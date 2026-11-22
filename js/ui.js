/* ============================================================================
   UI wiring
   Binds every control in the sidebar and stage.
   ========================================================================== */

TC.register(function (TC) {
  'use strict';

function syncRange(input, outId, digits = 2) {
  const paint = () => {
    const v = parseFloat(input.value);
    const pct = ((v - parseFloat(input.min)) / (parseFloat(input.max) - parseFloat(input.min))) * 100;
    input.style.setProperty('--pct', pct.toFixed(1) + '%');
    if (outId) TC.$(outId).textContent = digits ? v.toFixed(digits) : String(v);
  };
  input.addEventListener('input', paint);
  paint();
}

function downloadPdf() {
  if (!TC.state.pdfBytes) return;
  const base = (TC.state.file && TC.state.file.name ? TC.state.file.name : 'document').replace(/\.[^.]+TC.$/, '').replace(/[^\w\-]+/g, '-');
  const a = document.createElement('a');
  const blob = new Blob([TC.state.pdfBytes], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);
  a.href = url;
  a.download = `${base || 'document'}-reconstructed.pdf`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  TC.toast('PDF downloaded — it stays on your device.', 'ok', 2600);
}

function openInTab() {
  if (!TC.state.pdfUrl) return;
  window.open(TC.state.pdfUrl, '_blank', 'noopener');
}

function resetWorkspace() {
  if (TC.state.busy) return;
  TC.state.runId++;
  TC.resetResults();
  TC.state.pages = [];
  TC.state.file = null;
  TC.state.stats = { pages: 0, words: 0, vectors: 0 };
  ['statPages', 'statWords', 'statVectors'].forEach((id) => { TC.$(id).textContent = '0'; });
  TC.$('fileCard').hidden = true;
  TC.$('originalEmpty').hidden = false;
  TC.$('sourceBadge').textContent = 'none';
  TC.$('originalMeta').textContent = '—';
  const oc = TC.$('originalCanvas');
  const x = TC.ctxOf(oc);
  x.clearRect(0, 0, oc.width, oc.height);
  TC.$('runBtn').disabled = true;
  TC.$('resetBtn').disabled = true;
  TC.$('pdfCanvas').hidden = true;
  TC.$('pdfEmpty').hidden = false;
  const panel = TC.$('pdfViewport').querySelector('.textlayer-panel');
  if (panel) panel.remove();
  TC.progress.reset('Idle', 'Load a document to begin.');
  TC.toast('Workspace reset.', 'info', 2000);
}

function wireUi() {
  /* --- file input + drag & drop --- */
  const dz = TC.$('dropzone');
  const input = TC.$('fileInput');
  dz.addEventListener('click', () => input.click());
  dz.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } });
  input.addEventListener('change', () => {
    const f = input.files && input.files[0];
    if (f) TC.acceptFile(f);
    input.value = '';
  });
  ['dragenter', 'dragover'].forEach((ev) => {
    window.addEventListener(ev, (e) => {
      if (!e.dataTransfer || !Array.from(e.dataTransfer.types).includes('Files')) return;
      e.preventDefault();
      dz.classList.add('drag');
    });
  });
  ['dragleave', 'drop'].forEach((ev) => {
    window.addEventListener(ev, (e) => {
      if (ev === 'dragleave' && e.target !== document.documentElement && e.target !== document.body) return;
      if (ev === 'drop') e.preventDefault();
      dz.classList.remove('drag');
    });
  });
  window.addEventListener('drop', (e) => {
    if (!e.dataTransfer) return;
    const f = e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) { e.preventDefault(); TC.acceptFile(f); }
  });
  window.addEventListener('dragover', (e) => { if (e.dataTransfer) e.preventDefault(); });

  TC.$('fileClear').addEventListener('click', (e) => { e.stopPropagation(); resetWorkspace(); });
  TC.$('sampleInvoice').addEventListener('click', () => TC.loadSample('invoice'));
  TC.$('sampleWorksheet').addEventListener('click', () => TC.loadSample('worksheet'));
  TC.$('runBtn').addEventListener('click', TC.runPipeline);
  TC.$('resetBtn').addEventListener('click', resetWorkspace);
  TC.$('downloadBtn').addEventListener('click', downloadPdf);
  TC.$('newTabBtn').addEventListener('click', openInTab);

  /* --- sliders --- */
  syncRange(TC.$('contrast'), 'contrastVal', 2);
  syncRange(TC.$('lineSens'), 'lineVal', 2);
  syncRange(TC.$('minConf'), 'confVal', 0);
  syncRange(TC.$('boldThresh'), 'boldVal', 2);

  /* --- page size segmented --- */
  TC.$('pageSizeSeg').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-size]');
    if (!b) return;
    TC.state.pageSize = b.dataset.size;
    TC.$('pageSizeSeg').querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
  });

  /* --- preview mode --- */
  TC.$('previewModeSeg').addEventListener('click', async (e) => {
    const b = e.target.closest('button[data-mode]');
    if (!b) return;
    TC.state.previewMode = b.dataset.mode;
    TC.$('previewModeSeg').querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    const pdfCanvas = TC.$('pdfCanvas');
    if (TC.state.previewMode === 'text') {
      if (pdfCanvas.hidden) return;
      pdfCanvas.style.opacity = '0.06';
      await TC.renderTextLayer();
    } else {
      pdfCanvas.style.opacity = '1';
      const panel = TC.$('pdfViewport').querySelector('.textlayer-panel');
      if (panel) panel.remove();
    }
  });

  /* --- overlay toggles --- */
  const overlayMap = { tglBoxes: 'boxes', tglLines: 'lines', tglText: 'text', tglGfx: 'gfx' };
  Object.entries(overlayMap).forEach(([id, key]) => {
    TC.$(id).addEventListener('click', () => {
      TC.state.overlay[key] = !TC.state.overlay[key];
      TC.$(id).setAttribute('aria-pressed', String(TC.state.overlay[key]));
      TC.drawOriginalOverlay();
    });
  });

  /* --- zoom --- */
  const zoomSteps = [0.25, 0.33, 0.5, 0.67, 0.8, 1, 1.25, 1.5, 2, 3, 4];
  function applyZoomAll() {
    if (TC.state.pages.length) {
      const oc = TC.$('originalCanvas');
      TC.applyZoom(oc, TC.$('originalViewport'), oc.width, oc.height);
    }
    if (TC.state.pdfDoc) {
      const pc = TC.$('pdfCanvas');
      TC.applyZoom(pc, TC.$('pdfViewport'), pc.width, pc.height);
    }
  }
  TC.$('zoomIn').addEventListener('click', () => {
    if (TC.state.zoom === 'fit') TC.state.zoom = 1;
    const i = zoomSteps.findIndex((z) => z > TC.state.zoom + 0.001);
    TC.state.zoom = i === -1 ? zoomSteps[zoomSteps.length - 1] : zoomSteps[i];
    applyZoomAll();
  });
  TC.$('zoomOut').addEventListener('click', () => {
    if (TC.state.zoom === 'fit') TC.state.zoom = 1;
    const i = zoomSteps.map((z) => z).reverse().findIndex((z) => z < TC.state.zoom - 0.001);
    TC.state.zoom = i === -1 ? zoomSteps[0] : zoomSteps[zoomSteps.length - 1 - i];
    applyZoomAll();
  });
  window.addEventListener('resize', () => {
    if (TC.state.zoom === 'fit') applyZoomAll();
  });

  /* --- keyboard --- */
  document.addEventListener('keydown', (e) => {
    const tag = (document.activeElement && document.activeElement.tagName) || '';
    const typing = /input|textarea|select/i.test(tag);
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); if (!TC.state.busy) TC.runPipeline(); return; }
    if (typing) return;
    if (e.key.toLowerCase() === 't') TC.applyTheme(document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark');
    if (e.key.toLowerCase() === 'o') TC.$('fileInput').click();
    if (e.key === '1') { TC.$('tglBoxes').click(); }
    if (e.key === '2') { TC.$('tglLines').click(); }
    if (e.key === '3') { TC.$('tglText').click(); }
    if (e.key === '4') { TC.$('tglGfx').click(); }
    if (e.key === '+' || e.key === '=') TC.$('zoomIn').click();
    if (e.key === '-') TC.$('zoomOut').click();
  });

  // re-fit after layout settles
  window.addEventListener('load', () => setTimeout(() => applyZoomAll(), 60));

  /* --- initial idle state --- */
  TC.progress.reset('Idle', 'Load a document to begin.');
}

  // --- exported onto TC ---
  TC.downloadPdf = downloadPdf;
  TC.openInTab = openInTab;
  TC.resetWorkspace = resetWorkspace;
  TC.syncRange = syncRange;
  TC.wireUi = wireUi;
});
