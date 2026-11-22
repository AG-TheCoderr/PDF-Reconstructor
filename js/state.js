/* ============================================================================
   Application state
   The single source of truth for the current document.
   ========================================================================== */

TC.register(function (TC) {
  'use strict';

const state = {
  file: null,              // { name, kind: 'image'|'pdf', width, height }
  pages: [],               // [{ canvas, source:'main'|'sub', index, w, h }]
  // Full document composite (all pages stacked vertically) used for OCR.
  composite: null,
  compScale: 1,            // composite px per source px
  ocrSource: null,         // canvas given to Tesseract (enhanced)
  ocrScale: 1,             // ocrSource px per source px
  layers: null,            // { boxes, lines, words, wordsFallback, graphics, bgColor }
  analysis: null,          // derived per-run metrics
  pdfBytes: null,
  pdfUrl: null,
  pdfDoc: null,            // pdfjs doc for preview
  busy: false,
  pageSize: 'exact',
  previewMode: 'render',
  overlay: { boxes: true, lines: true, text: true, gfx: true },
  zoom: 'fit',
  stats: { pages: 0, words: 0, vectors: 0 },
  tesseract: null,         // lazily created worker
  tesseractReady: false,
  tesseractLoading: false,
  runId: 0,
  lastRunMs: 0,
};

  // --- exported onto TC ---
  TC.state = state;
});
