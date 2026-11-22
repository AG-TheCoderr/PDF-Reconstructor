/* ============================================================================
   Sample loading
   Wires the two sample buttons to the pipeline.
   ========================================================================== */

TC.register(function (TC) {
  'use strict';

async function loadSample(kind) {
  if (TC.state.busy) { TC.toast('Wait for the current reconstruction to finish.', 'info'); return; }
  try {
    TC.progress.reset('Drawing sample', 'Rendering a synthetic ' + kind + ' at 150 dpi…');
    await TC.nextFrame();
    const canvas = kind === 'invoice' ? TC.drawInvoiceSample() : TC.drawWorksheetSample();
    TC.addPaperNoise(canvas);
    TC.state.runId++;
    TC.resetResults();
    TC.state.pages = [await TC.prepareCanvasPage(canvas, 0)];
    TC.state.currentPage = 0;
    TC.setSourceUI({ name: kind === 'invoice' ? 'sample-invoice.png' : 'sample-worksheet.png', kind: 'sample', size: 0, width: canvas.width, height: canvas.height }, TC.state.pages[0]);
    TC.showPage(0);
    TC.progress.reset('Sample ready', 'Generated locally — running the pipeline…');
    TC.toast('Sample loaded. Running the four-layer pipeline…', 'ok', 2600);
    await TC.sleep(120);
    TC.runPipeline();
  } catch (err) {
    console.error(err);
    TC.toast('Could not build the sample document.', 'err');
  }
}

  // --- exported onto TC ---
  TC.loadSample = loadSample;
});
