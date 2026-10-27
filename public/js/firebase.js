import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js';
import { getAuth } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js';
import { getFirestore } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';
import { getStorage } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-storage.js';
import { firebaseConfig as cfg } from '/firebase-config.js';

export const configured = Boolean(cfg.apiKey && !cfg.apiKey.startsWith('YOUR_') && cfg.projectId && !cfg.projectId.startsWith('YOUR_'));
const app = configured ? initializeApp(cfg) : null;
export const auth = app && getAuth(app);
export const db = app && getFirestore(app);
export const storage = app && getStorage(app);
