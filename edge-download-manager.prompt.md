---
description: Erstellt die vollständige Microsoft Edge Download Manager Erweiterung (MV3, v1.9.0) von Grund auf
---

Entwickle eine vollständige, produktionsreife **Microsoft Edge Browser-Erweiterung** (Manifest V3) die als leistungsfähiger Download-Manager fungiert. Schreibe alle Dateien vollständig – keine Platzhalter, keine Auslassungen.

---

## Dateistruktur

```
edge-download-manager/
├── manifest.json
├── icons/
│   ├── icon16.png
│   ├── icon48.png
│   └── icon128.png
├── background/
│   ├── service-worker.js
│   ├── downloadManager.js
│   └── utils.js
├── offscreen/
│   ├── offscreen.html
│   └── offscreen.js
└── popup/
    ├── popup.html
    ├── popup.css
    └── popup.js
```

---

## manifest.json

```json
{
  "manifest_version": 3,
  "name": "Edge Download Manager",
  "version": "1.9.0",
  "description": "A powerful multi-stream download manager for Microsoft Edge",
  "icons": { "16": "icons/icon16.png", "48": "icons/icon48.png", "128": "icons/icon128.png" },
  "action": {
    "default_popup": "popup/popup.html",
    "default_title": "Download Manager",
    "default_icon": { "16": "icons/icon16.png", "48": "icons/icon48.png" }
  },
  "background": { "service_worker": "background/service-worker.js", "type": "module" },
  "permissions": ["downloads", "storage", "alarms", "offscreen"],
  "host_permissions": ["<all_urls>"],
  "content_security_policy": {
    "extension_pages": "script-src 'self'; object-src 'self'"
  }
}
```

---

## background/utils.js

Exportiert:
- `generateId()` – 8 random bytes via `crypto.getRandomValues`, als Hex-String
- `formatBytes(bytes)` – z. B. `"4.20 MB"`, Units: B/KB/MB/GB/TB
- `formatSpeed(bps)` – ruft `formatBytes` auf, hängt `/s` an
- `formatEta(seconds)` – `null/Infinity → "–"`, sonst `"HH:MM:SS"` oder `"MM:SS"`
- `mergeChunks(chunks)` – sortiertes Array von `{data: Uint8Array}` → `Blob`
- `isValidHttpUrl(url)` – `new URL(url)`, prüft `protocol === 'http:' || 'https:'`

---

## background/downloadManager.js

### Konstanten
```js
const DEFAULT_STREAMS          = 4;
const MAX_CONCURRENT_DOWNLOADS = 3;
const FALLBACK_CHUNK_SIZE      = 4 * 1024 * 1024;  // 4 MB
const FETCH_TIMEOUT_MS         = 30_000;
const MAX_CHUNK_RETRIES        = 3;
```

### Modul-Level Logging

```js
const log = {
  info:  (...a) => console.info ('[DLM]', ...a),
  warn:  (...a) => console.warn ('[DLM]', ...a),
  error: (...a) => console.error('[DLM]', ...a),
  debug: (...a) => console.debug('[DLM]', ...a),
};

function _addLog(item, level, msg) {
  item._eventLog.push({ ts: Date.now(), level, msg });
  log[level](msg);
}
```

### DownloadState-Enum
`PENDING | DOWNLOADING | PAUSED | COMPLETED | ERROR | CANCELLED`

### Item-Objekt (alle Felder)
```js
{
  id, url,
  filename,          // aus options.filename oder URL-Pfad abgeleitet (sanitizeFilename)
  folder,            // sanitizeFolder(options.folder || '') – relativ zu Downloads
  streams,           // geklammert: min 1, max 16
  state,
  totalBytes, downloadedBytes,
  startedAt, completedAt, queuedAt,
  error, contentType, retryCount,
  chromeDownloadId,  // zurückgegeben von chrome.downloads.download()
  _mode,             // 'detecting' | 'multi-stream' | 'single-stream'
  speedSamples,      // { ts, bytes }[] – gleitendes 5-Sekunden-Fenster
  currentSpeedBps, avgSpeedBps, etaSeconds,
  _abortControllers, _chunks, _supportsRanges,
  _eventLog,         // { ts: number, level: 'info'|'warn'|'error', msg: string }[]
  _step,             // aktueller menschenlesbarer Schritt (für Popup-Anzeige)
}
```

### Öffentliche API der Klasse `DownloadManager`
- `addDownload(url, options)` → `{ id, filename }`
- `pauseDownload(id)` → `{ ok }`
- `resumeDownload(id)` → `{ ok }` (nur aus `PAUSED`)
- `cancelDownload(id)` → `{ ok }`
- `retryDownload(id)` → `{ ok }` (aus `ERROR` oder `CANCELLED` – vollständiger Reset + Neustart)
- `getAllDownloads()` – gibt sanitized Items zurück, annotiert `queuePosition` für pending items
- `clearCompleted()` – entfernt COMPLETED/CANCELLED/ERROR
- `restoreItem(item)` – beim SW-Start; DOWNLOADING → PAUSED, Runtime-Felder zurücksetzen
- `getDownloadLog(id)` → `{ id, entries: _eventLog[] }`

### `_step`-Werte im Download-Ablauf
| Zeitpunkt | `_step`-Wert |
|---|---|
| `addDownload` | `'⏳ Warte in der Warteschlange…'` |
| `resumeDownload` | `'⏳ Wird wieder eingereiht…'` |
| `_scheduleNext` | `'🔌 Verbindung wird aufgebaut…'` |
| `_runDownload` start | `'🔍 Server wird abgefragt (HEAD)…'` |
| Nach HEAD | `'📊 Server erkannt: X MB, Range-Support: ja/nein'` |
| Einzelstream | `'↓ Datei wird heruntergeladen (Einzelstream)…'` |
| Multi-Stream | `'↓ Chunks werden geladen: N/M…'` (live aktualisiert) |
| Zusammenführen | `'🔗 Chunks werden zusammengeführt…'` |
| Speichern | `'💾 Datei wird gespeichert…'` |
| Abgeschlossen | `'✓ Abgeschlossen'` |
| Pausiert | `'⏸ Pausiert'` |
| Fehler | `'✕ Fehler'` |
| Abgebrochen | `'— Abgebrochen'` |

### Download-Ablauf
1. **HEAD-Request** → Content-Length, Accept-Ranges, Content-Type
2. Wenn `Accept-Ranges: bytes` und `Content-Length > 0` → **Multi-Stream**
3. Sonst → **Single-Stream** (ReadableStream, chunks-Array → Blob)
4. Multi-Stream: `buildChunkPlan(totalBytes, streams)` → N gleichmäßige Byte-Ranges
5. Chunk-Download mit bounded Concurrency (= `item.streams` Worker)
6. Pro Chunk: bis zu `MAX_CHUNK_RETRIES` Versuche, exponentielles Backoff 500ms/1s/2s
7. Nach Abschluss: Chunks mergen → `_saveFile(item, blob)`

### `_addLog`-Einträge (Überblick, pro Schritt)
- `addDownload`: Dateiname, URL, Streams, Zielordner, ID
- `_scheduleNext`: aktive Slots
- `_runDownload`: HEAD-Antwort (Größe, Ranges, Content-Type), Modus-Entscheid
- Multi-Stream: Chunk-Plan (Byte-Ranges) beim ersten Start; Fortschritt beim Fortsetzen
- Chunk-Retry: Nummer, Versuch, Fehlermeldung
- `_saveFile`: Zielpfad, Blob-Größe, Chrome-Download-ID
- `_completeItem`: Trennlinie `─×40`, Größe, Dauer, Ø-Speed, Streams/Modus, Zielordner, Chrome-ID, Retry-Anzahl
- Fehler: Fehlermeldung + bereits heruntergeladene Bytes

### `retryDownload(id)` – vollständiger Reset
Setzt folgende Felder zurück: `state → PENDING`, `error → null`, `retryCount/downloadedBytes/totalBytes/currentSpeedBps/avgSpeedBps/etaSeconds/startedAt/completedAt/chromeDownloadId → 0/null`, `_chunks → []`, `_supportsRanges/mode → null`, `speedSamples → []`, `_step`, `queuedAt → Date.now()`. Ruft dann `_scheduleNext()`.

### `_saveFile` – KRITISCH (MV3-Einschränkung)
`URL.createObjectURL` ist in MV3 Service Workers **nicht** verfügbar. Lösung: Offscreen-Dokument.

```js
async _saveFile(item, blob) {
  const relPath = item.folder ? `${item.folder}/${item.filename}` : item.filename;
  const arrayBuffer = await blob.arrayBuffer();
  // ArrayBuffer ist structured-cloneable, Blob ist es NICHT
  const objectUrl = await _createObjectUrlViaOffscreen(arrayBuffer, blob.type);
  item.chromeDownloadId = await chrome.downloads.download({
    url: objectUrl,
    filename: relPath,
    saveAs: false,
  });
  // Offscreen-Dokument macht URL.revokeObjectURL nach 90 s
}
```

### `_createObjectUrlViaOffscreen(arrayBuffer, mimeType)`
```js
async function _createObjectUrlViaOffscreen(arrayBuffer, mimeType) {
  const offscreenUrl = chrome.runtime.getURL('offscreen/offscreen.html');
  const existing = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [offscreenUrl],
  });
  if (existing.length === 0) {
    await chrome.offscreen.createDocument({
      url: offscreenUrl,
      reasons: ['BLOBS'],  // WICHTIG: 'BLOBS' – nicht 'BLOB_URL'
      justification: 'Create object URL for assembled download blob in MV3 service worker',
    });
  }
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(
      { type: 'CREATE_OBJECT_URL', arrayBuffer, mimeType },
      (response) => {
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        if (response?.url) return resolve(response.url);
        reject(new Error(response?.error || 'Offscreen document returned no URL'));
      }
    );
  });
}
```

### `_completeItem` – Auto-Registrierung des Ordners
Nach Abschluss: wenn `item.folder` gesetzt, wird der Ordner automatisch zu `knownFolders` in `chrome.storage.local` hinzugefügt.

### Sicherheits-Hilfsfunktionen
- `sanitizeFilename(name)` – ersetzt Windows-illegale Zeichen `<>:"/\|?*\x00-\x1f` durch `_`, trimmt führende/abschließende Punkte+Leerzeichen
- `sanitizeFolder(folder)` – Backslashes → `/`, splitten, filtert leere Segmente, `.`, `..` (kein Path-Traversal), rejoin
- `isValidDownloadUrl(url)` – prüft `http:`/`https:`, blockiert `localhost` und private IP-Ranges
- `classifyError(err)` – übersetzt `AbortError`, `Failed to fetch`, `NetworkError`, `CORS` in lesbare Strings
- `classifyHttpStatus(status)` – Map: 400/401/403/404/408/410/429/500/502/503/504 → lesbarer String

### `_sanitizeItem(item)` – gibt zurück
```js
{
  id, url, filename, folder, streams, state,
  totalBytes, downloadedBytes, startedAt, completedAt, queuedAt,
  chromeDownloadId, error, contentType, retryCount, mode,
  chunksTotal, chunksDone,
  currentSpeedBps, avgSpeedBps, etaSeconds,
  progress,  // 0–100 oder null
  step,      // item._step || ''
}
```

### `_updateSpeed(item, bytesJustReceived)`
- Gleitendes 5-Sekunden-Fenster für `currentSpeedBps`
- `avgSpeedBps = downloadedBytes / elapsedSeconds`
- `etaSeconds = remainingBytes / currentSpeedBps`

---

## background/service-worker.js

- Importiert `DownloadManager` als ES-Modul (`type: "module"` in manifest)
- Beim Start: `chrome.storage.local.get('downloads')` → `manager.restoreItem()` für jedes Item
- `chrome.runtime.onMessage` → async `handleMessage()` → `return true` für async sendResponse

### Message-Typen
| Typ | Aktion |
|---|---|
| `ADD_DOWNLOAD` | `manager.addDownload(url, options)` |
| `PAUSE_DOWNLOAD` | `manager.pauseDownload(id)` |
| `RESUME_DOWNLOAD` | `manager.resumeDownload(id)` |
| `CANCEL_DOWNLOAD` | `manager.cancelDownload(id)` |
| `RETRY_DOWNLOAD` | `manager.retryDownload(id)` |
| `GET_ALL_DOWNLOADS` | `manager.getAllDownloads()` |
| `CLEAR_COMPLETED` | `manager.clearCompleted()` |
| `GET_DOWNLOAD_LOG` | `manager.getDownloadLog(message.id)` |
| `GET_KNOWN_FOLDERS` | `chrome.storage.local.get('knownFolders')` → `{ folders: string[] }` |
| `SAVE_KNOWN_FOLDER` | Fügt `message.folder` zu `knownFolders` hinzu (Set-Deduplizierung) |
| `OPEN_DOWNLOADS_FOLDER` | Sucht in `chrome.downloads.search` nach dem letzten Download im Zielordner → `show(id)`, Fallback: `showDefaultFolder()` |
| `SHOW_IN_EXPLORER` | `chrome.downloads.show(message.chromeDownloadId)` |

- Alarm `broadcastState` alle 2 Sekunden (`periodInMinutes: 1/30`)
- Alarm-Handler: `manager.getAllDownloads()` → `chrome.runtime.sendMessage({ type: 'STATE_UPDATE', downloads })` (Fehler ignorieren)

---

## offscreen/offscreen.html

Minimale HTML-Seite, lädt `offscreen.js` (KEIN `type="module"`, normales Script).

## offscreen/offscreen.js

```js
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type !== 'CREATE_OBJECT_URL') return false;
  try {
    const blob = new Blob([message.arrayBuffer], {
      type: message.mimeType || 'application/octet-stream'
    });
    const objectUrl = URL.createObjectURL(blob);
    setTimeout(() => URL.revokeObjectURL(objectUrl), 90_000);
    sendResponse({ url: objectUrl });
  } catch (err) {
    sendResponse({ error: err.message });
  }
  return false;
});
```

---

## popup/popup.html

**Breite 500px, max-height 620px.**

Struktur:
1. `<header>` – Titel mit SVG-Download-Icon + `#btn-clear` (Clear finished)
2. `<div class="summary-bar" hidden>` – `#summary-active`, `#summary-queued`, `#summary-speed`
3. `<section class="add-form">`:
   - `.input-row` – `#input-url` (type=url)
   - `.options-row` – `#input-filename` (input--sm), `#input-streams` (select: 1/2/4✓/8/16), `#btn-add`
   - `<datalist id="folder-suggestions">` – **leer im HTML**, wird dynamisch per JS befüllt
   - `.folder-row` – 📁-Icon, Label "Zielordner", `#input-folder` (`list="folder-suggestions"`, freies Textfeld, placeholder "z. B. Videos/Filme"), `#btn-save-folder`, `#btn-open-folder` (📂 Öffnen)
   - `#add-feedback` (role=alert, aria-live=polite)
4. `<section class="download-list" id="download-list">` mit `#empty-state`
5. `<div class="toast-container" id="toast-container" aria-live="assertive">`
6. `<template id="tpl-download-item">`:
   - Row 1: `.dl-item__filename` + `.dl-item__badge-group` (`.dl-item__mode-badge.badge.badge--mode.hidden` + `.dl-item__state-badge.badge`)
   - Row 2: `.dl-item__url-row` (`.dl-item__url` + `.btn--icon.action-copy-url`)
   - Row 2b: `.dl-item__folder-row.hidden` (📁-Span + `.dl-item__folder-text`)
   - Row 2c: `.dl-item__step-row.hidden[aria-live=polite]` (`.dl-item__step-spinner` + `.dl-item__step-text`)
   - Row 3: `.dl-item__progress-row` (`.progress-bar[role=progressbar]` > `.progress-bar__fill` + `.dl-item__percent`)
   - Row 4: `.dl-item__info-grid` – 8 `.info-cell`: Size, Speed, Avg Speed, ETA, Chunks, Duration, Started, Type
   - Row 5: `.dl-item__queue-row.hidden` (🕐 + `.dl-item__queue-text`)
   - Row 6: `.dl-item__retry-row.hidden` (⚠ + `.dl-item__retry-text`)
   - Row 7: `.dl-item__error-panel.hidden[role=alert]` (✕-Icon + `.error-panel__body` + `.btn.action-retry`)
   - Row 8: `.dl-item__actions` – Pause (⏸), Resume (▶, btn--primary), Cancel (✕, btn--danger), `.action-show-in-explorer.hidden` (📂 Im Explorer), `.action-toggle-log` (📋 Log)
   - Row 9: `.dl-item__log-panel.hidden` – `.log-panel__header` (Titel + ↺ `action-refresh-log` + ✕ `action-close-log`) + `.log-panel__entries[aria-live=polite]`

---

## popup/popup.css

### Design Tokens (`:root`)
```css
--color-bg, --color-surface, --color-surface-2, --color-border
--color-text, --color-text-muted
--color-primary: #0078d4, --color-primary-dark: #005a9e
--color-danger: #d13438, --color-success: #107c10
--color-warning: #f59e0b, --color-warning-bg: #fef3c7, --color-error-bg: #fef2f2
--badge-pending/downloading/paused/completed/error/cancelled/mode
--radius-sm: 4px, --radius-md: 8px
--shadow-sm, --shadow-md
--transition: 150ms ease
--popup-width: 500px
```

### Dark Mode (`@media (prefers-color-scheme: dark)`)
Überschreibt: bg/surface/border/text/primary, warning-bg, error-bg, shadows.

### Komponenten
- **body**: `width: 500px; max-height: 620px; overflow: hidden; font-family: 'Segoe UI'`
- **summary-bar**: blauer Balken, weiße Schrift, `display:flex`
- **add-form**: `display:flex; flex-direction:column; gap:7px`
- **folder-row**: `display:flex; align-items:center; gap:8px`
- **input**: volle Breite, focus-Ring `box-shadow: 0 0 0 2px rgba(0,120,212,.18)`
- **btn Varianten**: `--primary`, `--ghost`, `--danger`, `--sm`, `--icon`
- **feedback**: `--error` (roter linker Rand), `--success` (grüner linker Rand)
- **dl-item**: Card, linker farbiger Border nach State: downloading→primary, completed→success, error→danger, paused→warning
- **badge**: Pill-Form; `.badge--downloading` mit `pulse-badge` Keyframe (opacity 1↔0.6, 1.4s)
- **info-grid**: `grid-template-columns: repeat(4, 1fr)`, `background: --color-surface`
- **dl-item__folder-row**: `font-size:11px; font-style:italic; color:--color-text-muted`
- **dl-item__step-row**: `display:flex; align-items:center; gap:6px; font-size:11.5px; color:--color-primary; font-weight:500`
  - `.dl-item__step-spinner`: 9px Kreis-Border, `animation: spin-step 0.7s linear infinite`
  - Bei `data-state="pending"`: grau statt blau
- **queue-row**: muted, 12px
- **retry-row**: warning-bg, amber text
- **error-panel**: error-bg, danger text, `border: 1px solid rgba(209,52,56,.25)`
- **dl-item__log-panel**: Terminal-Style, `background: #0d1117; border: 1px solid #30363d`
  - `.log-panel__header`: `background: #161b22`, 11px, grau
  - `.log-panel__entries`: `max-height: 220px; overflow-y: auto; scrollbar-width: thin`
  - `.log-entry`: `grid-template-columns: 62px 16px 1fr`, `font-family: Consolas/monospace`, 10.5px
  - `.log-entry__ts`: `color: #484f58`, 10px
  - `.log-entry--info`: Level-Icon blau `#388bfd`, Nachricht `#cdd9e5`
  - `.log-entry--warn`: Level-Icon gelb `#d29922`, Nachricht `#e3b341`
  - `.log-entry--error`: Level-Icon rot `#f85149`, Nachricht `#ff7b72`
  - `.log-entry--separator`: `opacity: .35; color: #8b949e` – für Trennlinien ohne Zeitstempel
- **`.hidden`**: `display:none !important`
- **toast**: dark bg, animiert (`opacity 0→1`, `translateY 8px→0`); Varianten: `--success`, `--error`, `--info`

---

## popup/popup.js

### DOM-Referenzen
`inputUrl, inputFilename, inputFolder, inputStreams, btnAdd, btnSaveFolder, btnOpenFolder, btnClear, addFeedback, downloadList, emptyState, itemTemplate, summaryBar, summaryActive, summaryQueued, summarySpeed, toastContainer`

### Runtime-State
```js
const itemElements = new Map();  // id → article-Element
const prevStates   = new Map();  // id → letzter bekannter State (für Toast-Transitions)
let prevFolderValue = '';         // Wert vor Fokus – für Revert bei Abbruch
let knownFolders = [];            // aus storage geladene bekannte Ordner
```

### `init()` (async IIFE)
1. `chrome.storage.local.get('defaultFolder')` → `inputFolder.value`; `prevFolderValue = inputFolder.value`
2. `sendMessage({ type: 'GET_KNOWN_FOLDERS' })` → `knownFolders`; `populateFolderDatalist(knownFolders)`
3. `sendMessage({ type: 'GET_ALL_DOWNLOADS' })` → `renderDownloadList(downloads)`
4. `chrome.runtime.onMessage` → bei `STATE_UPDATE`: `renderDownloadList(message.downloads)`

### Datalist-Helper
```js
function populateFolderDatalist(folders) {
  const dl = document.getElementById('folder-suggestions');
  dl.innerHTML = '';
  for (const f of folders) {
    const opt = document.createElement('option');
    opt.value = f;
    dl.appendChild(opt);
  }
}
```

### Event-Listener
- `btnAdd` → `handleAddDownload()`
- `btnSaveFolder` → `handleSaveFolder()`
- `btnOpenFolder` → `handleOpenFolder()`
- `btnClear` → `handleClearCompleted()`
- `inputUrl` keydown Enter → `handleAddDownload()`
- `inputFolder` focus → `prevFolderValue = inputFolder.value`
- `downloadList` click → `handleListClick()` (delegiert)

### `handleSaveFolder()`
1. Wenn `folder` unbekannt (nicht in `knownFolders`): `confirm('Ordner "Downloads/X" ist noch nicht bekannt. Anlegen?')`
   - Nein → `inputFolder.value = prevFolderValue`; return
   - Ja → `sendMessage({ type: 'SAVE_KNOWN_FOLDER', folder })`, `knownFolders` aktualisieren, `populateFolderDatalist`
2. `chrome.storage.local.set({ defaultFolder: folder })`; `prevFolderValue = folder`; Toast anzeigen

### `handleAddDownload()`
1. URL-Validierung (leer / kein http/https → `showFeedback('error', ...)`)
2. Wenn `folder` gesetzt und unbekannt: gleiche `confirm`-Logik wie `handleSaveFolder`
3. `sendMessage({ type: 'ADD_DOWNLOAD', url, options: { filename, folder, streams } })`
4. `showFeedback('success', ...)`, URL/Filename leeren

### `handleListClick(event)`
Delegiert an `.dl-item` → liest `dataset.id`:
- `.action-pause` → `PAUSE_DOWNLOAD`
- `.action-resume` → `RESUME_DOWNLOAD` (nur aus PAUSED)
- `.action-retry` → `RETRY_DOWNLOAD` (aus ERROR/CANCELLED – vollständiger Neustart)
- `.action-cancel` → confirm-Dialog bei state downloading/paused → `CANCEL_DOWNLOAD`
- `.action-copy-url` → `navigator.clipboard.writeText(dataset.url)`
- `.action-show-in-explorer` → `SHOW_IN_EXPLORER` mit `parseInt(dataset.chromeDownloadId, 10)`
- `.action-toggle-log` → `fetchAndRenderLog(article, id)` oder Panel schließen
- `.action-refresh-log` → `fetchAndRenderLog(article, id)`
- `.action-close-log` → Log-Panel verstecken

### `fetchAndRenderLog(el, id)`
- Zeigt sofort Lade-Indikator im Log-Panel
- `sendMessage({ type: 'GET_DOWNLOAD_LOG', id })` → `renderLogEntries(entriesEl, entries)`

### `renderLogEntries(el, entries)`
- Leere Liste → Hinweistext
- `LEVEL_ICON = { info: 'ℹ', warn: '⚠', error: '✕' }`
- Trennlinien (`/^[─=]{5,}/`) → `.log-entry--separator` (ohne Zeitstempel, gedimmt)
- Sonst: `grid-template-columns: 62px 16px 1fr` mit Uhrzeit (de-DE HH:MM:SS), Level-Icon, Nachricht
- Scroll to bottom nach Render

### `updateItemElement(el, d)` – alle Felder
- `el.dataset.state`, `el.dataset.url`, `el.dataset.chromeDownloadId`
- Filename + title
- State-Badge: `badge--${d.state}`, Text via `stateLabel()`
- Mode-Badge: `${d.streams}× streams` / `1× stream` / hidden
- URL: `truncateUrl(d.url, 52)`
- **Folder-Row**: `d.folder` → `"Downloads / ${d.folder}"`, sonst hidden
- **Step-Row**: sichtbar wenn `state === 'downloading' || state === 'pending'` UND `d.step` vorhanden; Text = `d.step`
- Progress-Bar: width, aria-valuenow, percent-Text
- Info-Grid (8 Zellen): Size, Speed, Avg Speed, ETA, Chunks, Duration, Started, Type
- Queue-Row: sichtbar bei `state=pending` mit `queuePosition`
- Retry-Row: sichtbar bei `state=downloading && retryCount > 0`
- Error-Panel: sichtbar bei `state=error`
- **Im-Explorer-Button**: sichtbar bei `state=completed && chromeDownloadId != null`

### `renderSummaryBar(downloads)`
- active = downloading, queued = pending
- `summaryBar.hidden = active + queued === 0`
- Gesamtspeed summiert über alle aktiven Items

### `onStateTransition(d, prevState)`
| Übergang | Toast |
|---|---|
| → completed | `"✓ filename – complete (size in duration)"`, success, 5000ms |
| → error | `"✕ filename – failed: error"`, error, 8000ms |
| pending → downloading | `"↓ filename – started"`, info, 2500ms |
| downloading → paused | `"⏸ filename – paused"`, info, 2000ms |

### `showToast(message, type, duration)`
- `<div class="toast toast--{type}">` erstellen
- `requestAnimationFrame` → `classList.add('toast--visible')`
- Nach `duration` ms: fade out → `transitionend` → `remove()`
- Klick dismissed sofort

### Hilfsfunktionen
- `stateLabel(state)` – ⏳/↓/⏸/✓/✕/—
- `toggle(el, selector, visible)` – `classList.toggle('hidden', !visible)`
- `setCell(el, selector, text)` – querySelector + textContent
- `truncateUrl(url, maxLen)` – `new URL()`, gibt hostname+path zurück
- `formatTimestamp(ts)` – `new Date(ts).toLocaleTimeString()` mit h/m/s
- `formatDuration(d)` – `Xs` / `Xm XXs` / `Xh Xm`
- `simplifyMime(mime)` – Map bekannter MIME-Types auf lesbare Namen (ZIP, MP4, PDF…)
- `escHtml(str)` – escaped `&<>"'`
- `sendMessage(payload)` – Promise-Wrapper um `chrome.runtime.sendMessage`, wirft bei Error
- `showFeedback(type, htmlContent)`, `clearFeedback()`

---

## Wichtige Randbedingungen & bekannte Fallstricke

1. **`URL.createObjectURL` in MV3 SW nicht verfügbar** → zwingend Offscreen-Dokument nutzen
2. **Blob nicht structured-cloneable** → als `ArrayBuffer + mimeType` übertragen, Blob erst im Offscreen-Dokument rekonstruieren
3. **Offscreen-Reason** muss `'BLOBS'` sein (nicht `'BLOB_URL'`)
4. **Relative Pfade** – `chrome.downloads.download({ filename })` akzeptiert nur relative Pfade (relativ zu Downloads-Verzeichnis)
5. **`chromeDownloadId` speichern** – Rückgabewert von `chrome.downloads.download()` für `chrome.downloads.show(id)` benötigt
6. **Alarm-Frequenz** – `periodInMinutes: 1/30` ≈ alle 2 Sekunden
7. **Service Worker Restart** – laufende Downloads auf PAUSED setzen (nicht auto-resume), Blob-Fortschritt ist verloren
8. **`sanitizeFolder`** muss `..`-Segmente blockieren (Path-Traversal-Schutz)
9. **`sanitizeFilename`** – Windows-illegale Zeichen müssen ersetzt werden, sonst schlägt `chrome.downloads.download()` lautlos fehl
10. **`knownFolders`** – in `chrome.storage.local` als `string[]` gespeichert; beim Abschluss eines Downloads automatisch ergänzt; Datalist im Popup wird dynamisch befüllt (kein hardcoded HTML)
11. **Retry vs. Resume** – `RESUME_DOWNLOAD` nur aus PAUSED; `RETRY_DOWNLOAD` nur aus ERROR/CANCELLED – vollständiger Reset, kein Fortsetzen
12. **Popup-Breite** – exakt 500px, max-height 620px

---

## Known-Folders-Workflow

```
inputFolder focus → prevFolderValue merken
Nutzer tippt/wählt Ordner
→ handleSaveFolder oder handleAddDownload
  → folder in knownFolders?
      Ja → weiter
      Nein → confirm("Anlegen?")
               Ja → SAVE_KNOWN_FOLDER → knownFolders aktualisieren → Datalist neu befüllen
               Nein → inputFolder.value = prevFolderValue → return
Download abgeschlossen → _completeItem auto-registriert folder in knownFolders
```

---

## Installation (Developer Mode)

1. Edge öffnen → `edge://extensions`
2. "Entwicklermodus" aktivieren
3. "Entpackte Erweiterung laden" → Ordner `edge-download-manager/` wählen
4. Bei Codeänderungen: Erweiterung in `edge://extensions` neu laden

---

## Dateistruktur

```
edge-download-manager/
├── manifest.json
├── icons/
│   ├── icon16.png   (SVG-Inhalt als .png gespeichert – für Developer Mode ausreichend)
│   ├── icon48.png
│   └── icon128.png
├── background/
│   ├── service-worker.js
│   ├── downloadManager.js
│   └── utils.js
├── offscreen/
│   ├── offscreen.html
│   └── offscreen.js
└── popup/
    ├── popup.html
    ├── popup.css
    └── popup.js
```

---

## manifest.json

```json
{
  "manifest_version": 3,
  "name": "Edge Download Manager",
  "version": "1.4.0",
  "description": "A powerful multi-stream download manager for Microsoft Edge",
  "icons": { "16": "icons/icon16.png", "48": "icons/icon48.png", "128": "icons/icon128.png" },
  "action": {
    "default_popup": "popup/popup.html",
    "default_title": "Download Manager",
    "default_icon": { "16": "icons/icon16.png", "48": "icons/icon48.png" }
  },
  "background": { "service_worker": "background/service-worker.js", "type": "module" },
  "permissions": ["downloads", "storage", "alarms", "offscreen"],
  "host_permissions": ["<all_urls>"],
  "content_security_policy": {
    "extension_pages": "script-src 'self'; object-src 'self'"
  }
}
```

---

## background/utils.js

Exportiert:
- `generateId()` – 8 random bytes via `crypto.getRandomValues`, als Hex-String
- `formatBytes(bytes)` – z. B. `"4.20 MB"`, Units: B/KB/MB/GB/TB
- `formatSpeed(bps)` – ruft `formatBytes` auf, hängt `/s` an
- `formatEta(seconds)` – `null/Infinity → "–"`, sonst `"HH:MM:SS"` oder `"MM:SS"`
- `mergeChunks(chunks)` – sortiertes Array von `{data: Uint8Array}` → `Blob`
- `isValidHttpUrl(url)` – `new URL(url)`, prüft `protocol === 'http:' || 'https:'`

---

## background/downloadManager.js

### Konstanten
```js
const DEFAULT_STREAMS       = 4;
const MAX_CONCURRENT_DOWNLOADS = 3;
const FALLBACK_CHUNK_SIZE   = 4 * 1024 * 1024;  // 4 MB
const FETCH_TIMEOUT_MS      = 30_000;
const MAX_CHUNK_RETRIES     = 3;
```

### DownloadState-Enum
`PENDING | DOWNLOADING | PAUSED | COMPLETED | ERROR | CANCELLED`

### Item-Objekt (alle Felder)
```js
{
  id, url,
  filename,          // aus options.filename oder URL-Pfad abgeleitet
  folder,            // sanitizeFolder(options.folder || '') – relativ zu Downloads
  streams,           // geklammert: min 1, max 16
  state,
  totalBytes, downloadedBytes,
  startedAt, completedAt, queuedAt,
  error, contentType, retryCount,
  chromeDownloadId,  // zurückgegeben von chrome.downloads.download()
  _mode,             // 'detecting' | 'multi-stream' | 'single-stream'
  speedSamples,      // { ts, bytes }[] – gleitendes 5-Sekunden-Fenster
  currentSpeedBps, avgSpeedBps, etaSeconds,
  _abortControllers, _chunks, _supportsRanges
}
```

### Öffentliche API der Klasse `DownloadManager`
- `addDownload(url, options)` → `{ id, filename }`
- `pauseDownload(id)` → `{ ok }`
- `resumeDownload(id)` → `{ ok }`
- `cancelDownload(id)` → `{ ok }`
- `getAllDownloads()` – gibt sanitized Items zurück, annotiert `queuePosition` für pending items
- `clearCompleted()` – entfernt COMPLETED/CANCELLED/ERROR
- `restoreItem(item)` – beim SW-Start; DOWNLOADING → PAUSED, Runtime-Felder zurücksetzen

### Download-Ablauf
1. **HEAD-Request** → Content-Length, Accept-Ranges, Content-Type
2. Wenn `Accept-Ranges: bytes` und `Content-Length > 0` → **Multi-Stream**
3. Sonst → **Single-Stream** (ReadableStream, chunks-Array → Blob)
4. Multi-Stream: `buildChunkPlan(totalBytes, streams)` → N gleichmäßige Byte-Ranges
5. Chunk-Download mit bounded Concurrency (= `item.streams` Worker)
6. Pro Chunk: bis zu `MAX_CHUNK_RETRIES` Versuche, exponentielles Backoff 500ms/1s/2s
7. Nach Abschluss: Chunks mergen → `_saveFile(item, blob)`

### _saveFile – KRITISCH (MV3-Einschränkung)
`URL.createObjectURL` ist in MV3 Service Workers **nicht** verfügbar.  
Lösung: Offscreen-Dokument nutzen.

```js
async _saveFile(item, blob) {
  const relPath = item.folder ? `${item.folder}/${item.filename}` : item.filename;
  const arrayBuffer = await blob.arrayBuffer();
  // ArrayBuffer ist structured-cloneable, Blob ist es NICHT
  const objectUrl = await _createObjectUrlViaOffscreen(arrayBuffer, blob.type);
  item.chromeDownloadId = await chrome.downloads.download({
    url: objectUrl,
    filename: relPath,
    saveAs: false,
  });
  // Offscreen-Dokument macht URL.revokeObjectURL nach 90 s
}
```

### _createObjectUrlViaOffscreen(arrayBuffer, mimeType)
```js
async function _createObjectUrlViaOffscreen(arrayBuffer, mimeType) {
  const offscreenUrl = chrome.runtime.getURL('offscreen/offscreen.html');
  const existing = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [offscreenUrl],
  });
  if (existing.length === 0) {
    await chrome.offscreen.createDocument({
      url: offscreenUrl,
      reasons: ['BLOBS'],  // WICHTIG: 'BLOBS' nicht 'BLOB_URL'
      justification: 'Create object URL for assembled download blob in MV3 service worker',
    });
  }
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(
      { type: 'CREATE_OBJECT_URL', arrayBuffer, mimeType },
      (response) => {
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        if (response?.url) return resolve(response.url);
        reject(new Error(response?.error || 'Offscreen document returned no URL'));
      }
    );
  });
}
```

### sanitizeFolder(folder)
- Backslashes → `/`
- Split nach `/`, filter: leere Segmente, `.`, `..` (kein Path-Traversal)
- Rejoin mit `/`

### classifyError(err)
Übersetzt `AbortError`, `Failed to fetch`, `NetworkError`, `CORS` in lesbare Deutsch/Englische Strings.

### classifyHttpStatus(status)
Map: 400/401/403/404/408/410/429/500/502/503/504 → readable String.

### _sanitizeItem(item) – gibt zurück
```js
{ id, url, filename, folder, streams, state,
  totalBytes, downloadedBytes, startedAt, completedAt, queuedAt,
  chromeDownloadId, error, contentType, retryCount, mode,
  chunksTotal, chunksDone,
  currentSpeedBps, avgSpeedBps, etaSeconds,
  progress }  // 0-100 oder null
```

### _updateSpeed(item, bytesJustReceived)
- Gleitendes 5-Sekunden-Fenster für `currentSpeedBps`
- `avgSpeedBps = downloadedBytes / elapsedSeconds`
- `etaSeconds = remainingBytes / currentSpeedBps`

---

## background/service-worker.js

- Importiert `DownloadManager` als ES-Modul (`type: "module"` in manifest)
- Beim Start: `chrome.storage.local.get('downloads')` → `manager.restoreItem()` für jedes Item
- `chrome.runtime.onMessage` → async `handleMessage()` → `return true` für async sendResponse

### Message-Typen
| Typ | Aktion |
|---|---|
| `ADD_DOWNLOAD` | `manager.addDownload(url, options)` |
| `PAUSE_DOWNLOAD` | `manager.pauseDownload(id)` |
| `RESUME_DOWNLOAD` | `manager.resumeDownload(id)` |
| `CANCEL_DOWNLOAD` | `manager.cancelDownload(id)` |
| `GET_ALL_DOWNLOADS` | `manager.getAllDownloads()` |
| `CLEAR_COMPLETED` | `manager.clearCompleted()` |
| `OPEN_DOWNLOADS_FOLDER` | `chrome.downloads.showDefaultFolder()` |
| `SHOW_IN_EXPLORER` | `chrome.downloads.show(message.chromeDownloadId)` |

- Alarm `broadcastState` alle 2 Sekunden (`periodInMinutes: 1/30`)
- Alarm-Handler: `manager.getAllDownloads()` → `chrome.runtime.sendMessage({ type: 'STATE_UPDATE', downloads })` (Fehler ignorieren, Popup kann geschlossen sein)

---

## offscreen/offscreen.html

Minimale HTML-Seite, lädt `offscreen.js` (KEIN `type="module"`, normales Script).

## offscreen/offscreen.js

```js
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type !== 'CREATE_OBJECT_URL') return false;
  try {
    // Blob aus ArrayBuffer rekonstruieren (Blob selbst ist nicht transferierbar)
    const blob = new Blob([message.arrayBuffer], {
      type: message.mimeType || 'application/octet-stream'
    });
    const objectUrl = URL.createObjectURL(blob);
    setTimeout(() => URL.revokeObjectURL(objectUrl), 90_000);
    sendResponse({ url: objectUrl });
  } catch (err) {
    sendResponse({ error: err.message });
  }
  return false; // synchrone Antwort
});
```

---

## popup/popup.html

**Breite 500px, max-height 620px.**

Struktur:
1. `<header>` – Titel mit SVG-Download-Icon + `#btn-clear` (Clear finished)
2. `<div class="summary-bar" hidden>` – `#summary-active`, `#summary-queued`, `#summary-speed`
3. `<section class="add-form">`:
   - `.input-row` – `#input-url` (type=url)
   - `.options-row` – `#input-filename` (input--sm), `#input-streams` (select: 1/2/4✓/8/16), `#btn-add`
   - `<datalist id="folder-suggestions">` – 18 Vorschläge: Videos, Videos/Filme, Videos/Serien, Videos/YouTube, Musik, Musik/Alben, Bilder, Bilder/Wallpaper, Dokumente, Dokumente/PDFs, Software, Software/Portable, Archive, Games, Games/Mods, Backup, Desktop, Temp
   - `.folder-row` – 📁-Icon, Label "Zielordner", `#input-folder` (list="folder-suggestions", freies Textfeld, placeholder "z. B. Videos/Filme (leer = Downloads-Stammordner)"), `#btn-save-folder`, `#btn-open-folder` (📂 Öffnen)
   - `#add-feedback` (role=alert, aria-live=polite)
4. `<section class="download-list" id="download-list">` mit `#empty-state` (SVG + Texte)
5. `<div class="toast-container" id="toast-container" aria-live="assertive">`
6. `<template id="tpl-download-item">`:
   - Row 1: `.dl-item__filename` + `.dl-item__badge-group` (`.dl-item__mode-badge.badge.badge--mode.hidden` + `.dl-item__state-badge.badge`)
   - Row 2: `.dl-item__url-row` (`.dl-item__url` + `.btn--icon.action-copy-url` mit ⧉)
   - Row 2b: `.dl-item__folder-row.hidden` (📁-Span + `.dl-item__folder-text`)
   - Row 3: `.dl-item__progress-row` (`.progress-bar[role=progressbar]` > `.progress-bar__fill` + `.dl-item__percent`)
   - Row 4: `.dl-item__info-grid` – 8 `.info-cell` mit `.info-label` + `.info-value`: Size, Speed, Avg Speed, ETA, Chunks, Duration, Started, Type
   - Row 5: `.dl-item__queue-row.hidden` (🕐-Span + `.dl-item__queue-text`)
   - Row 6: `.dl-item__retry-row.hidden` (⚠-Span + `.dl-item__retry-text`)
   - Row 7: `.dl-item__error-panel.hidden[role=alert]` (✕-Icon + `.error-panel__body` + `.btn.action-retry`)
   - Row 8: `.dl-item__actions` – Pause (⏸), Resume (▶, btn--primary), Cancel (✕, btn--danger), `.action-show-in-explorer.hidden` (📂 Im Explorer)

---

## popup/popup.css

### Design Tokens (`:root`)
```css
--color-bg, --color-surface, --color-surface-2, --color-border
--color-text, --color-text-muted
--color-primary: #0078d4, --color-primary-dark: #005a9e
--color-danger: #d13438, --color-success: #107c10
--color-warning: #f59e0b, --color-warning-bg: #fef3c7, --color-error-bg: #fef2f2
--badge-pending/downloading/paused/completed/error/cancelled/mode (Farben)
--radius-sm: 4px, --radius-md: 8px
--shadow-sm, --shadow-md
--transition: 150ms ease
--popup-width: 500px
```

### Dark Mode (`@media (prefers-color-scheme: dark)`)
Überschreibt: bg/surface/border/text/primary-Farben, warning-bg, error-bg, shadows.

### Komponenten
- **body**: `width: 500px; max-height: 620px; overflow: hidden; font-family: 'Segoe UI'`
- **summary-bar**: blauer Balken (`--color-primary`), weiße Schrift, `display:flex`
- **add-form**: `display:flex; flex-direction:column; gap:7px`
- **folder-row**: `display:flex; align-items:center; gap:8px`
- **input**: volle Breite, focus-Ring mit `box-shadow: 0 0 0 2px rgba(0,120,212,.18)`
- **btn Varianten**: `--primary`, `--ghost` (border + transparent bg), `--danger` (Rand+Hover fill), `--sm`, `--icon`
- **feedback**: `--error` (roter linker Rand, rotes bg), `--success` (grüner linker Rand)
- **dl-item**: Card mit `border-radius: 8px`, `box-shadow`, linker farbiger Border nach State:
  - downloading → `--color-primary`, completed → `--color-success`, error → `--color-danger`, paused → `--color-warning`
- **badge**: Pill-Form, `.badge--downloading` mit `pulse-badge` Keyframe-Animation (opacity 1↔0.6, 1.4s)
- **info-grid**: `grid-template-columns: repeat(4, 1fr)`, `background: --color-surface`
- **dl-item__folder-row**: `font-size:11px; font-style:italic; color:--color-text-muted`
- **queue-row**: muted, 12px
- **retry-row**: warning-bg, amber text, dark-mode: `#fbbf24`
- **error-panel**: error-bg, danger text, `border: 1px solid rgba(209,52,56,.25)`
- **`.hidden`**: `display:none !important`
- **toast-container**: `position:fixed; bottom:12px; left:50%; transform:translateX(-50%)`
- **toast**: dark bg, animiert (`opacity 0→1`, `translateY 8px→0`), Varianten: `--success` (dunkelgrün + grüner linker Rand), `--error` (dunkelrot), `--info` (dunkelblau)

---

## popup/popup.js

### DOM-Referenzen
`inputUrl, inputFilename, inputFolder, inputStreams, btnAdd, btnSaveFolder, btnOpenFolder, btnClear, addFeedback, downloadList, emptyState, itemTemplate, summaryBar, summaryActive, summaryQueued, summarySpeed, toastContainer`

### Runtime-State
- `itemElements: Map<id, HTMLElement>` – Download-ID → article-Element
- `prevStates: Map<id, string>` – für Toast-State-Transitions

### `init()` (IIFE, async)
1. `chrome.storage.local.get('defaultFolder')` → `inputFolder.value`
2. `sendMessage({ type: 'GET_ALL_DOWNLOADS' })` → `renderDownloadList(downloads)`
3. `chrome.runtime.onMessage.addListener` → bei `STATE_UPDATE`: `renderDownloadList(message.downloads)`

### Event-Listener
- `btnAdd` → `handleAddDownload()`
- `btnSaveFolder` → `handleSaveFolder()` – speichert `defaultFolder` in storage, zeigt Toast
- `btnOpenFolder` → `handleOpenFolder()` – sendet `OPEN_DOWNLOADS_FOLDER`, zeigt Toast
- `btnClear` → `handleClearCompleted()`
- `inputUrl` keydown Enter → `handleAddDownload()`
- `downloadList` click → `handleListClick()` (delegiert)

### handleAddDownload()
- Validiert URL (leer / kein http/https → `showFeedback('error', ...)`)
- Sendet `ADD_DOWNLOAD` mit `{ filename, folder, streams }`
- Zeigt `showFeedback('success', ...)`, leert URL/Filename-Input
- btnAdd während Request deaktivieren + Text "⏳ Adding…"

### handleListClick(event)
Delegiert an `.dl-item` → liest `dataset.id`:
- `.action-pause` → `PAUSE_DOWNLOAD`
- `.action-resume` oder `.action-retry` → `RESUME_DOWNLOAD`
- `.action-cancel` → confirm-Dialog bei state downloading/paused → `CANCEL_DOWNLOAD`
- `.action-copy-url` → `navigator.clipboard.writeText(dataset.url)`
- `.action-show-in-explorer` → `SHOW_IN_EXPLORER` mit `parseInt(dataset.chromeDownloadId, 10)`

### renderDownloadList(downloads)
- Stale DOM-Nodes entfernen
- Neue Items per `createItemElement(d)` (Template klonen) anlegen
- State-Transition-Toasts via `onStateTransition(d, prevState)`
- `updateItemElement(el, d)` für jedes Item
- `emptyState.classList.toggle('hidden', downloads.length > 0)`
- `renderSummaryBar(downloads)`

### updateItemElement(el, d) – alle Felder
- `el.dataset.state`, `el.dataset.url`
- Filename + title
- State-Badge: `badge--${d.state}`, Text via `stateLabel()`
- Mode-Badge: `${d.streams}× streams` / `1× stream` / hidden
- URL row: `truncateUrl(d.url, 52)` + full URL als title
- **Folder-Row**: wenn `d.folder` → `classList.remove('hidden')`, Text `"Downloads / ${d.folder}"`, sonst hidden
- Progress-Bar: width, aria-valuenow, percent-Text
- Info-Grid (8 Zellen via `setCell()`):
  - Size: `formatBytes(downloaded) / formatBytes(total)` oder nur downloaded
  - Speed: nur bei state=downloading und currentSpeedBps > 0
  - Avg Speed: wenn avgSpeedBps > 0
  - ETA: nur bei state=downloading
  - Chunks: `done/total` bei multi-stream, "single stream" bei single-stream, "detecting…"
  - Duration: `formatDuration(d)`
  - Started: `formatTimestamp(d.startedAt)`
  - Type: `simplifyMime(d.contentType)`
- Queue-Row: visible bei state=pending mit queuePosition
- Retry-Row: visible bei state=downloading und retryCount > 0
- Error-Panel: visible bei state=error
- Action-Buttons: pause (downloading), resume (paused), cancel (downloading/paused/pending)
- **Im-Explorer-Button**: `el.dataset.chromeDownloadId = d.chromeDownloadId ?? ''`, visible bei `state=completed && chromeDownloadId != null`

### renderSummaryBar(downloads)
- active = downloading, queued = pending
- `summaryBar.hidden = active.length === 0 && queued.length === 0`
- Total speed summiert über alle active items

### onStateTransition(d, prevState)
| Übergang | Toast |
|---|---|
| → completed | `"✓ filename – complete (size in duration)"`, success, 5000ms |
| → error | `"✕ filename – failed: error"`, error, 8000ms |
| pending → downloading | `"↓ filename – started"`, info, 2500ms |
| downloading → paused | `"⏸ filename – paused"`, info, 2000ms |

### showToast(message, type, duration)
- `<div class="toast toast--{type}">` erstellen
- `requestAnimationFrame` → `classList.add('toast--visible')`
- Nach `duration` ms: `classList.remove('toast--visible')` → `transitionend` → `remove()`
- Klick dismissed sofort

### Hilfsfunktionen
- `stateLabel(state)` – Map auf Icons+Texte: ⏳ Queued, ↓ Downloading, ⏸ Paused, ✓ Completed, ✕ Failed, — Cancelled
- `toggle(el, selector, visible)` – `classList.toggle('hidden', !visible)`
- `setCell(el, selector, text)` – querySelector + textContent
- `truncateUrl(url, maxLen)` – versucht `new URL()`, gibt hostname+path zurück
- `formatTimestamp(ts)` – `new Date(ts).toLocaleTimeString()` mit h/m/s
- `formatDuration(d)` – `(completedAt || now) - startedAt` → Sekunden → `Xs` / `Xm XXs` / `Xh Xm`
- `simplifyMime(mime)` – Map von bekannten MIME-Types auf lesbare Namen (ZIP, MP4, PDF, …)
- `escHtml(str)` – escaped `&<>"'`
- `sendMessage(payload)` – `chrome.runtime.sendMessage(payload)` als Promise, wirft bei `chrome.runtime.lastError` oder `response.error`
- `showFeedback(type, htmlContent)`, `clearFeedback()`

---

## Wichtige Randbedingungen & bekannte Fallstricke

1. **`URL.createObjectURL` in MV3 SW nicht verfügbar** → zwingend Offscreen-Dokument nutzen
2. **Blob ist nicht structured-cloneable** über `chrome.runtime.sendMessage` → als `ArrayBuffer` + `mimeType` übertragen, Blob erst im Offscreen-Dokument rekonstruieren
3. **Offscreen-Reason** muss `'BLOBS'` sein (nicht `'BLOB_URL'`)
4. **Relative Pfade** – `chrome.downloads.download({ filename })` akzeptiert nur relative Pfade (relativ zu Downloads-Verzeichnis), keine absoluten Pfade
5. **`chromeDownloadId` speichern** – der Rückgabewert von `chrome.downloads.download()` muss im Item gespeichert werden, damit später `chrome.downloads.show(id)` funktioniert
6. **Alarm-Frequenz** – `periodInMinutes: 1/30` ≈ alle 2 Sekunden
7. **Service Worker Persist** – beim SW-Start laufende Downloads auf PAUSED setzen (nicht auto-resume), da der Blob-Fortschritt verloren ist
8. **`sanitizeFolder`** muss `..`-Segmente blockieren (Path-Traversal-Schutz)
9. **Popup-Breite** – exakt 500px, max-height 620px

---

## Installation (Developer Mode)

1. Edge öffnen → `edge://extensions`
2. "Entwicklermodus" aktivieren
3. "Entpackte Erweiterung laden" → Ordner `edge-download-manager/` wählen
4. Bei Codeänderungen: Erweiterung in `edge://extensions` neu laden
