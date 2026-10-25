/**
 * popup.js  –  View layer
 * Communicates with the service worker via chrome.runtime.sendMessage.
 * Handles rich rendering: info grid, error panels, queue positions, toasts.
 */

import { formatBytes, formatSpeed, formatEta, isValidHttpUrl } from '../background/utils.js';

// ─── DOM References ───────────────────────────────────────────────────────────
const inputUrl       = document.getElementById('input-url');
const inputFilename  = document.getElementById('input-filename');
const inputFolder    = document.getElementById('input-folder');
const inputStreams    = document.getElementById('input-streams');
const btnAdd         = document.getElementById('btn-add');
const btnSaveFolder  = document.getElementById('btn-save-folder');
const btnOpenFolder  = document.getElementById('btn-open-folder');
const btnClear       = document.getElementById('btn-clear');
const addFeedback    = document.getElementById('add-feedback');
const downloadList   = document.getElementById('download-list');
const emptyState     = document.getElementById('empty-state');
const itemTemplate   = document.getElementById('tpl-download-item');
const summaryBar     = document.getElementById('summary-bar');
const summaryActive  = document.getElementById('summary-active');
const summaryQueued  = document.getElementById('summary-queued');
const summarySpeed   = document.getElementById('summary-speed');
const toastContainer = document.getElementById('toast-container');

// ─── Runtime State ────────────────────────────────────────────────────────────
/** @type {Map<string, HTMLElement>}  download id → article element */
const itemElements = new Map();

/** @type {Map<string, string>}  id → last-known state (for toast transitions) */
const prevStates = new Map();

/** Previous value of the folder input (for cancel-revert) */
let prevFolderValue = '';

/** Known folders loaded from storage (used to populate datalist) */
let knownFolders = [];

// ─── Datalist helper ─────────────────────────────────────────────────────────
function populateFolderDatalist(folders) {
  const dl = document.getElementById('folder-suggestions');
  // Keep only entries that came from known folders; clear all first
  dl.innerHTML = '';
  for (const f of folders) {
    const opt = document.createElement('option');
    opt.value = f;
    dl.appendChild(opt);
  }
}

// ─── Resize Handle ────────────────────────────────────────────────────────────
function initResizeHandle() {
  const handle = document.getElementById('resize-handle');
  const app    = document.querySelector('.app');
  if (!handle || !app) return;

  // Hard limits in px (CSS no longer enforces max-height to avoid vh circular dependency)
  const MIN_W = 500, MIN_H = 300, MAX_W = 900, MAX_H = 900;

  let startX, startY, startW, startH;

  handle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    startX = e.clientX;
    startY = e.clientY;
    startW = document.documentElement.offsetWidth;
    startH = document.documentElement.offsetHeight;

    const onMove = (e) => {
      const w = Math.min(MAX_W, Math.max(MIN_W, startW + (e.clientX - startX)));
      const h = Math.min(MAX_H, Math.max(MIN_H, startH + (e.clientY - startY)));
      // Must set html AND body – Edge measures the <html> element for popup window size.
      // body { height: 100% } then follows html, and .app { height: 100% } follows body.
      document.documentElement.style.width  = `${w}px`;
      document.documentElement.style.height = `${h}px`;
      document.body.style.width  = `${w}px`;
      document.body.style.height = `${h}px`;
    };

    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup',   onUp);
      chrome.storage.local.set({
        popupSize: {
          w: document.documentElement.offsetWidth,
          h: document.documentElement.offsetHeight,
        }
      });
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup',   onUp);
  });
}

// ─── Init ─────────────────────────────────────────────────────────────────────
(async function init() {
  // Restore persisted popup size
  const { popupSize } = await chrome.storage.local.get('popupSize');
  if (popupSize) {
    document.documentElement.style.width  = `${popupSize.w}px`;
    document.documentElement.style.height = `${popupSize.h}px`;
    document.body.style.width  = `${popupSize.w}px`;
    document.body.style.height = `${popupSize.h}px`;
  }

  // Show version in header
  const ver = chrome.runtime.getManifest().version;
  const verEl = document.getElementById('header-version');
  if (verEl) verEl.textContent = `v${ver}`;

  // Wire up the custom resize handle
  initResizeHandle();

  // Restore persisted folder preference
  const { defaultFolder } = await chrome.storage.local.get('defaultFolder');
  if (defaultFolder) inputFolder.value = defaultFolder;
  prevFolderValue = inputFolder.value;

  // Load known folders and populate datalist
  const kfResult = await sendMessage({ type: 'GET_KNOWN_FOLDERS' });
  knownFolders = kfResult.folders || [];
  populateFolderDatalist(knownFolders);

  const downloads = await sendMessage({ type: 'GET_ALL_DOWNLOADS' });
  renderDownloadList(downloads);

  // Push-based updates: the SW broadcasts STATE_UPDATE every ~2 s via an alarm
  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === 'STATE_UPDATE') {
      renderDownloadList(message.downloads);
    }
  });
})();

// ─── Event Listeners ──────────────────────────────────────────────────────────
btnAdd.addEventListener('click', handleAddDownload);
btnSaveFolder.addEventListener('click', handleSaveFolder);
btnOpenFolder.addEventListener('click', handleOpenFolder);
btnClear.addEventListener('click', handleClearCompleted);
inputUrl.addEventListener('keydown', (e) => { if (e.key === 'Enter') handleAddDownload(); });
// Track prev folder value for cancel-revert
inputFolder.addEventListener('focus', () => { prevFolderValue = inputFolder.value; });
// Single delegated listener for all item actions
downloadList.addEventListener('click', handleListClick);

// ─── Handlers ─────────────────────────────────────────────────────────────────
async function handleSaveFolder() {
  const folder = inputFolder.value.trim();
  // Check if folder is known; if not, ask user whether to create it
  if (folder && !knownFolders.includes(folder)) {
    const confirmed = confirm(
      `Der Ordner "Downloads/${folder}" ist noch nicht bekannt.\n\nSoll er angelegt und gespeichert werden?`
    );
    if (!confirmed) {
      inputFolder.value = prevFolderValue;  // revert
      return;
    }
    // Register folder as known
    await sendMessage({ type: 'SAVE_KNOWN_FOLDER', folder });
    knownFolders = [...new Set([...knownFolders, folder])];
    populateFolderDatalist(knownFolders);
  }
  await chrome.storage.local.set({ defaultFolder: folder });
  prevFolderValue = folder;
  showToast(
    folder
      ? `📁 Standard-Zielordner gespeichert: ${folder}`
      : '📁 Zielordner geleert – Dateien gehen in den Downloads-Stammordner',
    'info',
    2500
  );
}

function handleOpenFolder() {
  const folder = inputFolder.value.trim();
  sendMessage({ type: 'OPEN_DOWNLOADS_FOLDER', folder });
  showToast(
    folder
      ? `📂 Öffne Ordner: Downloads/${folder}…`
      : '📂 Downloads-Ordner wird geöffnet…',
    'info',
    2000
  );
}

async function handleAddDownload() {
  const url      = inputUrl.value.trim();
  const filename = inputFilename.value.trim() || undefined;
  const folder   = inputFolder.value.trim() || undefined;
  const streams  = parseInt(inputStreams.value, 10);

  // Validate folder: if set and not known, ask whether to create it
  if (folder && !knownFolders.includes(folder)) {
    const confirmed = confirm(
      `Der Ordner "Downloads/${folder}" ist noch nicht bekannt.\n\nSoll er angelegt werden?`
    );
    if (!confirmed) {
      inputFolder.value = prevFolderValue;  // revert
      return;
    }
    await sendMessage({ type: 'SAVE_KNOWN_FOLDER', folder });
    knownFolders = [...new Set([...knownFolders, folder])];
    populateFolderDatalist(knownFolders);
    prevFolderValue = folder;
  }

  if (!url) {
    showFeedback('error', 'Please enter a URL to download.');
    inputUrl.focus();
    return;
  }
  if (!isValidHttpUrl(url)) {
    showFeedback('error',
      'Invalid URL. Must start with <strong>http://</strong> or <strong>https://</strong>.');
    inputUrl.focus();
    return;
  }

  clearFeedback();
  btnAdd.disabled = true;
  btnAdd.textContent = '⏳ Adding…';

  try {
    const result = await sendMessage({ type: 'ADD_DOWNLOAD', url, options: { filename, folder, streams } });
    inputUrl.value = '';
    inputFilename.value = '';
    showFeedback('success',
      `Download queued: <strong>${escHtml(result.filename)}</strong>`);
    setTimeout(clearFeedback, 3500);
  } catch (err) {
    showFeedback('error', `Could not add download: ${escHtml(err.message)}`);
  } finally {
    btnAdd.disabled = false;
    btnAdd.textContent = '↓ Download';
  }
}

async function handleClearCompleted() {
  await sendMessage({ type: 'CLEAR_COMPLETED' });
}

function handleListClick(event) {
  const article = event.target.closest('.dl-item');
  if (!article) return;
  const id = article.dataset.id;

  if (event.target.closest('.action-pause')) {
    sendMessage({ type: 'PAUSE_DOWNLOAD', id });

  } else if (event.target.closest('.action-resume')) {
    sendMessage({ type: 'RESUME_DOWNLOAD', id });

  } else if (event.target.closest('.action-retry')) {
    sendMessage({ type: 'RETRY_DOWNLOAD', id });

  } else if (event.target.closest('.action-cancel')) {
    const state = article.dataset.state;
    // Confirm before cancelling an in-progress or paused download
    if (state === 'downloading' || state === 'paused') {
      if (!confirm('Cancel this download?\nProgress will be lost and cannot be recovered.')) return;
    }
    sendMessage({ type: 'CANCEL_DOWNLOAD', id });

  } else if (event.target.closest('.action-copy-url')) {
    const url = article.dataset.url;
    if (url) {
      navigator.clipboard.writeText(url)
        .then(() => showToast('URL copied to clipboard', 'info'))
        .catch(() => showToast('Could not access clipboard', 'error'));
    }

  } else if (event.target.closest('.action-show-in-explorer')) {
    const chromeDownloadId = parseInt(article.dataset.chromeDownloadId, 10);
    if (!isNaN(chromeDownloadId)) {
      sendMessage({ type: 'SHOW_IN_EXPLORER', chromeDownloadId });
    }

  } else if (event.target.closest('.action-toggle-log')) {
    const logPanel = article.querySelector('.dl-item__log-panel');
    if (!logPanel.classList.contains('hidden')) {
      logPanel.classList.add('hidden');
    } else {
      fetchAndRenderLog(article, id);
    }

  } else if (event.target.closest('.action-refresh-log')) {
    fetchAndRenderLog(article, id);

  } else if (event.target.closest('.action-close-log')) {
    article.querySelector('.dl-item__log-panel').classList.add('hidden');
  }
}

// ─── Log Panel ────────────────────────────────────────────────────────────────

async function fetchAndRenderLog(el, id) {
  const logPanel  = el.querySelector('.dl-item__log-panel');
  const entriesEl = logPanel.querySelector('.log-panel__entries');
  // Show panel immediately with loading indicator
  entriesEl.innerHTML =
    '<div class="log-entry log-entry--info">'
    + '<span class="log-entry__ts"></span>'
    + '<span class="log-entry__level">⏳</span>'
    + '<span class="log-entry__msg">Lade Log…</span>'
    + '</div>';
  logPanel.classList.remove('hidden');
  try {
    const result = await sendMessage({ type: 'GET_DOWNLOAD_LOG', id });
    renderLogEntries(entriesEl, result.entries || []);
  } catch (err) {
    entriesEl.innerHTML =
      `<div class="log-entry log-entry--error"><span class="log-entry__ts"></span>`
      + `<span class="log-entry__level">✕</span>`
      + `<span class="log-entry__msg">${escHtml(err.message)}</span></div>`;
  }
}

function renderLogEntries(el, entries) {
  if (entries.length === 0) {
    el.innerHTML =
      '<div class="log-entry log-entry--info">'
      + '<span class="log-entry__ts"></span>'
      + '<span class="log-entry__level">i</span>'
      + '<span class="log-entry__msg" style="color:#484f58;font-style:italic">Keine Log-Einträge vorhanden.</span>'
      + '</div>';
    return;
  }

  const LEVEL_ICON = { info: 'ℹ', warn: '⚠', error: '✕' };

  el.innerHTML = entries.map((e) => {
    const safeLevel = ['info', 'warn', 'error'].includes(e.level) ? e.level : 'info';

    // Separator lines (lines of ─ or =)
    const isSep = /^[─=]{5,}/.test(e.msg);
    if (isSep) {
      return '<div class="log-entry log-entry--separator">'
        + '<span class="log-entry__ts"></span>'
        + '<span class="log-entry__level"></span>'
        + `<span class="log-entry__msg">${escHtml(e.msg)}</span>`
        + '</div>';
    }

    const time = new Date(e.ts).toLocaleTimeString('de-DE',
      { hour: '2-digit', minute: '2-digit', second: '2-digit' });

    return `<div class="log-entry log-entry--${safeLevel}">`
      + `<span class="log-entry__ts">${escHtml(time)}</span>`
      + `<span class="log-entry__level">${LEVEL_ICON[safeLevel]}</span>`
      + `<span class="log-entry__msg">${escHtml(e.msg)}</span>`
      + '</div>';
  }).join('');

  // Scroll to latest entry
  el.scrollTop = el.scrollHeight;
}

// ─── Rendering ────────────────────────────────────────────────────────────────

/**
 * Reconcile the DOM with the current download list.
 * Creates rows for new items, updates existing ones, removes deleted ones.
 */
function renderDownloadList(downloads) {
  if (!Array.isArray(downloads)) return;

  const currentIds = new Set(downloads.map((d) => d.id));

  // Remove stale DOM nodes
  for (const [id, el] of itemElements) {
    if (!currentIds.has(id)) {
      el.remove();
      itemElements.delete(id);
      prevStates.delete(id);
    }
  }

  for (const d of downloads) {
    let el = itemElements.get(d.id);
    if (!el) {
      el = createItemElement(d);
      downloadList.appendChild(el);
      itemElements.set(d.id, el);
    }

    // Detect state transitions and fire toasts
    const prev = prevStates.get(d.id);
    if (prev && prev !== d.state) onStateTransition(d, prev);
    prevStates.set(d.id, d.state);

    updateItemElement(el, d);
  }

  emptyState.classList.toggle('hidden', downloads.length > 0);
  renderSummaryBar(downloads);
}

/** Clone the <template> and stamp in the id/url dataset attributes. */
function createItemElement(d) {
  const clone   = itemTemplate.content.cloneNode(true);
  const article = clone.querySelector('.dl-item');
  article.dataset.id  = d.id;
  article.dataset.url = d.url;
  return article;
}

/**
 * Updates every visible field of a download card.
 * @param {HTMLElement} el
 * @param {object} d  sanitized download item from the SW
 */
function updateItemElement(el, d) {
  el.dataset.state = d.state;
  el.dataset.url   = d.url;

  // ── Filename + badges
  const filenameEl = el.querySelector('.dl-item__filename');
  filenameEl.textContent = d.filename;
  filenameEl.title       = d.filename;

  const stateBadge = el.querySelector('.dl-item__state-badge');
  stateBadge.textContent = stateLabel(d.state);
  stateBadge.className   = `dl-item__state-badge badge badge--${d.state}`;

  const modeBadge = el.querySelector('.dl-item__mode-badge');
  if (d.mode === 'multi-stream') {
    modeBadge.textContent = `${d.streams}× streams`;
    modeBadge.classList.remove('hidden');
  } else if (d.mode === 'single-stream') {
    modeBadge.textContent = '1× stream';
    modeBadge.classList.remove('hidden');
  } else {
    modeBadge.classList.add('hidden');
  }

  // ── URL row
  const urlEl = el.querySelector('.dl-item__url');
  urlEl.textContent = truncateUrl(d.url, 52);
  urlEl.title       = d.url;  // full URL on hover

  // ── Folder row (only visible when a subfolder is set)
  const folderRow = el.querySelector('.dl-item__folder-row');
  if (d.folder) {
    folderRow.classList.remove('hidden');
    el.querySelector('.dl-item__folder-text').textContent =
      `Downloads / ${d.folder}`;
  } else {
    folderRow.classList.add('hidden');
  }

  // ── Step row (current processing step, visible while pending/downloading)
  const stepRow  = el.querySelector('.dl-item__step-row');
  const stepText = el.querySelector('.dl-item__step-text');
  const showStep = (d.state === 'downloading' || d.state === 'pending') && d.step;
  stepRow.classList.toggle('hidden', !showStep);
  if (showStep) stepText.textContent = d.step;

  // ── Progress bar
  const pct = d.progress !== null ? d.progress : 0;
  el.querySelector('.progress-bar__fill').style.width = `${pct}%`;
  const progressBar = el.querySelector('.progress-bar');
  progressBar.setAttribute('aria-valuenow', pct);
  progressBar.setAttribute('aria-label', `${d.filename}: ${pct}% complete`);
  el.querySelector('.dl-item__percent').textContent =
    d.progress !== null ? `${pct}%` : '–%';

  // ── Info grid
  let sizeText = '–';
  if (d.totalBytes > 0) {
    sizeText = `${formatBytes(d.downloadedBytes)} / ${formatBytes(d.totalBytes)}`;
  } else if (d.downloadedBytes > 0) {
    sizeText = formatBytes(d.downloadedBytes);
  }
  setCell(el, '.dl-item__size', sizeText);

  setCell(el, '.dl-item__speed',
    d.state === 'downloading' && d.currentSpeedBps > 0
      ? formatSpeed(d.currentSpeedBps) : '–');

  setCell(el, '.dl-item__avg-speed',
    d.avgSpeedBps > 0 ? formatSpeed(d.avgSpeedBps) : '–');

  setCell(el, '.dl-item__eta',
    d.state === 'downloading' ? formatEta(d.etaSeconds) : '–');

  if (d.mode === 'multi-stream' && d.chunksTotal > 0) {
    setCell(el, '.dl-item__chunks', `${d.chunksDone} / ${d.chunksTotal}`);
  } else if (d.mode === 'single-stream') {
    setCell(el, '.dl-item__chunks', 'single stream');
  } else if (d.mode === 'detecting') {
    setCell(el, '.dl-item__chunks', 'detecting…');
  } else {
    setCell(el, '.dl-item__chunks', '–');
  }

  setCell(el, '.dl-item__duration', formatDuration(d));
  setCell(el, '.dl-item__started', d.startedAt ? formatTimestamp(d.startedAt) : '–');
  setCell(el, '.dl-item__type', d.contentType ? simplifyMime(d.contentType) : '–');

  // ── Queue position row
  const queueRow = el.querySelector('.dl-item__queue-row');
  if (d.state === 'pending' && d.queuePosition != null) {
    queueRow.classList.remove('hidden');
    el.querySelector('.dl-item__queue-text').textContent =
      d.queuePosition === 1
        ? 'Starting next…'
        : `Position ${d.queuePosition} in queue – waiting for a free slot`;
  } else {
    queueRow.classList.add('hidden');
  }

  // ── Retry warning
  const retryRow = el.querySelector('.dl-item__retry-row');
  if (d.retryCount > 0 && d.state === 'downloading') {
    retryRow.classList.remove('hidden');
    el.querySelector('.dl-item__retry-text').textContent =
      `${d.retryCount} chunk retr${d.retryCount === 1 ? 'y' : 'ies'} – unstable connection detected`;
  } else {
    retryRow.classList.add('hidden');
  }

  // ── Error panel
  const errorPanel = el.querySelector('.dl-item__error-panel');
  if (d.state === 'error' && d.error) {
    errorPanel.classList.remove('hidden');
    el.querySelector('.dl-item__error-detail').textContent = d.error;
  } else {
    errorPanel.classList.add('hidden');
  }

  // ── Action buttons
  toggle(el, '.action-pause',  d.state === 'downloading');
  toggle(el, '.action-resume', d.state === 'paused');
  toggle(el, '.action-cancel',
    d.state === 'downloading' || d.state === 'paused' || d.state === 'pending');

  // ── Im Explorer anzeigen (nur bei abgeschlossenen Downloads)
  el.dataset.chromeDownloadId = d.chromeDownloadId ?? '';
  toggle(el, '.action-show-in-explorer',
    d.state === 'completed' && d.chromeDownloadId != null);
}

// ─── Summary Bar ──────────────────────────────────────────────────────────────
function renderSummaryBar(downloads) {
  const active   = downloads.filter((d) => d.state === 'downloading');
  const queued   = downloads.filter((d) => d.state === 'pending');
  const totalBps = active.reduce((sum, d) => sum + (d.currentSpeedBps || 0), 0);

  summaryBar.hidden = active.length === 0 && queued.length === 0;
  summaryActive.textContent = `${active.length} active`;
  summaryQueued.textContent = `${queued.length} queued`;
  summarySpeed.textContent  = totalBps > 0 ? `⬇ ${formatSpeed(totalBps)} total` : '';
}

// ─── Toast Notifications ──────────────────────────────────────────────────────
function onStateTransition(d, prevState) {
  if (d.state === 'completed') {
    const size = d.totalBytes > 0 ? formatBytes(d.totalBytes) : formatBytes(d.downloadedBytes);
    showToast(`✓ ${d.filename} – complete (${size} in ${formatDuration(d)})`, 'success', 5000);
  } else if (d.state === 'error') {
    showToast(`✕ ${d.filename} – failed: ${d.error}`, 'error', 8000);
  } else if (d.state === 'downloading' && prevState === 'pending') {
    showToast(`↓ ${d.filename} – started`, 'info', 2500);
  } else if (d.state === 'paused' && prevState === 'downloading') {
    showToast(`⏸ ${d.filename} – paused`, 'info', 2000);
  }
}

function showToast(message, type = 'info', duration = 4000) {
  const toast = document.createElement('div');
  toast.className = `toast toast--${type}`;
  toast.textContent = message;
  toastContainer.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add('toast--visible'));
  const dismiss = () => {
    toast.classList.remove('toast--visible');
    toast.addEventListener('transitionend', () => toast.remove(), { once: true });
  };
  const timer = setTimeout(dismiss, duration);
  toast.addEventListener('click', () => { clearTimeout(timer); dismiss(); });
}

// ─── Form Feedback ────────────────────────────────────────────────────────────
function showFeedback(type, htmlContent) {
  addFeedback.className = `feedback feedback--${type}`;
  addFeedback.innerHTML = htmlContent;
  addFeedback.classList.remove('hidden');
}

function clearFeedback() {
  addFeedback.className = 'feedback hidden';
  addFeedback.innerHTML = '';
}

// ─── Pure Helpers ─────────────────────────────────────────────────────────────

function stateLabel(state) {
  return {
    pending:     '⏳ Queued',
    downloading: '↓ Downloading',
    paused:      '⏸ Paused',
    completed:   '✓ Completed',
    error:       '✕ Failed',
    cancelled:   '— Cancelled',
  }[state] || state;
}

function toggle(el, selector, visible) {
  const node = el.querySelector(selector);
  if (node) node.classList.toggle('hidden', !visible);
}

function setCell(el, selector, text) {
  const node = el.querySelector(selector);
  if (node) node.textContent = text;
}

function truncateUrl(url, maxLen) {
  if (url.length <= maxLen) return url;
  try {
    const u     = new URL(url);
    const short = u.hostname + u.pathname;
    return short.length <= maxLen ? short : short.slice(0, maxLen - 1) + '…';
  } catch {
    return url.slice(0, maxLen - 1) + '…';
  }
}

function formatTimestamp(ts) {
  if (!ts) return '–';
  return new Date(ts).toLocaleTimeString(undefined, {
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}

function formatDuration(d) {
  if (!d.startedAt) return '–';
  const end = d.completedAt || Date.now();
  const sec = Math.max(0, Math.floor((end - d.startedAt) / 1000));
  if (sec < 60)   return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ${String(sec % 60).padStart(2, '0')}s`;
  return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`;
}

function simplifyMime(mime) {
  if (!mime) return '–';
  const base = mime.split(';')[0].trim().toLowerCase();
  const known = {
    'application/octet-stream':     'Binary',
    'application/zip':              'ZIP Archive',
    'application/x-zip-compressed': 'ZIP Archive',
    'application/x-7z-compressed':  '7-Zip Archive',
    'application/x-rar-compressed': 'RAR Archive',
    'application/pdf':              'PDF Document',
    'application/msword':           'Word Document',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'Word Document',
    'application/x-msdownload':     'Windows Executable',
    'application/x-iso9660-image':  'Disk Image (ISO)',
    'video/mp4':                    'MP4 Video',
    'video/x-matroska':             'MKV Video',
    'video/webm':                   'WebM Video',
    'audio/mpeg':                   'MP3 Audio',
    'audio/ogg':                    'OGG Audio',
    'image/jpeg':                   'JPEG Image',
    'image/png':                    'PNG Image',
    'image/gif':                    'GIF Image',
    'text/plain':                   'Plain Text',
    'application/json':             'JSON',
  };
  return known[base] || base;
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Wraps chrome.runtime.sendMessage in a Promise.
 * Rejects on runtime error or if the response contains { error }.
 */
function sendMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (response && response.error) {
        reject(new Error(response.error));
        return;
      }
      resolve(response);
    });
  });
}
