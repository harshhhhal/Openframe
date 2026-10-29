import { auth, db, storage } from '/js/firebase.js';
import { doc, onSnapshot, collection, query, orderBy, addDoc, setDoc, updateDoc, deleteDoc, getDocs, serverTimestamp, Timestamp } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';
import { ref as sref, getBytes, deleteObject } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-storage.js';
import { uploadFileWithFallback, resolveChunkedFile, downloadOrResolveFile, deleteChunkedFile } from '/js/storage.js';
import { shell, $, esc, ico, paint, toast, modal, confirmDialog, copyText, fmtTime, fmtSize, fmtLeft, qrPng } from '/js/ui.js';
import { unavailable } from '/js/main.js';

const MAX_FILE = 25 * 1024 * 1024, AUTO_PREVIEW = 10 * 1024 * 1024;
const BLOCKED = /\.(exe|bat|cmd|com|msi|scr|sh|js|mjs|jar|html?|xhtml|svg|php|ps1|vbs|apk|dmg)$/i;
const IMG = /^image\/(png|jpe?g|gif|webp|avif)$/, VID = /^video\/(mp4|webm|ogg|quicktime)$/;

export function parseYT(input) {
  try {
    const u = new URL(input.trim()); const h = u.hostname.replace(/^(www|m)\./, ''); let id = null;
    if (h === 'youtu.be') id = u.pathname.slice(1).split('/')[0];
    else if (h === 'youtube.com' || h === 'music.youtube.com') {
      if (u.pathname === '/watch') id = u.searchParams.get('v');
      else { const m = u.pathname.match(/^\/(embed|shorts|live|v)\/([^/?]+)/); if (m) id = m[2]; }
    }
    return /^[A-Za-z0-9_-]{11}$/.test(id || '') ? id : null;
  } catch { return null; }
}

let ytApi;
const loadYT = () => (ytApi ||= new Promise((res) => {
  if (window.YT?.Player) return res(true);
  window.onYouTubeIframeAPIReady = () => res(true);
  const s = document.createElement('script'); s.src = 'https://www.youtube.com/iframe_api'; s.onerror = () => { ytApi = null; res(false); };
  document.head.append(s);
}));

export async function cleanup(id) {
  const pref = doc(db, 'pages', id);
  try {
    const its = await getDocs(collection(pref, 'items'));
    await Promise.all(its.docs.map(async (d) => {
      const data = d.data(), p = data.storagePath;
      if (p) await deleteObject(sref(storage, p)).catch((e) => { if (e.code !== 'storage/object-not-found') throw e; });
      if (data.isChunked) await deleteChunkedFile(data.fileURL, pref);
    }));
    await Promise.all(its.docs.map((d) => deleteDoc(d.ref)));
    const cs = await getDocs(collection(pref, 'comments'));
    await Promise.all(cs.docs.map((d) => deleteDoc(d.ref)));
    await deleteDoc(pref);
  } catch (e) { console.error('Cleanup incomplete; it retries when the host reopens the page.', e); }
}

export function openPage(id) {
  const uid = auth.currentUser.uid, pref = doc(db, 'pages', id), shareUrl = `${location.origin}/p/${id}`;
  const unsubs = [], urls = new Map(), pending = new Map(), cleanups = [];
  let page = null, items = [], comments = [], built = false, dead = false, timer, presenceTimer, isHost = false, itemsLoaded = false;
  let openReply = null, replyDraft = '', lastSend = 0;
  let currentTab = 'all';
  const Y = { player: null, vid: null, rev: -1, hostRev: 0, cur: null, applying: false, wt: null, ready: false, lastT: 0, tick: 0, mounting: null };
  const onOff = () => toast(navigator.onLine ? 'Back online' : 'You are offline. Changes will sync when you reconnect.', !navigator.onLine);
  addEventListener('online', onOff); addEventListener('offline', onOff);

  const stop = () => {
    if (dead) return; dead = true;
    unsubs.forEach((u) => u()); cleanups.forEach((f) => f()); clearInterval(timer); clearInterval(presenceTimer); clearTimeout(Y.wt);
    try { Y.player?.destroy(); } catch { /* ignore */ }
    urls.forEach((u) => URL.revokeObjectURL(u)); removeEventListener('online', onOff); removeEventListener('offline', onOff);
  };
  const fail = (title) => { const host = page?.hostUid === uid; stop(); unavailable(title); if (host) cleanup(id); };
  const failFor = () => fail(page?.status === 'active' && page.expiresAt.toMillis() <= Date.now() ? 'This page has expired' : 'This page is no longer available');

  shell(`<main class="share-layout">
    <section class="workspace">
      <div class="workspace-header-skel"><div class="skel" style="height:36px;width:180px;"></div></div>
      <div class="skel" style="height:80px;margin-bottom:16px;"></div>
      <div class="skel" style="height:260px;"></div>
    </section>
    <aside class="sidebar">
      <div class="skel" style="height:170px;margin-bottom:16px;"></div>
      <div class="skel" style="height:130px;margin-bottom:16px;"></div>
      <div class="skel" style="height:240px;"></div>
    </aside>
  </main>`, { room: true });

  unsubs.push(onSnapshot(pref, (s) => {
    if (dead) return;
    if (!s.exists()) return fail('This page is no longer available');
    page = s.data({ serverTimestamps: 'estimate' });
    if (page.status !== 'active') return fail('This page is no longer available');
    if (page.expiresAt.toMillis() <= Date.now()) return fail('This page has expired');
    if (!built) { built = true; isHost = page.hostUid === uid; build(); }
    tickBar(); ytSync(page.youtubeState);
  }, () => { if (!dead) failFor(); }));

  /* ---------- layout ---------- */
  function build() {
    const meta = `<span class="badge status-pill" title="Connected viewers"><i class="dot"></i><b id="husers">1</b><span>online</span></span><span class="badge expiry-pill" title="Time remaining">${ico('clock-3')}<b id="hleft">--</b></span>`;
    
    shell(`<main class="share-layout">
      <!-- Main Workspace (Left Column) -->
      <section class="workspace" aria-label="Main collaboration workspace">
        <!-- Workspace Header -->
        <header class="workspace-header">
          <div class="workspace-heading">
            <h1>Shared</h1>
            <span class="connection-count" title="Active participants">
              <i class="dot"></i>
              <span id="presenceCopy">1 connected</span>
            </span>
          </div>
          <div class="workspace-actions">
            ${isHost ? `<span class="role-pill host-role">${ico('shield-check')}<span>Host</span></span>` : `<span class="role-pill viewer-role">${ico('eye')}<span>Viewer</span></span>`}
          </div>
        </header>

        <!-- YouTube Watch Along -->
        <section class="watch-along-card" id="ytsec" ${isHost ? '' : 'hidden'}>
          <div class="watch-along-header">
            <div class="watch-along-title">
              <span class="watch-along-icon">${ico('play-circle')}</span>
              <strong>Watch Along</strong>
            </div>
            <span class="watch-along-status" id="ytst"></span>
          </div>

          <div class="yt" id="ytwrap" hidden>
            <div id="ytp"></div>
            ${isHost ? '' : '<div class="shield"></div>'}
            <div class="ytnote" id="ytnote" hidden></div>
          </div>

          <div class="watch-along-bar" id="ytbar">
            ${isHost
              ? `<form class="watch-along-form" id="ytf">
                  <div class="watch-along-input-wrap">
                    <span class="watch-along-input-icon">${ico('link-2')}</span>
                    <input type="url" id="yti" class="watch-along-input" aria-label="YouTube video URL" placeholder="Paste YouTube link to watch together…" required>
                  </div>
                  <button class="primary-button sm watch-along-submit" type="submit">Set video</button>
                </form>
                <button type="button" class="icon-button sm danger" id="ytrm" aria-label="Remove video" title="Remove video" hidden>${ico('trash-2')}</button>`
              : `<div class="viewer-media-controls">
                  <button type="button" class="icon-button sm" id="mute" aria-label="Toggle mute">${ico('volume-2')}</button>
                  <label class="vol-label"><span class="sr-only">Volume</span><input type="range" id="vol" min="0" max="100" value="100" aria-label="Volume"></label>
                </div>`}
          </div>
        </section>

        <!-- Content Navigation Tabs -->
        <nav class="content-tabs" aria-label="Shared content types" role="tablist">
          <button type="button" class="content-tab is-active" data-filter="all" role="tab" aria-selected="true" aria-label="All items">
            ${ico('layers')}
            <span>All</span>
            <span class="tab-badge" id="tabCountAll">0</span>
          </button>
          <button type="button" class="content-tab" data-filter="files" role="tab" aria-selected="false" aria-label="Files">
            ${ico('file')}
            <span>Files</span>
            <span class="tab-badge" id="tabCountFiles">0</span>
          </button>
          <button type="button" class="content-tab" data-filter="links" role="tab" aria-selected="false" aria-label="Links">
            ${ico('link-2')}
            <span>Links</span>
            <span class="tab-badge" id="tabCountLinks">0</span>
          </button>
          <button type="button" class="content-tab" data-filter="notes" role="tab" aria-selected="false" aria-label="Notes">
            ${ico('file-text')}
            <span>Notes</span>
            <span class="tab-badge" id="tabCountNotes">0</span>
          </button>
          <button type="button" class="content-tab" data-filter="images" role="tab" aria-selected="false" aria-label="Images">
            ${ico('image')}
            <span>Images</span>
            <span class="tab-badge" id="tabCountImages">0</span>
          </button>
        </nav>

        <!-- Shared Items Stream Area -->
        <div class="shared-area">
          <span class="count" id="ic" hidden></span>
          <div id="feed" class="shared-feed">
            <div class="skel"></div>
          </div>
        </div>

        <!-- Upload Progress Tray -->
        <div class="tray" id="tray"></div>

        <!-- Bottom-Pinned Share Composer -->
        ${isHost ? `
        <form class="share-composer" id="composer">
          <button type="button" class="icon-button attachment-button" id="attach" aria-label="Attach file" title="Attach file">
            ${ico('paperclip')}
          </button>
          <input type="file" id="fi" multiple hidden>
          <div class="composer-input-wrap">
            <textarea id="ct" class="composer-input" rows="1" maxlength="10000" placeholder="Write a note or paste a link… (Enter to share, Shift+Enter for new line)" aria-label="Write a note or paste a link"></textarea>
          </div>
          <button type="submit" class="primary-button composer-submit" id="send" aria-label="Share">
            <span>Share</span>
            ${ico('arrow-up')}
          </button>
        </form>` : `
        <div class="viewer-notice">
          <span class="viewer-notice-icon">${ico('info')}</span>
          <span>You are viewing this shared workspace. You can read, preview, download files, and post comments below.</span>
        </div>`}
      </section>

      <!-- Right Utility Sidebar -->
      <aside class="sidebar" aria-label="Sharing and session details">
        <!-- Panel 1: Share Link and Collapsible QR Code -->
        <section class="sidebar-card share-link-card">
          <div class="sidebar-card-header">
            <div class="sidebar-card-title">
              <span class="sidebar-icon">${ico('share-2')}</span>
              <h2>Share page</h2>
            </div>
          </div>

          <div class="share-url-box">
            <span class="share-url-icon">${ico('link-2')}</span>
            <span class="share-url-text" title="${esc(shareUrl)}">${esc(shareUrl)}</span>
          </div>

          <button type="button" class="primary-button copy-link-btn" id="copy2">
            ${ico('copy')}
            <span>Copy link</span>
          </button>

          <!-- Collapsible QR Code -->
          <div class="qr-collapsible">
            <button type="button" class="qr-toggle-btn" id="qrtoggle" aria-expanded="false" aria-controls="qrcollapse">
              <span class="qr-toggle-left">${ico('qr-code')}<span>QR Code</span></span>
              <span class="qr-toggle-chevron">${ico('chevron-down')}</span>
            </button>
            <div class="qr-collapse-content" id="qrcollapse" hidden>
              <div class="qr-panel" id="qrbox"></div>
              <div class="qr-actions">
                <button type="button" class="secondary-button sm" id="qrbig">${ico('maximize-2')}<span>Expand QR</span></button>
              </div>
            </div>
          </div>
        </section>

        <!-- Panel 2: Session Info & Controls -->
        <section class="sidebar-card session-card">
          <div class="sidebar-card-header">
            <div class="sidebar-card-title">
              <span class="sidebar-icon">${ico('activity')}</span>
              <h2>Session</h2>
            </div>
          </div>

          <div class="session-stats-grid">
            <div class="session-stat-item">
              <span class="session-stat-label">${ico('users')} Connected</span>
              <strong class="session-stat-value" id="users">1</strong>
            </div>
            <div class="session-stat-item">
              <span class="session-stat-label">${ico('clock')} Remaining</span>
              <strong class="session-stat-value" id="left">--</strong>
            </div>
            <div class="session-stat-item">
              <span class="session-stat-label">${ico('layers')} Shared</span>
              <strong class="session-stat-value" id="sc">0</strong>
            </div>
          </div>

          ${isHost ? `
          <div class="host-actions">
            <button type="button" class="secondary-button extend-session-btn" id="ext">
              ${ico('clock-4')}
              <span>Extend 1 hour</span>
            </button>
            <button type="button" class="danger-outline-button delete-page-btn" id="del">
              ${ico('trash-2')}
              <span>Delete page</span>
            </button>
            <p class="host-disclaimer">${ico('shield')} Host session is tied to this browser.</p>
          </div>` : `
          <p class="viewer-disclaimer">${ico('shield')} Content automatically expires when session timer reaches zero.</p>
          `}
        </section>

        <!-- Panel 3: Comments -->
        <section class="sidebar-card comments-card">
          <div class="sidebar-card-header">
            <div class="sidebar-card-title">
              <span class="sidebar-icon">${ico('message-square')}</span>
              <h2>Comments</h2>
              <span class="count-badge" id="cc" hidden>0</span>
            </div>
            <button type="button" class="icon-button sm" id="addc" aria-label="Add comment" title="Add comment">
              ${ico('plus')}
            </button>
          </div>

          <form class="comment-composer-form" id="cform" hidden>
            ${commentFields('c')}
            <div class="form-actions">
              <button type="button" class="secondary-button sm" id="cancelc">Cancel</button>
              <button class="primary-button sm" type="submit">
                ${ico('send')}
                <span>Post</span>
              </button>
            </div>
          </form>

          <div class="comments-scroll-area">
            <div id="comments" class="comments-list"></div>
          </div>
        </section>
      </aside>
    </main>
    ${isHost ? `<div class="dropov" id="dov" hidden><div>${ico('upload-cloud')}<span>Drop files to share</span></div></div>` : ''}`, { meta, room: true });

    // Link copying
    const c1 = $('#copy'), c2 = $('#copy2');
    if (c1) c1.onclick = () => copyText(shareUrl);
    if (c2) c2.onclick = () => copyText(shareUrl);

    // QR code collapsible & modal
    renderQR();
    const qrToggle = $('#qrtoggle'), qrCol = $('#qrcollapse');
    if (qrToggle && qrCol) {
      qrToggle.onclick = () => {
        const isExp = qrToggle.getAttribute('aria-expanded') === 'true';
        qrToggle.setAttribute('aria-expanded', String(!isExp));
        qrCol.hidden = isExp;
        qrToggle.querySelector('.qr-toggle-chevron')?.classList.toggle('is-open', !isExp);
      };
    }
    const qrBig = $('#qrbig');
    if (qrBig) qrBig.onclick = qrModal;

    // Content navigation tabs
    document.querySelectorAll('.content-tab').forEach((b) => {
      b.onclick = () => {
        document.querySelectorAll('.content-tab').forEach((x) => {
          const on = x === b;
          x.classList.toggle('is-active', on);
          x.setAttribute('aria-selected', String(on));
        });
        currentTab = b.dataset.filter || 'all';
        renderFeed();
      };
    });

    if (isHost) {
      $('#ext').onclick = extend;
      $('#del').onclick = async () => {
        if (!(await confirmDialog('Delete this page and everything on it? This cannot be undone.', 'Delete page'))) return;
        try { await updateDoc(pref, { status: 'deleted' }); } catch { toast('Could not delete the page.', true); }
      };
      $('#ytf').onsubmit = setVideo;
      $('#ytrm').onclick = () => updateDoc(pref, { youtubeState: null }).catch(() => toast('Could not remove the video.', true));
      const ta = $('#ct'), fit = () => { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 160) + 'px'; };
      ta.oninput = fit; ta.onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); $('#composer').requestSubmit(); } };
      $('#composer').onsubmit = async (e) => {
        e.preventDefault(); const t = ta.value.trim(); if (!t) return; const btn = $('#send'); btn.disabled = true;
        let data = { type: 'text', text: t };
        if (/^https?:\/\/\S+$/i.test(t)) { try { data = { type: 'link', url: new URL(t).href }; } catch { /* keep as text */ } }
        try { await addDoc(collection(pref, 'items'), { ...data, createdAt: serverTimestamp(), createdBy: uid }); ta.value = ''; fit(); }
        catch { toast('Could not send. The page may have expired.', true); }
        btn.disabled = false; ta.focus();
      };
      $('#attach').onclick = () => $('#fi').click();
      $('#fi').onchange = (e) => { uploadFiles([...e.target.files]); e.target.value = ''; };
      let dt; const onOver = (e) => { if (!e.dataTransfer?.types?.includes('Files')) return; e.preventDefault(); const o = $('#dov'); if (o) o.hidden = false; clearTimeout(dt); dt = setTimeout(() => { const x = $('#dov'); if (x) x.hidden = true; }, 150); };
      const onDrop = (e) => { if (!e.dataTransfer?.files?.length) return; e.preventDefault(); const o = $('#dov'); if (o) o.hidden = true; uploadFiles([...e.dataTransfer.files]); };
      document.addEventListener('dragover', onOver); document.addEventListener('drop', onDrop);
      cleanups.push(() => { document.removeEventListener('dragover', onOver); document.removeEventListener('drop', onDrop); clearTimeout(dt); });
    } else {
      const mute = $('#mute'), vol = $('#vol');
      if (mute) mute.onclick = () => { const p = Y.player; if (!p || !Y.ready) return; const m = p.isMuted(); m ? p.unMute() : p.mute(); mute.innerHTML = ico(m ? 'volume-2' : 'volume-x'); paint(); };
      if (vol) vol.oninput = (e) => Y.ready && Y.player.setVolume(Number(e.target.value));
    }

    $('#addc').onclick = () => {
      const f = $('#cform');
      f.hidden = !f.hidden;
      if (!f.hidden) $('#cform textarea')?.focus();
    };
    const cancelC = $('#cancelc');
    if (cancelC) cancelC.onclick = () => { $('#cform').hidden = true; };

    $('#cform').onsubmit = (e) => { e.preventDefault(); sendComment(e.target, null); };
    $('#feed').onclick = feedClick;
    $('#comments').onclick = commentClick;
    $('#comments').addEventListener('submit', (e) => { e.preventDefault(); sendComment(e.target, e.target.dataset.parent); });
    $('#comments').addEventListener('input', (e) => { if (e.target.matches('.rf textarea')) replyDraft = e.target.value; });

    setupPresence();

    timer = setInterval(() => { tickBar(); ytLoop(); }, 1000);
    const onErr = () => { if (!dead) failFor(); };
    unsubs.push(onSnapshot(query(collection(pref, 'items'), orderBy('createdAt', 'asc')), (s) => {
      items = s.docs.map((d) => ({ id: d.id, ...d.data({ serverTimestamps: 'estimate' }) })); itemsLoaded = true; renderFeed();
    }, onErr));
    unsubs.push(onSnapshot(query(collection(pref, 'comments'), orderBy('createdAt', 'asc')), (s) => {
      comments = s.docs.map((d) => ({ id: d.id, ...d.data({ serverTimestamps: 'estimate' }) })); renderComments();
    }, onErr));
  }

  function tickBar() {
    if (dead || !page) return;
    const left = page.expiresAt.toMillis() - Date.now();
    if (left <= 0) return fail('This page has expired');
    const t = fmtLeft(left); const a = $('#left'), h = $('#hleft'); if (a) a.textContent = t; if (h) h.textContent = t;
  }

  function setupPresence() {
    const session = crypto.randomUUID(), here = doc(pref, 'presence', session), ttl = 55_000;
    const beat = () => setDoc(here, {
      uid, seenAt: serverTimestamp(), expiresAt: Timestamp.fromMillis(Date.now() + ttl),
    }, { merge: true }).catch(() => {});
    const showCount = (count) => {
      const n = Math.max(1, count), text = `${n} connected`;
      const a = $('#users'), b = $('#husers'), c = $('#presenceCopy');
      if (a) a.textContent = n; if (b) b.textContent = n; if (c) c.textContent = text;
    };
    beat(); presenceTimer = setInterval(beat, 20_000);
    unsubs.push(onSnapshot(collection(pref, 'presence'), (snap) => {
      const now = Date.now();
      showCount(snap.docs.filter((entry) => entry.data().expiresAt?.toMillis?.() > now).length);
    }));
    const leave = () => deleteDoc(here).catch(() => {});
    addEventListener('pagehide', leave, { once: true });
    cleanups.push(() => { removeEventListener('pagehide', leave); leave(); });
  }

  async function extend() {
    const cur = page.expiresAt.toMillis(), next = Math.min(cur + 3600e3, Date.now() + 7 * 864e5);
    if (next <= cur + 1000) return toast('This page is at the 7 day maximum.', true);
    try { await updateDoc(pref, { expiresAt: Timestamp.fromMillis(next) }); toast('Page extended 1 hour'); } catch { toast('Could not extend the page.', true); }
  }

  let qrUrl = '';
  function renderQR() {
    try { qrUrl = qrPng(shareUrl, 8, 2); $('#qrbox').innerHTML = `<img src="${qrUrl}" alt="QR code for this page">`; }
    catch { $('#qrbox').innerHTML = '<p class="mut">QR code unavailable.</p>'; }
  }
  function qrModal() {
    try {
      const big = qrPng(shareUrl, 14, 2);
      const m = modal(`<h2>Scan to open</h2><p class="mut">Opens this page on any device.</p><div class="qrbig"><img src="${big}" alt="QR code for this page"></div><div class="row end"><a class="secondary-button sm" download="openframe-qr.png" href="${big}">${ico('download')}<span>Download</span></a><button class="primary-button sm" data-x>Done</button></div>`);
      m.el.querySelector('[data-x]').onclick = m.close;
    } catch { toast('Could not generate the QR code.', true); }
  }

  /* ---------- shared items ---------- */
  const blobFor = (it) => {
    if (urls.has(it.id)) return Promise.resolve(urls.get(it.id));
    if (!pending.has(it.id)) pending.set(it.id, (async () => {
      if (it.fileURL?.startsWith('data:') || it.fileURL?.startsWith('https://')) return it.fileURL;
      const blob = it.isChunked
        ? await resolveChunkedFile(it.fileURL, it.contentType, pref)
        : new Blob([await getBytes(sref(storage, it.storagePath), MAX_FILE)], { type: it.contentType });
      const u = URL.createObjectURL(blob); urls.set(it.id, u); return u;
    })().finally(() => pending.delete(it.id)));
    return pending.get(it.id);
  };

  function itemHtml(it) {
    const acts = isHost
      ? `<div class="item-actions">
          ${it.type === 'text' ? `<button type="button" class="icon-button xs" data-a="edit" aria-label="Edit text" title="Edit text">${ico('pencil')}</button>` : ''}
          <button type="button" class="icon-button xs danger" data-a="del" aria-label="Delete entry" title="Delete entry">${ico('trash-2')}</button>
        </div>`
      : '';

    let body = '';
    if (it.type === 'text') {
      body = `<div class="txt">${esc(it.text)}</div>`;
    } else if (it.type === 'link') {
      body = `<a class="u" href="${esc(it.url)}" target="_blank" rel="noopener noreferrer">${ico('external-link')}<span>${esc(it.url)}</span></a>`;
    } else {
      const isImg = it.type === 'image', isVid = it.type === 'video';
      const hasBlob = urls.has(it.id);
      const canAuto = isImg && it.size <= AUTO_PREVIEW;

      let mediaPreview = '';
      if (isImg && (canAuto || hasBlob)) {
        mediaPreview = `<div class="media-preview-wrap"><img alt="${esc(it.originalName)}" data-img="${it.id}" ${hasBlob ? `src="${urls.get(it.id)}"` : ''}></div>`;
      } else if (isVid && hasBlob) {
        mediaPreview = `<div class="media-preview-wrap"><video controls preload="metadata" src="${urls.get(it.id)}"></video></div>`;
      }

      const needsLoad = (isImg || isVid) && !canAuto && !hasBlob;
      const previewBtn = needsLoad ? `<button type="button" class="secondary-button sm" data-a="load">${ico('play')}<span>Preview</span></button>` : '';

      body = `<div class="file">
        <div class="file-info">
          <span class="file-name">${esc(it.originalName)}</span>
          <small class="file-meta">${esc(it.contentType)} · ${fmtSize(it.size)}</small>
        </div>
        <div class="file-actions">
          ${previewBtn}
          <button type="button" class="secondary-button sm" data-a="dl">${ico('download')}<span>Download</span></button>
        </div>
      </div>${mediaPreview}`;
    }

    const badgeIcon = it.type === 'image' ? 'image' : it.type === 'video' ? 'video' : it.type === 'link' ? 'link-2' : it.type === 'text' ? 'file-text' : 'file';
    const badgeLabel = it.type === 'image' ? 'Image' : it.type === 'video' ? 'Video' : it.type === 'link' ? 'Link' : it.type === 'text' ? 'Note' : 'File';

    return `<article class="item" data-id="${it.id}">
      <div class="item-header">
        <span class="item-type-badge">${ico(badgeIcon)}<span>${badgeLabel}</span></span>
        <span class="item-time">${fmtTime(it.createdAt)}</span>
        ${acts}
      </div>
      <div class="item-body">${body}</div>
    </article>`;
  }

  function emptyStateHtml(filter) {
    const icon = filter === 'files' ? 'file' : filter === 'links' ? 'link-2' : filter === 'notes' ? 'file-text' : filter === 'images' ? 'image' : 'sparkles';
    const title = filter === 'files' ? 'No files shared yet'
      : filter === 'links' ? 'No links shared yet'
      : filter === 'notes' ? 'No notes shared yet'
      : filter === 'images' ? 'No images shared yet'
      : 'Nothing shared yet';
    const desc = isHost
      ? (filter === 'files' || filter === 'images' ? 'Use the paperclip button in the composer to attach files.' : 'Add a file, link or note below to get started.')
      : 'Items shared by the host will appear here in real time.';
    return `<div class="empty-state">
      <div class="empty-state-icon">${ico(icon)}</div>
      <h2>${title}</h2>
      <p>${desc}</p>
    </div>`;
  }

  function renderFeed() {
    const feed = $('#feed'); if (!feed) return;
    const ic = $('#ic'); if (ic) { ic.hidden = !items.length; ic.textContent = items.length; }
    const sc = $('#sc'); if (sc) sc.textContent = items.length;

    // Update tab counters
    const countAll = items.length;
    const countFiles = items.filter((x) => x.type === 'file' || x.type === 'video').length;
    const countLinks = items.filter((x) => x.type === 'link').length;
    const countNotes = items.filter((x) => x.type === 'text').length;
    const countImages = items.filter((x) => x.type === 'image').length;

    const bAll = $('#tabCountAll'), bFiles = $('#tabCountFiles'), bLinks = $('#tabCountLinks'), bNotes = $('#tabCountNotes'), bImages = $('#tabCountImages');
    if (bAll) bAll.textContent = countAll;
    if (bFiles) bFiles.textContent = countFiles;
    if (bLinks) bLinks.textContent = countLinks;
    if (bNotes) bNotes.textContent = countNotes;
    if (bImages) bImages.textContent = countImages;

    let filtered = items;
    if (currentTab === 'files') filtered = items.filter((x) => x.type === 'file' || x.type === 'video');
    else if (currentTab === 'links') filtered = items.filter((x) => x.type === 'link');
    else if (currentTab === 'notes') filtered = items.filter((x) => x.type === 'text');
    else if (currentTab === 'images') filtered = items.filter((x) => x.type === 'image');

    feed.innerHTML = filtered.length ? filtered.map(itemHtml).join('') : emptyStateHtml(currentTab);
    paint();
    feed.querySelectorAll('img[data-img]:not([src])').forEach(async (img) => {
      const it = items.find((x) => x.id === img.dataset.img);
      if (!it) return;
      try { const u = await blobFor(it); const t = $(`img[data-img="${it.id}"]`); if (t && !dead) t.src = u; } catch { toast('An image could not be loaded.', true); }
    });
  }

  async function feedClick(e) {
    if (e.target.matches('img[data-img]')) {
      const lb = document.createElement('div'); lb.className = 'lb'; lb.innerHTML = `<img alt="">`; lb.firstChild.src = e.target.src; lb.firstChild.alt = e.target.alt;
      const close = () => { lb.remove(); document.removeEventListener('keydown', k); }; const k = (ev) => ev.key === 'Escape' && close();
      lb.onclick = close; document.addEventListener('keydown', k); document.body.append(lb); return;
    }
    const b = e.target.closest('[data-a]'), art = e.target.closest('[data-id]'); if (!b || !art) return;
    const it = items.find((x) => x.id === art.dataset.id); if (!it) return; const a = b.dataset.a;
    if (a === 'load') { b.disabled = true; try { await blobFor(it); renderFeed(); } catch { b.disabled = false; toast('Could not load the preview.', true); } }
    else if (a === 'dl') {
      b.disabled = true;
      try {
        if (it.fileURL) await downloadOrResolveFile(it.fileURL, it.originalName, it.contentType, { parentRef: pref });
        else {
          const bytes = await getBytes(sref(storage, it.storagePath), MAX_FILE);
          const u = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }));
          const l = document.createElement('a'); l.href = u; l.download = it.originalName; document.body.append(l); l.click(); l.remove(); setTimeout(() => URL.revokeObjectURL(u), 4000);
        }
      } catch { toast('Download failed. Try again.', true); }
      b.disabled = false;
    } else if (a === 'del' && await confirmDialog('Delete this entry?')) {
      try { if (it.storagePath) await deleteObject(sref(storage, it.storagePath)).catch((er) => { if (er.code !== 'storage/object-not-found') throw er; }); if (it.isChunked) await deleteChunkedFile(it.fileURL, pref); await deleteDoc(doc(pref, 'items', it.id)); toast('Entry deleted'); }
      catch { toast('Could not delete the entry.', true); }
    } else if (a === 'edit') {
      const m = modal(`<h2>Edit text</h2><label class="f" for="et" style="margin-top:0">Text</label><textarea id="et" maxlength="10000"></textarea><p class="err" hidden></p><div class="row end"><button class="secondary-button sm" data-x>Cancel</button><button class="primary-button sm" data-s>Save</button></div>`);
      const ta = m.el.querySelector('textarea'); ta.value = it.text; m.el.querySelector('[data-x]').onclick = m.close;
      m.el.querySelector('[data-s]').onclick = async (ev) => {
        const t = ta.value.trim(); if (!t) { const er = m.el.querySelector('.err'); er.hidden = false; er.textContent = 'Text cannot be empty.'; return; }
        ev.target.disabled = true;
        try { await updateDoc(doc(pref, 'items', it.id), { text: t }); m.close(); toast('Saved'); } catch { ev.target.disabled = false; toast('Could not save.', true); }
      };
    }
  }

  let upChain = Promise.resolve();
  const uploadFiles = (files) => files.forEach((f) => {
    const controller = new AbortController();
    upChain = upChain.then(() => uploadOne(f, controller));
  });
  async function uploadOne(f, controller) {
    if (dead) return;
    if (f.size === 0) return toast(`${f.name} is empty.`, true);
    if (f.size > MAX_FILE) return toast(`${f.name} is over the 25 MB limit.`, true);
    if (BLOCKED.test(f.name)) return toast(`${f.name} is a file type that cannot be shared.`, true);
    const ct = f.type || 'application/octet-stream', path = `pages/${id}/${crypto.randomUUID()}`;
    const row = document.createElement('div'); row.className = 'up'; row.innerHTML = `<div class="up-top"><span></span><button type="button" class="icon-button xs danger" title="Cancel upload">${ico('x')}</button></div><div class="prog"><i></i></div>`;
    row.querySelector('span').textContent = `Uploading ${f.name} (${fmtSize(f.size)})`;
    row.querySelector('button').onclick = () => controller.abort(); $('#tray')?.append(row);
    paint();
    try {
      const stored = await uploadFileWithFallback({ file: f, parentRef: pref, storagePath: path, contentType: ct, signal: controller.signal, onProgress: (percent) => { row.querySelector('i').style.width = percent + '%'; } });
      const type = IMG.test(ct) ? 'image' : VID.test(ct) ? 'video' : 'file';
      try { await addDoc(collection(pref, 'items'), { type, ...stored, originalName: f.name.slice(0, 200), contentType: ct, size: f.size, createdAt: serverTimestamp(), createdBy: uid }); }
      catch (er) { if (stored.storagePath) await deleteObject(sref(storage, stored.storagePath)).catch(() => {}); if (stored.isChunked) await deleteChunkedFile(stored.fileURL, pref).catch(() => {}); throw er; }
    } catch (er) {
      if (er?.name === 'AbortError' || controller.signal.aborted) toast(`Canceled ${f.name}.`);
      else { console.error(er); toast(`Upload failed for ${f.name}.`, true); }
    }
    row.remove();
  }

  /* ---------- comments ---------- */
  function commentFields(p) {
    const n = sessionStorage.getItem('of-name') || '';
    return `<label class="f" for="${p}n" style="margin-top:0">Display name</label><input id="${p}n" name="n" type="text" maxlength="40" value="${esc(n)}" autocomplete="nickname" placeholder="Your name" required>
      <label class="f" for="${p}b">Comment</label><textarea id="${p}b" name="b" maxlength="1000" placeholder="Type a comment…" required style="min-height:70px"></textarea><p class="err" hidden></p>`;
  }

  async function sendComment(form, parent) {
    const name = form.elements.n.value.trim(), body = form.elements.b.value.trim(), er = form.querySelector('.err'), btn = form.querySelector('button[type=submit]');
    const bad = (t) => { er.hidden = false; er.textContent = t; };
    if (!name || name.length > 40) return bad('Enter a display name up to 40 characters.');
    if (!body || body.length > 1000) return bad('Write a comment up to 1000 characters.');
    if (Date.now() - lastSend < 3000) return bad('Wait a few seconds before posting again.');
    er.hidden = true; btn.disabled = true;
    try {
      await addDoc(collection(pref, 'comments'), { displayName: name, body, parentCommentId: parent || null, anonymousAuthorId: uid, createdAt: serverTimestamp() });
      lastSend = Date.now(); sessionStorage.setItem('of-name', name); form.elements.b.value = '';
      if (parent) { openReply = null; replyDraft = ''; renderComments(); } else form.hidden = true;
      toast('Comment posted');
    } catch { bad('Could not post the comment. The page may have expired.'); }
    btn.disabled = false;
  }

  function renderComments() {
    const box = $('#comments'); if (!box) return;
    const cc = $('#cc'); if (cc) { cc.hidden = !comments.length; cc.textContent = comments.length; }
    const top = comments.filter((c) => !c.parentCommentId), kids = (c) => comments.filter((r) => r.parentCommentId === c.id);
    const head = (c, reply) => `<div class="cm"><div class="cm-author"><b>${esc(c.displayName)}</b><span class="cm-time">${fmtTime(c.createdAt)}</span></div><div class="cm-actions">${reply ? '' : `<button type="button" class="icon-button xs" data-a="reply" aria-label="Reply to comment" title="Reply">${ico('reply')}</button>`}${isHost || c.anonymousAuthorId === uid ? `<button type="button" class="icon-button xs danger" data-a="delc" aria-label="Delete comment" title="Delete comment">${ico('trash-2')}</button>` : ''}</div></div><p class="cm-body">${esc(c.body)}</p>`;
    box.innerHTML = top.length ? top.map((c) => `<div class="c" data-cid="${c.id}">${head(c, false)}${kids(c).map((r) => `<div class="re" data-cid="${r.id}">${head(r, true)}</div>`).join('')}<div class="rf" ${openReply === c.id ? '' : 'hidden'}></div></div>`).join('') : `<div class="empty-comments"><p class="mut">No comments yet. Start the conversation!</p></div>`;
    if (openReply) mountReply(openReply);
    paint();
  }

  function mountReply(cid) {
    const slot = $(`.c[data-cid="${cid}"] .rf`, $('#comments')); if (!slot) { openReply = null; return; }
    slot.hidden = false;
    slot.innerHTML = `<form class="reply-form" data-parent="${cid}">${commentFields('r' + cid)}<div class="form-actions"><button class="secondary-button sm" type="button" data-a="cancel">Cancel</button><button class="primary-button sm" type="submit">${ico('send')}<span>Reply</span></button></div></form>`;
    const ta = slot.querySelector('textarea'); ta.value = replyDraft; paint();
  }

  async function commentClick(e) {
    const b = e.target.closest('[data-a]'); if (!b) return; const a = b.dataset.a;
    if (a === 'reply') { const cid = b.closest('.c').dataset.cid; if (openReply === cid) { openReply = null; renderComments(); return; } openReply = cid; replyDraft = ''; renderComments(); $('.rf textarea', $('#comments'))?.focus(); }
    else if (a === 'cancel') { openReply = null; replyDraft = ''; renderComments(); }
    else if (a === 'delc') {
      const cid = b.closest('[data-cid]').dataset.cid;
      if (!(await confirmDialog('Delete this comment?'))) return;
      try {
        await deleteDoc(doc(pref, 'comments', cid));
        const c = comments.find((x) => x.id === cid);
        if (c && !c.parentCommentId && isHost) await Promise.all(comments.filter((r) => r.parentCommentId === cid).map((r) => deleteDoc(doc(pref, 'comments', r.id))));
        toast('Comment deleted');
      } catch { toast('Could not delete the comment.', true); }
    }
  }

  /* ---------- YouTube watch-along ---------- */
  async function setVideo(e) {
    e.preventDefault(); const vid = parseYT($('#yti').value);
    if (!vid) return toast('Enter a valid YouTube link.', true);
    try { await writeYT({ videoId: vid, isPlaying: false, positionSeconds: 0 }); $('#yti').value = ''; } catch { toast('Could not set the video.', true); }
  }
  async function writeYT(s) {
    Y.hostRev = Math.max(Y.hostRev, page?.youtubeState?.revision || 0) + 1;
    await updateDoc(pref, { youtubeState: { videoId: s.videoId, isPlaying: s.isPlaying, positionSeconds: Math.max(0, Math.round(s.positionSeconds * 10) / 10), updatedAt: serverTimestamp(), updatedBy: uid, revision: Y.hostRev } });
  }
  function hostWrite(playing) {
    clearTimeout(Y.wt);
    Y.wt = setTimeout(() => { if (Y.player && !dead) writeYT({ videoId: Y.vid, isPlaying: playing, positionSeconds: Y.player.getCurrentTime() }).catch(() => toast('Could not sync playback.', true)); }, 300);
  }
  const expected = () => { const c = Y.cur; return c.positionSeconds + (c.isPlaying ? Math.max(0, (Date.now() - c.at) / 1000) : 0); };
  const quiet = () => { Y.applying = true; setTimeout(() => { Y.applying = false; }, 900); };
  function note(html) { const n = $('#ytnote'); if (!n) return; n.hidden = !html; n.innerHTML = html || ''; paint(); const j = n.querySelector('#join'); if (j) j.onclick = () => { quiet(); Y.player.seekTo(expected(), true); Y.cur.isPlaying ? Y.player.playVideo() : Y.player.pauseVideo(); note(''); }; }
  const joinNote = () => note(`<button type="button" class="primary-button sm" id="join">${ico('play')}<span>Join playback</span></button>`);

  async function ytSync(s) {
    const sec = $('#ytsec'), wrap = $('#ytwrap'); if (!sec) return;
    if (!s) {
      Y.vid = null; Y.rev = -1; Y.cur = null; Y.ready = false; Y.mounting = null;
      try { Y.player?.destroy(); } catch { /* ignore */ } Y.player = null;
      wrap.hidden = true; note(''); if (!isHost) sec.hidden = true;
      if (isHost) { $('#ytrm').hidden = true; $('#ytst').textContent = ''; } return;
    }
    sec.hidden = false; wrap.hidden = false;
    Y.cur = { ...s, at: s.updatedAt?.toMillis?.() ?? Date.now() };
    if (isHost) { $('#ytrm').hidden = false; $('#ytst').textContent = s.isPlaying ? 'Playing for everyone' : 'Paused for everyone'; }
    else $('#ytst').textContent = s.isPlaying ? 'Following the host' : 'Paused by the host';
    if (Y.vid !== s.videoId) { Y.vid = s.videoId; Y.rev = -1; Y.mounting = mount(s); }
    await Y.mounting; if (dead || !Y.ready) return;
    if (s.revision <= Y.rev) return; Y.rev = s.revision;
    if (!isHost) apply();
  }

  async function mount(s) {
    note('');
    if (Y.player && Y.ready) { quiet(); Y.player.cueVideoById({ videoId: s.videoId, startSeconds: s.positionSeconds }); return; }
    if (!(await loadYT()) || !window.YT?.Player) { note('YouTube could not be loaded.'); return; }
    if (dead) return; const wrap = $('#ytwrap');
    if (!$('#ytp')) { const d = document.createElement('div'); d.id = 'ytp'; wrap.prepend(d); }
    await new Promise((res) => {
      Y.player = new window.YT.Player('ytp', { videoId: s.videoId, width: '100%', height: '100%',
        playerVars: { controls: isHost ? 1 : 0, rel: 0, playsinline: 1, disablekb: isHost ? 0 : 1, start: Math.floor(s.positionSeconds) },
        events: { onReady: () => { Y.ready = true; res(); }, onStateChange: onState, onError: onErr } });
    });
  }
  function onErr(e) { note(({ 101: 'This video cannot be embedded.', 150: 'This video cannot be embedded.', 2: 'This video link is invalid.', 100: 'This video is unavailable.' })[e.data] || 'The video could not be played.'); }
  function onState(e) {
    if (isHost) { if (!Y.applying && (e.data === 1 || e.data === 2)) hostWrite(e.data === 1); }
    else if (e.data === 1) note('');
  }
  function apply() {
    const p = Y.player; if (!p || !Y.cur) return; quiet(); p.seekTo(expected(), true);
    if (Y.cur.isPlaying) { p.playVideo(); setTimeout(() => { if (!dead && Y.cur?.isPlaying && ![1, 3].includes(p.getPlayerState())) joinNote(); }, 2000); } else p.pauseVideo();
  }
  function ytLoop() {
    const p = Y.player; if (!p || !Y.ready || dead || !Y.cur) return; Y.tick++;
    const st = p.getPlayerState();
    if (isHost) {
      const t = p.getCurrentTime();
      if (st === 1 && !Y.applying && (Math.abs(t - Y.lastT - 1) > 2.5 || Y.tick % 15 === 0)) hostWrite(true);
      Y.lastT = t; return;
    }
    if (Y.tick % 5) return;
    if (Y.cur.isPlaying) { if (st === 1) { if (Math.abs(p.getCurrentTime() - expected()) > 2.5) { quiet(); p.seekTo(expected(), true); } } else if (st !== 3 && !$('#join')) joinNote(); }
    else if (st === 1) p.pauseVideo();
  }

  return stop;
}
