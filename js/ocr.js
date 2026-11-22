/* ============================================================================
   OCR engine
   Tesseract.js worker lifecycle and recognition passes.
   ========================================================================== */

TC.register(function (TC) {
  'use strict';

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

/** Build the enhanced OCR raster (upscale + gentle contrast), returns {canvas, scale}. */
function buildOcrCanvas(composite, contrastBoost, scaleWanted, regions) {
  const W = composite.width, H = composite.height;
  const scale = TC.clamp(scaleWanted || 1, 1, 2.5);
  const targetW = Math.max(1, Math.round(W * scale));
  const targetH = Math.max(1, Math.round(H * scale));
  const c = TC.makeCanvas(targetW, targetH);
  const x = TC.ctxOf(c);
  // High-quality resample first
  x.imageSmoothingEnabled = true;
  x.imageSmoothingQuality = 'high';
  x.drawImage(composite, 0, 0, targetW, targetH);
  if (contrastBoost > 0.001) {
    const img = x.getImageData(0, 0, targetW, targetH);
    const d = img.data;
    // S-curve in luminance space, preserving hue: darken ink, lift paper.
    const k = contrastBoost * 0.5;
    const lut = new Uint8ClampedArray(256);
    for (let v = 0; v < 256; v++) {
      const t = v / 255;
      const eased = 0.5 + (t - 0.5) * (1 + k); // linear contrast stretch around mid-grey
      lut[v] = TC.clamp(eased * 255, 0, 255);
    }
    for (let i = 0; i < d.length; i += 4) {
      d[i] = lut[d[i]]; d[i + 1] = lut[d[i + 1]]; d[i + 2] = lut[d[i + 2]];
    }
    x.putImageData(img, 0, 0);
  }
  return { canvas: c, scale: targetW / W };
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

async function runOcr(ocrCanvas, onProgress) {
  const worker = await ensureTesseract();
  await worker.setParameters({
    tessedit_pageseg_mode: '3',
    preserve_interword_spaces: '1',
    user_defined_dpi: '300',
  });
  const res = await worker.recognize(ocrCanvas, {}, { text: false, blocks: true });
  const blocks = (res && res.data && res.data.blocks) || [];
  const raw = [];
  for (const block of blocks) {
    for (const par of block.paragraphs || []) {
      for (const line of par.lines || []) {
        const bl = line.baseline || null;
        const ra = line.rowAttributes || null;
        for (const word of line.words || []) {
          raw.push({
            text: word.text,
            conf: word.confidence,
            bbox: word.bbox,
            lineBbox: line.bbox,
            baseline: bl,
            rowAttributes: ra,
            symbols: word.symbols || [],
            fontName: word.font_name || '',
          });
        }
      }
    }
  }
  onProgress && onProgress(raw.length, res.data);
  return raw;
}

  // --- exported onto TC ---
  TC.buildComposite = buildComposite;
  TC.buildOcrCanvas = buildOcrCanvas;
  TC.ensureTesseract = ensureTesseract;
  TC.runOcr = runOcr;
});
