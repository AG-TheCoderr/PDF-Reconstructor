/* ============================================================================
   Main pipeline
   Orchestrates every layer and reports progress.
   ========================================================================== */

TC.register(function (TC) {
  'use strict';

function readOptions() {
  return {
    contrast: parseFloat(TC.$('contrast').value),
    lineSens: parseFloat(TC.$('lineSens').value),
    minConf: parseInt(TC.$('minConf').value, 10),
    colorBoxes: TC.$('optColorBoxes').checked,
    lines: TC.$('optLines').checked,
    graphics: TC.$('optGraphics').checked,
    whiten: TC.$('optWhiten').checked,
    fitText: TC.$('optFitText').checked,
    boldThresh: parseFloat(TC.$('boldThresh').value),
    detectItalic: TC.$('optItalic').checked,
    pageSize: TC.state.pageSize,
  };
}

function setBusy(busy) {
  TC.state.busy = busy;
  const run = TC.$('runBtn');
  run.disabled = busy || !TC.state.pages.length;
  TC.$('resetBtn').disabled = busy;
  TC.$('sampleInvoice').disabled = busy;
  TC.$('sampleWorksheet').disabled = busy;
  TC.$('fileClear').disabled = busy;
  TC.$('runLabel').textContent = busy ? 'Rebuilding…' : 'Rebuild as PDF';
  const icon = run.querySelector('svg');
  let spin = run.querySelector('.spinner');
  if (busy && !spin) {
    spin = document.createElement('span');
    spin.className = 'spinner';
    run.insertBefore(spin, icon);
  }
  if (spin) spin.style.display = busy ? '' : 'none';
  icon.style.display = busy ? 'none' : '';
}

async function runPipeline() {
  if (TC.state.busy) return;
  if (!TC.state.pages.length) { TC.toast('Add a document first.', 'info'); return; }
  const runId = ++TC.state.runId;
  const opts = readOptions();
  const t0 = performance.now();
  setBusy(true);
  TC.progress.active = true;
  document.querySelectorAll('#steps .step-chip').forEach((c) => { c.classList.remove('active', 'done'); c.dataset.done = ''; });
  const alive = () => runId === TC.state.runId;

  try {
    /* ------------------------------ prep ------------------------------ */
    TC.progress.indeterminate(false);
    TC.progress.set(2, 'Preparing pages…', 'Preparing pages');
    await TC.nextFrame();
    const composite = TC.buildComposite(TC.state.pages);
    const pageData = TC.state.pages.map((p) => {
      const ctx = TC.ctxOf(p.canvas);
      const img = ctx.getImageData(0, 0, p.canvas.width, p.canvas.height);
      return { img, data: img.data, W: p.canvas.width, H: p.canvas.height, bg: TC.samplePageBackground(img.data, p.canvas.width, p.canvas.height), srcCanvas: p.canvas };
    });
    if (!alive()) return;

    /* ------------------------- LAYERS 1 & 2 ------------------------- */
    const perPageStructural = [];
    for (let pi = 0; pi < TC.state.pages.length; pi++) {
      const d = pageData[pi];
      TC.progress.chip('bg', 'active');
      TC.progress.set(4 + (pi / TC.state.pages.length) * 8, `Layer 1 · Colour regions — page ${pi + 1}/${TC.state.pages.length}`, 'Layer 1 · Background');
      await TC.nextFrame();
      let boxes = [];
      if (opts.colorBoxes) boxes = TC.detectColorRegions(d.img, d.W, d.H, d.bg, { colorThresh: 12 }).boxes;
      TC.progress.chip('bg', 'done');

      TC.progress.chip('lines', 'active');
      TC.progress.set(8 + (pi / TC.state.pages.length) * 8, `Layer 2 · Structural lines — page ${pi + 1}/${TC.state.pages.length}`, 'Layer 2 · Lines');
      await TC.nextFrame();
      let lines = [];
      const refImg = TC.buildBackgroundReference(d.W, d.H, d.bg, boxes);
      if (opts.lines) {
        lines = TC.detectLines(d.img, d.W, d.H, d.bg, opts.lineSens, refImg).lines;
        boxes = TC.snapBoxesToLines(boxes, lines, Math.max(3, Math.round(Math.min(d.W, d.H) * 0.004)));
      }
      TC.progress.chip('lines', 'done');
      perPageStructural.push({ boxes, lines, refImg });
      TC.state.pages[pi].layers = { bg: d.bg, boxes, lines, words: [], graphics: [] };
      TC.drawOriginalOverlay();
    }
    if (!alive()) return;

    /* --------------------------- LAYER 3a: OCR --------------------------- */
    TC.progress.chip('ocr', 'active');
    TC.progress.set(18, 'Loading OCR engine…', 'Layer 3 · OCR');
    await TC.nextFrame();
    // Scale the page until its *type* is big enough for the LSTM, measured from
    // the page's own median line height. Multi-page jobs get a smaller budget so
    // the composite stays inside canvas limits.
    const maxPageW = Math.max(...TC.state.pages.map((p) => p.canvas.width));
    const scaleBudget = TC.state.pages.length === 1 ? 3.5 : TC.clamp((1500 * 2.2) / maxPageW, 1, 2.2);
    const ocrScale = TC.chooseOcrScale(TC.state.pages, scaleBudget);
    // Two independent rasters. The second is deliberately off the "ideal"
    // scale: Tesseract's layout analyser drops different blocks at different
    // scales, so reading twice and taking the union recovers lines that a
    // single pass silently loses. See runOcrPasses() for the measurement.
    //
    // The second pass must be FAR from the first, not adjacent: Tesseract's
    // mistakes are strongly correlated between neighbouring scales (measured:
    // 2.0 and 2.75 fail on exactly the same block), so a nearby second read
    // buys almost nothing. A ratio of ~1.6 gives genuinely different
    // segmentation and re-finds different lines.
    const altScale = TC.clamp(ocrScale >= 2.2 ? ocrScale * 0.62 : ocrScale * 1.6, 1, 3.5);
    const passInputs = [
      { scale: ocrScale, contrast: opts.contrast },
      { scale: altScale, contrast: opts.contrast },
    ].map(({ scale, contrast }) => {
      const inp = TC.buildOcrCanvas(composite.canvas, contrast, scale, perPageStructural.flatMap((p) => p.boxes));
      return { canvas: inp.canvas, dpi: inp.dpi, scale };
    });
    await TC.ensureTesseract((msg) => TC.progress.set(20, msg));
    TC.progress.indeterminate(true);
    TC.progress.set(24, 'Layer 3 · Recognising text (largest step)…', 'Layer 3 · OCR');
    const passResult = await TC.runOcrPasses(passInputs, (info) => {
      TC.progress.set(24 + 8 * (info.pass / info.of), `Layer 3 · Reading page ${info.pass}/${info.of} — ${info.total} words so far`);
    });
    TC.progress.indeterminate(false);
    if (!alive()) return;
    TC.progress.chip('ocr', 'done');

    const rawWords = passResult.words;
    TC.state.lastPasses = (passResult.info || []).map((x) => ({ scale: x.scale, n: x.n }));
    TC.state.lastPassTexts = passResult.passTexts || null;
    if (passResult.added) console.info(`[ocr] second pass recovered ${passResult.added} words`);
    TC.progress.set(58, `Layer 3 · ${rawWords.length} words found — sampling colour & weight`);
    await TC.nextFrame();

    const perPageRaw = TC.state.pages.map(() => []);
    for (const w of rawWords) {
      const mapped = mapOcrWordToPageWithScale(w, ocrScale, composite, TC.state.pages);
      if (mapped) perPageRaw[mapped.pageIndex].push(mapped.word);
    }

    /* -------- targeted re-read of anything still unread -------------------
     * One pass over the whole page, driven by what we know is missing: bands of
     * ink with no recognised words on them, read as crop-sized images with each
     * column treated separately. This is the only step that recovers a block
     * Tesseract's layout analyser dropped, and it runs after the broad gap pass
     * so it does not repeat that pass's work. */
    for (let pi = 0; pi < TC.state.pages.length; pi++) {
      if (!alive()) return;
      try {
        const extra = await reReadUnderReadBands(pageData[pi], perPageRaw[pi], opts);
        if (!extra.length) continue;
        // The same page-bounds guard the gap pass uses: a crop read can
        // occasionally return a box a few pixels outside the page, and such a
        // word must never reach the assembler.
        const kept = extra.filter((w) => w.bbox && w.bbox.y0 >= -2 && w.bbox.y1 <= pageData[pi].H + 2);
        // Mark these as crop readings. A crop is how a band the full page missed
        // gets read at all, but on a word the full page *did* read it is not
        // better evidence — Tesseract still confuses F/P and 1/l, and a crop that
        // agrees on every character but one is far more likely to be the wrong
        // one ("POF" for "PDF"). Consolidation uses this mark to arbitrate.
        for (const w of kept) w.fromCrop = true;
        perPageRaw[pi].push(...kept);
        console.info(`band re-read page ${pi + 1}: +${extra.length} words (${kept.length} in bounds)`);
      } catch (err) {
        console.warn('band re-read failed', err);
      }
    }

    if (!alive()) return;

    /* -------- region fill: labels inside pale callouts are often skipped -------- */
    TC.progress.set(59, 'Reading labels inside callouts…', 'Layer 3 · OCR');
    await TC.nextFrame();
  /**
 * Remove tall lone fragments that survived consolidation: a single character
 * whose box is several times the height of the page's body type and which has
 * no neighbour beside it. On the worksheet this is the backslash Tesseract reads
 * out of a diagram arrow; drawn as type it crosses the label next to it.
 */
function dropTallFragments(words) {
  if (!words || words.length < 4) return words;
  const hs = words.map((w) => w.bbox ? Math.max(1, w.bbox.y1 - w.bbox.y0) : 1).sort((a, b) => a - b);
  const med = hs[Math.floor(hs.length / 2)] || 1;
  return words.filter((w) => {
    if (!w.bbox) return false;
    const h = w.bbox.y1 - w.bbox.y0;
    if (h < med * 2.5) return true;
    const chars = (w.text || '').replace(/\s+/g, '');
    if (chars.length > 2 || /[A-Za-z0-9]{2}/.test(chars)) return true;
    // A genuinely tall glyph has company: a bracket, a brace, a big parenthesis
    // sits beside other type on its line. Alone in its band, it is debris.
    const alone = !words.some((o) => o !== w && o.bbox &&
      Math.min(o.bbox.y1, w.bbox.y1) - Math.max(o.bbox.y0, w.bbox.y0) > h * 0.3 &&
      Math.abs((o.bbox.x0 + o.bbox.x1) / 2 - (w.bbox.x0 + w.bbox.x1) / 2) < h * 1.5);
    return !alone;
  });
}

  for (let pi = 0; pi < TC.state.pages.length; pi++) {
      if (!alive()) return;
      try {
        const structural = perPageStructural[pi];
        const extra = await ocrInsideRegions(pageData[pi], structural.boxes, perPageRaw[pi], opts);
        if (extra.length) {
          const kept = [];
          for (const w of extra) {
            const dup = perPageRaw[pi].some((k) => {
              const ix = Math.min(w.bbox.x1, k.bbox.x1) - Math.max(w.bbox.x0, k.bbox.x0);
              const iy = Math.min(w.bbox.y1, k.bbox.y1) - Math.max(w.bbox.y0, k.bbox.y0);
              return ix > 0 && iy > 0 && (ix * iy) / Math.max(1, (w.bbox.x1 - w.bbox.x0) * (w.bbox.y1 - w.bbox.y0)) > 0.35;
            });
            if (!dup) kept.push(w);
          }
          perPageRaw[pi].push(...kept);
        }
      } catch (err) {
        console.warn('region fill failed', err);
      }
    }

    /* ---------------------- LAYER 3b + LAYER 4 per page ---------------------- */
    for (let pi = 0; pi < TC.state.pages.length; pi++) {
      if (!alive()) return;
      const page = TC.state.pages[pi];
      const d = pageData[pi];
      const { boxes, lines, refImg } = perPageStructural[pi];
      perPageRaw[pi] = dropTallFragments(TC.consolidateWords(perPageRaw[pi]));
      const styled = TC.buildStyledWords(perPageRaw[pi], d.data, d.W, d.H, d.bg, { ...opts, boxes });

      /* -------- character-level verification ------------------------------
       * The last look at every uncertain reading, at the level where the
       * remaining errors live: individual letters. Tesseract reads "PDF" as
       * "POF" with 99/97/98 per-character confidence, so no confidence rule can
       * catch it, and re-reading the word bigger does not help either. What
       * does work is comparing the letter's actual ink against the same letter
       * rendered at the same size; the pass derives its own per-character boxes
       * from that ink, because Tesseract's symbol boxes do not address the page
       * raster. See js/glyphs.js. */
      if (opts.templates !== false && TC.verifyPageTemplates) {
        try {
          TC.verifyPageTemplates(styled.words, d.data, d.W, d.H, d.bg, {});
        } catch (err) { console.warn('template verification failed', err); }
      }

      TC.state.lastStyled = styled;
      TC.progress.set(60 + ((pi + 0.35) / TC.state.pages.length) * 22, `Layer 3 · Styled ${styled.words.length} words — page ${pi + 1}/${TC.state.pages.length}`);
      await TC.nextFrame();
      TC.progress.chip('text', 'done');

      TC.progress.chip('gfx', 'active');
      TC.progress.set(60 + ((pi + 0.8) / TC.state.pages.length) * 22, `Layer 4 · Tracing artwork — page ${pi + 1}/${TC.state.pages.length}`);
      await TC.nextFrame();
      let gfx = [];
      if (opts.graphics) {
        // Text that will be re-typed must not leak into graphic crops. A rotated
        // word's axis-aligned box does not cover its own ink (a stamp like PAID
        // sits on a slanted baseline), so protect the whole line box too — that
        // is the union of its words and never extends past real text.
        const typedBoxes = styled.words.map((w) => ({ x: w.x, y: w.y, w: w.w, h: w.h }));
        {
          const byLine = new Map();
          for (const w of styled.words) {
            const lb = w.lineBbox;
            const k = lb
              ? `${Math.round(lb.x0)},${Math.round(lb.y0)},${Math.round(lb.x1)},${Math.round(lb.y1)}`
              : `solo-${Math.round(w.x)},${Math.round(w.y)}`;
            let e = byLine.get(k);
            if (!e) { e = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity }; byLine.set(k, e); }
            if (lb) {
              e.x0 = Math.min(e.x0, lb.x0); e.y0 = Math.min(e.y0, lb.y0);
              e.x1 = Math.max(e.x1, lb.x1); e.y1 = Math.max(e.y1, lb.y1);
            } else {
              e.x0 = Math.min(e.x0, w.x); e.y0 = Math.min(e.y0, w.y);
              e.x1 = Math.max(e.x1, w.x + w.w); e.y1 = Math.max(e.y1, w.y + w.h);
            }
          }
          for (const e of byLine.values()) {
            if (!isFinite(e.x0)) continue;
            typedBoxes.push({ x: e.x0, y: e.y0, w: e.x1 - e.x0, h: e.y1 - e.y0 });
          }
        }
        gfx = TC.detectGraphics(d.img, d.W, d.H, d.bg, typedBoxes, lines, {
          whiten: opts.whiten,
          boxes,
          refImage: refImg,
          // Stroke outlines are thin: gate on *box size*, not ink area.
          minArea: Math.max(120, Math.round(d.W * d.H * 0.0001)),
          minDim: Math.max(26, Math.round(Math.min(d.W, d.H) * 0.02)),
        }).graphics;
      }
      // Artwork that carries a typed label (a monogram, a node caption, white
      // type on a banner) is added as a patch built from the label's own fill,
      // because component detection routinely loses it once the lettering has
      // been claimed by Layer 3.
      try {
        // Only labels whose fill is a compact shape qualify. A label on a wide
        // banner would produce a patch spanning the banner, and the banner is
        // already painted as a vector rectangle — the patch would only add a
        // duplicate.
        const labelled = styled.words.filter((w) => {
          if (!w.onArtwork) return false;
          if (w.w > d.W * 0.30 || w.h > d.H * 0.12) return false;
          // Two words in the same line (a caption split by the engine) are fine;
          // a dozen are a paragraph printed over a tinted panel, and that panel
          // is already a vector rectangle.
          const sameLine = styled.words.filter((v) => v.onArtwork && Math.abs((v.y + v.h / 2) - (w.y + w.h / 2)) < w.h * 0.6);
          if (sameLine.length > 4) return false;
          // A large word on a wide banner: its own box already proves the shape
          // is bigger than a badge, so a patch would duplicate the banner.
          return w.w < d.W * 0.14;
        });
        if (labelled.length) {
          const patches = TC.artworkPatches(d.img, d.W, d.H, labelled, d.bg, opts);
          for (const p2 of patches) {
            // Never duplicate a patch that a detected crop already covers.
            const dup = gfx.some((g) => {
              const ix = Math.min(g.x + g.w, p2.x + p2.w) - Math.max(g.x, p2.x);
              const iy = Math.min(g.y + g.h, p2.y + p2.h) - Math.max(g.y, p2.y);
              return ix > 0 && iy > 0 && (ix * iy) / Math.max(1, p2.w * p2.h) > 0.6;
            });
            // A patch that is a large fraction of the page is a background,
            // not artwork.
            if (!dup && p2.w * p2.h < d.W * d.H * 0.25) gfx.push(p2);
          }
        }
      } catch (err) {
        console.warn('artwork patch failed', err);
      }
      gfx = gfx.map((g) => TC.cleanCropAgainstVectors(g, d.W, d.H, boxes, refImg)).filter(Boolean);
      gfx = gfx.map((g) => TC.restoreCropAlpha(g)).filter(Boolean);

      /* Rotated text recovery — a stamp or slanted badge is one tilted line, and
       * its axis-aligned box cannot cover the ink, so the whole-page pass drops
       * it. Re-read each crop de-rotated; anything readable becomes typed text
       * and is cut out of the artwork so it is not drawn twice. */
      if (opts.rotatedText !== false) {
        for (const gf of gfx) {
          try {
            if (gf.canvas.width < 24 || gf.canvas.height < 14) continue;
            const ang = TC.estimateCropSkew(gf.canvas);
            if (!ang) continue;
            const scl = TC.clamp(900 / Math.max(gf.canvas.width, gf.canvas.height), 1, 4);
            const found = await ocrRotatedCrop(gf.canvas, ang, scl);
            if (!found.length) continue;
            const added = [];
            for (const f of found) {
              const px = gf.x + f.cx - f.w / 2;
              const py = gf.y + f.cy - f.h / 2;
              const dup = styled.words.some((w) => {
                const ix = Math.min(px + f.w, w.x + w.w) - Math.max(px, w.x);
                const iy = Math.min(py + f.h, w.y + w.h) - Math.max(py, w.y);
                return ix > 0 && iy > 0 && (ix * iy) / Math.max(1, f.w * f.h) > 0.4;
              });
              if (dup) continue;
              added.push({
                text: f.text,
                conf: f.conf,
                x: px, y: py, w: f.w, h: f.h,
                center: { x: gf.x + f.cx, y: gf.y + f.cy },
                bbox: { x0: px, y0: py, x1: px + f.w, y1: py + f.h },
                lineBbox: { x0: px, y0: py, x1: px + f.w, y1: py + f.h },
                baseline: null,
                rowAttributes: null,
                angleDeg: ang,
              });
            }
            if (added.length) {
              /* If the words we just read cover most of the artwork, the crop
               * existed only to carry that text (a stamp, a badge, a label).
               * Keep the typed text and discard the artwork entirely, otherwise
               * it renders twice: once as text and once as traced outlines. */
              const cropArea = gf.w * gf.h;
              const textArea = added.reduce((a, w) => a + w.w * w.h, 0);
              if (textArea / Math.max(1, cropArea) > 0.28) {
                gf.vector = null;
                gf.emptied = true;
                window.__cropDropped = (window.__cropDropped || 0) + 1;
              }
              // Recovered words need a colour: sample the ink core of each box.
              for (const a of added) {
                const box = { x: a.x, y: a.y, w: a.w, h: a.h, text: a.text };
                a.color = TC.sampleWordColor(d.data, d.W, d.H, box, d.bg) || [0, 0, 0];
                a.bold = TC.isBoxBold(d.data, d.W, d.H, box);
              }
              styled.words.push(...added);
              window.__rotatedRecovered = (window.__rotatedRecovered || 0) + added.length;
              // Cut the recovered words out of the artwork mask.
              TC.maskTextInCrop(gf, added);
            }
          } catch (err) { console.warn('rotated crop OCR failed', err); }
        }
      }

      // Re-draw every crop as geometry instead of embedding it as an image.
      for (const gf of gfx) {
        if (gf.emptied) { gf.vector = null; continue; }
        try { gf.vector = TC.vectoriseCrop(gf.canvas); } catch (err) { gf.vector = null; }
      }
      TC.progress.chip('gfx', 'done');
      page.layers = { bg: d.bg, boxes, lines, words: styled.words, graphics: gfx, dropped: styled.dropped };
      page.analysis = { words: styled.words.length, boxes: boxes.length, lines: lines.length, graphics: gfx.length };
      TC.drawOriginalOverlay();
    }
    if (!alive()) return;

    /* ------------------------------ assembly ------------------------------ */
    TC.progress.chip('pdf', 'active');
    TC.progress.set(84, 'Assembling typed PDF page…', 'PDF assembly');
    await TC.nextFrame();
    if (!window.PDFLib) await TC.loadScript(TC.CDN.pdfLib, 45000);
    const { bytes, stats } = await TC.assemblePdf(TC.state.pages, { pageSize: opts.pageSize, fitText: opts.fitText });
    if (!alive()) return;
    TC.progress.chip('pdf', 'done');
    TC.progress.set(94, 'Rendering preview…', 'Preview');

    if (TC.state.pdfUrl) URL.revokeObjectURL(TC.state.pdfUrl);
    const blob = new Blob([bytes], { type: 'application/pdf' });
    TC.state.pdfBytes = bytes;
    TC.state.pdfUrl = URL.createObjectURL(blob);
    TC.$('downloadBtn').disabled = false;
    TC.$('newTabBtn').disabled = false;
    TC.$('pdfSize').textContent = TC.fmtBytes(bytes.length);

    const totalG = TC.state.pages.reduce((s, p) => s + (p.layers ? p.layers.graphics.length : 0), 0);
    const totalL = TC.state.pages.reduce((s, p) => s + (p.layers ? p.layers.lines.length : 0), 0);
    const totalB = TC.state.pages.reduce((s, p) => s + (p.layers ? p.layers.boxes.length : 0), 0);
    TC.$('outWords').textContent = TC.fmtInt(stats.words);
    TC.$('outBoxes').textContent = TC.fmtInt(totalB);
    TC.$('outLines').textContent = TC.fmtInt(totalL);
    TC.$('outGfx').textContent = TC.fmtInt(totalG);
    TC.state.lastRunMs = performance.now() - t0;
    TC.$('outTime').textContent = (TC.state.lastRunMs / 1000).toFixed(1) + 's';
    // Session tallies: pages/words/vectors reflect the current document, not a
    // running sum across unrelated runs.
    TC.state.stats.pages = TC.state.pages.length;
    TC.state.stats.words = stats.words;
    TC.state.stats.vectors = stats.boxes + stats.lines + stats.graphics;
    TC.$('statPages').textContent = TC.fmtInt(TC.state.stats.pages);
    TC.$('statWords').textContent = TC.fmtInt(TC.state.stats.words);
    TC.$('statVectors').textContent = TC.fmtInt(TC.state.stats.vectors);

    await TC.loadPdfPreview(TC.state.pdfUrl);
    if (!alive()) return;
    TC.progress.set(100, 'Reconstruction complete', 'Complete');
    TC.$('progressStep').textContent = `Done — ${TC.fmtInt(stats.words)} words · ${TC.fmtInt(totalB)} regions · ${TC.fmtInt(totalL)} lines · ${TC.fmtInt(totalG)} graphics · ${(TC.state.lastRunMs / 1000).toFixed(1)} s`;
    TC.drawOriginalOverlay();
    TC.toast(`Reconstructed ${TC.state.pages.length} page${TC.state.pages.length > 1 ? 's' : ''} with ${TC.fmtInt(stats.words)} selectable words.`, 'ok', 3600);
  } catch (err) {
    console.error(err);
    TC.progress.indeterminate(false);
    TC.$('progressTitle').textContent = 'Reconstruction failed';
    TC.$('progressPct').textContent = '—';
    TC.$('progressStep').textContent = err && err.message ? err.message : String(err);
    TC.toast((err && err.message) || 'Reconstruction failed. Try another file.', 'err', 7000);
    if (/worker|ocr|tesseract|wasm|Core/i.test(String(err && err.message))) {
      TC.state.tesseractReady = false;
      try { if (TC.state.tesseract) TC.state.tesseract.terminate(); } catch (_) {}
      TC.state.tesseract = null;
    }
  } finally {
    setBusy(false);
    TC.progress.active = false;
  }
}

/** Recognise the OCR canvas with the shared Tesseract worker. */
async function workerRecognize(ocrCanvas, overrides, poolWorker) {
  const worker = poolWorker || TC.state.tesseract;
  if (!worker) throw new Error('OCR worker is not initialised.');
  // tessedit_ocr_engine_mode may only be set at init; setting it later triggers
  // a warning and is ignored, so it is not passed here.
  await worker.setParameters({
    tessedit_pageseg_mode: '3',
    preserve_interword_spaces: '1',
    user_defined_dpi: '300',
    ...(overrides || {}),
  });
  const res = await worker.recognize(ocrCanvas, {}, { text: false, blocks: true });
  return (res && res.data) || {};
}

/**
 * Horizontal extent of the ink inside a row range. Used to crop a band down to
 * the text it actually holds, so a recognition is not spent on blank paper.
 */
function inkExtent(y0, y1, data, W, bg, stepX) {
  let lo = W, hi = -1;
  const thresh = 60 * 60;
  for (let y = y0; y < y1; y++) {
    let p = y * W * 4;
    for (let x = 0; x < W; x += stepX, p += 4 * stepX) {
      if (TC.colorDist2(data[p], data[p + 1], data[p + 2], bg.r, bg.g, bg.b) > thresh) {
        if (x < lo) lo = x;
        if (x > hi) hi = x;
      }
    }
  }
  if (hi < 0) return { x0: 0, x1: W };
  return { x0: Math.max(0, lo - stepX), x1: Math.min(W, hi + stepX * 2) };
}

/**
 * Share of a band's ink that belongs to its single largest connected blob.
 *
 * Type is many small disconnected things. A signature squiggle, a chart line or
 * a logo stroke is one big connected thing. The fraction separates them cleanly
 * — on the invoice sample every real line of text measures under 15 %, the
 * signature well over 90 %.
 *
 * A *rule* is the exception, and it matters: a table's box drawing is one
 * connected blob that can easily own most of the band's ink while every word in
 * the band is ordinary type. So the blob is only disqualifying if it is also
 * more than a line thick — a table border is 1–2 px tall, artwork is not.
 */
function largestComponentShare(y0, y1, data, W, bg) {
  const H = data.length / (W * 4);
  const h = Math.min(y1, H) - y0;
  if (h < 4) return 1;
  const yy0 = Math.max(0, Math.floor(y0));
  // Work on a 3x3-subsampled grid. The question — "is this band many small
  // glyphs or one big stroke?" — is answered just as well at a third of the
  // resolution, and this test runs once per candidate band.
  const S = 3;
  const gw = Math.max(1, Math.floor(W / S)), gh = Math.max(1, Math.floor(h / S));
  const seen = new Uint8Array(gw * gh);
  const stack = [];
  let totalInk = 0, biggest = 0, biggestCell = -1;
  const isInk = (x, y) => {
    // A grid cell is ink when any of its source pixels is.
    for (let dy = 0; dy < S; dy++) {
      const sy = yy0 + y * S + dy;
      if (sy >= H) break;
      for (let dx = 0; dx < S; dx++) {
        const sx = x * S + dx;
        if (sx >= W) break;
        const p = (sy * W + sx) * 4;
        if (TC.colorDist2(data[p], data[p + 1], data[p + 2], bg.r, bg.g, bg.b) > 60 * 60) return true;
      }
    }
    return false;
  };
  for (let y = 0; y < gh; y++) {
    for (let x = 0; x < gw; x++) {
      const i = y * gw + x;
      if (seen[i] || !isInk(x, y)) continue;
      let count = 0;
      stack.length = 0; stack.push(i); seen[i] = 1;
      while (stack.length) {
        const cur = stack.pop();
        const cx = cur % gw, cy = (cur - cx) / gw;
        count++;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = cx + dx, ny = cy + dy;
            if (nx < 0 || nx >= gw || ny < 0 || ny >= gh) continue;
            const ni = ny * gw + nx;
            if (seen[ni] || !isInk(nx, ny)) continue;
            seen[ni] = 1; stack.push(ni);
          }
        }
      }
      totalInk += count;
      if (count > biggest) { biggest = count; biggestCell = i; }
    }
  }
  if (!totalInk) return 1;
  const share = biggest / totalInk;
  if (share <= 0.55) return share;

  // Measure the height of the biggest blob. A sheet of type with a drawn frame
  // reports one huge component that is a hairline every time; real artwork has
  // body. Walk the blob's cells once and take the tallest run of rows.
  const inBlob = new Uint8Array(gw * gh);
  stack.length = 0;
  stack.push(biggestCell);
  inBlob[biggestCell] = 1;
  let blobH = 0;
  let minY = gh, maxY = -1;
  while (stack.length) {
    const cur = stack.pop();
    const cx = cur % gw, cy = (cur - cx) / gw;
    if (cy < minY) minY = cy;
    if (cy > maxY) maxY = cy;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const nx = cx + dx, ny = cy + dy;
        if (nx < 0 || nx >= gw || ny < 0 || ny >= gh) continue;
        const ni = ny * gw + nx;
        if (inBlob[ni] || !isInk(nx, ny)) continue;
        inBlob[ni] = 1;
        stack.push(ni);
      }
    }
  }
  blobH = maxY - minY + 1;
  // Thick and dominant: a signature, a chart, a logo. Thin and dominant: a rule
  // or a frame around text, which must still be read.
  if (blobH * S < 10) return share * 0.4;

  // A *grid* is tall and can own most of a band's ink, yet it is furniture: the
  // table's own box drawing is one connected component covering two thirds of
  // the ink around perfectly ordinary type. A grid is recognisable by having
  // several rows that run the full width of the blob — a signature, a chart
  // line or a logo does not. Two such rows is a frame; treat it as text.
  // Wide rows alone do not make a frame: a solid banner is full of them. A frame
  // is a handful of *thin* wide rows with type between them, so require the wide
  // rows to be scattered rather than a filled block — the invoice's navy
  // letterhead band is one unbroken stretch of wide rows and is emphatically not
  // a table.
  let longRows = 0, runLong = 0, maxRunLong = 0;
  for (let y = minY; y <= maxY; y++) {
    let run = 0, best = 0;
    for (let x = 0; x < gw; x++) {
      if (inBlob[y * gw + x]) { if (++run > best) best = run; } else run = 0;
    }
    if (best >= Math.max(6, gw * 0.6)) {
      longRows++;
      if (++runLong > maxRunLong) maxRunLong = runLong;
    } else runLong = 0;
  }
  if (longRows >= 2 && maxRunLong <= Math.max(5, blobH * 0.25)) return share * 0.3;
  return share;
}

/**
 * Median height of a line of text on a page, from a row-ink profile.
 * Used only for ranking candidate bands, so an approximate value is fine.
 */
function estimateLineHeight(inkRow, samples) {
  const minInk = Math.max(2, samples * 0.004);
  const runs = [];
  let run = 0;
  for (let y = 0; y < inkRow.length; y++) {
    if (inkRow[y] >= minInk) run++;
    else if (run) { runs.push(run); run = 0; }
  }
  if (run) runs.push(run);
  const usable = runs.filter((r) => r >= 5 && r <= 120);
  return usable.length ? TC.medianOfNumbers(usable) : 14;
}

/**
 * Re-read the bands of a page whose text the whole-page pass did not cover.
 *
 * Whole-page OCR is fragile in exactly one specific way: Tesseract's layout
 * analyser sometimes decides that a block of lines belongs to a paragraph with
 * inconsistent metrics and silently omits it from the output tree. Which block
 * it drops changes with the page's scale — measured on the invoice sample, the
 * three-line billed-to address is read at 2.5× and lost at 2.0×, while a
 * different block is lost at 2.75×. No fixed scale is safe, and a union of
 * scales is only partly effective because neighbouring scales fail together.
 *
 * Detection does not have that problem: a band of rows carrying ink that no
 * recognised word covers is unambiguous evidence that something was missed.
 * So the page is scanned for such bands and each one is re-read as its own
 * crop, where a single band is trivially laid out correctly — no page-level
 * analysis to get wrong.
 *
 * Returns words in page coordinates.
 */
async function reReadUnderReadBands(pageData, rawWords, opts) {
  const { data, W, H, bg } = pageData;
  if (!rawWords) return [];
  // Only *substantive* words count as evidence that a row was read: at least
  // three characters and reasonable confidence. Tesseract's layout analyser
  // tends to replace a block it has given up on with a couple of one- or
  // two-character fragments ("ne", "ini", "i" on the invoice's billed-to
  // block), and counting those would declare the row read when nothing useful
  // was recognised there.
  // Three characters or more and decent confidence. Two is too strict: a real
  // line can be a single word and must still count as read.
  const substantive = (w) => w && w.text && w.text.replace(/[^A-Za-z0-9]/g, '').length >= 3 && (w.conf === undefined || w.conf >= 55);
  const count = new Uint8Array(H);
  for (const w of rawWords) {
    if (!w.bbox || !substantive(w)) continue;
    const y0 = TC.clamp(Math.floor(w.bbox.y0) - 1, 0, H - 1);
    const y1 = TC.clamp(Math.ceil(w.bbox.y1) + 1, y0 + 1, H);
    for (let y = y0; y < y1; y++) if (count[y] < 250) count[y]++;
  }
  const stepX = W > 1400 ? 2 : 1;
  const samples = Math.ceil(W / stepX);
  const inkRow = new Uint32Array(H);
  const gapInk = new Uint32Array(H);
  for (let y = 0; y < H; y++) {
    let c = 0, p = y * W * 4;
    for (let x = 0; x < W; x += stepX, p += 4 * stepX) {
      if (TC.colorDist2(data[p], data[p + 1], data[p + 2], bg.r, bg.g, bg.b) > 60 * 60) c++;
    }
    inkRow[y] = c;
    // Under-read when the row carries ink but no substantive word at all.
    gapInk[y] = count[y] === 0 ? c : 0;
  }
  const minInk = Math.max(3, Math.round(samples * 0.006));
  const lineHeight = estimateLineHeight(inkRow, samples);
  const bands = [];
  let cur = null;
  for (let y = 0; y < H; y++) {
    const wanted = gapInk[y] >= minInk;
    if (wanted) { if (!cur) cur = { y0: y, y1: y }; else cur.y1 = y; }
    else if (cur) { bands.push(cur); cur = null; }
  }
  if (cur) bands.push(cur);
  // Merge only across *small* gaps. When two under-read runs are separated by
  // rows that were read properly, they are different blocks and must not be
  // fused: merging the invoice's address block with the table below it made one
  // 500 px band whose ink mass outranked everything else and starved the
  // address out of the top-5, so the one block that needed re-reading was the
  // one never re-read.
  const merged = [];
  for (const b of bands) {
    const last = merged[merged.length - 1];
    if (last && b.y0 - last.y1 <= 4) last.y1 = b.y1;
    else merged.push({ ...b });
  }
  const targets = merged
    .map((b) => {
      let ink = 0;
      for (let y = b.y0; y <= b.y1; y++) ink += gapInk[y];
      return { y0: b.y0, y1: b.y1, ink, rows: b.y1 - b.y0 + 1 };
    })
    // Two or more rows of ink, not a rule or a stray speck.
    .filter((b) => b.rows >= 4 && b.rows <= H * 0.25 && b.ink >= samples * 0.12)
    // Rank by how MUCH of the band is unexplained, so a tall mostly-read band
    // cannot outrank a short completely-unread one.
    .sort((a, b) => (b.ink / b.rows) - (a.ink / a.rows) || b.ink - a.ink)
    .slice(0, 8);
  // A block that was read *partially* has some rows covered and some not, so the
  // under-read test alone gives only its missing line — and a one-line crop of a
  // three-line block cannot be read coherently. Add the whole straddled block:
  // every run of text rows (rows with any ink) that contains at least one
  // under-read row becomes a target in its own right. Reads are deduplicated
  // later by consolidateWords, so overlap is safe.
  const rowHasInk = new Uint8Array(H);
  for (let y = 0; y < H; y++) rowHasInk[y] = inkRow[y] >= minInk ? 1 : 0;
  const blocks = [];
  let blk = null;
  let blkGap = 0;
  for (let y = 0; y < H; y++) {
    if (rowHasInk[y]) {
      if (!blk) { blk = { y0: y, y1: y, gap: false }; blocks.push(blk); }
      else { blk.y1 = y; }
      blkGap = 0;
    } else if (blk) {
      blkGap++;
      // A block ends after ~1.5 line heights of clear space.
      if (blkGap > 26) { blk = null; blkGap = 0; }
    }
    // Record whether this row is under-read and inside a block.
    if (blk && gapInk[y] >= minInk) blk.gap = true;
  }
  for (const b of blocks) {
    if (!b.gap) continue;
    const rows = b.y1 - b.y0 + 1;
    if (rows < 8 || rows > H * 0.3) continue;
    let ink = 0;
    for (let y = b.y0; y <= b.y1; y++) ink += gapInk[y];
    if (ink < samples * 0.12) continue;
    targets.push({ y0: b.y0, y1: b.y1, ink, rows });
  }
  // Keep the list to the bands that matter. Fourteen crops on one page is a lot
  // of recognitions for little gain. Rank by *total unexplained ink* — the
  // amount of text-shaped evidence a band holds — rather than by density: a
  // three-line address block is dense but small, and ranking by density dropped
  // it while keeping slivers of artwork edge.
  // Rank by unexplained ink, but never let one giant block crowd out the rest:
  // `[0,183]` is the whole letterhead and carries the most raw ink of anything
  // on the invoice, while the three-line address block is a third of its size
  // and is the one block that must not be dropped. Cap each band's contribution
  // at a few lines' worth.
  // A block target and the individual under-read rows inside it are the same
  // work: reading the block covers them. Drop any target that sits inside
  // another, biggest first.
  targets.sort((a, b) => (b.y1 - b.y0) - (a.y1 - a.y0) || b.ink - a.ink);
  const deduped = [];
  for (const t of targets) {
    const inside = deduped.some((d) => t.y0 >= d.y0 - 2 && t.y1 <= d.y1 + 2);
    if (!inside) deduped.push(t);
  }
  // Rank by unexplained ink (the amount of unread text evidence), keeping the
  // list short enough that the extra recognitions stay affordable. The band with
  // the largest area always goes first: on an invoice that is the letterhead or
  // the address block, the one thing a page must never lose, and it can lose a
  // pure ink ranking to a band of dense small type.
  deduped.sort((a, b) => b.ink - a.ink);
  const biggest = deduped.reduce((best, t) => ((t.y1 - t.y0) > (best.y1 - best.y0) ? t : best), deduped[0]);
  const capped = [biggest].concat(deduped.filter((t) => t !== biggest).slice(0, 5))
    .sort((a, b) => a.y0 - b.y0);
  TC.state.__targets = capped.map((t) => [t.y0, t.y1]);

  if (!targets.length) return [];

  /* ---- find the column gutter inside a band -------------------------------
   * This is the whole point. On a page laid out in columns — a letterhead with
   * a sender block left and a billed-to block right, an invoice table, a
   * two-column article — PSM 3 runs its layout analysis over the full width and
   * interleaves the columns into nonsense ("Se Foal a bid 55 qd" is what the
   * invoice's own header turns into). Cropping each column separately makes each
   * one a single column of text and it reads perfectly.
   *
   * The gutter is the widest run of empty columns in the band's vertical middle
   * third, in the middle half of the page width.
   */
  const inkCol = new Uint32Array(W);
  const gutterFor = (y0, y1) => {
    inkCol.fill(0);
    for (let y = y0; y < y1; y++) {
      let p = y * W * 4;
      for (let x = 0; x < W; x++, p += 4) {
        if (TC.colorDist2(data[p], data[p + 1], data[p + 2], bg.r, bg.g, bg.b) > 60 * 60) inkCol[x]++;
      }
    }
    const from = Math.round(W * 0.28), to = Math.round(W * 0.72);
    let best = null, run = null;
    for (let x = from; x < to; x++) {
      if (inkCol[x] === 0) { if (!run) run = { a: x, b: x }; else run.b = x; }
      else if (run) { if (!best || (run.b - run.a) > (best.b - best.a)) best = run; run = null; }
    }
    if (run && (!best || (run.b - run.a) > (best.b - best.a))) best = run;
    // A real gutter is wide relative to the type, and both sides must carry ink.
    if (!best || best.b - best.a < W * 0.03) return null;
    let leftInk = 0, rightInk = 0;
    for (let x = 0; x < best.a; x++) leftInk += inkCol[x];
    for (let x = best.b + 1; x < W; x++) rightInk += inkCol[x];
    if (leftInk < (y1 - y0) * 0.5 || rightInk < (y1 - y0) * 0.5) return null;
    return Math.round((best.a + best.b) / 2);
  };

  const found = [];
  // Recognition cost is proportional to the crop's pixel count, and a page-wide
  // band at 2.8× is over three megapixels of mostly white paper. Upscale enough
  // for the ascenders to be crisp — Tesseract's sweet spot is ~30 px caps and
  // body type here is ~10 px — but hold each crop to a fixed pixel budget.
  const scaleFor = (w, h) => TC.clamp(Math.sqrt(1500000 / Math.max(1, w * h)), 2.2, 3.2);
  // Each crop is an independent recognition, so build the canvases up front and
  // hand one to each pool worker. On a page with six bands that is the
  // difference between six serial recognition round-trips and two.
  const readCrop = async (worker, x0, y0, x1, y1) => {
    const scale = scaleFor(x1 - x0, y1 - y0);
    const cw = Math.round((x1 - x0) * scale), ch = Math.round((y1 - y0) * scale);
    if (cw < 24 || ch < 12) return;
    const c = TC.makeCanvas(cw, ch);
    const x = TC.ctxOf(c);
    x.imageSmoothingEnabled = true;
    x.imageSmoothingQuality = 'high';
    x.fillStyle = '#ffffff';
    x.fillRect(0, 0, cw, ch);
    x.drawImage(pageData.srcCanvas, x0, y0, x1 - x0, y1 - y0, 0, 0, cw, ch);
    let res;
    try {
      res = await workerRecognize(c, { user_defined_dpi: String(Math.round(96 * scale)) }, worker);
    } catch (e) {
      console.warn('band re-read failed', e);
      return;
    }
    for (const block of res.blocks || []) {
      for (const par of block.paragraphs || []) {
        for (const line of par.lines || []) {
          const lb = line.bbox, base = line.baseline, ra = line.rowAttributes;
          for (const word of line.words || []) {
            if (!word.text || !word.text.trim() || word.confidence < 40) continue;
            const wb = word.bbox;
            found.push({
              text: word.text,
              conf: word.confidence,
              fontName: word.font_name || '',
              bbox: {
                x0: wb.x0 / scale + x0, y0: wb.y0 / scale + y0,
                x1: wb.x1 / scale + x0, y1: wb.y1 / scale + y0,
              },
              lineBbox: lb ? {
                x0: lb.x0 / scale + x0, y0: lb.y0 / scale + y0,
                x1: lb.x1 / scale + x0, y1: lb.y1 / scale + y0,
              } : null,
              baseline: base && base.has_baseline !== false ? {
                x0: base.x0 / scale + x0, y0: base.y0 / scale + y0,
                x1: base.x1 / scale + x0, y1: base.y1 / scale + y0, has_baseline: true,
              } : null,
              rowAttributes: ra,
              symbols: word.symbols || [],
            });
          }
        }
      }
    }
  };

  /* A band of handwriting or a drawn shape is not type.
   *
   * Type is many small disconnected things; a signature squiggle, a chart line,
   * a logo stroke is one big connected thing. Measuring the largest connected
   * component's share of the band's ink separates them cleanly — on the invoice
   * the signature is almost all one component while every real line of text is
   * under 15 % — and stops the re-read from inventing words like "in" and "oof"
   * out of a drawn curve. */
  // Pad each band so its crop includes the neighbouring lines a paragraph needs.
  // Measured from the invoice, the billed-to block sits between a 40 px band
  // above and a 60 px gap, and a 2×row pad straddles both lines correctly without
  // swallowing the table header below.
  const windows = [];
  for (const t of capped) {
    // Ignore slivers: a band a few rows tall is a rule, a border or a speck, and
    // recognising it costs a full worker round-trip for nothing.
    if (t.rows < 8) continue;
    // A drawn shape is not a line of type.
    try {
      const yA = TC.clamp(t.y0, 0, H - 2), yB = TC.clamp(t.y1 + 1, yA + 2, H);
      if (largestComponentShare(yA, yB, data, W, bg) > 0.55) continue;
    } catch (_) { /* optimisation only — never let it break the pass */ }
    // The pad exists to give a *one-line* band the neighbouring lines a
    // paragraph needs. Scaling it with the band's height is wrong: a 184-row
    // band (a whole letterhead) would get a 374-row pad, weld itself to every
    // block below it, and the resulting page-wide crop has to be recognised at
    // a fraction of the resolution that makes 10 px type legible.
    // Half a line of clearance on each side, so the crop holds the band plus the
    // neighbours that make it read as a paragraph — and never more, because a
    // crop that reaches into the next block re-reads it as noise.
    const padY = TC.clamp(Math.round(lineHeight * 0.5) + 6, 8, 34);
    // Keep the band's own rows alongside the padded window: the column gutter
    // must be found over the band itself. Searching it over the padding would
    // let a neighbouring full-width line fill the gutter and stop the split,
    // and an unsplit letterhead reads as interleaved nonsense.
    // At the very top of a page, take the margin as well: a letterhead's first
    // line sits above its band's sentinel row, and a crop that begins on the
    // glyphs themselves robs Tesseract of the white space it needs to segment.
    const top = t.y0 - padY <= 0 ? 0 : t.y0 - padY;
    windows.push([TC.clamp(top, 0, H - 1), TC.clamp(t.y1 + padY, 0, H), t.y0, t.y1]);
  }
  // Genuinely overlapping windows are the same crop, so merge them. Windows that
  // merely *touch* through their padding must not be: welding the letterhead to
  // the address block below it makes one 300-row crop that has to be recognised
  // at 1.9× to stay inside the pixel budget, and at that size a 10 px body line
  // loses its first letter ("Kingsway" came back as "Ingsway").
  windows.sort((a, b) => a[0] - b[0]);
  const mergedWindows = [];
  for (const w of windows) {
    const last = mergedWindows[mergedWindows.length - 1];
    if (last && w[0] <= last[1] - 4) {
      last[1] = Math.max(last[1], w[1]);
      last[2] = Math.min(last[2], w[2]);
      last[3] = Math.max(last[3], w[3]);
    } else mergedWindows.push([...w]);
  }

  const crops = [];
  for (const [wy0, wy1, cy0, cy1] of mergedWindows) {
    if (wy1 - wy0 < 8) continue;
    (pageData.readBands || (pageData.readBands = [])).push([wy0, wy1]);
    const gutter = gutterFor(cy0, cy1);
    if (gutter) {
      // Read each column on its own; the combined band is never read because
      // that is exactly the case that produces interleaved garbage.
      crops.push([0, wy0, gutter, wy1], [gutter, wy0, W, wy1]);
    } else {
      // A band that does not span the page — an address block on the left, a
      // footer on the right — is mostly blank paper at page width, and blank
      // paper costs the same as ink. Crop to the ink instead.
      const ext = inkExtent(wy0, wy1, data, W, bg, stepX);
      const padX = Math.max(8, Math.round((wy1 - wy0) * 0.6));
      crops.push([
        TC.clamp(ext.x0 - padX, 0, W - 16),
        wy0,
        TC.clamp(ext.x1 + padX, 16, W),
        wy1,
      ]);
    }
  }
  if (!crops.length) return found;
  await TC.withWorkers(TC.poolSize(), crops.map((c) => (worker) => readCrop(worker, ...c)));
  return found;
}

/**
 * Read text that lives inside artwork — a rotated stamp, a badge, a label on a
 * logo. The whole-page pass reports these as one slanted line whose axis-aligned
 * box does not cover the ink, so the words are thrown away and the artwork gets
 * traced as shapes. Re-running OCR on the de-rotated crop recovers them as real
 * words so they can be TYPED, which is the point of the reconstruction.
 *
 * Returns words in page coordinates, with a rotation attached so the assembler
 * can draw them at the original angle.
 */
async function ocrRotatedCrop(canvas, angleDeg, scale) {
  if (!canvas || canvas.width < 8 || canvas.height < 8) return [];
  const rad = (-angleDeg * Math.PI) / 180;
  const cos = Math.abs(Math.cos(rad)), sin = Math.abs(Math.sin(rad));
  const outW = Math.ceil((canvas.width * cos + canvas.height * sin) * scale);
  const outH = Math.ceil((canvas.width * sin + canvas.height * cos) * scale);

  // Draw the crop de-rotated, opaque on white, so the ink lies horizontally.
  const base = TC.makeCanvas(outW, outH);
  const bx = TC.ctxOf(base);
  bx.fillStyle = '#ffffff';
  bx.fillRect(0, 0, outW, outH);
  bx.imageSmoothingEnabled = true;
  bx.imageSmoothingQuality = 'high';
  bx.translate(outW / 2, outH / 2);
  bx.rotate(rad);
  bx.scale(scale, scale);
  bx.drawImage(canvas, -canvas.width / 2, -canvas.height / 2);

  /* Stamps are often pale ink on paper. Tesseract's binariser prefers strong
   * contrast, so try a sweep of fixed thresholds and keep the most confident
   * reading — that beats a single global guess on faint artwork. */
  const lumData = bx.getImageData(0, 0, outW, outH);
  const lum = lumData.data;
  for (let i = 0; i < lum.length; i += 4) {
    const v = 0.299 * lum[i] + 0.587 * lum[i + 1] + 0.114 * lum[i + 2];
    lum[i] = lum[i + 1] = lum[i + 2] = v;
    lum[i + 3] = 255;
  }

  const psm = canvas.height * scale >= 48 ? '4' : '6';
  const variants = [];
  for (const thr of [255, 165, 180, 195]) {
    if (thr === 255) { variants.push(lumData); continue; }
    const copy = new ImageData(new Uint8ClampedArray(lum), outW, outH);
    const cd = copy.data;
    for (let i = 0; i < cd.length; i += 4) {
      const v = cd[i] < thr ? 0 : 255;
      cd[i] = cd[i + 1] = cd[i + 2] = v;
    }
    variants.push(copy);
  }

  /* Cheap path first: read the plain de-rotated crop. Most artwork is either
   * clearly legible or clearly not text, and this keeps the common case at a
   * single OCR pass. Only escalate to binarised variants when nothing was read. */
  let bestWords = [];
  let bestScore = -1;
  let bestCanvas = null;
  for (let vi = 0; vi < variants.length; vi++) {
    const variant = variants[vi];
    const c = TC.makeCanvas(outW, outH);
    TC.ctxOf(c).putImageData(variant, 0, 0);
    let data;
    try {
      data = await workerRecognize(c, { tessedit_pageseg_mode: psm });
    } catch (e) { continue; }
    const found = collectRecognisedWords(data, outW, outH, scale, rad, canvas);
    if (!found.length) continue;                       // keep going to next threshold
    const conf = found.reduce((a, w) => a + w.conf, 0) / found.length;
    const score = conf + found.reduce((a, w) => a + w.text.length, 0) * 4;
    if (score > bestScore) { bestScore = score; bestWords = found; bestCanvas = c; }
    // A confident read on the first variant needs no further work.
    if (vi === 0 && conf >= 80 && found.length >= 1) break;
  }
  void bestCanvas;
  return bestWords;
}

/** Pull words out of a Tesseract result and map them back into crop pixels. */
function collectRecognisedWords(data, outW, outH, scale, rad, canvas) {
  const blocks = (data && data.blocks) || [];
  const found = [];
  for (const block of blocks) {
    for (const par of block.paragraphs || []) {
      for (const line of par.lines || []) {
        for (const word of line.words || []) {
          const t = (word.text || '').trim();
          if (!t || (word.confidence || 0) < 45) continue;
          if (!/[A-Za-z0-9]{1,}/.test(t)) continue;
          const cx = (word.bbox.x0 + word.bbox.x1) / 2 / scale - outW / 2 / scale;
          const cy = (word.bbox.y0 + word.bbox.y1) / 2 / scale - outH / 2 / scale;
          const a = -rad;
          const rx = cx * Math.cos(a) - cy * Math.sin(a);
          const ry = cx * Math.sin(a) + cy * Math.cos(a);
          found.push({
            text: t,
            conf: word.confidence || 0,
            cx: rx + canvas.width / 2,
            cy: ry + canvas.height / 2,
            w: (word.bbox.x1 - word.bbox.x0) / scale,
            h: (word.bbox.y1 - word.bbox.y0) / scale,
            baseline: line.baseline || null,
          });
        }
      }
    }
  }
  return found;
}

/**
 * Second-chance OCR: Tesseract's page segmentation sometimes skips isolated
 * blocks (e.g. a footer separated from the body by a large blank gap). Detect
 * horizontal bands that contain real ink but no recognised word, re-OCR just
 * those bands at 2× and append whatever it finds.
 */
async function fillOcrGaps(pageData, rawWords, opts) {
  const { data, W, H, bg } = pageData;
  if (!rawWords) return [];
  // rawWords are already in page coordinates (mapOcrWordToPageWithScale).
  const covered = new Uint8Array(H);
  for (const w of rawWords) {
    if (!w.bbox) continue;
    const y0 = TC.clamp(Math.floor(w.bbox.y0) - 3, 0, H - 1);
    const y1 = TC.clamp(Math.ceil(w.bbox.y1) + 3, y0 + 1, H);
    for (let y = y0; y < y1; y++) covered[y] = 1;
  }
  // ink per row
  const inkRow = new Uint32Array(H);
  const stepX = W > 1400 ? 2 : 1;
  for (let y = 0; y < H; y++) {
    let c = 0, p = (y * W) * 4;
    for (let x = 0; x < W; x += stepX, p += 4 * stepX) {
      if (TC.colorDist2(data[p], data[p + 1], data[p + 2], bg.r, bg.g, bg.b) > 60 * 60) c++;
    }
    inkRow[y] = c;
  }
  const samples = Math.ceil(W / stepX);
  const minInk = Math.max(3, Math.round(samples * 0.004));
  // candidate bands: ink rows that no word covers
  const bands = [];
  let cur = null;
  for (let y = 0; y < H; y++) {
    const wanted = inkRow[y] >= minInk && !covered[y];
    if (wanted) { if (!cur) cur = { y0: y, y1: y }; else cur.y1 = y; }
    else if (cur) { bands.push(cur); cur = null; }
  }
  if (cur) bands.push(cur);
  // merge close bands, pad, drop slivers and absurd full-page bands
  const merged = [];
  for (const b of bands) {
    const last = merged[merged.length - 1];
    if (last && b.y0 - last.y1 <= 22) last.y1 = b.y1;
    else merged.push({ ...b });
  }
  // Score bands by ink mass and pick the heaviest few, so a footer far down the
  // page is not starved by a handful of rules near the top.
  const usable = merged
    .map((b) => {
      let ink = 0;
      for (let y = b.y0; y <= b.y1; y++) ink += inkRow[y];
      return { y0: TC.clamp(b.y0 - 7, 0, H - 1), y1: TC.clamp(b.y1 + 7, 0, H), ink, rows: b.y1 - b.y0 + 1 };
    })
    .filter((b) => b.y1 - b.y0 >= 9 && b.y1 - b.y0 <= H * 0.6 && b.ink >= samples * 0.35 && b.rows >= 6)
    .sort((a, b) => b.ink - a.ink)
    .slice(0, 6);
  if (!usable.length) return [];

  const found = [];
  for (const b of usable) {
    const bh = b.y1 - b.y0;
    // Already read by the band pass? Skip it — the overlap was two extra
    // recognitions per page for no new text.
    const seen = (pageData.readBands || []).some((r) => b.y0 >= r[0] && b.y1 <= r[1]);
    if (seen) continue;
    // A drawn shape (a signature, a chart line) is not a line of type: its ink
    // is one big connected component instead of many small glyphs. Reading it
    // produces confident nonsense, so skip it entirely.
    try {
      if (largestComponentShare(b.y0, b.y1, data, W, bg) > 0.55) continue;
    } catch (_) { /* optimisation only */ }
    const scale = TC.clamp(2.4, 1.6, 3);
    const c = TC.makeCanvas(Math.round(W * scale), Math.round(bh * scale));
    const x = TC.ctxOf(c);
    x.imageSmoothingEnabled = true;
    x.imageSmoothingQuality = 'high';
    x.fillStyle = '#ffffff';
    x.fillRect(0, 0, c.width, c.height);
    x.drawImage(pageData.canvasSrc || pageData.srcCanvas, 0, b.y0, W, bh, 0, 0, c.width, c.height);
    let res;
    try {
      res = await workerRecognize(c);
    } catch (e) {
      console.warn('gap OCR failed', e);
      break;
    }
    for (const block of res.blocks || []) {
      for (const par of block.paragraphs || []) {
        for (const line of par.lines || []) {
          const lb = line.bbox, base = line.baseline, ra = line.rowAttributes;
          for (const word of line.words || []) {
            if (!word.text || !word.text.trim() || word.confidence < 30) continue;
            const wb = word.bbox;
            found.push({
              text: word.text,
              conf: word.confidence,
              fontName: word.font_name || '',
              bbox: {
                x0: wb.x0 / scale, y0: wb.y0 / scale + b.y0,
                x1: wb.x1 / scale, y1: wb.y1 / scale + b.y0,
              },
              lineBbox: lb ? {
                x0: lb.x0 / scale, y0: lb.y0 / scale + b.y0,
                x1: lb.x1 / scale, y1: lb.y1 / scale + b.y0,
              } : null,
              baseline: base && base.has_baseline !== false ? {
                x0: base.x0 / scale, y0: base.y0 / scale + b.y0,
                x1: base.x1 / scale, y1: base.y1 / scale + b.y0, has_baseline: true,
              } : null,
              rowAttributes: ra,
              // Symbol boxes come back in crop pixels and must be mapped to
              // page pixels like the word box above, or the character-level
              // pass would look at the wrong ink entirely.
              symbols: (word.symbols || []).map((sy) => ({
                ...sy,
                bbox: sy.bbox ? {
                  x0: sy.bbox.x0 / scale, y0: sy.bbox.y0 / scale + b.y0,
                  x1: sy.bbox.x1 / scale, y1: sy.bbox.y1 / scale + b.y0,
                } : sy.bbox,
              })),
            });
          }
        }
      }
    }
  }
  return found;
}

/**
 * Third-chance OCR: small labels inside pale callouts ("Sun", "Songbird",
 * "NAME") are often skipped by whole-page layout analysis. Crop each detected
 * colour region, upscale it and read it with single-block segmentation.
 */
async function ocrInsideRegions(pageData, boxes, rawWords, opts) {
  if (!boxes || !boxes.length) return [];
  const { W, H, srcCanvas } = pageData;
  const found = [];
  const existing = rawWords || [];
  const overlapsExisting = (b) => existing.some((w) => {
    if (!w.bbox) return false;
    const ix = Math.min(b.x1, w.bbox.x1) - Math.max(b.x0, w.bbox.x0);
    const iy = Math.min(b.y1, w.bbox.y1) - Math.max(b.y0, w.bbox.y0);
    if (ix <= 0 || iy <= 0) return false;
    return (ix * iy) / Math.max(1, (b.x1 - b.x0) * (b.y1 - b.y0)) > 0.45;
  });
  // Only regions big enough to hold a label and whose interior is NOT already
  // recognised text. Table cells are covered by the whole-page pass; re-reading
  // them produced stray fragments.
  const targets = boxes
    .filter((b) => {
      if (b.w < 40 || b.h < 20 || b.w * b.h > W * H * 0.5) return false;
      if (b.h < 26) return false;                       // thin strips are rules/cells
      // A band wider than ~half the page with a large area is a banner / table
      // header: the whole-page pass reads those correctly and a crop re-read only
      // adds column-boundary noise.
      if (b.w > W * 0.45 && b.w * b.h > W * H * 0.02) return false;
      const inside = existing.filter((w) => {
        if (!w.bbox) return false;
        const cx = (w.bbox.x0 + w.bbox.x1) / 2, cy = (w.bbox.y0 + w.bbox.y1) / 2;
        return cx >= b.x && cx <= b.x + b.w && cy >= b.y && cy <= b.y + b.h;
      });
      // Regions holding several labels (diagram callouts) are re-read; a region
      // with a single already-recognised word is left to the whole-page pass.
      const bigEnoughForMore = b.w * b.h >= 6000 && b.h >= 44;
      return inside.length === 0 || bigEnoughForMore;
    })
    .sort((a, b) => b.w * b.h - a.w * a.h)
    .slice(0, 24);
  for (const box of targets) {
    // Pad generously (a glyph can stick out of a tight fill) but keep the crop
    // inside the page and away from neighbouring text.
    const pad = 12;
    const x0 = TC.clamp(Math.floor(box.x - pad), 0, W - 1);
    const y0 = TC.clamp(Math.floor(box.y - pad), 0, H - 1);
    const w = TC.clamp(Math.ceil(box.w + pad * 2), 8, W - x0);
    const h = TC.clamp(Math.ceil(box.h + pad * 2), 8, H - y0);
    const scale = TC.clamp(2000 / Math.max(1, w), 2, 5);
    const c = TC.makeCanvas(Math.round(w * scale), Math.round(h * scale));
    const cctx = TC.ctxOf(c);
    cctx.imageSmoothingEnabled = true;
    cctx.imageSmoothingQuality = 'high';
    cctx.fillStyle = '#ffffff';
    cctx.fillRect(0, 0, c.width, c.height);
    cctx.drawImage(srcCanvas, x0, y0, w, h, 0, 0, c.width, c.height);
    let res;
    try {
      res = await workerRecognize(c, { tessedit_pageseg_mode: box.h >= 48 ? '4' : '6' });
    } catch (e) {
      console.warn('region OCR failed', e);
      break;
    }
    for (const block of res.blocks || []) {
      for (const par of block.paragraphs || []) {
        for (const line of par.lines || []) {
          for (const word of line.words || []) {
            if (!word.text || !word.text.trim() || word.confidence < 40) continue;
            // Punctuation-only or 1-char fragments from a padded crop are noise.
            const letters = (word.text.match(/[A-Za-z0-9]/g) || []).length;
            if (letters === 0) continue;
            if (letters <= 1) continue;
            // A glyph shorter than ~6 px in the source is not real text.
            if (word.bbox.y1 - word.bbox.y0 < 6 * scale) continue;
            const wb = word.bbox;
            const b = {
              x0: wb.x0 / scale + x0, y0: wb.y0 / scale + y0,
              x1: wb.x1 / scale + x0, y1: wb.y1 / scale + y0,
            };
            // must sit inside the region (small tolerance for padded glyph edges)
            const cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2;
            if (cx < box.x - 14 || cx > box.x + box.w + 14 || cy < box.y - 8 || cy > box.y + box.h + 8) continue;
            if (overlapsExisting(b)) continue;
            found.push({
              text: word.text,
              conf: word.confidence,
              fontName: word.font_name || '',
              bbox: b,
              lineBbox: line.bbox ? {
                x0: line.bbox.x0 / scale + x0, y0: line.bbox.y0 / scale + y0,
                x1: line.bbox.x1 / scale + x0, y1: line.bbox.y1 / scale + y0,
              } : null,
              baseline: line.baseline && line.baseline.has_baseline !== false ? {
                x0: line.baseline.x0 / scale + x0, y0: line.baseline.y0 / scale + y0,
                x1: line.baseline.x1 / scale + x0, y1: line.baseline.y1 / scale + y0,
                has_baseline: true,
              } : null,
              rowAttributes: line.rowAttributes,
              symbols: word.symbols || [],
            });
          }
        }
      }
    }
  }
  return found;
}

/** Map a raw OCR word (composite coords) onto its page (page coords). */
function mapOcrWordToPageWithScale(w, ocrScale, composite, pages) {
  const bb = w.bbox;
  if (!bb) return null;
  const compCenterY = ((bb.y0 + bb.y1) / 2) / ocrScale;
  let idx = 0;
  for (let k = 0; k < composite.offsets.length; k++) if (compCenterY >= composite.offsets[k] - 3) idx = k;
  const page = pages[idx];
  if (!page) return null;
  const off = composite.offsets[idx];
  const offX = Math.round((composite.canvas.width - page.canvas.width) / 2);
  const mapX = (v) => v / ocrScale - offX;
  const mapY = (v) => v / ocrScale - off;
  const line = w.lineBbox;
  const base = w.baseline;
  return {
    pageIndex: idx,
    word: {
      text: w.text,
      conf: w.conf,
      fontName: w.fontName,
      bbox: { x0: mapX(bb.x0), y0: mapY(bb.y0), x1: mapX(bb.x1), y1: mapY(bb.y1) },
      lineBbox: line ? { x0: mapX(line.x0), y0: mapY(line.y0), x1: mapX(line.x1), y1: mapY(line.y1) } : null,
      baseline: base && base.has_baseline !== false
        ? { x0: mapX(base.x0), y0: mapY(base.y0), x1: mapX(base.x1), y1: mapY(base.y1), has_baseline: true }
        : null,
      rowAttributes: w.rowAttributes,
    },
  };
}

  // --- exported onto TC ---
  TC.collectRecognisedWords = collectRecognisedWords;
  TC.fillOcrGaps = fillOcrGaps;
  TC.mapOcrWordToPageWithScale = mapOcrWordToPageWithScale;
  TC.ocrInsideRegions = ocrInsideRegions;
  TC.ocrRotatedCrop = ocrRotatedCrop;
  TC.readOptions = readOptions;
  TC.runPipeline = runPipeline;
  TC.setBusy = setBusy;
  TC.workerRecognize = workerRecognize;
});
