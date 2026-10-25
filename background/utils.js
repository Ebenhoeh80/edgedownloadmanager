/**
 * utils.js
 * Shared utility functions used by both background and popup contexts.
 */

// ─── ID Generation ────────────────────────────────────────────────────────────

/**
 * Generates a compact random ID using the Web Crypto API.
 * More robust than Math.random() for use as a key.
 */
export function generateId() {
  const arr = new Uint8Array(8);
  crypto.getRandomValues(arr);
  return [...arr].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ─── Formatting ───────────────────────────────────────────────────────────────

/**
 * Formats a byte count into a human-readable string.
 * @param {number} bytes
 * @returns {string}  e.g. "4.20 MB"
 */
export function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const exp = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = (bytes / Math.pow(1024, exp)).toFixed(2);
  return `${value} ${units[exp]}`;
}

/**
 * Formats a speed value in bytes/s to a human-readable string.
 * @param {number} bps  bytes per second
 * @returns {string}  e.g. "3.14 MB/s"
 */
export function formatSpeed(bps) {
  return `${formatBytes(bps)}/s`;
}

/**
 * Converts seconds to a "HH:MM:SS" or "MM:SS" string.
 * @param {number|null} seconds
 * @returns {string}
 */
export function formatEta(seconds) {
  if (seconds === null || !isFinite(seconds) || seconds < 0) return '–';
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;

  if (h > 0) {
    return `${h}:${pad(m)}:${pad(sec)}`;
  }
  return `${pad(m)}:${pad(sec)}`;
}

function pad(n) {
  return String(n).padStart(2, '0');
}

// ─── Chunk Merging ────────────────────────────────────────────────────────────

/**
 * Merges an ordered array of chunk objects (each with a .data Uint8Array)
 * into a single Blob.
 * @param {{ data: Uint8Array }[]} chunks  Must be sorted by index ascending
 * @returns {Blob}
 */
export function mergeChunks(chunks) {
  const parts = chunks.map((c) => c.data);
  return new Blob(parts, { type: 'application/octet-stream' });
}

// ─── URL Utilities ────────────────────────────────────────────────────────────

/**
 * Validates that the given string is an HTTP/HTTPS URL.
 * @param {string} url
 * @returns {boolean}
 */
export function isValidHttpUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}
