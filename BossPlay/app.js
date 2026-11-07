/* BossPlay PWA — lecteur de ta bibliothèque Google Drive (Artiste/Album/Titre), pour iPhone, iPad et tout navigateur.
   Paroles : LRCLIB. Clips : YouTube (lecteur officiel intégré, ou l'appli YouTube / YouTube Music). */
'use strict';

const VERSION = '1.0';
const YT_KEY = 'AIzaSyDoAxJzDHTkIPDqZbVcLr2Aguu40kPZqio';            // clé « BossPlayPWA » (limitée à bosseagle-la.github.io)
const SCOPE = 'https://www.googleapis.com/auth/drive.readonly';
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
  openPage() {
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
const saveFavs = () => { store.set('favTracks', [...favs.tracks]); store.set('favAlbums', [...favs.albums]); };
let playlists = store.get('playlists', []);
const savePl = () => store.set('playlists', playlists);
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
        tok = { t: r.access_token, exp: Date.now() + (Number(r.expires_in || 3600) - 120) * 1000 };
        store.set('token', tok);
        banner();
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
  if (need === undefined) need = !hasToken() && !!S.rootId;
  if (!need || hasToken()) { b.hidden = true; return; }
  b.replaceChildren(h('span', null, S.clientId ? 'Connexion à Google Drive expirée.' : 'BossPlay n\'est pas encore relié à Google Drive.'),
    h('button', { onclick: async () => { const t = await connect(); if (t) { b.hidden = true; if (!lib.tracks.length && S.rootId) scan(); } } }, 'Se connecter'));
  b.hidden = false;
}

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

async function scan() {
  if (!S.rootId) { toast('Choisis d\'abord le dossier de musique dans Réglages.'); go('settings'); return; }
  try {
    setStatus('Lecture de Google Drive…');
    const folders = await listAll("mimeType='application/vnd.google-apps.folder' and trashed=false", 'files(id,name,parents)');
    const audio = await listAll("mimeType contains 'audio/' and trashed=false", 'files(id,name,parents,size,mimeType)');
    const images = await listAll("mimeType contains 'image/' and trashed=false", 'files(id,name,parents)');
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
  const t = cur(); if (!t) return;
  const seq = ++P.seq;
  P.error = ''; ui.loading = true; updatePlayer();
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
  if (!cur()) return;
  if (audio.paused) { if (!audio.src) load(); else audio.play().catch(() => { }); } else audio.pause();
}
function playNext(list) { if (!cur()) return play(list); P.queue.splice(P.i + 1, 0, ...list); toast('Sera lu ensuite'); }
function addQueue(list) { if (!cur()) return play(list); P.queue.push(...list); toast('Ajouté à la file d\'attente'); }
audio.addEventListener('ended', () => next(false));
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
  set('play', () => clip.on && clip.has ? ytCmd('playVideo') : audio.play());
  set('pause', () => clip.on && clip.has ? ytCmd('pauseVideo') : audio.pause());
  set('previoustrack', prev);
  set('nexttrack', () => next(true));
  set('seekto', d => { if (d.seekTime != null) audio.currentTime = d.seekTime; });
}

// ---------- Interface ----------
const ui = { tab: 'albums', stack: [], q: '', loading: false, songLimit: 400 };
function go(tab) { ui.tab = tab; ui.stack = []; ui.songLimit = 400; $('#search').value = ui.q = ''; render(); }
function openPage(page) { ui.stack.push(page); render(); $('#view').scrollTop = 0; }
function back() { ui.stack.pop(); render(); }
function filt(list, text) { if (!ui.q) return list; const q = fold(ui.q); return list.filter(x => fold(text(x)).includes(q)); }

function render() {
  document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === ui.tab && !ui.stack.length));
  $('#back').hidden = !ui.stack.length;
  const v = $('#view'); v.replaceChildren();
  const page = ui.stack[ui.stack.length - 1];
  if (page) {
    if (page.album) return viewAlbum(v, lib.albumById.get(page.album) || localAlbum());
    if (page.artist) return viewArtist(v, lib.artistByKey.get(page.artist));
    if (page.playlist) return viewPlaylist(v, playlists.find(p => p.id === page.playlist));
  }
  if (!lib.tracks.length && !localTracks.length && ui.tab !== 'settings') return viewEmpty(v);
  ({ albums: viewAlbums, artists: viewArtists, songs: viewSongs, favs: viewFavs, playlists: viewPlaylists, settings: viewSettings })[ui.tab](v);
}
function viewEmpty(v) {
  v.append(h('div', { class: 'card' },
    h('h1', null, 'Bienvenue dans BossPlay'),
    h('p', null, S.rootId ? 'Ta bibliothèque n\'est pas encore lue.' : 'Relie ton Google Drive et choisis le dossier de musique (Artiste › Album › Titre).'),
    h('p', { class: 'muted small', id: 'scanmsg' }, scanMsg),
    h('div', { class: 'btns' },
      S.rootId ? h('button', { class: 'btn', onclick: async () => { if (!hasToken() && !(await connect())) return; scan(); } }, 'Lire ma musique') : null,
      h('button', { class: 'btn alt', onclick: () => go('settings') }, 'Réglages'),
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
  const kept = a.tracks.length && a.tracks.every(t => offline.has(t.id) || t.local);
  v.append(h('div', { class: 'hero' }, artBox('art', a, a.name),
    h('div', null,
      h('div', { class: 'muted small' }, 'ALBUM'), h('div', { class: 'h-t' }, a.name),
      h('div', { class: 'link', style: 'color:var(--accent);cursor:pointer', onclick: () => a.artistKey && lib.artistByKey.has(a.artistKey) && openPage({ artist: a.artistKey }) }, a.artist),
      h('div', { class: 'muted small' }, a.tracks.length + ' titres'),
      h('div', { class: 'btns' },
        h('button', { class: 'btn', onclick: () => play(a.tracks, 0) }, '▶ Lire'),
        h('button', { class: 'btn alt', onclick: () => { P.shuffle = true; play(a.tracks, Math.floor(Math.random() * a.tracks.length)); } }, 'Aléatoire'),
        h('button', { class: 'btn alt', onclick: () => { fav ? favs.albums.delete(a.id) : favs.albums.add(a.id); saveFavs(); render(); } }, fav ? '♥ Favori' : '♡ Favori'),
        a.tracks[0]?.local ? null : h('button', { class: 'btn alt', onclick: () => kept ? unkeep(a) : keep(a) }, kept ? 'Retirer de l\'appareil' : 'Garder hors ligne')))),
    h('div', { class: 'list' }, a.tracks.map((t, i) => trackRow(t, a.tracks, i, { num: true }))));
}
function viewArtist(v, ar) {
  if (!ar) { v.append(h('p', null, 'Artiste introuvable.')); return; }
  const all = ar.albums.flatMap(a => a.tracks);
  v.append(h('h1', null, ar.name),
    h('div', { class: 'btns', style: 'margin-bottom:16px' }, h('button', { class: 'btn', onclick: () => play(all, 0) }, '▶ Tout lire'),
      h('button', { class: 'btn alt', onclick: () => { P.shuffle = true; play(all, Math.floor(Math.random() * all.length)); } }, 'Aléatoire')),
    h('div', { class: 'grid' }, ar.albums.map(albumCell)));
}
function viewFavs(v) {
  const ts = [...favs.tracks].map(id => lib.byId.get(id)).filter(Boolean);
  const als = [...favs.albums].map(id => lib.albumById.get(id)).filter(Boolean);
  v.append(h('h1', null, 'Favoris'));
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
      h('button', { class: 'btn alt', onclick: () => { const n = prompt('Nouveau nom', p.name); if (n) { p.name = n.trim().slice(0, 80) || p.name; savePl(); render(); } } }, 'Renommer'),
      h('button', { class: 'btn alt', onclick: () => { if (confirm('Supprimer « ' + p.name + ' » ?')) { playlists = playlists.filter(x => x !== p); savePl(); back(); } } }, 'Supprimer')),
    h('div', { class: 'list' }, ts.map((t, i) => trackRow(t, ts, i, { album: true, playlist: p }))));
}
function newPlaylist(ids) {
  const n = prompt('Nom de la playlist'); if (!n) return;
  playlists.push({ id: 'pl' + Date.now().toString(36), name: n.trim().slice(0, 80), ids: [...ids] }); savePl();
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
    { label: fav ? 'Retirer des favoris' : 'Ajouter aux favoris', fn: () => { fav ? favs.tracks.delete(t.id) : favs.tracks.add(t.id); saveFavs(); render(); updatePlayer(); } },
    { label: 'Ajouter à une playlist…', fn: () => sheet('Ajouter à une playlist', [{ label: '+ Nouvelle playlist…', fn: () => newPlaylist([t.id]) },
      ...playlists.map(p => ({ label: p.name, fn: () => { if (!p.ids.includes(t.id)) p.ids.push(t.id); savePl(); toast('Ajouté à « ' + p.name + ' »'); } }))]) },
    { label: 'Clip vidéo…', fn: () => clipPicker(t) },
    !t.local ? { label: 'Aller à l\'album', fn: () => openPage({ album: t.albumId }) } : null,
    lib.artistByKey.has(fold(t.artist)) ? { label: 'Aller à l\'artiste', fn: () => openPage({ artist: fold(t.artist) }) } : null,
    pl ? { label: 'Retirer de la playlist', red: true, fn: () => { pl.ids = pl.ids.filter(x => x !== t.id); savePl(); render(); } } : null,
  ]);
}

// Hors ligne : titres gardés dans le stockage de l'appareil (lecture sans réseau).
async function keep(a) {
  const c = await cacheOpen('bp-offline'); if (!c) return toast('Stockage indisponible sur cet appareil.');
  let n = 0;
  toast('Copie de « ' + a.name + ' » sur l\'appareil…', 60000);
  for (const t of a.tracks) {
    try {
      if (!offline.has(t.id)) {
        const r = await drive('files/' + t.id, { alt: 'media' }, true);
        await c.put('https://bossplay.local/off/' + t.id, new Response(await r.blob()));
        offline.add(t.id); saveOff();
      }
      toast(`Copie : ${++n}/${a.tracks.length}`, 60000);
    } catch (e) { toast('Copie interrompue (' + e.message + ')'); render(); return; }
  }
  toast('« ' + a.name + ' » est disponible hors ligne'); render();
}
async function unkeep(a) {
  const c = await cacheOpen('bp-offline');
  for (const t of a.tracks) { offline.delete(t.id); if (c) await c.delete('https://bossplay.local/off/' + t.id); }
  saveOff(); toast('Retiré de l\'appareil'); render();
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
function updatePlayer() {
  const t = cur(); $('#mini').hidden = !t;
  if (!t) return;
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
const saveClips = () => store.set('clips', clipCache);
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
  clip.on = true; $('#clip').hidden = false; clipLayout(); wakeBar();
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
  clip.on = false; $('#clip').hidden = true; ytCmd('stopVideo'); clip.has = false;
  if (wasPlaying) audio.play().catch(() => { });
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
    audio.pause();
    $('#clip .nov').hidden = true; $('#yt').style.visibility = 'visible';
    const f = clip.yt.getIframe && clip.yt.getIframe(); if (f) f.style.visibility = 'visible';
    clip.yt.loadVideoById(info.chosen);
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
function shiftOffset(d) { const t = cur(); if (!t) return; const c = clipCache[t.id] || (clipCache[t.id] = { cands: [], offset: 0, date: Date.now() }); c.offset = Math.max(-60000, Math.min(60000, (c.offset || 0) + d)); saveClips(); toast('Décalage des paroles : ' + (c.offset / 1000).toFixed(1).replace('.', ',') + ' s', 1200); }
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
  v.append(h('h1', null, 'Réglages'),
    h('div', { class: 'card' }, h('h2', { style: 'margin-top:0' }, 'Google Drive'),
      h('div', { class: 'muted small' }, 'ID client OAuth (Application Web) de ton projet Google Cloud :'),
      h('div', { class: 'row', style: 'margin:6px 0 10px' }, id, h('button', { class: 'btn', onclick: () => { S.clientId = id.value.trim(); saveS(); tokenClient = null; toast('ID client enregistré'); render(); } }, 'Enregistrer')),
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
    const q = `'${id}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`;
    const j = await drive('files', { q, fields: 'files(id,name)', pageSize: 1000, orderBy: 'name', supportsAllDrives: true, includeItemsFromAllDrives: true });
    sheet(path.map(p => p[1]).join(' › '), [
      id !== 'root' ? { label: '✓ Utiliser ce dossier', fn: () => { S.rootId = id; S.rootName = path.slice(1).map(p => p[1]).join(' › '); saveS(); scan(); render(); } } : null,
      path.length > 1 ? { label: '‹ Dossier parent', fn: () => browse(path[path.length - 2][0], path.slice(0, -1)) } : null,
      ...(j.files || []).map(f => ({ label: '📁 ' + f.name, fn: () => browse(f.id, path.concat([[f.id, f.name]])) })),
    ]);
  } catch (e) { sheet('Google Drive', [h('div', { style: 'padding:0 12px' }, 'Lecture impossible : ' + e.message)]); }
}
function applyTheme() { document.documentElement.dataset.theme = S.theme; }

// ---------- Boutons ----------
document.querySelectorAll('#tabs button').forEach(b => b.onclick = () => go(b.dataset.tab));
$('#back').onclick = back;
$('#theme').onclick = () => { S.theme = { auto: 'dark', dark: 'light', light: 'auto' }[S.theme]; saveS(); applyTheme(); toast({ auto: 'Thème automatique', dark: 'Thème nuit', light: 'Thème jour' }[S.theme], 1200); };
$('#search').addEventListener('input', e => { ui.q = e.target.value; if (ui.tab === 'settings' || ui.tab === 'favs' || ui.tab === 'playlists') ui.tab = 'songs'; ui.stack = []; render(); });
$('#mini .meta').onclick = $('#mini .art').onclick = () => { $('#full').hidden = false; updatePlayer(); tick(); };
$('#mini .play').onclick = $('#full .play').onclick = toggle;
$('#mini .next').onclick = $('#full .next').onclick = () => next(true);
$('#mini .prev').onclick = $('#full .prev').onclick = prev;
$('#full .close').onclick = () => { $('#full').hidden = true; };
$('#full .shuffle').onclick = () => { P.shuffle = !P.shuffle; if (P.shuffle) shuffleRest(); updatePlayer(); };
$('#full .repeat').onclick = () => { P.repeat = (P.repeat + 1) % 3; updatePlayer(); };
$('#full .fav').onclick = () => { const t = cur(); if (!t) return; favs.tracks.has(t.id) ? favs.tracks.delete(t.id) : favs.tracks.add(t.id); saveFavs(); updatePlayer(); };
$('#full .more').onclick = () => { const t = cur(); if (t) trackMenu(t); };
$('#full .clip').onclick = openClip;
$('#full .lyr').onclick = () => {
  const box = $('#full .lyrics'), cov = $('#full .cover');
  const show = box.hidden; box.hidden = !show; cov.hidden = show; $('#full .lyr').classList.toggle('on', show);
  if (show) { box.dataset.for = ''; showLyrics(); }
};
$('#full .artist').onclick = () => { const t = cur(); if (t && lib.artistByKey.has(fold(t.artist))) { $('#full').hidden = true; openPage({ artist: fold(t.artist) }); } };
$('#full .album').onclick = () => { const t = cur(); if (t) { $('#full').hidden = true; openPage({ album: t.albumId }); } };
$('#full .seek').addEventListener('input', () => { tick.drag = true; });
$('#full .seek').addEventListener('change', e => { tick.drag = false; if (audio.duration) audio.currentTime = e.target.value / 1000 * audio.duration; });

// ---------- Démarrage ----------
(async function start() {
  applyTheme();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => { });
  for (const t of store.get('localIndex', [])) localTracks.push(Object.assign({}, t));
  const raw = await idb.get('library');
  if (raw && raw.rootId === S.rootId) buildLib(raw); else for (const t of localTracks) lib.byId.set(t.id, t);
  render(); banner();
  if (S.clientId) initAuth();
  if (S.rootId && hasToken() && !raw) scan();
})();
