/* ============================================================================
   File loading
   Accepts images and PDFs, renders PDF pages, normalises page canvases.
   ========================================================================== */

TC.register(function (TC) {
  'use strict';

const MAX_PDF_PAGES = 12;
const MAX_WORK_SIDE = 1700;   // working canvas long side (px)
const MIN_OCR_SIDE = 1150;    // upscale for OCR if below this

function resetResults() {
  if (TC.state.pdfUrl) { URL.revokeObjectURL(TC.state.pdfUrl); TC.state.pdfUrl = null; }
  TC.state.pdfBytes = null;
  TC.state.pdfDoc = null;
  TC.state.layers = null;
  TC.state.analysis = null;
  TC.state.pages.forEach((p) => { p.layers = null; p.analysis = null; });
  TC.$('downloadBtn').disabled = true;
  TC.$('newTabBtn').disabled = true;
  TC.$('pdfMeta').textContent = 'No PDF built yet';
  TC.$('pdfSize').textContent = '—';
  TC.$('pdfCanvas').hidden = true;
  TC.$('pdfEmpty').hidden = false;
  ['outWords', 'outBoxes', 'outLines', 'outGfx', 'outTime'].forEach((id) => { TC.$(id).textContent = '—'; });
}

function setSourceUI(file, firstPage) {
  TC.state.file = file;
  TC.$('fileCard').hidden = false;
  TC.$('fileName').textContent = file.name;
  TC.$('sourceBadge').textContent = file.kind === 'pdf' ? `${TC.state.pages.length} page${TC.state.pages.length > 1 ? 's' : ''}` : 'image';
  TC.$('fileDims').textContent = `${TC.fmtInt(firstPage.canvas.width)} × ${TC.fmtInt(firstPage.canvas.height)} px${file.kind === 'pdf' ? ' · rendered from PDF' : ''}`;
  try {
    const c = TC.makeCanvas(104, 104);
    const x = TC.ctxOf(c);
    const src = firstPage.canvas;
    const s = Math.max(104 / src.width, 104 / src.height);
    x.imageSmoothingQuality = 'high';
    x.drawImage(src, (104 - src.width * s) / 2, (104 - src.height * s) / 2, src.width * s, src.height * s);
    TC.$('fileThumb').src = c.toDataURL('image/jpeg', 0.8);
  } catch (_) { TC.$('fileThumb').removeAttribute('src'); }
  TC.$('originalEmpty').hidden = true;
  TC.$('runBtn').disabled = false;
  TC.$('resetBtn').disabled = false;
  TC.$('originalMeta').textContent = `${TC.fmtInt(firstPage.canvas.width)} × ${TC.fmtInt(firstPage.canvas.height)} px`;
}

async function prepareCanvasPage(sourceCanvas, index) {
  // Fit working canvas to a sane size for CV + OCR.
  const canvas = TC.fitCanvasFrom(sourceCanvas, sourceCanvas.width, sourceCanvas.height, MAX_WORK_SIDE);
  return { canvas, index, source: 'main', layers: null, analysis: null };
}

/** Render every page of a PDF into working canvases using PDF.js. */
async function loadPdfPages(file, onProgress) {
  if (!window.pdfjsLib) await TC.loadScript(TC.CDN.pdfJs);
  const pdfjs = window.pdfjsLib;
  if (!pdfjs) throw new Error('PDF.js failed to initialise.');
  pdfjs.GlobalWorkerOptions.workerSrc = TC.CDN.pdfJsWorker;
  const buf = await file.arrayBuffer();
  const task = pdfjs.getDocument({ data: new Uint8Array(buf), isEvalSupported: false, useSystemFonts: true });
  const doc = await task.promise;
  const count = Math.min(doc.numPages, MAX_PDF_PAGES);
  const pages = [];
  for (let i = 1; i <= count; i++) {
    onProgress((i - 1) / count, `Rendering PDF page ${i} of ${count}…`);
    const page = await doc.getPage(i);
    // Target a raster whose long side is ~1500 px (≈ 150 dpi for A4).
    const vp1 = page.getViewport({ scale: 1 });
    const scale = TC.clamp(1500 / Math.max(vp1.width, vp1.height), 0.5, 6);
    const vp = page.getViewport({ scale });
    const c = TC.makeCanvas(vp.width, vp.height);
    const x = TC.ctxOf(c);
    x.fillStyle = '#ffffff';
    x.fillRect(0, 0, c.width, c.height);
    await page.render({ canvasContext: x, viewport: vp, background: '#ffffff' }).promise;
    pages.push(await prepareCanvasPage(c, i - 1));
    page.cleanup();
  }
  try { await doc.destroy(); } catch (_) { /* ignore */ }
  if (!pages.length) throw new Error('This PDF contains no renderable pages.');
  return pages;
}

async function loadImagePages(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = 'async';
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = () => reject(new Error('That image could not be decoded by this browser.'));
      img.src = url;
    });
    // Guard against decompression bombs / absurd source sizes.
    const w = img.naturalWidth, h = img.naturalHeight;
    if (!w || !h) throw new Error('Image has zero dimensions.');
    if (w * h > 80e6) throw new Error('Image is too large (over 80 megapixels). Please downscale it first.');
    const src = TC.makeCanvas(w, h);
    TC.ctxOf(src).drawImage(img, 0, 0);
    return [await prepareCanvasPage(src, 0)];
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function acceptFile(file, opts = {}) {
  if (TC.state.busy) { TC.toast('A reconstruction is running — please wait for it to finish.', 'info'); return; }
  const name = file.name || 'document';
  const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(name);
  const isImg = /^image\//.test(file.type) || /\.(png|jpe?g|webp|bmp|gif|avif)$/i.test(name);
  if (!isPdf && !isImg) {
    TC.toast('Unsupported file type. Use PNG, JPG, WEBP, BMP, GIF or PDF.', 'err');
    return;
  }
  if (file.size > 60 * 1024 * 1024) {
    TC.toast('That file is larger than 60 MB. Please compress or downscale it first.', 'err');
    return;
  }
  const runId = ++TC.state.runId;
  showDropProgress(true, 0.02);
  resetResults();
  try {
    let pages;
    if (isPdf) {
      pages = await loadPdfPages(file, (p, label) => { showDropProgress(0.05 + p * 0.55); TC.progress.set(p * 55, 'pdf-in', label); });
    } else {
      pages = await loadImagePages(file);
    }
    if (runId !== TC.state.runId) return;
    if (!pages.length) throw new Error('No pages found in file.');
    TC.state.pages = pages;
    const first = pages[0];
    setSourceUI({ name, kind: isPdf ? 'pdf' : 'image', size: file.size, width: first.canvas.width, height: first.canvas.height }, first);
    TC.state.currentPage = 0;
    TC.showPage(0);
    TC.progress.reset('Ready to reconstruct', `“${name}” loaded — ${pages.length} page${pages.length > 1 ? 's' : ''}, ${TC.fmtInt(first.canvas.width)} × ${TC.fmtInt(first.canvas.height)} px.`);
    TC.$('runBtn').disabled = false;
    if (opts.autoRun) {
      await TC.sleep(180);
      TC.runPipeline();
    }
  } catch (err) {
    console.error(err);
    TC.toast(err.message || 'Could not read that file.', 'err', 6000);
    TC.progress.reset('Load failed', err.message || 'Could not read that file.');
    if (!TC.state.pages.length) { TC.$('dropzone').hidden = false; }
  } finally {
    showDropProgress(false, 0);
  }
}

function showDropProgress(on, frac) {
  TC.$('dropProgress').hidden = !on;
  TC.$('dropProgressBar').style.width = (TC.clamp(frac, 0, 1) * 100).toFixed(1) + '%';
}

  // --- exported onto TC ---
  TC.MAX_PDF_PAGES = MAX_PDF_PAGES;
  TC.MAX_WORK_SIDE = MAX_WORK_SIDE;
  TC.MIN_OCR_SIDE = MIN_OCR_SIDE;
  TC.acceptFile = acceptFile;
  TC.loadImagePages = loadImagePages;
  TC.loadPdfPages = loadPdfPages;
  TC.prepareCanvasPage = prepareCanvasPage;
  TC.resetResults = resetResults;
  TC.setSourceUI = setSourceUI;
  TC.showDropProgress = showDropProgress;
});
