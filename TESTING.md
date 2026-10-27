# Manual test checklist (needs a live Firebase project, two browsers)
## Media
- [ ] Upload a PNG, MP4, PDF and a 26 MB file (last must be refused). Progress bar shows.
- [ ] Image previews inline; click opens the lightbox. Video loads on Preview. Download saves the original filename.
- [ ] Viewer window sees new items live, has no composer, no delete buttons, and cannot write (try in console).
- [ ] Host deletes an item: Firestore doc and Storage object both disappear.
## Expiry and cleanup
- [ ] Create a 30 min page, in Firestore edit `expiresAt` to the past: open pages show "This page has expired", new writes fail.
- [ ] Within 15 min, `pages/{id}`, its items, comments and Storage files are gone. Check Functions logs.
- [ ] Host Delete page: other window shows unavailable; data purged within a minute.
## YouTube (host + 2 viewers)
- [ ] Set a link: viewers load the video. Play, pause, seek on host: viewers follow within ~2 s.
- [ ] Replace the video: viewers switch. Remove: section disappears for viewers.
- [ ] Open a viewer mid-playback: it seeks to the host position. If autoplay is blocked, "Join playback" appears and works.
- [ ] Non-embeddable video shows an error note. Viewers cannot control playback.
## General
- [ ] Phone widths 320, 390, 768: no horizontal scroll; tabs switch Page and Share. Dark mode toggle persists.
