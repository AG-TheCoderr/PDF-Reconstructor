/* ============================================================================
   Styled word building
   Filters, measures and enriches raw OCR words for assembly.
   ========================================================================== */

TC.register(function (TC) {
  'use strict';

/**
 * Characters that carry no letterform information but still make a word worth
 * keeping (digits, money, punctuation inside a table cell).
 */
function isMeaningful(text) {
  return /[A-Za-z0-9]/.test(text);
}

/** Strip decoration an OCR word can swallow at either end. */
function cleanWordText(raw) {
  let t = String(raw || '').replace(/\s+/g, ' ').trim();
  if (isMeaningful(t)) {
    // Leading decoration is stripped only up to the first letter or digit; the
    // trailing pass keeps a dash, because "packaging artwork —" ends a phrase
    // and dropping the dash silently changes the sentence.
    t = t.replace(/^[\u2190-\u21FF|¦\u00BB\u00AB\u203A\u2039\-–—=~_]+/, '')
         .replace(/[\u2190-\u21FF|¦\u00BB\u00AB\u203A\u2039=~_]+$/, '')
         .trim();
  }
  t = TC.sanitizeForWinAnsi(t);
  // "[secondary" — the layout engine glued a neighbouring bracket to this word.
  if (/^[\[{(<'"][A-Za-z][A-Za-z]{2,}/.test(t)) t = t.slice(1);
  return t;
}

/**
 * Group raw words into text lines.
 * Tesseract's own line bbox is the best key when present; otherwise fall back
 * to a vertical clustering so gap-fill and region-fill words still group.
 */
function groupIntoLines(words) {
  const lines = [];
  for (const w of words) {
    const lb = w.lineBbox;
    const cy = lb ? (lb.y0 + lb.y1) / 2 : w.y + w.h / 2;
    let target = null;
    for (const l of lines) {
      const dy = Math.abs(l.cy - cy);
      const tol = Math.max(3, Math.min(l.h, w.h) * 0.45);
      if (dy <= tol) { target = l; break; }
    }
    if (!target) { target = { cy, h: w.h, words: [] }; lines.push(target); }
    target.words.push(w);
    target.cy = (target.cy * (target.words.length - 1) + cy) / target.words.length;
    target.h = Math.max(target.h, w.h);
  }
  lines.sort((a, b) => a.cy - b.cy);
  return lines;
}

function buildStyledWords(rawWords, mainData, W, H, pageBg, opts) {
  const out = [];
  const candidates = [];
  const drop = { lowConf: 0, empty: 0, noInk: 0, tiny: 0, artifact: 0 };
  const boxes = opts.boxes || [];
  const data = { px: mainData, W, H };

  /* ---- pass 1: clean, filter, and measure ink ------------------------- */
  for (const w of rawWords) {
    if (!w.bbox) { drop.empty++; continue; }
    if (!w.text || !w.text.trim()) { drop.empty++; continue; }
    if (w.conf < opts.minConf) { drop.lowConf++; continue; }
    const cleaned = cleanWordText(w.text);
    if (!cleaned.trim()) { drop.empty++; continue; }
    const bbox = {
      x: w.bbox.x0, y: w.bbox.y0,
      w: Math.max(1, w.bbox.x1 - w.bbox.x0),
      h: Math.max(1, w.bbox.y1 - w.bbox.y0),
    };
    // A dash or a bullet has real ink but is only a few rows tall; keep it
    // rather than losing punctuation from the middle of a sentence.
    const punctuationOnly = !/[A-Za-z0-9]/.test(cleaned) && cleaned.length >= 1;
    if (bbox.w < 2 || (bbox.h < 4 && !punctuationOnly)) { drop.tiny++; continue; }
    // A single stray mark (a speck, a corner of a border) is not a character.
    if (punctuationOnly && bbox.w < 6 && bbox.h < 6) { drop.artifact++; continue; }
    // A short, saturated token with no letters is artwork (an arrowhead, a
    // bullet) that OCR mistook for a glyph.
    if (!isMeaningful(cleaned) && bbox.w <= 40 && bbox.h <= 22) { drop.artifact++; continue; }
    if (bbox.x >= W || bbox.y >= H || bbox.x + bbox.w <= 0 || bbox.y + bbox.h <= 0) { drop.tiny++; continue; }

    // The fill comes first, because every later measurement is relative to it.
    // A label inside a coloured node measured against the *page* paper counts
    // the whole node as ink, which inflated its type by 2–3×.
    const fill = TC.fillBeneathWord(mainData, W, H, bbox, pageBg, null);
    const ctxBg = fill || TC.contextBackgroundFor(bbox, pageBg, boxes);
    const refit = TC.refitWordInk(mainData, W, H, bbox, ctxBg, cleaned);
    const finalBox = refit ? refit.bbox : bbox;
    const info = TC.analyzeTextPixels(mainData, W, H, finalBox, ctxBg);
    if (!info) { drop.noInk++; continue; }
    // A word whose local background is not the page paper is printed on
    // artwork (a node caption, white type on a banner). Layer 4 must erase just
    // its glyphs then, so the artwork survives.
    // Deciding whether these glyphs are printed *on* artwork.
    //
    // Measure the fill the lettering actually sits on rather than trusting the
    // region detector: a label on a small shape — a monogram in the corner of a
    // letterhead, a badge — is often not inside any *detected* region, because
    // small rings and discs do not survive region detection. Asking what is
    // around the glyph strokes answers the question directly.
    const wordBg = fill || ctxBg;
    const glyphPixels = fill ? TC.glyphPixelList(mainData, W, H, finalBox, wordBg, 46) : null;

    candidates.push({
      text: cleaned,
      rawText: w.text,
      x: finalBox.x, y: finalBox.y, w: finalBox.w, h: finalBox.h,
      rawX: bbox.x, rawY: bbox.y, rawW: bbox.w, rawH: bbox.h,
      conf: Math.round(w.conf),
      info,
      ctxBg,
      fill,
      wordBg,
      glyphPixels,
      lineBbox: w.lineBbox,
      baseline: w.baseline,
      rowAttributes: w.rowAttributes,
      fontName: w.fontName || '',
    });
  }

  /* ---- pass 2: per-line typography ------------------------------------- */
  //
  // Everything that should be constant across a line is decided here, from the
  // whole line, and only then applied to words that agree with it. This is the
  // single biggest visual improvement: one size, one weight, one slant per
  // line instead of a different size on every word.
  const lines = groupIntoLines(candidates);
  const boldThreshPx = 0.155 + (opts.boldThresh - 0.2) * 0.15;

  for (const line of lines) {
    const arr = line.words;

    // ---- is this line printed on artwork?
    //
    // Decided for the line, not per word. A line of white type on a coloured
    // band ("NORTHWIND STUDIO" on a navy letterhead) shares one fill; deciding
    // per word lets one word with a tight box see the wrong thing. The fill that
    // most of the line's glyph pixels actually touch is the fill of the line.
    const tints = new Map();
    for (const w of arr) {
      if (!w.fill) continue;
      const key = [Math.round(w.fill.r / 12), Math.round(w.fill.g / 12), Math.round(w.fill.b / 12)].join(',');
      const e = tints.get(key) || { n: 0, fill: w.fill };
      e.n += (w.glyphPixels ? w.glyphPixels.length : 0) + 1;
      tints.set(key, e);
    }
    let lineFill = null;
    for (const e of tints.values()) if (!lineFill || e.n > lineFill.n) lineFill = e;
    const paperLum = TC.lumOf(pageBg.r, pageBg.g, pageBg.b);
    const lineOnArt = !!lineFill && (
      TC.colorfulness(lineFill.fill) > 0.10 ||
      TC.lumOf(lineFill.fill.r, lineFill.fill.g, lineFill.fill.b) < paperLum - 45
    );
    for (const w of arr) {
      w.onArtwork = lineOnArt;
      w.wordBg = lineOnArt && lineFill ? lineFill.fill : w.wordBg;
      if (lineOnArt && !w.glyphPixels) {
        w.glyphPixels = TC.glyphPixelList(mainData, W, H, { x: w.x, y: w.y, w: w.w, h: w.h }, w.wordBg, 46);
      }
    }

    // measured band layout for the line (falls back gracefully)
    let bands = null;
    try { bands = TC.lineBands(data, arr, arr[0].ctxBg); } catch (_) { bands = null; }

    // ---- size: per-word estimate, then a per-line consensus
    const sizes = [];
    for (const w of arr) {
      w.sizePx = TC.estimateTypeSize(
        { text: w.text, x: w.x, y: w.y, w: w.w, h: w.h, inkH: w.info.inkH, bold: false },
      );
      // A box shorter than ~5 px is noise, not type.
      if (w.h >= 5) sizes.push(w.sizePx);
    }
    let lineSize = sizes.length ? TC.medianOfNumbers(sizes) : 12;
    // Reject words whose own estimate is outlier-ish; they are usually a box
    // that lost its ascender or swallowed a descender from the row below.
    for (const w of arr) {
      if (Math.abs(w.sizePx - lineSize) / lineSize > 0.22) w.sizePx = lineSize;
    }
    lineSize = TC.medianOfNumbers(arr.map((w) => w.sizePx));

    // ---- weight: stroke thickness normalised by the *line's* em
    for (const w of arr) {
      const em = Math.max(4, lineSize);
      const strokeRatio = w.info.meanRun / em;
      // A bold face's stroke is roughly 1.5× a regular one at the same size.
      // Helvetica regular ≈ 0.10 em of stem, bold ≈ 0.15 em; measure at the
      // 50 % threshold and put the cut between them.
      w.strokeRatio = strokeRatio;
      w.sizePx = lineSize;
    }
    const lineStroke = TC.medianOfNumbers(arr.map((w) => w.strokeRatio));
    const lineBold = lineStroke >= boldThreshPx;
    for (const w of arr) {
      const near = Math.abs(w.strokeRatio - lineStroke) < lineStroke * 0.22;
      // A word that clearly disagrees with its line keeps its own verdict, but
      // only when the disagreement is large; Tesseract's fontName is trusted if
      // it ever appears.
      const hinted = w.fontName && /bold|black|heavy|semibold/i.test(w.fontName);
      w.bold = hinted || (near ? lineBold : w.strokeRatio >= boldThreshPx);
      w.lineStrokeRatio = +lineStroke.toFixed(3);
    }

    // ---- slant: measured once for the line, from its projection profile.
    //
    // Italic is a property of the *typeface*, so it is decided per line and
    // applied to the whole line. Deciding per word (the old centroid heuristic)
    // made ordinary upright text come out oblique wherever a comma or a wide
    // capital nudged one word's centre of mass.
    const lineSlant = opts.detectItalic === false ? 0 : TC.lineSlantDeg(data, arr, arr[0].ctxBg);
    for (const w of arr) {
      w.italic = Math.abs(lineSlant) >= 4;
      w.lineSlantDeg = +lineSlant.toFixed(1);
    }

    // ---- vertical position: one baseline for the line, from its own ink
    if (bands && bands.baseline >= 0) {
      const baseY = bands.baseline + 1;
      for (const w of arr) {
        const dy = Math.abs((w.y + w.h) - baseY);
        if (dy < Math.max(3, lineSize * 0.35)) w.baselineY = baseY;
      }
    }
  }

  /* ---- pass 3: colour, tracking, and final records ---------------------- */
  for (const w of candidates) {
    const info = w.info;
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
      // Very low contrast (white-on-dark / light-on-light): pick the extreme of
      // the context so the retyped word is always readable.
      if (info.lightBg) { fr = 32; fgc = 32; fbb = 34; } else { fr = 246; fgc = 246; fbb = 248; }
    }
    const effHex = TC.rgbToHex(fr, fgc, fbb);
    // The box the assembler will draw with: its top comes from the measured
    // baseline so descenders and ascenders stop moving the text up and down.
    const drawTop = (w.baselineY !== undefined) ? w.baselineY - w.sizePx * TC.HELV.cap : w.y;
    out.push({
      text: w.text,
      x: w.x, y: drawTop, w: w.w, h: w.h,
      sizePx: w.sizePx,
      baselineY: w.baselineY,
      italic: !!w.italic,
      lineSlantDeg: w.lineSlantDeg || 0,
      effColorHex: effHex,
      rawX: w.rawX, rawY: w.rawY, rawW: w.rawW, rawH: w.rawH,
      conf: w.conf,
      color: [Math.round(fr), Math.round(fgc), Math.round(fbb)],
      colorHex: info.fgHex,
      localBg: info.bg,
      density: info.density,
      medRun: info.medRun,
      strokeRatio: +w.strokeRatio.toFixed(4),
      lineStrokeRatio: w.lineStrokeRatio,
      bold: !!w.bold,
      contrast: info.contrast,
      onArtwork: !!w.onArtwork,
      bg: w.wordBg || w.ctxBg,
      glyphPixels: w.glyphPixels,
      lineBbox: w.lineBbox,
      baseline: w.baseline,
      rowAttributes: w.rowAttributes,
    });
  }

  const result = {
    words: out,
    dropped: drop.lowConf + drop.empty + drop.noInk + drop.tiny + drop.artifact,
    drop,
    lines: lines.length,
  };
  // Diagnostics: which raw words did not survive, and why. Cheap to keep and
  // invaluable when a document silently loses a block.
  try {
    const keep = new Set(out.map((w) => w.text + '@' + Math.round(w.x)));
    result.lost = candidates
      .filter((c) => !keep.has(c.text + '@' + Math.round(c.x)))
      .slice(0, 80)
      .map((c) => ({ text: c.text, conf: c.conf, x: Math.round(c.x), y: Math.round(c.y) }));
  } catch (_) { result.lost = []; }
  return result;
}

  // --- exported onto TC ---
  TC.cleanWordText = cleanWordText;
  TC.groupIntoLines = groupIntoLines;
  TC.buildStyledWords = buildStyledWords;
});
