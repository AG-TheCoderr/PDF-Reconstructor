/* ============================================================================
   Boot
   Starts the app and publishes the debug handle.
   ========================================================================== */

TC.register(function (TC) {
  'use strict';

function boot() {
  TC.initTheme();
  TC.wireUi();
  // Warm the heavy libs as soon as the browser is idle (keeps first run snappy).
  const idle = window.requestIdleCallback || ((fn) => setTimeout(fn, 900));
  idle(() => { TC.loadScript(TC.CDN.pdfLib).catch(() => {}); });
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
else boot();

/* Small public handle — useful for automation, e2e tests and power users. */
window.Typecraft = {
  version: '1.0',
  state: TC.state,
  run: TC.runPipeline,
  loadSample: TC.loadSample,
  reset: TC.resetWorkspace,
  detectColorRegions: TC.detectColorRegions,
  detectLines: TC.detectLines,
  samplePageBackground: TC.samplePageBackground,
  buildStyledWords: TC.buildStyledWords,
  assemblePdf: TC.assemblePdf,
  options: TC.readOptions,
  drawInvoiceSample: TC.drawInvoiceSample,
  drawWorksheetSample: TC.drawWorksheetSample,
  estimateCropSkew: TC.estimateCropSkew,
  ocrRotatedCrop: TC.ocrRotatedCrop,
  vectoriseCrop: TC.vectoriseCrop,
  traceMask: TC.traceMask,
  // Layer internals, exposed for diagnostics and automated checks.
  detectGraphics: TC.detectGraphics,
  cleanCropAgainstVectors: TC.cleanCropAgainstVectors,
  restoreCropAlpha: TC.restoreCropAlpha,
  buildStyledWordsFull: TC.buildStyledWords,
  runOcrPasses: TC.runOcrPasses,
  chooseOcrScale: TC.chooseOcrScale,
  medianLineHeight: TC.medianLineHeight,
  poolSize: TC.poolSize,
  ensureWorkerPool: TC.ensureWorkerPool,
  fillBeneathWord: TC.fillBeneathWord,
  analyzeTextPixels: TC.analyzeTextPixels,
  colorDist2: TC.colorDist2,
  colorfulness: TC.colorfulness,
  lumOf: TC.lumOf,
};

  // --- exported onto TC ---
  TC.boot = boot;
});
