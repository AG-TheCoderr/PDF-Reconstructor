/* ============================================================================
   Layer 3 - text analysis
   Turns OCR output into styled words: colour, weight, size, grouping.
   ========================================================================== */

TC.register(function (TC) {
  'use strict';

const WINANSI_MAP = {
  '\u2018': "'", '\u2019': "'", '\u201A': "'", '\u201B': "'",
  '\u201C': '"', '\u201D': '"', '\u201E': '"', '\u201F': '"',
  '\u2010': '-', '\u2011': '-', '\u2012': '-', '\u2013': '-', '\u2014': '-', '\u2015': '-', '\u2212': '-',
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
 * Inspect the pixels inside a text bbox.
 * - local background is taken from the known region context (page bg / colour box)
 * - the ink colour is the *core* stroke colour (luminance percentile), which is
 *   immune to anti-aliasing halos and to tight Tesseract boxes
 * - stroke thickness is measured with a strict threshold → reliable bold test
 */
function analyzeTextPixels(data, W, H, bbox, ctxBg, opts = {}) {
  const x0 = TC.clamp(Math.floor(bbox.x), 0, W - 1);
  const y0 = TC.clamp(Math.floor(bbox.y), 0, H - 1);
  const x1 = TC.clamp(Math.ceil(bbox.x + bbox.w), x0 + 1, W);
  const y1 = TC.clamp(Math.ceil(bbox.y + bbox.h), y0 + 1, H);
  const area = (x1 - x0) * (y1 - y0);
  if (area < 6) return null;
  const step = area > 90000 ? 2 : 1;
  let localBg = { r: ctxBg.r, g: ctxBg.g, b: ctxBg.b };
  const bgLum = TC.lumOf(localBg.r, localBg.g, localBg.b);
  const lightBg = bgLum > 128;

  // Luminance histogram of pixels that are not local-background.
  const lumHist = new Uint32Array(256);
  const softThresh2 = 46 * 46;
  let nonBg = 0, total = 0;
  for (let y = y0; y < y1; y += step) {
    let p = (y * W + x0) * 4;
    for (let x = x0; x < x1; x += step, p += 4 * step) {
      total++;
      const r = data[p], g = data[p + 1], b = data[p + 2];
      if (TC.colorDist2(r, g, b, localBg.r, localBg.g, localBg.b) > softThresh2) {
        lumHist[Math.round(TC.lumOf(r, g, b))]++;
        nonBg++;
      }
    }
  }
  if (nonBg < Math.max(4, total * 0.012)) {
    // No real ink inside: fall back to the context colour (invisible text is worse
    // than a slightly wrong colour) and report zero contrast.
    return null;
  }

  // Core ink band: darkest 30 % of ink pixels on light paper, brightest on dark.
  const target = Math.max(1, Math.round(nonBg * 0.2));
  let acc = 0, lo = 0, hi = 255;
  if (lightBg) {
    for (let v = 0; v < 256; v++) { acc += lumHist[v]; if (acc >= target) { hi = v; break; } }
    lo = 0;
  } else {
    for (let v = 255; v >= 0; v--) { acc += lumHist[v]; if (acc >= target) { lo = v; break; } }
    hi = 255;
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
    // darkest / brightest pixel fallback
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

  // Stroke geometry at the 50 % ink threshold (sub-pixel stable weight cue):
  // scan the x-height band and collect horizontal ink runs.
  const lumInk = TC.lumOf(fr, fg, fb);
  const midLum = (bgLum + lumInk) / 2;
  const bandTop = y0 + Math.round((y1 - y0) * 0.22);
  const bandBot = y1 - Math.round((y1 - y0) * 0.16);
  const runs = [];
  let ink = 0, sampled = 0;
  for (let y = bandTop; y < Math.max(bandTop + 1, bandBot); y++) {
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

  return {
    fg: [Math.round(fr), Math.round(fg), Math.round(fb)],
    fgHex: TC.rgbToHex(fr, fg, fb),
    bg: [Math.round(localBg.r), Math.round(localBg.g), Math.round(localBg.b)],
    bgHex: TC.rgbToHex(localBg.r, localBg.g, localBg.b),
    density: sampled ? ink / sampled : 0,
    medRun, meanRun, runCount: runs.length,
    contrast,
    lightBg,
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
  // Estimate the ink colour from the central column strip.
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
  // Contiguous non-empty spans (tolerate 1–2 empty columns inside a word)
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
  // word is at least ~3 px wide, else skip trimming horizontally
  let nx0 = x0 + first.a, nx1 = x0 + last.b + 1;
  const expectedWs = Math.max(1, (text || '').split(/\s+/).length);
  // reject absurd trims that would eat >45% of a correctly sized box
  if (nx1 - nx0 < bw * 0.3) { nx0 = x0; nx1 = x1; }
  // vertical trim
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

  // --- exported onto TC ---
  TC.WINANSI_MAP = WINANSI_MAP;
  TC.analyzeTextPixels = analyzeTextPixels;
  TC.canEncode = canEncode;
  TC.contextBackgroundFor = contextBackgroundFor;
  TC.refitWordInk = refitWordInk;
  TC.sanitizeForWinAnsi = sanitizeForWinAnsi;
});
