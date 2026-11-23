/* ============================================================================
   Typography
   Turns measured word ink into Helvetica type: size, slant, tracking.

   Everything here works in *page pixels* and is converted to points by the
   assembler. The three jobs:

     estimateTypeSize   how big the original type was
     estimateSlantDeg   whether that type was italic
     estimateTracking   whether the original was letter-spaced

   Size is the hard one. A Tesseract word box is only as tall as the glyphs in
   that particular word: "Dog" gains a descender, "ill" has neither cap nor
   ascender. Dividing box height by one fixed ratio — what this app used to do —
   gives "Dog" a ~20 % larger em than "cat", and the PDF ends up with a
   different font size on every word of the same line.

   The fix is to stop guessing which glyph classes a word *might* contain and
   instead measure them. Helvetica's vertical metrics are fixed ratios of the
   em (cap 0.717, x-height 0.523, ascender 0.718, descender 0.207), so once we
   know *which bands of ink exist* in a word's box we know exactly which ratio
   to divide by. The bands come from a row-ink profile of one text line, which
   is reliable even when the page has been deskewed.
   ========================================================================== */

TC.register(function (TC) {
  'use strict';

  /* Helvetica vertical metrics, as fractions of the em. */
  const HELV = {
    cap: 0.717,
    xheight: 0.523,
    ascender: 0.718,
    descender: 0.207,
    baseline: 1,
  };

  /* Characters whose incunabula extend above the x-height in Helvetica. */
  const ASCENDER_CH = 'bdfhklt';
  const DESCENDER_CH = 'gjpqy';

  /**
   * Which glyph bands does this string occupy?
   * Returns the fraction of the em that its *ink* spans: one of the four
   * combinations Helvetica actually produces.
   */
  function inkFractionFor(text, weight) {
    const t = String(text || '');
    let hasDesc = false, hasAsc = false, hasCap = false, hasX = false;
    for (const ch of t) {
      const c = ch.toLowerCase();
      if (DESCENDER_CH.includes(c)) hasDesc = true;
      if (ASCENDER_CH.includes(c)) hasAsc = true;
      if (/[A-Z0-9]/.test(ch)) hasCap = true;
      if (/[a-z]/.test(ch)) hasX = true;
    }
    // Punctuation and symbols sit in the x-height band, and in a bold face
    // they are thick enough to define it. Digits are cap height.
    if (!hasX && /[.,;:'"!?*+=]/.test(t)) hasX = true;
    let top;
    if (hasCap) top = HELV.cap;
    else if (hasAsc) top = HELV.ascender;
    else if (hasX) top = HELV.xheight;
    else top = HELV.cap;              // digits, punctuation-only, fallback
    if (weight && weight.bold) top += 0.008;   // bold faces sit a hair taller
    return top + (hasDesc ? HELV.descender : 0);
  }

  /**
   * Row-ink profile of a word box.
   * Returns the first and last row (relative to the box) that contain ink, and
   * the ink mass per row, measured against the word's own background.
   */
  function rowProfile(data, W, bbox, bg, tol) {
    const x0 = TC.clamp(Math.floor(bbox.x), 0, W - 1);
    const y0 = TC.clamp(Math.floor(bbox.y), 0, data.H - 1);
    const x1 = TC.clamp(Math.ceil(bbox.x + bbox.w), x0 + 1, W);
    const y1 = TC.clamp(Math.ceil(bbox.y + bbox.h), y0 + 1, data.H);
    const rows = [];
    const t2 = tol * tol;
    for (let y = y0; y < y1; y++) {
      let c = 0;
      let p = (y * W + x0) * 4;
      for (let x = x0; x < x1; x++, p += 4) {
        if (TC.colorDist2(data.px[p], data.px[p + 1], data.px[p + 2], bg.r, bg.g, bg.b) > t2) c++;
      }
      rows.push(c);
    }
    let first = -1, last = -1;
    const minInk = Math.max(1, Math.round((x1 - x0) * 0.012));
    for (let i = 0; i < rows.length; i++) if (rows[i] >= minInk) { if (first < 0) first = i; last = i; }
    return { rows, first, last, x0, y0, x1, y1 };
  }

  /**
   * Vertical band layout of a line of words, in pixels.
   * Analyses the union box of the line, so every word shares the result —
   * that is what makes the whole line agree on one size.
   */
  function lineBands(data, words, bg) {
    if (!words || !words.length) return null;
    /* One outlier must not define the line's geometry. A stray glyph — a lone
     * backslash reported 64 px tall beside 15 px type, a fragment clipped from a
     * rule — otherwise drags the union box down, pushes the measured baseline
     * with it, and every word on the line is drawn through its own middle. Keep
     * the words whose height is within half to double the median. */
    const heights = words.map((w) => Math.max(1, w.h ?? w.rawH ?? 0)).sort((a, b) => a - b);
    const medH = heights[Math.floor(heights.length / 2)] || 1;
    const inliers = words.filter((w) => {
      const h = Math.max(1, w.h ?? w.rawH ?? 0);
      return h >= medH * 0.5 && h <= medH * 2;
    });
    const use = inliers.length ? inliers : words;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const w of use) {
      x0 = Math.min(x0, w.x ?? w.rawX ?? 0);
      y0 = Math.min(y0, w.y ?? w.rawY ?? 0);
      x1 = Math.max(x1, (w.x ?? w.rawX ?? 0) + (w.w ?? w.rawW ?? 0));
      y1 = Math.max(y1, (w.y ?? w.rawY ?? 0) + (w.h ?? w.rawH ?? 0));
    }
    const box = { x: x0, y: y0, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0) };
    const prof = rowProfile(data, data.W, box, bg, 46);
    if (prof.first < 0) return null;

    // Baseline: the row where ink mass collapses. Take the densest run of
    // rows, then find the last row above 35 % of peak ink below mid-box.
    const rows = prof.rows;
    const peak = Math.max(...rows);
    const mid = (prof.first + prof.last) / 2;
    let base = -1;
    for (let i = prof.last; i >= prof.first; i--) {
      if (rows[i] >= peak * 0.30 && i >= mid) { base = i; break; }
    }
    if (base < 0) base = prof.last;

    // Does the line contain ascenders / descenders at all? Compare the ink
    // mass in the strip just above the x-height band with the x-height band.
    const top = prof.first, bot = prof.last;
    const height = bot - top + 1;
    const bandAt = (f) => Math.round(top + height * f);
    const massIn = (a, b) => {
      let s = 0;
      for (let i = Math.max(0, a); i <= Math.min(rows.length - 1, b); i++) s += rows[i];
      return s;
    };
    // ink mass per row, normalised, tells us where the solid body is
    const meanMass = rows.slice(top, bot + 1).reduce((a, b) => a + b, 0) / height;
    const hasAscBand = massIn(top, bandAt(0.25)) > meanMass * 0.6;
    const hasDescBand = massIn(bandAt(0.80), bot) > meanMass * 0.55;

    return { top: prof.first, bottom: prof.last, baseline: base, hasAscBand, hasDescBand, height };
  }

  /**
   * Font size in page pixels for one word, given the line's band layout.
   *
   * The word's own ink top tells us which band it starts at:
   *     at the line top  → it has a cap or an ascender
   *     below the top    → x-height only
   * and the presence of descenders is read from the word's ink bottom.
   */
  function estimateTypeSize(word) {
    // Use the word's *measured ink* height, not the box. Tesseract's word boxes
    // are padded — the amount varies with the glyphs present and with the
    // engine's own layout — and dividing a padded box by a cap-height ratio
    // inflates the em by 20–40 %. The ink span inside the box is what the type
    // actually occupies.
    const inkH = word.inkH && word.inkH > 3 ? word.inkH : word.h;
    const h = Math.max(3, inkH);
    const t = word.text || '';
    /**
     * Which glyph bands the ink spans. This must not be downgraded on the
     * strength of the line's geometry: a word containing a capital really does
     * reach cap height, and treating it as x-height-only makes it ~37 % too
     * large. (That single mistake turned "Grass" — 20 px type — into a 44 px
     * headline on the worksheet diagram.)
     */
    const frac = inkFractionFor(t, { bold: word.bold });
    const size = h / Math.max(0.30, frac);
    return TC.clamp(size, 1.5, 400);
  }

  /**
   * Slant of a line, measured by projection profile.
   *
   * The obvious measure — how far the ink's centre of mass drifts between the
   * top and bottom of the box — is far too noisy: a full stop at the end of one
   * word, a comma, a right-aligned digit, or simply a capital that is wider at
   * the top all move the centroid a few degrees, and the result was that
   * ordinary upright text came out oblique.
   *
   * The reliable measure is the one every deskew algorithm uses: shear the ink
   * by a candidate angle and see which angle makes the vertical projection
   * sharpest. Upright type has its stems vertically aligned, so the projection
   * has deep valleys between letters; shearing by the wrong angle smears those
   * valleys away. The peak of that sharpness curve is the slant.
   *
   * Returns degrees (positive = top leans right), 0 when the line reads upright.
   */
  function lineSlantDeg(data, words, bg) {
    if (!words || !words.length) return 0;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const w of words) {
      x0 = Math.min(x0, w.x); y0 = Math.min(y0, w.y);
      x1 = Math.max(x1, w.x + w.w); y1 = Math.max(y1, w.y + w.h);
    }
    const bw = Math.round(x1 - x0), bh = Math.round(y1 - y0);
    if (bw < 24 || bh < 12 || bh > 200) return 0;

    // Collect ink points once, subsampled: the profile only needs a few hundred.
    //
    // The line's bounding box is *not* the same as the line's type. On the
    // invoice the letterhead reads "NORTHWIND STUDIO" on the left and a round
    // monogram on the right: the bounding box then spans the whole band, and
    // the circular ring's own curvature dominates a projection profile and
    // reports a confident 8° slant for upright capitals. So: measure the glyphs
    // of this line's words only, and ignore everything else inside the box.
    const own = words.map((w) => ({
      x0: Math.floor(w.x) - 1, y0: Math.floor(w.y) - 1,
      x1: Math.ceil(w.x + w.w) + 1, y1: Math.ceil(w.y + w.h) + 1,
    }));
    const inOwn = (x, y) => {
      for (const r of own) if (x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1) return true;
      return false;
    };
    const pts = [];
    const t2 = 46 * 46;
    const step = Math.max(1, Math.floor(bw * bh / 9000));
    let n = 0;
    for (let y = 0; y < bh; y++) {
      const sy = Math.round(y0 + y);
      if (sy < 0 || sy >= data.H) continue;
      let p = (sy * data.W + Math.round(x0)) * 4;
      for (let x = 0; x < bw; x++, p += 4) {
        if ((n++ % step) !== 0) continue;
        if (TC.colorDist2(data.px[p], data.px[p + 1], data.px[p + 2], bg.r, bg.g, bg.b) > t2) {
          // Coordinates here are relative to the line box.
          if (inOwn(x + Math.round(x0), y + Math.round(y0))) pts.push(x, y);
        }
      }
    }
    const count = pts.length / 2;
    if (count < 60) return 0;

    // Ink spread per unit height must be sensible for type, not a filled block.
    const density = count / (bw * bh);
    if (density > 0.55) return 0;

    const sharpness = (tanA) => {
      const cols = new Float32Array(bw + Math.ceil(bh * Math.abs(tanA)) + 2);
      const off = tanA > 0 ? 0 : Math.ceil(bh * -tanA);
      const midY = bh / 2;
      for (let i = 0; i < pts.length; i += 2) {
        const xi = pts[i] - (pts[i + 1] - midY) * tanA + off;
        const c = Math.round(xi);
        if (c >= 0 && c < cols.length) cols[c]++;
      }
      // Sharpness = variance of the column profile. Maximised when letters are
      // separated by empty columns.
      let sum = 0, sum2 = 0;
      for (let i = 0; i < cols.length; i++) { sum += cols[i]; sum2 += cols[i] * cols[i]; }
      const mean = sum / cols.length;
      return sum2 / cols.length - mean * mean;
    };

    let bestDeg = 0, bestScore = -Infinity;
    const scores = [];
    for (let deg = -16; deg <= 16; deg += 1) {
      const sc = sharpness(Math.tan(deg * Math.PI / 180));
      scores.push(sc);
      if (sc > bestScore) { bestScore = sc; bestDeg = deg; }
    }
    // The peak must actually stand out from its neighbours, otherwise the line
    // is too short or too noisy to judge and upright is the safe answer.
    const mid = scores[16];   // 0 degrees
    if (bestScore <= mid * 1.08) return 0;
    // Require the peak to be a local maximum, not the edge of the search range.
    if (Math.abs(bestDeg) >= 16) return 0;
    // A slant under 4 degrees is not italic — it is measurement noise.
    return Math.abs(bestDeg) < 4 ? 0 : bestDeg;
  }

  /**
   * Letter-spacing estimate.
   *
   * Compares the ink's advance per em against Helvetica's natural advance for
   * the same string. Wide tracking (small caps titles, "N A M E") shows up as a
   * ratio well above 1. Returns an em-fraction adjustment, clamped small so a
   * bad measurement can never wreck a line.
   */
  function estimateTracking(word, widthOf) {
    const t = word.text;
    if (!t || t.length < 3 || !widthOf) return 0;
    const size = Math.max(1, word.sizePx || word.h);
    const nat = widthOf(t) * size;          // natural advance in px
    if (!isFinite(nat) || nat <= 0) return 0;
    const ratio = word.w / nat;
    // Only nudge when the original is clearly wider or tighter than the font.
    if (ratio > 1.06 && ratio < 1.9) return TC.clamp((ratio - 1) * 0.55, 0, 0.1);
    if (ratio < 0.94 && ratio > 0.55) return TC.clamp((ratio - 1) * 0.5, -0.05, 0);
    return 0;
  }

  /* --- exported onto TC --- */
  TC.HELV = HELV;
  TC.inkFractionFor = inkFractionFor;
  TC.rowProfile = rowProfile;
  TC.lineBands = lineBands;
  TC.estimateTypeSize = estimateTypeSize;
  TC.lineSlantDeg = lineSlantDeg;
  TC.estimateTracking = estimateTracking;
});
