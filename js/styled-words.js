/* ============================================================================
   Styled word building
   Filters, measures and enriches raw OCR words for assembly.
   ========================================================================== */

TC.register(function (TC) {
  'use strict';

function buildStyledWords(rawWords, mainData, W, H, pageBg, opts) {
  const out = [];
  const drop = { lowConf: 0, empty: 0, noInk: 0, tiny: 0 };
  const boxes = opts.boxes || [];
  for (const w of rawWords) {
    if (!w.bbox) { drop.empty++; continue; }
    if (!w.text || !w.text.trim()) { drop.empty++; continue; }
    if (w.conf < opts.minConf) { drop.lowConf++; continue; }
    // Strip decoration glyphs BEFORE sanitising: sanitise drops the arrow/guillemet
    // outright, which would leave an orphan "|" glued to the word.
    let cleaned = w.text.replace(/\s+/g, ' ').trim();
    if (/[A-Za-z0-9]/.test(cleaned)) {
      cleaned = cleaned.replace(/^[\u2190-\u21FF|¦\u00BB\u00AB\u203A\u2039\-–—=~_]+/, '')
                       .replace(/[\u2190-\u21FF|¦\u00BB\u00AB\u203A\u2039=~_]+$/, '')
                       .trim();
    }
    cleaned = TC.sanitizeForWinAnsi(cleaned);
    // "[secondary" — the layout engine glued a neighbouring bracket to this word.
    if (/^[\[{(<'"][A-Za-z][A-Za-z]{2,}/.test(cleaned)) cleaned = cleaned.slice(1);
    if (!cleaned.trim()) { drop.empty++; continue; }
    const bbox = {
      x: w.bbox.x0, y: w.bbox.y0,
      w: Math.max(1, w.bbox.x1 - w.bbox.x0),
      h: Math.max(1, w.bbox.y1 - w.bbox.y0),
    };
    if (bbox.w < 2 || bbox.h < 4) { drop.tiny++; continue; }
    // A short, saturated token with no letters is a piece of artwork (an arrow
    // head, a bullet) that OCR mistook for a glyph.
    if (!/[A-Za-z]/.test(cleaned) && bbox.w <= 40 && (bbox.y1 - bbox.y0) <= 22) { drop.tiny++; continue; }
    if (bbox.x >= W || bbox.y >= H || bbox.x + bbox.w <= 0 || bbox.y + bbox.h <= 0) { drop.tiny++; continue; }
    const ctxBg = TC.contextBackgroundFor(bbox, pageBg, boxes);
    const refit = TC.refitWordInk(mainData, W, H, bbox, ctxBg, cleaned);
    const finalBox = refit ? refit.bbox : { x: bbox.x, y: bbox.y, w: bbox.w, h: bbox.h };
    const info = TC.analyzeTextPixels(mainData, W, H, finalBox, ctxBg);
    if (!info) { drop.noInk++; continue; }
    // Effective height ratio → boldness (stroke thickness / cap height).
    // Tesseract's raw box height already encodes the font size far more reliably
    // than a trimmed ink box (which loses ascenders/descenders).
    const hRef = Math.max(4, bbox.h);
    const emEst = hRef / 0.72;
    // mean ink-run (50 % threshold) normalised by em  → Helvetica ≈ .085, Bold ≈ .135
    const strokeRatio = info.meanRun / Math.max(1, emEst);
    const avgAdvance = finalBox.w / Math.max(1, cleaned.length) / Math.max(1, emEst);
    // Bold threshold follows the UI slider (0.2 … 0.6 → 0.155 … 0.215)
    const strokeThresh = 0.155 + (opts.boldThresh - 0.2) * 0.15;
    const bold = (w.fontName && /bold|black|heavy|semibold/i.test(w.fontName))
      ? true
      : strokeRatio >= strokeThresh;
    // Choose the fill colour. Saturated inks keep their hue; near-neutral ink is
    // pushed to a crisp near-black / near-white extreme matching its own polarity.
    let fr = info.fg[0], fgc = info.fg[1], fbb = info.fg[2];
    const maxC = Math.max(fr, fgc, fbb), minC = Math.min(fr, fgc, fbb);
    const sat = maxC === 0 ? 0 : (maxC - minC) / maxC;
    if (sat < 0.22 && info.contrast > 40) {
      const l = TC.lumOf(fr, fgc, fbb);
      if (info.lightBg) {
        if (l > 64) { const k = 46 / Math.max(1, l); fr *= k; fgc *= k; fbb *= k; }
      } else if (l < 186) {
        const k = Math.min(2.2, 210 / Math.max(1, l));
        fr = Math.min(255, fr * k); fgc = Math.min(255, fgc * k); fbb = Math.min(255, fbb * k);
      }
    } else if (sat < 0.22 && info.contrast <= 40) {
      // Very low contrast (white-on-dark / light-on-light): pick the extreme of the
      // context so the re-typed word is always readable.
      if (info.lightBg) { fr = 32; fgc = 32; fbb = 34; } else { fr = 246; fgc = 246; fbb = 248; }
    }
    const effHex = TC.rgbToHex(fr, fgc, fbb);
    out.push({
      text: cleaned,
      x: finalBox.x, y: finalBox.y, w: finalBox.w, h: finalBox.h,
      effColorHex: effHex,
      rawX: bbox.x, rawY: bbox.y, rawW: bbox.w, rawH: bbox.h,
      conf: Math.round(w.conf),
      color: [Math.round(fr), Math.round(fgc), Math.round(fbb)], colorHex: info.fgHex,
      localBg: info.bg,
      density: info.density,
      medRun: info.medRun,
      strokeRatio,
      avgAdvance,
      bold,
      contrast: info.contrast,
      lineBbox: w.lineBbox,
      baseline: w.baseline,
      rowAttributes: w.rowAttributes,
    });
  }
  // Per-line smoothing: words on the same line usually share a weight; only
  // flip a word when its stroke measure clearly disagrees with its line.
  const groups = new Map();
  for (const w of out) {
    const lb = w.lineBbox;
    const k = lb ? `${Math.round(lb.x0)},${Math.round(lb.y0)}` : `s${Math.round(w.y)}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(w);
  }
  const thresh = 0.155 + (opts.boldThresh - 0.2) * 0.15;
  for (const arr of groups.values()) {
    const lineStroke = TC.medianOfNumbers(arr.map((w) => w.strokeRatio));
    for (const w of arr) {
      if (Math.abs(w.strokeRatio - lineStroke) < 0.022) w.bold = lineStroke >= thresh;
      w.lineStrokeRatio = +lineStroke.toFixed(3);
    }
  }
  return { words: out, dropped: drop.lowConf + drop.empty + drop.noInk + drop.tiny, drop };
}

  // --- exported onto TC ---
  TC.buildStyledWords = buildStyledWords;
});
