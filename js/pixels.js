/* ============================================================================
   Pixel + colour helpers
   Low-level pixel access, masks, morphology and colour sampling.
   ========================================================================== */

TC.register(function (TC) {
  'use strict';

const lumOf = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
const colorDist2 = (r1, g1, b1, r2, g2, b2) => {
  const dr = r1 - r2, dg = g1 - g2, db = b1 - b2;
  return dr * dr + dg * dg + db * db;
};
const colorDist = (r1, g1, b1, r2, g2, b2) => Math.sqrt(colorDist2(r1, g1, b1, r2, g2, b2));

function medianOfNumbers(arr) {
  if (!arr.length) return 0;
  const a = arr.slice().sort((x, y) => x - y);
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

/**
 * Dominant colour of an RGBA buffer region using a coarse histogram + mean refinement.
 * Robust to anti-aliased text over the region.
 */
function dominantColor(data, W, x0, y0, x1, y1, step = 1) {
  const hist = new Uint32Array(4096);
  const sums = new Float64Array(4096 * 3);
  let sampled = 0;
  for (let y = y0; y < y1; y += step) {
    let p = (y * W + x0) * 4;
    for (let x = x0; x < x1; x += step, p += 4 * step) {
      const r = data[p], g = data[p + 1], b = data[p + 2];
      const k = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
      hist[k]++;
      sums[k * 3] += r; sums[k * 3 + 1] += g; sums[k * 3 + 2] += b;
      sampled++;
    }
  }
  if (!sampled) return { r: 255, g: 255, b: 255, frac: 1 };
  let best = 0, bestK = 0;
  for (let k = 0; k < 4096; k++) if (hist[k] > best) { best = hist[k]; bestK = k; }
  return {
    r: sums[bestK * 3] / best,
    g: sums[bestK * 3 + 1] / best,
    b: sums[bestK * 3 + 2] / best,
    frac: best / sampled,
  };
}

/**
 * Layer 1 helper — page background from outer margins.
 */
function samplePageBackground(data, W, H) {
  const bx = Math.max(2, Math.round(W * 0.028));
  const by = Math.max(2, Math.round(H * 0.028));
  const bands = [
    [0, 0, W, by], [0, H - by, W, H],
    [0, 0, bx, H], [W - bx, 0, W, H],
  ];
  const hist = new Uint32Array(4096);
  const sums = new Float64Array(4096 * 3);
  let total = 0;
  for (const [x0, y0, x1, y1] of bands) {
    for (let y = y0; y < y1; y += 2) {
      let p = (y * W + x0) * 4;
      for (let x = x0; x < x1; x += 2, p += 8) {
        const r = data[p], g = data[p + 1], b = data[p + 2];
        const k = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
        hist[k]++; sums[k * 3] += r; sums[k * 3 + 1] += g; sums[k * 3 + 2] += b; total++;
      }
    }
  }
  if (!total) return { r: 255, g: 255, b: 255, hex: '#ffffff' };
  let best = 0, bestK = 0;
  for (let k = 0; k < 4096; k++) if (hist[k] > best) { best = hist[k]; bestK = k; }
  const r = sums[bestK * 3] / best, g = sums[bestK * 3 + 1] / best, b = sums[bestK * 3 + 2] / best;
  return { r: Math.round(r), g: Math.round(g), b: Math.round(b), hex: TC.rgbToHex(r, g, b), frac: best / total };
}

/**
 * Build a reference "expected background" raster: page paper everywhere, with
 * every detected colour region painted in its own fill colour. Layers 2 & 4
 * compare pixels against this instead of the global page colour, which keeps
 * banner interiors from registering as ink.
 */
function buildBackgroundReference(W, H, pageBg, boxes) {
  const c = TC.makeCanvas(W, H);
  const x = TC.ctxOf(c);
  x.fillStyle = TC.rgbToHex(pageBg.r, pageBg.g, pageBg.b);
  x.fillRect(0, 0, W, H);
  const ordered = boxes.slice().sort((a, b) => b.area - a.area);
  for (const b of ordered) {
    // A box covering part of the page is only an *approximation* of the fill
    // under it, and this reference is what every later layer compares against.
    // Painting it in its dominant colour is right for a flat panel; for a box
    // that spans a letterhead and the paper below it, painting one flat colour
    // invents a boundary that does not exist and hides real artwork. So the
    // reference is painted only where the box actually is uniform, which is
    // the common case and the only case where painting helps.
    if (b.area && b.area < b.w * b.h * 0.62) continue;
    x.fillStyle = b.hex;
    x.fillRect(b.x, b.y, b.w, b.h);
  }
  return x.getImageData(0, 0, W, H);
}

/** Ink mask against a local background reference. */
function buildInkMask(data, ref, total, tol) {
  const ink = new Uint8Array(total);
  const t2 = tol * tol;
  for (let i = 0, p = 0; i < total; i++, p += 4) {
    const dr = data[p] - ref[p], dg = data[p + 1] - ref[p + 1], db = data[p + 2] - ref[p + 2];
    if (dr * dr + dg * dg + db * db > t2) ink[i] = 1;
  }
  return ink;
}

  // --- exported onto TC ---
  TC.buildBackgroundReference = buildBackgroundReference;
  TC.buildInkMask = buildInkMask;
  TC.colorDist = colorDist;
/** Saturation of a colour, 0 for grey and 1 for a fully saturated hue. */
function colorfulness(c) {
  const mx = Math.max(c.r, c.g, c.b), mn = Math.min(c.r, c.g, c.b);
  return mx <= 0 ? 0 : (mx - mn) / mx;
}

  TC.colorDist2 = colorDist2;
  TC.colorfulness = colorfulness;
  TC.dominantColor = dominantColor;
  TC.lumOf = lumOf;
  TC.medianOfNumbers = medianOfNumbers;
  TC.samplePageBackground = samplePageBackground;
});
