// MishMusic as a web app: songs are fetched from the backend (through its tunnel) and kept on the phone in
// IndexedDB, so they play with no connection. The test log records when each song starts and whether the
// screen was off, to check that a locked phone keeps moving through the queue.

const $ = id => document.getElementById(id);
const audio = $('audio');

// ---- small helpers

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) node.append(c);
  return node;
}

const time = s => {
  if (!Number.isFinite(s)) return '0:00';
  s = Math.max(0, Math.round(s));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
const mb = bytes => `${(bytes / 1048576).toFixed(1)} MB`;

let toastTimer;
function toast(text) {
  let box = document.querySelector('.toast');
  if (!box) document.body.append(box = el('div', { class: 'toast' }));
  box.textContent = text;
  box.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => box.classList.remove('show'), 2500);
}

// ---- the songs on this phone (IndexedDB)

const db = new Promise((resolve, reject) => {
  const open = indexedDB.open('mishmusic', 1);
  open.onupgradeneeded = () => open.result.createObjectStore('songs', { keyPath: 'id' });
  open.onsuccess = () => resolve(open.result);
  open.onerror = () => reject(open.error);
});

async function store(mode, work) {
  const tx = (await db).transaction('songs', mode);
  const result = work(tx.objectStore('songs'));
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve(result.result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('Not saved (is the phone full?)'));
  });
}
const allSongs = () => store('readonly', s => s.getAll());
const putSong = song => store('readwrite', s => s.put(song));
const deleteSong = id => store('readwrite', s => s.delete(id));

let saved = []; // songs on this phone, newest first, without their blobs
async function loadSaved() {
  const songs = await allSongs();
  saved = songs.map(({ blob, ...song }) => ({ ...song, bytes: blob.size }))
    .sort((a, b) => String(b.savedAt).localeCompare(String(a.savedAt)));
}
const blobOf = async id => (await store('readonly', s => s.get(id)))?.blob;

// ---- the backend

const settings = {
  get key() { return localStorage.getItem('key') || ''; },
  set key(v) { localStorage.setItem('key', v.trim()); },
  get server() { return localStorage.getItem('server') || ''; },
  set server(v) { localStorage.setItem('server', v); },
};

/** The tunnel's current address, from url.txt next to the app (the backend's start script keeps it current). */
async function findServer() {
  try {
    const reply = await fetch('../url.txt', { cache: 'no-store' });
    const url = (await reply.text()).trim().replace(/\/$/, '');
    if (/^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/.test(url)) settings.server = url;
  } catch {}
  return settings.server;
}

async function api(path, options = {}) {
  const server = settings.server || await findServer();
  if (!server) throw new Error('No server address yet.');
  if (!settings.key) throw new Error('Put your key in Settings first.');
  let reply;
  try {
    reply = await fetch(server + path, { ...options, headers: { Authorization: `Bearer ${settings.key}`, ...(options.headers || {}) } });
  } catch {
    // The tunnel may have moved: look the address up again once.
    const again = await findServer();
    if (again === server) throw new Error("Can't reach your PC. Is the backend running?");
    reply = await fetch(again + path, { ...options, headers: { Authorization: `Bearer ${settings.key}` } });
  }
  if (!reply.ok) {
    let message = `${reply.status}`;
    try { message = (await reply.json()).error || message; } catch {}
    throw new Error(message);
  }
  return reply;
}

// ---- downloading to the phone

const downloading = new Map(); // id -> fraction done

async function saveSong(track) {
  if (downloading.has(track.id) || saved.some(s => s.id === track.id)) return;
  downloading.set(track.id, 0);
  render();
  try {
    const reply = await api(`/api/tracks/${track.id}/file`);
    const total = Number(reply.headers.get('Content-Length')) || track.size || 0;
    const reader = reply.body.getReader();
    const parts = [];
    let got = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
      got += value.length;
      if (total) { downloading.set(track.id, got / total); updateProgress(track.id); }
    }
    const blob = new Blob(parts, { type: 'audio/mpeg' });
    await putSong({ id: track.id, title: track.title, artist: track.artist, duration: track.duration, source: track.source, savedAt: new Date().toISOString(), blob });
    await loadSaved();
  } catch (e) {
    toast(`${track.title}: ${e.message}`);
  } finally {
    downloading.delete(track.id);
    render();
  }
}

function updateProgress(id) {
  const bar = document.querySelector(`[data-progress="${id}"]`);
  if (bar) bar.style.width = `${Math.round((downloading.get(id) || 0) * 100)}%`;
}

async function saveAll(tracks) {
  const todo = tracks.filter(t => !saved.some(s => s.id === t.id));
  // Two at a time: quicker than one, and gentle on the tunnel.
  let next = 0;
  const worker = async () => { while (next < todo.length) await saveSong(todo[next++]); };
  await Promise.all([worker(), worker()]);
}

// ---- playing

const player = { queue: [], index: -1, url: '' };
const current = () => player.queue[player.index];

async function playAt(index) {
  if (index < 0 || index >= player.queue.length) return;
  player.index = index;
  const song = current();
  const blob = await blobOf(song.id);
  if (!blob) { toast('That song is no longer on this phone.'); return; }
  if (player.url) URL.revokeObjectURL(player.url);
  player.url = URL.createObjectURL(blob);
  audio.src = player.url;
  try { await audio.play(); } catch (e) { log(`couldn't start ${song.title}: ${e.message}`); }
  log(`started ${song.title}`);
  setMediaSession(song);
  renderPlayer();
  if (tab === 'saved') render();
}

function playList(list, index) {
  player.queue = list.slice();
  playAt(index);
}

const next = () => player.index + 1 < player.queue.length ? playAt(player.index + 1) : (audio.pause(), renderPlayer());
const previous = () => audio.currentTime > 3 ? (audio.currentTime = 0) : playAt(Math.max(0, player.index - 1));
const toggle = () => audio.src ? (audio.paused ? audio.play() : audio.pause()) : saved.length && playList(saved, 0);

audio.addEventListener('ended', () => { log('ended'); next(); });
audio.addEventListener('play', renderPlayer);
audio.addEventListener('pause', renderPlayer);
audio.addEventListener('timeupdate', updateTime);
audio.addEventListener('error', () => log(`audio error ${audio.error?.code}`));

function setMediaSession(song) {
  if (!('mediaSession' in navigator)) return;
  navigator.mediaSession.metadata = new MediaMetadata({ title: song.title, artist: song.artist || '', album: 'MishMusic',
    artwork: [{ src: 'icon-512.png', sizes: '512x512', type: 'image/png' }] });
}
if ('mediaSession' in navigator) {
  const handlers = {
    play: () => audio.play(), pause: () => audio.pause(), nexttrack: next, previoustrack: previous,
    seekto: d => { audio.currentTime = d.seekTime; },
  };
  for (const [action, fn] of Object.entries(handlers)) {
    try { navigator.mediaSession.setActionHandler(action, fn); } catch {}
  }
}

// ---- the test log: kept across restarts, so after unlocking you can see what happened while locked

function log(text) {
  const lines = JSON.parse(localStorage.getItem('log') || '[]');
  const at = new Date().toLocaleTimeString();
  lines.push(`${at}  ${text}${document.visibilityState === 'hidden' ? '  (screen off / app hidden)' : ''}`);
  localStorage.setItem('log', JSON.stringify(lines.slice(-200)));
  if (tab === 'settings') render();
}
document.addEventListener('visibilitychange', () => log(document.visibilityState === 'hidden' ? 'app hidden' : 'app shown'));

// ---- pages

let tab = 'saved';
let serverTracks = null;
let serverError = '';

async function loadServer() {
  serverError = '';
  try {
    const reply = await api('/api/tracks');
    serverTracks = (await reply.json()).tracks.filter(t => t.status === 'ready');
  } catch (e) {
    serverError = e.message;
  }
  render();
}

function songRow(song, { onTap, action, playing }) {
  let progress = null;
  if (downloading.has(song.id)) {
    const fill = el('span', { 'data-progress': song.id });
    fill.style.width = `${Math.round(downloading.get(song.id) * 100)}%`; // through the style object: the policy blocks style attributes
    progress = el('span', { class: 'song-progress' }, fill);
  }
  return el('li', { class: `song${playing ? ' playing' : ''}` },
    el('button', { class: 'song-main', type: 'button', onclick: onTap },
      el('span', { class: 'song-title' }, song.title),
      el('span', { class: 'song-sub' }, [song.artist, time(song.duration)].filter(Boolean).join(' · '))),
    action,
    progress);
}

function savedPage() {
  if (!saved.length) return el('p', { class: 'empty' }, 'Nothing on this phone yet. Save songs from the Library tab.');
  const total = saved.reduce((n, s) => n + s.bytes, 0);
  return [
    el('div', { class: 'bar' },
      el('span', { class: 'muted' }, `${saved.length} songs · ${mb(total)}`),
      el('button', { class: 'pill', type: 'button', onclick: () => playList(saved, 0) }, 'Play all'),
      el('button', { class: 'pill', type: 'button', onclick: () => {
        const shuffled = saved.slice().sort(() => Math.random() - 0.5);
        playList(shuffled, 0);
      } }, 'Shuffle')),
    el('ul', { class: 'songs' }, saved.map((song, i) => songRow(song, {
      onTap: () => playList(saved, i),
      playing: current()?.id === song.id,
      action: el('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Remove from phone', onclick: async () => {
        if (!confirm(`Remove "${song.title}" from this phone?`)) return;
        await deleteSong(song.id);
        await loadSaved();
        render();
      } }, '✕'),
    }))),
  ];
}

function libraryPage() {
  if (serverTracks === null && !serverError) {
    loadServer();
    return el('p', { class: 'empty' }, 'Loading your library…');
  }
  const head = el('div', { class: 'bar' },
    el('span', { class: 'muted' }, serverError ? '' : `${serverTracks.length} songs on your PC`),
    el('button', { class: 'pill', type: 'button', onclick: () => { serverTracks = null; render(); } }, 'Refresh'),
    serverTracks?.length ? el('button', { class: 'pill', type: 'button', onclick: () => saveAll(serverTracks) }, 'Save all') : null);
  if (serverError) return [head, el('p', { class: 'empty error' }, serverError)];
  return [head, el('ul', { class: 'songs' }, serverTracks.map(t => {
    const have = saved.some(s => s.id === t.id);
    return songRow(t, {
      onTap: () => (have ? playList(saved, saved.findIndex(s => s.id === t.id)) : saveSong(t)),
      action: have ? el('span', { class: 'tick', 'aria-label': 'On this phone' }, '✓')
        : el('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Save to phone', onclick: () => saveSong(t) }, downloading.has(t.id) ? '…' : '↓'),
    });
  }))];
}

function settingsPage() {
  const key = el('input', { type: 'password', class: 'field', placeholder: 'Your MishMusic key', autocomplete: 'off', value: settings.key });
  const storage = el('p', { class: 'muted' }, '');
  if (navigator.storage?.estimate) {
    Promise.all([navigator.storage.estimate(), navigator.storage.persisted?.()]).then(([e, persisted]) => {
      storage.textContent = `Using ${mb(e.usage || 0)} of about ${mb(e.quota || 0)}. ${persisted ? 'Kept safe from clean-ups.' : 'Not yet marked as kept (iOS may ask, or decide by itself).'}`;
    });
  }
  const lines = JSON.parse(localStorage.getItem('log') || '[]');
  return [
    el('section', { class: 'card' },
      el('h2', {}, 'Key'),
      key,
      el('button', { class: 'pill', type: 'button', onclick: () => { settings.key = key.value; serverTracks = null; toast('Saved'); } }, 'Save key'),
      el('p', { class: 'muted' }, `Server: ${settings.server || 'not found yet'}`)),
    el('section', { class: 'card' }, el('h2', {}, 'Storage'), storage),
    el('section', { class: 'card' },
      el('h2', {}, 'Test log'),
      el('p', { class: 'muted' }, 'Start a few songs, lock the phone (Airplane Mode on), unlock later and check every song started while the screen was off.'),
      el('pre', { class: 'log' }, lines.slice().reverse().join('\n') || 'Empty.'),
      el('button', { class: 'pill', type: 'button', onclick: () => { localStorage.removeItem('log'); render(); } }, 'Clear log')),
  ];
}

const TABS = [['saved', 'On phone', savedPage], ['library', 'Library', libraryPage], ['settings', 'Settings', settingsPage]];

function render() {
  $('tabs').replaceChildren(...TABS.map(([id, label]) => el('button', { type: 'button', class: 'tab', 'aria-pressed': String(id === tab), onclick: () => { tab = id; render(); } }, label)));
  $('page').replaceChildren(...[TABS.find(t => t[0] === tab)[2]()].flat());
  renderNet();
}

function renderPlayer() {
  const song = current();
  if (!song) { $('player').replaceChildren(); document.body.classList.remove('has-player'); return; }
  document.body.classList.add('has-player');
  const seek = el('input', { type: 'range', class: 'seek', min: '0', max: String(song.duration || 1), step: '1', value: String(audio.currentTime || 0), 'aria-label': 'Position' });
  seek.addEventListener('input', () => { audio.currentTime = Number(seek.value); });
  $('player').replaceChildren(
    el('div', { class: 'now' }, el('div', { class: 'now-title' }, song.title), el('div', { class: 'now-sub' }, song.artist || '')),
    el('div', { class: 'controls' },
      el('button', { class: 'ctl', type: 'button', 'aria-label': 'Previous', onclick: previous }, '⏮'),
      el('button', { class: 'ctl main', type: 'button', 'aria-label': audio.paused ? 'Play' : 'Pause', onclick: toggle }, audio.paused ? '▶' : '⏸'),
      el('button', { class: 'ctl', type: 'button', 'aria-label': 'Next', onclick: next }, '⏭')),
    el('div', { class: 'times' }, el('span', { id: 'at' }, time(audio.currentTime)), seek, el('span', {}, time(song.duration || audio.duration))));
}

function updateTime() {
  const at = $('at');
  if (at) at.textContent = time(audio.currentTime);
  const seek = document.querySelector('.seek');
  if (seek && document.activeElement !== seek) seek.value = String(audio.currentTime);
}

function renderNet() {
  $('net').textContent = navigator.onLine ? '' : 'Offline';
}
addEventListener('online', renderNet);
addEventListener('offline', renderNet);

// ---- start

(async () => {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  navigator.storage?.persist?.().catch(() => {});
  await loadSaved();
  render();
  if (navigator.onLine) findServer();
})();
