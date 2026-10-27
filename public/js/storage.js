import { storage } from '/js/firebase.js';
import { doc, getDocs, collection, query, orderBy, setDoc, writeBatch } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';
import { ref, uploadBytesResumable, getDownloadURL } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-storage.js';

export const INLINE_FILE_LIMIT = 300 * 1024;
export const CHUNK_SIZE = 250 * 1024;
const CHUNK_WORKERS = 3;

function abortError() { return new DOMException('The upload was cancelled.', 'AbortError'); }
function assertNotAborted(signal) { if (signal?.aborted) throw abortError(); }
function chunkRef(parentRef, fileId, index, width) {
  return doc(parentRef, 'files', fileId, 'chunks', String(index).padStart(width, '0'));
}

/** Read a Blob with an abortable FileReader. */
export function readAsDataURL(blob, signal) {
  return new Promise((resolve, reject) => {
    assertNotAborted(signal);
    const reader = new FileReader();
    const abort = () => reader.abort();
    const done = () => signal?.removeEventListener('abort', abort);
    reader.onload = () => { done(); resolve(reader.result); };
    reader.onerror = () => { done(); reject(reader.error || new Error('Could not read the file.')); };
    reader.onabort = () => { done(); reject(abortError()); };
    signal?.addEventListener('abort', abort, { once: true });
    reader.readAsDataURL(blob);
  });
}

function base64FromDataURL(dataURL) { return String(dataURL).slice(String(dataURL).indexOf(',') + 1); }
function bytesFromBase64(base64) {
  const text = atob(base64), bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i += 1) bytes[i] = text.charCodeAt(i);
  return bytes;
}

function storageUpload(file, path, contentType, { signal, onProgress } = {}) {
  return new Promise((resolve, reject) => {
    assertNotAborted(signal);
    const task = uploadBytesResumable(ref(storage, path), file, { contentType });
    let settled = false, transferred = 0, unsubscribe = () => {};
    const abort = () => task.cancel();
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(stallTimer);
      signal?.removeEventListener('abort', abort);
      unsubscribe();
      fn(value);
    };
    // Missing buckets and CORS-blocked requests commonly make no progress at all.
    const stallTimer = setTimeout(() => {
      if (transferred === 0) {
        const error = new Error('Firebase Storage made no upload progress.');
        error.code = 'storage/stalled';
        task.cancel();
        finish(reject, error);
      }
    }, 2500);
    signal?.addEventListener('abort', abort, { once: true });
    unsubscribe = task.on('state_changed', (snapshot) => {
      transferred = snapshot.bytesTransferred;
      onProgress?.(snapshot.totalBytes ? transferred / snapshot.totalBytes * 100 : 0);
    }, (error) => finish(reject, signal?.aborted ? abortError() : error), async () => {
      try { finish(resolve, await getDownloadURL(task.snapshot.ref)); }
      catch (error) { finish(reject, error); }
    });
  });
}

async function uploadChunks(file, parentRef, { signal, onProgress } = {}) {
  const fileId = crypto.randomUUID(), count = Math.ceil(file.size / CHUNK_SIZE);
  const width = Math.max(4, String(count - 1).length);
  let next = 0, completeBytes = 0;
  const worker = async () => {
    while (true) {
      assertNotAborted(signal);
      const index = next++;
      if (index >= count) return;
      const start = index * CHUNK_SIZE, slice = file.slice(start, Math.min(start + CHUNK_SIZE, file.size));
      const data = base64FromDataURL(await readAsDataURL(slice, signal));
      assertNotAborted(signal);
      await setDoc(chunkRef(parentRef, fileId, index, width), { index, data });
      completeBytes += slice.size;
      onProgress?.(completeBytes / file.size * 100);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CHUNK_WORKERS, count) }, worker));
  return { fileURL: `chunked:${fileId}:${count}`, isChunked: true, fileId, chunkCount: count };
}

/**
 * Upload with Firestore fallbacks. parentRef is the page/room document that owns the file.
 * The caller saves the returned fields in its metadata document after this resolves.
 */
export async function uploadFileWithFallback({ file, parentRef, storagePath, contentType = file.type || 'application/octet-stream', signal, onProgress } = {}) {
  if (!file || !parentRef) throw new Error('A file and parent Firestore document are required.');
  assertNotAborted(signal);
  onProgress?.(0);
  if (file.size <= INLINE_FILE_LIMIT) {
    const fileURL = await readAsDataURL(file, signal);
    onProgress?.(100);
    return { fileURL, isChunked: false };
  }
  try {
    const fileURL = await storageUpload(file, storagePath, contentType, { signal, onProgress });
    onProgress?.(100);
    return { fileURL, storagePath, isChunked: false };
  } catch (error) {
    if (signal?.aborted || error?.name === 'AbortError' || error?.code === 'storage/canceled') throw abortError();
    // Storage is optional: a missing bucket, CORS rejection, quota issue, or network failure uses chunks.
    console.warn('Firebase Storage upload failed; using Firestore chunks.', error);
    return uploadChunks(file, parentRef, { signal, onProgress });
  }
}

function parseChunkURL(fileURL) {
  const match = /^chunked:([^:]+):(\d+)$/.exec(fileURL || '');
  return match && { fileId: match[1], count: Number(match[2]) };
}

export async function resolveChunkedFile(fileURL, mimeType, parentRef, signal) {
  const parsed = parseChunkURL(fileURL);
  if (!parsed || !parentRef) throw new Error('Invalid chunked file reference.');
  assertNotAborted(signal);
  const snapshot = await getDocs(query(collection(parentRef, 'files', parsed.fileId, 'chunks'), orderBy('index')));
  assertNotAborted(signal);
  if (snapshot.size !== parsed.count) throw new Error('This file is incomplete.');
  const parts = snapshot.docs.map((entry, index) => {
    const chunk = entry.data();
    if (chunk.index !== index || typeof chunk.data !== 'string') throw new Error('This file has invalid chunks.');
    return bytesFromBase64(chunk.data);
  });
  return new Blob(parts, { type: mimeType || 'application/octet-stream' });
}

function clickDownload(href, fileName) {
  const link = document.createElement('a');
  link.href = href; link.download = fileName || 'download'; link.rel = 'noopener';
  document.body.append(link); link.click(); link.remove();
}

/**
 * Resolves all three storage formats. Pass parentRef for chunked URLs; plain HTTPS/data URLs
 * do not need it. A page-specific wrapper can retain parentRef and expose the three-argument API.
 */
export async function downloadOrResolveFile(fileURL, fileName, mimeType, { parentRef, signal } = {}) {
  assertNotAborted(signal);
  if (fileURL?.startsWith('https://') || fileURL?.startsWith('data:')) {
    clickDownload(fileURL, fileName);
    return;
  }
  const blob = await resolveChunkedFile(fileURL, mimeType, parentRef, signal);
  const objectURL = URL.createObjectURL(blob);
  try { clickDownload(objectURL, fileName); }
  finally { setTimeout(() => URL.revokeObjectURL(objectURL), 4000); }
}

export function createDownloadResolver(parentRef) {
  return (fileURL, fileName, mimeType, signal) => downloadOrResolveFile(fileURL, fileName, mimeType, { parentRef, signal });
}

export async function deleteChunkedFile(fileURL, parentRef) {
  const parsed = parseChunkURL(fileURL);
  if (!parsed || !parentRef) return;
  const chunks = await getDocs(collection(parentRef, 'files', parsed.fileId, 'chunks'));
  const batch = writeBatch(parentRef.firestore);
  chunks.forEach((entry) => batch.delete(entry.ref));
  await batch.commit();
}
