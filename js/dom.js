/* ============================================================================
   DOM + utility helpers
   Query helper, canvas creation, formatting, colour maths, geometry helpers.
   ========================================================================== */

TC.register(function (TC) {
  'use strict';

const $ = (id) => document.getElementById(id);
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));
const fmtInt = (n) => Math.round(n).toLocaleString('en-US');
const fmtBytes = (n) => n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(2)} MB`;
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}
function ctxOf(canvas, opts) { return canvas.getContext('2d', opts || { willReadFrequently: true }); }

/** Draw an image-like source into a fresh canvas, scaled so the LONG side ≤ maxSide. */
function fitCanvasFrom(source, sw, sh, maxSide) {
  const scale = Math.min(1, maxSide / Math.max(sw, sh));
  const c = makeCanvas(sw * scale, sh * scale);
  const x = ctxOf(c);
  x.imageSmoothingEnabled = true;
  x.imageSmoothingQuality = 'high';
  x.drawImage(source, 0, 0, c.width, c.height);
  return c;
}

/** Convert any CSS-ish color string via a 1×1 canvas. */
let _probeCtx = null;
function parseCssColor(str) {
  if (!_probeCtx) _probeCtx = ctxOf(makeCanvas(1, 1));
  _probeCtx.fillStyle = '#000';
  _probeCtx.fillStyle = str;
  _probeCtx.fillRect(0, 0, 1, 1);
  const d = _probeCtx.getImageData(0, 0, 1, 1).data;
  return [d[0], d[1], d[2]];
}
const rgbToHex = (r, g, b) => '#' + [r, g, b].map((v) => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0')).join('');

  // --- exported onto TC ---
  TC.$ = $;
  TC._probeCtx = _probeCtx;
  TC.clamp = clamp;
  TC.ctxOf = ctxOf;
  TC.escapeHtml = escapeHtml;
  TC.fitCanvasFrom = fitCanvasFrom;
  TC.fmtBytes = fmtBytes;
  TC.fmtInt = fmtInt;
  TC.makeCanvas = makeCanvas;
  TC.nextFrame = nextFrame;
  TC.parseCssColor = parseCssColor;
  TC.rgbToHex = rgbToHex;
  TC.sleep = sleep;
});
