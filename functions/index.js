// Server-side cleanup. Requires the Blaze plan. Deletes Storage files and every Firestore document
// (items, comments) of pages that are expired or deleted, with retries on the next run.
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { onDocumentUpdated } = require('firebase-functions/v2/firestore');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');
const { getStorage } = require('firebase-admin/storage');

initializeApp();
const db = getFirestore();

async function purge(id) {
  await getStorage().bucket().deleteFiles({ prefix: `pages/${id}/`, force: true });
  await db.recursiveDelete(db.collection('pages').doc(id)); // page + items + comments
}

// Safety net: every 15 minutes, purge anything expired or marked deleted.
exports.cleanupExpiredPages = onSchedule({ schedule: 'every 15 minutes', timeZone: 'UTC', memory: '512MiB', timeoutSeconds: 540 }, async () => {
  const [expired, deleted] = await Promise.all([
    db.collection('pages').where('expiresAt', '<=', Timestamp.now()).limit(200).get(),
    db.collection('pages').where('status', '==', 'deleted').limit(200).get(),
  ]);
  const ids = new Set([...expired.docs, ...deleted.docs].map((d) => d.id));
  for (const id of ids) {
    try { await purge(id); } catch (e) { console.error('purge failed, will retry', id, e); }
  }
});

// Fast path: purge right after the host deletes a page.
exports.purgeDeletedPage = onDocumentUpdated('pages/{pageId}', async (event) => {
  if (event.data.after.data()?.status === 'deleted') await purge(event.params.pageId);
});
