import { configured, auth, db } from '/js/firebase.js';
import { signInAnonymously } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js';
import { doc, getDoc, setDoc, serverTimestamp, Timestamp } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';
import { shell, $, esc, ico, paint, modal } from '/js/ui.js';
import { openPage } from '/js/page.js';

const ID_RE = /^[A-Za-z0-9]{6}$/;
const DURATIONS = [['30 min', 30], ['1 hour', 60], ['6 hours', 360], ['24 hours', 1440], ['7 days', 10080]];
const state = { teardown: null };

export function go(path) { history.pushState({}, '', path); route(); }
addEventListener('popstate', route);
document.addEventListener('click', (e) => {
  const a = e.target.closest('a[data-link]');
  if (a && !e.metaKey && !e.ctrlKey && !e.shiftKey) { e.preventDefault(); go(a.getAttribute('href')); }
});

export function unavailable(title) {
  shell(`<main class="center"><div class="center-card"><span class="center-mark">${ico('clock')}</span><h1>${esc(title)}</h1><p class="mut">Nothing here can be viewed any more.</p><a class="btn dark" href="/" data-link>Return home</a></div></main>`);
}

function newId() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join('');
}

function landing() {
  shell(`<main class="home"><section class="intro">
      <span class="label">${ico('scan-line')} Temporary sharing</span>
      <h1>Share it.<br><em>While it lasts.</em></h1>
      <p>Put text, links, files and video on one page. Anyone with the link can see it. No account needed.</p>
      <div class="actions"><button class="create" id="c"><span class="mark">${ico('plus')}</span><span>Create a page</span>${ico('arrow-up-right')}</button>
        <button class="join" id="j"><span>Join a page</span>${ico('arrow-right')}</button></div>
    </section>
    <aside class="help"><div class="help-h">${ico('clock-3')}<h2>How it works</h2></div><ol>
      <li><span>1</span><p>Create a page and pick how long it lasts.</p></li>
      <li><span>2</span><p>Share the link or QR code with anyone.</p></li>
      <li><span>3</span><p>Add content. The page clears itself when time runs out.</p></li></ol></aside></main>`);
  $('#c').onclick = createModal; $('#j').onclick = joinModal;
}

function createModal() {
  const m = modal(`<h2>Create a page</h2><p class="mut">How long should it last?</p>
    <form id="cf"><div class="chips">${DURATIONS.map(([l, v], i) => `<label><input type="radio" name="d" value="${v}" ${i === 1 ? 'checked' : ''}><span>${l}</span></label>`).join('')}</div>
    <p class="err" id="e" hidden></p><div class="row end"><button class="btn dark" type="submit">Create page ${ico('arrow-right')}</button></div></form>`);
  m.el.querySelector('#cf').onsubmit = async (ev) => {
    ev.preventDefault();
    const mins = Number(new FormData(ev.target).get('d'));
    if (!DURATIONS.some(([, v]) => v === mins)) return;
    const btn = ev.target.querySelector('button'); btn.disabled = true; btn.textContent = 'Creating…';
    const id = newId();
    try {
      await setDoc(doc(db, 'pages', id), { hostUid: auth.currentUser.uid, createdAt: serverTimestamp(), expiresAt: Timestamp.fromMillis(Date.now() + mins * 60000), status: 'active', schemaVersion: 1, title: '', youtubeState: null });
      m.close(); go('/p/' + id);
    } catch (err) {
      console.error(err); btn.disabled = false; btn.innerHTML = `Create page ${ico('arrow-right')}`; paint();
      const e = m.el.querySelector('#e'); e.hidden = false; e.textContent = 'Could not create the page. Check your connection and try again.';
    }
  };
}

function joinModal() {
  const m = modal(`<h2>Join a page</h2><p class="mut">Paste the page link or its code.</p>
    <form id="jf"><div class="joinbox"><input id="ji" type="text" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="Link or code" aria-label="Page link or code"><button class="go" type="submit" aria-label="Join">${ico('arrow-right')}</button></div><p class="err" id="e" hidden></p></form>`);
  m.el.querySelector('#jf').onsubmit = async (ev) => {
    ev.preventDefault();
    const raw = m.el.querySelector('#ji').value.trim(), e = m.el.querySelector('#e'); e.hidden = true;
    let id = raw; try { const x = new URL(raw).pathname.match(/\/p\/([^/]+)/); if (x) id = x[1]; } catch { /* plain code */ }
    if (!ID_RE.test(id)) { e.hidden = false; e.textContent = 'That is not a valid Openframe link or code.'; return; }
    const btn = ev.target.querySelector('button'); btn.disabled = true;
    try {
      const s = await getDoc(doc(db, 'pages', id)); const d = s.data();
      if (!s.exists()) throw new Error('missing');
      if (d.status !== 'active') throw new Error('gone');
      if (d.expiresAt.toMillis() <= Date.now()) throw new Error('gone');
      m.close(); go('/p/' + id);
    } catch (err) {
      btn.disabled = false; e.hidden = false;
      e.textContent = err.message === 'missing' ? 'No page found with that link.' : 'This page has expired or is no longer available.';
    }
  };
}

function about() {
  shell(`<main class="about"><section class="about-hero"><span class="label">About</span><h1>One page.<br><em>Gone on time.</em></h1>
    <p>Openframe is a temporary page for handing things over: text, links, files, images, video and a shared YouTube watch-along. The host adds content, everyone with the link can read it and comment without an account.</p>
    <a class="btn dark" href="/" data-link>Create a page ${ico('arrow-right')}</a></section>
    <section class="about-grid">
      <article><span class="ic">${ico('clock-3')}</span><h3>Expires on schedule</h3><p>Pick 30 minutes to 7 days. When time is up, access closes and the data is deleted.</p></article>
      <article><span class="ic">${ico('qr-code')}</span><h3>Link or QR</h3><p>Share the page URL or let someone scan the QR code on the page.</p></article>
      <article><span class="ic">${ico('send')}</span><h3>No accounts</h3><p>Viewers just open the link. Hosts are identified by an anonymous sign-in in their browser, so clearing site data or switching device means losing host control.</p></article>
    </section></main>`);
}

function route() {
  state.teardown?.(); state.teardown = null;
  const p = location.pathname.replace(/\/$/, '') || '/';
  const m = p.match(/^\/p\/([A-Za-z0-9]{6})$/);
  if (p === '/') landing(); else if (p === '/about') about();
  else if (m) state.teardown = openPage(m[1]);
  else unavailable('This page is no longer available');
}

async function start() {
  if (!configured) { shell(`<main class="center"><div class="center-card"><h1>Firebase is not configured</h1><p class="mut">Add your web app config to public/firebase-config.js, then reload.</p></div></main>`); return; }
  try { await auth.authStateReady(); if (!auth.currentUser) await signInAnonymously(auth); }
  catch (err) {
    console.error(err);
    shell(`<main class="center"><div class="center-card"><h1>Could not sign in</h1><p class="mut">Enable Anonymous sign-in in Firebase Authentication and check your connection.</p><button class="btn dark" onclick="location.reload()">Retry</button></div></main>`); return;
  }
  route();
}
start();
