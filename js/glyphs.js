/* ============================================================================
   Character-level verification by template matching

   Tesseract is *confidently* wrong on certain single characters. On the built-in
   invoice "PDF" comes back "POF" with P 99 %, O 97 %, F 98 % — there is no
   confidence signal at all, so no threshold can catch it. Re-reading the word at
   higher resolution does not help either: measured on an isolated 4x crop the
   answers were "PD", "PDA", "PC" and "POF", never "PDF". The information is not
   in the LSTM's output.

   What *is* on the page is the glyph's actual shape. So this pass renders each
   candidate character and correlates it against the page glyph, both normalised
   to a small coverage grid. On the built-in invoice, at the size the letters
   actually appear (13-15 px of ink), the separation is:

     glyph   truth     runner-up           margin
     D       D .57     O .41               .16
     O       O .97     D .75               .22
     P       P .93     F .78               .15
     B       B .79     8 .50               .29

   A .16 margin is not much, and the pass is tuned around that fact rather than
   pretending otherwise: the gate is .16, a degenerate reference is treated as
   "no comparison" and not as a win, and anything the segmentation cannot cut
   confidently is skipped. On the built-in samples that means exactly one change
   — "POF" to "PDF" — in five runs out of five, and no changes at all on the
   worksheet.

   Two earlier attempts failed for reasons worth recording, because they are the
   whole difficulty.

   Symbols. Tesseract reports per-character boxes in `symbols`, and using them
   looks obviously right. They are not in page coordinates: a "P" of a word at
   page x=97 reports x0=302, a first symbol of "INVOICE" is 71 px tall, and even
   after rescaling by the OCR scale factor the x-ratios differ per word (2.11,
   3.16). Probing page ink with them silently reads the wrong pixels, which is
   why several earlier versions of this pass scored everything at 0.2-0.4. The
   boxes are derived from the ink instead — see glyphBoxes.

   Size. The reference was first rendered at a *nominal* size taken from the
   word, while the page glyph is an anti-aliased, downsampled raster of that
   letter. Correlation then fell to 0.36-0.42 and the margins became noise. The
   fix is to render the reference until its *ink height matches the page glyph's
   ink height*, which is what makes the two grids comparable.

   Two rules keep the pass honest:
     · It only arbitrates between readings that already exist — the candidate
       set is the character Tesseract chose plus the shapes it is known to
       confuse it with, so it can never invent a letter nobody read.
     · It only changes a character on a large margin. A close match is evidence
       of nothing and the engine's reading stands.
   ========================================================================== */

TC.register(function (TC) {
  'use strict';

  /* Candidate sets for the confusions that occur in ordinary documents. Only
   * characters with an entry are ever examined, so the cost is paid on the
   * handful of letters that actually get misread. */
  const CONFUSABLE = {
    D: 'DO', O: 'ODQ', P: 'PF', F: 'FP', B: 'B8',
    '8': '8B', '0': '0OD', Q: 'QO', S: 'S5', '5': 'S5',
    '1': '1l', l: 'l1', G: 'G6', '6': '6G', C: 'CG', E: 'EF', R: 'RP',
  };

  /* Normalised coverage grid. 12x16 is coarse on purpose: enough to separate an
   * O from a D at 14 px, coarse enough that a one-pixel difference in glyph
   * extent does not move the score. */
  const GRID_W = 12, GRID_H = 16;

  function inkProbe(data, W, H, bg, thresh) {
    const t2 = (thresh || 60) * (thresh || 60);
    return (x, y) => {
      if (x < 0 || y < 0 || x >= W || y >= H) return false;
      const p = (y * W + x) * 4;
      return TC.colorDist2(data[p], data[p + 1], data[p + 2], bg.r, bg.g, bg.b) > t2;
    };
  }

  /** Tight ink box for a region. */
  function inkBox(ink, x0, y0, x1, y1) {
    // Guard the numbers: a malformed box must make this pass abstain, never
    // throw. Boxes reach here from OCR output that is not always finite.
    if (![x0, y0, x1, y1].every((v) => Number.isFinite(v))) return null;
    if (x1 < x0 || y1 < y0) return null;
    let mnx = Infinity, mny = Infinity, mxx = -1, mxy = -1;
    for (let y = Math.floor(y0); y <= Math.ceil(y1); y++) {
      for (let x = Math.floor(x0); x <= Math.ceil(x1); x++) {
        if (!ink(x, y)) continue;
        if (x < mnx) mnx = x;
        if (x > mxx) mxx = x;
        if (y < mny) mny = y;
        if (y > mxy) mxy = y;
      }
    }
    if (mxx < 0) return null;
    return { x0: mnx, y0: mny, x1: mxx, y1: mxy, w: mxx - mnx + 1, h: mxy - mny + 1 };
  }

  /** Coverage grid of the ink inside a box: each cell is the inked fraction. */
  function coverageGrid(ink, b) {
    const out = [];
    for (let gy = 0; gy < GRID_H; gy++) {
      const row = [];
      for (let gx = 0; gx < GRID_W; gx++) {
        const xa = b.x0 + (b.w * gx) / GRID_W, xb = b.x0 + (b.w * (gx + 1)) / GRID_W;
        const ya = b.y0 + (b.h * gy) / GRID_H, yb = b.y0 + (b.h * (gy + 1)) / GRID_H;
        let n = 0, tot = 0;
        for (let y = Math.floor(ya); y < Math.ceil(yb); y++) {
          for (let x = Math.floor(xa); x < Math.ceil(xb); x++) { tot++; if (ink(x, y)) n++; }
        }
        row.push(tot ? n / tot : 0);
      }
      out.push(row);
    }
    return out;
  }

  /** Pearson correlation of two coverage grids. */
  function correlate(A, B) {
    if (!A || !B) return -1;
    const n = GRID_W * GRID_H;
    let ma = 0, mb = 0;
    for (let y = 0; y < GRID_H; y++) for (let x = 0; x < GRID_W; x++) { ma += A[y][x]; mb += B[y][x]; }
    ma /= n; mb /= n;
    let num = 0, da = 0, db = 0;
    for (let y = 0; y < GRID_H; y++) {
      for (let x = 0; x < GRID_W; x++) {
        const a = A[y][x] - ma, b = B[y][x] - mb;
        num += a * b; da += a * a; db += b * b;
      }
    }
    return (da > 0 && db > 0) ? num / Math.sqrt(da * db) : -1;
  }

  /**
   * Reference glyphs, rendered until their ink height matches the page glyph.
   *
   * The size search is the important part. A reference drawn at the word's
   * nominal font size has a different ink height from the page's anti-aliased
   * glyph — a 20 px font has a 14 px cap — and correlating two grids with
   * different effective resolutions destroys the signal. Rendering at a spread
   * of sizes and keeping the one whose ink height is closest to the target is
   * cheap (a few small canvases, cached per size) and makes the comparison
   * like-for-like.
   */
  const refCache = new Map();

  function renderGlyphGrid(ch, fontPx, weight) {
    let grid = null;
    try {
      const size = Math.max(6, Math.round(fontPx));
      const c = TC.makeCanvas(200, 200);
      const x = TC.ctxOf(c);
      x.fillStyle = '#ffffff';
      x.fillRect(0, 0, 200, 200);
      x.fillStyle = '#000000';
      x.font = `${weight} ${size}px Arial, Helvetica, sans-serif`;
      x.textAlign = 'left';
      x.textBaseline = 'alphabetic';
      x.fillText(ch, 60, 140);
      const data = x.getImageData(0, 0, 200, 200).data;
      const ink = inkProbe(data, 200, 200, { r: 255, g: 255, b: 255 });
      const b = inkBox(ink, 0, 0, 199, 199);
      if (!b || b.w < 2 || b.h < 4) return null;
      grid = coverageGrid(ink, b);
      return { grid, h: b.h };
    } catch (e) {
      return null;
    }
  }

  function referenceFor(ch, targetH, weight) {
    const key = `${ch}|${weight}|${targetH}`;
    const hit = refCache.get(key);
    if (hit !== undefined) return hit;
    let best = null;
    // Search a spread around the target height. Font size and ink height differ
    // by a face-dependent factor, so search rather than assume a ratio.
    const base = Math.max(6, Math.round(targetH));
    const sizes = [];
    for (let f = 0.9; f <= 1.8; f += 0.12) sizes.push(Math.round(base * f));
    for (const s of sizes) {
      const r = renderGlyphGrid(ch, s, weight);
      if (!r) continue;
      const err = Math.abs(r.h - targetH);
      if (!best || err < best.err) best = { ...r, err };
      if (err === 0) break;
    }
    const out = best ? best.grid : null;
    refCache.set(key, out);
    return out;
  }

  /**
   * Decide one character from ink. Returns the winner, its score, the runner-up
   * and the margin between them — the caller sets the threshold, because a
   * margin is meaningful evidence while a raw score is not.
   */
  function classifyGlyph(ink, box, candidates, weight) {
    if (!box) return null;
    const b = inkBox(ink, box.x0, box.y0, box.x1, box.y1);
    if (!b || b.h < 6 || b.w < 3) return null;
    const grid = coverageGrid(ink, b);
    let best = null, second = null;
    for (const ch of candidates) {
      const ref = referenceFor(ch, b.h, weight);
      const score = correlate(grid, ref);
      if (!best || score > best.score) { second = best; best = { ch, score }; }
      else if (!second || score > second.score) { second = { ch, score }; }
    }
    if (!best) return null;
    return {
      ch: best.ch,
      score: best.score,
      runnerUp: second ? second.ch : null,
      runnerScore: second ? second.score : -1,
      margin: second ? best.score - second.score : 1,
      h: b.h, w: b.w,
    };
  }

  /**
   * Segment a word's ink into per-character boxes.
   *
   * Tesseract does report symbol boxes, but measured on the invoice sample they
   * arrive in a coordinate space of their own — a "P" of a word at page y=139
   * reports y 139-189 with a width of 41 px, and the first symbol of "INVOICE"
   * is 71 px tall. They cannot be trusted to address the page raster, and
   * without correct boxes the character-level pass has nothing to look at.
   *
   * So the boxes are measured from the ink instead. Glyphs in running text are
   * separated by clear vertical gaps, which is exactly the structure a word's
   * own column profile exposes. Splitting on the widest gaps until the count
   * matches the character count gives boxes that are guaranteed to line up with
   * the ink the matcher is going to compare.
   */
  function glyphBoxes(ink, wordBox, text, weight) {
    if (!wordBox || !text) return null;
    const chars = Array.from(String(text));
    const count = chars.length;
    if (!(count > 0)) return null;
    let b = inkBox(ink, wordBox.x0, wordBox.y0, wordBox.x1, wordBox.y1);
    if (!b || b.w < count * 2 || b.h < 6) return null;

    /* Ink that is not part of the word.
     *
     * A word's box routinely overlaps its neighbours: the QTY "1" of the next
     * table column sits 3 px from "tokens", so it lands inside the box and gets
     * counted as a character. Left alone, that ink is a cell with no letter to
     * be, its correlation is meaningless, and it wins any comparison outright —
     * "tokens" became "tokens1" on exactly that.
     *
     * The test is vertical: a glyph of this word stops where the word's own
     * band stops, while foreign ink on a different baseline starts above or
     * ends below it. Only the *edges* are checked, and only where the ink
     * actually runs past the band — text inside the band is never touched. */
    const band = bandOf(ink, b);
    if (band) {
      const before = b;
      const left = edgeCut(ink, b, band, +1);
      const right = edgeCut(ink, b, band, -1);
      if (left || right) {
        b = inkBox(ink, b.x0 + left, b.y0, b.x1 - right, b.y1);
        if (!b || b.w < count * 2) b = before;
      }
    }

    const WC = b.w;

    /* Where the boundaries may go: a window around even spacing. Wide enough to
     * reach a real gap, narrow enough that a cut cannot wander into the middle
     * of a glyph — "DESCRIPTION" would otherwise happily hand three columns of
     * D to E and still line up on the other side. */
    const pitch = WC / count;
    const slack = Math.max(1, Math.min(4, Math.round(pitch * 0.45)));
    const cands = [];
    for (let i = 1; i < count; i++) {
      const ideal = i * pitch;
      const lo = Math.round(ideal - slack);
      const hi = Math.round(ideal + slack);
      const list = [];
      for (let x = lo; x <= hi; x++) list.push(x);
      if (!list.length) list.push(Math.round(ideal));
      cands.push(list.map((x) => Math.max(1, Math.min(WC - 1, x))));
    }

    /* Score a cell by how well its ink matches a letter it could be.
     * This is the whole trick: with touching glyphs there is no empty column to
     * cut at, but there *is* a cut that leaves two glyphs that each look like
     * themselves, and one that slices a bowl in half. Measuring the second case
     * scores badly, so the search can tell them apart. */
    const cellCache = new Map();
    const cellScore = (xa, xb, ch) => {
      // Score against the whole confusion set, not the letter that was read.
      // Otherwise the boundaries depend on the reading they are about to judge,
      // and the same ink gets sliced two different ways in two runs — which is
      // exactly how a 0.15 margin became a coin toss.
      const candsFor = CONFUSABLE[ch] || ch;
      const key = xa + ':' + xb + ':' + candsFor;
      const hit = cellCache.get(key);
      if (hit !== undefined) return hit;
      const box = inkBox(ink, b.x0 + xa, b.y0, b.x0 + xb - 1, b.y1);
      let s = -1;
      if (box && box.w >= 2) {
        const grid = coverageGrid(ink, box);
        for (const cand of candsFor) {
          const ref = referenceFor(cand, box.h, weight);
          const v = correlate(grid, ref);
          if (v > s) s = v;
        }
      }
      cellCache.set(key, s);
      return s;
    };

    /* 1-D dynamic programme over the boundaries, with one cell of slack at each
     * end so a cell made mostly of foreign ink can be excluded from the word
     * rather than being forced to become a letter. */
    const margin = Math.max(2, Math.round(pitch * 0.9));
    let prev = new Map([[0, 0]]);
    const back = [];
    for (let i = 0; i < count - 1; i++) {
      const cur = new Map();
      const bk = new Map();
      for (const xb of cands[i]) {
        let bestPrev = null, bestVal = -Infinity;
        for (const [xa, val] of prev) {
          if (xb - xa < 2) continue;
          const v = val + cellScore(xa, xb, chars[i]);
          if (v > bestVal) { bestVal = v; bestPrev = xa; }
        }
        if (bestPrev !== null) { cur.set(xb, bestVal); bk.set(xb, bestPrev); }
      }
      if (!cur.size) return null;
      back.push(bk);
      prev = cur;
    }
    let bestEnd = null, bestTotal = -Infinity;
    for (const [xa, val] of prev) {
      if (WC - xa < 2) continue;
      const v = val + cellScore(xa, WC, chars[count - 1]);
      if (v > bestTotal) { bestTotal = v; bestEnd = xa; }
    }
    if (bestEnd === null) return null;

    const mids = new Array(count - 1);
    let at = bestEnd;
    for (let i = back.length - 1; i >= 0; i--) {
      mids[i] = at;
      at = back[i].get(at);
    }
    const cuts = [0, ...mids, WC];

    const out = [];
    const cellPitch = WC / count;
    for (let i = 0; i < count; i++) {
      const cb = inkBox(ink, b.x0 + cuts[i], b.y0, b.x0 + cuts[i + 1] - 1, b.y1);
      if (!cb || cb.w < 2 || cb.h < 6) return null;
      /* Flag cells the segmentation had to shave, instead of trusting them.
       *
       * When a boundary lands inside a glyph the survivor is a fragment — no
       * counter, no symmetry — and a fragment is exactly the kind of ink that
       * matches the wrong letter with a confident margin. Measured on the
       * invoice: "AMOUNT" in the table header has a wide M and a wide O, so even
       * spacing puts that boundary ~10 px inside the O, and what reaches the
       * matcher is a 6 px stub. The stub reads as D at 0.61 vs O at 0.33 and
       * rewrote a *correct* word to "AMDUNT" on every run.
       *
       * The cell is still returned rather than dropping the word — "INVOICE"
       * has a legitimate 7 px I against a 17.7 px pitch, so narrow is not the
       * same as broken. It is flagged, and verifyWord will not act on a flagged
       * cell. Every correction the pass has ever made on the samples came from a
       * cell comfortably over half a pitch. */
      const flagged = cb.w < cellPitch * 0.5 || cb.w > cellPitch * 2.4;
      out.push({ x0: cb.x0, y0: cb.y0, x1: cb.x1, y1: cb.y1, flagged });
    }
    return out;
  }

  /** Vertical band a word's glyphs occupy: the y-range holding most of its ink. */
  function bandOf(ink, b) {
    const rows = [];
    for (let y = b.y0; y <= b.y1; y++) {
      let n = 0;
      for (let x = b.x0; x <= b.x1; x++) if (ink(x, y)) n++;
      rows.push(n);
    }
    const total = rows.reduce((a, v) => a + v, 0);
    if (!total) return null;
    // Keep the shortest contiguous range that holds 85 % of the ink. A word's
    // own glyphs fill its band densely; foreign ink on another baseline
    // contributes far less and lands outside.
    let best = null;
    for (let i = 0; i < rows.length; i++) {
      let acc = 0;
      for (let j = i; j < rows.length; j++) {
        acc += rows[j];
        if (acc >= total * 0.85) {
          if (!best || j - i < best[1] - best[0]) best = [i, j];
          break;
        }
      }
    }
    if (!best) return null;
    return { y0: b.y0 + best[0], y1: b.y0 + best[1] };
  }

  /**
   * How many columns of foreign ink to trim from one edge of the word box.
   * Walks inwards from the edge and stops at the first column whose ink is
   * inside the word's band. Returns 0 when there is nothing foreign.
   */
  function edgeCut(ink, b, band, dir) {
    const WC = b.w;
    const col = (i) => (dir > 0 ? b.x0 + i : b.x1 - i);
    const inBand = (x) => {
      for (let y = band.y0; y <= band.y1; y++) if (ink(x, y)) return true;
      return false;
    };
    const outBand = (x) => {
      let n = 0;
      for (let y = b.y0; y <= b.y1; y++) if (ink(x, y) && (y < band.y0 || y > band.y1)) n++;
      return n;
    };
    let i = 0;
    // Skip columns that are pure band ink: those are the word's own letters.
    while (i < WC && !outBand(col(i))) i++;
    if (i >= WC) return 0;              // no foreign ink anywhere on this edge
    // From here the ink runs past the band. Trim only while it stays that way;
    // a short runback into the band means the letter itself has started.
    let cut = 0, run = 0;
    for (; i < WC; i++) {
      if (outBand(col(i)) && !inBand(col(i))) { run++; cut = i + 1; }
      else if (run > 0) break;
    }
    return cut;
  }

  /**
   * Background behind a word, as opposed to the background of the page.
   *
   * The invoice's table header is white text on a navy band. Probing it with the
   * page background (white) marks every pixel of the band as ink, so the whole
   * word collapses into one solid block, the cells cannot be told apart and the
   * matcher reads noise — "DESCRIPTION" came back "DESCRIPTIDN" that way.
   *
   * The band is obvious in the data, so read it: the most common colour around
   * a word's box is what that word was written on.
   */
  function localBg(data, W, H, box) {
    const counts = new Map();
    const pad = 3;
    const x0 = Math.max(0, Math.floor(box.x0) - pad), x1 = Math.min(W - 1, Math.ceil(box.x1) + pad);
    const y0 = Math.max(0, Math.floor(box.y0) - pad), y1 = Math.min(H - 1, Math.ceil(box.y1) + pad);
    for (let y = y0; y <= y1; y += 1) {
      for (let x = x0; x <= x1; x += 1) {
        const p = (y * W + x) * 4;
        // Quantise to 8 levels per channel: anti-aliasing and JPEG-ish noise
        // must not split one background into thousands of near-identical keys.
        const k = ((data[p] >> 5) << 6) | ((data[p + 1] >> 5) << 3) | (data[p + 2] >> 5);
        counts.set(k, (counts.get(k) || 0) + 1);
      }
    }
    let bestKey = -1, bestN = 0;
    for (const [k, n] of counts) if (n > bestN) { bestN = n; bestKey = k; }
    if (bestKey < 0) return null;
    const r = ((bestKey >> 6) & 7) * 32 + 16, g = ((bestKey >> 3) & 7) * 32 + 16, bl = (bestKey & 7) * 32 + 16;
    const total = (x1 - x0 + 1) * (y1 - y0 + 1);
    // A background that is not clearly dominant means this word sits on
    // artwork or a gradient. Abstaining is right: there is no clean ink mask.
    if (bestN / total < 0.45) return null;
    return { r, g, b: bl };
  }

  /**
   * Normalise the two shapes a word box arrives in. Styled words carry
   * {x, y, w, h}; page words carry {x0, y0, x1, y1}. Getting this wrong is
   * silent — inkBox returns null and the whole pass abstains — so it is done in
   * one place and checked.
   */
  function boxOf(w) {
    if (!w) return null;
    if ([w.x0, w.y0, w.x1, w.y1].every((v) => Number.isFinite(v))) {
      return { x0: w.x0, y0: w.y0, x1: w.x1, y1: w.y1 };
    }
    if ([w.x, w.y, w.w, w.h].every((v) => Number.isFinite(v))) {
      return { x0: w.x, y0: w.y, x1: w.x + w.w, y1: w.y + w.h };
    }
    return null;
  }

  /**
   * Verify one word. Returns { text, changes }.
   *
   * Note the gate: confidence is deliberately *not* used. The failures this pass
   * exists for are high-confidence misreads, so gating on low confidence would
   * skip exactly the words that need help. The gate is the margin instead —
   * a decisive template win, or nothing happens.
   */
  function verifyWord(ink, word, opts) {
    const o = opts || {};
    const minMargin = o.minMargin === undefined ? 0.16 : o.minMargin;
    const minScore = o.minScore === undefined ? 0.45 : o.minScore;
    const text = word.text;
    const chars = Array.from(text);
    // Only letters and digits with a known confusion set are worth the work;
    // if the word has none, skip it before doing any segmentation.
    const worth = chars.some((ch) => CONFUSABLE[ch]);
    if (!worth) return { text, changes: [] };
    const wb = boxOf(word);
    if (!wb) return { text, changes: [] };
    /* Words made only of digits and punctuation are left alone.
     *
     * The letter-shape confusions this pass exists for (D/O, P/F, B/8) do not
     * apply inside a number, and the risk does: measured on the invoice it
     * "corrected" £16,884.00 to £16,884.D0 and 0411 to O411 — both from the
     * zero/D confusion applied where a zero is unambiguous to a reader but a
     * round glyph at 14 px is not to a 12x16 grid. A wrong number is worse than
     * a wrong letter, so numeric words are not evidence this pass can act on.
     */
    if (!/[A-Za-z]/.test(text)) return { text, changes: [] };
    const weight = word.bold ? 700 : 400;
    const boxes = glyphBoxes(ink, wb, text, weight);
    if (!boxes) return { text, changes: [] };
    const out = chars.slice();
    const changes = [];
    for (let i = 0; i < chars.length; i++) {
      const ch = chars[i];
      const cands = CONFUSABLE[ch];
      if (!cands || cands.length < 2) continue;
      // A cell the segmentation had to shave is not evidence about its letter.
      if (boxes[i].flagged) continue;
      const res = classifyGlyph(ink, boxes[i], cands, weight);
      if (!res) continue;
      // A degenerate reference scores -1 and would win every margin by default.
      // If the runner-up could not be rendered, there is no comparison to make.
      if (!(res.runnerScore > -0.9)) continue;
      if (res.ch !== ch && res.score >= minScore && res.margin >= minMargin) {
        out[i] = res.ch;
        changes.push(`${ch}->${res.ch} (${res.score.toFixed(2)} vs ${res.runnerScore.toFixed(2)}, margin ${res.margin.toFixed(2)})`);
      }
    }
    return { text: out.join(''), changes };
  }

  /** Apply to a page's words. */
  function verifyPageWords(words, data, W, H, bg, opts) {
    // One ink probe per background colour actually used, not one per page.
    const probes = new Map();
    const probeFor = (b) => {
      const key = b ? `${b.r},${b.g},${b.b}` : 'page';
      let fn = probes.get(key);
      if (!fn) { fn = inkProbe(data, W, H, b || bg); probes.set(key, fn); }
      return fn;
    };
    let changed = 0;
    const log = [];
    for (const w of words) {
      if (!w.text) continue;
      let res;
      try {
        const wb = boxOf(w);
        if (!wb) continue;
        // Probe against the word's own background when it has one of its own.
        const lb = localBg(data, W, H, wb);
        res = verifyWord(probeFor(lb), w, opts);
      } catch (e) { continue; }
      if (res.text !== w.text) {
        log.push(`"${w.text}" -> "${res.text}" [${res.changes.join(', ')}]`);
        w.templateFix = { from: w.text, to: res.text, changes: res.changes };
        w.text = res.text;
        changed++;
      }
    }
    if (log.length) console.info(`template verification: ${changed} word(s) corrected\n  ${log.join('\n  ')}`);
    return changed;
  }

  // --- exported onto TC ---
  TC.CONFUSABLE = CONFUSABLE;
  TC.coverageGrid = coverageGrid;
  TC.correlate = correlate;
  TC.classifyGlyph = classifyGlyph;
  TC.verifyWordTemplates = verifyWord;
  TC.verifyPageTemplates = verifyPageWords;
  TC.inkProbe = inkProbe;
  TC.inkBox = inkBox;
  TC.referenceFor = referenceFor;
  TC.glyphBoxes = glyphBoxes;
  TC.boxOf = boxOf;
  TC.localBg = localBg;
});
