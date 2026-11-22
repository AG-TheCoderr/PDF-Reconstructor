/* ============================================================================
   Page display + overlay
   Shows a page and draws the debug overlay (regions, lines, text, graphics).
   ========================================================================== */

TC.register(function (TC) {
  'use strict';

function fitViewportSize(viewport, canvasW, canvasH) {
  const pad = parseFloat(getComputedStyle(viewport).paddingLeft) * 2 || 24;
  const vw = Math.max(120, viewport.clientWidth - pad);
  const vh = Math.max(120, viewport.clientHeight - pad);
  const s = Math.min(vw / canvasW, vh / canvasH);
  return { width: canvasW * s, height: canvasH * s, scale: s };
}

function applyZoom(canvasEl, viewport, naturalW, naturalH, extraScale = 1) {
  const fit = fitViewportSize(viewport, naturalW, naturalH);
  let w = fit.width * extraScale;
  if (TC.state.zoom !== 'fit') w = fit.width * TC.state.zoom;
  w = TC.clamp(w, 60, naturalW * 4);
  const h = w * (naturalH / naturalW);
  canvasEl.style.width = w + 'px';
  canvasEl.style.height = h + 'px';
  const pct = Math.round((w / naturalW) * 100);
  TC.$('zoomLabel').textContent = TC.state.zoom === 'fit' ? 'fit' : pct + '%';
  return { w, h };
}

function showPage(index) {
  TC.state.currentPage = index;
  const page = TC.state.pages[index];
  if (!page) return;
  const oc = TC.$('originalCanvas');
  oc.width = page.canvas.width;
  oc.height = page.canvas.height;
  const x = TC.ctxOf(oc);
  x.drawImage(page.canvas, 0, 0);
  drawOriginalOverlay();
  applyZoom(oc, TC.$('originalViewport'), oc.width, oc.height);
  TC.$('originalEmpty').hidden = true;
  TC.$('originalMeta').textContent = `${TC.fmtInt(page.canvas.width)} × ${TC.fmtInt(page.canvas.height)} px` + (TC.state.pages.length > 1 ? ` · page ${index + 1}/${TC.state.pages.length}` : '');
  if (TC.state.pdfDoc) TC.renderPdfPreview();
}

function overlayColors() {
  const s = getComputedStyle(document.documentElement);
  return {
    bg: s.getPropertyValue('--layer-bg').trim() || '#3b82f6',
    line: s.getPropertyValue('--layer-line').trim() || '#22c55e',
    text: s.getPropertyValue('--layer-text').trim() || '#f59e0b',
    gfx: s.getPropertyValue('--layer-gfx').trim() || '#a855f7',
  };
}

function drawOriginalOverlay() {
  const page = TC.state.pages[TC.state.currentPage];
  if (!page) return;
  const oc = TC.$('originalCanvas');
  const x = TC.ctxOf(oc);
  x.clearRect(0, 0, oc.width, oc.height);
  x.drawImage(page.canvas, 0, 0);
  const L = page.layers;
  if (!L) return;
  const C = overlayColors();
  const dpr = 1; // canvas space is already page pixels
  const lw = Math.max(1.2, oc.width / 900);

  // Layer 1 — color regions (blue)
  if (TC.state.overlay.boxes) {
    x.save();
    x.strokeStyle = C.bg;
    x.lineWidth = lw;
    x.setLineDash([]);
    for (const b of L.boxes) {
      x.globalAlpha = 0.9;
      x.strokeRect(b.x + 0.5, b.y + 0.5, b.w, b.h);
      x.globalAlpha = 0.12;
      x.fillStyle = b.hex;
      x.fillRect(b.x, b.y, b.w, b.h);
    }
    x.restore();
  }
  // Layer 2 — lines (green)
  if (TC.state.overlay.lines) {
    x.save();
    x.strokeStyle = C.line;
    x.lineWidth = Math.max(lw * 1.6, 2);
    x.setLineDash([]);
    for (const l of L.lines) {
      x.beginPath();
      x.moveTo(l.x1, l.y1);
      x.lineTo(l.x2, l.y2);
      x.stroke();
    }
    x.restore();
  }
  // Layer 3 — text (orange)
  if (TC.state.overlay.text) {
    x.save();
    x.strokeStyle = C.text;
    x.lineWidth = Math.max(1, lw * 0.9);
    x.globalAlpha = 0.95;
    for (const w of L.words) {
      x.strokeRect(w.x + 0.25, w.y + 0.25, w.w, w.h);
    }
    x.restore();
  }
  // Layer 4 — graphics (purple)
  if (TC.state.overlay.gfx) {
    x.save();
    x.strokeStyle = C.gfx;
    x.lineWidth = Math.max(lw * 1.4, 1.6);
    x.setLineDash([6 * lw, 4 * lw]);
    for (const g of L.graphics) {
      x.strokeRect(g.x, g.y, g.w, g.h);
    }
    x.restore();
  }
}

  // --- exported onto TC ---
  TC.applyZoom = applyZoom;
  TC.drawOriginalOverlay = drawOriginalOverlay;
  TC.fitViewportSize = fitViewportSize;
  TC.overlayColors = overlayColors;
  TC.showPage = showPage;
});
