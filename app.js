import { db } from './db.js';
import { preparePhoto, blobToDataURL, dataURLToBlob } from './images.js';
import { attachAutocomplete, matchScore } from './autocomplete.js';
import { YARN_LINES } from './yarn-catalog.js';
import { RUSTIC_PATTERNS, SHOP_URL } from './rustic-patterns.js';
import { parseCSV, toCSV, COLUMNS, mapHeadings, parseDate, parseNumber } from './csv.js';

const APP_VERSION = '1.4.1';
const HOME_URL = 'https://imadeit.rusticnastalje.com';
// Earlier addresses. Blankets saved there stay there, so the app explains how to bring them across.
const OLD_HOSTS = ['imadeit.afrikanerinamerika.com'];
const SIZES = ['Baby', 'Lap', 'Throw', 'Twin', 'Full', 'Queen', 'King', 'Other'];
const MAX_PATTERN_FILE = 30 * 1024 * 1024;

const state = {
  blankets: [],
  patterns: [],
  settings: { unit: 'in' },
  lastBackup: null,
  changesSinceBackup: 0,
  query: '',
  filter: 'all',
  backupBannerHidden: false,
};

const app = document.getElementById('app');
const photoURLs = new Map();
let installPrompt = null;
let unsavedChanges = false;
let patternFileURL = null;

// ---------- Small helpers ----------

const esc = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const uid = () =>
  crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2);

const pad = (n) => String(n).padStart(2, '0');

function today() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function parseDay(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function fmtDate(iso) {
  if (!iso) return '';
  return parseDay(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

// Counts both the start and finish day, the way makers talk about it ("took 5 days").
function daysTaken(b) {
  if (!b.started || !b.finished) return null;
  return Math.round((parseDay(b.finished) - parseDay(b.started)) / 86400000) + 1;
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const numberOrBlank = (v) => (v === '' || v == null || Number.isNaN(Number(v)) ? '' : Number(v));
const nameOf = (b) => (b.title && b.title.trim()) || `Blanket #${b.number}`;
const yearOf = (b) => (b.finished || b.started || b.createdAt || '').slice(0, 4) || 'Undated';
const has = (v) => v !== '' && v != null;
const num = (v) => Number(v) || 0;
const round = (n) => Math.round(num(n) * 100) / 100;
const usedOf = (b) => (b.yarns || []).reduce((n, y) => n + num(y.used), 0);
const plannedOf = (b) => (b.yarns || []).reduce((n, y) => n + num(y.planned), 0);
const emptyYarn = () => ({ brand: '', color: '', planned: '', used: '', log: [] });

// Version 1.0 stored one "skeins" number per yarn (it meant skeins used),
// and versions before 1.2 had a single "stitch" field that is now the pattern name.
function normalize(blanket) {
  const { stitch, ...b } = blanket;
  return {
    plannedWidth: '',
    plannedLength: '',
    patternId: '',
    patternSize: '',
    rowsDone: 0,
    ...b,
    patternName: b.patternName ?? stitch ?? '',
    yarns: (b.yarns || []).map((y) => ({
      brand: y.brand || '',
      color: y.color || '',
      planned: y.planned ?? '',
      used: y.used ?? y.skeins ?? '',
      log: Array.isArray(y.log) ? y.log : [],
    })),
  };
}
const unitLabel = () => (state.settings.unit === 'cm' ? 'cm' : 'in');

// Accepts "ravelry.com/patterns/..." as well as full links, but only ever web links.
function safeURL(text) {
  const t = (text || '').trim();
  if (!t) return '';
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(t) ? t : `https://${t}`);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : '';
  } catch {
    return '';
  }
}

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; }
}

function fileSize(bytes) {
  return bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

// Hands a file to the share sheet (Save to Files, Books, Mail…) or downloads it where sharing isn't available.
async function shareOrDownload(file, title) {
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title });
      return 'shared';
    } catch (err) {
      if (err.name === 'AbortError') return 'cancelled';
    }
  }
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url;
  a.download = file.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  return 'downloaded';
}

function readLocal(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function writeLocal(key, value) {
  try { localStorage.setItem(key, value); } catch { /* private mode: fine to forget */ }
}

function toast(message) {
  const el = document.getElementById('toast');
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.remove('show'), 2800);
}

const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const isIOS = () =>
  /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

const icon = {
  gear: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>',
  back: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 18l-6-6 6-6"/></svg>',
  next: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 18l6-6-6-6"/></svg>',
  plus: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
  camera: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>',
  search: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>',
  close: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 6L6 18M6 6l12 12"/></svg>',
  file: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M8 13h8M8 17h5"/></svg>',
  link: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/></svg>',
  external: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14L21 3"/></svg>',
  check: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 6L9 17l-5-5"/></svg>',
  book: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20V3H6.5A2.5 2.5 0 0 0 4 5.5z"/><path d="M4 19.5A2.5 2.5 0 0 0 6.5 22H20v-5"/></svg>',
  shield: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>',
};

const logo = `<svg class="logo" viewBox="0 0 512 512" aria-hidden="true"><rect width="512" height="512" rx="112" fill="var(--accent)"/>${
  [172, 258, 344].flatMap((y) => [156, 256, 356].map((x) =>
    `<ellipse cx="${x - 24}" cy="${y}" rx="21" ry="46" transform="rotate(-34 ${x - 24} ${y})" fill="#f6efe4"/><ellipse cx="${x + 24}" cy="${y}" rx="21" ry="46" transform="rotate(34 ${x + 24} ${y})" fill="#e7d3b8"/>`)).join('')
}</svg>`;

// ---------- Data ----------

async function load() {
  state.blankets = (await db.all('blankets')).map(normalize);
  state.patterns = await db.all('patterns');
  await movePatternsIntoLibrary();
  state.settings = { unit: 'in', ...((await db.getMeta('settings')) || {}) };
  state.lastBackup = (await db.getMeta('lastBackup')) || null;
  state.changesSinceBackup = (await db.getMeta('changesSinceBackup')) || 0;
}

// ---------- Pattern library ----------

const builtInPattern = (id) => RUSTIC_PATTERNS.find((p) => p.id === id);
const libraryPattern = (id) => state.patterns.find((p) => p.id === id);
const patternById = (id) => (id ? builtInPattern(id) || libraryPattern(id) : null);
const blanketsWithPattern = (id) => state.blankets.filter((b) => b.patternId === id);

function findPatternByName(name) {
  const key = (name || '').trim().toLowerCase();
  if (!key) return null;
  return RUSTIC_PATTERNS.find((p) => p.name.toLowerCase() === key)
    || state.patterns.find((p) => p.name.toLowerCase() === key)
    || null;
}

async function savePattern(pattern) {
  await db.put('patterns', pattern);
  const i = state.patterns.findIndex((x) => x.id === pattern.id);
  if (i >= 0) state.patterns[i] = pattern;
  else state.patterns.push(pattern);
  // Blankets show the pattern's current name in lists and search.
  for (const b of blanketsWithPattern(pattern.id)) {
    if (b.patternName !== pattern.name) await saveBlanket({ ...b, patternName: pattern.name }, { quiet: true });
  }
}

// Before 1.4 each blanket held its own pattern link and file. Those become library patterns,
// one per pattern name, and the blankets point at them.
async function movePatternsIntoLibrary() {
  const loose = state.blankets.filter((b) => !b.patternId && (b.patternName || b.patternUrl || b.patternFile));
  for (const b of loose) {
    const name = (b.patternName || b.patternFile?.name?.replace(/\.[a-z0-9]+$/i, '') || 'Pattern').trim();
    let pattern = findPatternByName(name);
    if (pattern && builtInPattern(pattern.id)) {
      if (b.patternFile) await db.remove('files', b.patternFile.id);
    } else if (pattern) {
      const changes = {};
      if (!pattern.url && b.patternUrl) changes.url = b.patternUrl;
      if (b.patternFile) {
        if (!pattern.file) changes.file = b.patternFile;
        // "Make another" used to copy the file for each blanket; keep only one.
        else if (pattern.file.id !== b.patternFile.id) await db.remove('files', b.patternFile.id);
      }
      if (Object.keys(changes).length) {
        pattern = { ...pattern, ...changes, updatedAt: new Date().toISOString() };
        await db.put('patterns', pattern);
        state.patterns = state.patterns.map((x) => (x.id === pattern.id ? pattern : x));
      }
    } else {
      const now = new Date().toISOString();
      pattern = { id: uid(), name, url: b.patternUrl || '', file: b.patternFile || null, notes: '', createdAt: now, updatedAt: now };
      await db.put('patterns', pattern);
      state.patterns.push(pattern);
    }
    const { patternUrl, patternFile, ...rest } = b;
    const moved = { ...rest, patternId: pattern.id, patternName: pattern.name };
    await db.put('blankets', moved);
    state.blankets = state.blankets.map((x) => (x.id === b.id ? moved : x));
  }
}

async function noteChange() {
  state.changesSinceBackup += 1;
  await db.setMeta('changesSinceBackup', state.changesSinceBackup);
}

// Asks the browser not to clear our storage when the phone runs low on space.
async function requestPersistence() {
  try {
    if (navigator.storage && navigator.storage.persist && !(await navigator.storage.persisted())) {
      await navigator.storage.persist();
    }
  } catch { /* not supported everywhere */ }
}

async function photoURL(id, kind = 'thumb') {
  const key = `${id}:${kind}`;
  if (photoURLs.has(key)) return photoURLs.get(key);
  const photo = await db.get('photos', id);
  if (!photo || !photo[kind]) return null;
  const url = URL.createObjectURL(photo[kind]);
  photoURLs.set(key, url);
  return url;
}

function forgetPhoto(id) {
  for (const kind of ['thumb', 'full']) {
    const key = `${id}:${kind}`;
    if (photoURLs.has(key)) {
      URL.revokeObjectURL(photoURLs.get(key));
      photoURLs.delete(key);
    }
  }
}

function hydratePhotos(root = app) {
  root.querySelectorAll('img[data-photo]').forEach(async (img) => {
    const url = await photoURL(img.dataset.photo, img.dataset.kind || 'thumb');
    if (url) img.src = url;
  });
}

function suggestions(pick) {
  const seen = new Map();
  for (const b of state.blankets) {
    for (const value of pick(b)) {
      const v = (value || '').trim();
      if (v && !seen.has(v.toLowerCase())) seen.set(v.toLowerCase(), v);
    }
  }
  return [...seen.values()].sort((a, b) => a.localeCompare(b));
}

const datalist = (id, values) => `<datalist id="${id}">${values.map((v) => `<option value="${esc(v)}">`).join('')}</datalist>`;

// ---------- Home: the blanket log ----------

function movingNotice() {
  if (!OLD_HOSTS.includes(location.hostname)) return '';
  return `<aside class="notice warm moving">
      <div><strong>ImadeIt has a new home</strong>
      <p>It now lives at <b>imadeit.rusticnastalje.com</b>. Your blankets don't move on their own, so bring them across:</p>
      <ol>
        <li>Save a backup here.</li>
        <li>Open the new address and add it to your Home Screen.</li>
        <li>In its Settings, tap <b>Restore from a backup</b> and pick that file.</li>
      </ol>
      <div class="moving-actions">
        <button class="btn small primary" data-action="backup">Save a backup</button>
        <a class="btn small ghost" href="${HOME_URL}" target="_blank" rel="noopener">Open the new address</a>
      </div></div>
    </aside>`;
}

function backupBanner() {
  if (state.backupBannerHidden || !state.blankets.length) return '';
  const daysSince = state.lastBackup ? Math.floor((Date.now() - new Date(state.lastBackup)) / 86400000) : null;
  const changes = state.changesSinceBackup;
  let message = '';
  if (daysSince === null && state.blankets.length >= 3) {
    message = `You have ${plural(state.blankets.length, 'blanket')} and no backup yet.`;
  } else if (changes >= 5) {
    message = `${plural(changes, 'change')} since your last backup.`;
  } else if (daysSince !== null && daysSince >= 30 && changes > 0) {
    message = `Your last backup was ${daysSince} days ago.`;
  }
  if (!message) return '';
  return `<aside class="notice warm">
      <div><strong>${message}</strong><p>A backup keeps your blankets safe if anything happens to this phone.</p>
      <button class="btn small primary" data-action="backup">Save a backup</button></div>
      <button class="close" data-dismiss="backup" aria-label="Hide for now">${icon.close}</button>
    </aside>`;
}

function installHint() {
  if (isStandalone() || readLocal('installHintDismissed')) return '';
  const how = isIOS()
    ? 'In Safari, tap <b>Share</b>, then <b>Add to Home Screen</b>.'
    : installPrompt
      ? '<button class="btn small primary" data-action="install">Install ImadeIt</button>'
      : 'Open your browser menu and choose <b>Install app</b> or <b>Add to Home screen</b>.';
  return `<aside class="notice">
      <div><strong>Make it an app on your phone</strong><p>${how}</p>
      <p class="fine">Tip: install it before you start logging. The Home Screen app keeps its own notebook, separate from the browser.</p></div>
      <button class="close" data-dismiss="install" aria-label="Hide">${icon.close}</button>
    </aside>`;
}

function renderHome() {
  const year = String(new Date().getFullYear());
  const total = state.blankets.length;
  const thisYear = state.blankets.filter((b) => yearOf(b) === year).length;
  const skeins = state.blankets.reduce((n, b) => n + usedOf(b), 0);
  const inProgress = state.blankets.filter((b) => !b.finished).length;

  app.innerHTML = `
    <header class="top">
      <div class="brand">${logo}<div><h1>ImadeIt</h1><p>by Rustic Nastalje</p></div></div>
      <div class="top-actions">
        <a class="icon-btn" href="#/patterns" aria-label="Patterns">${icon.book}</a>
        <a class="icon-btn" href="#/settings" aria-label="Settings and backups">${icon.gear}</a>
      </div>
    </header>
    ${movingNotice()}
    ${movingNotice() ? '' : backupBanner()}
    ${installHint()}
    ${total ? `
      <section class="stats" aria-label="Your totals">
        <div><strong>${total}</strong><span>${total === 1 ? 'blanket' : 'blankets'}</span></div>
        <div><strong>${thisYear}</strong><span>in ${year}</span></div>
        <div><strong>${Math.round(skeins * 10) / 10}</strong><span>skeins used</span></div>
      </section>
      <label class="search">${icon.search}
        <input type="search" id="search" placeholder="Search colour, yarn, pattern, notes…" value="${esc(state.query)}" autocomplete="off" enterkeyhint="search">
      </label>
      <div class="chips" role="group" aria-label="Show">
        ${[['all', 'All'], ['progress', `In progress${inProgress ? ` · ${inProgress}` : ''}`], ['done', 'Finished']]
          .map(([key, label]) => `<button class="chip${state.filter === key ? ' on' : ''}" data-filter="${key}" aria-pressed="${state.filter === key}">${label}</button>`).join('')}
      </div>
      <div id="results"></div>` : `
      <section class="empty">
        <div class="empty-art">${logo}</div>
        <h2>Your first blanket starts here</h2>
        <p>Snap a photo, jot down the yarn and pattern, and you'll never have to wonder “how did I make that one?” again.</p>
        <a class="btn primary" href="#/new">${icon.plus} Log a blanket</a>
      </section>`}
    ${total ? `<a class="fab" href="#/new">${icon.plus}<span>New blanket</span></a>` : ''}`;

  if (total) {
    const search = document.getElementById('search');
    search.addEventListener('input', () => {
      state.query = search.value;
      renderResults();
    });
    app.querySelectorAll('[data-filter]').forEach((chip) =>
      chip.addEventListener('click', () => {
        state.filter = chip.dataset.filter;
        app.querySelectorAll('[data-filter]').forEach((c) => {
          c.classList.toggle('on', c === chip);
          c.setAttribute('aria-pressed', c === chip);
        });
        renderResults();
      }));
    renderResults();
  }
  wireNotices();
}

function wireNotices() {
  app.querySelectorAll('[data-dismiss]').forEach((btn) =>
    btn.addEventListener('click', () => {
      if (btn.dataset.dismiss === 'install') writeLocal('installHintDismissed', '1');
      else state.backupBannerHidden = true;
      btn.closest('.notice').remove();
    }));
  app.querySelector('[data-action="backup"]')?.addEventListener('click', exportBackup);
  app.querySelector('[data-action="install"]')?.addEventListener('click', async () => {
    if (!installPrompt) return;
    installPrompt.prompt();
    await installPrompt.userChoice;
    installPrompt = null;
    route();
  });
}

function matches(b, terms) {
  const haystack = [
    b.number, `#${b.number}`, b.title, b.patternName, b.size, b.notes, b.started, b.finished,
    ...(b.yarns || []).flatMap((y) => [y.brand, y.color]),
  ].join(' ').toLowerCase();
  return terms.every((t) => haystack.includes(t));
}

function renderResults() {
  const results = document.getElementById('results');
  const terms = state.query.toLowerCase().split(/\s+/).filter(Boolean);
  const list = state.blankets.filter((b) =>
    (state.filter === 'all' || (state.filter === 'done' ? b.finished : !b.finished)) && matches(b, terms));

  if (!list.length) {
    results.innerHTML = `<p class="none">${terms.length ? `No blankets match “${esc(state.query)}”.` : 'Nothing here yet.'}</p>`;
    return;
  }

  const byYear = new Map();
  for (const b of list) {
    const y = yearOf(b);
    if (!byYear.has(y)) byYear.set(y, []);
    byYear.get(y).push(b);
  }
  const years = [...byYear.keys()].sort((a, b) => b.localeCompare(a));

  results.innerHTML = years.map((y) => {
    const items = byYear.get(y).sort((a, b) => (Number(b.number) || 0) - (Number(a.number) || 0));
    return `<section class="year">
        <h2>${esc(y)} <span>${plural(items.length, 'blanket')}</span></h2>
        <div class="grid">${items.map(card).join('')}</div>
      </section>`;
  }).join('');
  hydratePhotos(results);
}

function card(b) {
  const cover = b.photos && b.photos[0];
  const detail = [b.patternName, b.size].filter(Boolean).join(' · ');
  const planned = plannedOf(b);
  const when = b.finished
    ? fmtDate(b.finished)
    : planned
      ? `Skein ${round(usedOf(b))} of ${round(planned)}`
      : b.started ? `Started ${fmtDate(b.started)}` : '';
  return `<a class="card" href="#/b/${b.id}">
      <div class="thumb">
        ${cover ? `<img data-photo="${cover}" alt="">` : '<div class="knit"></div>'}
        <span class="num">#${esc(b.number)}</span>
        ${b.finished ? '' : '<span class="badge">In progress</span>'}
      </div>
      <div class="card-body">
        <h3>${esc(nameOf(b))}</h3>
        ${detail ? `<p>${esc(detail)}</p>` : ''}
        ${when ? `<p class="muted">${esc(when)}</p>` : ''}
      </div>
    </a>`;
}

// ---------- One blanket ----------

// Yarn colour names that browsers don't know, so "Dusty Sage" still gets a sage swatch.
const YARN_COLORS = {
  cream: '#f1e6cf', oatmeal: '#dccbb0', oat: '#dccbb0', sand: '#d8c3a0', latte: '#c4a484', mocha: '#8a6a55',
  taupe: '#a39382', sage: '#9caf88', blush: '#e8c4c4', 'dusty rose': '#d3a1a1', rose: '#d99a9a', mauve: '#b58da0',
  mustard: '#d4a537', rust: '#b5562f', terracotta: '#c0673f', burgundy: '#7a2335', forest: '#3f5e3a',
  denim: '#5b7896', charcoal: '#3f3f45', espresso: '#4a3426', camel: '#c19a6b', blue: '#6f8fb5', lilac: '#c3b1d6',
  lavender: '#b9a7d6', mint: '#bfe0cc', khaki: '#b9a77f', teal: '#3f8f8b', navy: '#2f3d5c',
  green: '#6f9a5e', red: '#b3443a', pink: '#eaa9b6', purple: '#8a6aa8', yellow: '#e8c95a', orange: '#e08a3c',
  brown: '#7a5a43', tan: '#c8a97e', ivory: '#f6f0dc', white: '#f7f4ee', black: '#2b2b2b', grey: '#9a9a9a', gray: '#9a9a9a',
};

function swatchColor(name) {
  const text = (name || '').trim().toLowerCase();
  if (!text) return '';
  if (YARN_COLORS[text]) return YARN_COLORS[text];
  const compact = text.replace(/\s+/g, '');
  if (window.CSS && CSS.supports('color', compact)) return compact;
  // Yarn words first, in the order they're written, so "Sage Green" is sage rather than plain green.
  const words = text.split(/[\s/&,-]+/).filter(Boolean);
  for (const w of words) if (YARN_COLORS[w]) return YARN_COLORS[w];
  for (const w of words) if (/^[a-z]+$/.test(w) && window.CSS && CSS.supports('color', w)) return w;
  return '';
}

const swatch = (y) => {
  const color = swatchFill(y.color);
  return `<span class="swatch"${color ? ` style="--swatch:${color}"` : ''}></span>`;
};

const yarnName = (y) =>
  `<div class="yarn-name"><strong>${esc(y.color || y.brand || 'Yarn')}</strong>${y.color && y.brand ? `<span>${esc(y.brand)}</span>` : ''}</div>`;

function dimsText(w, l) {
  return has(w) || has(l) ? `${has(w) ? round(w) : '?'} × ${has(l) ? round(l) : '?'} ${unitLabel()}` : '';
}

function sizeDiff(b) {
  const unit = unitLabel();
  const parts = [];
  let compared = false;
  if (has(b.width) && has(b.plannedWidth)) {
    compared = true;
    const d = round(num(b.width) - num(b.plannedWidth));
    if (d) parts.push(`${Math.abs(d)} ${unit} ${d > 0 ? 'wider' : 'narrower'}`);
  }
  if (has(b.length) && has(b.plannedLength)) {
    compared = true;
    const d = round(num(b.length) - num(b.plannedLength));
    if (d) parts.push(`${Math.abs(d)} ${unit} ${d > 0 ? 'longer' : 'shorter'}`);
  }
  if (!compared) return '';
  return parts.length ? `${parts.join(' and ')} than planned` : 'Exactly the size you planned';
}

function skeinDiff(used, planned) {
  const d = round(used - planned);
  if (!d) return 'right on plan';
  return d > 0 ? `${d} more than planned` : `${Math.abs(d)} fewer than planned`;
}

// Mixed and tie-dye colours ("Forest & Sage & Mint") get a swatch split into each colour.
function swatchFill(name) {
  const parts = (name || '').split(/\s*[&/]\s*/).filter(Boolean);
  const colors = parts.length > 1 ? parts.map(swatchColor).filter(Boolean) : [];
  if (colors.length > 1) {
    const step = 360 / colors.length;
    return `conic-gradient(${colors.map((c, i) => `${c} ${i * step}deg ${(i + 1) * step}deg`).join(', ')})`;
  }
  return swatchColor(name);
}

function renderDetail(id) {
  const b = state.blankets.find((x) => x.id === id);
  if (!b) return renderMissing();

  const days = daysTaken(b);
  const dayNumber = !b.finished && b.started && b.started <= today() ? daysTaken({ started: b.started, finished: today() }) : null;
  const facts = [
    ['Started', fmtDate(b.started)],
    ['Finished', b.finished ? fmtDate(b.finished) : 'Still in progress'],
    ['Took', days ? plural(days, 'day') : ''],
    ['Size', b.size],
    ['Stitches wide', b.stitchesWide],
    ['Rows', b.rows],
  ].filter(([, v]) => has(v));

  const yarns = b.yarns || [];
  const used = usedOf(b);
  const planned = plannedOf(b);
  const plannedDims = dimsText(b.plannedWidth, b.plannedLength);
  const finalDims = dimsText(b.width, b.length);

  // While knitting: one big button per yarn to count skeins as they're joined.
  const tracker = b.finished ? '' : `
    <section class="tracker">
      <div class="tracker-head"><h3>Skein tracker</h3>${dayNumber ? `<span>Day ${dayNumber}</span>` : ''}</div>
      ${yarns.length ? `
        <p class="fine">Tap <b>New skein</b> each time you join one. ImadeIt keeps count so you don't have to.</p>
        ${yarns.map((y, i) => {
          const u = num(y.used);
          const p = num(y.planned);
          const over = p && u > p;
          return `<div class="skein${over ? ' over' : ''}">
            <div class="skein-top">${swatch(y)}${yarnName(y)}
              <div class="skein-count"><b>${round(u)}</b>${p ? `<span>of ${round(p)}</span>` : ''}</div>
            </div>
            ${p ? `<div class="meter" role="img" aria-label="${round(u)} of ${round(p)} skeins"><span style="width:${Math.min(100, (u / p) * 100)}%"></span></div>` : ''}
            <div class="skein-actions">
              <button class="btn primary small" data-skein="${i}">${icon.plus} New skein</button>
              ${u > 0 ? `<button class="link" data-undo="${i}">Undo</button>` : ''}
              <span class="skein-note">${p ? (over ? `${round(u - p)} over plan` : `${round(p - u)} left in plan`) : ''}</span>
            </div>
          </div>`;
        }).join('')}
        <a class="link" href="#/edit/${b.id}">Using a yarn you didn't plan? Add it</a>`
      : `<p class="fine">Add the yarn you plan to use, and how many skeins of each, to count skeins as you go.</p>
        <a class="btn ghost small" href="#/edit/${b.id}">${icon.plus} Add planned yarn</a>`}
    </section>
    <a class="btn sage block finish-btn" href="#/finish/${b.id}">I finished it!</a>`;

  // Once finished: how the result compares with the plan.
  const sizeSection = plannedDims && finalDims ? `
      <h3>Size</h3>
      <div class="compare">
        <div><span>Planned</span><b>${esc(plannedDims)}</b></div>
        <div><span>Finished</span><b>${esc(finalDims)}</b></div>
        ${sizeDiff(b) ? `<p>${esc(sizeDiff(b))}</p>` : ''}
      </div>`
    : plannedDims || finalDims ? `
      <h3>Size</h3>
      <div class="compare single">
        <div><span>${finalDims ? 'Finished' : 'Planned'}</span><b>${esc(finalDims || plannedDims)}</b></div>
      </div>` : '';

  const yarnSection = b.finished && yarns.length ? `
      <h3>Yarn <span>${used ? `${plural(round(used), 'skein')} used` : ''}${used && planned ? ` · ${skeinDiff(used, planned)}` : !used && planned ? `${plural(round(planned), 'skein')} planned` : ''}</span></h3>
      <ul class="yarns">${yarns.map((y) => {
        const u = num(y.used);
        const p = num(y.planned);
        return `<li>${swatch(y)}${yarnName(y)}
          <div class="yarn-used">${has(y.used) ? `<b>${plural(round(u), 'skein')}</b>` : ''}
          ${p ? `<span>${has(y.used) ? `planned ${round(p)}` : `${round(p)} planned`}</span>` : ''}</div></li>`;
      }).join('')}</ul>` : '';

  const pattern = patternById(b.patternId);
  const builtIn = builtInPattern(b.patternId);
  const patternSection = builtIn ? `
      <h3>Pattern</h3>
      <div class="pattern">
        <a class="pattern-row" href="#/rn/${builtIn.id}">
          ${icon.book}<span><strong>${esc(builtIn.name)}</strong><small>Free pattern by ${esc(builtIn.designer)}${b.patternSize ? ` · ${esc(b.patternSize)}` : ''}</small></span>${icon.next}</a>
      </div>`
    : pattern ? `
      <h3>Pattern</h3>
      <div class="pattern">
        <a class="pattern-row" href="#/p/${pattern.id}">
          ${icon.book}<span><strong>${esc(pattern.name)}</strong><small>${plural(blanketsWithPattern(pattern.id).length, 'blanket')} made with it</small></span>${icon.next}</a>
        ${patternLinkRow(pattern)}
        ${patternFileRow(pattern)}
      </div>`
    : b.patternName ? `<h3>Pattern</h3><div class="pattern"><p class="pattern-name">${esc(b.patternName)}</p></div>` : '';

  // While knitting: count rows, with the pattern's own instructions when it's a built-in pattern.
  const totalRows = num(b.rows);
  const rowsDone = Math.min(num(b.rowsDone), totalRows);
  const nextRow = rowsDone + 1;
  const rowCounter = !b.finished && totalRows ? `
    <section class="tracker">
      <div class="tracker-head"><h3>Row counter</h3><span>${rowsDone >= totalRows ? 'All rows done' : `Row ${nextRow} of ${totalRows}`}</span></div>
      ${rowsDone < totalRows ? `
        ${builtIn ? `<p class="row-step"><b>Row ${nextRow}:</b> ${esc(builtIn.row(nextRow, totalRows))}</p>` : ''}
        <div class="meter" role="img" aria-label="${rowsDone} of ${totalRows} rows done"><span style="width:${(rowsDone / totalRows) * 100}%"></span></div>
        <div class="skein-actions">
          <button class="btn primary small" id="row-done">${icon.check} Done row ${nextRow}</button>
          ${rowsDone > 0 ? '<button class="link" id="row-undo">Undo</button>' : ''}
          <span class="skein-note">${plural(totalRows - rowsDone, 'row')} to go</span>
        </div>`
      : `<p class="fine">Every row is done.${builtIn ? ` Next: <a href="#/rn/${builtIn.id}">end your blanket</a> with the braided edge.` : ' Time to finish the edge.'}</p>
        <button class="link" id="row-undo">Undo last row</button>`}
    </section>` : '';

  const diary = yarns.flatMap((y) => (y.log || []).map((t, k) => ({ t, y, n: k + 1 })))
    .sort((a, b2) => b2.t.localeCompare(a.t));
  const diarySection = diary.length ? `
      <details class="diary">
        <summary>Skein diary <span>${plural(diary.length, 'skein')} logged</span></summary>
        <ol>${diary.map(({ t, y, n }) => `<li>${swatch(y)}<span>${esc(y.color || y.brand || 'Yarn')}, skein ${n}</span>
          <time datetime="${t}">${new Date(t).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</time></li>`).join('')}</ol>
      </details>` : '';

  app.innerHTML = `
    <header class="bar">
      <a class="icon-btn" href="#/" aria-label="Back to all blankets">${icon.back}</a>
      <span class="bar-title">#${esc(b.number)}</span>
      <a class="text-btn" href="#/edit/${b.id}">Edit</a>
    </header>
    ${b.photos && b.photos.length ? `<div class="gallery${b.photos.length === 1 ? ' single' : ''}">
      ${b.photos.map((p, i) => `<button class="shot" data-open="${p}" aria-label="View photo ${i + 1} larger"><img data-photo="${p}" data-kind="full" alt="Photo ${i + 1} of ${esc(nameOf(b))}"></button>`).join('')}
    </div>` : ''}
    <article class="detail">
      <p class="eyebrow">Blanket #${esc(b.number)} · ${esc(yearOf(b))}</p>
      <h2>${esc(nameOf(b))}</h2>
      ${rowCounter}
      ${tracker}
      ${facts.length ? `<dl class="facts">${facts.map(([k, v]) => `<div><dt>${k}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>` : ''}
      ${patternSection}
      ${sizeSection}
      ${yarnSection}
      ${diarySection}
      ${b.notes ? `<h3>Notes</h3><p class="notes">${esc(b.notes)}</p>` : ''}
      <div class="actions">
        <a class="btn ghost block" href="#/again/${b.id}">Make another like this</a>
        <button class="btn danger block" id="delete">Delete this blanket</button>
      </div>
    </article>`;

  hydratePhotos();
  app.querySelectorAll('[data-open]').forEach((btn) => btn.addEventListener('click', () => openPhoto(btn.dataset.open)));
  if (pattern?.file) preparePatternFile(pattern.file);

  const setRows = async (n, message) => {
    await saveBlanket({ ...b, rowsDone: Math.max(0, Math.min(totalRows, n)), updatedAt: new Date().toISOString() });
    if (message) toast(message);
    renderDetail(id);
  };
  document.getElementById('row-done')?.addEventListener('click', () => {
    if (navigator.vibrate) navigator.vibrate(15);
    setRows(rowsDone + 1, nextRow === totalRows ? 'Last row done!' : `Row ${nextRow} done`);
  });
  document.getElementById('row-undo')?.addEventListener('click', () => setRows(rowsDone - 1, `Back to row ${rowsDone}`));

  const updateYarn = async (i, change, message) => {
    const updatedYarns = yarns.map((y, k) => (k === i ? change({ ...y, log: [...(y.log || [])] }) : y));
    await saveBlanket({ ...b, yarns: updatedYarns, updatedAt: new Date().toISOString() });
    toast(message(updatedYarns[i]));
    renderDetail(id);
  };
  app.querySelectorAll('[data-skein]').forEach((btn) =>
    btn.addEventListener('click', () => {
      if (navigator.vibrate) navigator.vibrate(15);
      updateYarn(Number(btn.dataset.skein), (y) => {
        y.used = round(num(y.used) + 1);
        y.log.push(new Date().toISOString());
        return y;
      }, (y) => `${y.color || y.brand || 'Yarn'}: skein ${y.used} started`);
    }));
  app.querySelectorAll('[data-undo]').forEach((btn) =>
    btn.addEventListener('click', () =>
      updateYarn(Number(btn.dataset.undo), (y) => {
        y.used = round(Math.max(0, num(y.used) - 1));
        y.log.pop();
        return y;
      }, (y) => `Undone. ${y.color || y.brand || 'Yarn'} is back to ${plural(y.used, 'skein')}`)));

  document.getElementById('delete').addEventListener('click', async () => {
    if (!confirm(`Delete “${nameOf(b)}”? This can't be undone.`)) return;
    for (const p of b.photos || []) {
      await db.remove('photos', p);
      forgetPhoto(p);
    }
    await db.remove('blankets', b.id);
    state.blankets = state.blankets.filter((x) => x.id !== b.id);
    await noteChange();
    toast('Blanket deleted');
    location.hash = '#/';
  });
}

function patternLinkRow(pattern) {
  return pattern.url ? `<a class="pattern-row" href="${esc(pattern.url)}" target="_blank" rel="noopener noreferrer">
      ${icon.link}<span><strong>Open pattern link</strong><small>${esc(hostOf(pattern.url))}</small></span>${icon.external}</a>` : '';
}

function patternFileRow(pattern) {
  return pattern.file ? `<div class="pattern-row">
      ${icon.file}<span><strong>${esc(pattern.file.name)}</strong><small>${fileSize(pattern.file.size)}</small></span>
      <a class="btn small primary" id="pattern-open" target="_blank" rel="noopener">Open</a>
      <button class="btn small ghost" id="pattern-save">Save</button></div>` : '';
}

// Phones only open or share a file straight from a tap, so the file is loaded before it's tapped.
async function preparePatternFile(meta) {
  if (patternFileURL) URL.revokeObjectURL(patternFileURL);
  patternFileURL = null;
  const record = await db.get('files', meta.id);
  const openLink = document.getElementById('pattern-open');
  const saveButton = document.getElementById('pattern-save');
  if (!openLink || !saveButton) return;
  if (!record) {
    openLink.replaceWith(Object.assign(document.createElement('span'), { className: 'fine', textContent: 'File missing' }));
    saveButton.remove();
    return;
  }
  const file = new File([record.blob], meta.name, { type: meta.type || record.blob.type });
  patternFileURL = URL.createObjectURL(file);
  openLink.href = patternFileURL;
  if (file.type.startsWith('image/')) {
    openLink.addEventListener('click', (e) => {
      e.preventDefault();
      showLightbox(patternFileURL);
    });
  }
  saveButton.addEventListener('click', () => shareOrDownload(file, meta.name));
}

// ---------- Finishing: measure and count ----------

function renderFinish(id) {
  const b = state.blankets.find((x) => x.id === id);
  if (!b) return renderMissing();
  const unit = unitLabel();
  const yarns = b.yarns || [];
  const plannedDims = dimsText(b.plannedWidth, b.plannedLength);

  app.innerHTML = `
    <header class="bar">
      <a class="icon-btn" href="#/b/${b.id}" aria-label="Back">${icon.back}</a>
      <span class="bar-title">Finish #${esc(b.number)}</span>
      <span></span>
    </header>
    <form id="finish-form" class="form" novalidate>
      <section class="group celebrate">
        <h3>Off your arms! Well done.</h3>
        <p class="hint">Two quick things to record before it goes: how big it came out and how many skeins it took.</p>
        <label class="field"><span>Finished on</span><input name="finished" type="date" value="${esc(b.finished || today())}"></label>
      </section>

      <section class="group">
        <h3>Finished size</h3>
        <p class="hint group-hint">Lay it flat and measure.${plannedDims ? ` You planned <b>${esc(plannedDims)}</b>.` : ''}</p>
        <div class="dims">
          <label class="field"><span>Width (${unit})</span>
            <input name="width" type="number" inputmode="decimal" step="any" min="0" value="${esc(b.width)}" placeholder="${has(b.plannedWidth) ? esc(b.plannedWidth) : ''}"></label>
          <span class="times">×</span>
          <label class="field"><span>Length (${unit})</span>
            <input name="length" type="number" inputmode="decimal" step="any" min="0" value="${esc(b.length)}" placeholder="${has(b.plannedLength) ? esc(b.plannedLength) : ''}"></label>
        </div>
      </section>

      ${yarns.length ? `
      <section class="group">
        <h3>Skeins used</h3>
        <p class="hint group-hint">This is the count from your skein tracker. Some left on the last skein? Type 5.5 for half a skein left over.</p>
        ${yarns.map((y, i) => `
          <div class="used-row">${swatch(y)}${yarnName(y)}
            <label class="field"><span>${has(y.planned) ? `Planned ${round(y.planned)}` : 'Used'}</span>
              <input data-used="${i}" type="number" inputmode="decimal" step="any" min="0" value="${esc(y.used)}" aria-label="Skeins of ${esc(y.color || y.brand || 'yarn')} used"></label>
          </div>`).join('')}
      </section>` : ''}

      <div class="save-bar"><button type="submit" class="btn primary block" id="save">Save finished blanket</button></div>
    </form>`;

  const form = document.getElementById('finish-form');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const data = new FormData(form);
    const finished = data.get('finished') || today();
    if (b.started && finished < b.started) {
      toast('The finish date is before the start date.');
      return;
    }
    const updatedYarns = yarns.map((y, i) => ({ ...y, used: numberOrBlank(form.querySelector(`[data-used="${i}"]`).value) }));
    await saveBlanket({
      ...b,
      finished,
      width: numberOrBlank(data.get('width')),
      length: numberOrBlank(data.get('length')),
      yarns: updatedYarns,
      updatedAt: new Date().toISOString(),
    });
    toast('Finished! Well done.');
    location.hash = `#/b/${b.id}`;
  });
}

async function openPhoto(id) {
  const url = await photoURL(id, 'full');
  if (url) showLightbox(url);
}

function showLightbox(url) {
  const box = document.createElement('div');
  box.className = 'lightbox';
  box.innerHTML = `<img src="${url}" alt=""><button class="close" aria-label="Close">${icon.close}</button>`;
  box.addEventListener('click', () => box.remove());
  document.body.appendChild(box);
}

async function saveBlanket(b, { quiet = false } = {}) {
  await db.put('blankets', b);
  const i = state.blankets.findIndex((x) => x.id === b.id);
  if (i >= 0) state.blankets[i] = b;
  else state.blankets.push(b);
  if (!quiet) await noteChange();
  requestPersistence();
}

function renderMissing() {
  app.innerHTML = `
    <header class="bar"><a class="icon-btn" href="#/" aria-label="Back">${icon.back}</a><span class="bar-title"></span><span></span></header>
    <section class="empty"><h2>That blanket isn't here</h2><p>It may have been deleted.</p><a class="btn primary" href="#/">Back to my blankets</a></section>`;
}

// ---------- Yarn suggestions ----------

// Brands and colours already used in this notebook, so anything typed once is offered again.
function yarnHistory() {
  const brands = new Map();
  const colorsByBrand = new Map();
  const allColors = new Map();
  for (const b of state.blankets) {
    for (const y of b.yarns || []) {
      const brand = (y.brand || '').trim();
      const color = (y.color || '').trim();
      if (brand) brands.set(brand.toLowerCase(), brand);
      if (color) {
        allColors.set(color.toLowerCase(), color);
        const key = brand.toLowerCase();
        if (!colorsByBrand.has(key)) colorsByBrand.set(key, new Map());
        colorsByBrand.get(key).set(color.toLowerCase(), color);
      }
    }
  }
  return { brands, colorsByBrand, allColors };
}

// "Bernat Blanket" finds that line; plain "Bernat" finds every Bernat line.
function catalogLinesFor(brand) {
  const q = brand.trim().toLowerCase();
  if (!q) return [];
  const exact = YARN_LINES.filter((l) => l.display.toLowerCase() === q);
  return exact.length ? exact : YARN_LINES.filter((l) => l.brand.toLowerCase() === q);
}

function rankOptions(options, query, limit) {
  return options
    .map((o) => ({ ...o, score: matchScore(o.value, query) }))
    .filter((o) => o.score > 0)
    .sort((a, b) => b.score - a.score || Number(Boolean(b.mine)) - Number(Boolean(a.mine)) || a.value.localeCompare(b.value))
    .slice(0, limit);
}

function brandOptions(query) {
  const options = new Map();
  for (const value of yarnHistory().brands.values()) options.set(value.toLowerCase(), { value, mine: true });
  for (const line of YARN_LINES) {
    const key = line.display.toLowerCase();
    if (!options.has(key)) options.set(key, { value: line.display, note: line.weight });
  }
  return rankOptions([...options.values()], query, query.trim() ? 8 : 60);
}

function colorOptions(brand, query) {
  const history = yarnHistory();
  const options = new Map();
  const mine = brand.trim()
    ? history.colorsByBrand.get(brand.trim().toLowerCase()) || new Map()
    : history.allColors;
  for (const value of mine.values()) options.set(value.toLowerCase(), { value, mine: true });
  for (const line of catalogLinesFor(brand)) {
    for (const value of line.colors) {
      if (!options.has(value.toLowerCase())) options.set(value.toLowerCase(), { value });
    }
  }
  // An unknown brand still gets the colours used with any brand before.
  if (!options.size) for (const value of history.allColors.values()) options.set(value.toLowerCase(), { value, mine: true });
  return rankOptions([...options.values()], query, query.trim() ? 10 : 200);
}

function swatchElement(name) {
  const el = document.createElement('span');
  el.className = 'swatch';
  const color = swatchFill(name);
  if (color) el.style.setProperty('--swatch', color);
  return el;
}

// ---------- Add / edit ----------

// preset fills a new blanket from a pattern: { patternId, patternSize, size, plannedWidth, plannedLength, stitchesWide, rows }.
function renderForm(id, copyFromId, preset = null) {
  const existing = id ? state.blankets.find((x) => x.id === id) : null;
  if (id && !existing) return renderMissing();
  const source = copyFromId ? state.blankets.find((x) => x.id === copyFromId) : null;
  const nextNumber = state.blankets.reduce((max, b) => Math.max(max, Number(b.number) || 0), 0) + 1;
  const now = new Date().toISOString();

  // "Make another like this" turns what the old blanket actually came out as into the new plan.
  // Photos, dates, notes and skein counts start fresh.
  const b = existing
    ? JSON.parse(JSON.stringify(existing))
    : {
        id: uid(), number: nextNumber, title: source ? source.title : '', started: today(), finished: '',
        size: source?.size || '',
        plannedWidth: source ? (has(source.width) ? source.width : source.plannedWidth) : '',
        plannedLength: source ? (has(source.length) ? source.length : source.plannedLength) : '',
        width: '', length: '',
        stitchesWide: source?.stitchesWide ?? '', rows: source?.rows ?? '',
        patternId: source?.patternId || '', patternName: source?.patternName || '', patternSize: source?.patternSize || '', rowsDone: 0,
        yarns: (source?.yarns || []).map((y) => ({
          ...emptyYarn(), brand: y.brand, color: y.color, planned: num(y.used) ? y.used : y.planned,
        })),
        notes: '', photos: [], createdAt: now,
      };
  if (preset && !existing) {
    const p = patternById(preset.patternId);
    Object.assign(b, preset, { patternName: p ? p.name : '' });
    if (!b.title && p) b.title = preset.patternSize ? `${p.name} (${preset.patternSize})` : p.name;
  }
  if (!b.yarns.length) b.yarns.push(emptyYarn());
  // Each yarn row keeps its skein diary while the form is open, even if rows are added or removed.
  b.yarns = b.yarns.map((y) => ({ ...y, key: uid() }));
  const yarnLogs = new Map(b.yarns.map((y) => [y.key, y.log || []]));

  let photos = (b.photos || []).map((pid) => ({ id: pid }));
  unsavedChanges = false;
  const heading = existing ? `Edit #${b.number}` : source ? 'Make another' : 'New blanket';
  const unit = unitLabel();
  // Only used when the pattern name is new: it becomes a library pattern on save.
  let patternFile = null;
  let newPatternUrl = '';

  app.innerHTML = `
    <header class="bar">
      <button class="icon-btn" id="cancel" aria-label="Cancel">${icon.back}</button>
      <span class="bar-title">${esc(heading)}</span>
      <span></span>
    </header>
    <form id="form" class="form" novalidate>
      <section class="group">
        <div class="photo-strip" id="photos"></div>
        <p class="hint" id="photo-hint"></p>
      </section>

      <section class="group">
        <div class="row">
          <label class="field narrow"><span>Blanket #</span>
            <input name="number" type="number" inputmode="numeric" min="1" value="${esc(b.number)}"></label>
          <label class="field"><span>Name <em>optional</em></span>
            <input name="title" value="${esc(b.title)}" placeholder="e.g. Sage garter throw" autocomplete="off" autocapitalize="sentences"></label>
        </div>
        <div class="row">
          <label class="field"><span>Started</span><input name="started" type="date" value="${esc(b.started)}"></label>
          <label class="field"><span>Finished</span><input name="finished" type="date" value="${esc(b.finished)}"></label>
        </div>
        <p class="hint">Leave “Finished” empty while it's still on the go.</p>
      </section>

      <section class="group">
        <h3>Size</h3>
        <div class="chips wrap" role="radiogroup" aria-label="Size">
          ${SIZES.map((s) => `<label class="chip"><input type="radio" name="size" value="${s}"${b.size === s ? ' checked' : ''}><span>${s}</span></label>`).join('')}
        </div>
        <p class="pair-label">Planned size <em>(${unit})</em></p>
        <div class="dims">
          <label class="field"><span>Width</span>
            <input name="plannedWidth" type="number" inputmode="decimal" step="any" min="0" value="${esc(b.plannedWidth)}"></label>
          <span class="times">×</span>
          <label class="field"><span>Length</span>
            <input name="plannedLength" type="number" inputmode="decimal" step="any" min="0" value="${esc(b.plannedLength)}"></label>
        </div>
        <p class="pair-label">Finished size <em>(${unit}, measure when it's done)</em></p>
        <div class="dims">
          <label class="field"><span>Width</span>
            <input name="width" type="number" inputmode="decimal" step="any" min="0" value="${esc(b.width)}"></label>
          <span class="times">×</span>
          <label class="field"><span>Length</span>
            <input name="length" type="number" inputmode="decimal" step="any" min="0" value="${esc(b.length)}"></label>
        </div>
        <div class="row">
          <label class="field"><span>Stitches wide</span>
            <input name="stitchesWide" type="number" inputmode="numeric" min="0" value="${esc(b.stitchesWide)}"></label>
          <label class="field"><span>Rows</span>
            <input name="rows" type="number" inputmode="numeric" min="0" value="${esc(b.rows)}"></label>
        </div>
      </section>

      <section class="group">
        <h3>Pattern <em class="optional">optional</em></h3>
        <div class="field"><label for="pattern-name">Pattern</label>
          <div class="ac"><input id="pattern-name" name="patternName" value="${esc(b.patternName)}" placeholder="Pick one of your patterns, or type a new one" autocomplete="off" autocorrect="off" autocapitalize="sentences" spellcheck="false"></div></div>
        <div id="pattern-extra"></div>
      </section>

      <section class="group">
        <h3>Yarn</h3>
        <p class="hint group-hint">Plan how many skeins of each colour you'll need. While you knit, the skein tracker counts what you actually use.</p>
        <div id="yarns"></div>
        <button type="button" class="btn ghost small" id="add-yarn">${icon.plus} Add another yarn</button>
      </section>

      <section class="group">
        <h3>Notes</h3>
        <textarea name="notes" rows="5" placeholder="Anything worth remembering: who it was for, what you'd change, why it took longer…">${esc(b.notes)}</textarea>
      </section>


      <div class="save-bar"><button type="submit" class="btn primary block" id="save">Save blanket</button></div>
    </form>`;

  const form = document.getElementById('form');
  const yarnBox = document.getElementById('yarns');
  const strip = document.getElementById('photos');

  function readYarns() {
    return [...yarnBox.querySelectorAll('.yarn')].map((row) => ({
      key: row.dataset.key,
      brand: row.querySelector('[data-k="brand"]').value.trim(),
      color: row.querySelector('[data-k="color"]').value.trim(),
      planned: numberOrBlank(row.querySelector('[data-k="planned"]').value),
      used: numberOrBlank(row.querySelector('[data-k="used"]').value),
      log: yarnLogs.get(row.dataset.key) || [],
    }));
  }

  function drawYarns(yarns) {
    yarnBox.innerHTML = yarns.map((y, i) => `
      <div class="yarn" data-key="${y.key}">
        <div class="field"><label for="brand-${y.key}">Brand / line</label>
          <div class="ac"><input id="brand-${y.key}" data-k="brand" value="${esc(y.brand)}" placeholder="Start typing, e.g. Bernat" autocomplete="off" autocorrect="off" autocapitalize="words" spellcheck="false" enterkeyhint="next"></div></div>
        <div class="field"><label for="color-${y.key}">Colour</label>
          <div class="ac"><input id="color-${y.key}" data-k="color" value="${esc(y.color)}" placeholder="Pick or type a colour" autocomplete="off" autocorrect="off" autocapitalize="words" spellcheck="false" enterkeyhint="next"></div></div>
        <div class="row">
          <label class="field"><span>Planned skeins</span>
            <input data-k="planned" type="number" inputmode="decimal" step="any" min="0" value="${esc(y.planned)}"></label>
          <label class="field"><span>Used so far</span>
            <input data-k="used" type="number" inputmode="decimal" step="any" min="0" value="${esc(y.used)}"></label>
        </div>
        ${yarns.length > 1 ? `<button type="button" class="link danger-text" data-remove-yarn="${i}">Remove this yarn</button>` : ''}
      </div>`).join('');
    yarnBox.querySelectorAll('.yarn').forEach((row) => {
      const brand = row.querySelector('[data-k="brand"]');
      const color = row.querySelector('[data-k="color"]');
      attachAutocomplete(brand, {
        getOptions: brandOptions,
        // Picking a brand goes straight on to its colours.
        onPick: () => color.focus(),
      });
      attachAutocomplete(color, {
        getOptions: (q) => colorOptions(brand.value, q),
        renderSwatch: swatchElement,
        onPick: () => row.querySelector('[data-k="planned"]').focus(),
      });
    });
    yarnBox.querySelectorAll('[data-remove-yarn]').forEach((btn) =>
      btn.addEventListener('click', () => {
        const list = readYarns();
        list.splice(Number(btn.dataset.removeYarn), 1);
        unsavedChanges = true;
        drawYarns(list);
      }));
  }

  async function drawPhotos() {
    strip.innerHTML = `
      ${photos.map((p, i) => `
        <div class="pic${i === 0 ? ' cover' : ''}">
          <button type="button" class="pic-img" data-cover="${i}" aria-label="${i === 0 ? 'Cover photo' : 'Make this the cover photo'}">
            <img ${p.url ? `src="${p.url}"` : `data-photo="${p.id}"`} alt="">
            ${i === 0 ? '<span>Cover</span>' : ''}
          </button>
          <button type="button" class="pic-remove" data-remove-photo="${i}" aria-label="Remove photo">${icon.close}</button>
        </div>`).join('')}
      <label class="add-photo">
        <input type="file" accept="image/*" multiple id="photo-input">
        ${icon.camera}<span>${photos.length ? 'Add more' : 'Add photos'}</span>
      </label>`;
    document.getElementById('photo-hint').textContent = photos.length > 1 ? 'Tap a photo to make it the cover.' : '';
    hydratePhotos(strip);

    strip.querySelectorAll('[data-cover]').forEach((btn) =>
      btn.addEventListener('click', () => {
        const i = Number(btn.dataset.cover);
        if (i === 0) return;
        photos.unshift(...photos.splice(i, 1));
        unsavedChanges = true;
        drawPhotos();
      }));
    strip.querySelectorAll('[data-remove-photo]').forEach((btn) =>
      btn.addEventListener('click', () => {
        const [removed] = photos.splice(Number(btn.dataset.removePhoto), 1);
        if (removed.url) URL.revokeObjectURL(removed.url);
        unsavedChanges = true;
        drawPhotos();
      }));

    const input = document.getElementById('photo-input');
    input.addEventListener('change', async () => {
      const files = [...input.files];
      input.value = '';
      if (!files.length) return;
      strip.classList.add('busy');
      for (const file of files) {
        try {
          const { full, thumb } = await preparePhoto(file);
          photos.push({ id: uid(), full, thumb, url: URL.createObjectURL(thumb) });
        } catch (err) {
          toast(err.message);
        }
      }
      strip.classList.remove('busy');
      unsavedChanges = true;
      drawPhotos();
    });
  }

  const patternInput = document.getElementById('pattern-name');
  const extraBox = document.getElementById('pattern-extra');
  let extraFor = null;
  function drawPatternExtra() {
    if (!extraBox.isConnected) return;
    const name = patternInput.value.trim();
    const match = findPatternByName(name);
    const built = match && builtInPattern(match.id);
    // Redraw only when the pattern changes, so a link being typed isn't wiped.
    const key = match ? match.id : name ? 'new' : '';
    if (key === extraFor) return;
    extraFor = key;
    if (!name) {
      extraBox.innerHTML = '';
    } else if (match) {
      const bits = built
        ? [`Free pattern by ${built.designer}`, match.id === b.patternId && b.patternSize ? b.patternSize : '']
        : [match.url ? 'link' : '', match.file ? 'file' : '', plural(blanketsWithPattern(match.id).length, 'blanket')];
      extraBox.innerHTML = `<div class="file-chip">${icon.book}
          <span><strong>From ${built ? 'Rustic Nastalje' : 'your patterns'}</strong><small>${esc(bits.filter(Boolean).join(' · '))}</small></span></div>`;
    } else {
      extraBox.innerHTML = `
        <p class="hint group-hint">New pattern. It's saved to your patterns so you can pick it next time.</p>
        <label class="field"><span>Link <em>optional</em></span>
          <input id="pattern-url" type="url" inputmode="url" value="${esc(newPatternUrl)}" placeholder="https://…" autocomplete="off" autocapitalize="off" spellcheck="false"></label>
        <div id="pattern-file"></div>`;
      document.getElementById('pattern-url').addEventListener('input', (e) => { newPatternUrl = e.target.value; });
      drawPatternFile();
    }
  }
  function drawPatternFile() {
    const fileBox = document.getElementById('pattern-file');
    if (!fileBox) return;
    fileBox.innerHTML = patternFile
      ? `<div class="file-chip">${icon.file}
          <span><strong>${esc(patternFile.name)}</strong><small>${fileSize(patternFile.size)}</small></span>
          <button type="button" class="link danger-text" id="remove-pattern">Remove</button></div>`
      : `<label class="btn ghost small file-btn">${icon.file} Attach a pattern file
          <input type="file" id="pattern-input" accept="application/pdf,.pdf,image/*,.doc,.docx,.txt,.rtf,.pages"></label>`;
    document.getElementById('remove-pattern')?.addEventListener('click', () => {
      patternFile = null;
      unsavedChanges = true;
      drawPatternFile();
    });
    const input = document.getElementById('pattern-input');
    input?.addEventListener('change', async () => {
      const picked = await readPatternFile(input.files[0]);
      input.value = '';
      if (!picked) return;
      patternFile = picked;
      unsavedChanges = true;
      drawPatternFile();
    });
  }
  attachAutocomplete(patternInput, { getOptions: patternOptions, onPick: drawPatternExtra });
  patternInput.addEventListener('input', drawPatternExtra);
  patternInput.addEventListener('blur', () => setTimeout(drawPatternExtra, 0));

  drawYarns(b.yarns);
  drawPhotos();
  drawPatternExtra();

  form.addEventListener('input', () => { unsavedChanges = true; });
  document.getElementById('add-yarn').addEventListener('click', () => {
    drawYarns([...readYarns(), { ...emptyYarn(), key: uid() }]);
    unsavedChanges = true;
    yarnBox.querySelector('.yarn:last-child input')?.focus();
  });

  const leave = () => {
    for (const p of photos) if (p.url) URL.revokeObjectURL(p.url);
    unsavedChanges = false;
    location.hash = existing ? `#/b/${existing.id}` : source ? `#/b/${source.id}` : '#/';
  };
  document.getElementById('cancel').addEventListener('click', () => {
    if (unsavedChanges && !confirm('Leave without saving your changes?')) return;
    leave();
  });

  let saving = false;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (saving) return;
    const data = new FormData(form);
    const started = data.get('started') || '';
    const finished = data.get('finished') || '';
    if (started && finished && finished < started) {
      toast('The finish date is before the start date.');
      return;
    }
    const patternName = (data.get('patternName') || '').trim();
    let pattern = findPatternByName(patternName);
    const patternUrl = safeURL(newPatternUrl);
    if (!pattern && newPatternUrl.trim() && !patternUrl) {
      toast("That pattern link doesn't look right. It should start with https://");
      return;
    }
    const number = numberOrBlank(data.get('number')) || nextNumber;
    const clash = state.blankets.find((x) => x.id !== b.id && Number(x.number) === number);
    if (clash && !confirm(`You already have a Blanket #${number}. Save with the same number anyway?`)) return;

    saving = true;
    document.getElementById('save').disabled = true;
    try {
      for (const p of photos) {
        if (p.full) await db.put('photos', { id: p.id, full: p.full, thumb: p.thumb });
      }
      const kept = new Set(photos.map((p) => p.id));
      for (const old of existing?.photos || []) {
        if (!kept.has(old)) {
          await db.remove('photos', old);
          forgetPhoto(old);
        }
      }
      if (!pattern && patternName) {
        const now = new Date().toISOString();
        pattern = { id: uid(), name: patternName, url: patternUrl, file: await storePatternFile(patternFile), notes: '', createdAt: now, updatedAt: now };
        await savePattern(pattern);
      }

      const saved = {
        ...b,
        number,
        title: (data.get('title') || '').trim(),
        started,
        finished,
        size: data.get('size') || '',
        plannedWidth: numberOrBlank(data.get('plannedWidth')),
        plannedLength: numberOrBlank(data.get('plannedLength')),
        width: numberOrBlank(data.get('width')),
        length: numberOrBlank(data.get('length')),
        stitchesWide: numberOrBlank(data.get('stitchesWide')),
        rows: numberOrBlank(data.get('rows')),
        patternId: pattern ? pattern.id : '',
        patternName: pattern ? pattern.name : '',
        patternSize: pattern && pattern.id === b.patternId ? b.patternSize : '',
        yarns: readYarns()
          .filter((y) => y.brand || y.color || has(y.planned) || has(y.used))
          .map(({ key, ...y }) => y),
        notes: (data.get('notes') || '').trim(),
        photos: photos.map((p) => p.id),
        updatedAt: new Date().toISOString(),
      };
      await saveBlanket(saved);
      for (const p of photos) if (p.url) URL.revokeObjectURL(p.url);
      unsavedChanges = false;
      toast(existing ? 'Changes saved' : 'Blanket saved');
      location.hash = `#/b/${saved.id}`;
    } catch (err) {
      console.error(err);
      toast('Something went wrong saving. Your phone may be out of space.');
      saving = false;
      document.getElementById('save').disabled = false;
    }
  });
}

// ---------- Patterns ----------

function patternOptions(query) {
  const options = RUSTIC_PATTERNS.map((p) => ({ value: p.name, note: 'Free · Rustic Nastalje' }));
  for (const p of state.patterns) {
    const made = blanketsWithPattern(p.id).length;
    options.push({ value: p.name, note: made ? `Made ${made}×` : 'Your pattern' });
  }
  return rankOptions(options, query, query.trim() ? 8 : 60);
}

async function readPatternFile(file) {
  if (!file) return null;
  if (file.size > MAX_PATTERN_FILE) {
    toast(`${file.name} is too big. Pattern files can be up to 30 MB.`);
    return null;
  }
  // Copied into a plain Blob: some iPhones can't store the picked File itself.
  const blob = new Blob([await file.arrayBuffer()], { type: file.type });
  return { id: uid(), name: file.name, type: file.type, size: file.size, blob };
}

async function storePatternFile(picked) {
  if (!picked) return null;
  await db.put('files', { id: picked.id, blob: picked.blob });
  const { id, name, type, size } = picked;
  return { id, name, type, size };
}

// "LodgePlaid-FingerKnitBlanketPattern.pdf" and "Pattern Lodge Plaid (Breadcrumb) v2 - Etsy upload.pdf"
// both become "Lodge Plaid", so several versions of one pattern are added only once.
function nameFromFile(filename) {
  const name = filename
    .replace(/\.[a-z0-9]+$/i, '')
    .replace(/[_]+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/\(\s*breadcrumb\s*\)/gi, ' ')
    .replace(/[-–]\s*etsy upload/gi, ' ')
    .replace(/\bv\d+\b/gi, ' ')
    .replace(/\b(finger|arm|hand)\s*knit(ted)?\s*(blanket\s*)?pattern\b/gi, ' ')
    .replace(/^\s*pattern\b[\s:-]*/i, '')
    .replace(/[\s:-]*\bpattern\s*$/i, '')
    .replace(/\s*-\s*$/, '')
    .replace(/^\s*-\s*/, '')
    .replace(/\s*-\s*/g, ' - ')
    .replace(/\s+/g, ' ')
    .trim();
  return name || filename.replace(/\.[a-z0-9]+$/i, '') || 'Pattern';
}

function renderPatterns() {
  const mine = [...state.patterns].sort((a, b) => a.name.localeCompare(b.name));
  app.innerHTML = `
    <header class="bar">
      <a class="icon-btn" href="#/" aria-label="Back to all blankets">${icon.back}</a>
      <span class="bar-title">Patterns</span>
      <a class="text-btn" href="#/pnew">Add</a>
    </header>
    <section class="free-pattern">
      <p class="eyebrow">Free with ImadeIt</p>
      ${RUSTIC_PATTERNS.map((p) => `
        <a class="free-card" href="#/rn/${p.id}">
          <span class="free-art">${logo}</span>
          <span><strong>${esc(p.name)}</strong><small>by ${esc(p.designer)} · ${plural(p.sizes.length, 'size')}</small></span>
          ${icon.next}
        </a>`).join('')}
    </section>
    <section class="library">
      <h2>My patterns <span>${mine.length || ''}</span></h2>
      ${mine.length ? `<ul class="pattern-list">${mine.map((p) => {
        const made = blanketsWithPattern(p.id).length;
        const bits = [made ? `Made ${made}×` : 'Not made yet', p.file ? 'File' : '', p.url ? hostOf(p.url) : ''].filter(Boolean);
        return `<li><a href="#/p/${p.id}">${icon.book}<span><strong>${esc(p.name)}</strong><small>${esc(bits.join(' · '))}</small></span>${icon.next}</a></li>`;
      }).join('')}</ul>`
      : `<p class="fine">Save each pattern once: its name, a link, or the PDF. Then pick it whenever you start a blanket.</p>`}
      <div class="library-actions">
        <a class="btn primary block" href="#/pnew">${icon.plus} New pattern</a>
        <label class="btn ghost block file-btn">${icon.file} Add pattern files
          <input type="file" id="bulk-files" multiple accept="application/pdf,.pdf,image/*,.doc,.docx,.txt,.rtf,.pages"></label>
        <p class="fine">Pick several PDFs at once from Files or Google Drive. Each one becomes a pattern, named after the file.</p>
      </div>
    </section>
    <p class="shop-line"><a href="${SHOP_URL}" target="_blank" rel="noopener">More Breadcrumb patterns by Rustic Nastalje on Etsy ${icon.external}</a></p>`;

  const bulk = document.getElementById('bulk-files');
  bulk.addEventListener('change', async () => {
    const files = [...bulk.files];
    bulk.value = '';
    if (!files.length) return;
    toast(`Adding ${plural(files.length, 'pattern')}…`);
    let added = 0;
    const skipped = [];
    for (const file of files) {
      const name = nameFromFile(file.name);
      if (findPatternByName(name)) {
        skipped.push(name);
        continue;
      }
      const picked = await readPatternFile(file);
      if (!picked) continue;
      const now = new Date().toISOString();
      await savePattern({ id: uid(), name, url: '', file: await storePatternFile(picked), notes: '', createdAt: now, updatedAt: now });
      added += 1;
    }
    await noteChange();
    requestPersistence();
    renderPatterns();
    toast(`${plural(added, 'pattern')} added${skipped.length ? `. Already had ${skipped.length}` : ''}`);
  });
}

function renderPatternDetail(id) {
  const p = libraryPattern(id);
  if (!p) return renderMissing();
  const made = blanketsWithPattern(id).sort((a, b) => (Number(b.number) || 0) - (Number(a.number) || 0));
  const done = made.filter((b) => b.finished);
  const avg = (vals) => (vals.length ? round(vals.reduce((n, v) => n + v, 0) / vals.length) : null);
  const avgSkeins = avg(done.map(usedOf).filter((n) => n > 0));
  const avgDays = avg(done.map(daysTaken).filter(Boolean));
  const sizes = done.map((b) => dimsText(b.width, b.length)).filter(Boolean);

  app.innerHTML = `
    <header class="bar">
      <a class="icon-btn" href="#/patterns" aria-label="Back to patterns">${icon.back}</a>
      <span class="bar-title">Pattern</span>
      <a class="text-btn" href="#/pedit/${p.id}">Edit</a>
    </header>
    <article class="detail">
      <p class="eyebrow">My pattern</p>
      <h2>${esc(p.name)}</h2>
      ${p.url || p.file ? `<div class="pattern">${patternLinkRow(p)}${patternFileRow(p)}</div>` : ''}
      ${done.length ? `<dl class="facts">
        <div><dt>Made</dt><dd>${plural(made.length, 'time')}</dd></div>
        <div><dt>Skeins, on average</dt><dd>${avgSkeins ?? '–'}</dd></div>
        <div><dt>Days, on average</dt><dd>${avgDays ?? '–'}</dd></div>
        <div><dt>Last finished size</dt><dd>${esc(sizes[0] || '–')}</dd></div>
      </dl>` : ''}
      ${p.notes ? `<h3>Notes</h3><p class="notes">${esc(p.notes)}</p>` : ''}
      <a class="btn primary block start-btn" href="#/newp/${p.id}">${icon.plus} Start a blanket with this pattern</a>
      ${made.length ? `<h3>Made with this pattern</h3><div class="grid">${made.map(card).join('')}</div>` : ''}
      <div class="actions"><button class="btn danger block" id="delete-pattern">Delete this pattern</button></div>
    </article>`;
  hydratePhotos();
  if (p.file) preparePatternFile(p.file);
  document.getElementById('delete-pattern').addEventListener('click', async () => {
    const note = made.length ? ` ${plural(made.length, 'blanket')} made with it will keep the pattern's name.` : '';
    if (!confirm(`Delete the pattern “${p.name}”?${note}`)) return;
    if (p.file) await db.remove('files', p.file.id);
    for (const b of made) await saveBlanket({ ...b, patternId: '' }, { quiet: true });
    await db.remove('patterns', p.id);
    state.patterns = state.patterns.filter((x) => x.id !== p.id);
    await noteChange();
    toast('Pattern deleted');
    location.hash = '#/patterns';
  });
}

function renderPatternForm(id) {
  const existing = id ? libraryPattern(id) : null;
  if (id && !existing) return renderMissing();
  let file = existing?.file ? { ...existing.file } : null;
  unsavedChanges = false;

  app.innerHTML = `
    <header class="bar">
      <button class="icon-btn" id="cancel" aria-label="Cancel">${icon.back}</button>
      <span class="bar-title">${existing ? 'Edit pattern' : 'New pattern'}</span>
      <span></span>
    </header>
    <form id="pattern-form" class="form" novalidate>
      <section class="group">
        <label class="field"><span>Pattern name</span>
          <input name="name" value="${esc(existing?.name || '')}" placeholder="e.g. Lodge Plaid" autocomplete="off" autocapitalize="words" required></label>
        <label class="field"><span>Link <em>optional</em></span>
          <input name="url" type="url" inputmode="url" value="${esc(existing?.url || '')}" placeholder="https://…" autocomplete="off" autocapitalize="off" spellcheck="false"></label>
        <div id="file-box"></div>
      </section>
      <section class="group">
        <h3>Notes</h3>
        <textarea name="notes" rows="5" placeholder="Cast on counts, yarn that works well, changes you always make…">${esc(existing?.notes || '')}</textarea>
      </section>
      <div class="save-bar"><button type="submit" class="btn primary block" id="save">Save pattern</button></div>
    </form>`;

  const form = document.getElementById('pattern-form');
  const box = document.getElementById('file-box');
  const drawFile = () => {
    box.innerHTML = file
      ? `<div class="file-chip">${icon.file}<span><strong>${esc(file.name)}</strong><small>${fileSize(file.size)}</small></span>
          <button type="button" class="link danger-text" id="remove-file">Remove</button></div>`
      : `<label class="btn ghost small file-btn">${icon.file} Attach a pattern file
          <input type="file" id="file-input" accept="application/pdf,.pdf,image/*,.doc,.docx,.txt,.rtf,.pages"></label>`;
    document.getElementById('remove-file')?.addEventListener('click', () => { file = null; unsavedChanges = true; drawFile(); });
    const input = document.getElementById('file-input');
    input?.addEventListener('change', async () => {
      const picked = await readPatternFile(input.files[0]);
      input.value = '';
      if (!picked) return;
      file = picked;
      unsavedChanges = true;
      const nameField = form.querySelector('[name=name]');
      if (!nameField.value.trim()) nameField.value = nameFromFile(picked.name);
      drawFile();
    });
  };
  drawFile();
  form.addEventListener('input', () => { unsavedChanges = true; });
  document.getElementById('cancel').addEventListener('click', () => {
    if (unsavedChanges && !confirm('Leave without saving your changes?')) return;
    unsavedChanges = false;
    location.hash = existing ? `#/p/${existing.id}` : '#/patterns';
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const data = new FormData(form);
    const name = (data.get('name') || '').trim();
    if (!name) {
      toast('Give the pattern a name.');
      return;
    }
    const other = findPatternByName(name);
    if (other && other.id !== existing?.id) {
      toast(`You already have a pattern called “${other.name}”.`);
      return;
    }
    const url = safeURL(data.get('url'));
    if ((data.get('url') || '').trim() && !url) {
      toast("That link doesn't look right. It should start with https://");
      return;
    }
    const fileMeta = file?.blob ? await storePatternFile(file) : file;
    if (existing?.file && existing.file.id !== fileMeta?.id) await db.remove('files', existing.file.id);
    const now = new Date().toISOString();
    const saved = { id: existing?.id || uid(), createdAt: existing?.createdAt || now, name, url, file: fileMeta, notes: (data.get('notes') || '').trim(), updatedAt: now };
    await savePattern(saved);
    await noteChange();
    requestPersistence();
    unsavedChanges = false;
    toast(existing ? 'Pattern saved' : 'Pattern added');
    location.hash = `#/p/${saved.id}`;
  });
}

// The free Breadcrumb pattern, readable in the app, with a size picker that sets up the blanket.
function renderBuiltInPattern(id) {
  const p = builtInPattern(id);
  if (!p) return renderMissing();
  const made = blanketsWithPattern(id);
  let chosen = p.sizes.length - 1;
  const unit = unitLabel();
  const show = (inches) => (unit === 'cm' ? Math.round(inches * 2.54) : inches);

  app.innerHTML = `
    <header class="bar">
      <a class="icon-btn" href="#/patterns" aria-label="Back to patterns">${icon.back}</a>
      <span class="bar-title">Free pattern</span>
      <span></span>
    </header>
    <article class="detail breadcrumb">
      <p class="eyebrow">A Breadcrumb pattern by ${esc(p.designer)}</p>
      <h2>${esc(p.name)}</h2>
      <p class="lede">${esc(p.summary)}</p>
      <p class="fine">${esc(p.tagline)}</p>

      <h3>Pick your size</h3>
      <div class="size-picker" role="radiogroup" aria-label="Size">
        ${p.sizes.map((z, i) => `
          <button type="button" class="size-option${i === chosen ? ' on' : ''}" role="radio" aria-checked="${i === chosen}" data-size="${i}">
            <strong>${esc(z.name)}</strong>
            <span>${show(z.width)} × ${show(z.length)} ${unit}</span>
            <small>${z.loops} loops · ${z.rows} rows</small>
          </button>`).join('')}
      </div>
      <a class="btn primary block start-btn" id="start" href="#/newrn/${p.id}/${chosen}">${icon.plus} Start this blanket</a>
      <p class="fine">Sets up a new blanket with this size's loops and rows. The row counter then shows each row's instruction as you go.${made.length ? ` You've started it ${plural(made.length, 'time')}.` : ''}</p>

      <h3>You'll need</h3>
      <ul class="plain">${p.supplies.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
      ${p.yarnLink ? `<p><a href="${esc(p.yarnLink)}" target="_blank" rel="noopener">Shop the yarn ${icon.external}</a></p>` : ''}

      <h3>Rows</h3>
      <ol class="rows-list">
        <li><b>Cast on:</b> make a slipknot and chain the loops for your size.</li>
        <li><b>Row 1:</b> ${esc(p.row(1, 42))}</li>
        <li><b>Every row after:</b> ${esc(p.row(2, 42))}</li>
        ${p.sizes.map((z) => `<li class="stop"><b>Row ${z.rows}:</b> last row for ${esc(z.name)}. Make these loops about four fingers wide.</li>`).join('')}
      </ol>

      ${p.sections.map((sec) => `
        <details class="pattern-step"${sec.title === 'Before you start' ? ' open' : ''}>
          <summary>${esc(sec.title)}</summary>
          ${sec.body.map((line) => `<p>${esc(line)}</p>`).join('')}
        </details>`).join('')}

      <p class="terms">${esc(p.terms)}</p>
      <p class="shop-line"><a href="${SHOP_URL}" target="_blank" rel="noopener">More Breadcrumb patterns by Rustic Nastalje on Etsy ${icon.external}</a></p>
    </article>`;

  const start = document.getElementById('start');
  app.querySelectorAll('[data-size]').forEach((btn) =>
    btn.addEventListener('click', () => {
      chosen = Number(btn.dataset.size);
      app.querySelectorAll('[data-size]').forEach((x) => {
        x.classList.toggle('on', x === btn);
        x.setAttribute('aria-checked', String(x === btn));
      });
      start.href = `#/newrn/${p.id}/${chosen}`;
    }));
}

function presetForBuiltIn(id, sizeIndex) {
  const p = builtInPattern(id);
  const z = p && p.sizes[Number(sizeIndex)];
  if (!z) return null;
  const cm = state.settings.unit === 'cm';
  const conv = (inches) => (cm ? Math.round(inches * 2.54) : inches);
  return {
    patternId: p.id, patternSize: z.name, size: z.size,
    plannedWidth: conv(z.width), plannedLength: conv(z.length), stitchesWide: z.loops, rows: z.rows,
  };
}

// ---------- Spreadsheets ----------

function spreadsheetRows(blankets) {
  const rows = [COLUMNS.map((c) => c.label)];
  const sorted = [...blankets].sort((a, b) => (Number(a.number) || 0) - (Number(b.number) || 0));
  for (const b of sorted) {
    const base = {
      number: b.number, title: b.title, started: b.started, finished: b.finished, size: b.size,
      plannedWidth: b.plannedWidth, plannedLength: b.plannedLength, width: b.width, length: b.length,
      stitchesWide: b.stitchesWide, rows: b.rows, pattern: patternById(b.patternId)?.name || b.patternName, notes: b.notes,
    };
    const yarns = (b.yarns || []).length ? b.yarns : [{}];
    for (const y of yarns) {
      const row = { ...base, brand: y.brand, color: y.color, planned: y.planned, used: y.used };
      rows.push(COLUMNS.map((c) => row[c.key] ?? ''));
    }
  }
  return rows;
}

async function exportSpreadsheet() {
  const file = new File([toCSV(spreadsheetRows(state.blankets))], `ImadeIt-blankets-${today()}.csv`, { type: 'text/csv' });
  await shareOrDownload(file, 'ImadeIt blankets');
}

async function downloadTemplate() {
  const example = [
    { number: 1, title: 'Sage garter throw', started: '2026-10-21', finished: '2026-10-25', size: 'Throw', plannedWidth: 50, plannedLength: 60, width: 48, length: 63, stitchesWide: 22, rows: 42, pattern: 'The Rustic Blanket', brand: 'Bernat Blanket Big', color: 'Sage', planned: 6, used: 6.5, notes: 'Example row: replace with your own' },
    { number: 1, title: 'Sage garter throw', brand: 'Bernat Blanket Big', color: 'Vintage White', planned: 1, used: 1 },
  ];
  const rows = [COLUMNS.map((c) => c.label), ...example.map((r) => COLUMNS.map((c) => r[c.key] ?? ''))];
  await shareOrDownload(new File([toCSV(rows)], 'ImadeIt-template.csv', { type: 'text/csv' }), 'ImadeIt template');
}

async function importSpreadsheet(file) {
  let table;
  try {
    table = parseCSV(await file.text());
  } catch {
    toast("That file couldn't be read. Save the sheet as CSV and try again.");
    return;
  }
  if (table.length < 2) {
    toast('That spreadsheet has no rows to import.');
    return;
  }
  const { map, unknown } = mapHeadings(table[0]);
  if (!('title' in map) && !('number' in map) && !('color' in map) && !('brand' in map)) {
    toast('No columns were recognised. Start from the blank template to see the column names.');
    return;
  }
  const get = (row, key) => (key in map ? (row[map[key]] || '').trim() : '');

  // Rows with the same Blanket # are one blanket; a row without a number starts a new blanket.
  const groups = [];
  const byNumber = new Map();
  for (const row of table.slice(1)) {
    const n = parseNumber(get(row, 'number'));
    let group = n !== '' ? byNumber.get(n) : null;
    if (!group) {
      group = { number: n, rows: [] };
      groups.push(group);
      if (n !== '') byNumber.set(n, group);
    }
    group.rows.push(row);
  }

  let nextNumber = state.blankets.reduce((max, b) => Math.max(max, Number(b.number) || 0), 0) + 1;
  const now = new Date().toISOString();
  const blankets = [];
  let duplicates = 0;
  for (const g of groups) {
    const first = g.rows[0];
    const pick = (key) => g.rows.map((r) => get(r, key)).find(Boolean) || '';
    const title = pick('title');
    if (g.number !== '' && state.blankets.some((b) => Number(b.number) === g.number && (b.title || '') === title)) {
      duplicates += 1;
      continue;
    }
    const yarns = g.rows
      .map((r) => ({ ...emptyYarn(), brand: get(r, 'brand'), color: get(r, 'color'), planned: parseNumber(get(r, 'planned')), used: parseNumber(get(r, 'used')) }))
      .filter((y) => y.brand || y.color || has(y.planned) || has(y.used));
    blankets.push({
      ...normalize({}),
      id: uid(),
      number: g.number !== '' ? g.number : nextNumber++,
      title,
      started: parseDate(get(first, 'started') || pick('started')),
      finished: parseDate(get(first, 'finished') || pick('finished')),
      size: pick('size'),
      plannedWidth: parseNumber(pick('plannedWidth')),
      plannedLength: parseNumber(pick('plannedLength')),
      width: parseNumber(pick('width')),
      length: parseNumber(pick('length')),
      stitchesWide: parseNumber(pick('stitchesWide')),
      rows: parseNumber(pick('rows')),
      patternName: pick('pattern'),
      yarns,
      notes: g.rows.map((r) => get(r, 'notes')).filter(Boolean).join('\n'),
      photos: [],
      createdAt: now,
      updatedAt: now,
    });
  }

  if (!blankets.length) {
    toast(duplicates ? 'Those blankets are already in ImadeIt.' : 'No blankets found in that spreadsheet.');
    return;
  }
  const details = [
    duplicates ? `${plural(duplicates, 'blanket')} already here will be skipped.` : '',
    unknown.length ? `Columns not used: ${unknown.join(', ')}.` : '',
  ].filter(Boolean).join(' ');
  if (!confirm(`Import ${plural(blankets.length, 'blanket')} from this spreadsheet?${details ? `\n\n${details}` : ''}`)) return;

  for (const b of blankets) {
    if (b.patternName) {
      let pattern = findPatternByName(b.patternName);
      if (!pattern) {
        pattern = { id: uid(), name: b.patternName, url: '', file: null, notes: '', createdAt: now, updatedAt: now };
        await savePattern(pattern);
      }
      b.patternId = pattern.id;
      b.patternName = pattern.name;
    }
    await saveBlanket(b, { quiet: true });
  }
  await noteChange();
  requestPersistence();
  toast(`Imported ${plural(blankets.length, 'blanket')}`);
  location.hash = '#/';
}

// ---------- Settings & backups ----------

function renderSettings() {
  const last = state.lastBackup
    ? (() => {
        const days = Math.floor((Date.now() - new Date(state.lastBackup)) / 86400000);
        const when = new Date(state.lastBackup).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
        return `${when} (${days === 0 ? 'today' : `${plural(days, 'day')} ago`})`;
      })()
    : 'Never';
  const unit = state.settings.unit;

  app.innerHTML = `
    <header class="bar">
      <a class="icon-btn" href="#/" aria-label="Back to all blankets">${icon.back}</a>
      <span class="bar-title">Settings</span>
      <span></span>
    </header>
    <div class="panels">
      ${movingNotice()}
      <section class="panel">
        <h3>Backups</h3>
        <p>Your blankets live only on this phone. A backup is one file holding every blanket and photo. Save it to Files, iCloud Drive or Google Drive, or email it to yourself.</p>
        <p class="muted">Last backup: <b>${esc(last)}</b>${state.changesSinceBackup && state.lastBackup ? ` · ${plural(state.changesSinceBackup, 'change')} since` : ''}</p>
        <button class="btn primary block" id="export"${state.blankets.length ? '' : ' disabled'}>Save a backup</button>
        <label class="btn ghost block file-btn">Restore from a backup
          <input type="file" accept=".json,application/json" id="import"></label>
        <p class="fine">Restoring adds the blankets from the backup. Anything already on this phone stays.</p>
      </section>

      <section class="panel">
        <h3>Spreadsheets</h3>
        <p>Already keep your blankets in Google Sheets, Excel or Numbers? Save it as a CSV file and bring it in. One row per yarn colour; rows with the same Blanket # become one blanket.</p>
        <label class="btn primary block file-btn">Import from a spreadsheet
          <input type="file" accept=".csv,text/csv,text/plain" id="import-csv"></label>
        <button class="btn ghost block" id="csv-template">Get a blank template</button>
        <button class="btn ghost block" id="export-csv"${state.blankets.length ? '' : ' disabled'}>Download my blankets as a spreadsheet</button>
        <p class="fine">Spreadsheets hold the words and numbers only. Use “Save a backup” to keep photos and pattern files too.</p>
      </section>

      <section class="panel">
        <h3>Measurements</h3>
        <div class="segmented" role="radiogroup" aria-label="Units">
          <button class="${unit === 'in' ? 'on' : ''}" data-unit="in" role="radio" aria-checked="${unit === 'in'}">Inches</button>
          <button class="${unit === 'cm' ? 'on' : ''}" data-unit="cm" role="radio" aria-checked="${unit === 'cm'}">Centimetres</button>
        </div>
      </section>

      <section class="panel">
        <h3>Put it on your Home Screen</h3>
        <p><b>iPhone / iPad:</b> open this page in Safari, tap <b>Share</b>, then <b>Add to Home Screen</b>.</p>
        <p><b>Android:</b> open the Chrome menu (⋮) and tap <b>Install app</b> or <b>Add to Home screen</b>.</p>
        <p class="fine">Once installed it works without internet. Blankets saved in the browser and in the Home Screen app are kept separately, so stick to the app.</p>
      </section>

      <section class="panel">
        <h3>${icon.shield} Your privacy</h3>
        <ul class="ticks">
          <li>No account, no sign-up, no subscription.</li>
          <li>No ads, no tracking, no analytics.</li>
          <li>Your photos and notes never leave this phone unless you save a backup yourself.</li>
        </ul>
        <p class="fine" id="persist-status"></p>
      </section>

      <section class="panel about">
        ${logo}
        <p><b>ImadeIt</b> is a free gift from <b>Rustic Nastalje</b>, made by a chunky blanket knitter for chunky blanket knitters.</p>
        <p class="fine">Yarn brand and colour names are listed only to describe yarn. ImadeIt isn't affiliated with or endorsed by any yarn brand.</p>
        <p class="fine"><a href="${SHOP_URL}" target="_blank" rel="noopener">Patterns by Rustic Nastalje on Etsy</a></p>
        <p class="fine">Version ${APP_VERSION}</p>
      </section>

      <section class="panel">
        <h3>Start over</h3>
        <p class="fine">Removes every blanket and photo from this phone. Save a backup first if you might want them back.</p>
        <button class="btn danger block" id="wipe"${state.blankets.length ? '' : ' disabled'}>Delete everything</button>
      </section>
    </div>`;

  document.getElementById('export').addEventListener('click', exportBackup);
  app.querySelector('.moving [data-action="backup"]')?.addEventListener('click', exportBackup);
  document.getElementById('export-csv').addEventListener('click', exportSpreadsheet);
  document.getElementById('csv-template').addEventListener('click', downloadTemplate);
  const csvInput = document.getElementById('import-csv');
  csvInput.addEventListener('change', async () => {
    const file = csvInput.files[0];
    csvInput.value = '';
    if (file) await importSpreadsheet(file);
  });
  const importInput = document.getElementById('import');
  importInput.addEventListener('change', async () => {
    const file = importInput.files[0];
    importInput.value = '';
    if (file) await importBackup(file);
  });

  app.querySelectorAll('[data-unit]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      state.settings.unit = btn.dataset.unit;
      await db.setMeta('settings', state.settings);
      renderSettings();
    }));

  document.getElementById('wipe').addEventListener('click', async () => {
    if (!confirm(`Delete all ${plural(state.blankets.length, 'blanket')} and their photos from this phone?`)) return;
    if (!confirm('Last check: this cannot be undone. Delete everything?')) return;
    await db.clear('blankets');
    await db.clear('photos');
    await db.clear('files');
    await db.clear('patterns');
    await db.setMeta('changesSinceBackup', 0);
    for (const url of photoURLs.values()) URL.revokeObjectURL(url);
    photoURLs.clear();
    await load();
    toast('Everything has been deleted');
    location.hash = '#/';
  });

  (async () => {
    const el = document.getElementById('persist-status');
    try {
      if (navigator.storage && navigator.storage.persisted && (await navigator.storage.persisted())) {
        el.textContent = 'This phone has agreed to keep ImadeIt’s storage safe from automatic clean-up.';
      }
    } catch { /* not supported */ }
  })();
}

async function exportBackup() {
  if (!state.blankets.length) return;
  toast('Packing up your blankets…');
  const blankets = await db.all('blankets');
  const photos = await db.all('photos');
  const files = await db.all('files');
  const payload = {
    app: 'ImadeIt',
    format: 3,
    exportedAt: new Date().toISOString(),
    settings: state.settings,
    blankets,
    photos: await Promise.all(photos.map(async (p) => ({
      id: p.id,
      full: await blobToDataURL(p.full),
      thumb: await blobToDataURL(p.thumb),
    }))),
    files: await Promise.all(files.map(async (f) => ({ id: f.id, data: await blobToDataURL(f.blob) }))),
    patterns: await db.all('patterns'),
  };
  const filename = `ImadeIt-backup-${today()}.json`;
  const file = new File([JSON.stringify(payload)], filename, { type: 'application/json' });
  if ((await shareOrDownload(file, 'ImadeIt backup')) === 'cancelled') return;

  state.lastBackup = new Date().toISOString();
  state.changesSinceBackup = 0;
  await db.setMeta('lastBackup', state.lastBackup);
  await db.setMeta('changesSinceBackup', 0);
  toast(`Backup saved: ${plural(blankets.length, 'blanket')}`);
  route();
}

async function importBackup(file) {
  let data;
  try {
    data = JSON.parse(await file.text());
  } catch {
    toast("That file isn't an ImadeIt backup.");
    return;
  }
  if (!data || data.app !== 'ImadeIt' || !Array.isArray(data.blankets)) {
    toast("That file isn't an ImadeIt backup.");
    return;
  }
  const exported = data.exportedAt ? ` from ${fmtDate(data.exportedAt.slice(0, 10))}` : '';
  if (!confirm(`Restore ${plural(data.blankets.length, 'blanket')}${exported}? Blankets already on this phone are kept.`)) return;

  toast('Restoring…');
  try {
    for (const p of data.photos || []) {
      await db.put('photos', { id: p.id, full: await dataURLToBlob(p.full), thumb: await dataURLToBlob(p.thumb) });
      forgetPhoto(p.id);
    }
    for (const pattern of data.patterns || []) await db.put('patterns', pattern);
    for (const f of data.files || []) {
      await db.put('files', { id: f.id, blob: await dataURLToBlob(f.data) });
    }
    for (const b of data.blankets) await db.put('blankets', b);
    await load();
    await noteChange();
    requestPersistence();
    toast(`Restored ${plural(data.blankets.length, 'blanket')}`);
    location.hash = '#/';
  } catch (err) {
    console.error(err);
    toast('Something went wrong restoring. Your phone may be out of space.');
  }
}

// ---------- Routing ----------

const routes = [
  [/^#?\/?$/, () => renderHome()],
  [/^#\/new$/, () => renderForm()],
  [/^#\/b\/([\w-]+)$/, (m) => renderDetail(m[1])],
  [/^#\/edit\/([\w-]+)$/, (m) => renderForm(m[1])],
  [/^#\/again\/([\w-]+)$/, (m) => renderForm(null, m[1])],
  [/^#\/finish\/([\w-]+)$/, (m) => renderFinish(m[1])],
  [/^#\/settings$/, () => renderSettings()],
  [/^#\/patterns$/, () => renderPatterns()],
  [/^#\/p\/([\w-]+)$/, (m) => renderPatternDetail(m[1])],
  [/^#\/pnew$/, () => renderPatternForm()],
  [/^#\/pedit\/([\w-]+)$/, (m) => renderPatternForm(m[1])],
  [/^#\/rn\/([\w-]+)$/, (m) => renderBuiltInPattern(m[1])],
  [/^#\/newp\/([\w-]+)$/, (m) => (libraryPattern(m[1]) ? renderForm(null, null, { patternId: m[1] }) : renderMissing())],
  [/^#\/newrn\/([\w-]+)\/(\d+)$/, (m) => {
    const preset = presetForBuiltIn(m[1], m[2]);
    return preset ? renderForm(null, null, preset) : renderMissing();
  }],
];

let lastHash = null;
function route() {
  const hash = location.hash || '#/';
  for (const [pattern, show] of routes) {
    const m = hash.match(pattern);
    if (m) {
      if (hash !== lastHash) window.scrollTo(0, 0);
      lastHash = hash;
      show(m);
      return;
    }
  }
  location.hash = '#/';
}

window.addEventListener('hashchange', route);
window.addEventListener('beforeunload', (e) => {
  if (unsavedChanges) e.preventDefault();
});
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installPrompt = e;
  if ((location.hash || '#/') === '#/') route();
});

if ('serviceWorker' in navigator) {
  // When a new version has downloaded, switch to it straight away (unless a form is half filled in).
  const hadController = Boolean(navigator.serviceWorker.controller);
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController || reloading || unsavedChanges) return;
    reloading = true;
    location.reload();
  });
  window.addEventListener('load', () =>
    navigator.serviceWorker.register('sw.js')
      .then((reg) => {
        document.addEventListener('visibilitychange', () => {
          if (document.visibilityState === 'visible') reg.update().catch(() => {});
        });
      })
      .catch(() => {}));
}

load()
  .then(route)
  .catch((err) => {
    console.error(err);
    app.innerHTML = `<section class="empty"><h2>ImadeIt couldn't open its storage</h2>
      <p>If you're in a private browsing window, open it in a normal window instead.</p></section>`;
  });
