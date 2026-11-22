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
    const maxPageW = Math.max(...TC.state.pages.map((p) => p.canvas.width));
    const ocrScale = TC.state.pages.length === 1 ? TC.clamp(2200 / maxPageW, 1, 2.4) : TC.clamp(1500 / maxPageW, 1, 1.8);
    const ocrInput = TC.buildOcrCanvas(composite.canvas, opts.contrast, ocrScale, perPageStructural.flatMap((p) => p.boxes));
    await TC.ensureTesseract((msg) => TC.progress.set(20, msg));
    TC.progress.indeterminate(true);
    TC.progress.set(24, 'Layer 3 · Recognising text (largest step)…', 'Layer 3 · OCR');
    const ocrRes = await workerRecognize(ocrInput.canvas);
    TC.progress.indeterminate(false);
    if (!alive()) return;
    TC.progress.chip('ocr', 'done');

    const rawWords = [];
    for (const block of (ocrRes.blocks || [])) {
      for (const par of block.paragraphs || []) {
        for (const line of par.lines || []) {
          for (const word of line.words || []) {
            rawWords.push({
              text: word.text, conf: word.confidence, bbox: word.bbox,
              lineBbox: line.bbox, baseline: line.baseline, rowAttributes: line.rowAttributes,
              fontName: word.font_name || '',
            });
          }
        }
      }
    }
    TC.progress.set(58, `Layer 3 · ${rawWords.length} words found — sampling colour & weight`);
    await TC.nextFrame();

    const perPageRaw = TC.state.pages.map(() => []);
    for (const w of rawWords) {
      const mapped = mapOcrWordToPageWithScale(w, ocrScale, composite, TC.state.pages);
      if (mapped) perPageRaw[mapped.pageIndex].push(mapped.word);
    }

    /* -------- gap fill: catch blocks the page segmenter skipped -------- */
    TC.progress.set(58, 'Checking for missed text…', 'Layer 3 · OCR');
    await TC.nextFrame();
    for (let pi = 0; pi < TC.state.pages.length; pi++) {
      if (!alive()) return;
      try {
        const extra = await fillOcrGaps(pageData[pi], perPageRaw[pi], opts);
        if (extra.length) {
          const existing = new Set(perPageRaw[pi].map((w) => w.text.toLowerCase()));
          for (const w of extra) {
            if (!w.bbox) continue;
            if (w.bbox.y0 < -2 || w.bbox.y1 > pageData[pi].H + 2) continue;
            perPageRaw[pi].push(w);
          }
          console.info(`gap OCR page ${pi + 1}: +${extra.length} words`);
        }
      } catch (err) {
        console.warn('gap fill failed', err);
      }
    }

    /* -------- region fill: labels inside pale callouts are often skipped -------- */
    TC.progress.set(59, 'Reading labels inside callouts…', 'Layer 3 · OCR');
    await TC.nextFrame();
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
      perPageRaw[pi] = TC.consolidateWords(perPageRaw[pi]);
      const styled = TC.buildStyledWords(perPageRaw[pi], d.data, d.W, d.H, d.bg, { ...opts, boxes });
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
async function workerRecognize(ocrCanvas, overrides) {
  const worker = TC.state.tesseract;
  if (!worker) throw new Error('OCR worker is not initialised.');
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
              symbols: word.symbols || [],
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
