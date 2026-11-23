/* ============================================================================
   Layer 3 - text analysis
   Turns OCR output into styled words: size, colour, weight, slant, spacing.

   The measurement philosophy: never trust a single word's box for anything
   that should be constant across a line. Tesseract's per-word boxes vary by a
   couple of pixels because of which glyphs happen to be present and how the
   anti-aliasing fell, so size, weight and slant are all decided per line and
   then applied to the words that agree with the line.
   ========================================================================== */

TC.register(function (TC) {
  'use strict';

const WINANSI_MAP = {
  '\u2018': "'", '\u2019': "'", '\u201A': "'", '\u201B': "'",
  '\u201C': '"', '\u201D': '"', '\u201E': '"', '\u201F': '"',
  '\u2010': '-', '\u2011': '-', '\u2012': '-', '\u2013': '-', '\u2014': '\u2014', '\u2015': '\u2014', '\u2212': '-',
  '\u2022': '\u00B7', '\u2023': '\u00B7', '\u25E6': '\u00B7', '\u2043': '-',
  '\u2026': '...', '\u2032': "'", '\u2033': '"', '\u00A0': ' ', '\u2007': ' ', '\u202F': ' ',
  '\u200B': '', '\u200C': '', '\u200D': '', '\uFEFF': '', '\u00AD': '',
  '\u2190': '<', '\u2192': '>', '\u2194': '<>', '\u21D2': '=>',
  '\u2264': '<=', '\u2265': '>=', '\u2260': '!=', '\u2248': '~', '\u00B1': '\u00B1', '\u00D7': 'x', '\u00F7': '/',
  '\u2713': '\u221A', '\u2714': '\u221A', '\u2717': 'x', '\u2718': 'x',
  '\u25AA': '\u00B7', '\u25AB': '\u00B7', '\u25A0': '\u25A0', '\u25CF': '\u2022',
  '\u00A9': '\u00A9', '\u00AE': '\u00AE', '\u2122': '\u2122'
};

/** Make a string safe for a WinAnsi (cp1252) encoded standard font. */
function sanitizeForWinAnsi(text) {
  let out = '';
  for (const ch of String(text)) {
    const cp = ch.codePointAt(0);
    if ((cp >= 32 && cp <= 126) || (cp >= 0xA0 && cp <= 0xFF)) { out += ch; continue; }
    if (cp === 10 || cp === 13 || cp === 9) { out += ' '; continue; }
    const mapped = WINANSI_MAP[ch];
    if (mapped !== undefined) { out += mapped; continue; }
    // Arrows, maths symbols and zero-width characters are not in WinAnsi. They are
    // decoration (an OCR word can swallow an arrowhead), so drop them entirely.
  }
  return out;
}

/** True when Helvetica (WinAnsi) can encode every character of `text`. */
function canEncode(text, font) {
  try {
    font.encodeText(text);
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * Ink colour and stroke statistics inside a word box.
 *
 *  - the background is the known context (page paper or the colour region the
 *    word sits on), not a guess from the box
 *  - the ink colour is the *core* stroke colour (luminance percentile), which
 *    is immune to anti-aliasing halos and to boxes that clip the glyphs
 *  - stroke thickness is measured as horizontal ink runs at the 50 % threshold,
 *    normalised later by the measured em so it compares across sizes
 */
function analyzeTextPixels(data, W, H, bbox, ctxBg, opts = {}) {
  const x0 = TC.clamp(Math.floor(bbox.x), 0, W - 1);
  const y0 = TC.clamp(Math.floor(bbox.y), 0, H - 1);
  const x1 = TC.clamp(Math.ceil(bbox.x + bbox.w), x0 + 1, W);
  const y1 = TC.clamp(Math.ceil(bbox.y + bbox.h), y0 + 1, H);
  const area = (x1 - x0) * (y1 - y0);
  if (area < 6) return null;
  const step = area > 90000 ? 2 : 1;
  const localBg = { r: ctxBg.r, g: ctxBg.g, b: ctxBg.b };
  const bgLum = TC.lumOf(localBg.r, localBg.g, localBg.b);
  const lightBg = bgLum > 128;

  const lumHist = new Uint32Array(256);
  const softThresh2 = 46 * 46;
  let nonBg = 0, total = 0;
  // How much of the box matches the assumed fill. A padded box hanging off the
  // edge of a coloured node scores low here, which is the signal used to
  // reject a false "label printed on artwork".
  let bgMatch = 0;
  for (let y = y0; y < y1; y += step) {
    let p = (y * W + x0) * 4;
    for (let x = x0; x < x1; x += step, p += 4 * step) {
      total++;
      const r = data[p], g = data[p + 1], b = data[p + 2];
      if (TC.colorDist2(r, g, b, localBg.r, localBg.g, localBg.b) > softThresh2) {
        lumHist[Math.round(TC.lumOf(r, g, b))]++;
        nonBg++;
      } else {
        bgMatch++;
      }
    }
  }
  if (nonBg < Math.max(4, total * 0.012)) return null;

  // Core ink band: darkest 20 % of ink pixels on light paper, brightest on dark.
  const target = Math.max(1, Math.round(nonBg * 0.2));
  let acc = 0, lo = 0, hi = 255;
  if (lightBg) {
    for (let v = 0; v < 256; v++) { acc += lumHist[v]; if (acc >= target) { hi = v; break; } }
  } else {
    for (let v = 255; v >= 0; v--) { acc += lumHist[v]; if (acc >= target) { lo = v; break; } }
  }
  let sr = 0, sg = 0, sb = 0, sn = 0;
  for (let y = y0; y < y1; y += step) {
    let p = (y * W + x0) * 4;
    for (let x = x0; x < x1; x += step, p += 4 * step) {
      const r = data[p], g = data[p + 1], b = data[p + 2];
      if (TC.colorDist2(r, g, b, localBg.r, localBg.g, localBg.b) <= softThresh2) continue;
      const l = TC.lumOf(r, g, b);
      if (l >= lo && l <= hi && (lightBg ? l < bgLum - 18 : l > bgLum + 18)) { sr += r; sg += g; sb += b; sn++; }
    }
  }
  let fr, fg, fb;
  if (sn > 0) { fr = sr / sn; fg = sg / sn; fb = sb / sn; }
  else {
    let best = null, bestLum = lightBg ? 1e9 : -1e9;
    for (let y = y0; y < y1; y += step) {
      let p = (y * W + x0) * 4;
      for (let x = x0; x < x1; x += step, p += 4 * step) {
        const l = TC.lumOf(data[p], data[p + 1], data[p + 2]);
        if (lightBg ? l < bestLum : l > bestLum) { bestLum = l; best = [data[p], data[p + 1], data[p + 2]]; }
      }
    }
    [fr, fg, fb] = best || [lightBg ? 0 : 255, lightBg ? 0 : 255, lightBg ? 0 : 255];
  }
  const contrast = Math.abs(bgLum - TC.lumOf(fr, fg, fb));

  /* ---- stroke geometry ---------------------------------------------------
   * Horizontal ink runs are measured over the *whole* box, not a guessed
   * middle band. A middle band clips the x-height of a cap-only word and
   * measures the gaps between glyphs of a wide one, which is how the old
   * version mis-called bold on tabular figures. */
  const lumInk = TC.lumOf(fr, fg, fb);
  const midLum = (bgLum + lumInk) / 2;
  const runs = [];
  let ink = 0, sampled = 0;
  for (let y = y0; y < y1; y++) {
    let run = 0;
    let p = (y * W + x0) * 4;
    for (let x = x0; x < x1; x++, p += 4) {
      const l = TC.lumOf(data[p], data[p + 1], data[p + 2]);
      const isInk = lightBg ? l <= midLum : l >= midLum;
      if (isInk) run++;
      else { if (run > 0) runs.push(run); run = 0; }
    }
    if (run > 0) runs.push(run);
  }
  for (let y = y0; y < y1; y += step) {
    let p = (y * W + x0) * 4;
    for (let x = x0; x < x1; x += step, p += 4 * step) {
      sampled++;
      const l = TC.lumOf(data[p], data[p + 1], data[p + 2]);
      if (lightBg ? l <= midLum : l >= midLum) ink++;
    }
  }
  const medRun = runs.length ? TC.medianOfNumbers(runs) : 1;
  const meanRun = runs.length ? runs.reduce((a, b) => a + b, 0) / runs.length : 1;

  // Ink top/bottom inside the box: a word with no descender has its last ink
  // row well above the box bottom, which is the cue the size model needs.
  let inkTop = -1, inkBottom = -1;
  for (let y = y0; y < y1; y++) {
    let c = 0, p = (y * W + x0) * 4;
    for (let x = x0; x < x1; x++, p += 4) {
      const l = TC.lumOf(data[p], data[p + 1], data[p + 2]);
      if (lightBg ? l <= midLum : l >= midLum) c++;
    }
    if (c >= Math.max(1, Math.round((x1 - x0) * 0.02))) {
      if (inkTop < 0) inkTop = y;
      inkBottom = y;
    }
  }

  return {
    fg: [Math.round(fr), Math.round(fg), Math.round(fb)],
    fgHex: TC.rgbToHex(fr, fg, fb),
    bg: [Math.round(localBg.r), Math.round(localBg.g), Math.round(localBg.b)],
    bgHex: TC.rgbToHex(localBg.r, localBg.g, localBg.b),
    density: sampled ? ink / sampled : 0,
    medRun, meanRun, runCount: runs.length,
    contrast,
    lightBg,
    inkTop, inkBottom,
    inkH: inkTop >= 0 ? inkBottom - inkTop + 1 : 0,
    bgMatch, samples: total,
  };
}

/**
 * Refit a Tesseract box onto the actual ink of its own text.
 * Tesseract occasionally returns boxes that bleed into neighbouring words
 * ("Transferof", "level data"); trimming to the letter islands inside the box
 * (ignoring rules / fills that touch the border) restores true word extents.
 */
function refitWordInk(data, W, H, bbox, ctxBg, text) {
  const x0 = TC.clamp(Math.floor(bbox.x), 0, W - 1);
  const y0 = TC.clamp(Math.floor(bbox.y), 0, H - 1);
  const x1 = TC.clamp(Math.ceil(bbox.x + bbox.w), x0 + 1, W);
  const y1 = TC.clamp(Math.ceil(bbox.y + bbox.h), y0 + 1, H);
  const bw = x1 - x0, bh = y1 - y0;
  if (bw < 3 || bh < 4) return null;
  const border = 1;
  const midX = x0 + Math.round(bw * 0.5);
  let sr = 0, sg = 0, sb = 0, sn = 0;
  for (let y = y0 + border; y < y1 - border; y++) {
    const p = (y * W + midX) * 4;
    const r = data[p], g = data[p + 1], b = data[p + 2];
    if (TC.colorDist2(r, g, b, ctxBg.r, ctxBg.g, ctxBg.b) > 42 * 42) { sr += r; sg += g; sb += b; sn++; }
  }
  if (sn < 2) return null;
  const fr = sr / sn, fg = sg / sn, fb = sb / sn;
  const inkTol = 52 * 52;
  const bwHist = new Uint32Array(bw);
  const bhHist = new Uint32Array(bh);
  for (let y = 0; y < bh; y++) {
    const base = (y0 + y) * W + x0;
    const nearBorderY = y < border || y >= bh - border;
    for (let x = 0; x < bw; x++) {
      const nearBorder = nearBorderY || x < border || x >= bw - border;
      if (nearBorder) continue;
      const p = (base + x) * 4;
      if (TC.colorDist2(data[p], data[p + 1], data[p + 2], fr, fg, fb) < inkTol) { bwHist[x]++; bhHist[y]++; }
    }
  }
  const spans = [];
  let cur = null, gap = 0;
  for (let i = 0; i < bw; i++) {
    if (bwHist[i] > 0) {
      if (!cur) cur = { a: i, b: i };
      else { cur.b = i; gap = 0; }
      gap = 0;
    } else if (cur) {
      gap++;
      if (gap > 2) { spans.push(cur); cur = null; gap = 0; }
    }
  }
  if (cur) spans.push(cur);
  if (!spans.length) return null;
  const first = spans[0], last = spans[spans.length - 1];
  let nx0 = x0 + first.a, nx1 = x0 + last.b + 1;
  if (nx1 - nx0 < bw * 0.3) { nx0 = x0; nx1 = x1; }
  let ny0 = y0, ny1 = y1;
  let top = 0, bot = bh - 1;
  while (top < bh && bhHist[top] === 0) top++;
  while (bot > top && bhHist[bot] === 0) bot--;
  if (bot > top) { ny0 = y0 + top; ny1 = y0 + bot + 1; }
  return {
    bbox: { x: nx0, y: ny0, w: Math.max(2, nx1 - nx0), h: Math.max(3, ny1 - ny0) },
    color: [Math.round(fr), Math.round(fg), Math.round(fb)],
  };
}

/** Pick the background a word sits on: page paper or the colour box containing it. */
function contextBackgroundFor(bbox, pageBg, boxes) {
  const cx = bbox.x + bbox.w / 2, cy = bbox.y + bbox.h / 2;
  let best = null, bestArea = Infinity;
  for (const b of boxes) {
    if (cx >= b.x && cx <= b.x + b.w && cy >= b.y && cy <= b.y + b.h) {
      const area = b.w * b.h;
      if (area < bestArea) { bestArea = area; best = b; }
    }
  }
  return best ? { r: best.r, g: best.g, b: best.b } : pageBg;
}

/**
 * The fill a word is printed on, measured rather than assumed.
 *
 * The obvious approach — ask which detected colour region contains the word —
 * fails in an important case: a label on a small shape (a monogram in the
 * corner of a letterhead, a badge) is often not inside a *detected* region,
 * because a small ring or disc does not survive region detection. Assuming the
 * page paper then makes the label's own white glyphs read as ink on a dark
 * background, and the whole thing is mis-specified.
 *
 * Instead take the colour of the ink pixels' immediate surroundings: the most
 * common colour in the ring around each glyph stroke. That is the fill the
 * lettering is actually drawn on, whatever the region detector thinks.
 *
 * Returns null when the surroundings are the page paper itself (no artwork).
 */
function fillBeneathWord(data, W, H, bbox, pageBg, glyphPixels) {
  const x0 = TC.clamp(Math.floor(bbox.x) - 3, 0, W - 1);
  const y0 = TC.clamp(Math.floor(bbox.y) - 3, 0, H - 1);
  const x1 = TC.clamp(Math.ceil(bbox.x + bbox.w) + 3, x0 + 1, W);
  const y1 = TC.clamp(Math.ceil(bbox.y + bbox.h) + 3, y0 + 1, H);
  const glyphSet = glyphPixels && glyphPixels.length ? new Set(glyphPixels) : null;
  const hist = new Map();
  for (let y = y0; y < y1; y++) {
    let p = (y * W + x0) * 4;
    for (let x = x0; x < x1; x++, p += 4) {
      const idx = y * W + x;
      if (glyphSet && glyphSet.has(idx)) continue;
      // Quantise to 5 bits per channel: enough to separate fills, coarse enough
      // to beat paper texture.
      const key = ((data[p] >> 3) << 10) | ((data[p + 1] >> 3) << 5) | (data[p + 2] >> 3);
      let e = hist.get(key);
      if (!e) { e = { n: 0, r: 0, g: 0, b: 0 }; hist.set(key, e); }
      e.n++; e.r += data[p]; e.g += data[p + 1]; e.b += data[p + 2];
    }
  }
  let best = null;
  for (const e of hist.values()) if (!best || e.n > best.n) best = e;
  if (!best || best.n < 8) return null;
  const fill = { r: best.r / best.n, g: best.g / best.n, b: best.b / best.n };
  if (TC.colorDist2(fill.r, fill.g, fill.b, pageBg.r, pageBg.g, pageBg.b) <= 34 * 34) return null;
  return fill;
}

/**
 * Indices (into the pixel array, /4) of the glyph pixels of one word./**
 * Indices (into the pixel array, /4) of the glyph pixels of one word.
 *
 * Used only for labels printed on artwork: Layer 4 has to erase the lettering
 * to type it, but must leave the underlying fill intact so the artwork can
 * still be traced. Returns null when the word is small enough to box-erase.
 */
function glyphPixelList(data, W, H, bbox, bg, tol) {
  const x0 = TC.clamp(Math.floor(bbox.x), 0, W - 1);
  const y0 = TC.clamp(Math.floor(bbox.y), 0, H - 1);
  const x1 = TC.clamp(Math.ceil(bbox.x + bbox.w), x0 + 1, W);
  const y1 = TC.clamp(Math.ceil(bbox.y + bbox.h), y0 + 1, H);
  const t2 = tol * tol;
  const out = [];
  for (let y = y0; y < y1; y++) {
    let p = (y * W + x0) * 4;
    for (let x = x0; x < x1; x++, p += 4) {
      if (TC.colorDist2(data[p], data[p + 1], data[p + 2], bg.r, bg.g, bg.b) > t2) out.push(y * W + x);
    }
  }
  return out;
}

  // --- exported onto TC ---
  TC.glyphPixelList = glyphPixelList;
  TC.fillBeneathWord = fillBeneathWord;
  TC.WINANSI_MAP = WINANSI_MAP;
  TC.analyzeTextPixels = analyzeTextPixels;
  TC.canEncode = canEncode;
  TC.contextBackgroundFor = contextBackgroundFor;
  TC.refitWordInk = refitWordInk;
  TC.sanitizeForWinAnsi = sanitizeForWinAnsi;
});
