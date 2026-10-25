/**
 * offscreen.js
 *
 * Runs inside the offscreen document (DOM context) so that
 * URL.createObjectURL() is available — which is NOT available in MV3
 * service workers.
 *
 * Problem: MV3 offscreen documents are terminated by the browser when idle
 * (no active JS execution). If the document is terminated before
 * chrome.downloads reads the blob URL, we get:
 *   "The requested file could not be read, typically due to permission
 *    problems that have occurred after a reference to a file was acquired."
 *
 * Fix:
 *  1. Keep the offscreen document alive by pinging the service worker every
 *     20 s while blob URLs are active (both sides reset their idle timer).
 *  2. Only revoke the blob URL after the service worker sends REVOKE_OBJECT_URL
 *     (triggered by chrome.downloads.onChanged when the download finishes).
 *  3. Safety fallback: auto-revoke after 10 minutes regardless.
 */

/** Map<objectUrl, { keepAliveInterval, safetyTimeout }> */
const activeUrls = new Map();

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {

  // ── Create a blob URL and start keepAlive ─────────────────────────────
  if (message.type === 'CREATE_OBJECT_URL') {
    try {
      const blob = new Blob(
        [message.arrayBuffer],
        { type: message.mimeType || 'application/octet-stream' }
      );
      const objectUrl = URL.createObjectURL(blob);

      // Ping the SW every 20 s to prevent both the SW and this document
      // from being considered idle and terminated.
      const keepAliveInterval = setInterval(() => {
        chrome.runtime.sendMessage({ type: 'OFFSCREEN_KEEPALIVE' }).catch(() => {
          // SW unreachable – stop pinging but keep the URL alive for now
          clearInterval(keepAliveInterval);
        });
      }, 20_000);

      // Absolute safety fallback: revoke after 10 minutes
      const safetyTimeout = setTimeout(() => {
        clearInterval(keepAliveInterval);
        URL.revokeObjectURL(objectUrl);
        activeUrls.delete(objectUrl);
      }, 600_000);

      activeUrls.set(objectUrl, { keepAliveInterval, safetyTimeout });
      sendResponse({ url: objectUrl });
    } catch (err) {
      sendResponse({ error: err.message });
    }
    return false; // synchronous response already sent
  }

  // ── Revoke a blob URL (sent by SW after download completes) ───────────
  if (message.type === 'REVOKE_OBJECT_URL') {
    const entry = activeUrls.get(message.url);
    if (entry) {
      clearInterval(entry.keepAliveInterval);
      clearTimeout(entry.safetyTimeout);
      activeUrls.delete(message.url);
    }
    if (message.url) URL.revokeObjectURL(message.url);
    sendResponse({ ok: true });
    return false;
  }
});

  }

  // Return false — response is sent synchronously above
  return false;
});
