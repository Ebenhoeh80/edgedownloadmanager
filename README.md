# Edge Download Manager

A production-ready Microsoft Edge extension (Manifest V3) that provides multi-stream
parallel downloading with speed tracking, pause/resume, and a modern dark-mode UI.

---

## Quick Start – Load in Edge

1. **Generate placeholder icons** (required once):
   ```
   node generate-icons.js
   ```
   This creates `icons/icon16.png`, `icon48.png`, `icon128.png`.  
   Replace them with real PNGs before publishing.

2. **Open Edge** and navigate to `edge://extensions/`

3. Enable **Developer mode** (toggle, top-right corner)

4. Click **"Load unpacked"** and select the `edge-download-manager/` folder

5. The extension icon appears in the toolbar – click it to open the popup.

---

## Architecture

```
edge-download-manager/
├── manifest.json              MV3 manifest – permissions, SW entry, popup
├── generate-icons.js          One-time icon generator (Node.js)
├── icons/
│   ├── icon16.png
│   ├── icon48.png
│   └── icon128.png
├── background/
│   ├── service-worker.js      SW entry: message router, alarm-based broadcast
│   ├── downloadManager.js     Core download logic (chunks, streams, speed)
│   └── utils.js               Shared helpers (formatBytes, mergeChunks, …)
└── popup/
    ├── popup.html             Popup shell with <template> for list items
    ├── popup.js               View layer: DOM reconciliation, sends messages to SW
    └── popup.css              Design-token-based CSS, full dark-mode support
```

### Data Flow

```
User clicks "Download"
        │
        ▼
  popup.js  ──sendMessage──►  service-worker.js
                                     │
                              DownloadManager
                                     │
                          ┌─────────┴──────────┐
                     HEAD request          Chunk workers (N streams)
                     (get size,            fetch byte ranges in parallel
                      range support)       with retry + back-off
                          └─────────┬──────────┘
                                    │ mergeChunks()
                                    ▼
                             chrome.downloads.download()
                             (native save dialog)

  chrome.alarms (every 2s)  ──pushState──►  popup.js (re-renders list)
```

### Key Design Decisions

| Decision | Reason |
|---|---|
| Alarm-based state push | Service Workers can be suspended; alarms wake them reliably |
| `chrome.downloads.download()` for save | No `<a download>` tricks needed; handles large files safely |
| Rolling 5-second speed window | Avoids burst spikes skewing the displayed speed |
| Chunk metadata persisted, data not | `Uint8Array` blobs are too large for `chrome.storage.local`; only progress is saved |
| `MAX_CONCURRENT_DOWNLOADS = 3` | Avoids exhausting the browser's connection pool |

---

## Permissions Explained

| Permission | Why |
|---|---|
| `downloads` | Triggers the native save dialog via `chrome.downloads.download()` |
| `storage` | Persists download list across popup opens / SW restarts |
| `alarms` | Periodic state broadcast to the popup (SW-safe alternative to `setInterval`) |
| `<all_urls>` host permission | Needed to `fetch()` arbitrary file URLs from the SW context |

---

## Limitations / Future Work

- **Chunk data is not persisted** – if the SW is killed mid-download, the download
  restarts from 0 (not from the byte offset). Fix: write chunks to `IndexedDB`.
- **No authentication support** – add custom request headers in `addDownload()` options.
- **Icons are SVG placeholders** – replace with real PNGs for Edge Add-ons store.
