#!/usr/bin/env node
/**
 * generate-icons.js
 * Run once with Node.js to create minimal SVG placeholder icons.
 * Replace with real PNG icons before publishing to the Edge Add-ons store.
 *
 * Usage: node generate-icons.js
 */
const fs   = require('fs');
const path = require('path');

const sizes = [16, 48, 128];
const dir   = path.join(__dirname, 'icons');
fs.mkdirSync(dir, { recursive: true });

for (const size of sizes) {
  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <rect width="${size}" height="${size}" rx="${Math.round(size * 0.15)}" fill="#0078d4"/>
  <line x1="${size/2}" y1="${size*0.2}" x2="${size/2}" y2="${size*0.65}" stroke="white" stroke-width="${Math.max(1,size/16)}" stroke-linecap="round"/>
  <polyline points="${size*0.3},${size*0.55} ${size*0.5},${size*0.72} ${size*0.7},${size*0.55}" fill="none" stroke="white" stroke-width="${Math.max(1,size/16)}" stroke-linecap="round" stroke-linejoin="round"/>
  <line x1="${size*0.25}" y1="${size*0.82}" x2="${size*0.75}" y2="${size*0.82}" stroke="white" stroke-width="${Math.max(1,size/16)}" stroke-linecap="round"/>
</svg>`;
  // Edge technically needs PNG, but Chromium accepts SVG renamed as PNG for unpacked extensions
  fs.writeFileSync(path.join(dir, `icon${size}.png`), svg);
  console.log(`Created icon${size}.png (SVG placeholder)`);
}
console.log('Done. Replace with real PNG files for store submission.');
