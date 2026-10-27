# Openframe

Share it. While it lasts. Pure vanilla HTML, CSS and ES modules. **No build step, no npm for the web app.**
Firebase Auth (anonymous), Firestore, Storage, Hosting. One Cloud Functions codebase for reliable cleanup.

## Layout
- `public/` the whole site (index.html, css/, js/, vendor/lucide + qrcode-generator, firebase-config.js)
- `firestore.rules`, `storage.rules`, `firebase.json`, `cors.json`
- `functions/` scheduled + on-delete cleanup (needs the Blaze plan)

## Setup (step by step)
1. Create a Firebase project. Upgrade to **Blaze** (needed for Functions and Storage in new projects; set a budget alert).
2. Authentication > Sign-in method > enable **Anonymous**.
3. Create **Firestore** (production mode) and **Storage** (same region).
4. Project settings > Your apps > Web: copy the config into `public/firebase-config.js`.
5. Storage CORS (needed for file preview and download): `gsutil cors set cors.json gs://YOUR_BUCKET`. Edit `origin` to your domain.
6. `npm i -g firebase-tools`, `firebase login`, `firebase use YOUR_PROJECT_ID`.
7. `cd functions && npm install && cd ..`
8. `firebase deploy` (hosting, rules, functions). Accept the prompt granting Storage rules access to Firestore.
9. Local preview: `firebase emulators:start --only hosting` or `npx serve -s public`. Add `localhost` under Authentication > Settings > Authorized domains.

## How it works
- Everyone signs in anonymously. `hostUid` is immutable; only the host can add, edit, delete content, set the video, extend or delete the page.
- Expiry is enforced by Firestore and Storage rules (`status == 'active' && expiresAt > request.time`), not by timers.
- Files are read with the Storage SDK (`getBytes`), never `getDownloadURL`, so no permanent token links exist. Limit 25 MB; executable, HTML, SVG and script types are rejected by the client and by `storage.rules`.
- Each file has an item document (`originalName, contentType, size, storagePath, createdAt, createdBy`). Images under 10 MB preview inline, video loads on click, everything has Download.
- **Cleanup:** `cleanupExpiredPages` runs every 15 minutes and deletes expired and deleted pages: all Storage files under `pages/{id}/` plus the page, items and comments (`recursiveDelete`). `purgeDeletedPage` does the same immediately after the host deletes. Failures are retried on the next run. The browser also attempts cleanup, but the functions are the dependable path.
- YouTube: host player is authoritative; state is written on play, pause, seek, video change and a 15 s checkpoint. Viewers seek to the expected position and correct drift over 2.5 s. Best effort, not frame perfect. Expected position uses the viewer's clock.

## Known limitations
- Cleanup needs Blaze. Without it, access is still blocked at expiry but data stays until deleted manually.
- Comment rate limiting is a client cooldown plus rule validation. Server-side limits need App Check.
- Losing the browser's anonymous session loses host control.
- Not yet verified against a live Firebase project; see TESTING.md.
