/* ============================================================================
   Layer 4 - artwork
   Finds logos, stamps and diagrams, then traces them into vector paths.
   ========================================================================== */

TC.register(function (TC) {
  'use strict';

function detectGraphics(imgData, W, H, bg, words, lines, opts) {
  const t0 = performance.now();
  const data = imgData.data;
  const total = W * H;
  const mask = new Uint8Array(total);   // 1 = candidate graphic ink
  const forbid = new Uint8Array(total); // 1 = text or line pixel (never graphics)
  const bgLum = TC.lumOf(bg.r, bg.g, bg.b);
  const paperIsLight = bgLum > 128;
  const pageBgRef = bg;

  // Ink test against the local background reference (page paper + colour fills).
  const bgTol = opts.bgTol || 46;
  const ref = opts.refImage;
  if (ref) {
    const m = TC.buildInkMask(data, ref.data, total, bgTol);
    mask.set(m);
  } else {
    const bgTol2 = bgTol * bgTol;
    for (let i = 0, p = 0; i < total; i++, p += 4) {
      const d2 = TC.colorDist2(data[p], data[p + 1], data[p + 2], bg.r, bg.g, bg.b);
      mask[i] = d2 > bgTol2 ? 1 : 0;
    }
  }

  // Exclude text bboxes (slightly inflated) and thick horizontal/vertical rules.
  const inflate = 2;
  for (const w of words) {
    const x0 = TC.clamp(Math.floor(w.x) - inflate, 0, W);
    const y0 = TC.clamp(Math.floor(w.y) - inflate, 0, H);
    const x1 = TC.clamp(Math.ceil(w.x + w.w) + inflate, 0, W);
    const y1 = TC.clamp(Math.ceil(w.y + w.h) + inflate, 0, H);
    for (let y = y0; y < y1; y++) {
      const base = y * W;
      for (let x = x0; x < x1; x++) forbid[base + x] = 1;
    }
  }
  // Exclude line corridors (rules are painted as vectors, not crops).
  for (const l of lines) {
    const th = Math.max(3, l.thickness + 3);
    if (l.orient === 'h') {
      const y0 = TC.clamp(Math.floor(l.y1 - th), 0, H);
      const y1 = TC.clamp(Math.ceil(l.y1 + th), 0, H);
      const x0 = TC.clamp(Math.floor(Math.min(l.x1, l.x2) - th), 0, W);
      const x1 = TC.clamp(Math.ceil(Math.max(l.x1, l.x2) + th), 0, W);
      for (let y = y0; y < y1; y++) { const b = y * W; for (let x = x0; x < x1; x++) forbid[b + x] = 1; }
    } else {
      const x0 = TC.clamp(Math.floor(l.x1 - th), 0, W);
      const x1 = TC.clamp(Math.ceil(l.x1 + th), 0, W);
      const y0 = TC.clamp(Math.floor(Math.min(l.y1, l.y2) - th), 0, H);
      const y1 = TC.clamp(Math.ceil(Math.max(l.y1, l.y2) + th), 0, H);
      for (let y = y0; y < y1; y++) { const b = y * W; for (let x = x0; x < x1; x++) forbid[b + x] = 1; }
    }
  }
  for (let i = 0; i < total; i++) if (forbid[i]) mask[i] = 0;

  // Despeckle: drop near-isolated dark pixels of tiny glyph fragments.
  // 3×3 erosion then dilation would kill 1px strokes; instead do a cheap 8-neighbour count
  // on the mask copy for pixels whose neighbourhood is nearly empty.
  const despeckled = mask.slice();
  for (let y = 1; y < H - 1; y += 1) {
    const b = y * W;
    for (let x = 1; x < W - 1; x += 1) {
      const i = b + x;
      if (!mask[i]) continue;
      const s = mask[i - 1] + mask[i + 1] + mask[i - W] + mask[i + W] +
        mask[i - W - 1] + mask[i - W + 1] + mask[i + W - 1] + mask[i + W + 1];
      if (s < 2) despeckled[i] = 0;
    }
  }

  // Connected components (iterative flood fill, 8-connectivity)
  const labels = new Int32Array(total).fill(0);
  const comps = [];
  const stack = new Int32Array(total);
  const minArea = opts.minArea || 1600;
  const minDim = opts.minDim || 26;
  const maxComps = 4000;
  let nextLabel = 0;
  for (let i = 0; i < total; i++) {
    if (!despeckled[i] || labels[i]) continue;
    nextLabel++;
    let sp = 0;
    stack[sp++] = i;
    labels[i] = nextLabel;
    let minX = W, minY = H, maxX = 0, maxY = 0, area = 0;
    const pixels = [];
    while (sp > 0) {
      const q = stack[--sp];
      const qy = (q / W) | 0, qx = q - qy * W;
      area++;
      if (area <= 400000) pixels.push(q);
      if (qx < minX) minX = qx; if (qx > maxX) maxX = qx;
      if (qy < minY) minY = qy; if (qy > maxY) maxY = qy;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = qy + dy;
        if (ny < 0 || ny >= H) continue;
        const nb = ny * W;
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const nx = qx + dx;
          if (nx < 0 || nx >= W) continue;
          const ni = nb + nx;
          if (despeckled[ni] && !labels[ni]) { labels[ni] = nextLabel; stack[sp++] = ni; }
        }
      }
      if (sp > total - 2) break; // safety
    }
    comps.push({ label: nextLabel, area, minX, minY, maxX, maxY, pixels });
    if (nextLabel >= maxComps) break;
  }

  // Merge components that overlap heavily (e.g. logo ring pieces, stamp strokes).
  comps.sort((a, b) => b.area - a.area);
  const chosen = [];
  const why = { area: 0, dim: 0, ratio: 0, big: 0, text: 0, solid: 0, inbox: 0, kept: 0 };
  for (const c of comps) {
    const w = c.maxX - c.minX + 1, h = c.maxY - c.minY + 1;
    if (c.area < minArea) { why.area++; continue; }
    if (w < minDim || h < minDim) { why.dim++; continue; }
    if (w / h > 12 || h / w > 12) { why.ratio++; continue; }   // rules are Layer 2's job
    if (w * h > W * H * 0.55) { why.big++; continue; }       // page-sized fills are backgrounds
    const fill = c.area / (w * h);
    // A glyph cluster is not a graphic: bail when most of its mass is text ink.
    let textish = 0;
    const stride = Math.max(1, Math.floor(c.pixels.length / 4000));
    for (let i = 0; i < c.pixels.length; i += stride) if (forbid[c.pixels[i]]) textish++;
    if (c.pixels.length && textish / (c.pixels.length / stride) > 0.55) { why.text++; continue; }
    // Solid, rectangle-like fills are painted by Layers 1–2 — never crop them as graphics.
    if (fill > 0.8 && w > 18 && h > 14) { why.solid++; continue; }
    // Anything that sits entirely inside a detected colour region is already vector art.
    let insideBox = false;
    for (const b of (opts.boxes || [])) {
      if (c.minX >= b.x - 2 && c.maxX <= b.x + b.w + 2 && c.minY >= b.y - 2 && c.maxY <= b.y + b.h + 2) { insideBox = true; break; }
    }
    if (insideBox && (c.area / (w * h)) > 0.35) { why.inbox++; continue; }
    // Union with any selected component whose box touches/overlaps this one.
    // (A banner's visible text pixels and its border must ship as ONE crop,
    //  otherwise the page background would show through the gaps.)
    let mergedInto = null;
    for (const k of chosen) {
      const gapX = Math.max(k.minX, c.minX) - Math.min(k.maxX, c.maxX);
      const gapY = Math.max(k.minY, c.minY) - Math.min(k.maxY, c.maxY);
      if (gapX <= 2 && gapY <= 2) { mergedInto = k; break; }
    }
    if (mergedInto) {
      mergedInto.minX = Math.min(mergedInto.minX, c.minX);
      mergedInto.minY = Math.min(mergedInto.minY, c.minY);
      mergedInto.maxX = Math.max(mergedInto.maxX, c.maxX);
      mergedInto.maxY = Math.max(mergedInto.maxY, c.maxY);
      mergedInto.area += c.area;
      (mergedInto.merged || (mergedInto.merged = [])).push(c.label);
    } else {
      chosen.push({ ...c, merged: [c.label] });
    }
    why.kept++;
    if (chosen.length >= 60) break;
  }

  // Only components that actually became part of this crop may be painted.
  // (Using the global label image would pull in every unrelated blob in the box.)
  const selectedLabels = new Uint8Array(nextLabel + 1);
  for (const c of chosen) selectedLabels[c.label] = 1;
  for (const c of chosen) {
    if (c.merged) for (const l2 of c.merged) selectedLabels[l2] = 1;
  }

  // Crop with padding, alpha-mask everything that is not part of the graphic and
  // (optionally) whiten near-background pixels.
  const whiteThresh = opts.whiten ? (paperIsLight ? 234 : 24) : (paperIsLight ? 250 : 8);
  const graphics = [];
  for (const c of chosen) {
    const pad = 3;
    const x0 = TC.clamp(c.minX - pad, 0, W);
    const y0 = TC.clamp(c.minY - pad, 0, H);
    const x1 = TC.clamp(c.maxX + 1 + pad, 0, W);
    const y1 = TC.clamp(c.maxY + 1 + pad, 0, H);
    const w = x1 - x0, h = y1 - y0;
    if (w < 4 || h < 4) continue;
    const downscale = Math.max(1, Math.max(w, h) / 760);
    const cw = Math.max(2, Math.round(w / downscale)), ch = Math.max(2, Math.round(h / downscale));
    const crop = TC.makeCanvas(cw, ch);
    const cx = TC.ctxOf(crop);
    const out = cx.createImageData(cw, ch);
    const swStep = w / cw, shStep = h / ch;
    // Pull pixels from a padded read buffer with clamping to access neighbours.
    let keptPixels = 0, tried = 0;
    for (let y = 0; y < ch; y++) {
      for (let x = 0; x < cw; x++) {
        const sx = TC.clamp(Math.round(x0 + (x + 0.5) * swStep), 0, W - 1);
        const sy = TC.clamp(Math.round(y0 + (y + 0.5) * shStep), 0, H - 1);
        const si = sy * W + sx;
        const o = (y * cw + x) * 4;
        const p = si * 4;
        tried++;
        let r = data[p], g = data[p + 1], b = data[p + 2];
        const isMember = labels[si] !== 0 && selectedLabels[labels[si]] === 1 && !forbid[si];
        // keep member pixels plus any pixel that belongs to a nearby member (anti-aliasing halo)
        let nearMember = false;
        if (!isMember) {
          for (let dy = -1; dy <= 1 && !nearMember; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
              const nx = sx + dx, ny = sy + dy;
              if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
              if (despeckled[ny * W + nx]) { nearMember = true; break; }
            }
          }
        }
        if (!isMember && nearMember) {
          // Anti-aliasing halo: keep it, but blend toward the local background
          // so retyped text sits on a clean fill instead of a hole.
          const rr = ref ? ref.data[p] : pageBgRef.r;
          const gg = ref ? ref.data[p + 1] : pageBgRef.g;
          const bb = ref ? ref.data[p + 2] : pageBgRef.b;
          out.data[o] = Math.round((r + rr) * 0.5);
          out.data[o + 1] = Math.round((g + gg) * 0.5);
          out.data[o + 2] = Math.round((b + bb) * 0.5);
          out.data[o + 3] = 255;
          keptPixels++;
          continue;
        }
        if (isMember) {
          const lum = TC.lumOf(r, g, b);
          if (paperIsLight) {
            // push paper-ish pixels to pure white so the crop blends into the page
            if (lum >= whiteThresh) { r = 255; g = 255; b = 255; }
          } else if (lum <= whiteThresh) {
            r = 0; g = 0; b = 0;
          }
          out.data[o] = r; out.data[o + 1] = g; out.data[o + 2] = b; out.data[o + 3] = 255;
          keptPixels++;
        } else if (forbid[si]) {
          // Text and rules inside the crop are already painted by Layers 2–3;
          // filling them with the reference colour removes ghost lettering.
          const rr = ref ? ref.data[p] : (paperIsLight ? 255 : 0);
          const gg = ref ? ref.data[p + 1] : (paperIsLight ? 255 : 0);
          const bb = ref ? ref.data[p + 2] : (paperIsLight ? 255 : 0);
          out.data[o] = rr; out.data[o + 1] = gg; out.data[o + 2] = bb; out.data[o + 3] = 255;
        } else {
          out.data[o + 3] = 0;
        }
      }
    }
    const visible = keptPixels / Math.max(1, tried);
    if (visible < 0.03) continue;
    cx.putImageData(out, 0, 0);
    // Trim fully transparent borders to keep the PDF exact.
    const trimmed = trimAlpha(crop);
    if (trimmed.width < 5 || trimmed.height < 5) continue;
    graphics.push({ x: x0, y: y0, w: trimmed.width * downscale, h: trimmed.height * downscale, canvas: trimmed, area: c.area, visible });
  }
  graphics.sort((a, b) => b.area - a.area);
  const limited = graphics.slice(0, 14);
  window.__gfxDebug = { comps: comps.length, why, top: comps.slice(0,6).map(c=>[c.minX,c.minY,c.maxX-c.minX+1,c.maxY-c.minY+1,c.area].join(',')), chosen: chosen.map(c=>[c.minX,c.minY,c.maxX-c.minX+1,c.maxY-c.minY+1].join(',')), made: graphics.length };
  return { graphics: limited, ms: performance.now() - t0, components: comps.length, chosen: chosen.length };
}

/**
 * Graphics hygiene: a crop may still contain straight segments that are already
 * painted as vector rectangles / lines (box borders, arrows). Erase those pixels
 * from the crop so nothing is drawn twice, and drop crops that become empty.
 */
function cleanCropAgainstVectors(gf, pageW, pageH, boxes, refImage) {
  const cw = gf.canvas.width, ch = gf.canvas.height;
  const gw = pageW, gh = pageH;
  const scale = cw / Math.max(1, gf.w);
  const cx = TC.ctxOf(gf.canvas);
  const img = cx.getImageData(0, 0, cw, ch);
  const d = img.data;
  const isInk = (i) => d[i + 3] > 12;
  /* Only *edge-touching* straight rules are duplicates of Layer-2 drawings.
   * (Arrow shafts are also straight but must survive — they are artwork.)
   *
   * Small crops are exempt: a stamp's rectangular frame is four edge-touching
   * straight lines, and wiping them leaves a dotted outline. A duplicate of a
   * page-spanning table rule only appears in crops large enough to span it. */
  const frameSafe = cw < gw * 0.5 && ch < gh * 0.5;
  let changed = false;
  const wipe = (x, y) => { const i = (y * cw + x) * 4; if (d[i + 3] > 0) { d[i + 3] = 0; changed = true; } };
  let edgeRows = Math.max(2, Math.round(ch * 0.02));
  let edgeCols = Math.max(2, Math.round(cw * 0.02));
  if (frameSafe) { edgeRows = 0; edgeCols = 0; }
  for (let y = 0; y < ch; y++) {
    const nearEdgeY = y < edgeRows * 2 || y >= ch - edgeRows * 2;
    if (!nearEdgeY) continue;
    let run = 0;
    for (let x = 0; x <= cw; x++) {
      const on = x < cw && isInk((y * cw + x) * 4);
      if (on) run++;
      else {
        if (run >= cw * 0.8) for (let k = x - run; k < x; k++) wipe(k, y);
        run = 0;
      }
    }
  }
  for (let x = 0; x < cw; x++) {
    const nearEdgeX = x < edgeCols * 2 || x >= cw - edgeCols * 2;
    if (!nearEdgeX) continue;
    let run = 0;
    for (let y = 0; y <= ch; y++) {
      const on = y < ch && isInk((y * cw + x) * 4);
      if (on) run++;
      else {
        if (run >= ch * 0.8) for (let k = y - run; k < y; k++) wipe(x, k);
        run = 0;
      }
    }
  }
  // Fill every transparent hole with the *reference* colour at that exact spot
  // (page paper or the local colour-region fill) — never a single global guess.
  /* Record what was genuinely artwork before the hole-filling flood below makes
   * every pixel opaque. Colour distance cannot recover this afterwards: artwork
   * is often the same colour as the page behind it (a navy logo ring sits on a
   * navy banner), and only the alpha channel knows the difference. */
  const inkAlpha = new Uint8Array(cw * ch);
  for (let i2 = 0, p2 = 3; i2 < cw * ch; i2++, p2 += 4) inkAlpha[i2] = d[p2];
  gf.inkAlpha = inkAlpha;

  const sxScale = gf.w / cw, syScale = gf.h / ch;
  let bgFill = [255, 255, 255];
  if (!refImage) {
    let bestCov = -1;
    for (const b of boxes) {
      const ix = Math.max(0, Math.min(b.x + b.w, gf.x + gf.w) - Math.max(b.x, gf.x));
      const iy = Math.max(0, Math.min(b.y + b.h, gf.y + gf.h) - Math.max(b.y, gf.y));
      const cov = (ix * iy) / Math.max(1, gf.w * gf.h);
      if (cov > bestCov) { bestCov = cov; bgFill = [Math.round(b.r), Math.round(b.g), Math.round(b.b)]; }
    }
  }
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      const i = (y * cw + x) * 4;
      if (d[i + 3] !== 0) continue;
      if (refImage) {
        const px = TC.clamp(Math.round(gf.x + (x + 0.5) * sxScale), 0, pageW - 1);
        const py = TC.clamp(Math.round(gf.y + (y + 0.5) * syScale), 0, pageH - 1);
        const rp = (py * pageW + px) * 4;
        d[i] = refImage.data[rp]; d[i + 1] = refImage.data[rp + 1]; d[i + 2] = refImage.data[rp + 2];
      } else {
        d[i] = bgFill[0]; d[i + 1] = bgFill[1]; d[i + 2] = bgFill[2];
      }
      d[i + 3] = 255;
    }
  }
  cx.putImageData(img, 0, 0);
  if (!changed) return gf;
  const px = cx.getImageData(0, 0, cw, ch).data;
  let ink = 0;
  for (let i = 0; i < px.length; i += 4) {
    if (Math.abs(px[i] - bgFill[0]) + Math.abs(px[i + 1] - bgFill[1]) + Math.abs(px[i + 2] - bgFill[2]) > 40) ink++;
  }
  if (ink < 40) return null;
  return gf;
}

/**
 * Record each crop's genuine artwork coverage.
 *
 * This must run BEFORE cleanCropAgainstVectors, which erases duplicate rules and
 * then floods every transparent pixel with the page colour. By that point the
 * canvas is fully opaque and the only evidence of what was artwork is gone.
 * The alpha channel captured here is authoritative: artwork is often the same
 * colour as the page behind it (the logo's navy ring sits on a navy banner), so
 * colour distance can never recover it.
 */
function snapshotCropAlpha(gfx) {
  for (const gf of gfx) {
    const c = gf.canvas;
    const cw = c.width, ch = c.height;
    const d = TC.ctxOf(c).getImageData(0, 0, cw, ch).data;
    const a = new Uint8Array(cw * ch);
    for (let i = 0, p = 3; i < cw * ch; i++, p += 4) a[i] = d[p];
    gf.inkAlpha = a;
  }
}

/**
 * Restore the crop's transparency.
 *
 * The crop pipeline floods every transparent pixel with the page/reference
 * colour and sets alpha to 255, so by this point the canvas is fully opaque and
 * the artwork's original alpha is gone. Recomputing it from colour distance to
 * the local background is required for two things: the tracer needs to know
 * which pixels are ink, and rotated-text recovery needs to see the glyph shapes.
 */
function restoreCropAlpha(gf) {
  const c = gf.canvas;
  const cw = c.width, ch = c.height;
  if (!gf.inkAlpha || gf.inkAlpha.length !== cw * ch) return gf;
  const cx = TC.ctxOf(c);
  const img = cx.getImageData(0, 0, cw, ch);
  const d = img.data;
  // Restore the artwork's own coverage. Flood-filled background pixels become
  // transparent again; genuine ink — including ink the same colour as the page
  // behind it — keeps its opacity, so a navy ring on a navy banner survives.
  for (let i = 0, p = 3; i < cw * ch; i++, p += 4) d[p] = gf.inkAlpha[i];
  cx.putImageData(img, 0, 0);

  let inkPx = 0;
  for (let i = 3; i < d.length; i += 4 * 7) if (d[i] >= 40) inkPx++;
  if (inkPx < 6) return null;
  return gf;
}

/** Trim transparent margins from an RGBA canvas. */
function trimAlpha(canvas) {
  const w = canvas.width, h = canvas.height;
  const data = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, w, h).data;
  let minX = w, minY = h, maxX = -1, maxY = -1;
  for (let y = 0; y < h; y++) {
    const b = y * w;
    for (let x = 0; x < w; x++) {
      if (data[(b + x) * 4 + 3] > 12) {
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return canvas;
  const outW = maxX - minX + 1, outH = maxY - minY + 1;
  if (outW === w && outH === h) return canvas;
  const c = TC.makeCanvas(outW, outH);
  TC.ctxOf(c).drawImage(canvas, minX, minY, outW, outH, 0, 0, outW, outH);
  return c;
}

  // --- exported onto TC ---
  TC.cleanCropAgainstVectors = cleanCropAgainstVectors;
  TC.detectGraphics = detectGraphics;
  TC.restoreCropAlpha = restoreCropAlpha;
  TC.snapshotCropAlpha = snapshotCropAlpha;
  TC.trimAlpha = trimAlpha;
});
