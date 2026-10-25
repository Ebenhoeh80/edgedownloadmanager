/**
 * Service Worker – Entry Point
 * Handles messages from the popup, orchestrates the DownloadManager,
 * and persists state via chrome.storage.local.
 */

import { DownloadManager } from './downloadManager.js';

const manager = new DownloadManager();

// ─── Restore persisted downloads on Service Worker startup ───────────────────
chrome.storage.local.get('downloads', ({ downloads }) => {
  if (downloads) {
    for (const item of Object.values(downloads)) {
      // Only re-register items that were active – do not auto-resume
      manager.restoreItem(item);
    }
  }
});

// ─── Message Router ──────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  handleMessage(message)
    .then(sendResponse)
    .catch((err) => sendResponse({ error: err.message }));

  // Return true to keep the message channel open for async sendResponse
  return true;
});

async function handleMessage(message) {
  switch (message.type) {
    case 'ADD_DOWNLOAD':
      return manager.addDownload(message.url, message.options);

    case 'PAUSE_DOWNLOAD':
      return manager.pauseDownload(message.id);

    case 'RESUME_DOWNLOAD':
      return manager.resumeDownload(message.id);

    case 'CANCEL_DOWNLOAD':
      return manager.cancelDownload(message.id);

    case 'RETRY_DOWNLOAD':
      return manager.retryDownload(message.id);

    case 'GET_ALL_DOWNLOADS':
      return manager.getAllDownloads();

    case 'CLEAR_COMPLETED':
      return manager.clearCompleted();

    case 'OPEN_DOWNLOADS_FOLDER': {
      // If a specific subfolder is requested, find the most recent completed
      // download whose path contains that subfolder and call show() on it.
      // chrome.downloads.show() opens Explorer and highlights the file –
      // effectively opening the correct subfolder.
      // Fallback: showDefaultFolder() when no matching download exists yet.
      const folder = (message.folder || '').replace(/\\/g, '/').trim();
      if (folder) {
        const results = await new Promise((resolve) =>
          chrome.downloads.search({ orderBy: ['-startTime'], limit: 50 }, resolve)
        );
        // Match items whose absolute path contains the subfolder segment
        const needle = '/' + folder + '/';
        const match = results.find(
          (d) => d.filename && d.filename.replace(/\\/g, '/').includes(needle)
        );
        if (match) {
          chrome.downloads.show(match.id);
          return {};
        }
      }
      // Subfolder not found in history or no subfolder specified
      chrome.downloads.showDefaultFolder();
      return {};
    }

    case 'GET_DOWNLOAD_LOG':
      return manager.getDownloadLog(message.id);

    case 'GET_KNOWN_FOLDERS': {
      const { knownFolders } = await chrome.storage.local.get('knownFolders');
      return { folders: knownFolders || [] };
    }

    case 'SAVE_KNOWN_FOLDER': {
      const folder = (message.folder || '').trim();
      if (folder) {
        const { knownFolders } = await chrome.storage.local.get('knownFolders');
        const set = new Set(knownFolders || []);
        set.add(folder);
        await chrome.storage.local.set({ knownFolders: [...set] });
      }
      return { ok: true };
    }

    case 'SHOW_IN_EXPLORER':
      if (message.chromeDownloadId != null) {
        chrome.downloads.show(message.chromeDownloadId);
      }
      return {};

    case 'OFFSCREEN_KEEPALIVE':
      // Offscreen document pings us to keep both sides alive while a blob URL
      // is pending. Just respond so neither context is considered idle.
      return { ok: true };

    default:
      throw new Error(`Unknown message type: ${message.type}`);
  }
}

// ─── Revoke blob URLs after chrome.downloads has finished reading them ────────
// This prevents the MV3 error: "The requested file could not be read,
// typically due to permission problems that have occurred after a reference
// to a file was acquired." – caused by the offscreen document being terminated
// before chrome.downloads finishes reading the blob URL.
chrome.downloads.onChanged.addListener((delta) => {
  if (delta.state &&
      (delta.state.current === 'complete' || delta.state.current === 'interrupted')) {
    manager.revokeObjectUrl(delta.id);
  }
});

// ─── Periodic state broadcast via alarms (every 2 s) ─────────────────────────
chrome.alarms.create('broadcastState', { periodInMinutes: 1 / 30 });

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'broadcastState') {
    const downloads = manager.getAllDownloads();
    chrome.runtime.sendMessage({ type: 'STATE_UPDATE', downloads }).catch(() => {
      // Popup may be closed – silently ignore
    });
  }
});
