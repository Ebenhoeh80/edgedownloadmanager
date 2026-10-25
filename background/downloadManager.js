/**
 * DownloadManager
 * Core business logic: multi-stream chunk downloading, pause/resume,
 * speed calculation, state management.
 */

import { generateId, formatBytes, formatSpeed, mergeChunks } from './utils.js';

// ─── Constants ────────────────────────────────────────────────────────────────

/** Default number of parallel streams per download */
const DEFAULT_STREAMS = 4;

/** Maximum simultaneous downloads running at once */
const MAX_CONCURRENT_DOWNLOADS = 3;

/** Chunk size per stream when total file size is unknown (4 MB) */
const FALLBACK_CHUNK_SIZE = 4 * 1024 * 1024;

/** Timeout for a single fetch request in milliseconds */
const FETCH_TIMEOUT_MS = 30_000;

/** How many automatic retries per chunk on network errors */
const MAX_CHUNK_RETRIES = 3;

// ─── Download States ──────────────────────────────────────────────────────────
export const DownloadState = {
  PENDING: 'pending',
  DOWNLOADING: 'downloading',
  PAUSED: 'paused',
  COMPLETED: 'completed',
  ERROR: 'error',
  CANCELLED: 'cancelled',
};

// ─── DownloadManager Class ────────────────────────────────────────────────────
export class DownloadManager {
  constructor() {
    /** @type {Map<string, DownloadItem>} */
    this._items = new Map();

    /** @type {Set<string>} ids of downloads currently running */
    this._active = new Set();
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /**
   * Add a new download to the queue and start it if capacity allows.
   * @param {string} url
   * @param {{ streams?: number, filename?: string }} options
   */
  async addDownload(url, options = {}) {
    // ── Security: validate URL in SW (defence-in-depth – popup also validates)
    if (!isValidDownloadUrl(url)) {
      log.warn('addDownload: rejected invalid URL', url);
      throw new Error('Invalid or unsafe URL – only http:// and https:// are supported');
    }

    const id = generateId();
    const rawFilename = options.filename || deriveFilename(url);
    const filename    = sanitizeFilename(rawFilename);   // strip Windows-illegal chars
    const folder      = sanitizeFolder(options.folder || '');

    if (filename !== rawFilename) {
      log.warn('addDownload: filename sanitised', { raw: rawFilename, clean: filename });
    }
    if (folder !== (options.folder || '')) {
      log.warn('addDownload: folder sanitised',   { raw: options.folder, clean: folder });
    }

    const item = {
      id,
      url,
      filename,
      folder,
      streams: Math.min(Math.max(options.streams || DEFAULT_STREAMS, 1), 16),
      state: DownloadState.PENDING,
      totalBytes: 0,
      downloadedBytes: 0,
      startedAt: null,
      completedAt: null,
      queuedAt: Date.now(),
      error: null,
      contentType: null,    // MIME type from Content-Type header
      retryCount: 0,        // total chunk retries across the lifetime of this download
      _mode: null,          // 'detecting' | 'multi-stream' | 'single-stream'
      // Speed tracking
      speedSamples: [],          // { ts: number, bytes: number }[]
      currentSpeedBps: 0,
      avgSpeedBps: 0,
      etaSeconds: null,
      // Internal: AbortControllers per chunk, indexed by chunk index
      _abortControllers: {},
      // Chunk state for resume
      _chunks: [],               // { index, start, end, downloaded, done }[]
      _supportsRanges: null,
      _eventLog: [],             // per-download structured event log
      _step: '⏳ Warte in der Warteschlange…',  // current human-readable step
    };

    this._items.set(id, item);
    _addLog(item, 'info', `▶ Download eingereiht`);
    _addLog(item, 'info', `  Dateiname : ${item.filename}`);
    _addLog(item, 'info', `  URL       : ${url}`);
    _addLog(item, 'info', `  Streams   : ${item.streams}`);
    _addLog(item, 'info', `  Zielordner: ${item.folder ? `Downloads/${item.folder}` : '(Downloads-Stammordner)'}`);
    _addLog(item, 'info', `  ID        : ${item.id}`);
    this._persistState();
    this._scheduleNext();
    return { id, filename: item.filename };
  }

  pauseDownload(id) {
    const item = this._items.get(id);
    if (!item || item.state !== DownloadState.DOWNLOADING) return { ok: false };
    item.state = DownloadState.PAUSED;
    item._step = '⏸ Pausiert';
    _addLog(item, 'info', 'Paused by user');
    this._abortAllChunks(item);
    this._active.delete(id);
    this._persistState();
    this._scheduleNext();
    return { ok: true };
  }

  resumeDownload(id) {
    const item = this._items.get(id);
    if (!item || item.state !== DownloadState.PAUSED) return { ok: false };
    item.state = DownloadState.PENDING;
    item._step = '⏳ Wird wieder eingereiht…';
    _addLog(item, 'info', 'Resumed by user – re-queued');
    this._persistState();
    this._scheduleNext();
    return { ok: true };
  }

  cancelDownload(id) {
    const item = this._items.get(id);
    if (!item) return { ok: false };
    item.state = DownloadState.CANCELLED;
    item._step = '— Abgebrochen';
    _addLog(item, 'warn', 'Cancelled by user');
    this._abortAllChunks(item);
    this._active.delete(id);
    this._persistState();
    this._scheduleNext();
    return { ok: true };
  }

  retryDownload(id) {
    const item = this._items.get(id);
    if (!item) return { ok: false };
    if (![DownloadState.ERROR, DownloadState.CANCELLED].includes(item.state)) return { ok: false };
    // Reset download state for a clean retry
    item.state = DownloadState.PENDING;
    item.error = null;
    item.retryCount = 0;
    item.downloadedBytes = 0;
    item.totalBytes = 0;
    item.currentSpeedBps = 0;
    item.avgSpeedBps = 0;
    item.etaSeconds = null;
    item.startedAt = null;
    item.completedAt = null;
    item.chromeDownloadId = null;
    item._chunks = [];
    item._supportsRanges = null;
    item._mode = null;
    item.speedSamples = [];
    item._objectUrl = null;
    item._step = '⏳ Warte in der Warteschlange… (Neuversuch)';
    item.queuedAt = Date.now();
    _addLog(item, 'info', 'Retried by user – re-queued from scratch');
    this._persistState();
    this._scheduleNext();
    return { ok: true };
  }

  getAllDownloads() {
    const items = [...this._items.values()].map((item) => this._sanitizeItem(item));

    // Annotate pending items with their queue position (ordered by queuedAt)
    let pos = 1;
    for (const item of items) {
      item.queuePosition = item.state === 'pending' ? pos++ : null;
    }
    return items;
  }

  clearCompleted() {
    for (const [id, item] of this._items) {
      if ([DownloadState.COMPLETED, DownloadState.CANCELLED, DownloadState.ERROR].includes(item.state)) {
        this._items.delete(id);
      }
    }
    this._persistState();
    return { ok: true };
  }

  /** Revokes the blob URL for a completed/interrupted chrome download. */
  revokeObjectUrl(chromeDownloadId) {
    const item = [...this._items.values()].find(
      (i) => i.chromeDownloadId === chromeDownloadId
    );
    if (!item?._objectUrl) return;
    const url = item._objectUrl;
    item._objectUrl = null;
    // Fire-and-forget: send revoke to offscreen doc (it may already be gone)
    chrome.runtime.sendMessage({ type: 'REVOKE_OBJECT_URL', url }).catch(() => {});
  }

  /** Returns the full event log for a single download (fetched on demand). */
  getDownloadLog(id) {
    const item = this._items.get(id);
    return { id, entries: item ? (item._eventLog || []) : [] };
  }

  /**
   * Restore an item from persisted storage (called on SW startup).
   * Items that were actively downloading are moved to PAUSED so the user
   * can decide to resume.
   */
  restoreItem(item) {
    if (item.state === DownloadState.DOWNLOADING) {
      item.state = DownloadState.PAUSED;
    }
    // Reset runtime-only fields
    item._abortControllers = {};
    item.speedSamples = [];
    item.currentSpeedBps = 0;
    item.avgSpeedBps = 0;
    item.etaSeconds = null;
    item._mode      = item._mode      || null;
    item.retryCount = item.retryCount || 0;
    item.contentType = item.contentType || null;
    item.queuedAt   = item.queuedAt   || null;
    item._chunks    = item._chunks    || [];
    item._eventLog  = item._eventLog  || [];
    item._step      = '⏸ Pausiert (SW-Neustart)';
    _addLog(item, 'info', 'Service Worker restarted – download state restored');
    this._items.set(item.id, item);
  }

  // ── Private: Scheduling ────────────────────────────────────────────────────

  _scheduleNext() {
    if (this._active.size >= MAX_CONCURRENT_DOWNLOADS) return;

    const next = [...this._items.values()].find(
      (item) => item.state === DownloadState.PENDING
    );
    if (!next) return;

    next.state = DownloadState.DOWNLOADING;
    next.startedAt = next.startedAt || Date.now();
    next._step = '🔌 Verbindung wird aufgebaut…';
    _addLog(next, 'info', `🔌 Download gestartet (aktive Slots: ${this._active.size + 1}/${MAX_CONCURRENT_DOWNLOADS})`);
    this._active.add(next.id);
    this._runDownload(next).catch((err) => {
      next.state = DownloadState.ERROR;
      next.error = err.message;
      next._step = '✕ Fehler';
      _addLog(next, 'error', `✕ Download fehlgeschlagen: ${err.message}`);
      _addLog(next, 'error', `  Heruntergeladen: ${formatBytes(next.downloadedBytes)} / ${next.totalBytes > 0 ? formatBytes(next.totalBytes) : 'unbekannt'}`);
      this._active.delete(next.id);
      this._persistState();
      this._scheduleNext();
    });
  }

  // ── Private: Core Download Logic ───────────────────────────────────────────

  async _runDownload(item) {
    item._mode = 'detecting';
    item._step = '🔍 Server wird abgefragt (HEAD)…';
    log.info('_runDownload: begin', { id: item.id, url: item.url, streams: item.streams });
    _addLog(item, 'info', `Download started (${item.streams} streams requested)`);
    try {
      // Step 1: HEAD request to determine file size and Range support
      const meta = await this._fetchMeta(item.url);
      item.totalBytes = meta.contentLength;
      item._supportsRanges = meta.supportsRanges;
      item.contentType = meta.contentType;
      item._step = `📊 Server erkannt: ${meta.contentLength > 0 ? formatBytes(meta.contentLength) : 'Größe unbekannt'}, Range-Support: ${meta.supportsRanges ? 'ja' : 'nein'}`;
      _addLog(item, 'info',
        `HEAD response: size=${meta.contentLength > 0 ? formatBytes(meta.contentLength) : 'unknown'}` +
        `, ranges=${meta.supportsRanges ? 'yes' : 'no'}` +
        `, type=${meta.contentType || 'unknown'}`);

      if (!meta.supportsRanges || meta.contentLength === 0) {
        // Fallback: server does not support Range requests – single stream
        log.info('_runDownload: single-stream mode',
          { id: item.id, contentLength: meta.contentLength, supportsRanges: meta.supportsRanges });
        _addLog(item, 'info', '📥 Modus: Einzelstream (Server unterstützt keine Range-Requests)');
        await this._downloadSingleStream(item);
      } else {
        // Multi-stream: split into parallel byte-range chunks
        log.info('_runDownload: multi-stream mode',
          { id: item.id, contentLength: meta.contentLength, streams: item.streams });
        _addLog(item, 'info',
          `📥 Modus: Multi-Stream – ${item.streams} parallele Chunks × ${formatBytes(Math.ceil(meta.contentLength / item.streams))}`);
        await this._downloadMultiStream(item);
      }
    } catch (err) {
      if (item.state === DownloadState.PAUSED || item.state === DownloadState.CANCELLED) {
        log.info('_runDownload: aborted intentionally', { id: item.id, state: item.state });
        return; // Expected abort – not an error
      }
      log.error('_runDownload: failed', { id: item.id, error: err.message });
      throw new Error(classifyError(err));
    }
  }

  /**
   * HEAD request to get Content-Length and Accept-Ranges header.
   */
  async _fetchMeta(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    try {
      const response = await fetch(url, {
        method: 'HEAD',
        signal: controller.signal,
      });
      clearTimeout(timer);

      const contentLength = parseInt(response.headers.get('content-length') || '0', 10);
      const acceptRanges = response.headers.get('accept-ranges');
      const supportsRanges = acceptRanges === 'bytes' && contentLength > 0;
      const contentType = response.headers.get('content-type') || null;

      return { contentLength, supportsRanges, contentType };
    } catch {
      clearTimeout(timer);
      // If HEAD fails, assume no range support
      return { contentLength: 0, supportsRanges: false };
    }
  }

  /**
   * Single-stream fallback: streams the entire response body.
   */
  async _downloadSingleStream(item) {
    item._mode = 'single-stream';
    item._step = '↓ Datei wird heruntergeladen (Einzelstream)…';
    _addLog(item, 'info', '⬇ Einzelstream-Download startet…');
    const controller = new AbortController();
    item._abortControllers[-1] = controller;

    const response = await this._fetchWithTimeout(item.url, {
      signal: controller.signal,
    });

    if (!response.ok) throw new Error(classifyHttpStatus(response.status));

    const reader = response.body.getReader();
    const chunks = [];

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      // Check if paused or cancelled between reads
      if (item.state !== DownloadState.DOWNLOADING) {
        reader.cancel();
        return;
      }

      chunks.push(value);
      item.downloadedBytes += value.byteLength;
      this._updateSpeed(item, value.byteLength);
    }

    const blob = new Blob(chunks);
    _addLog(item, 'info', `⬇ Einzelstream abgeschlossen: ${formatBytes(blob.size)} empfangen`);
    item._step = '💾 Datei wird gespeichert…';
    await this._saveFile(item, blob);
    this._completeItem(item);
  }

  /**
   * Multi-stream download: splits the file into N chunks and fetches in parallel.
   */
  async _downloadMultiStream(item) {
    item._mode = 'multi-stream';
    const { totalBytes, streams } = item;

    // Initialize chunk metadata (only on first run, not resume)
    if (item._chunks.length === 0) {
      item._chunks = buildChunkPlan(totalBytes, streams);
    }

    // Filter out already-completed chunks (resume support)
    const pending = item._chunks.filter((c) => !c.done);
    const totalChunks = item._chunks.length;
    const doneSoFar = totalChunks - pending.length;
    item._step = `↓ Chunks werden geladen: ${doneSoFar}/${totalChunks}…`;
    if (doneSoFar > 0) {
      _addLog(item, 'info', `↺ Fortsetzen: ${doneSoFar}/${totalChunks} Chunks bereits fertig, ${pending.length} ausstehend`);
    } else {
      _addLog(item, 'info', `⬇ Multi-Stream-Download startet: ${totalChunks} Chunks`);
      item._chunks.forEach((c, i) => _addLog(item, 'info',
        `  Chunk ${i + 1}: bytes ${c.start}–${c.end} (${formatBytes(c.end - c.start + 1)})`));
    }

    // Download pending chunks with limited concurrency
    await this._downloadChunksWithConcurrency(item, pending);

    if (item.state !== DownloadState.DOWNLOADING) return;

    // All chunks done – merge and save
    _addLog(item, 'info', `🔗 Alle ${totalChunks} Chunks geladen – werden zusammengeführt…`);
    item._step = '🔗 Chunks werden zusammengeführt…';
    const sortedChunks = [...item._chunks].sort((a, b) => a.index - b.index);
    const blob = mergeChunks(sortedChunks);
    _addLog(item, 'info', `🔗 Zusammenführen abgeschlossen: ${formatBytes(blob.size)} gesamt`);
    item._step = '💾 Datei wird gespeichert…';
    await this._saveFile(item, blob);
    this._completeItem(item);
  }

  /**
   * Downloads an array of chunk descriptors with bounded concurrency.
   */
  async _downloadChunksWithConcurrency(item, chunks) {
    let index = 0;
    const concurrency = item.streams;

    async function worker() {
      while (index < chunks.length) {
        if (item.state !== DownloadState.DOWNLOADING) return;
        const chunk = chunks[index++];
        await this._downloadChunk(item, chunk);
      }
    }

    const workers = Array.from({ length: concurrency }, () => worker.call(this));
    await Promise.all(workers);
  }

  /**
   * Downloads a single byte-range chunk with retry logic.
   */
  async _downloadChunk(item, chunk) {
    for (let attempt = 0; attempt < MAX_CHUNK_RETRIES; attempt++) {
      if (item.state !== DownloadState.DOWNLOADING) return;

      const controller = new AbortController();
      item._abortControllers[chunk.index] = controller;

      try {
        const response = await this._fetchWithTimeout(item.url, {
          headers: { Range: `bytes=${chunk.start}-${chunk.end}` },
          signal: controller.signal,
        });

        if (!response.ok && response.status !== 206) {
          throw new Error(classifyHttpStatus(response.status));
        }

        const buffer = await response.arrayBuffer();
        chunk.data = new Uint8Array(buffer);
        chunk.done = true;
        item.downloadedBytes += buffer.byteLength;
        this._updateSpeed(item, buffer.byteLength);
        delete item._abortControllers[chunk.index];
        // Update live step counter
        const done = item._chunks.filter((c) => c.done).length;
        item._step = `↓ Chunks werden geladen: ${done}/${item._chunks.length}…`;
        log.debug('chunk done',
          { id: item.id, chunkIdx: chunk.index, bytes: buffer.byteLength });
        return;

      } catch (err) {
        delete item._abortControllers[chunk.index];

        if (item.state !== DownloadState.DOWNLOADING) return; // Intentional abort

        item.retryCount++;
        log.warn('chunk retry',
          { id: item.id, chunkIdx: chunk.index, attempt: attempt + 1, error: err.message });
        _addLog(item, 'warn',
          `Chunk ${chunk.index + 1} retry #${attempt + 1}/${MAX_CHUNK_RETRIES}: ${err.message}`);

        if (attempt < MAX_CHUNK_RETRIES - 1) {
          // Exponential back-off: 500 ms, 1 s, 2 s …
          await sleep(500 * Math.pow(2, attempt));
        } else {
          const reason = classifyError(err);
          throw new Error(
            `Chunk ${chunk.index + 1}/${item._chunks.length} failed after ${MAX_CHUNK_RETRIES} retries: ${reason}`
          );
        }
      }
    }
  }

  // ── Private: Speed Tracking ────────────────────────────────────────────────

  /**
   * Records downloaded bytes and recalculates speed/ETA.
   * Uses a rolling 5-second window of samples.
   */
  _updateSpeed(item, bytesJustReceived) {
    const now = Date.now();
    item.speedSamples.push({ ts: now, bytes: bytesJustReceived });

    // Remove samples older than 5 seconds
    const cutoff = now - 5000;
    item.speedSamples = item.speedSamples.filter((s) => s.ts >= cutoff);

    const windowBytes = item.speedSamples.reduce((acc, s) => acc + s.bytes, 0);
    item.currentSpeedBps = windowBytes / 5; // bytes per second

    // Average speed since start
    const elapsed = (now - item.startedAt) / 1000;
    item.avgSpeedBps = elapsed > 0 ? item.downloadedBytes / elapsed : 0;

    // ETA
    const remaining = item.totalBytes - item.downloadedBytes;
    item.etaSeconds = item.currentSpeedBps > 0 ? remaining / item.currentSpeedBps : null;
  }

  // ── Private: Helpers ────────────────────────────────────────────────────────

  _fetchWithTimeout(url, options = {}) {
    const controller = new AbortController();

    // Chain with any caller-provided signal
    if (options.signal) {
      options.signal.addEventListener('abort', () => controller.abort());
    }

    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    return fetch(url, { ...options, signal: controller.signal }).finally(() =>
      clearTimeout(timer)
    );
  }

  _abortAllChunks(item) {
    for (const ctrl of Object.values(item._abortControllers)) {
      ctrl.abort();
    }
    item._abortControllers = {};
  }

  /**
   * Triggers the browser's built-in download save dialog via chrome.downloads API.
   * If item.folder is set, the file is placed in that subfolder within Downloads.
   *
   * URL.createObjectURL is NOT available in MV3 service workers, so we delegate
   * that call to an offscreen document which has full DOM access.
   */
  async _saveFile(item, blob) {
    // Build the relative path: 'Subfolder/filename.zip' or just 'filename.zip'
    const relPath = item.folder
      ? `${item.folder}/${item.filename}`
      : item.filename;

    log.info('_saveFile: starting', { id: item.id, relPath, blobSize: blob.size });
    _addLog(item, 'info', `Saving: "${relPath}" (${formatBytes(blob.size)})`);

    // Blobs are NOT structured-cloneable via chrome.runtime.sendMessage, so
    // we extract the raw bytes and MIME type and let the offscreen doc rebuild the Blob.
    const arrayBuffer = await blob.arrayBuffer();
    const objectUrl = await _createObjectUrlViaOffscreen(arrayBuffer, blob.type);
    item._objectUrl = objectUrl; // stored so the SW can revoke it via onChanged

    // Store the chrome download ID so the popup can later call chrome.downloads.show()
    item.chromeDownloadId = await chrome.downloads.download({
      url: objectUrl,
      filename: relPath,
      saveAs: false,
    });
    log.info('_saveFile: chrome download started',
      { id: item.id, chromeDownloadId: item.chromeDownloadId, relPath });
    _addLog(item, 'info', `Browser download started (chromeDownloadId: ${item.chromeDownloadId})`);
    // The blob URL is revoked by the SW via chrome.downloads.onChanged (see service-worker.js)
  }

  _completeItem(item) {
    item.state = DownloadState.COMPLETED;
    item.completedAt = Date.now();
    item.downloadedBytes = item.totalBytes || item.downloadedBytes;
    item.currentSpeedBps = 0;
    item.etaSeconds = null;
    item._step = '✓ Abgeschlossen';
    const durSec = item.startedAt
      ? Math.round((item.completedAt - item.startedAt) / 1000) : 0;
    _addLog(item, 'info', '─'.repeat(40));
    _addLog(item, 'info', `✓ Download abgeschlossen`);
    _addLog(item, 'info', `  Größe     : ${formatBytes(item.downloadedBytes)}`);
    _addLog(item, 'info', `  Dauer     : ${durSec}s`);
    _addLog(item, 'info',
      item.avgSpeedBps > 0
        ? `  Ø Speed   : ${formatSpeed(item.avgSpeedBps)}`
        : `  Ø Speed   : –`);
    _addLog(item, 'info', `  Streams   : ${item.streams} (Modus: ${item._mode || '–'})`);
    _addLog(item, 'info', `  Zielordner: ${item.folder ? `Downloads/${item.folder}` : '(Downloads-Stammordner)'}`);
    if (item.chromeDownloadId != null) {
      _addLog(item, 'info', `  Chrome-ID : ${item.chromeDownloadId}`);
    }
    if (item.retryCount > 0) {
      _addLog(item, 'warn', `  Retries   : ${item.retryCount} Chunk-Wiederholungen`);
    }
    _addLog(item, 'info', '─'.repeat(40));
    // Auto-register folder as known so it appears in the datalist next time
    if (item.folder) {
      chrome.storage.local.get('knownFolders', ({ knownFolders }) => {
        const set = new Set(knownFolders || []);
        set.add(item.folder);
        chrome.storage.local.set({ knownFolders: [...set] });
      });
    }
    this._active.delete(item.id);
    this._persistState();
    this._scheduleNext();
  }

  /**
   * Returns a serializable copy of the item (no Uint8Array data, no controllers).
   * Safe to pass to chrome.storage.local or postMessage.
   */
  _sanitizeItem(item) {
    const chunks     = item._chunks || [];
    const chunksDone  = chunks.filter((c) => c.done).length;
    const chunksTotal = chunks.length;
    return {
      step: item._step || '',
      id: item.id,
      url: item.url,
      filename: item.filename,
      folder: item.folder || '',
      streams: item.streams,
      state: item.state,
      totalBytes: item.totalBytes,
      downloadedBytes: item.downloadedBytes,
      startedAt: item.startedAt,
      completedAt: item.completedAt,
      queuedAt: item.queuedAt,
      chromeDownloadId: item.chromeDownloadId ?? null,
      error: item.error,
      contentType: item.contentType,
      retryCount: item.retryCount,
      mode: item._mode,
      chunksTotal,
      chunksDone,
      currentSpeedBps: item.currentSpeedBps,
      avgSpeedBps: item.avgSpeedBps,
      etaSeconds: item.etaSeconds,
      progress: item.totalBytes > 0
        ? Math.floor((item.downloadedBytes / item.totalBytes) * 100)
        : null,
    };
  }

  /**
   * Persist serializable state to chrome.storage.local.
   * Chunk data (Uint8Array) is intentionally excluded – only metadata is saved.
   */
  _persistState() {
    const serializable = {};
    for (const [id, item] of this._items) {
      serializable[id] = this._sanitizeItem(item);
    }
    chrome.storage.local.set({ downloads: serializable });
  }
}

// ─── Module-level helpers ─────────────────────────────────────────────────────

/** Structured logger – prefixes all output with [DM] and a level tag. */
const log = {
  info:  (...a) => console.log( '[DM][INFO]',  ...a),
  warn:  (...a) => console.warn( '[DM][WARN]',  ...a),
  error: (...a) => console.error('[DM][ERROR]', ...a),
  debug: (...a) => console.debug('[DM][DEBUG]', ...a),
};

/**
 * Appends a structured log entry to item._eventLog and forwards to the console.
 * The log is NOT persisted to storage – it lives only in memory for the SW lifetime.
 * @param {object} item
 * @param {'info'|'warn'|'error'} level
 * @param {string} msg
 */
function _addLog(item, level, msg) {
  if (!item._eventLog) item._eventLog = [];
  item._eventLog.push({ ts: Date.now(), level, msg });
  log[level](`[${item.id.slice(0, 6)}] ${msg}`);
}

/**
 * Validates that a URL is a safe http/https URL (defence-in-depth).
 * This mirrors the check in the popup but runs server-side in the SW.
 */
function isValidDownloadUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Removes characters that are illegal in Windows filenames and trims
 * leading/trailing dots and spaces (which Windows also rejects).
 * Illegal chars: < > : " / \ | ? *  and control characters (0x00–1f).
 * @param {string} name
 * @returns {string}
 */
function sanitizeFilename(name) {
  if (!name || typeof name !== 'string') return 'download';
  // Replace illegal Windows filename chars with underscore
  // eslint-disable-next-line no-control-regex
  let clean = name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_');
  // Trim leading/trailing dots and spaces
  clean = clean.replace(/^[. ]+|[. ]+$/g, '');
  return clean || 'download';
}

/**
 * Splits a file of `totalBytes` into `count` evenly-sized chunks.
 * @returns {{ index: number, start: number, end: number, done: boolean, data: null }[]}
 */
function buildChunkPlan(totalBytes, count) {
  const chunkSize = Math.ceil(totalBytes / count);
  const chunks = [];
  for (let i = 0; i < count; i++) {
    const start = i * chunkSize;
    const end = Math.min(start + chunkSize - 1, totalBytes - 1);
    if (start > totalBytes - 1) break;
    chunks.push({ index: i, start, end, done: false, data: null });
  }
  return chunks;
}

/**
 * Creates an object URL for the given Blob by delegating to an offscreen
 * document, which has DOM access (URL.createObjectURL) unlike MV3 SWs.
 * @param {Blob} blob
 * @param {ArrayBuffer} arrayBuffer  Raw bytes of the download
 * @param {string}      mimeType     MIME type of the original Blob
 * @returns {Promise<string>} object URL
 */
async function _createObjectUrlViaOffscreen(arrayBuffer, mimeType) {
  const offscreenUrl = chrome.runtime.getURL('offscreen/offscreen.html');

  // Create the offscreen document only if it doesn't already exist
  const existing = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [offscreenUrl],
  });

  if (existing.length === 0) {
    await chrome.offscreen.createDocument({
      url: offscreenUrl,
      reasons: ['BLOBS'],
      justification: 'Create object URL for assembled download blob in MV3 service worker',
    });
  }

  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(
      // ArrayBuffer is structured-cloneable; Blob is NOT – hence we pass raw bytes
      { type: 'CREATE_OBJECT_URL', arrayBuffer, mimeType },
      (response) => {
        if (chrome.runtime.lastError) {
          return reject(new Error(chrome.runtime.lastError.message));
        }
        if (response?.url) return resolve(response.url);
        reject(new Error(response?.error || 'Offscreen document returned no URL'));
      }
    );
  });
}

/**
 * Sanitizes a user-supplied folder string so it is safe to pass as a
 * relative path to chrome.downloads.download({ filename }).
 * – Strips leading / trailing slashes and whitespace
 * – Removes any '..' segments (prevents path traversal)
 * – Collapses duplicate slashes
 * – Returns an empty string if the result is empty
 * @param {string} folder
 * @returns {string}
 */
function sanitizeFolder(folder) {
  if (!folder || typeof folder !== 'string') return '';
  return folder
    .trim()
    .replace(/\\/g, '/')          // normalize backslashes
    .split('/')
    .filter((seg) => seg.length > 0 && seg !== '.')  // remove empty / dot
    .filter((seg) => seg !== '..')                    // block traversal
    .join('/');
}

/**
 * Translates a fetch/network Error into a human-readable message.
 */
function classifyError(err) {
  if (!err) return 'Unknown error';
  if (err.name === 'AbortError' || String(err.message).toLowerCase().includes('abort')) {
    return 'Connection timed out (30 s limit reached)';
  }
  if (String(err.message).includes('Failed to fetch') || String(err.message).includes('NetworkError')) {
    return 'Network connection lost – check your internet connection';
  }
  if (String(err.message).includes('CORS')) {
    return 'Server blocked the request (CORS policy)';
  }
  return err.message || 'Unknown network error';
}

/**
 * Translates an HTTP status code into a human-readable error string.
 */
function classifyHttpStatus(status) {
  const map = {
    400: 'Bad request sent to server (HTTP 400)',
    401: 'Authentication required – login needed (HTTP 401)',
    403: 'Access denied – file is not public (HTTP 403)',
    404: 'File not found on server (HTTP 404)',
    408: 'Server request timed out (HTTP 408)',
    410: 'File no longer available – removed from server (HTTP 410)',
    429: 'Rate limited – too many requests, try again later (HTTP 429)',
    500: 'Internal server error (HTTP 500)',
    502: 'Bad gateway – upstream server unreachable (HTTP 502)',
    503: 'Server temporarily unavailable (HTTP 503)',
    504: 'Gateway timed out (HTTP 504)',
  };
  return map[status] ?? `Unexpected server response (HTTP ${status})`;
}

/** Derives a filename from a URL, falling back to 'download'. */
function deriveFilename(url) {
  try {
    const pathname = new URL(url).pathname;
    const parts = pathname.split('/').filter(Boolean);
    const last = parts[parts.length - 1] || 'download';
    return decodeURIComponent(last);
  } catch {
    return 'download';
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
