/* BossPlay PWA — lecteur de ta bibliothèque Google Drive (Artiste/Album/Titre), pour iPhone, iPad et tout navigateur.
   Paroles : LRCLIB. Clips : YouTube (lecteur officiel intégré, ou l'appli YouTube / YouTube Music). */
'use strict';

const VERSION = '1.6.0';   // même numéro que le cache dans sw.js (bp-app-…) : les deux se changent ensemble
const YT_KEY = 'AIzaSyDoAxJzDHTkIPDqZbVcLr2Aguu40kPZqio';            // clé « BossPlayPWA » (limitée à bosseagle-la.github.io)
// Lecture de la musique + dossier caché de BossPlay (profil de chacun) + fichiers créés par BossPlay (index de la bibliothèque).
const SCOPE = 'https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/drive.appdata https://www.googleapis.com/auth/drive.file';
const FAMILY = ['Boss', 'Sam', 'Adam', 'Sofia'];
const KIDS = ['Adam', 'Sofia'];   // profils des enfants : aucun accès aux Réglages, ni au compte Google, ni aux connexions
const PROFILE_FILE = 'bossplay-profil.json';
const INDEX_FILE = 'bossplay-index.json';
const DEFAULT_CLIENT = '660248878537-3pvnlm8fkk4r9heemoa4p7aq5am0h8gg.apps.googleusercontent.com';   // ID client OAuth « BossPlay PWA »
const AUDIO_EXT = /\.(mp3|m4a|aac|mp4|flac|wav|aif|aiff|ogg|opus)$/i;
const MIME = { mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', mp4: 'audio/mp4', flac: 'audio/flac', wav: 'audio/wav', aif: 'audio/aiff', aiff: 'audio/aiff', ogg: 'audio/ogg', opus: 'audio/ogg' };

// ---------- Petits outils ----------
const $ = (s, el = document) => el.querySelector(s);
function h(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  if (attrs) for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k === 'html') e.innerHTML = v;
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) e.append(k instanceof Node ? k : String(k));
  return e;
}
const fold = s => (s || '').normalize('NFD').replace(/\p{Mn}+/gu, '').toLowerCase();
const fmt = sec => { sec = Math.max(0, Math.floor(sec || 0)); return Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0'); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const RBASE = 'https://radio.bossplay.workers.dev';   // relais BossPlay (Cloudflare)
function toast(msg, ms = 2600) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => { t.hidden = true; }, ms);
}
const store = {
  get(k, d) { try { const v = localStorage.getItem('bp.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('bp.' + k, JSON.stringify(v)); } catch { } },
};
// Base IndexedDB (bibliothèque, paroles) : clé → valeur.
const idb = {
  _p: null,
  open() {
    return this._p || (this._p = new Promise((res, rej) => {
      const r = indexedDB.open('bossplay', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('kv');
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    }));
  },
  async get(k) {
    try { const d = await this.open(); return await new Promise(res => { const q = d.transaction('kv').objectStore('kv').get(k); q.onsuccess = () => res(q.result); q.onerror = () => res(undefined); }); }
    catch { return undefined; }
  },
  async set(k, v) {
    try { const d = await this.open(); await new Promise(res => { const t = d.transaction('kv', 'readwrite'); t.objectStore('kv').put(v, k); t.oncomplete = res; t.onerror = res; }); } catch { }
  },
};
async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; try { await fn(items[k], k); } catch { } } }));
}

// ---------- Réglages ----------
const S = Object.assign({
  clientId: '', rootId: '', rootName: '', theme: 'auto',
  clipPlayer: 'integrated', clipLyrics: 'subs', clipAuto: true, afterReturn: 'next',
}, store.get('settings', {}));
if (!S.clientId) S.clientId = DEFAULT_CLIENT;
const saveS = () => store.set('settings', S);
const favs = { tracks: new Set(store.get('favTracks', [])), albums: new Set(store.get('favAlbums', [])) };
// Favoris datés (synchronisation) : 't:id' / 'a:id' → +date (favori) ou −date (retiré).
let favTs = store.get('favTs', null);
if (!favTs) { favTs = {}; favs.tracks.forEach(id => favTs['t:' + id] = 1); favs.albums.forEach(id => favTs['a:' + id] = 1); }
const saveFavs = () => { store.set('favTracks', [...favs.tracks]); store.set('favAlbums', [...favs.albums]); store.set('favTs', favTs); markDirty(); };
function setFav(kind, id, on) {
  favTs[kind + ':' + id] = on ? Date.now() : -Date.now();
  (kind === 't' ? favs.tracks : favs.albums)[on ? 'add' : 'delete'](id);
  saveFavs();
}
function toggleFav(kind, id) { setFav(kind, id, !(kind === 't' ? favs.tracks : favs.albums).has(id)); }
let playlists = store.get('playlists', []);
let plDeleted = store.get('plDeleted', {});
const savePl = (p) => { if (p) p.ts = Date.now(); store.set('playlists', playlists); store.set('plDeleted', plDeleted); markDirty(); };
let playLog = store.get('history', []);     // écoutes : [{ id, at }]
const offline = new Set(store.get('offline', []));      // titres gardés sur l'appareil
const saveOff = () => store.set('offline', [...offline]);

// ---------- Connexion Google Drive ----------
let tok = store.get('token', null);   // { t, exp }
let tokenClient = null;
let tokenWaiters = [];
function hasToken() { return tok && Date.now() < tok.exp; }
function loadGis() {
  if (window.google?.accounts?.oauth2) return Promise.resolve(true);
  if (loadGis._p) return loadGis._p;
  loadGis._p = new Promise(res => {
    const s = h('script', { src: 'https://accounts.google.com/gsi/client', async: true });
    s.onload = () => res(true); s.onerror = () => { loadGis._p = null; res(false); };
    document.head.append(s);
  });
  return loadGis._p;
}
async function initAuth() {
  if (tokenClient || !S.clientId) return !!tokenClient;
  if (!(await loadGis())) return false;
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: S.clientId, scope: SCOPE,
    callback: r => {
      if (r && r.access_token) {
        tok = { t: r.access_token, exp: Date.now() + (Number(r.expires_in || 3600) - 120) * 1000, scope: r.scope || '' };
        store.set('token', tok);
        banner();
        whoAmI();
      }
      tokenWaiters.splice(0).forEach(f => f(hasToken() ? tok.t : null));
    },
    error_callback: () => tokenWaiters.splice(0).forEach(f => f(null)),
  });
  return true;
}
/** Demande la connexion (à appeler depuis un appui : Safari bloque sinon la fenêtre Google). */
async function connect() {
  if (!S.clientId) { toast('Ajoute d\'abord l\'ID client OAuth dans Réglages.'); go('settings'); return null; }
  if (!(await initAuth())) { toast('Impossible de charger la connexion Google (réseau ?).'); return null; }
  return new Promise(res => { tokenWaiters.push(res); tokenClient.requestAccessToken({ prompt: store.get('connected', false) ? '' : 'consent' }); store.set('connected', true); });
}
async function token() {
  if (hasToken()) return tok.t;
  banner(true);
  throw new Error('auth');
}
async function drive(path, params = {}, raw = false) {
  const u = new URL('https://www.googleapis.com/drive/v3/' + path);
  for (const [k, v] of Object.entries(params)) if (v != null) u.searchParams.set(k, v);
  const r = await fetch(u, { headers: { Authorization: 'Bearer ' + await token() } });
  if (r.status === 401) { tok = null; store.set('token', null); banner(true); throw new Error('auth'); }
  if (!r.ok) throw new Error('drive ' + r.status);
  return raw ? r : r.json();
}
async function listAll(q, fields) {
  const out = []; let pageToken;
  do {
    const j = await drive('files', { q, fields: 'nextPageToken,' + fields, pageSize: 1000, pageToken, supportsAllDrives: true, includeItemsFromAllDrives: true });
    out.push(...(j.files || [])); pageToken = j.nextPageToken;
    setStatus(`Lecture de Google Drive… ${out.length}`);
  } while (pageToken);
  return out;
}
function banner(need) {
  const b = $('#banner');
  const oldScope = hasToken() && !String(tok.scope || '').includes('drive.appdata');
  if (need === undefined) need = (!hasToken() && !!S.rootId) || oldScope;
  if (!need || (hasToken() && !oldScope)) { b.hidden = true; return; }
  b.replaceChildren(h('span', null, oldScope ? 'Nouveauté : reconnecte-toi pour retrouver tes favoris sur tous tes appareils.' : S.clientId ? 'Connexion à Google Drive expirée.' : 'BossPlay n\'est pas encore relié à Google Drive.'),
    h('button', { onclick: async () => { const t = await connect(); if (t) { b.hidden = true; if (!lib.tracks.length && S.rootId) scan(); } } }, 'Se connecter'));
  b.hidden = false;
}

// ---------- Profils et synchronisation ----------
// Chacun se connecte avec SON compte Google. Son profil (favoris, playlists, clips, écoutes, réglages) est gardé
// dans le dossier caché de BossPlay de SON Google Drive : rien ne se mélange entre Boss, Sam, Adam et Sofia.
// Administrateur = le compte qui peut modifier le dossier de musique (Boss) ; Google interdit l'écriture aux autres.
const sync = { me: store.get('me', null), admin: store.get('admin', false), name: store.get('profileName', ''),
  fileId: store.get('syncFileId', null), last: store.get('syncLast', 0), dirty: store.get('syncDirty', false), timer: 0, busy: false, error: '' };
function markDirty() {
  sync.dirty = true; store.set('syncDirty', true);
  clearTimeout(sync.timer); sync.timer = setTimeout(() => push(), 4000);
}
function addPlay(id) {
  playLog.push({ id, at: Date.now() });
  if (playLog.length > 5000) playLog = playLog.slice(-5000);
  store.set('history', playLog); markDirty();
}
async function gfetch(url, opts = {}) {
  const r = await fetch(url, Object.assign({}, opts, { headers: Object.assign({ Authorization: 'Bearer ' + await token() }, opts.headers || {}) }));
  if (r.status === 401) { tok = null; store.set('token', null); banner(true); throw new Error('auth'); }
  return r;
}
async function whoAmI() {
  try {
    const j = await drive('about', { fields: 'user(displayName,emailAddress)' });
    const changed = !sync.me || sync.me.email !== j.user.emailAddress;
    sync.me = { email: j.user.emailAddress, name: j.user.displayName };
    store.set('me', sync.me);
    if (changed) { sync.fileId = null; store.set('syncFileId', null); }
    if (S.rootId) {
      const f = await drive('files/' + S.rootId, { fields: 'capabilities(canEdit),ownedByMe', supportsAllDrives: true });
      sync.admin = !!(f.ownedByMe || f.capabilities?.canEdit);
      store.set('admin', sync.admin);
    }
    await pull();
    avLoad(false);
    if (!sync.name) pickProfile();
    else if (sync.name === 'Boss' && sync.admin && !bossOk) enterBoss();
    if (isBoss()) loadFamilyWishes();
    pinShare(); rcKick();
    render();
  } catch (e) { if (e.message !== 'auth') { sync.error = e.message; } }
}
// Profil Boss protégé par un code (4 à 6 chiffres), propre à cet appareil, gardé chiffré (empreinte SHA-256).
// Les droits d'administration ne valent que dans le profil Boss, même sur le compte Google de Boss.
// Le code n'est demandé que lorsqu'on passe d'un autre profil à Boss ; l'appareil de Boss reste ouvert.
let bossOk = localStorage.getItem('bossOk') === '1';
const isBoss = () => sync.admin && sync.name === 'Boss' && bossOk;
async function pinHash(code) {
  const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('bossplay:' + code));
  return [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('');
}
function pinDialog(title, sub, onCode) {
  const inp = h('input', { type: 'password', inputmode: 'numeric', pattern: '[0-9]*', autocomplete: 'off', maxlength: '6', placeholder: '••••',
    style: 'font-size:28px;letter-spacing:10px;text-align:center;width:100%;box-sizing:border-box;padding:12px;border-radius:14px' });
  const ok = () => { const c = inp.value.replace(/\D/g, ''); if (c.length < 4) { toast('4 à 6 chiffres'); inp.focus(); return; } $('#sheet').hidden = true; onCode(c); };
  inp.addEventListener('keydown', e => { if (e.key === 'Enter') ok(); });
  sheet(title, [
    h('div', { class: 'muted small', style: 'padding:0 12px 8px' }, sub),
    h('div', { style: 'padding:0 12px 10px' }, inp),
    h('button', { class: 'it', onclick: ok }, 'Valider'),
  ]);
  setTimeout(() => inp.focus(), 80);
}
const isKid = () => KIDS.includes(sync.name);
// Le code de Boss est commun à toute la famille : son empreinte est gardée par le relais BossPlay.
// Ainsi, sur l'appareil d'un enfant (où Boss n'a jamais tapé son code), personne ne peut « créer » un code de Boss.
async function pinAsk(body) {
  const r = await fetch(RBASE + '/pin', { method: 'POST', headers: { Authorization: 'Bearer ' + await token(), 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error('relais ' + r.status);
  return r.json();
}
// Passe à un profil d'adulte après vérification du code de Boss. « who » = 'Boss' ou 'Sam'.
function enterBoss(who = 'Boss') {
  const saved = store.get('bossPin', '');
  const become = () => {
    bossOk = who === 'Boss'; bossOk ? localStorage.setItem('bossOk', '1') : localStorage.removeItem('bossOk');
    sync.name = who; store.set('profileName', who); markDirty(); render(); rcKick(); toast('Bonjour ' + who + ' !');
  };
  const create = () => pinDialog('Créer le code de Boss', 'Ce code protège les profils des adultes et les Réglages, sur tous les appareils de la famille.', c1 =>
    pinDialog('Confirmer le code', 'Retape le même code.', async c2 => {
      if (c1 !== c2) { toast('Les deux codes sont différents.'); return create(); }
      const hh = await pinHash(c1);
      try { const j = await pinAsk({ op: 'set', h: hh }); if (!j.match) { toast('Un code de Boss existe déjà : tape-le.'); return enterBoss(who); } } catch { }
      store.set('bossPin', hh); become();
    }));
  pinDialog('Code de Boss', who === 'Boss' ? 'Profil administrateur protégé.' : 'Demande à papa : son code est nécessaire pour quitter un profil d\'enfant.', async c => {
    const hh = await pinHash(c);
    let j = null;
    try { j = await pinAsk({ op: 'check', h: hh }); } catch { }
    if (j && j.wait) return toast('Trop d\'essais : réessaie dans ' + Math.ceil(j.wait / 60) + ' min.');
    if (j && j.set) {                                   // le relais connaît le code : c'est lui qui décide
      if (!j.match) return toast('Code faux.');
      store.set('bossPin', hh); return become();
    }
    if (saved) {                                        // relais muet ou pas encore de code commun : code gardé sur cet appareil
      if (hh !== saved) return toast('Code faux.');
      if (j) pinAsk({ op: 'set', h: hh }).catch(() => { });   // on le rend commun à la famille
      return become();
    }
    if (j && !j.set && !isKid()) return create();       // tout premier code de la famille
    if (j && !j.set) return toast('Boss n\'a pas encore créé son code.');
    toast('Vérification impossible sans Internet : réessaie plus tard.');
  });
}
// Sur l'appareil de Boss : rend commun le code déjà créé ici (une seule fois, sans rien demander).
async function pinShare() {
  const saved = store.get('bossPin', '');
  if (!saved || !isBoss() || !hasToken() || store.get('pinShared', false)) return;
  try { const j = await pinAsk({ op: 'state' }); if (!j.set) await pinAsk({ op: 'set', h: saved }); store.set('pinShared', true); } catch { }
}
// ---------- Avatars (Google Drive › BossPlay › Avatars) ----------
const AV = { names: [], urls: {}, folder: null, choicesId: null, picks: store.get('avPicks', {}), loading: false };
async function avFolder() {
  if (AV.folder) return AV.folder;
  const base = "name='Avatars' and mimeType='application/vnd.google-apps.folder' and trashed=false";
  let j = S.rootId ? await drive('files', { q: base + ` and '${S.rootId}' in parents`, fields: 'files(id)', supportsAllDrives: true, includeItemsFromAllDrives: true }) : null;
  if (!j?.files?.length) j = await drive('files', { q: base, fields: 'files(id)', supportsAllDrives: true, includeItemsFromAllDrives: true });
  AV.folder = j.files?.[0]?.id || null;
  return AV.folder;
}
async function avLoad(say) {
  if (AV.loading || !hasToken()) return;
  AV.loading = true;
  try {
    const fid = await avFolder();
    if (!fid) { if (say) toast('Dossier « Avatars » introuvable dans Google Drive'); return; }
    const j = await drive('files', { q: `'${fid}' in parents and trashed=false`, fields: 'files(id,name,mimeType,size)', pageSize: 500, supportsAllDrives: true, includeItemsFromAllDrives: true });
    const files = j.files || [];
    const ch = files.find(f => f.name === 'bossplay-avatars.json');
    AV.choicesId = ch?.id || null;
    if (ch) { try { const r = await gfetch('https://www.googleapis.com/drive/v3/files/' + ch.id + '?alt=media&supportsAllDrives=true'); const o = await r.json();
      for (const k in o) if (!AV.picks[k] || (o[k].at || 0) > (AV.picks[k].at || 0)) AV.picks[k] = o[k]; store.set('avPicks', AV.picks); } catch { } }
    const imgs = files.filter(f => (f.mimeType || '').startsWith('image/'))
      .sort((a, b) => (parseInt(a.name) || 1e9) - (parseInt(b.name) || 1e9) || a.name.localeCompare(b.name));
    await pool(imgs, 6, async f => {
      const key = 'av:' + f.name + ':' + (f.size || '');
      let blob = await idb.get(key);
      if (!blob) { const r = await gfetch('https://www.googleapis.com/drive/v3/files/' + f.id + '?alt=media&supportsAllDrives=true'); if (!r.ok) return; blob = await r.blob(); await idb.set(key, blob); }
      if (AV.urls[f.name]) URL.revokeObjectURL(AV.urls[f.name]);
      AV.urls[f.name] = URL.createObjectURL(blob);
    });
    AV.names = imgs.map(f => f.name).filter(n => AV.urls[n]);
    if (say) toast(AV.names.length + ' avatars disponibles');
    render();
  } catch (e) { if (say) toast('Avatars : ' + e.message); }
  finally { AV.loading = false; }
}
function avEl(who, cls) {
  const p = AV.picks[who], u = p && AV.urls[p.img];
  return u ? h('img', { class: 'av ' + (cls || ''), src: u, alt: who }) : h('span', { class: 'av ' + (cls || '') }, who[0]);
}
async function avPick(who, name) {
  AV.picks[who] = { img: name, at: Date.now() }; store.set('avPicks', AV.picks); render();
  try {
    const fid = await avFolder(); if (!fid) return;
    const body = JSON.stringify(AV.picks);
    if (AV.choicesId) await gfetch('https://www.googleapis.com/upload/drive/v3/files/' + AV.choicesId + '?uploadType=media&supportsAllDrives=true', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body });
    else { const r = await gfetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=id', multipart({ name: 'bossplay-avatars.json', parents: [fid] }, body, 'application/json')); if (r.ok) AV.choicesId = (await r.json()).id; }
  } catch { /* lecture seule (profils de la famille) : le choix reste sur cet appareil */ }
}
function avGallery() {
  const who = sync.name || 'Boss';
  sheet('Avatar de ' + who, [
    AV.names.length ? h('div', { class: 'gal' }, AV.names.map(n => h('button', { class: AV.picks[who]?.img === n ? 'on' : '', onclick: () => { $('#sheet').hidden = true; avPick(who, n); toast('Avatar de ' + who + ' changé'); } }, h('img', { src: AV.urls[n], alt: n }))))
      : h('div', { class: 'muted small', style: 'padding:0 12px 8px' }, AV.loading ? 'Chargement des avatars…' : 'Ajoute des images dans Google Drive › BossPlay › Avatars.'),
    { label: '↻ Recharger les avatars', fn: () => avLoad(true) },
  ]);
}
function pickProfile() {
  const kid = isKid();
  const choose = n => {
    if (n === sync.name && !(n === 'Boss' && !bossOk)) { $('#sheet').hidden = true; return; }
    $('#sheet').hidden = true;
    if (n === 'Boss' && !sync.admin) { toast('« Boss » est réservé au compte qui gère la musique.'); return; }
    if (n === 'Boss') return enterBoss('Boss');
    if (kid && !KIDS.includes(n)) return enterBoss(n);          // d'un profil d'enfant vers un adulte : code de Boss
    bossOk = false; localStorage.removeItem('bossOk'); sync.name = n; store.set('profileName', n); markDirty();
    if (KIDS.includes(n) && ui.tab === 'settings') ui.tab = 'albums';
    render(); rcKick(); toast('Bonjour ' + n + ' !');
  };
  sheet(h('span', { class: 'who-title' }, 'Qui écoute sur', h('img', { src: 'logo.png', alt: 'BossPlay' }), '?'), [
    h('div', { class: 'who-row' }, FAMILY.map(n => h('button', { class: 'who-p' + (n === sync.name ? ' on' : ''), onclick: () => choose(n) }, avEl(n), h('span', null, n + (n === 'Boss' || (kid && n === 'Sam') ? ' 🔒' : ''))))),
    kid ? null : h('div', { class: 'muted small', style: 'padding:0 12px 6px;text-align:center' }, sync.me ? 'Compte Google : ' + sync.me.email : ''),
    sync.name ? { label: 'Changer mon avatar', fn: () => avGallery() } : null,
    kid ? { label: 'Thème : ' + ({ auto: 'automatique', dark: 'nuit', light: 'jour' })[S.theme] + ' (toucher pour changer)', fn: () => $('#theme').click() } : null,
    kid ? { label: 'Mettre à jour la musique', fn: async () => { if (!hasToken() && !(await connect())) return; toast('Mise à jour de la musique…'); await scan(); store.set('lastScan', Date.now()); toast('Musique à jour'); } } : null,
    isBoss() ? { label: '🔒 Changer le code de Boss', fn: () => pinDialog('Code actuel', 'Pour changer le code, tape d\'abord l\'actuel.', async c => {
      const old = await pinHash(c);
      if (store.get('bossPin', '') && old !== store.get('bossPin', '')) { toast('Code faux.'); return; }
      pinDialog('Nouveau code', '4 à 6 chiffres. Il vaudra sur tous les appareils de la famille.', c1 => pinDialog('Confirmer le code', 'Retape le même code.', async c2 => {
        if (c1 !== c2) return toast('Les deux codes sont différents : rien n\'a changé.');
        const hh = await pinHash(c1);
        try { const j = await pinAsk({ op: 'set', h: hh, old }); if (!j.match) return toast(j.wait ? 'Trop d\'essais : réessaie plus tard.' : 'Refusé par le serveur : code actuel différent.'); }
        catch { return toast('Internet nécessaire pour changer le code.'); }
        store.set('bossPin', hh); toast('Code de Boss changé');
      }));
    }) } : null,
  ]);
}
function profileData() {
  return { v: 1, name: sync.name, updated: Date.now(), favTs, playlists, plDeleted, clips: clipCache, history: playLog,
    prefs: { theme: S.theme, clipPlayer: S.clipPlayer, clipLyrics: S.clipLyrics, clipAuto: S.clipAuto, afterReturn: S.afterReturn }, extra: extraProfile() };
}
function mergeProfile(r) {
  if (!r || typeof r !== 'object') return;
  if (r.name && !sync.name) { sync.name = r.name; store.set('profileName', r.name); }
  for (const [k, v] of Object.entries(r.favTs || {})) if (Math.abs(v) > Math.abs(favTs[k] || 0)) favTs[k] = v;
  favs.tracks = new Set(Object.keys(favTs).filter(k => k.startsWith('t:') && favTs[k] > 0).map(k => k.slice(2)));
  favs.albums = new Set(Object.keys(favTs).filter(k => k.startsWith('a:') && favTs[k] > 0).map(k => k.slice(2)));
  for (const [k, v] of Object.entries(r.plDeleted || {})) if (v > (plDeleted[k] || 0)) plDeleted[k] = v;
  const byId = new Map(playlists.map(p => [p.id, p]));
  for (const p of r.playlists || []) { const mine = byId.get(p.id); if (!mine || (p.ts || 0) > (mine.ts || 0)) byId.set(p.id, p); }
  playlists = [...byId.values()].filter(p => !(plDeleted[p.id] >= (p.ts || 0)));
  for (const [k, v] of Object.entries(r.clips || {})) if (!clipCache[k] || (v.date || 0) > (clipCache[k].date || 0)) clipCache[k] = v;
  const seen = new Set(playLog.map(x => x.id + '@' + x.at));
  for (const x of r.history || []) if (!seen.has(x.id + '@' + x.at)) playLog.push(x);
  playLog.sort((a, b) => a.at - b.at); if (playLog.length > 5000) playLog = playLog.slice(-5000);
  if (r.prefs && (r.updated || 0) > sync.last && !sync.dirty) { Object.assign(S, r.prefs); saveS(); applyTheme(); }
  extraMerge(r.extra);
  store.set('favTracks', [...favs.tracks]); store.set('favAlbums', [...favs.albums]); store.set('favTs', favTs);
  store.set('playlists', playlists); store.set('plDeleted', plDeleted); store.set('clips', clipCache); store.set('history', playLog);
}
async function findProfileFile() {
  if (sync.fileId) return sync.fileId;
  const j = await drive('files', { spaces: 'appDataFolder', q: `name='${PROFILE_FILE}' and trashed=false`, fields: 'files(id,modifiedTime)', pageSize: 10 });
  sync.fileId = j.files?.[0]?.id || null; store.set('syncFileId', sync.fileId);
  return sync.fileId;
}
async function pull() {
  if (!hasToken()) return;
  try {
    const id = await findProfileFile();
    if (id) {
      const r = await gfetch('https://www.googleapis.com/drive/v3/files/' + id + '?alt=media');
      if (r.status === 404) { sync.fileId = null; store.set('syncFileId', null); }
      else if (r.ok) { mergeProfile(await r.json()); }
      else if (r.status === 403) throw new Error('scope');
    }
    sync.error = '';
    if (sync.dirty || !id) await push(true);
    sync.last = Date.now(); store.set('syncLast', sync.last);
  } catch (e) {
    sync.error = e.message === 'scope' || /403/.test(e.message) ? 'Reconnecte-toi (Réglages › Se connecter) pour activer la synchronisation.' : e.message;
  }
}
async function push(force) {
  if (!hasToken() || sync.busy || (!sync.dirty && !force)) return;
  sync.busy = true;
  try {
    const body = JSON.stringify(profileData());
    let r;
    const id = await findProfileFile();
    if (id) {
      r = await gfetch('https://www.googleapis.com/upload/drive/v3/files/' + id + '?uploadType=media', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body });
    }
    if (!id || r.status === 404) {
      const meta = { name: PROFILE_FILE, parents: ['appDataFolder'] };
      r = await gfetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id', multipart(meta, body, 'application/json'));
      if (r.ok) { sync.fileId = (await r.json()).id; store.set('syncFileId', sync.fileId); }
    }
    if (!r.ok) throw new Error('envoi ' + r.status);
    sync.dirty = false; store.set('syncDirty', false);
    sync.last = Date.now(); store.set('syncLast', sync.last); sync.error = '';
  } catch (e) { if (e.message !== 'auth') sync.error = 'Synchronisation en attente (' + e.message + ')'; }
  sync.busy = false;
}
function multipart(meta, body, type) {
  const b = 'bossplay' + Math.random().toString(36).slice(2);
  return { method: 'POST', headers: { 'Content-Type': 'multipart/related; boundary=' + b },
    body: `--${b}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${b}\r\nContent-Type: ${type}\r\n\r\n${body}\r\n--${b}--` };
}
// Index de la bibliothèque, publié par Boss dans le dossier de musique : la famille l'ouvre sans relire tout le Drive.
async function publishIndex(raw, quiet) {
  try {
    raw = raw || await idb.get('library');
    if (!raw) { if (!quiet) toast('Lis d\'abord la musique.'); return; }
    const body = JSON.stringify(raw);
    const j = await drive('files', { q: `'${S.rootId}' in parents and name='${INDEX_FILE}' and trashed=false`, fields: 'files(id)', supportsAllDrives: true, includeItemsFromAllDrives: true });
    let r;
    if (j.files?.[0]) r = await gfetch('https://www.googleapis.com/upload/drive/v3/files/' + j.files[0].id + '?uploadType=media&supportsAllDrives=true', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body });
    else r = await gfetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=id', multipart({ name: INDEX_FILE, parents: [S.rootId] }, body, 'application/json'));
    if (!r.ok) throw new Error(String(r.status));
    if (!quiet) toast('Bibliothèque publiée pour la famille');
  } catch (e) { if (!quiet) toast('Publication impossible (' + e.message + ')'); }
}
async function loadIndex() {
  try {
    setStatus('Ouverture de la bibliothèque familiale…');
    const j = await drive('files', { q: `'${S.rootId}' in parents and name='${INDEX_FILE}' and trashed=false`, fields: 'files(id,modifiedTime)', supportsAllDrives: true, includeItemsFromAllDrives: true });
    const f = j.files?.[0]; if (!f) return false;
    const r = await gfetch('https://www.googleapis.com/drive/v3/files/' + f.id + '?alt=media&supportsAllDrives=true');
    if (!r.ok) return false;
    const raw = await r.json();
    if (!raw || !Array.isArray(raw.tracks)) return false;
    raw.rootId = S.rootId;
    await idb.set('library', raw);
    buildLib(raw);
    setStatus(`${lib.tracks.length} titres · ${lib.albums.length} albums (bibliothèque publiée par Boss)`);
    render();
    return true;
  } catch { return false; }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') push();
  else if (hasToken() && Date.now() - sync.last > 60000) pull().then(() => { if (!clip.on) render(); });
});

// ---------- Bibliothèque ----------
let lib = { tracks: [], albums: [], artists: [], byId: new Map(), albumById: new Map(), artistByKey: new Map() };
let localTracks = [];   // fichiers de l'iPhone (iCloud Drive via l'app Fichiers)
let scanMsg = '';
function setStatus(m) { scanMsg = m; const s = $('#scanmsg'); if (s) s.textContent = m; }

function parseName(file) {
  let base = file.replace(/\.[^.]+$/, '');
  let disc = 1, no = 0;
  let m = base.match(/^(\d{1,2})[-.](\d{1,3})(?!\d)\s*[-.]?\s*/);
  if (m) { disc = +m[1]; no = +m[2]; base = base.slice(m[0].length); }
  else if ((m = base.match(/^(\d{1,3})(?!\d)\s*[-.)]?\s+/))) { no = +m[1]; base = base.slice(m[0].length); }
  return { title: base.replace(/_/g, '\'').trim() || file, disc, no };
}
function buildLib(raw) {
  const albums = new Map(), artists = new Map();
  const tracks = raw.tracks.map(t => Object.assign({}, t));
  for (const t of tracks) {
    let a = albums.get(t.albumId);
    if (!a) { const aa = t.albumArtist || t.artist; a = { id: t.albumId, name: t.album, artist: aa, artistKey: fold(aa), tracks: [], cover: raw.covers[t.albumId] || null }; albums.set(a.id, a); }
    a.tracks.push(t);
  }
  for (const a of albums.values()) {
    a.tracks.sort((x, y) => x.disc - y.disc || x.no - y.no || x.title.localeCompare(y.title, 'fr'));
    let ar = artists.get(a.artistKey);
    if (!ar) { ar = { key: a.artistKey, name: a.artist, albums: [], photo: raw.photos[a.artistKey] || null }; artists.set(ar.key, ar); }
    ar.albums.push(a);
  }
  const al = [...albums.values()].sort((x, y) => x.artist.localeCompare(y.artist, 'fr') || x.name.localeCompare(y.name, 'fr'));
  const ars = [...artists.values()].sort((x, y) => x.name.localeCompare(y.name, 'fr'));
  const all = al.flatMap(a => a.tracks);
  lib = { tracks: all, albums: al, artists: ars, byId: new Map(all.map(t => [t.id, t])), albumById: albums, artistByKey: artists };
  for (const t of localTracks) lib.byId.set(t.id, t);
}

async function scan(full = false) {
  if (!S.rootId) { toast('Choisis d\'abord le dossier de musique dans Réglages.'); go('settings'); return; }
  // Famille : l'index publié par Boss évite de relire tout le Drive.
  if (!full && !sync.admin && await loadIndex()) return;
  try {
    setStatus('Lecture de Google Drive…');
    // Les trois listes en même temps (au lieu de l'une après l'autre).
    const [folders, audio, images] = await Promise.all([
      listAll("mimeType='application/vnd.google-apps.folder' and trashed=false", 'files(id,name,parents)'),
      listAll("mimeType contains 'audio/' and trashed=false", 'files(id,name,parents,size,mimeType)'),
      listAll("mimeType contains 'image/' and trashed=false", 'files(id,name,parents)'),
    ]);
    const fmap = new Map(folders.map(f => [f.id, f]));
    const under = new Map();
    const inRoot = id => {
      if (under.has(id)) return under.get(id);
      let x = id, d = 0, ok = false; const seen = [];
      while (x && d++ < 15) { if (x === S.rootId) { ok = true; break; } if (under.has(x)) { ok = under.get(x); break; } seen.push(x); x = fmap.get(x)?.parents?.[0]; }
      seen.forEach(s => under.set(s, ok)); under.set(id, ok); return ok;
    };
    const tracks = [];
    for (const f of audio) {
      const pid = f.parents?.[0];
      if (!pid || !inRoot(pid) || !AUDIO_EXT.test(f.name)) continue;
      const p = fmap.get(pid);
      const gp = p && p.id !== S.rootId ? fmap.get(p.parents?.[0]) : null;
      let album = p && p.id !== S.rootId ? p.name : 'Titres isolés';
      let artist = gp && gp.id !== S.rootId ? gp.name : '';
      const pn = parseName(f.name);
      let title = pn.title;
      if (!artist) {
        const m = album.match(/^(.+?)\s+-\s+(.+)$/);
        if (m) { artist = m[1]; album = m[2]; }
      }
      let albumArtist = artist;
      const tm = title.match(/^(.+?)\s+-\s+(.+)$/);
      const various = !artist || /various|divers|compil/i.test(artist);
      if (tm && (various || fold(tm[1]) === fold(artist))) { if (various) artist = tm[1]; title = tm[2]; }
      artist = (artist || 'Artiste inconnu').replace(/_/g, '/');
      albumArtist = (albumArtist || artist).replace(/_/g, '/');
      tracks.push({ id: f.id, name: f.name, title, artist, albumArtist, album, albumId: pid, disc: pn.disc, no: pn.no, size: +f.size || 0, mime: f.mimeType });
    }
    const covers = {}, photos = {};
    const pref = n => { const b = fold(n.replace(/\.[^.]+$/, '')); return b === 'cover' ? 0 : b === 'folder' ? 1 : b === 'front' ? 2 : /cover|front|folder|album/.test(b) ? 3 : 9; };
    const byParent = new Map();
    for (const im of images) { const pid = im.parents?.[0]; if (!pid) continue; (byParent.get(pid) || byParent.set(pid, []).get(pid)).push(im); }
    const albumIds = new Set(tracks.map(t => t.albumId));
    for (const id of albumIds) { const l = byParent.get(id); if (l) covers[id] = l.slice().sort((a, b) => pref(a.name) - pref(b.name))[0].id; }
    for (const t of tracks) {
      const gpId = fmap.get(t.albumId)?.parents?.[0];
      const key = fold(t.albumArtist || t.artist);
      if (photos[key] || !gpId || gpId === S.rootId) continue;
      const l = byParent.get(gpId);
      if (l) { const a = l.find(x => /^artist\./i.test(x.name)) || l[0]; photos[key] = a.id; }
    }
    const raw = { rootId: S.rootId, date: Date.now(), tracks, covers, photos };
    await idb.set('library', raw);
    buildLib(raw);
    if (sync.admin) publishIndex(raw, true);
    setStatus(`${lib.tracks.length} titres · ${lib.albums.length} albums · ${lib.artists.length} artistes`);
    render();
  } catch (e) {
    setStatus(e.message === 'auth' ? 'Connecte-toi à Google Drive pour lire ta musique.' : 'Lecture impossible : ' + e.message);
  }
}

// ---------- Pochettes (cache de l'appareil) ----------
const coverURL = new Map();   // clé → URL objet
let coverCache = null;
const coverQueue = [];
let coverBusy = 0;
async function cacheOpen(name) { try { return await caches.open(name); } catch { return null; } }
function wantCover(key, fn) {
  if (coverURL.has(key)) { fn(coverURL.get(key)); return; }
  coverQueue.push([key, fn]); pumpCovers();
}
function pumpCovers() {
  while (coverBusy < 4 && coverQueue.length) {
    const [key, fn] = coverQueue.shift();
    coverBusy++;
    loadCover(key).then(u => { if (u) fn(u); }).finally(() => { coverBusy--; pumpCovers(); });
  }
}
async function shrink(blob, max = 600) {
  try {
    const bmp = await createImageBitmap(blob);
    const k = Math.min(1, max / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas'); c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    return await new Promise(res => c.toBlob(b => res(b || blob), 'image/jpeg', 0.86));
  } catch { return blob; }
}
async function loadCover(key) {
  if (coverURL.has(key)) return coverURL.get(key);
  coverCache = coverCache || await cacheOpen('bp-covers');
  const req = 'https://bossplay.local/cover/' + encodeURIComponent(key);
  let blob = null;
  const hit = coverCache && await coverCache.match(req);
  if (hit) blob = await hit.blob();
  if (!blob && hasToken()) {
    try {
      const [kind, id] = key.split(':');
      if (kind === 'img') blob = await shrink(await (await drive('files/' + id, { alt: 'media' }, true)).blob());
      else if (kind === 'emb') blob = await embeddedArt(id);
      if (blob && coverCache) await coverCache.put(req, new Response(blob, { headers: { 'Content-Type': 'image/jpeg' } }));
    } catch { }
  }
  if (!blob) return null;
  const u = URL.createObjectURL(blob); coverURL.set(key, u); return u;
}
/** Pochette intégrée au MP3 (ID3 APIC), en lisant le début du fichier seulement. */
async function embeddedArt(trackId) {
  const r = await fetch('https://www.googleapis.com/drive/v3/files/' + trackId + '?alt=media', { headers: { Authorization: 'Bearer ' + await token(), Range: 'bytes=0-524287' } });
  if (!r.ok) return null;
  const b = new Uint8Array(await r.arrayBuffer());
  if (b[0] !== 0x49 || b[1] !== 0x44 || b[2] !== 0x33) return null;
  const ver = b[3];
  const size = ((b[6] & 127) << 21) | ((b[7] & 127) << 14) | ((b[8] & 127) << 7) | (b[9] & 127);
  let p = 10; const end = Math.min(b.length, 10 + size);
  while (p + 10 < end) {
    const id = String.fromCharCode(b[p], b[p + 1], b[p + 2], b[p + 3]);
    const fs = ver === 4 ? ((b[p + 4] & 127) << 21) | ((b[p + 5] & 127) << 14) | ((b[p + 6] & 127) << 7) | (b[p + 7] & 127)
      : (b[p + 4] << 24) | (b[p + 5] << 16) | (b[p + 6] << 8) | b[p + 7];
    if (!/^[A-Z0-9]{4}$/.test(id) || fs <= 0) break;
    if (id === 'APIC') {
      let q = p + 10; const enc = b[q++];
      let mime = ''; while (b[q] && q < end) mime += String.fromCharCode(b[q++]); q++;
      q++; // type d'image
      if (enc === 1 || enc === 2) { while (q + 1 < end && !(b[q] === 0 && b[q + 1] === 0)) q += 2; q += 2; } else { while (q < end && b[q]) q++; q++; }
      const data = b.slice(q, Math.min(p + 10 + fs, b.length));
      return shrink(new Blob([data], { type: mime || 'image/jpeg' }));
    }
    p += 10 + fs;
  }
  return null;
}
function artBox(cls, a, label) {
  const box = h('div', { class: cls });
  const initials = (label || '?').split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase();
  box.append(h('div', { class: 'ph' }, initials));
  const key = a ? (a.cover ? 'img:' + a.cover : a.tracks?.[0] && !a.tracks[0].local ? 'emb:' + a.tracks[0].id : null) : null;
  if (key) {
    const io = new IntersectionObserver(es => {
      if (!es.some(e => e.isIntersecting)) return;
      io.disconnect();
      wantCover(key, u => box.replaceChildren(h('img', { src: u, alt: '' })));
    }, { rootMargin: '300px' });
    io.observe(box);
  }
  return box;
}

// ---------- Lecteur ----------
const audio = new Audio();
audio.preload = 'auto';
const P = { queue: [], i: -1, shuffle: false, repeat: 0, urls: new Map(), seq: 0, error: '' };
const cur = () => P.queue[P.i] || null;
async function srcFor(t) {
  if (t.url) return t.url;
  if (P.urls.has(t.id)) return P.urls.get(t.id);
  let blob = null;
  const c = await cacheOpen(t.local ? 'bp-local' : 'bp-offline');
  const hit = c && await c.match('https://bossplay.local/' + (t.local ? 'local/' : 'off/') + t.id);
  if (hit) blob = await hit.blob();
  if (!blob) {
    if (t.local) throw new Error('Fichier de l\'iPhone introuvable : ajoute-le à nouveau.');
    const r = await drive('files/' + t.id, { alt: 'media' }, true);
    blob = await r.blob();
  }
  const ext = (t.name.split('.').pop() || '').toLowerCase();
  if (!blob.type || blob.type === 'application/octet-stream') blob = new Blob([blob], { type: MIME[ext] || 'audio/mpeg' });
  const u = URL.createObjectURL(blob);
  P.urls.set(t.id, u);
  // On ne garde en mémoire que le titre en cours, le précédent et les deux suivants.
  const keep = new Set([P.i - 1, P.i, P.i + 1, P.i + 2].map(k => P.queue[k]?.id));
  for (const [id, url] of P.urls) if (!keep.has(id) && id !== t.id) { URL.revokeObjectURL(url); P.urls.delete(id); }
  return u;
}
function play(list, index = 0) {
  if (!list.length) return;
  P.queue = list.slice(); P.i = Math.max(0, Math.min(index, list.length - 1));
  if (P.shuffle) shuffleRest();
  load();
}
function shuffleRest() {
  const rest = P.queue.slice(P.i + 1);
  for (let k = rest.length - 1; k > 0; k--) { const j = Math.floor(Math.random() * (k + 1)); [rest[k], rest[j]] = [rest[j], rest[k]]; }
  P.queue = P.queue.slice(0, P.i + 1).concat(rest);
}
async function load(autoplay = true) {
  if (!navigator.onLine && cur() && !isKept(cur())) {
    const j = P.queue.findIndex((x, k) => k > P.i && isKept(x));
    if (j < 0) { P.error = 'Pas d\'Internet : ce titre n\'est pas sur l\'appareil.'; updatePlayer(); return; }
    P.i = j;
  }
  const t = cur(); if (!t) return;
  if (radio.st) radioStop();
  const seq = ++P.seq;
  P.error = ''; P.counted = false; ui.loading = true; updatePlayer();
  try {
    const u = await srcFor(t);
    if (seq !== P.seq) return;
    audio.src = u;
    // En mode clip, la musique ne démarre que si le titre n'a pas de clip (voir clipTrackChanged).
    if (autoplay && !clip.on) await audio.play().catch(() => { });
    setSession(t);
    prefetch();
  } catch (e) {
    if (seq !== P.seq) return;
    P.error = e.message === 'auth' ? 'Connexion Google Drive expirée : touche « Se connecter ».' : 'Titre illisible (' + e.message + ')';
  }
  ui.loading = false; updatePlayer(); renderPlaying();
  if (clip.on) clipTrackChanged();
}
function prefetch() { const n = P.queue[P.i + 1]; if (n) srcFor(n).catch(() => { }); }
function next(user = true) {
  if (!P.queue.length) return;
  if (!user && P.repeat === 2) { audio.currentTime = 0; audio.play(); return; }
  if (P.i + 1 < P.queue.length) P.i++;
  else if (P.repeat === 1) P.i = 0;
  else { audio.pause(); updatePlayer(); return; }
  load();
}
function prev() {
  if (audio.currentTime > 3) { audio.currentTime = 0; return; }
  if (P.i > 0) { P.i--; load(); }
}
function toggle() {
  if (radio.st) { if (radio.el.paused) radio.el.play().catch(() => { }); else radio.el.pause(); return; }
  if (!cur()) return;
  if (audio.paused) { if (!audio.src) load(); else audio.play().catch(() => { }); } else audio.pause();
}
function playNext(list) { if (!cur()) return play(list); P.queue.splice(P.i + 1, 0, ...list); toast('Sera lu ensuite'); }
function addQueue(list) { if (!cur()) return play(list); P.queue.push(...list); toast('Ajouté à la file d\'attente'); }
audio.addEventListener('ended', () => { if (sleepEnd()) return; next(false); });
audio.addEventListener('play', updatePlayer);
audio.addEventListener('pause', updatePlayer);
audio.addEventListener('timeupdate', tick);
audio.addEventListener('error', () => { if (audio.src) { P.error = 'Lecture impossible de ce format sur cet appareil.'; updatePlayer(); } });

function setSession(t) {
  if (!('mediaSession' in navigator)) return;
  const a = lib.albumById.get(t.albumId);
  const md = { title: t.title, artist: t.artist, album: t.album, artwork: [] };
  navigator.mediaSession.metadata = new MediaMetadata(md);
  const key = a ? (a.cover ? 'img:' + a.cover : 'emb:' + a.tracks[0].id) : null;
  if (key) loadCover(key).then(u => { if (u && cur() === t) navigator.mediaSession.metadata = new MediaMetadata(Object.assign(md, { artwork: [{ src: u, sizes: '600x600', type: 'image/jpeg' }] })); });
}
if ('mediaSession' in navigator) {
  const ms = navigator.mediaSession;
  const set = (a, f) => { try { ms.setActionHandler(a, f); } catch { } };
  set('play', () => radio.st ? radio.el.play() : clip.on && clip.has ? ytCmd('playVideo') : audio.play());
  set('pause', () => radio.st ? radio.el.pause() : clip.on && clip.has ? ytCmd('pauseVideo') : audio.pause());
  set('stop', () => radio.st ? radioStop() : audio.pause());
  set('previoustrack', () => { if (!radio.st) prev(); });
  set('nexttrack', () => { if (!radio.st) next(true); });
  set('seekto', d => { if (!radio.st && d.seekTime != null) audio.currentTime = d.seekTime; });
}

// ---------- Interface ----------
const ui = { tab: 'albums', stack: [], q: '', loading: false, songLimit: 400 };
function go(tab) { if (tab === 'settings' && isKid()) { toast('Les réglages sont réservés aux parents.'); return; } ui.tab = tab; ui.stack = []; ui.songLimit = 400; $('#search').value = ui.q = ''; render(); }
function openPage(page) { ui.stack.push(page); render(); $('#view').scrollTop = 0; }
function back() { ui.stack.pop(); render(); }
function filt(list, text) { if (!ui.q) return list; const q = fold(ui.q); return list.filter(x => fold(text(x)).includes(q)); }

function render() {
  const who = $('#who'); who.hidden = !sync.name; who.replaceChildren(...(sync.name ? [avEl(sync.name, 'sm')] : []), sync.name + (isBoss() ? ' ★' : (sync.name === 'Boss' ? ' 🔒' : '')));
  if (isKid() && ui.tab === 'settings') ui.tab = 'albums';
  document.querySelectorAll('#tabs button').forEach(b => { b.classList.toggle('on', b.dataset.tab === ui.tab && !ui.stack.length); if (b.dataset.tab === 'settings') b.hidden = isKid(); });
  $('#back').hidden = !ui.stack.length;
  const v = $('#view'); v.replaceChildren();
  const page = ui.stack[ui.stack.length - 1];
  if (page) {
    if (page.album) return viewAlbum(v, lib.albumById.get(page.album) || localAlbum());
    if (page.artist) return viewArtist(v, lib.artistByKey.get(page.artist));
    if (page.playlist) return viewPlaylist(v, playlists.find(p => p.id === page.playlist));
  }
  if (!lib.tracks.length && !localTracks.length && !['settings', 'radio', 'wishes', 'kept'].includes(ui.tab)) return viewEmpty(v);
  ({ albums: viewAlbums, artists: viewArtists, songs: viewSongs, favs: viewFavs, playlists: viewPlaylists, radio: viewRadio, wishes: viewWishes, stats: viewStats, settings: viewSettings, kept: viewKept })[ui.tab](v);
  tabBadge();
}
function viewEmpty(v) {
  v.append(h('div', { class: 'card' },
    h('h1', null, 'Bienvenue dans BossPlay'),
    h('p', null, S.rootId ? 'Ta bibliothèque n\'est pas encore lue.' : 'Relie ton Google Drive et choisis le dossier de musique (Artiste › Album › Titre).'),
    h('p', { class: 'muted small', id: 'scanmsg' }, scanMsg),
    h('div', { class: 'btns' },
      S.rootId ? h('button', { class: 'btn', onclick: async () => { if (!hasToken() && !(await connect())) return; scan(); } }, 'Lire ma musique') : null,
      isKid() ? null : h('button', { class: 'btn alt', onclick: () => go('settings') }, 'Réglages'),
      h('button', { class: 'btn alt', onclick: () => $('#files').click() }, 'Fichiers de l\'iPhone…'))));
}
function albumCell(a) {
  const playing = cur() && cur().albumId === a.id;
  return h('div', { class: 'cell' + (playing ? ' playing' : ''), 'data-album': a.id, onclick: () => openPage({ album: a.id }) },
    artBox('art', a, a.name), h('div', { class: 'n' }, a.name), h('div', { class: 'a' }, a.artist));
}
function viewAlbums(v) {
  const list = filt(lib.albums, a => a.name + ' ' + a.artist);
  v.append(h('h1', null, 'Albums'), h('div', { class: 'grid' }, list.map(albumCell)));
}
function viewArtists(v) {
  const list = filt(lib.artists, a => a.name);
  v.append(h('h1', null, 'Artistes'), h('div', { class: 'grid' }, list.map(ar => {
    const a0 = ar.albums[0];
    const fake = ar.photo ? { cover: ar.photo, tracks: a0.tracks } : a0;
    return h('div', { class: 'cell', onclick: () => openPage({ artist: ar.key }) }, artBox('art', fake, ar.name),
      h('div', { class: 'n' }, ar.name), h('div', { class: 'a' }, ar.albums.length + ' album' + (ar.albums.length > 1 ? 's' : '')));
  })));
}
function trackRow(t, list, i, opts = {}) {
  const playing = cur() && cur().id === t.id;
  return h('div', { class: 'tr' + (playing ? ' playing' : ''), 'data-track': t.id, onclick: () => play(list, i) },
    h('div', { class: 'no' }, playing ? h('span', { class: 'eq' }, '▮▮') : (opts.num ? (t.no || i + 1) : i + 1)),
    h('div', { class: 'm' }, h('div', null, t.title), h('div', { class: 's' }, opts.album ? t.artist + ' — ' + t.album : t.artist)),
    favs.tracks.has(t.id) ? h('span', { style: 'color:var(--red)' }, '♥') : null,
    offline.has(t.id) ? h('span', { class: 'kept', title: 'Sur cet appareil' }, '✓') : null,
    h('button', { class: 'x', onclick: e => { e.stopPropagation(); trackMenu(t, opts.playlist); } }, '⋯'));
}
function viewSongs(v) {
  const all = filt(lib.tracks.concat(localTracks), t => t.title + ' ' + t.artist + ' ' + t.album);
  const list = all.slice(0, ui.songLimit);
  v.append(h('h1', null, 'Chansons'), h('p', { class: 'muted small' }, all.length + ' titres'),
    h('div', { class: 'btns' }, h('button', { class: 'btn', onclick: () => { P.shuffle = true; play(all, Math.floor(Math.random() * all.length)); } }, 'Lecture aléatoire')),
    h('div', { class: 'list' }, list.map((t, i) => trackRow(t, all, i, { album: true }))),
    all.length > list.length ? h('button', { class: 'pill more', onclick: () => { ui.songLimit += 400; render(); } }, 'Afficher plus') : null);
}
function viewAlbum(v, a) {
  if (!a) { v.append(h('p', null, 'Album introuvable.')); return; }
  const fav = favs.albums.has(a.id);
  v.append(h('div', { class: 'hero' }, artBox('art', a, a.name),
    h('div', null,
      h('div', { class: 'muted small' }, 'ALBUM'), h('div', { class: 'h-t' }, a.name),
      h('div', { class: 'link', style: 'color:var(--accent);cursor:pointer', onclick: () => a.artistKey && lib.artistByKey.has(a.artistKey) && openPage({ artist: a.artistKey }) }, a.artist),
      h('div', { class: 'muted small' }, a.tracks.length + ' titres'),
      h('div', { class: 'btns' },
        h('button', { class: 'btn', onclick: () => play(a.tracks, 0) }, '▶ Lire'),
        h('button', { class: 'btn alt', onclick: () => { P.shuffle = true; play(a.tracks, Math.floor(Math.random() * a.tracks.length)); } }, 'Aléatoire'),
        h('button', { class: 'btn alt', onclick: () => { toggleFav('a', a.id); render(); } }, fav ? '♥ Favori' : '♡ Favori'),
        a.tracks[0]?.local ? null : keepBtn(a.name, a.tracks)))),
    h('div', { class: 'list' }, a.tracks.map((t, i) => trackRow(t, a.tracks, i, { num: true }))));
}
function viewArtist(v, ar) {
  if (!ar) { v.append(h('p', null, 'Artiste introuvable.')); return; }
  const all = ar.albums.flatMap(a => a.tracks);
  v.append(h('h1', null, ar.name),
    h('div', { class: 'btns', style: 'margin-bottom:16px' }, h('button', { class: 'btn', onclick: () => play(all, 0) }, '▶ Tout lire'),
      h('button', { class: 'btn alt', onclick: () => { P.shuffle = true; play(all, Math.floor(Math.random() * all.length)); } }, 'Aléatoire'), keepBtn(ar.name, all)),
    h('div', { class: 'grid' }, ar.albums.map(albumCell)));
}
function viewFavs(v) {
  const ts = [...favs.tracks].map(id => lib.byId.get(id)).filter(Boolean);
  const als = [...favs.albums].map(id => lib.albumById.get(id)).filter(Boolean);
  v.append(h('h1', null, 'Favoris'));
  const favAll = ts.concat(als.flatMap(a => a.tracks).filter(t => !favs.tracks.has(t.id)));
  if (favAll.length) v.append(h('div', { class: 'btns', style: 'margin-bottom:12px' }, keepBtn('Mes favoris', favAll)));
  if (als.length) v.append(h('h2', null, 'Albums'), h('div', { class: 'grid' }, als.map(albumCell)));
  v.append(h('h2', null, 'Titres'), ts.length ? h('div', { class: 'list' }, ts.map((t, i) => trackRow(t, ts, i, { album: true }))) : h('p', { class: 'muted' }, 'Touche ⋯ sur un titre › Favori.'));
}
function viewPlaylists(v) {
  v.append(h('h1', null, 'Playlists'),
    h('div', { class: 'btns', style: 'margin-bottom:12px' }, h('button', { class: 'btn', onclick: () => newPlaylist([]) }, '+ Nouvelle playlist')),
    h('div', { class: 'list' }, playlists.map(p => h('div', { class: 'tr', onclick: () => openPage({ playlist: p.id }) },
      h('div', { class: 'no' }, '♫'), h('div', { class: 'm' }, h('div', null, p.name), h('div', { class: 's' }, p.ids.length + ' titres'))))));
}
function viewPlaylist(v, p) {
  if (!p) { v.append(h('p', null, 'Playlist introuvable.')); return; }
  const ts = p.ids.map(id => lib.byId.get(id)).filter(Boolean);
  v.append(h('h1', null, p.name),
    h('div', { class: 'btns', style: 'margin-bottom:12px' },
      h('button', { class: 'btn', onclick: () => play(ts, 0) }, '▶ Lire'),
      keepBtn(p.name, ts),
      h('button', { class: 'btn alt', onclick: () => m3u(p.name, ts) }, 'Exporter M3U'),
      h('button', { class: 'btn alt', onclick: () => { const n = prompt('Nouveau nom', p.name); if (n) { p.name = n.trim().slice(0, 80) || p.name; savePl(p); render(); } } }, 'Renommer'),
      h('button', { class: 'btn alt', onclick: () => { if (confirm('Supprimer « ' + p.name + ' » ?')) { plDeleted[p.id] = Date.now(); playlists = playlists.filter(x => x !== p); savePl(); back(); } } }, 'Supprimer')),
    h('div', { class: 'list' }, ts.map((t, i) => trackRow(t, ts, i, { album: true, playlist: p }))));
}
function newPlaylist(ids) {
  const n = prompt('Nom de la playlist'); if (!n) return;
  const np = { id: 'pl' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), name: n.trim().slice(0, 80), ids: [...ids] }; playlists.push(np); savePl(np);
  toast('Playlist « ' + n + ' » créée'); render();
}
function localAlbum() { return localTracks.length ? { id: 'local', name: 'Fichiers de l\'iPhone', artist: 'iCloud Drive / Fichiers', tracks: localTracks } : null; }

// Fenêtre d'actions (en bas de l'écran)
function sheet(title, items) {
  const s = $('#sheet'), p = $('.panel', s);
  p.replaceChildren(h('div', { class: 'h' }, title), ...items.filter(Boolean).map(it => it instanceof Node ? it :
    h('button', { class: 'it' + (it.red ? ' red' : ''), onclick: () => { s.hidden = true; it.fn(); } }, it.label)),
    h('button', { class: 'it', onclick: () => { s.hidden = true; } }, 'Fermer'));
  s.hidden = false;
}
$('#sheet').addEventListener('click', e => { if (e.target.id === 'sheet') e.target.hidden = true; });
function trackMenu(t, pl) {
  const fav = favs.tracks.has(t.id);
  sheet(t.title, [
    { label: 'Lire ensuite', fn: () => playNext([t]) },
    { label: 'Ajouter à la file d\'attente', fn: () => addQueue([t]) },
    { label: '🎚 Pastille Dolby du titre…', fn: () => dolbyMenu('t:' + t.id, t.title) },
    { label: '🎚 Pastille Dolby de l\'album…', fn: () => dolbyMenu('a:' + t.albumId, t.album) },
    { label: fav ? 'Retirer des favoris' : 'Ajouter aux favoris', fn: () => { toggleFav('t', t.id); render(); updatePlayer(); } },
    { label: 'Ajouter à une playlist…', fn: () => sheet('Ajouter à une playlist', [{ label: '+ Nouvelle playlist…', fn: () => newPlaylist([t.id]) },
      ...playlists.map(p => ({ label: p.name, fn: () => { if (!p.ids.includes(t.id)) p.ids.push(t.id); savePl(p); toast('Ajouté à « ' + p.name + ' »'); } }))]) },
    t.local ? null : offline.has(t.id) ? { label: 'Retirer de cet appareil', fn: () => unkeepTracks([t]) } : { label: 'Garder sur cet appareil', fn: () => keepTracks(t.title, [t]) },
    { label: 'Clip vidéo…', fn: () => clipPicker(t) },
    !t.local ? { label: 'Aller à l\'album', fn: () => openPage({ album: t.albumId }) } : null,
    lib.artistByKey.has(fold(t.artist)) ? { label: 'Aller à l\'artiste', fn: () => openPage({ artist: fold(t.artist) }) } : null,
    pl ? { label: 'Retirer de la playlist', red: true, fn: () => { pl.ids = pl.ids.filter(x => x !== t.id); savePl(pl); render(); } } : null,
  ]);
}

// ---------- Ma musique téléchargée ----------
// Chacun choisit ce qu'il garde sur SON appareil (album, artiste, playlist, favoris ou un seul titre) : lecture sans Internet.
// Les copies restent sur l'appareil quel que soit le profil choisi ; rien n'est envoyé ailleurs.
const dl = { queue: [], busy: false, stop: false, done: 0, total: 0, name: '' };
const offUrl = id => 'https://bossplay.local/off/' + id;
const isKept = t => t.local || offline.has(t.id);
const fmtBytes = b => b >= 1e9 ? (b / 1e9).toFixed(1).replace('.', ',') + ' Go' : Math.max(1, Math.round(b / 1e6)) + ' Mo';
async function freeSpace() { try { const e = await navigator.storage.estimate(); return e.quota ? e.quota - e.usage : null; } catch { return null; } }
// Ajoute des titres à la liste à télécharger ; un seul téléchargement à la fois, deux titres en parallèle.
async function keepTracks(name, tracks) {
  const todo = tracks.filter(t => !t.local && !offline.has(t.id) && !dl.queue.some(x => x.id === t.id));
  if (!todo.length) { toast('« ' + name + ' » est déjà sur cet appareil'); return; }
  if (!hasToken() && !(await connect())) return;
  const need = todo.reduce((n, t) => n + (t.size || 8e6), 0), free = await freeSpace();
  if (free != null && need > free * 0.9) return toast('Pas assez de place sur cet appareil : il faut environ ' + fmtBytes(need) + ', il reste ' + fmtBytes(free) + '.', 5000);
  dl.queue.push(...todo); dl.total += todo.length; dl.name = name;
  toast('Téléchargement de « ' + name + ' » (' + todo.length + ' titre' + (todo.length > 1 ? 's' : '') + ', ' + fmtBytes(need) + ')');
  try { navigator.storage?.persist?.(); } catch { }
  if (dl.busy) return render();
  dl.busy = true; dl.stop = false; render();
  const c = await cacheOpen('bp-offline');
  if (!c) { dl.busy = false; dl.queue = []; dl.total = dl.done = 0; return toast('Stockage indisponible sur cet appareil.'); }
  let failed = 0;
  const worker = async () => {
    while (dl.queue.length && !dl.stop) {
      const t = dl.queue.shift();
      try {
        if (!offline.has(t.id)) {
          const r = await drive('files/' + t.id, { alt: 'media' }, true);
          await c.put(offUrl(t.id), new Response(await r.blob()));
          offline.add(t.id); saveOff();
        }
      } catch (e) { failed++; if (e.message === 'auth' || /quota/i.test(e.name + e.message)) dl.stop = true; }
      dl.done++; dlShow();
    }
  };
  await Promise.all([worker(), worker()]);
  const stopped = dl.stop, left = dl.queue.length;
  dl.busy = false; dl.queue = []; dl.total = dl.done = 0; dl.stop = false;
  toast(stopped ? 'Téléchargement arrêté' + (left ? ' (' + left + ' titre(s) non copiés)' : '') : failed ? failed + ' titre(s) n\'ont pas pu être copiés : réessaie plus tard.' : 'C\'est sur ton appareil : tu peux l\'écouter sans Internet.', 4000);
  render();
}
async function unkeepTracks(tracks, say = true) {
  const c = await cacheOpen('bp-offline');
  for (const t of tracks) { if (t.local) continue; offline.delete(t.id); if (c) await c.delete(offUrl(t.id)); }
  saveOff(); if (say) toast('Retiré de cet appareil'); render();
}
const keep = a => keepTracks(a.name, a.tracks);
const unkeep = a => unkeepTracks(a.tracks);
// Bouton « Garder sur cet appareil » / « Retirer de l'appareil » pour un groupe de titres (album, artiste, playlist, favoris).
function keepBtn(name, tracks) {
  const own = tracks.filter(t => !t.local);
  if (!own.length) return null;
  const n = own.filter(t => offline.has(t.id)).length, waiting = own.some(t => dl.queue.some(x => x.id === t.id));
  if (waiting) return h('button', { class: 'btn alt', onclick: () => go('kept') }, 'Téléchargement…');
  if (n === own.length) return h('button', { class: 'btn alt', onclick: () => { if (confirm('Retirer « ' + name + ' » de cet appareil ?')) unkeepTracks(own); } }, '✓ Sur l\'appareil');
  return h('button', { class: 'btn alt', onclick: () => keepTracks(name, own) }, n ? 'Garder le reste (' + (own.length - n) + ')' : 'Garder sur cet appareil');
}
function dlShow() {
  const el = $('#dlbar'); if (!el) return;
  el.textContent = dl.busy ? 'Téléchargement : ' + dl.done + ' / ' + dl.total + ' titres' : '';
  const f = $('#dlfill'); if (f) f.style.width = dl.total ? (100 * dl.done / dl.total).toFixed(1) + '%' : '0';
}
function viewKept(v) {
  const kept = lib.tracks.filter(t => offline.has(t.id));
  const bytes = kept.reduce((n, t) => n + (t.size || 0), 0);
  const albums = lib.albums.filter(a => a.tracks.some(t => offline.has(t.id)));
  const all = kept.concat(localTracks);
  const info = h('p', { class: 'muted small' }, kept.length + ' titre' + (kept.length > 1 ? 's' : '') + ' · ' + (bytes ? fmtBytes(bytes) : '0 Mo'));
  freeSpace().then(f => { if (f != null && info.isConnected) info.textContent += ' · encore ' + fmtBytes(f) + ' de libre'; });
  v.append(h('h1', null, 'Ma musique téléchargée'), info,
    dl.busy ? h('div', { class: 'card' },
      h('div', { id: 'dlbar', class: 'small' }), h('div', { class: 'rc-bar', style: 'margin:8px 0' }, h('div', { id: 'dlfill', class: 'fill' })),
      h('button', { class: 'pill', onclick: () => { dl.stop = true; toast('Arrêt après les titres en cours…'); } }, 'Arrêter')) : null,
    all.length ? h('div', { class: 'btns', style: 'margin-bottom:12px' },
      h('button', { class: 'btn', onclick: () => play(all, 0) }, '▶ Tout lire'),
      h('button', { class: 'btn alt', onclick: () => { P.shuffle = true; play(all, Math.floor(Math.random() * all.length)); } }, 'Aléatoire')) : null,
    !navigator.onLine ? h('p', { class: 'small', style: 'color:var(--accent)' }, 'Pas d\'Internet : seule la musique de cette page peut être écoutée.') : null);
  if (!kept.length && !localTracks.length) {
    v.append(h('div', { class: 'card' }, h('p', null, 'Rien pour l\'instant.'),
      h('p', { class: 'muted small' }, 'Ouvre un album, un artiste, une playlist ou tes favoris et touche « Garder sur cet appareil ». La musique est alors copiée ici : tu peux l\'écouter même sans Internet (en voiture, en avion…).')));
  } else {
    v.append(h('div', { class: 'grid' }, albums.map(a => {
      const n = a.tracks.filter(t => offline.has(t.id)).length;
      const c = albumCell(a); c.append(h('div', { class: 'a' }, n === a.tracks.length ? '✓ Album complet' : n + ' / ' + a.tracks.length + ' titres')); return c;
    })));
    if (localTracks.length) v.append(h('h2', null, 'Fichiers de l\'appareil'), h('div', { class: 'list' }, localTracks.map((t, i) => trackRow(t, localTracks, i, { album: true }))));
    if (kept.length) v.append(h('div', { class: 'btns', style: 'margin-top:18px' }, h('button', { class: 'btn alt', onclick: () => { if (confirm('Retirer toute la musique téléchargée de cet appareil ?')) unkeepTracks(kept); } }, 'Tout retirer de l\'appareil')));
    v.append(h('p', { class: 'muted small', style: 'margin-top:14px' }, 'Sur iPhone et iPad, ouvre BossPlay de temps en temps (au moins une fois par mois) : iOS peut effacer les copies d\'une appli qu\'on n\'ouvre plus.'));
  }
  dlShow();
}

// Fichiers de l'iPhone (iCloud Drive dans l'app Fichiers) : choisis à la main, gardés dans l'appli si tu veux.
$('#files').addEventListener('change', async e => {
  const files = [...e.target.files]; e.target.value = '';
  if (!files.length) return;
  const keepIt = confirm('Garder ces ' + files.length + ' fichiers dans BossPlay (lecture sans les choisir à nouveau) ?\nAnnuler = seulement pour cette fois.');
  const c = keepIt ? await cacheOpen('bp-local') : null;
  const index = store.get('localIndex', []);
  for (const f of files) {
    const pn = parseName(f.name); let artist = 'Fichiers de l\'iPhone', title = pn.title;
    const m = title.match(/^(.+?)\s+-\s+(.+)$/); if (m) { artist = m[1]; title = m[2]; }
    const id = 'local' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    const t = { id, name: f.name, title, artist, album: 'Fichiers de l\'iPhone', albumId: 'local', disc: 1, no: pn.no, local: true };
    if (c) { try { await c.put('https://bossplay.local/local/' + id, new Response(f)); index.push(t); } catch { t.url = URL.createObjectURL(f); } }
    else t.url = URL.createObjectURL(f);
    localTracks.push(t); lib.byId.set(id, t);
  }
  store.set('localIndex', index);
  toast(files.length + ' fichier(s) ajouté(s)');
  openPage({ album: 'local' });
});

// ---------- Lecteur à l'écran ----------
function coverInto(el, t) {
  const a = t && (lib.albumById.get(t.albumId) || (t.local ? localAlbum() : null));
  el.replaceChildren(artBox('art', a, t ? t.album : '♪'));
  el.firstChild.style.width = '100%'; el.firstChild.style.height = '100%';
}
let lastCoverFor = null;
// La radio utilise le même lecteur (barre du bas et fenêtre « En lecture ») que les titres de musique.
function radioBtns(on) {
  const d = on ? '' : 'none';
  $('#mini .stop').style.display = d; $('#mini .rwish').style.display = d;
  $('#full .rstop').style.display = d; $('#full .rwish').style.display = d;
}
function updateRadioPlayer() {
  const st = radio.st, playing = !radio.el.paused;
  document.querySelectorAll('#mini,#full').forEach(e => e.classList.add('rmode'));
  radioBtns(true);
  $('#mini').hidden = false;
  $('#mini .t').textContent = st.name;
  $('#mini .s').textContent = playing ? '📻 EN DIRECT' : 'Radio en pause';
  $('#mini .play').textContent = playing ? '⏸' : '▶';
  $('#full .play').textContent = playing ? '⏸' : '▶';
  $('#full .title').textContent = st.name;
  $('#full .artist').textContent = playing ? '📻 EN DIRECT' : 'Radio en pause';
  $('#full .album').textContent = st.tags || '';
  $('#full .err').textContent = '';
  $('#mini .fill').style.width = '0';
  $('#full .lyrics').hidden = true; $('#full .cover').hidden = false; $('#full .lyr').classList.remove('on');
  if (lastCoverFor !== 'radio:' + st.id) {
    lastCoverFor = 'radio:' + st.id;
    for (const el of [$('#mini .art'), $('#full .cover')]) {
      el.replaceChildren(st.favicon
        ? h('img', { src: st.favicon, alt: '', style: 'width:100%;height:100%;object-fit:contain', onerror: e => e.target.replaceWith(h('span', { class: 'rlogo' }, '📻')) })
        : h('span', { class: 'rlogo' }, '📻'));
    }
    $('#full .bg').style.backgroundImage = '';
  }
  sleepBtn(); rcPublish();
}
function updatePlayer() {
  if (radio.st) return updateRadioPlayer();
  document.querySelectorAll('#mini,#full').forEach(e => e.classList.remove('rmode'));
  radioBtns(false);
  const t = cur(); $('#mini').hidden = !t;
  if (!t) { $('#full').hidden = true; return; }
  $('#mini .t').textContent = t.title;
  $('#mini .s').textContent = P.error || (ui.loading ? 'Chargement…' : t.artist + ' — ' + t.album);
  const playing = !audio.paused;
  $('#mini .play').textContent = playing ? '⏸' : '▶';
  $('#full .play').textContent = playing ? '⏸' : '▶';
  $('#full .title').textContent = t.title;
  $('#full .artist').textContent = t.artist;
  $('#full .album').textContent = t.album;
  $('#full .err').textContent = P.error;
  $('#full .shuffle').classList.toggle('on', P.shuffle);
  $('#full .repeat').classList.toggle('on', P.repeat > 0);
  $('#full .repeat').textContent = P.repeat === 2 ? '🔂' : '🔁';
  $('#full .fav').textContent = favs.tracks.has(t.id) ? '♥ Favori' : '♡ Favori';
  $('#full .clip').classList.toggle('on', !!clipCache[t.id]?.chosen);
  if (lastCoverFor !== t.albumId) {
    lastCoverFor = t.albumId;
    coverInto($('#mini .art'), t); coverInto($('#full .cover'), t);
    const a = lib.albumById.get(t.albumId); const key = a && (a.cover ? 'img:' + a.cover : 'emb:' + a.tracks[0].id);
    $('#full .bg').style.backgroundImage = '';
    if (key) loadCover(key).then(u => { if (u && cur() === t) $('#full .bg').style.backgroundImage = `url(${u})`; });
  }
  if (!$('#full .lyrics').hidden) showLyrics();
  updateBadges(t); sleepBtn(); rcPublish();
}
function renderPlaying() {
  const t = cur();
  document.querySelectorAll('.tr.playing,.cell.playing').forEach(e => e.classList.remove('playing'));
  if (!t) return;
  document.querySelectorAll(`[data-track="${CSS.escape(t.id)}"]`).forEach(e => e.classList.add('playing'));
  document.querySelectorAll(`[data-album="${CSS.escape(t.albumId)}"]`).forEach(e => e.classList.add('playing'));
}
function tick() {
  const d = audio.duration || 0, c = audio.currentTime || 0;
  // Une écoute compte après 30 s (ou la moitié d'un titre court).
  if (!P.counted && cur() && d && c >= Math.min(30, d / 2)) { P.counted = true; addPlay(cur().id); }
  $('#mini .fill').style.width = d ? (c / d * 100) + '%' : '0';
  if (!$('#full').hidden) {
    if (!tick.drag) $('#full .seek').value = d ? Math.round(c / d * 1000) : 0;
    $('#full .cur').textContent = fmt(c); $('#full .dur').textContent = fmt(d);
    if (!$('#full .lyrics').hidden) syncLyrics($('#full .lyrics'), c * 1000);
  }
  if (clip.on && !clip.has) clipTick(c * 1000, d * 1000);
}

// ---------- Paroles (LRCLIB) ----------
const lyrMem = new Map();
function parseLrc(s) {
  const out = [];
  for (const line of (s || '').split('\n')) {
    const tags = [...line.matchAll(/\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?]/g)];
    if (!tags.length) continue;
    const text = line.slice(tags[tags.length - 1].index + tags[tags.length - 1][0].length).trim();
    for (const m of tags) { const f = m[3] || ''; out.push({ ms: +m[1] * 60000 + +m[2] * 1000 + (f.length === 1 ? +f * 100 : f.length === 2 ? +f * 10 : +(f.slice(0, 3) || 0)), text }); }
  }
  return out.sort((a, b) => a.ms - b.ms);
}
const cleanTitle = t => t.replace(/\s*[([][^)\]]*[)\]]/g, '').replace(/\s+(feat\.?|ft\.?|featuring)\s+.*$/i, '').trim() || t;
async function lyricsFor(t) {
  if (lyrMem.has(t.id)) return lyrMem.get(t.id);
  let r = await idb.get('lyr:' + t.id);
  if (!r || (r.none && Date.now() - r.date > 86400000)) {
    const title = cleanTitle(t.title), artist = /various|divers|fichiers/i.test(t.artist) ? '' : t.artist;
    const secs = Math.round(audio.duration || 0);
    let found = null;
    try {
      if (artist) {
        const u = `https://lrclib.net/api/get?track_name=${encodeURIComponent(title)}&artist_name=${encodeURIComponent(artist)}` + (secs ? `&duration=${secs}` : '');
        const x = await fetch(u); if (x.ok) found = await x.json();
      }
      if (!found || (!found.syncedLyrics && !found.plainLyrics)) {
        const x = await fetch('https://lrclib.net/api/search?q=' + encodeURIComponent((artist + ' ' + title).trim()));
        const arr = x.ok ? await x.json() : [];
        found = arr.find(o => o.syncedLyrics && (!secs || Math.abs(o.duration - secs) < 10)) || arr.find(o => !secs || Math.abs(o.duration - secs) < 10) || arr[0] || null;
      }
      r = found ? { synced: found.syncedLyrics || '', plain: found.plainLyrics || '', instr: !!found.instrumental } : { none: true, date: Date.now() };
      await idb.set('lyr:' + t.id, r);
    } catch { r = null; }
  }
  const out = r && !r.none ? { lines: parseLrc(r.synced), plain: r.plain, instr: r.instr } : null;
  lyrMem.set(t.id, out);
  return out;
}
async function showLyrics() {
  const box = $('#full .lyrics'), t = cur();
  if (!t || box.dataset.for === t.id) return;
  box.dataset.for = t.id; box.replaceChildren(h('div', { class: 'muted' }, 'Recherche des paroles…'));
  const l = await lyricsFor(t);
  if (cur() !== t) return;
  if (!l) return box.replaceChildren(h('div', { class: 'muted' }, 'Paroles introuvables pour ce titre.'));
  if (l.lines.length) box.replaceChildren(...l.lines.map(x => h('div', { class: 'ly', onclick: () => { audio.currentTime = x.ms / 1000; } }, x.text || '♪')));
  else if (l.plain) box.replaceChildren(h('div', { style: 'white-space:pre-wrap;font-size:19px' }, l.plain));
  else box.replaceChildren(h('div', { class: 'muted' }, 'Titre instrumental'));
  box._lines = l.lines; box._cur = -1;
}
function syncLyrics(box, ms) {
  const lines = box._lines; if (!lines || !lines.length) return;
  let i = -1; for (let k = 0; k < lines.length; k++) { if (lines[k].ms <= ms + 300) i = k; else break; }
  if (i === box._cur) return;
  box._cur = i;
  const els = box.children;
  for (let k = 0; k < els.length; k++) els[k].classList.toggle('on', k === i);
  if (i >= 0 && els[i]) box.scrollTo({ top: els[i].offsetTop - box.clientHeight / 3, behavior: 'smooth' });
}

// ---------- Clips YouTube ----------
let clipCache = store.get('clips', {});      // id du titre → { chosen, cands:[{id,title,channel,thumb}], none, manual, offset, date }
const saveClips = () => { store.set('clips', clipCache); markDirty(); };
const validId = s => /^[A-Za-z0-9_-]{11}$/.test(s || '');
function scoreClip(c, artist, title) {
  const t = fold(c.title), ch = fold(c.channel), a = fold(artist).trim(), s = fold(cleanTitle(title)).trim();
  let n = 0;
  n += s && t.includes(s) ? 4 : -4;
  if (a && (t.includes(a) || ch.includes(a) || ch.includes(a.replace(/ /g, '')))) n += 2;
  if (ch.endsWith('vevo')) n += 4;
  if (/official (music )?video|clip officiel|videoclip|video oficial/.test(t)) n += 4; else if (/official|officiel/.test(t)) n += 1;
  if (ch.endsWith(' - topic')) n -= 6;
  for (const bad of ['lyrics', 'lyric', 'paroles', 'karaoke', 'cover', 'reaction', 'remix', '8d', 'slowed', 'sped up', 'nightcore', 'instrumental', 'tutorial']) if (t.includes(bad) && !s.includes(bad)) n -= 3;
  if ((t.includes('live') || t.includes('concert')) && !s.includes('live')) n -= 2;
  if (t.includes('audio') && !t.includes('video')) n -= 2;
  return n;
}
const unesc = s => (s || '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, '\'').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
async function resolveClip(t, force = false) {
  const old = clipCache[t.id];
  if (!force && old && (old.chosen || old.manual || (old.none && Date.now() - old.date < 30 * 86400000))) return old;
  const various = /various|divers|fichiers/i.test(t.artist);
  const q = (various ? '' : t.artist + ' ') + cleanTitle(t.title) + ' official video';
  try {
    const r = await fetch('https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&maxResults=8&videoEmbeddable=true&q=' + encodeURIComponent(q) + '&key=' + YT_KEY);
    const j = await r.json();
    if (!r.ok) {
      const reason = j?.error?.errors?.[0]?.reason || '';
      clip.msg = /quota|dailyLimit/.test(reason) ? 'Quota YouTube du jour atteint (environ 100 recherches). Réessaie demain.'
        : r.status === 403 ? 'YouTube refuse la recherche (' + reason + ') : la clé n\'accepte peut-être pas cette adresse.' : 'Recherche YouTube impossible (' + r.status + ').';
      return old || null;
    }
    clip.msg = '';
    const cands = (j.items || []).map(o => ({ id: o.id?.videoId, title: unesc(o.snippet?.title), channel: unesc(o.snippet?.channelTitle), thumb: o.snippet?.thumbnails?.medium?.url || '' })).filter(c => validId(c.id));
    const ranked = cands.map(c => [c, scoreClip(c, t.artist, t.title)]).sort((a, b) => b[1] - a[1]);
    const best = ranked[0] && ranked[0][1] >= 0 ? ranked[0][0] : null;
    clipCache[t.id] = { chosen: best ? best.id : null, cands: ranked.map(x => x[0]), none: !best, manual: false, offset: old?.offset || 0, date: Date.now() };
    saveClips();
    return clipCache[t.id];
  } catch { clip.msg = 'Pas de connexion : clip non cherché.'; return old || null; }
}
function chooseClip(t, id) { clipCache[t.id] = Object.assign({ cands: [], offset: 0 }, clipCache[t.id], { chosen: id, none: false, manual: true, date: Date.now() }); saveClips(); if (clip.on && cur() === t) clipTrackChanged(); updatePlayer(); }
function noClip(t) { clipCache[t.id] = Object.assign({ cands: [], offset: 0 }, clipCache[t.id], { chosen: null, none: true, manual: true, date: Date.now() }); saveClips(); if (clip.on && cur() === t) clipTrackChanged(); }
function linkId(s) { s = (s || '').trim(); if (validId(s)) return s; const m = s.match(/(?:v=|youtu\.be\/|shorts\/|embed\/|live\/)([A-Za-z0-9_-]{11})/); return m ? m[1] : null; }
async function clipPicker(t) {
  let info = clipCache[t.id];
  sheet('Clip de « ' + t.title + ' »', [h('div', { class: 'muted small', style: 'padding:0 12px' }, 'Recherche…')]);
  if (!info || !info.cands?.length) info = await resolveClip(t, true);
  const items = (info?.cands || []).map(c => h('button', { class: 'it cand', onclick: () => { $('#sheet').hidden = true; chooseClip(t, c.id); } },
    h('img', { src: c.thumb, alt: '' }), h('div', null, h('div', { style: c.id === info.chosen ? 'font-weight:800' : '' }, (c.id === info.chosen ? '✓ ' : '') + c.title), h('div', { class: 'muted small' }, c.channel))));
  sheet('Clip de « ' + t.title + ' »', [
    clip.msg ? h('div', { style: 'color:var(--red);padding:0 12px' }, clip.msg) : null,
    ...items,
    { label: 'Coller un lien YouTube…', fn: () => { const id = linkId(prompt('Lien YouTube')); if (id) chooseClip(t, id); else toast('Lien non reconnu'); } },
    { label: 'Chercher à nouveau', fn: async () => { await resolveClip(t, true); clipPicker(t); } },
    { label: 'Pas de clip pour ce titre', red: true, fn: () => noClip(t) },
  ]);
}
// Ouvrir dans l'appli YouTube ou YouTube Music (abonnement Premium = sans pubs).
let away = 0;
function openExternal(kind, t, id) {
  const q = encodeURIComponent((t.artist + ' ' + cleanTitle(t.title)).trim());
  const url = kind === 'music' ? (id ? 'https://music.youtube.com/watch?v=' + id : 'https://music.youtube.com/search?q=' + q)
    : (id ? 'https://www.youtube.com/watch?v=' + id : 'https://www.youtube.com/results?search_query=' + q);
  audio.pause(); if (clip.has) ytCmd('pauseVideo');
  away = Date.now();
  const a = h('a', { href: url, target: '_blank', rel: 'noopener' }); document.body.append(a); a.click(); a.remove();
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || !away) return;
  if (Date.now() - away < 2500) return;
  away = 0;
  if (S.afterReturn === 'next') next(true); else if (S.afterReturn === 'resume') audio.play().catch(() => { });
});

// Lecteur officiel YouTube (API IFrame) dans le mode clip.
const clip = { on: false, has: false, yt: null, ready: null, msg: '', tried: new Set(), timer: 0, len: 0, time: 0, playing: false };
function ytApi() {
  if (clip.ready) return clip.ready;
  clip.ready = new Promise(res => {
    window.onYouTubeIframeAPIReady = () => res(true);
    const s = h('script', { src: 'https://www.youtube.com/iframe_api' }); s.onerror = () => { clip.ready = null; res(false); };
    document.head.append(s);
  });
  return clip.ready;
}
function ytCmd(f, ...a) { try { clip.yt && clip.yt[f] && clip.yt[f](...a); } catch { } }
async function openClip() {
  const t = cur(); if (!t) return;
  if (S.clipPlayer === 'youtube' || S.clipPlayer === 'music') { const i = await resolveClip(t); return openExternal(S.clipPlayer, t, i?.chosen); }
  clip.on = true; clip.entry = t.id; $('#clip').hidden = false; clipLayout(); wakeBar();
  if (!(await ytApi())) { clip.msg = 'Impossible de charger le lecteur YouTube (réseau ?).'; clipTrackChanged(); return; }
  if (!clip.yt) {
    clip.yt = new YT.Player('yt', {
      width: '100%', height: '100%',
      playerVars: { autoplay: 1, controls: 0, playsinline: 1, rel: 0, fs: 0, iv_load_policy: 3, modestbranding: 1, origin: location.origin },
      events: {
        onReady: () => clipTrackChanged(),
        onStateChange: e => { clip.playing = e.data === 1 || e.data === 3; $('#clip .play').textContent = clip.playing ? '⏸' : '▶'; if (e.data === 0) { if (S.clipAuto) next(true); else closeClip(); } },
        onError: e => {
          const info = clipCache[cur()?.id];
          const nid = info?.cands?.map(c => c.id).find(id => !clip.tried.has(id));
          if ([100, 101, 150].includes(e.data) && nid && !info.manual) { clip.tried.add(nid); ytCmd('loadVideoById', nid); }
          else { clip.has = false; clip.msg = 'Ce clip ne peut être lu que dans YouTube : touche « Source ▾ ».'; showNoVideo(cur()); audio.play().catch(() => { }); }
        },
      },
    });
    clearInterval(clip.timer);
    clip.timer = setInterval(() => {
      if (!clip.on || !clip.has || !clip.yt?.getCurrentTime) return;
      clipTick(clip.yt.getCurrentTime() * 1000, (clip.yt.getDuration() || 0) * 1000);
    }, 250);
  } else clipTrackChanged();
}
function closeClip() {
  if (!clip.on) return;
  const wasPlaying = clip.has && clip.playing;
  const at = (clip.time + (clipCache[cur()?.id]?.offset || 0)) / 1000;
  clip.on = false; $('#clip').hidden = true; ytCmd('stopVideo'); clip.has = false;
  if (wasPlaying) {
    // La musique reprend là où en était le clip.
    if (at > 0 && (!audio.duration || at < audio.duration - 2)) audio.currentTime = at;
    audio.play().catch(() => { });
  }
}
async function clipTrackChanged() {
  const t = cur(); if (!t || !clip.on) return;
  clip.tried = new Set();
  $('#clip .info .t').textContent = t.title; $('#clip .info .s').textContent = t.artist;
  clipLyricsFor(t);
  const info = await resolveClip(t);
  if (cur() !== t || !clip.on) return;
  if (info?.chosen && clip.yt?.loadVideoById) {
    clip.has = true; clip.tried.add(info.chosen);
    // Premier clip après l'ouverture : il reprend à la seconde où en était le MP3 (moins le décalage des paroles).
    const start = clip.entry === t.id ? Math.max(0, audio.currentTime - (info.offset || 0) / 1000) : 0;
    clip.entry = null;
    audio.pause();
    $('#clip .nov').hidden = true; $('#yt').style.visibility = 'visible';
    const f = clip.yt.getIframe && clip.yt.getIframe(); if (f) f.style.visibility = 'visible';
    clip.yt.loadVideoById({ videoId: info.chosen, startSeconds: start });
  } else {
    clip.has = false; ytCmd('stopVideo');
    showNoVideo(t);
    if (audio.paused) audio.play().catch(() => { });
  }
}
function showNoVideo(t) {
  const f = clip.yt?.getIframe && clip.yt.getIframe(); if (f) f.style.visibility = 'hidden';
  const n = $('#clip .nov'); n.hidden = false;
  const box = h('div', { class: 'art' }); coverInto(box, t);
  n.replaceChildren(box, h('div', null, clip.msg || 'Pas de clip trouvé pour ce titre : la musique continue.'));
  $('#clip .play').textContent = audio.paused ? '▶' : '⏸';
}
async function clipLyricsFor(t) {
  const side = $('#clip .side'); side._lines = null; side.replaceChildren();
  const l = await lyricsFor(t);
  if (cur() !== t) return;
  const lines = l?.lines || [];
  side._lines = lines; side._cur = -1;
  side.replaceChildren(...lines.map(x => h('div', { class: 'ly' }, x.text || '♪')));
  clipLayout();
}
function clipLayout() {
  const has = ($('#clip .side')._lines || []).length > 0;
  $('#clip .side').hidden = !(S.clipLyrics === 'left' && has);
  $('#clip .subs').hidden = !(S.clipLyrics === 'subs' && has);
  $('#clip .lmode').textContent = { off: 'Sans paroles', left: 'Paroles à gauche', subs: 'Sous-titres' }[S.clipLyrics];
  $('#clip .minus').hidden = $('#clip .plus').hidden = S.clipLyrics === 'off';
}
function clipTick(ms, len) {
  const t = cur(); if (!t) return;
  clip.time = ms; clip.len = len;
  if (!tick.cdrag) $('#clip .seek').value = len ? Math.round(ms / len * 1000) : 0;
  const pos = ms + (clipCache[t.id]?.offset || 0);
  const side = $('#clip .side');
  if (!side.hidden) syncLyrics(side, pos);
  const subs = $('#clip .subs');
  if (!subs.hidden && side._lines) {
    let i = -1; for (let k = 0; k < side._lines.length; k++) { if (side._lines[k].ms <= pos + 200) i = k; else break; }
    const c = side._lines[i]?.text, n = side._lines[i + 1]?.text || '';
    if (subs._i !== i) { subs._i = i; subs.replaceChildren(...(c != null ? [h('div', { class: 'c' }, c || '♪'), n ? h('div', { class: 'n' }, n) : null] : [])); }
  }
}
function wakeBar() {
  $('#clip').classList.remove('idle');
  clearTimeout(wakeBar._t);
  wakeBar._t = setTimeout(() => { if (clip.has && clip.playing) $('#clip').classList.add('idle'); }, 5000);
}
$('#clip').addEventListener('pointerdown', wakeBar);
$('#clip .close').onclick = closeClip;
$('#clip .play').onclick = () => { if (clip.has) ytCmd(clip.playing ? 'pauseVideo' : 'playVideo'); else toggle(); setTimeout(() => showPlayState(), 50); };
function showPlayState() { if (!clip.has) $('#clip .play').textContent = audio.paused ? '▶' : '⏸'; }
$('#clip .prev').onclick = () => { if (clip.has && clip.time > 3000) ytCmd('seekTo', 0, true); else prev(); };
$('#clip .next').onclick = () => next(true);
$('#clip .seek').addEventListener('input', () => { tick.cdrag = true; });
$('#clip .seek').addEventListener('change', e => {
  tick.cdrag = false; const f = e.target.value / 1000;
  if (clip.has) ytCmd('seekTo', f * clip.len / 1000, true); else if (audio.duration) audio.currentTime = f * audio.duration;
});
$('#clip .lmode').onclick = () => { S.clipLyrics = { off: 'left', left: 'subs', subs: 'off' }[S.clipLyrics]; saveS(); clipLayout(); };
$('#clip .minus').onclick = () => shiftOffset(-500);
$('#clip .plus').onclick = () => shiftOffset(500);
function shiftOffset(d) { const t = cur(); if (!t) return; const c = clipCache[t.id] || (clipCache[t.id] = { cands: [], offset: 0, date: Date.now() }); c.offset = Math.max(-60000, Math.min(60000, (c.offset || 0) + d)); c.date = Date.now(); saveClips(); toast('Décalage des paroles : ' + (c.offset / 1000).toFixed(1).replace('.', ',') + ' s', 1200); }
$('#clip .src').onclick = () => {
  const t = cur(); if (!t) return; const id = clipCache[t.id]?.chosen;
  sheet('Clip', [
    { label: 'Ouvrir dans YouTube', fn: () => openExternal('youtube', t, id) },
    { label: 'Ouvrir dans YouTube Music', fn: () => openExternal('music', t, id) },
    { label: 'Choisir un autre clip…', fn: () => clipPicker(t) },
    { label: 'Pas de clip pour ce titre', red: true, fn: () => noClip(t) },
    { label: 'Revenir à la pochette', fn: closeClip },
  ]);
};

// ---------- Réglages ----------
function viewSettings(v) {
  const id = h('input', { class: 'field', value: S.clientId, placeholder: '…apps.googleusercontent.com' });
  const pills = (key, opts, after) => h('div', { class: 'row' }, opts.map(([val, label]) =>
    h('button', { class: 'pill' + (S[key] === val ? ' on' : ''), onclick: () => { S[key] = val; saveS(); if (after) after(); render(); } }, label)));
  const ago = sync.last ? Math.max(0, Math.round((Date.now() - sync.last) / 60000)) : null;
  v.append(h('h1', null, 'Réglages'),
    h('div', { class: 'card' }, h('h2', { style: 'margin-top:0' }, 'Profil'),
      h('div', { class: 'row' }, h('b', { style: 'font-size:18px' }, sync.name || 'Aucun profil choisi'), isBoss() ? h('span', { class: 'pill on' }, 'Administrateur') : null,
        h('button', { class: 'pill', onclick: () => hasToken() ? pickProfile() : connect() }, 'Changer')),
      h('p', { class: 'muted small' }, sync.me ? 'Compte Google : ' + sync.me.email : 'Connecte-toi avec ton propre compte Google : tes favoris, playlists et écoutes te suivent sur tous tes appareils, sans se mélanger avec ceux de la famille.'),
      h('p', { class: 'small', style: sync.error ? 'color:var(--red)' : '' }, sync.error || (ago == null ? '' : '✓ Synchronisé ' + (ago < 1 ? 'à l\'instant' : 'il y a ' + ago + ' min') + ' · ' + favs.tracks.size + ' titres favoris · ' + playlists.length + ' playlists · ' + playLog.length + ' écoutes')),
      h('button', { class: 'pill', onclick: async () => { if (!hasToken() && !(await connect())) return; await pull(); toast(sync.error || 'Synchronisé'); render(); } }, 'Synchroniser maintenant')),
    isBoss() ? h('div', { class: 'card' }, h('h2', { style: 'margin-top:0' }, 'Administration (Boss)'),
      h('p', { class: 'muted small' }, 'Pour la famille : dans Google Drive, partage le dossier de musique avec les comptes de Sam, Adam et Sofia en tant que « Lecteur ». Google les empêche alors de modifier ou supprimer quoi que ce soit.'),
      h('div', { class: 'btns' },
        h('button', { class: 'btn', onclick: () => publishIndex(null, false) }, 'Publier la bibliothèque pour la famille'),
        h('button', { class: 'btn alt', onclick: async () => { if (!hasToken() && !(await connect())) return; scan(true); } }, 'Relire toute la musique'))) : null,
    h('div', { class: 'card' }, h('h2', { style: 'margin-top:0' }, 'Google Drive'),
      isBoss() || !S.clientId ? h('div', { class: 'muted small' }, 'ID client OAuth (Application Web) de ton projet Google Cloud :') : null,
      isBoss() || !S.clientId ? h('div', { class: 'row', style: 'margin:6px 0 10px' }, id, h('button', { class: 'btn', onclick: () => { S.clientId = id.value.trim(); saveS(); tokenClient = null; toast('ID client enregistré'); render(); } }, 'Enregistrer')) : null,
      h('div', null, hasToken() ? '✓ Connecté à Google Drive' : 'Pas connecté', ' ',
        h('button', { class: 'pill', onclick: async () => { if (await connect()) render(); } }, hasToken() ? 'Reconnecter' : 'Se connecter')),
      h('p', null, 'Dossier de musique : ', h('b', null, S.rootName || 'aucun')),
      h('div', { class: 'btns' },
        h('button', { class: 'btn alt', onclick: () => browse('root', [['root', 'Mon Drive']]) }, 'Choisir le dossier…'),
        h('button', { class: 'btn', onclick: async () => { if (!hasToken() && !(await connect())) return; scan(); } }, 'Relire la musique')),
      h('p', { class: 'muted small', id: 'scanmsg' }, scanMsg || (lib.tracks.length ? `${lib.tracks.length} titres · ${lib.albums.length} albums` : ''))),
    h('div', { class: 'card' }, h('h2', { style: 'margin-top:0' }, 'Fichiers de l\'iPhone (iCloud Drive)'),
      h('p', { class: 'muted small' }, 'Choisis des chansons dans l\'app Fichiers (iCloud Drive compris). Tu peux les garder dans BossPlay pour les rejouer sans les choisir à nouveau.'),
      h('div', { class: 'btns' }, h('button', { class: 'btn alt', onclick: () => $('#files').click() }, 'Ajouter des fichiers…'),
        localTracks.length ? h('button', { class: 'btn alt', onclick: () => openPage({ album: 'local' }) }, 'Voir (' + localTracks.length + ')') : null,
        localTracks.length ? h('button', { class: 'btn alt', onclick: clearLocal }, 'Tout retirer') : null)),
    h('div', { class: 'card' }, h('h2', { style: 'margin-top:0' }, 'Clips vidéo'),
      h('div', { class: 'muted small' }, 'Bouton « 🎬 Clip » du grand lecteur :'),
      pills('clipPlayer', [['integrated', 'Dans BossPlay'], ['youtube', 'Appli YouTube'], ['music', 'Appli YouTube Music']]),
      h('div', { class: 'muted small', style: 'margin-top:10px' }, 'Paroles sur le clip :'),
      pills('clipLyrics', [['off', 'Sans paroles'], ['left', 'À gauche'], ['subs', 'Sous-titres']]),
      h('div', { class: 'muted small', style: 'margin-top:10px' }, 'En revenant de YouTube :'),
      pills('afterReturn', [['next', 'Titre suivant'], ['resume', 'Reprendre la chanson'], ['nothing', 'Ne rien faire']]),
      h('div', { class: 'muted small', style: 'margin-top:10px' }, 'À la fin d\'un clip :'),
      pills('clipAuto', [[true, 'Titre suivant'], [false, 'Revenir à la pochette']]),
      h('div', { class: 'btns' }, h('button', { class: 'pill', onclick: () => { clipCache = {}; saveClips(); toast('Clips oubliés'); } }, 'Oublier les clips trouvés'))),
    extrasSettings(),
    h('div', { class: 'card' }, h('h2', { style: 'margin-top:0' }, 'Affichage'),
      pills('theme', [['auto', 'Automatique'], ['light', 'Jour'], ['dark', 'Nuit']], applyTheme),
      h('p', { class: 'muted small', id: 'usage' }, '')),
    h('p', { class: 'muted small' }, 'BossPlay PWA ' + VERSION + ' · Paroles : LRCLIB · Clips : YouTube'));
  navigator.storage?.estimate?.().then(e => { const u = $('#usage'); if (u) u.textContent = 'Stockage utilisé sur l\'appareil : ' + Math.round((e.usage || 0) / 1048576) + ' Mo'; });
}
async function clearLocal() {
  if (!confirm('Retirer tous les fichiers de l\'iPhone de BossPlay ?')) return;
  try { await caches.delete('bp-local'); } catch { }
  store.set('localIndex', []); localTracks.forEach(t => { if (t.url) URL.revokeObjectURL(t.url); lib.byId.delete(t.id); }); localTracks = []; render();
}
async function browse(id, path) {
  if (!hasToken() && !(await connect())) return;
  sheet(path.map(p => p[1]).join(' › '), [h('div', { class: 'muted small', style: 'padding:0 12px' }, 'Lecture…')]);
  try {
    const q = id === 'shared' ? "sharedWithMe = true and mimeType='application/vnd.google-apps.folder' and trashed=false"
      : `'${id}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`;
    const j = await drive('files', { q, fields: 'files(id,name)', pageSize: 1000, orderBy: 'name', supportsAllDrives: true, includeItemsFromAllDrives: true });
    sheet(path.map(p => p[1]).join(' › '), [
      id === 'root' ? { label: '📤 Partagés avec moi (musique de Boss)', fn: () => browse('shared', path.concat([['shared', 'Partagés avec moi']])) } : null,
      id !== 'root' && id !== 'shared' ? { label: '✓ Utiliser ce dossier', fn: async () => { S.rootId = id; S.rootName = path.slice(1).map(p => p[1]).join(' › '); saveS(); await whoAmI(); scan(); render(); } } : null,
      path.length > 1 ? { label: '‹ Dossier parent', fn: () => browse(path[path.length - 2][0], path.slice(0, -1)) } : null,
      ...(j.files || []).map(f => ({ label: '📁 ' + f.name, fn: () => browse(f.id, path.concat([[f.id, f.name]])) })),
    ]);
  } catch (e) { sheet('Google Drive', [h('div', { style: 'padding:0 12px' }, 'Lecture impossible : ' + e.message)]); }
}
function applyTheme() { document.documentElement.dataset.theme = S.theme; }

// ---------- Boutons ----------
document.querySelectorAll('#tabs button').forEach(b => b.onclick = () => go(b.dataset.tab));
$('#back').onclick = back;
$('#who').onclick = () => hasToken() ? pickProfile() : connect();
$('#theme').onclick = () => { S.theme = { auto: 'dark', dark: 'light', light: 'auto' }[S.theme]; saveS(); applyTheme(); toast({ auto: 'Thème automatique', dark: 'Thème nuit', light: 'Thème jour' }[S.theme], 1200); };
$('#search').addEventListener('input', e => { ui.q = e.target.value; if (!['albums', 'artists', 'songs'].includes(ui.tab)) ui.tab = 'songs'; ui.stack = []; render(); });
$('#mini .meta').onclick = $('#mini .art').onclick = () => { $('#full').hidden = false; updatePlayer(); tick(); };
$('#mini .play').onclick = $('#full .play').onclick = toggle;
$('#mini .next').onclick = $('#full .next').onclick = () => next(true);
$('#mini .prev').onclick = $('#full .prev').onclick = prev;
$('#full .close').onclick = () => { $('#full').hidden = true; };
$('#full .shuffle').onclick = () => { P.shuffle = !P.shuffle; if (P.shuffle) shuffleRest(); updatePlayer(); };
$('#full .repeat').onclick = () => { P.repeat = (P.repeat + 1) % 3; updatePlayer(); };
$('#full .fav').onclick = () => { const t = cur(); if (!t) return; toggleFav('t', t.id); updatePlayer(); };
$('#full .more').onclick = () => { const t = cur(); if (t) trackMenu(t); };
$('#full .clip').onclick = openClip;
$('#full .sleep').onclick = sleepSheet;
$('#full .kara').onclick = karaoke;
$('#mic').onclick = voice;
// 📺 Recherche envoyée à BossPlay TV (Fire TV, même Wi-Fi) : le texte du champ, sinon une dictée.
function tvAddr(ask) {
  let a = store.get('tvAddr', '');
  if (!a || ask) {
    a = (prompt('Adresse affichée sur la télé, dans Recherche (ex. 192.168.6.69:8765)', a || '192.168.6.69:8765') || '').trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    if (a) store.set('tvAddr', a);
  }
  return a;
}
const RELAY = RBASE + '/relay/send';
// Envoi par le relais Cloudflare (un seul toucher, rien ne s'ouvre) ; sinon, page de la télé sur le Wi-Fi.
async function tvSend(q) {
  if (hasToken()) {
    try {
      const r = await gfetch(RELAY, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ q }) });
      const j = await r.json().catch(() => ({}));
      if (r.ok && j.ok) {
        toast(j.tv ? '📺 Envoyé à la télé : ' + q : '📺 Envoyé : « ' + q + ' » — ouvre BossPlay sur la télé (dans les 2 minutes)', 3500);
        return;
      }
      if (r.status === 401) toast('Ce compte Google n\'est pas autorisé sur le serveur BossPlay : envoi par le Wi-Fi.', 3500);
    } catch (e) { /* serveur injoignable : envoi par le Wi-Fi */ }
  }
  tvLocal(q);
}
function tvLocal(q) {
  const a = tvAddr(false); if (!a) return;
  toast('📺 Envoi à la télé par le Wi-Fi : ' + q, 2500);
  location.href = 'http://' + a + '/?q=' + encodeURIComponent(q);
}
let tvBusy = false;
function tvSearch() {
  const typed = $('#search').value.trim();
  if (typed) return tvSend(typed);
  if (tvBusy) return;
  const R = window.SpeechRecognition || window.webkitSpeechRecognition;
  const ask = () => { const q = (prompt('Chercher sur la télé (tu peux utiliser le micro du clavier) :') || '').trim(); if (q) tvSend(q); };
  if (!R) return ask();
  if (!hasToken() && !tvAddr(false)) return;
  let done = false;
  const r = new R(); r.lang = 'fr-CA'; r.interimResults = false; r.maxAlternatives = 1; r.continuous = false;
  const stop = () => { tvBusy = false; $('#tvsearch').classList.remove('on'); };
  r.onstart = () => toast('📺 Je t\'écoute… dis un artiste, un album ou une chanson', 7000);
  r.onresult = e => { done = true; stop(); const q = (e.results[0][0].transcript || '').trim(); if (q) tvSend(q); else toast('Je n\'ai rien entendu.'); };
  r.onerror = e => {
    done = true; stop();
    if (e.error === 'not-allowed' || e.error === 'service-not-allowed') { toast('Micro refusé : autorise-le pour ce site, ou tape ta recherche.', 4000); ask(); }
    else if (e.error === 'no-speech') toast('Je n\'ai rien entendu : touche 📺 et parle tout de suite.', 3500);
    else { toast('Dictée indisponible (' + e.error + ') : tape ta recherche.', 3500); ask(); }
  };
  r.onend = () => { if (!done) { stop(); toast('Je n\'ai rien entendu : réessaie.', 2500); } };
  try { tvBusy = true; $('#tvsearch').classList.add('on'); r.start(); }
  catch (e) { stop(); ask(); }
}
$('#tvsearch').onclick = tvSearch;
$('#tvsearch').oncontextmenu = e => { e.preventDefault(); tvAddr(true); };
$('#remote').onclick = () => remoteSheet();
$('#full .lyr').onclick = () => {
  const box = $('#full .lyrics'), cov = $('#full .cover');
  const show = box.hidden; box.hidden = !show; cov.hidden = show; $('#full .lyr').classList.toggle('on', show);
  if (show) { box.dataset.for = ''; showLyrics(); }
};
$('#full .artist').onclick = () => { const t = cur(); if (t && lib.artistByKey.has(fold(t.artist))) { $('#full').hidden = true; openPage({ artist: fold(t.artist) }); } };
$('#full .album').onclick = () => { const t = cur(); if (t) { $('#full').hidden = true; openPage({ album: t.albumId }); } };
$('#full .seek').addEventListener('input', () => { tick.drag = true; });
$('#full .seek').addEventListener('change', e => { tick.drag = false; if (audio.duration) audio.currentTime = e.target.value / 1000 * audio.duration; });


// =====================================================================================================
// BossPlay 1.3 : radio + « Retenir ce titre », envies de la famille, écoutes, minuteur, télécommande,
// karaoké, commande vocale, badges de format, export M3U.
// =====================================================================================================
const X = {
  radios: store.get('xRadios', []),          // radios favorites [{ id, name, url, favicon, country, tags, ts }]
  radiosDel: store.get('xRadiosDel', {}),
  wishes: store.get('xWishes', []),          // mes envies [{ id, at, station, title, artist, note, by }]
  wishDel: store.get('xWishDel', {}),
  bought: store.get('xBought', {}),          // Boss : envies achetées ou masquées { id: date }
  wishSeen: store.get('xWishSeen', 0),       // Boss : date de la dernière envie vue
  family: [],                                // Boss : envies de toute la famille [{ ...envie, who }]
  newCount: 0,
};
const saveX = () => {
  store.set('xRadios', X.radios); store.set('xRadiosDel', X.radiosDel); store.set('xWishes', X.wishes);
  store.set('xWishDel', X.wishDel); store.set('xBought', X.bought); store.set('xWishSeen', X.wishSeen); markDirty();
};
function extraProfile() { return { radios: X.radios, radiosDel: X.radiosDel, wishes: X.wishes, wishDel: X.wishDel, bought: X.bought, wishSeen: X.wishSeen }; }
function extraMerge(e) {
  if (!e || typeof e !== 'object') return;
  const mergeList = (mine, theirs, delMine, delTheirs, key = 'id') => {
    for (const [k, v] of Object.entries(delTheirs || {})) if (v > (delMine[k] || 0)) delMine[k] = v;
    const m = new Map(mine.map(x => [x[key], x]));
    for (const x of theirs || []) { const y = m.get(x[key]); if (!y || (x.ts || x.at || 0) > (y.ts || y.at || 0)) m.set(x[key], x); }
    return [...m.values()].filter(x => !(delMine[x[key]] >= (x.ts || x.at || 0)));
  };
  X.radios = mergeList(X.radios, e.radios, X.radiosDel, e.radiosDel);
  X.wishes = mergeList(X.wishes, e.wishes, X.wishDel, e.wishDel).sort((a, b) => b.at - a.at);
  for (const [k, v] of Object.entries(e.bought || {})) if (!X.bought[k] || v > X.bought[k]) X.bought[k] = v;
  X.wishSeen = Math.max(X.wishSeen, e.wishSeen || 0);
  store.set('xRadios', X.radios); store.set('xRadiosDel', X.radiosDel); store.set('xWishes', X.wishes);
  store.set('xWishDel', X.wishDel); store.set('xBought', X.bought); store.set('xWishSeen', X.wishSeen);
}
const when = at => new Date(at).toLocaleString('fr-CA', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
async function appData(name) {
  const j = await drive('files', { spaces: 'appDataFolder', q: `name='${name}' and trashed=false`, fields: 'files(id,modifiedTime)', pageSize: 5 });
  return j.files?.[0] || null;
}
async function writeJson(name, data, id, parents) {
  const body = JSON.stringify(data);
  let r;
  if (id) r = await gfetch('https://www.googleapis.com/upload/drive/v3/files/' + id + '?uploadType=media', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body });
  if (!id || r.status === 404) {
    r = await gfetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id', multipart({ name, parents: parents || ['appDataFolder'] }, body, 'application/json'));
    if (r.ok) return (await r.json()).id;
  }
  if (!r.ok) throw new Error('écriture ' + r.status);
  return id;
}
async function readJson(id) {
  const r = await gfetch('https://www.googleapis.com/drive/v3/files/' + id + '?alt=media&supportsAllDrives=true');
  if (!r.ok) throw new Error('lecture ' + r.status);
  return r.json();
}

// ---------- Radio (Radio Browser, flux https uniquement) ----------
const radio = { el: new Audio(), st: null, results: [], q: '', loading: false, msg: '' };
radio.el.preload = 'none';
const RB = ['https://de1.api.radio-browser.info', 'https://nl1.api.radio-browser.info', 'https://at1.api.radio-browser.info'];
async function rbGet(path) {
  for (const base of RB) {
    try { const r = await fetch(base + path); if (r.ok) return await r.json(); } catch { }
  }
  throw new Error('service radio injoignable');
}
const toStation = s => ({ id: s.stationuuid, name: (s.name || '').trim() || 'Radio', url: s.url_resolved || s.url, favicon: s.favicon || '', country: s.countrycode || '', tags: (s.tags || '').split(',').slice(0, 3).join(', '), ts: Date.now() });
async function radioSearch(q) {
  radio.loading = true; radio.msg = ''; render();
  try {
    const path = q ? '/json/stations/search?name=' + encodeURIComponent(q) + '&hidebroken=true&order=clickcount&reverse=true&limit=80'
      : '/json/stations/bycountrycodeexact/CA?hidebroken=true&order=clickcount&reverse=true&limit=80';
    radio.results = (await rbGet(path)).filter(s => /^https:/i.test(s.url_resolved || '')).map(toStation);
    if (!radio.results.length) radio.msg = 'Aucune radio en https trouvée.';
  } catch (e) { radio.msg = e.message; }
  radio.loading = false; render();
}
function radioPlay(st) {
  audio.pause();
  radio.st = st; radio.el.src = st.url;
  radio.el.play().then(() => toast('📻 ' + st.name)).catch(() => toast('Cette radio ne se lit pas sur cet appareil.'));
  if ('mediaSession' in navigator) navigator.mediaSession.metadata = new MediaMetadata({ title: st.name, artist: 'Radio', album: st.tags || 'BossPlay Radio', artwork: st.favicon ? [{ src: st.favicon, sizes: '256x256' }] : [] });
  try { fetch(RB[0] + '/json/url/' + st.id).catch(() => { }); } catch { }
  render(); radioBar();
}
function radioStop() {
  if (!radio.st && radio.el.paused && !radio.el.getAttribute('src')) return;
  radio.el.pause(); radio.el.removeAttribute('src'); radio.el.load(); radio.st = null;
  lastCoverFor = null; updatePlayer(); if (ui.tab === 'radio') render();
}
radio.el.addEventListener('pause', radioBar); radio.el.addEventListener('play', radioBar);
function radioBar() { updatePlayer(); }
$('#mini .stop').onclick = $('#full .rstop').onclick = radioStop;
$('#mini .rwish').onclick = $('#full .rwish').onclick = () => wishSheet();
const isFavRadio = st => X.radios.some(r => r.id === st.id);
function favRadio(st) {
  if (isFavRadio(st)) { X.radios = X.radios.filter(r => r.id !== st.id); X.radiosDel[st.id] = Date.now(); toast('Retirée de mes radios'); }
  else { X.radios.push(Object.assign({}, st, { ts: Date.now() })); delete X.radiosDel[st.id]; toast('Ajoutée à mes radios'); }
  saveX(); render();
}
function stationRow(st) {
  const on = radio.st && radio.st.id === st.id;
  return h('div', { class: 'tr' + (on ? ' playing' : ''), onclick: () => radioPlay(st) },
    st.favicon ? h('img', { class: 'rfav', src: st.favicon, alt: '', loading: 'lazy', onerror: e => { e.target.replaceWith(h('div', { class: 'no' }, '📻')); } }) : h('div', { class: 'no' }, '📻'),
    h('div', { class: 'm' }, h('div', null, st.name), h('div', { class: 's' }, [st.country, st.tags].filter(Boolean).join(' · '))),
    h('button', { class: 'x', style: isFavRadio(st) ? 'color:var(--red)' : '', onclick: e => { e.stopPropagation(); favRadio(st); } }, isFavRadio(st) ? '♥' : '♡'));
}
function viewRadio(v) {
  const q = h('input', { class: 'field', type: 'search', placeholder: 'Nom de radio, ville, style (ex. CKOI, jazz, Montréal)…', value: radio.q });
  const go2 = () => { radio.q = q.value.trim(); radioSearch(radio.q); };
  q.addEventListener('keydown', e => { if (e.key === 'Enter') go2(); });
  v.append(h('h1', null, 'Radio'),
    h('div', { class: 'row', style: 'margin-bottom:12px' }, q, h('button', { class: 'btn', onclick: go2 }, 'Chercher')),
    h('p', { class: 'muted small' }, 'Pendant l\'écoute, « ♥ Retenir ce titre » garde la chanson dans tes envies' + (isBoss() ? '.' : ' et la transmet à Boss.') + ' Astuce : lance Shazam depuis le Centre de contrôle pour connaître le titre.'));
  if (X.radios.length) v.append(h('h2', null, 'Mes radios'), h('div', { class: 'list' }, X.radios.map(stationRow)));
  v.append(h('h2', null, radio.q ? 'Résultats' : 'Populaires au Canada'));
  if (radio.loading) v.append(h('p', { class: 'muted' }, 'Recherche…'));
  else if (radio.msg) v.append(h('p', { class: 'muted' }, radio.msg));
  else v.append(h('div', { class: 'list' }, radio.results.map(stationRow)));
  if (!radio.results.length && !radio.loading && !radio.msg) radioSearch('');
}

// ---------- Envies (« Retenir ce titre ») ----------
function wishSheet(pre = {}) {
  const st = radio.st;
  const ti = h('input', { class: 'field', placeholder: 'Titre de la chanson (si tu le connais)', value: pre.title || '' });
  const ar = h('input', { class: 'field', placeholder: 'Artiste', value: pre.artist || '' });
  const no = h('input', { class: 'field', placeholder: 'Note (ex. « refrain : I will survive »)', value: '' });
  const box = h('div', { style: 'padding:0 12px 8px;display:grid;gap:8px' },
    h('div', { class: 'muted small' }, (st ? '📻 ' + st.name + ' · ' : '') + when(Date.now())), ti, ar, no,
    h('button', { class: 'btn', onclick: () => { $('#sheet').hidden = true; addWish({ station: st ? st.name : (pre.station || ''), title: ti.value.trim(), artist: ar.value.trim(), note: no.value.trim() }); } }, '♥ Retenir'));
  sheet('Retenir ce titre', [box]);
  setTimeout(() => ti.focus(), 200);
}
function addWish(w) {
  const e = Object.assign({ id: 'w' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), at: Date.now(), by: sync.name || 'Boss' }, w);
  X.wishes.unshift(e); saveX();
  toast(isBoss() ? '♥ Ajouté à ta liste d\'achats' : '♥ Retenu — Boss le verra dans sa liste');
  publishWishes();
  if (ui.tab === 'wishes') render();
}
function delWish(w) { X.wishes = X.wishes.filter(x => x.id !== w.id); X.wishDel[w.id] = Date.now(); saveX(); publishWishes(); render(); }
// Chaque membre garde sa liste dans un fichier de SON Drive, partagé en lecture avec Boss (courriel de Google au 1er partage).
async function adminEmail() {
  if (S.adminEmail) return S.adminEmail;
  if (!S.rootId) return null;
  try { const f = await drive('files/' + S.rootId, { fields: 'owners(emailAddress)', supportsAllDrives: true }); S.adminEmail = f.owners?.[0]?.emailAddress || ''; saveS(); } catch { }
  return S.adminEmail || null;
}
let wishTimer = 0;
function publishWishes() { clearTimeout(wishTimer); wishTimer = setTimeout(doPublishWishes, 1500); }
async function doPublishWishes() {
  if (!hasToken() || !sync.name) return;
  const name = 'bossplay-envies-' + sync.name + '.json';
  try {
    let id = store.get('xWishFile', null);
    if (!id) { const j = await drive('files', { q: `name='${name}' and 'me' in owners and trashed=false`, fields: 'files(id)', pageSize: 3 }); id = j.files?.[0]?.id || null; }
    const data = { who: sync.name, email: sync.me?.email || '', updated: Date.now(), wishes: X.wishes };
    const newId = await writeJson(name, data, id, ['root']);
    store.set('xWishFile', newId);
    if (!isBoss() && !store.get('xWishShared', false)) {
      const to = await adminEmail();
      if (to && to !== sync.me?.email) {
        const r = await gfetch('https://www.googleapis.com/drive/v3/files/' + newId + '/permissions?sendNotificationEmail=true&emailMessage=' +
          encodeURIComponent(sync.name + ' a retenu des chansons dans BossPlay. Ouvre BossPlay › Envies.'), {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ role: 'reader', type: 'user', emailAddress: to }) });
        if (r.ok) store.set('xWishShared', true);
      }
    }
  } catch (e) { if (e.message !== 'auth') console.warn('envies', e); }
}
async function loadFamilyWishes() {
  if (!isBoss() || !hasToken()) return;
  try {
    const j = await drive('files', { q: "name contains 'bossplay-envies-' and trashed=false", fields: 'files(id,name,modifiedTime,owners(displayName,emailAddress))', pageSize: 50 });
    const all = [];
    for (const f of j.files || []) {
      try {
        const d = await readJson(f.id);
        if (d.email && d.email === sync.me?.email) continue;            // mes propres envies sont déjà dans X.wishes
        for (const w of d.wishes || []) all.push(Object.assign({}, w, { who: d.who || f.owners?.[0]?.displayName || '?' }));
      } catch { }
    }
    X.family = all.sort((a, b) => b.at - a.at);
    const fresh = X.family.filter(w => w.at > X.wishSeen && !X.bought[w.id]);
    X.newCount = fresh.length;
    tabBadge();
    if (fresh.length) {
      const per = {}; fresh.forEach(w => per[w.who] = (per[w.who] || 0) + 1);
      toast('♥ Nouvelles envies : ' + Object.entries(per).map(([k, n]) => k + ' ' + n).join(', '), 5000);
    }
  } catch (e) { if (e.message !== 'auth') console.warn('envies famille', e); }
}
function tabBadge() {
  const b = $('#tabs [data-tab="wishes"]'); if (b) b.dataset.badge = X.newCount ? String(X.newCount) : '';
  try { X.newCount ? navigator.setAppBadge?.(X.newCount) : navigator.clearAppBadge?.(); } catch { }
}
const buyLinks = w => {
  const q = encodeURIComponent([w.artist, w.title].filter(Boolean).join(' ') || w.note || w.station);
  return [h('a', { class: 'pill', href: 'https://music.apple.com/ca/search?term=' + q, target: '_blank', rel: 'noopener' }, 'iTunes'),
    h('a', { class: 'pill', href: 'https://www.amazon.ca/s?k=' + q + '&i=digital-music', target: '_blank', rel: 'noopener' }, 'Amazon'),
    h('a', { class: 'pill', href: 'https://www.youtube.com/results?search_query=' + q, target: '_blank', rel: 'noopener' }, 'YouTube')];
};
function copyWish(w) {
  const t = [w.title, w.artist].filter(Boolean).join(' – ') || w.station || '';
  const done = () => toast('Copié : ' + t);
  if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(t).then(done).catch(() => fallbackCopy(t, done));
  fallbackCopy(t, done);
}
function fallbackCopy(t, done) {
  const ta = h('textarea', { style: 'position:fixed;top:-1000px' }); ta.value = t; document.body.append(ta); ta.select();
  try { document.execCommand('copy'); done(); } catch { toast('Copie impossible'); } ta.remove();
}
function wishRow(w, mine) {
  const done = !!X.bought[w.id];
  return h('div', { class: 'card wishc' + (done ? ' done' : '') },
    h('div', { class: 'row', style: 'justify-content:space-between' },
      h('b', null, (w.title || 'Titre inconnu') + (w.artist ? ' — ' + w.artist : '')),
      w.who ? h('span', { class: 'pill on' }, w.who) : null),
    h('div', { class: 'muted small' }, [w.station ? '📻 ' + w.station : '', when(w.at)].filter(Boolean).join(' · ')),
    w.note ? h('div', { class: 'small' }, '« ' + w.note + ' »') : null,
    h('div', { class: 'row', style: 'margin-top:8px' }, h('button', { class: 'pill', onclick: () => copyWish(w) }, '📋 Copier'), ...(isBoss() ? buyLinks(w) : []),
      isBoss() ? h('button', { class: 'pill' + (done ? ' on' : ''), onclick: () => { if (done) delete X.bought[w.id]; else X.bought[w.id] = Date.now(); saveX(); render(); } }, done ? '✓ Acheté' : 'Marquer acheté') : null,
      mine ? h('button', { class: 'pill', onclick: () => delWish(w) }, 'Retirer') : null));
}
function viewWishes(v) {
  if (isBoss()) {
    if (X.newCount) { X.wishSeen = Date.now(); X.newCount = 0; saveX(); tabBadge(); }
    const todo = X.family.concat(X.wishes.map(w => Object.assign({ who: 'Boss' }, w))).sort((a, b) => b.at - a.at);
    const open = todo.filter(w => !X.bought[w.id]), done = todo.filter(w => X.bought[w.id]);
    v.append(h('h1', null, 'Liste d\'achats de la famille'),
      h('p', { class: 'muted small' }, 'Chansons retenues à la radio par Sam, Adam, Sofia et toi. Les membres partagent leur liste avec ton compte Google : tu reçois un courriel au premier partage, puis le badge « Envies » t\'avertit.'),
      h('div', { class: 'btns', style: 'margin-bottom:10px' }, h('button', { class: 'pill', onclick: async () => { await loadFamilyWishes(); render(); toast('Liste à jour'); } }, 'Actualiser'),
        h('button', { class: 'pill', onclick: () => wishSheet() }, '+ Ajouter à la main')));
    v.append(h('h2', null, 'À acheter (' + open.length + ')'));
    if (!open.length) v.append(h('p', { class: 'muted' }, 'Rien pour l\'instant.'));
    open.forEach(w => v.append(wishRow(w, w.who === 'Boss')));
    if (done.length) { v.append(h('h2', null, 'Achetés (' + done.length + ')')); done.forEach(w => v.append(wishRow(w, w.who === 'Boss'))); }
  } else {
    v.append(h('h1', null, 'Mes envies'),
      h('p', { class: 'muted small' }, 'Les chansons que tu retiens à la radio sont envoyées à Boss pour qu\'il les ajoute à la bibliothèque.'),
      h('div', { class: 'btns', style: 'margin-bottom:10px' }, h('button', { class: 'pill', onclick: () => wishSheet() }, '+ Ajouter à la main')));
    if (!X.wishes.length) v.append(h('p', { class: 'muted' }, 'Aucune envie. Écoute la radio et touche « ♥ Retenir ce titre ».'));
    X.wishes.forEach(w => v.append(wishRow(w, true)));
  }
}

// ---------- Écoutes et statistiques ----------
const statsUi = { period: 30 };
function viewStats(v) {
  const now = Date.now(), y = new Date().getFullYear();
  const from = statsUi.period === 'year' ? new Date(y, 0, 1).getTime() : statsUi.period ? now - statsUi.period * 86400000 : 0;
  const log = playLog.filter(x => x.at >= from && lib.byId.has(x.id));
  const count = (key) => { const m = new Map(); for (const x of log) { const t = lib.byId.get(x.id); const k = key(t); if (k) m.set(k, (m.get(k) || 0) + 1); } return [...m.entries()].sort((a, b) => b[1] - a[1]); };
  const topT = count(t => t.id).slice(0, 25), topA = count(t => t.albumArtist || t.artist).slice(0, 15), topAl = count(t => t.albumId).slice(0, 12);
  const pill = (val, label) => h('button', { class: 'pill' + (statsUi.period === val ? ' on' : ''), onclick: () => { statsUi.period = val; render(); } }, label);
  v.append(h('h1', null, statsUi.period === 'year' ? 'Mon récap ' + y : 'Mes écoutes'),
    h('div', { class: 'row', style: 'margin-bottom:12px' }, pill(7, '7 jours'), pill(30, '30 jours'), pill('year', 'Récap ' + y), pill(0, 'Tout')),
    h('div', { class: 'card' }, h('div', { class: 'stat' }, h('b', null, String(log.length)), ' écoutes'),
      h('div', { class: 'stat' }, h('b', null, String(new Set(log.map(x => x.id)).size)), ' titres différents'),
      h('div', { class: 'stat' }, h('b', null, String(new Set(log.map(x => lib.byId.get(x.id).albumArtist)).size)), ' artistes')));
  if (!log.length) { v.append(h('p', { class: 'muted' }, 'Pas encore d\'écoutes sur cette période (une écoute compte après 30 secondes).')); return; }
  if (topAl.length) v.append(h('h2', null, 'Albums les plus écoutés'), h('div', { class: 'grid' }, topAl.map(([id]) => lib.albumById.get(id)).filter(Boolean).map(albumCell)));
  v.append(h('h2', null, 'Artistes'), h('div', { class: 'list' }, topA.map(([n, c], i) => h('div', { class: 'tr', onclick: () => lib.artistByKey.has(fold(n)) && openPage({ artist: fold(n) }) },
    h('div', { class: 'no' }, String(i + 1)), h('div', { class: 'm' }, h('div', null, n), h('div', { class: 's' }, c + ' écoutes'))))));
  const ts = topT.map(([id]) => lib.byId.get(id));
  v.append(h('h2', null, 'Titres'), h('div', { class: 'btns', style: 'margin-bottom:8px' }, h('button', { class: 'btn', onclick: () => play(ts, 0) }, '▶ Lire mon top'),
    h('button', { class: 'btn alt', onclick: () => { const np = { id: 'pl' + Date.now().toString(36), name: 'Mon top ' + (statsUi.period === 'year' ? y : new Date().toLocaleDateString('fr-CA')), ids: ts.map(t => t.id) }; playlists.push(np); savePl(np); toast('Playlist créée'); } }, 'En faire une playlist')),
    h('div', { class: 'list' }, topT.map(([id, c], i) => { const t = lib.byId.get(id); const row = trackRow(t, ts, i, { album: true }); row.querySelector('.s').textContent += ' · ' + c + ' écoutes'; return row; })));
  const recent = playLog.slice(-60).reverse().map(x => ({ t: lib.byId.get(x.id), at: x.at })).filter(x => x.t);
  v.append(h('h2', null, 'Historique'), h('div', { class: 'list' }, recent.map((x, i) => {
    const row = trackRow(x.t, recent.map(r => r.t), i, { album: true }); row.querySelector('.no').textContent = new Date(x.at).toLocaleTimeString('fr-CA', { hour: '2-digit', minute: '2-digit' }); return row;
  })));
}

// ---------- Minuteur de sommeil ----------
const sleepT = { end: 0, endOfTrack: false, timer: 0, vol: 1 };
function sleepSheet() {
  const left = sleepT.end ? Math.max(0, Math.round((sleepT.end - Date.now()) / 60000)) : 0;
  sheet(sleepT.end || sleepT.endOfTrack ? 'Minuteur : ' + (sleepT.endOfTrack ? 'fin du titre' : left + ' min restantes') : 'Arrêter la musique dans…', [
    ...[15, 30, 45, 60, 90].map(m => ({ label: m + ' minutes', fn: () => setSleep(m) })),
    { label: 'À la fin de ce titre', fn: () => { clearSleep(); sleepT.endOfTrack = true; toast('Arrêt à la fin du titre'); sleepBtn(); } },
    sleepT.end || sleepT.endOfTrack ? { label: 'Annuler le minuteur', red: true, fn: () => { clearSleep(); toast('Minuteur annulé'); } } : null]);
}
function setSleep(m) {
  clearSleep(); sleepT.end = Date.now() + m * 60000;
  sleepT.timer = setInterval(() => {
    const left = sleepT.end - Date.now();
    const el = radio.st ? radio.el : audio;
    if (left <= 30000 && left > 0) el.volume = Math.max(0, left / 30000);      // fondu sur les 30 dernières secondes
    if (left <= 0) { audio.pause(); radio.el.pause(); clearSleep(); toast('Bonne nuit 🌙'); }
    sleepBtn();
  }, 1000);
  toast('Arrêt dans ' + m + ' minutes'); sleepBtn();
}
function clearSleep() { clearInterval(sleepT.timer); sleepT.end = 0; sleepT.endOfTrack = false; audio.volume = 1; radio.el.volume = 1; sleepBtn(); }
function sleepEnd() { if (!sleepT.endOfTrack) return false; clearSleep(); audio.pause(); toast('Bonne nuit 🌙'); updatePlayer(); return true; }
function sleepBtn() {
  const b = $('#full .sleep'); if (!b) return;
  const left = sleepT.end ? Math.max(0, Math.ceil((sleepT.end - Date.now()) / 60000)) : 0;
  b.textContent = sleepT.endOfTrack ? '⏾ fin' : sleepT.end ? '⏾ ' + left + ' min' : '⏾';
  b.classList.toggle('on', !!(sleepT.end || sleepT.endOfTrack));
}

// ---------- Badges de format ----------
// Pastille Dolby indiquée à la main (titre ou album), gardée sur cet appareil.
const DOLBY = [['dolby_a', 'Dolby A'], ['dolby_b', 'Dolby B'], ['dolby_c', 'Dolby C'], ['dolby_s', 'Dolby S'], ['dolby_sr', 'Dolby SR'],
  ['dolby_surround', 'Dolby Surround'], ['dolby_pro_logic_ii', 'Dolby Pro Logic II']];
const dolbyTags = store.get('dolbyTags', {});
const dolbyOf = t => dolbyTags['t:' + t.id] || dolbyTags['a:' + t.albumId] || '';
function dolbyMenu(key, name) {
  const cur = dolbyTags[key] || '';
  const set = c => { if (c) dolbyTags[key] = c; else delete dolbyTags[key]; store.set('dolbyTags', dolbyTags); updateBadges(curTrackSafe()); toast(c ? 'Pastille : ' + DOLBY.find(d => d[0] === c)[1] : 'Pastille retirée'); };
  sheet('Pastille Dolby — ' + name, [{ label: (cur ? '' : '✓ ') + 'Aucune', fn: () => set('') },
    ...DOLBY.map(([c, n]) => ({ label: (cur === c ? '✓ ' : '') + n, fn: () => set(c) }))]);
}
function curTrackSafe() { try { return cur(); } catch (e) { return null; } }
function badgeImg(code, label) {
  // Le grand lecteur est toujours sombre : image « _dark ».
  const img = h('img', { class: 'badge-img', alt: label, title: label, src: 'badges/' + code + '_dark.png' });
  img.onerror = () => { img.replaceWith(h('span', { class: 'badge' }, label.toUpperCase())); };
  return img;
}
function updateBadges(t) {
  const box = $('#full .badges'); if (!box) return;
  if (!t) { box.replaceChildren(); return; }
  const ext = (t.name || '').split('.').pop().toLowerCase();
  const fmtName = { mp3: 'MP3', m4a: 'AAC', aac: 'AAC', mp4: 'AAC', flac: 'FLAC', wav: 'WAV', aif: 'AIFF', aiff: 'AIFF', ogg: 'OGG', opus: 'OPUS', ac3: 'AC-3', ec3: 'E-AC-3', eac3: 'E-AC-3', dts: 'DTS' }[ext] || ext.toUpperCase();
  const lossless = ['flac', 'wav', 'aif', 'aiff'].includes(ext);
  const d = audio.duration;
  const kbps = t.size && d ? Math.round(t.size * 8 / d / 1000) : 0;
  const multi = ['ac3', 'ec3', 'eac3', 'dts'].includes(ext);
  const items = [fmtName, lossless ? 'Sans perte' : kbps ? kbps + ' kb/s' : '', multi ? '' : 'Stéréo', offline.has(t.id) ? 'Sur l\'appareil' : ''];
  const nodes = items.filter(Boolean).map((s, i) => h('span', { class: 'badge' + (i === 0 ? ' main' : '') }, s));
  if (ext === 'ac3') nodes.push(badgeImg('dolby_digital', 'Dolby Digital'));
  if (ext === 'ec3' || ext === 'eac3') nodes.push(h('span', { class: 'badge' }, 'DOLBY DIGITAL PLUS'));
  if (ext === 'dts') nodes.push(h('span', { class: 'badge' }, 'DTS'));
  if (multi) nodes.push(badgeImg('surround', 'Surround'));
  const dz = dolbyOf(t);
  if (dz) nodes.push(badgeImg(dz, (DOLBY.find(x => x[0] === dz) || [0, dz])[1]));
  box.replaceChildren(...nodes);
}
audio.addEventListener('loadedmetadata', () => updateBadges(cur()));

// ---------- Karaoké (atténuation de la voix au centre) ----------
const kara = { on: false, ctx: null, src: null, sum: null };
function karaoke() {
  try {
    if (!kara.ctx) {
      const C = window.AudioContext || window.webkitAudioContext; kara.ctx = new C();
      kara.src = kara.ctx.createMediaElementSource(audio);
      const split = kara.ctx.createChannelSplitter(2), inv = kara.ctx.createGain(); inv.gain.value = -1;
      kara.sum = kara.ctx.createGain(); kara.sum.channelCount = 1; kara.sum.channelCountMode = 'explicit';
      split.connect(kara.sum, 0); split.connect(inv, 1); inv.connect(kara.sum); kara.split = split;
      kara.sum.connect(kara.ctx.destination);
    }
    kara.ctx.resume();
    kara.on = !kara.on;
    kara.src.disconnect();
    kara.src.connect(kara.on ? kara.split : kara.ctx.destination);
    $('#full .kara').classList.toggle('on', kara.on);
    toast(kara.on ? '🎤 Karaoké : voix atténuée (selon l\'enregistrement)' : 'Karaoké désactivé');
    if (kara.on && $('#full .lyrics').hidden) $('#full .lyr').click();
  } catch (e) { toast('Karaoké indisponible sur cet appareil'); }
}

// ---------- Commande vocale ----------
function voice() {
  const R = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!R) return voiceAsk('');
  const r = new R(); r.lang = 'fr-CA'; r.interimResults = false; r.maxAlternatives = 1;
  let done = false;
  toast('Je t\'écoute… (ex. « joue Bob Marley », « pause », « suivant », « radio CKOI »)', 6000);
  r.onresult = e => { done = true; doVoice(e.results[0][0].transcript || ''); };
  // Sur l'iPhone, une appli installée sur l'écran d'accueil n'a souvent pas droit à la reconnaissance vocale :
  // on le dit clairement et on propose de taper ou de dicter la commande avec le micro du clavier.
  r.onerror = e => {
    if (done) return; done = true;
    const why = e && e.error;
    if (why === 'no-speech') return toast('Je n\'ai rien entendu. Touche le micro et parle tout de suite.');
    if (why === 'aborted') return;
    voiceAsk(why === 'not-allowed' || why === 'service-not-allowed' ? 'Le micro n\'est pas autorisé ici.' : 'La reconnaissance vocale ne marche pas ici.');
  };
  try { r.start(); } catch { voiceAsk(''); }
}
/** Commande tapée, ou dictée avec le micro du clavier (marche partout). */
function voiceAsk(why) {
  const q = (prompt((why ? why + ' ' : '') + 'Tape ta commande, ou dicte-la avec le micro du clavier :\n« joue Bob Marley », « pause », « suivant », « radio CKOI »') || '').trim();
  if (q) doVoice(q);
}
function doVoice(s) {
  const t = fold(s).trim(); toast('« ' + s + ' »', 2000);
  if (/^(pause|stop|arrete)/.test(t)) { audio.pause(); radio.el.pause(); return; }
  if (/^(suivant|chanson suivante|next)/.test(t)) return next(true);
  if (/^(precedent|chanson precedente)/.test(t)) return prev();
  if (/^(reprend|lecture|play)$/.test(t)) return toggle();
  let m = t.match(/^radio\s+(.+)/);
  if (m) { go('radio'); radio.q = m[1]; return rbGet('/json/stations/search?name=' + encodeURIComponent(m[1]) + '&hidebroken=true&order=clickcount&reverse=true&limit=20').then(l => { const s2 = l.find(x => /^https:/.test(x.url_resolved || '')); s2 ? radioPlay(toStation(s2)) : toast('Radio introuvable'); }).catch(() => toast('Radio introuvable')); }
  m = t.match(/^(joue|mets|lance|ecoute|fais jouer)\s+(.+)/);
  const q = m ? m[2].replace(/^(l'album |l album |la chanson |le titre |du |de la |de |des )/, '') : t;
  const ar = lib.artists.find(a => fold(a.name) === q) || lib.artists.find(a => fold(a.name).includes(q));
  const al = lib.albums.find(a => fold(a.name) === q) || lib.albums.find(a => fold(a.name).includes(q));
  const tr = lib.tracks.find(x => fold(x.title) === q) || lib.tracks.find(x => fold(x.title).includes(q));
  if (m && tr && (!ar || fold(tr.title) === q)) return play([tr], 0);
  if (m && ar) { const all = ar.albums.flatMap(a => a.tracks); P.shuffle = true; return play(all, Math.floor(Math.random() * all.length)); }
  if (m && al) return play(al.tracks, 0);
  $('#search').value = ui.q = s; ui.tab = 'songs'; ui.stack = []; render();
}

// ---------- Export M3U (clé USB de la voiture, VLC…) ----------
function m3u(name, tracks) {
  const safe = s => (s || '').replace(/\//g, '_');
  const lines = ['#EXTM3U'];
  for (const t of tracks) { if (t.local) continue; lines.push('#EXTINF:-1,' + t.artist + ' - ' + t.title); lines.push(safe(t.albumArtist || t.artist) + '/' + safe(t.album) + '/' + t.name); }
  const a = h('a', { href: URL.createObjectURL(new Blob([lines.join('\r\n') + '\r\n'], { type: 'audio/x-mpegurl' })), download: name.replace(/[\\/:*?"<>|]/g, '_') + '.m3u8' });
  document.body.append(a); a.click(); a.remove();
  toast('Playlist exportée (à placer à la racine de la clé USB)');
}

// ---------- Lecture partagée entre appareils (instantanée, par le relais BossPlay) ----------
// Chaque appareil ouvert annonce ce qu'il joue et garde une requête ouverte vers le relais : un ordre arrive en moins d'une seconde.
// Un profil ne voit que ses propres appareils ; Boss les voit tous.
const rc = { id: store.get('devId', null), devices: [], seq: -1, skew: 0, loop: false, ctl: null, pubTimer: 0, lastPub: 0, denied: false, panel: null };
if (!rc.id) { rc.id = Math.random().toString(36).slice(2, 10); store.set('devId', rc.id); }
function devName() {
  if (S.devName) return S.devName;
  const u = navigator.userAgent;
  return /iPhone/.test(u) ? 'iPhone' : /iPad|Macintosh.*Mobile/.test(u) || (/Macintosh/.test(u) && navigator.maxTouchPoints > 1) ? 'iPad' : /Android/.test(u) ? 'Android' : /Mac/.test(u) ? 'Mac' : /Windows/.test(u) ? 'PC' : 'Navigateur';
}
const pathOf = t => [(t.albumArtist || t.artist || '').replace(/\//g, '_'), (t.album || '').replace(/\//g, '_'), t.name].join('/');
let pathMap = null, pathFor = null;
function byPath(p) {
  if (pathFor !== lib) { pathFor = lib; pathMap = new Map(); for (const t of lib.tracks) { const parts = pathOf(t).split('/').map(fold); pathMap.set(parts.join('/'), t); if (!pathMap.has(parts.slice(1).join('/'))) pathMap.set(parts.slice(1).join('/'), t); } }
  const parts = String(p || '').split('/').filter(Boolean).map(fold);
  return pathMap.get(parts.slice(-3).join('/')) || pathMap.get(parts.slice(-2).join('/')) || null;
}
const resolveList = (ids, paths) => { const a = (ids || []).map(id => lib.byId.get(id)).filter(Boolean); return a.length ? a : (paths || []).map(byPath).filter(Boolean); };
function nowState() {
  const t = cur();
  if (radio.st) return { radio: radio.st.name, playing: !radio.el.paused };
  if (!t) return null;
  const from = Math.max(0, P.i - 10), q = P.queue.slice(from, P.i + 60);
  return { id: t.id, path: pathOf(t), title: t.title, artist: t.artist, album: t.album, playing: !audio.paused, pos: audio.currentTime || 0, dur: audio.duration || 0,
    paths: q.map(pathOf), qi: P.i - from };
}
// Appels au relais : jamais par gfetch (un refus du relais ne doit pas déconnecter Google Drive).
async function rfetch(path, body, signal) {
  const r = await fetch(RBASE + path, { method: body ? 'POST' : 'GET', signal, body: body ? JSON.stringify(body) : undefined,
    headers: Object.assign({ Authorization: 'Bearer ' + tok.t }, body ? { 'Content-Type': 'application/json' } : {}) });
  if (r.status === 401) { rc.denied = true; throw new Error('Ce compte Google n\'est pas autorisé sur le serveur BossPlay.'); }
  if (!r.ok) throw new Error('relais ' + r.status);
  rc.denied = false;
  return r.json();
}
const rcP = () => encodeURIComponent(sync.name || 'Famille');
const rcSounding = () => !audio.paused || (radio.st && !radio.el.paused);
const rcOn = () => !S.remoteOff && hasToken() && !!sync.name && !rc.denied && (document.visibilityState === 'visible' || rcSounding());
function rcPublish(soon) {
  if (S.remoteOff) return;
  clearTimeout(rc.pubTimer); rc.pubTimer = setTimeout(async () => {
    if (!rcOn()) return;
    rc.lastPub = Date.now();
    try { await rfetch('/play/pub?p=' + rcP(), { dev: { id: rc.id, name: devName(), kind: 'pwa', who: sync.name }, now: nowState() }); } catch { }
  }, soon ? 120 : 1200);
}
async function rcLoop() {
  if (rc.loop) return; rc.loop = true;
  let fail = 0;
  while (rcOn()) {
    try {
      rc.ctl = new AbortController();
      const j = await rfetch('/play/wait?p=' + rcP() + '&dev=' + rc.id + '&since=' + rc.seq + (isBoss() ? '&all=1' : ''), null, rc.ctl.signal);
      fail = 0; rc.seq = j.seq; rc.skew = j.t - Date.now();
      rc.devices = (j.devices || []).filter(d => d.id !== rc.id);
      for (const c of j.cmds || []) { try { runCmd(c); } catch { } }
      if ((j.cmds || []).length) rcPublish(true);
      rcShow();
    } catch (e) {
      if (e.name === 'AbortError') continue;
      fail++; await sleep(Math.min(30000, 500 * 2 ** fail));
    }
  }
  rc.loop = false;
}
// À appeler quand le profil, la connexion ou l'affichage change : repart tout de suite avec les bons réglages.
function rcKick() { rc.denied = false; rc.seq = -1; rc.devices = []; try { rc.ctl && rc.ctl.abort(); } catch { } rcShow(); rcLoop(); rcPublish(true); }
function runCmd(c) {
  const a = c.arg;
  const seekTo = pos => { if (audio.readyState >= 1) audio.currentTime = pos; else audio.addEventListener('canplay', () => { audio.currentTime = pos; }, { once: true }); };
  switch (c.cmd) {
    case 'toggle': radio.st ? (radio.el.paused ? radio.el.play() : radio.el.pause()) : toggle(); break;
    case 'pause': audio.pause(); radio.el.pause(); break;
    case 'play': if (radio.st) radio.el.play().catch(() => { }); else if (audio.paused) toggle(); break;
    case 'next': next(true); break;
    case 'prev': prev(); break;
    case 'seek': audio.currentTime = Math.max(0, (audio.currentTime || 0) + (+a || 0)); break;
    case 'seekTo': audio.currentTime = Math.max(0, +a || 0); break;
    case 'vol': audio.volume = radio.el.volume = Math.max(0, Math.min(1, audio.volume + (+a || 0))); break;
    case 'playIds': {
      const list = resolveList(a.ids, a.paths);
      if (!list.length) return toast('Ces titres ne sont pas dans la bibliothèque de cet appareil.');
      radioStop(); P.shuffle = false; play(list, Math.min(a.i || 0, list.length - 1));
      if (a.pos) audio.addEventListener('canplay', () => { audio.currentTime = a.pos; }, { once: true });
      toast('▶ Lecture reçue de ' + (c.from || 'un autre appareil')); break;
    }
  }
}
async function sendCmd(dev, cmd, arg) {
  const j = await rfetch('/play/cmd?p=' + rcP(), { to: dev.id, cmd, arg, from: devName() });
  if (!j.online) toast(dev.name + ' ne répond pas : BossPlay y est peut-être fermé.', 3500);
  return j.online;
}
// Position estimée d'un autre appareil, à la seconde près (son dernier état + le temps écoulé depuis).
function rcPos(d) {
  const n = d.now || {};
  const p = (n.pos || 0) + (n.playing ? Math.max(0, (Date.now() + rc.skew - (d.srv || 0)) / 1000) : 0);
  return n.dur ? Math.min(p, n.dur) : p;
}
const mmss = x => { x = Math.max(0, Math.floor(x || 0)); return Math.floor(x / 60) + ':' + String(x % 60).padStart(2, '0'); };
const rcTrack = n => (n && ((n.id && lib.byId.get(n.id)) || byPath(n.path))) || null;
const rcKindIcon = k => k === 'tv' ? 'Télé' : k === 's8' ? 'Tablette' : k === 'mac' ? 'Mac' : 'Téléphone';
const rcPlayingElse = () => rc.devices.find(d => d.now && d.now.playing && !d.now.radio) || rc.devices.find(d => d.now && d.now.playing) || null;
// Reprend ici, au même endroit, ce qui joue sur l'appareil « d », et met « d » en pause.
function rcTakeOver(d) {
  const n = d.now || {};
  const list = resolveList(n.queue, n.paths); if (!list.length) return toast('Ces titres ne sont pas dans la bibliothèque de cet appareil.');
  const pos = rcPos(d);
  radioStop(); P.shuffle = false; play(list, Math.min(n.qi || 0, list.length - 1));
  audio.addEventListener('canplay', () => { audio.currentTime = pos; }, { once: true });
  sendCmd(d, 'pause').catch(() => { });
  $('#sheet').hidden = true;
}
// Envoie ma lecture sur l'appareil « d », au même endroit, et met cet appareil en pause.
async function rcHandOff(d) {
  const s = nowState(); if (!s || s.radio) return toast('Lance d\'abord un titre de ta musique.');
  try { if (await sendCmd(d, 'playIds', { paths: s.paths, i: s.qi, pos: s.pos })) { audio.pause(); toast('La musique continue sur ' + d.name); } }
  catch (e) { toast('Envoi impossible : ' + e.message); }
}
// Bandeau « en lecture sur un autre appareil » (au-dessus du lecteur), avec pochette et avancement en direct.
function rcShow() {
  const bar = $('#else'), d = S.remoteOff ? null : rcPlayingElse();
  const show = !!d && !rcSounding();
  bar.hidden = !show;
  document.body.classList.toggle('has-else', show);
  if (show) {
    const n = d.now, key = d.id + '|' + (n.radio || n.path || n.title);
    if (bar.dataset.key !== key) {
      bar.dataset.key = key;
      const t = rcTrack(n), art = $('.art', bar);
      if (t) coverInto(art, t); else art.replaceChildren(h('span', { class: 'rlogo', style: 'font-size:20px' }, n.radio ? '📻' : '♪'));
      $('.t', bar).textContent = n.radio || n.title || '';
      $('.s', bar).textContent = 'En lecture sur ' + d.name + (n.artist ? ' · ' + n.artist : '');
      $('.take', bar).hidden = !!n.radio;
    }
    bar.dataset.dev = d.id;
  } else bar.dataset.key = '';
  rcTick();
  if (rc.panel && !$('#sheet').hidden && rc.panel.box.isConnected) { const d2 = rc.devices.find(x => x.id === rc.panel.id); if (d2) rcFill(d2); } else rc.panel = null;
}
function rcTick() {
  const bar = $('#else');
  if (!bar.hidden) { const d = rc.devices.find(x => x.id === bar.dataset.dev); if (d && d.now && d.now.dur) $('.fill', bar).style.width = (100 * rcPos(d) / d.now.dur).toFixed(2) + '%'; else $('.fill', bar).style.width = '0'; }
  if (rc.panel && rc.panel.box.isConnected) {
    const d = rc.devices.find(x => x.id === rc.panel.id), n = d && d.now;
    if (n && n.dur) { rc.panel.fill.style.width = (100 * rcPos(d) / n.dur).toFixed(2) + '%'; rc.panel.time.textContent = mmss(rcPos(d)) + ' / ' + mmss(n.dur); }
    else { rc.panel.fill.style.width = '0'; rc.panel.time.textContent = n && n.radio ? 'EN DIRECT' : ''; }
  }
}
setInterval(rcTick, 1000);
function rcFill(d) {
  const P2 = rc.panel, n = d.now || {}, key = n.radio || n.path || n.title || '';
  if (P2.key !== key) {
    P2.key = key;
    const t = rcTrack(n);
    if (t) coverInto(P2.art, t); else P2.art.replaceChildren(h('span', { class: 'rlogo' }, n.radio ? '📻' : '♪'));
    P2.title.textContent = n.radio || n.title || 'À l\'arrêt';
    P2.sub.textContent = n.artist ? n.artist + ' — ' + (n.album || '') : '';
  }
  P2.play.textContent = n.playing ? '⏸' : '▶';
  P2.take.hidden = !(n.paths && n.paths.length) || !!n.radio;
}
function remoteSheet(openId) {
  if (!hasToken()) return connect().then(t => { if (t) { rcKick(); remoteSheet(openId); } });
  if (S.remoteOff) return toast('La lecture partagée est désactivée sur cet appareil.');
  if (!rc.loop) rcKick();
  const d0 = openId && rc.devices.find(d => d.id === openId);
  if (d0) return remotePanel(d0);
  const line = d => { const n = d.now; return d.name + (d.who && d.who !== sync.name ? ' (' + d.who + ')' : '') + ' — ' + (n ? (n.radio ? '📻 ' + n.radio : (n.playing ? '▶ ' : '⏸ ') + n.title) : 'à l\'arrêt'); };
  sheet('Mes appareils', [
    h('div', { class: 'muted small', style: 'padding:0 12px 8px' }, 'Cet appareil : ' + devName() + ' · profil ' + sync.name + '.'),
    ...(rc.devices.length ? rc.devices.map(d => ({ label: line(d), fn: () => remotePanel(d) }))
      : [h('div', { style: 'padding:6px 12px' }, rc.denied ? 'Ce compte Google n\'est pas autorisé sur le serveur BossPlay.'
        : 'Aucun autre appareil pour l\'instant. Ouvre BossPlay sur l\'autre appareil, avec le même profil (' + sync.name + ') : il apparaît ici en une ou deux secondes.'),
        { label: 'Actualiser', fn: () => { rcKick(); setTimeout(() => remoteSheet(), 900); } }]),
  ]);
}
function remotePanel(d) {
  const send = async (cmd, arg, local) => { try { if (local) { local(); rcShow(); } await sendCmd(d, cmd, arg); } catch (e) { toast('Envoi impossible : ' + e.message); } };
  const live = () => rc.devices.find(x => x.id === d.id) || d;
  const btn = (label, cmd, arg, local) => h('button', { class: 'btn alt', onclick: () => send(cmd, arg, local) }, label);
  const art = h('div', { class: 'rc-art' }), title = h('b', null, ''), sub = h('div', { class: 'muted small' }, ''), fill = h('div', { class: 'fill' }), time = h('div', { class: 'muted small rc-time' }, '');
  const bar = h('div', { class: 'rc-bar', onclick: e => { const n = live().now; if (!n || !n.dur) return; const r = bar.getBoundingClientRect(); const pos = n.dur * Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)); send('seekTo', pos, () => { n.pos = pos; live().srv = Date.now() + rc.skew; }); } }, fill);
  const play = h('button', { class: 'btn', onclick: () => send('toggle', null, () => { const x = live(); if (x.now) { x.now.pos = rcPos(x); x.srv = Date.now() + rc.skew; x.now.playing = !x.now.playing; } }) }, '⏯');
  const take = h('button', { class: 'it', onclick: () => rcTakeOver(live()) }, 'Continuer ici (sur ' + devName() + ')');
  const box = h('div', { class: 'rc-now' }, art, h('div', { class: 'rc-meta' }, title, sub));
  sheet(rcKindIcon(d.kind) + ' · ' + d.name, [
    box, h('div', { style: 'padding:0 12px' }, bar, time),
    h('div', { class: 'btns', style: 'padding:6px 12px 10px;justify-content:center' }, btn('⏮', 'prev'), play, btn('⏭', 'next'), btn('−15 s', 'seek', -15), btn('+15 s', 'seek', 15), btn('Vol −', 'vol', -0.1), btn('Vol +', 'vol', 0.1)),
    take,
    cur() && !radio.st ? { label: 'Envoyer ma musique sur ' + d.name, fn: () => rcHandOff(live()) } : null,
  ]);
  rc.panel = { id: d.id, box, art, title, sub, fill, time, play, take, key: null };
  rcFill(live()); rcTick();
}
$('#else .meta').onclick = $('#else .art').onclick = () => remoteSheet($('#else').dataset.dev);
$('#else .pp').onclick = () => { const d = rc.devices.find(x => x.id === $('#else').dataset.dev); if (d) sendCmd(d, 'pause').catch(() => { }); };
$('#else .take').onclick = () => { const d = rc.devices.find(x => x.id === $('#else').dataset.dev); if (d) rcTakeOver(d); };
audio.addEventListener('play', () => { rcPublish(true); rcLoop(); rcShow(); });
audio.addEventListener('pause', () => { rcPublish(true); rcShow(); });
audio.addEventListener('seeked', () => rcPublish(true));
setInterval(() => { if (Date.now() - rc.lastPub > 25000) rcPublish(true); if (!rc.loop) rcLoop(); }, 10000);   // présence : « je suis toujours là »
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { rcKick(); if (isBoss()) loadFamilyWishes(); } });
setInterval(() => { if (isBoss() && document.visibilityState === 'visible') loadFamilyWishes(); }, 10 * 60000);

function extrasSettings() {
  const nm = h('input', { class: 'field', value: devName(), placeholder: 'Nom de cet appareil' });
  return h('div', { class: 'card' }, h('h2', { style: 'margin-top:0' }, 'Mes appareils'),
    h('div', { class: 'muted small' }, 'Nom de cet appareil :'),
    h('div', { class: 'row', style: 'margin:6px 0 10px' }, nm, h('button', { class: 'btn', onclick: () => { S.devName = nm.value.trim(); saveS(); rcPublish(true); toast('Nom enregistré'); } }, 'Enregistrer')),
    h('div', { class: 'row' }, h('button', { class: 'pill' + (S.remoteOff ? '' : ' on'), onclick: () => { S.remoteOff = !S.remoteOff; saveS(); render(); rcKick(); } }, S.remoteOff ? 'Lecture partagée : non' : 'Lecture partagée : oui'),
      h('button', { class: 'pill', onclick: () => remoteSheet() }, h('span', { class: 'ic', html: $('#remote').innerHTML }), ' Mes appareils')),
    h('p', { class: 'muted small' }, 'Lecture partagée : tes appareils ouverts sur le même profil se voient en direct. Tu peux mettre en pause, changer de titre, ou faire passer la musique de l\'un à l\'autre sans perdre l\'endroit où tu étais.'),
    playlists.length ? h('div', { class: 'btns' }, h('button', { class: 'pill', onclick: () => playlists.forEach(p => m3u(p.name, p.ids.map(id => lib.byId.get(id)).filter(Boolean))) }, 'Exporter mes playlists (M3U)')) : null);
}

// ---------- Démarrage ----------
(async function start() {
  applyTheme();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => { });
  // Demande au navigateur de ne pas effacer la bibliothèque gardée sur l'appareil.
  try { navigator.storage?.persist?.(); } catch { }
  for (const t of store.get('localIndex', [])) localTracks.push(Object.assign({}, t));
  const raw = await idb.get('library');
  if (raw && raw.rootId === S.rootId) buildLib(raw); else for (const t of localTracks) lib.byId.set(t.id, t);
  if (!navigator.onLine && (offline.size || localTracks.length)) ui.tab = 'kept';   // sans Internet : directement la musique téléchargée
  render(); banner();
  if (S.clientId) initAuth();
  if (hasToken()) whoAmI();
  if (S.rootId && hasToken() && !raw) scan();
  else if (S.rootId && hasToken() && Date.now() - store.get('lastScan', 0) > 24 * 3600000) { store.set('lastScan', Date.now()); scan(); }   // au plus une fois par jour
})();
