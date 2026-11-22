/* ============================================================================
   PDF preview
   Renders the produced PDF with PDF.js, plus its text layer.
   ========================================================================== */

TC.register(function (TC) {
  'use strict';

async function loadPdfPreview(url) {
  if (!window.pdfjsLib) await TC.loadScript(TC.CDN.pdfJs).catch(() => {});
  const pdfjs = window.pdfjsLib;
  if (!pdfjs) { TC.$('pdfMeta').textContent = 'Preview unavailable (PDF.js could not load)'; return; }
  pdfjs.GlobalWorkerOptions.workerSrc = TC.CDN.pdfJsWorker;
  try {
    if (TC.state.pdfDoc) { try { await TC.state.pdfDoc.destroy(); } catch (_) {} }
    TC.state.pdfDoc = await pdfjs.getDocument({ url, isEvalSupported: false }).promise;
    TC.$('pdfMeta').textContent = `Vector PDF · ${TC.state.pdfDoc.numPages} page${TC.state.pdfDoc.numPages > 1 ? 's' : ''}`;
    await renderPdfPreview();
  } catch (err) {
    console.warn('pdf preview failed', err);
    TC.$('pdfMeta').textContent = 'Preview could not render — download is still available';
  }
}

async function renderPdfPreview() {
  if (!TC.state.pdfDoc) return;
  const pdfCanvas = TC.$('pdfCanvas');
  const n = TC.state.pdfDoc.numPages;
  const shown = Math.min(n, 6);
  const pageViews = [];
  let totalH = 0, maxW = 0;
  const targetLong = 1500;
  for (let i = 1; i <= shown; i++) {
    const p = await TC.state.pdfDoc.getPage(i);
    const vp1 = p.getViewport({ scale: 1 });
    const scale = targetLong / Math.max(vp1.width, vp1.height);
    const vp = p.getViewport({ scale });
    pageViews.push({ p, vp });
    totalH += Math.ceil(vp.height) + 8;
    maxW = Math.max(maxW, Math.ceil(vp.width));
  }
  pdfCanvas.width = maxW;
  pdfCanvas.height = Math.round(totalH);
  const x = TC.ctxOf(pdfCanvas);
  x.fillStyle = '#dfe3ee';
  x.fillRect(0, 0, pdfCanvas.width, pdfCanvas.height);
  let y = 0;
  for (const { p, vp } of pageViews) {
    x.save();
    x.translate(0, y);
    await p.render({ canvasContext: x, viewport: vp, background: '#ffffff' }).promise;
    x.restore();
    y += Math.ceil(vp.height) + 8;
  }
  pdfCanvas.hidden = false;
  TC.$('pdfEmpty').hidden = true;
  TC.applyZoom(pdfCanvas, TC.$('pdfViewport'), pdfCanvas.width, pdfCanvas.height);
  pdfCanvas.style.opacity = TC.state.previewMode === 'text' ? '0.06' : '1';
  if (TC.state.previewMode === 'text') renderTextLayer();
}

async function renderTextLayer() {
  const host = TC.$('pdfViewport');
  let panel = host.querySelector('.textlayer-panel');
  if (!panel) {
    panel = document.createElement('div');
    panel.className = 'textlayer-panel';
    panel.style.cssText = 'position:absolute;inset:10px;overflow:auto;padding:16px 18px;border-radius:10px;background:color-mix(in srgb, var(--bg-1) 97%, transparent);font-size:.78rem;line-height:1.75;white-space:pre-wrap;font-family:var(--font-mono);text-align:left;display:block;box-shadow:0 0 0 1px var(--line-2);';
    host.appendChild(panel);
  }
  panel.hidden = false;
  panel.textContent = 'Extracting text layer…';
  try {
    const out = [];
    for (let i = 1; i <= TC.state.pdfDoc.numPages; i++) {
      const p = await TC.state.pdfDoc.getPage(i);
      const tc = await p.getTextContent();
      const lines = [];
      let line = '';
      for (const item of tc.items) {
        if (item.str) line += item.str;
        if (item.hasEOL) { if (line.trim()) lines.push(line.trim()); line = ''; }
      }
      if (line.trim()) lines.push(line.trim());
      out.push(`── page ${i} ──\n` + lines.join('\n'));
    }
    panel.textContent = out.join('\n\n');
  } catch (e) {
    panel.textContent = 'Could not extract text: ' + e.message;
  }
}

  // --- exported onto TC ---
  TC.loadPdfPreview = loadPdfPreview;
  TC.renderPdfPreview = renderPdfPreview;
  TC.renderTextLayer = renderTextLayer;
});
