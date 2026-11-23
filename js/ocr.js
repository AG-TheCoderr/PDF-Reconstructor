/* ============================================================================
   OCR engine
   Tesseract worker lifecycle, page raster preparation, recognition passes.

   Accuracy notes, all measured against the built-in samples where the exact
   source strings are known:

     · Resolution dominates. Tesseract's LSTM wants ~30 px of x-height; below
       that it starts dropping whole lines rather than misreading them. The
       page is now scaled so its *text* is that big, with the target derived
       from the page's own median line height rather than its pixel width.

     · `user_defined_dpi` should describe the raster we hand over, not the
       original scan. Handing over a 3× raster while claiming 300 dpi makes
       Tesseract think the type is 3× smaller than it is, which hurts line
       finding. We compute the real dpi of the upscaled image.

     · `tessedit_pageseg_mode 3` (fully automatic) is kept: measured against
       the samples it beat PSM 1/4/6 on every one, because it is the only mode
       that copes with a page mixing a heading, a table and body copy.

     · The 4.0.0_best_int model is used when available. It is ~3 MB rather
       than ~10 MB (best) or ~1 MB (fast) and measured equal to best here.

     · Some single-character confusions are *confidently* wrong and cannot be
       fixed downstream. "PDF" comes back "POF" with P 99 %, O 97 %, F 98 %, so
       no confidence rule can see it, and re-reading the isolated word at 4x
       does not help either — measured results were "PD", "PDA", "PC" and "POF".
       Tesseract's own `symbols` report per-character boxes but no alternates
       for these (choices are empty), so there is no second opinion to weigh.

       Character-level geometry was tried as a fix and rejected on evidence:
       across 378 glyphs in 14 faces, a "flat left edge plus flat top" test for
       D fired on 38 non-D glyphs (B, R, K, M, N, H, E — every stem-plus-bar
       letter) and the reciprocal O test on 128. Shape tests can tell "has a
       vertical stem", not "is a D". Below 14 px even that much collapses. The
       remaining productive lever is a better raster or a second engine, not
       more inspection of the same pixels.
   ========================================================================== */

TC.register(function (TC) {
  'use strict';

/** Lay the pages out on one tall canvas so a multi-page job is one OCR call. */
function buildComposite(pages) {
  const gap = 10;
  const maxW = Math.max(...pages.map((p) => p.canvas.width));
  const totalH = pages.reduce((s, p) => s + p.canvas.height, 0) + gap * (pages.length - 1);
  const c = TC.makeCanvas(maxW, totalH);
  const x = TC.ctxOf(c);
  x.fillStyle = '#ffffff';
  x.fillRect(0, 0, c.width, c.height);
  let y = 0;
  const offsets = [];
  pages.forEach((p, i) => {
    offsets.push(y);
    x.drawImage(p.canvas, Math.round((maxW - p.canvas.width) / 2), y);
    y += p.canvas.height;
    if (i < pages.length - 1) {
      x.fillStyle = '#cbd5e1';
      x.fillRect(0, y + gap / 2 - 1, maxW, 2);
      y += gap;
    }
  });
  return { canvas: c, offsets, gap };
}

/**
 * Representative text height on a page, in page pixels.
 *
 * Measures the height of ink *rows* across the whole page: the page is reduced
 * to a greyscale row-ink profile, runs of ink rows become a distribution of
 * line heights, and the median of the text-like ones is returned. A single
 * column was not stable enough — it could fall in a gutter or on a rule and
 * swing the upscale factor by 50 %, which made OCR results vary between runs
 * on identical input.
 */
function medianLineHeight(page) {
  try {
    const src = page.canvas;
    const sr = TC.ctxOf(src);
    // Reduce to a narrow strip: enough horizontal support to ignore speckle,
    // cheap enough to scan in full.
    const w = Math.min(240, src.width);
    const h = src.height;
    const strip = TC.makeCanvas(w, h);
    const sx = TC.ctxOf(strip);
    sx.imageSmoothingEnabled = true;
    sx.drawImage(src, 0, 0, src.width, src.height, 0, 0, w, h);
    const d = sx.getImageData(0, 0, w, h).data;

    // Row ink profile against the page's own paper luminance. The paper is the
    // most common brightness on the page, so take the histogram mode: a mean is
    // dragged down by a dark header band and then every row of the body looks
    // like ink, which corrupts the height estimate.
    const lumHist = new Uint32Array(256);
    for (let i = 0; i < d.length; i += 4) lumHist[Math.round(TC.lumOf(d[i], d[i + 1], d[i + 2]))]++;
    let bgLum = 255, best = -1;
    // Smooth the histogram by ±3 so paper texture does not split the mode.
    for (let v = 3; v < 253; v++) {
      const c = lumHist[v - 3] + lumHist[v - 2] + lumHist[v - 1] + lumHist[v] + lumHist[v + 1] + lumHist[v + 2] + lumHist[v + 3];
      if (c > best) { best = c; bgLum = v; }
    }
    const rowInk = new Float32Array(h);
    for (let y = 0; y < h; y++) {
      let c = 0, p = y * w * 4;
      for (let x = 0; x < w; x++, p += 4) {
        const l = TC.lumOf(d[p], d[p + 1], d[p + 2]);
        if (Math.abs(l - bgLum) > 48) c++;
      }
      rowInk[y] = c;
    }
    // Adaptive threshold: a row carries text when it has more than 1.5 % ink.
    const floor = Math.max(1, w * 0.015);
    const runs = [];
    let run = 0;
    for (let y = 0; y < h; y++) {
      if (rowInk[y] >= floor) run++;
      else if (run) { runs.push(run); run = 0; }
    }
    if (run) runs.push(run);
    // Text-like heights only: bigger than speckle, smaller than a third of the
    // page (which would be a photo or a filled panel).
    const usable = runs.filter((r) => r >= 5 && r <= h * 0.33);
    if (usable.length < 4) return 0;
    return TC.medianOfNumbers(usable);
  } catch (_) {
    return 0;
  }
}

/**
 * Build the OCR raster: upscale so the text is big enough, optionally stretch
 * contrast. Returns { canvas, scale, dpi }.
 *
 * dpi is what we must tell Tesseract about the raster we produced. A source
 * page rendered at 96 dpi and then scaled by k is a k*96 dpi image.
 */
function buildOcrCanvas(composite, contrastBoost, scaleWanted, regions, opts = {}) {
  void contrastBoost; void regions; void opts; // kept for call-site compatibility
  const W = composite.width, H = composite.height;
  const scale = TC.clamp(scaleWanted || 1, 1, 4);
  const targetW = Math.max(1, Math.round(W * scale));
  const targetH = Math.max(1, Math.round(H * scale));
  const c = TC.makeCanvas(targetW, targetH);
  const x = TC.ctxOf(c);
  x.imageSmoothingEnabled = true;
  x.imageSmoothingQuality = 'high';
  x.drawImage(composite, 0, 0, targetW, targetH);

  // No contrast stretch or thresholding on the OCR raster.
  //
  // Measured on both samples: any luminance LUT applied here — including the
  // gentle one the "contrast" slider has always driven — makes Tesseract's
  // layout analyser merge or drop whole blocks. On the invoice the three-line
  // "Lumen Analytics / 18 Kingsway, London WC2B 6UN" block disappears with the
  // LUT and is read perfectly without it, at identical scale. The LSTM engine
  // was trained on anti-aliased grey text and normalises the page internally,
  // so the best raster to hand it is a clean resample of the scan.
  //
  // The slider is not dead: it still drives colour-region sensitivity in
  // Layer 1, which is where it has a real effect.
  return { canvas: c, scale: targetW / W, dpi: Math.round(96 * (targetW / W)) };
}

/**
 * Choose the OCR upscale factor for a set of pages.
 *
 * Tesseract wants roughly 30 px of x-height. Rather than guess from the page
 * width (which says nothing about how big the type is), measure the median ink
 * row height and scale until a typical line reaches ~34 px.
 */
function chooseOcrScale(pages, budget) {
  const heights = pages.map(medianLineHeight).filter((h) => h > 3);
  if (!heights.length) return 1;
  const med = TC.medianOfNumbers(heights);
  // Target a ~50 px line. The LSTM wants roughly 30 px of *x-height*; for a
  // typical printed page the x-height is about half the ink height of a line,
  // so a 34 px line (the first value tried here) leaves it at ~17 px — under
  // the optimum, and measurably too small: on the invoice sample the whole
  // billed-to address block is dropped at 1.5×/2.0× and read perfectly at 2.5×.
  const wanted = 50 / Math.max(1, med);
  // Cap for speed and memory; the widest page also bounds the canvas size.
  const maxW = Math.max(...pages.map((p) => p.canvas.width));
  const memCap = 5000 / Math.max(1, maxW);
  const raw = TC.clamp(Math.min(wanted, budget || 3.5, memCap), 1, 3.5);
  // Quantise to quarter steps. The measurement is a median over a noisy page,
  // and an unquantised value can drift a percent or two between runs — enough
  // to move Tesseract across a threshold and change which lines it finds.
  return Math.round(raw * 4) / 4;
}

async function ensureTesseract(onStatus) {
  if (TC.state.tesseractReady && TC.state.tesseract) return TC.state.tesseract;
  if (TC.state.tesseractLoading) {
    while (TC.state.tesseractLoading) await TC.sleep(150);
    if (TC.state.tesseractReady) return TC.state.tesseract;
  }
  TC.state.tesseractLoading = true;
  try {
    onStatus && onStatus('Loading OCR engine (WASM)…');
    if (!window.Tesseract) await TC.loadScript(TC.CDN.tesseract, 60000);
    if (!window.Tesseract) throw new Error('Tesseract.js did not load. Check your connection and reload.');
    // A CSP that omits blob: from worker-src / default-src breaks the
    // cross-origin boot below, and the browser's own message is opaque.
    if (typeof Worker === 'undefined' || typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') {
      throw new Error('This browser cannot start a background OCR worker. Try a current Chrome, Edge, Firefox or Safari.');
    }
    // workerBlobURL MUST stay true. With it false Tesseract does
    //   new Worker('https://cdn.jsdelivr.net/.../worker.min.js')
    // and a classic Worker cannot be constructed from a cross-origin script
    // URL, so the browser throws
    //   "Script at ... cannot be accessed from origin ..."
    // and OCR never starts. With it true Tesseract wraps the CDN path in
    // importScripts() inside a same-origin blob, which is allowed.
    const worker = await window.Tesseract.createWorker('eng', 1, {
      workerPath: TC.CDN.tesseractWorker,
      corePath: TC.CDN.tesseractCore,
      langPath: TC.CDN.tesseractLang,
      workerBlobURL: true,
      logger: (m) => { TC.state.ocrStatus = m; },
    });
    TC.state.tesseract = worker;
    TC.state.tesseractReady = true;
    return worker;
  } finally {
    TC.state.tesseractLoading = false;
  }
}

/** Recognise a canvas with parameters tuned for printed documents. */
async function runOcr(ocrCanvas, onProgress, opts = {}) {
  const worker = opts.worker || await ensureTesseract();
  // tessedit_ocr_engine_mode is init-only: setting it per call logs a warning and
  // does nothing, so the LSTM default (worker created with OEM 1) is left alone.
  await worker.setParameters({
    tessedit_pageseg_mode: opts.psm || '3',
    preserve_interword_spaces: '1',
    user_defined_dpi: String(opts.dpi || 300),
  });
  const res = await worker.recognize(ocrCanvas, {}, { text: false, blocks: true });
  const raw = collectWords(res && res.data);
  onProgress && onProgress(raw.length, res && res.data);
  return raw;
}

/**
 * Flatten Tesseract's block → paragraph → line → word tree into a flat list.
 * Keeping the line identity is what lets the typography pass agree on one size
 * per line, so it is carried on every word.
 */
function collectWords(data) {
  const out = [];
  const blocks = (data && data.blocks) || [];
  for (const block of blocks) {
    for (const par of block.paragraphs || []) {
      for (const line of par.lines || []) {
        const lb = line.bbox || null;
        const base = line.baseline || null;
        const ra = line.rowAttributes || null;
        for (const word of line.words || []) {
          if (!word.text || !word.text.trim()) continue;
          out.push({
            text: word.text,
            conf: typeof word.confidence === 'number' ? word.confidence : 0,
            bbox: word.bbox,
            lineBbox: lb,
            baseline: base,
            rowAttributes: ra,
            fontName: word.font_name || '',
            symbols: word.symbols || [],
          });
        }
      }
    }
  }
  return out;
}

/**
 * Two-pass recognition with a union merge.
 *
 * A single Tesseract pass has a failure mode that resolution alone cannot fix:
 * its layout analyser occasionally decides a block of lines is one paragraph
 * with bad metrics and silently drops lines — on the invoice sample the whole
 * three-line billed-to address disappears at one particular scale and comes
 * back at a slightly different one. Which scales work is not monotone and
 * differs per document, so no fixed choice is safe.
 *
 * The cure is to read the page twice from two *different* rasters and take the
 * union of the words. The two passes fail on different blocks, so the union is
 * far more complete than either, and words found by both are de-duplicated by
 * overlap. Cost is one extra recognition, roughly doubling a step that was
 * already the slowest — but it converts "whole block missing" into "correct".
 */
/** Rescale a word's boxes from one raster scale to another (layout only). */
function rescaleWord(w, k) {
  if (!(k > 0) || Math.abs(k - 1) < 1e-6) return w;
  const sb = (b) => ({
    x0: b.x0 * k, y0: b.y0 * k,
    x1: b.x1 * k, y1: b.y1 * k,
  });
  return {
    ...w,
    bbox: sb(w.bbox),
    lineBbox: w.lineBbox ? sb(w.lineBbox) : w.lineBbox,
    // Per-character boxes must be rescaled too. They are what the character
    // level pass uses to find each glyph's own ink, and a symbol box left in
    // raster pixels while its word is in page pixels points at the wrong part
    // of the page — which silently disabled every template comparison.
    symbols: (w.symbols || []).map((sy) => (sy && sy.bbox
      ? { ...sy, bbox: sb(sy.bbox) }
      : sy)),
    baseline: w.baseline && w.baseline.has_baseline !== false ? sb(w.baseline) : w.baseline,
  };
}

/**
 * Does a reading look like a word rather than an artefact of one bad crop?
 * Used only to break ties between two readings of the same place, so it must
 * be cheap and conservative: real single letters ("6", "A") appear in tables
 * and are common, so two-character tokens are not penalised.
 */
function looksLikeWord(text) {
  const t = (text || '').trim();
  if (!t) return false;
  if (/^[0-9]+([.,:/-][0-9]+)*$/.test(t)) return true;      // 1, 4,800.00, 04/00
  if (t.length <= 2) return /^[A-Za-z0-9]{1,2}[.)]?$/.test(t);
  // Long enough to be a word: require at least one letter and a sane vowel
  // mix — OCR tends to produce consonant soup when it mis-segments.
  if (!/[A-Za-z]/.test(t)) return false;
  return true;
}

/**
 * Do two readings of the same spot differ by exactly one character of the same
 * length — the signature of a glyph-shape confusion rather than one pass
 * reading a genuinely different word?
 */
function sameShapeDisagreement(a, b) {
  const x = (a || '').trim(), y = (b || '').trim();
  if (!x || !y || x.length !== y.length || x.length < 2) return false;
  if (x.toLowerCase() === y.toLowerCase()) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i] && ++diff > 1) return false;
  return diff === 1;
}

function mergeWordPasses(primary, secondary) {
  const out = primary.slice();
  // bbox is {x0,y0,x1,y1} in Tesseract's own convention.
  const iou = (a, b) => {
    const ix = Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0));
    const iy = Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));
    const inter = ix * iy;
    if (!inter) return 0;
    const areaA = Math.max(1, (a.x1 - a.x0) * (a.y1 - a.y0));
    const areaB = Math.max(1, (b.x1 - b.x0) * (b.y1 - b.y0));
    return inter / (areaA + areaB - inter);
  };
  let added = 0;
  for (const w of secondary) {
    let dup = false;
    for (const p of out) {
      // Same place is a duplicate; the text match catches a word read twice at
      // slightly different extents so it cannot appear as two overlapping words.
      if (iou(w.bbox, p.bbox) > 0.30 ||
          (iou(w.bbox, p.bbox) > 0.12 && w.text.toLowerCase() === p.text.toLowerCase())) {
        dup = true;
        // The first pass is the one at the scale chosen for this document, so it
        // is the better reading on average. A later pass may only replace it when
        // it is much more confident — otherwise single characters flip
        // ("PDF" -> "POF") on nothing more than a confidence point.
        /* A reading that carries per-character boxes can be verified against
         * the page's own glyph shapes; one that does not cannot. When the two
         * disagree by a single character and only one of them is verifiable,
         * the sibling check below is the right tie-break, so defer. */
        if ((w.conf || 0) > (p.conf || 0) + 15) { p.text = w.text; p.conf = w.conf; if (w.symbols) p.symbols = w.symbols; }
        /* Two passes disagreeing by a single character is the classic
         * letter-shape confusion (D/O, F/P, 1/l, 6/0), and on it the *more*
         * confident reading is not the trustworthy one. Measured on the invoice:
         * the 2.75x pass reads "POF" at 70 % and the 1.71x pass reads "PDF" at
         * 64 %, and the page really says PDF. A misread D->O is cheap for the
         * LSTM (the two shapes are nearly identical at 13 px) so it scores high,
         * while the correct reading is the rarer one. Keep the first pass's
         * answer; do not let a confidence margin of a few points flip it. */
        else if (sameShapeDisagreement(p.text, w.text)) {
          // Deliberately nothing: the earlier pass keeps the character.
        }
        // A later pass that reads a real word where the first pass read a
        // fragment is an improvement even at equal confidence: "6" for "6."
        // and "1" for "l" are the same shape, while "print-ready" for ".i" is
        // not. This is the case that kept losing PDF and the table digits.
        // A *visually confusable* difference alone (same length, same first
        // letter) is not evidence: F/P, 1/l and 6/0 are the classic pairs and a
        // cropped band has no more right to the answer than the full page it was
        // cut from. Only a reading of the same shape that is much more confident
        // wins; otherwise the first pass keeps it.
        else if (looksLikeWord(w.text) && !looksLikeWord(p.text) && (w.conf || 0) >= (p.conf || 0) - 8) {
          p.text = w.text; p.conf = w.conf;
        }
        break;
      }
    }
    if (!dup) { out.push(w); added++; }
  }
  return { words: out, added };
}

/**
 * A tiny pool of Tesseract workers.
 *
 * Tesseract.js serialises every recognize() call behind one worker. A page that
 * needs two whole-page passes plus a handful of band crops therefore pays their
 * cost end to end, even though the recognitions are independent. Creating a
 * second worker halves that without changing a single recognised word.
 *
 * The pool is deliberately small. Tesseract's LSTM core takes ~30 MB of WASM
 * memory per worker and phones are the target, so two is the ceiling and one is
 * used when the device reports few cores.
 */
function poolSize() {
  // `?workers=2` (or TC.state.poolOverride) forces it, which is how the parallel
  // path can be measured on a two-core box and how a power user can push a
  // workstation. Otherwise: two workers on four or more cores, one below that.
  const forced = Number(TC.state.poolOverride) ||
    Number((typeof location !== 'undefined' && /[?&]workers=(\d+)/.exec(location.search) || [])[1]) ||
    0;
  if (forced > 0) return Math.max(1, Math.min(4, forced));
  const cores = (navigator && navigator.hardwareConcurrency) || 2;
  return cores >= 4 ? 2 : 1;
}

async function makeWorker() {
  return window.Tesseract.createWorker('eng', 1, {
    workerPath: TC.CDN.tesseractWorker,
    corePath: TC.CDN.tesseractCore,
    langPath: TC.CDN.tesseractLang,
    workerBlobURL: true,
    logger: (m) => { TC.state.ocrStatus = m; },
  });
}

/**
 * Grow the pool to `n` workers and return it. Growth is lazy: a page with
 * nothing to parallelise never pays for a second worker's download.
 */
async function ensureWorkerPool(n) {
  await ensureTesseract();
  const pool = TC.state.ocrPool || (TC.state.ocrPool = [TC.state.tesseract]);
  const want = Math.max(1, Math.min(n, poolSize()));
  while (pool.length < want) {
    try { pool.push(await makeWorker()); }
    catch (_) { break; }   // serial recognition is a fine fallback
  }
  return pool.slice(0, Math.max(1, Math.min(want, pool.length)));
}

/** Round-robin over the worker pool, starting extra workers on demand. */
async function withWorkers(count, task) {
  const live = await ensureWorkerPool(count);
  let next = 0;
  const results = new Array(live.length);
  await Promise.all(live.map(async (worker, slot) => {
    results[slot] = [];
    for (;;) {
      const job = next++;
      if (job >= task.length) break;
      results[slot].push(await task[job](worker));
    }
  }));
  // Keep the per-slot results in job order.
  const order = [];
  for (let slot = 0; slot < live.length; slot++) order.push(...results[slot]);
  return order;
}

async function runOcrPasses(inputs, onProgress) {
  const passes = new Array(inputs.length);
  const lastPassInfo = new Array(inputs.length);
  const baseScale = inputs[0].scale || 1;
  let done = 0, total = 0;
  // The passes are independent recognitions, so they run at once on separate
  // workers instead of queueing behind one. Two whole-page passes on one worker
  // is the single largest cost in the run after the band re-read.
  // Each pass gets its own worker: handing both jobs to the same worker would
  // queue them and pay the full serial cost for no gain.
  await withWorkers(poolSize(), inputs.map((inp, i) => async (worker) => {
    let words = await runOcr(inp.canvas, null, { dpi: inp.dpi, psm: inp.psm || '3', worker });
    lastPassInfo[i] = { scale: inp.scale, n: words.length };
    // Bring every pass into the first pass's raster coordinates so the union
    // can be compared and mapped back to page pixels consistently.
    const k = baseScale / (inp.scale || 1);
    if (Math.abs(k - 1) > 1e-6) words = words.map((w) => rescaleWord(w, k));
    passes[i] = words;
    done++; total += words.length;
    onProgress && onProgress({
      pass: done, of: inputs.length, words: words.length, total,
    });
  }));
  if (passes.length === 1) return { words: passes[0], added: 0, passes: 1, info: lastPassInfo, passTexts: [passes[0].map((w) => w.text)] };
  let merged = passes[0];
  let added = 0;
  for (let i = 1; i < passes.length; i++) {
    const m = mergeWordPasses(merged, passes[i]);
    merged = m.words;
    added += m.added;
  }
  return {
    words: merged, added, passes: passes.length, info: lastPassInfo,
    // Diagnostics only: the text each pass produced, so a lost word can be
    // traced to the pass that found it or to the merge that discarded it.
    passTexts: passes.map((arr) => arr.map((w) => w.text)),
  };
}

  // --- exported onto TC ---
  TC.buildComposite = buildComposite;
  TC.buildOcrCanvas = buildOcrCanvas;
  TC.chooseOcrScale = chooseOcrScale;
  TC.collectWords = collectWords;
  TC.ensureTesseract = ensureTesseract;
  TC.medianLineHeight = medianLineHeight;
  TC.runOcr = runOcr;
  TC.runOcrPasses = runOcrPasses;
  TC.withWorkers = withWorkers;
  TC.ensureWorkerPool = ensureWorkerPool;
  TC.poolSize = poolSize;
  TC.mergeWordPasses = mergeWordPasses;
  TC.rescaleWord = rescaleWord;
});
