/* ============================================================================
   Configuration
   Version pins for the CDN libraries and the pipeline constants.
   ========================================================================== */

TC.register(function (TC) {
  'use strict';

const CDN = {
  tesseract: 'https://cdn.jsdelivr.net/npm/tesseract.js@6.0.1/dist/tesseract.min.js',
  tesseractWorker: 'https://cdn.jsdelivr.net/npm/tesseract.js@6.0.1/dist/worker.min.js',
  tesseractCore: 'https://cdn.jsdelivr.net/npm/tesseract.js-core@6.1.2',
  tesseractLang: 'https://cdn.jsdelivr.net/npm/@tesseract.js-data/eng@1.0.0/4.0.0_best_int',
  pdfLib: 'https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/dist/pdf-lib.min.js',
  // pdf.js 3.x ships a classic UMD build that runs from file:// and GH Pages alike.
  pdfJs: 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.min.js',
  pdfJsWorker: 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js',
};

  // --- exported onto TC ---
  TC.CDN = CDN;
});
