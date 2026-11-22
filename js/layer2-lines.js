/* ============================================================================
   Layer 2 - structural lines
   Finds rules, dividers and table borders.
   ========================================================================== */

TC.register(function (TC) {
  'use strict';

function detectLines(imgData, W, H, bg, sens, refImage) {
  const t0 = performance.now();
  const data = imgData.data;
  const thresh = 46 - sens * 16;       // 30 … 46
  const t2 = thresh * thresh;
  // Ink mask against the local background (banner fills are not ink).
  const ink = refImage
    ? TC.buildInkMask(data, refImage.data, W * H, thresh)
    : new Uint8Array(W * H).map((_, i) => 0);
  if (!refImage) {
    for (let i = 0, p = 0; i < ink.length; i++, p += 4) {
      ink[i] = TC.colorDist2(data[p], data[p + 1], data[p + 2], bg.r, bg.g, bg.b) > t2 ? 1 : 0;
    }
  }
  const maxThick = Math.max(4, Math.round(Math.min(W, H) * 0.014));
  const minLenH = Math.max(24, Math.round(W * (0.15 - 0.105 * sens)));
  const minLenV = Math.max(24, Math.round(H * (0.15 - 0.105 * sens)));

  const scanRuns = (horizontal) => {
    const bands = [];
    const limit = horizontal ? H : W;
    const cross = horizontal ? W : H;
    let active = [];
    for (let a = 0; a < limit; a++) {
      // gather runs along this row/column
      const runs = [];
      let start = -1;
      for (let b = 0; b < cross; b++) {
        const on = horizontal ? ink[a * W + b] : ink[b * W + a];
        if (on) { if (start < 0) start = b; }
        else if (start >= 0) {
          if (b - start >= Math.min(minLenH, minLenV) * 0.5) runs.push([start, b - 1]);
          start = -1;
        }
      }
      if (start >= 0 && cross - start >= Math.min(minLenH, minLenV) * 0.5) runs.push([start, cross - 1]);
      const nextActive = [];
      const used = new Uint8Array(runs.length);
      for (const band of active) {
        let matched = false;
        for (let ri = 0; ri < runs.length; ri++) {
          if (used[ri]) continue;
          const [rs, re] = runs[ri];
          const ov = Math.min(band.x2, re) - Math.max(band.x1, rs) + 1;
          const minLen = Math.min(band.x2 - band.x1, re - rs) + 1;
          if (ov > 0 && ov / minLen >= 0.72) {
            band.x1 = Math.min(band.x1, rs);
            band.x2 = Math.max(band.x2, re);
            band.y1 = a;
            used[ri] = 1;
            matched = true;
            nextActive.push(band);
            break;
          }
        }
        if (!matched) bands.push(band);
      }
      for (let ri = 0; ri < runs.length; ri++) {
        if (used[ri]) continue;
        nextActive.push({ x1: runs[ri][0], x2: runs[ri][1], y0: a, y1: a });
      }
      active = nextActive;
    }
    bands.push(...active);
    return bands;
  };

  const finish = (bands, horizontal) => {
    const out = [];
    for (const b of bands) {
      const len = b.x2 - b.x1 + 1;
      const thick = b.y1 - b.y0 + 1;
      const minLen = horizontal ? minLenH : minLenV;
      if (len < minLen) continue;
      if (thick > maxThick) continue;
      if (len / thick < 5) continue;
      // median stroke colour sampled along the centre of the band
      const midCross = Math.round((b.y0 + b.y1) / 2);
      const x0 = Math.round(b.x1 + len * 0.06), x1 = Math.round(b.x2 - len * 0.06);
      const rs = [], gs = [], bs = [];
      for (let c = x0; c <= x1; c += Math.max(1, Math.round(len / 220))) {
        const idx = horizontal ? (midCross * W + c) : (c * W + midCross);
        const p = idx * 4;
        const rr = refImage ? refImage.data[p] : bg.r;
        const gg = refImage ? refImage.data[p + 1] : bg.g;
        const bb = refImage ? refImage.data[p + 2] : bg.b;
        if (TC.colorDist2(data[p], data[p + 1], data[p + 2], rr, gg, bb) > t2) {
          rs.push(data[p]); gs.push(data[p + 1]); bs.push(data[p + 2]);
        }
      }
      const r = rs.length ? TC.medianOfNumbers(rs) : 0;
      const g = gs.length ? TC.medianOfNumbers(gs) : 0;
      const bl = bs.length ? TC.medianOfNumbers(bs) : 0;
      // Re-verify on the centreline: most samples must actually match this colour.
      let agree = 0, tested = 0;
      for (let c = Math.round(b.x1 + len * 0.04); c < Math.round(b.x2 - len * 0.04); c += Math.max(1, Math.round(len / 160))) {
        const idx = horizontal ? (midCross * W + c) : (c * W + midCross);
        const p = idx * 4;
        tested++;
        if (TC.colorDist2(data[p], data[p + 1], data[p + 2], r, g, bl) < 55 * 55) agree++;
      }
      if (tested > 4 && agree / tested < 0.62) continue;
      if (TC.colorDist(r, g, bl, bg.r, bg.g, bg.b) < 26) continue; // a gap, not a stroke
      out.push(horizontal
        ? { orient: 'h', x1: b.x1, y1: midCross, x2: b.x2 + 1, y2: midCross, thickness: thick, r, g, b: bl, hex: TC.rgbToHex(r, g, bl) }
        : { orient: 'v', x1: midCross, y1: b.x1, x2: midCross, y2: b.x2 + 1, thickness: thick, r, g, b: bl, hex: TC.rgbToHex(r, g, bl) });
    }
    // merge collinear neighbours split by gaps (e.g. a glyph crossing a rule)
    out.sort((p, q) => (horizontal ? p.y1 - q.y1 || p.x1 - q.x1 : p.x1 - q.x1 || p.y1 - q.y1));
    const merged = [];
    for (const l of out) {
      const prev = merged[merged.length - 1];
      if (prev && prev.orient === l.orient &&
          Math.abs(prev.y1 - l.y1) <= Math.max(2, prev.thickness) &&
          Math.abs(prev.firstCross - l.firstCross) <= 2) {
        const gap = horizontal ? l.x1 - prev.x2 : l.y1 - prev.y2;
        if (gap >= -2 && gap <= 14) {
          prev.x2 = Math.max(prev.x2, l.x2);
          prev.y2 = Math.max(prev.y2, l.y2);
          continue;
        }
      }
      const copy = { ...l, firstCross: horizontal ? l.x1 : l.y1 };
      merged.push(copy);
    }
    return merged.map(({ firstCross, ...rest }) => rest);
  };

  const hBands = finish(scanRuns(true), true);
  const vBands = finish(scanRuns(false), false);
  return { lines: [...hBands, ...vBands], ms: performance.now() - t0, minLenH, minLenV, maxThick };
}

/** Remove rule detections that live entirely inside a filled colour region. */
function dropLinesInsideBoxes(lines, boxes) {
  if (!boxes.length) return lines;
  const out = [];
  for (const l of lines) {
    const x1 = Math.min(l.x1, l.x2), x2 = Math.max(l.x1, l.x2);
    const y1 = Math.min(l.y1, l.y2), y2 = Math.max(l.y1, l.y2);
    let inside = false;
    for (const b of boxes) {
      const bx0 = b.x - 3, by0 = b.y - 3, bx1 = b.x + b.w + 3, by1 = b.y + b.h + 3;
      if (x1 >= bx0 && x2 <= bx1 && y1 >= by0 && y2 <= by1) {
        // A rule *on* the border is structural → keep it.
        const onTop = Math.abs(y1 - b.y) < 4 && l.orient === 'h';
        const onBottom = Math.abs(y2 - (b.y + b.h)) < 4 && l.orient === 'h';
        const onLeft = Math.abs(x1 - b.x) < 4 && l.orient === 'v';
        const onRight = Math.abs(x2 - (b.x + b.w)) < 4 && l.orient === 'v';
        if (!onTop && !onBottom && !onLeft && !onRight) { inside = true; break; }
      }
    }
    if (!inside) out.push(l);
  }
  return out;
}

  // --- exported onto TC ---
  TC.detectLines = detectLines;
  TC.dropLinesInsideBoxes = dropLinesInsideBoxes;
});
