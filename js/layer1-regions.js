/* ============================================================================
   Layer 1 - colour regions
   Finds shaded fills, banners and table cell backgrounds.
   ========================================================================== */

TC.register(function (TC) {
  'use strict';

function detectColorRegions(imgData, W, H, bg, opts) {
  const data = imgData.data;
  const t0 = performance.now();
  const bs = TC.clamp(Math.round(Math.min(W, H) / 112), 7, 15);
  const gw = Math.ceil(W / bs), gh = Math.ceil(H / bs);
  const n = gw * gh;
  const flat = new Uint8Array(n);
  const cR = new Float32Array(n), cG = new Float32Array(n), cB = new Float32Array(n);
  const bgLum = TC.lumOf(bg.r, bg.g, bg.b);
  const noise = opts.noise || 0;

  for (let gy = 0; gy < gh; gy++) {
    const y0 = gy * bs, y1 = Math.min(H, y0 + bs);
    for (let gx = 0; gx < gw; gx++) {
      const x0 = gx * bs, x1 = Math.min(W, x0 + bs);
      let sr = 0, sg = 0, sb = 0, count = 0;
      // first pass: mean
      for (let y = y0; y < y1; y++) {
        let p = (y * W + x0) * 4;
        for (let x = x0; x < x1; x++, p += 4) { sr += data[p]; sg += data[p + 1]; sb += data[p + 2]; count++; }
      }
      if (!count) continue;
      const mr = sr / count, mg = sg / count, mb = sb / count;
      // second pass: inliers close to the mean + mean of inliers
      let ir = 0, ig = 0, ib = 0, inl = 0;
      for (let y = y0; y < y1; y++) {
        let p = (y * W + x0) * 4;
        for (let x = x0; x < x1; x++, p += 4) {
          const d = TC.colorDist2(data[p], data[p + 1], data[p + 2], mr, mg, mb);
          if (d < 30 * 30) { ir += data[p]; ig += data[p + 1]; ib += data[p + 2]; inl++; }
        }
      }
      const idx = gy * gw + gx;
      if (inl / count >= 0.6) {
        cR[idx] = ir / inl; cG[idx] = ig / inl; cB[idx] = ib / inl;
        flat[idx] = 1;
      }
    }
  }

  // Union-find over flat blocks with similar fill colours
  const parent = new Int32Array(n).fill(-1);
  const find = (a) => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };
  const union = (a, b) => {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent[rb] = ra;
  };
  for (let i = 0; i < n; i++) if (flat[i]) parent[i] = i;
  const simThresh = 20;
  for (let gy = 0; gy < gh; gy++) {
    for (let gx = 0; gx < gw; gx++) {
      const i = gy * gw + gx;
      if (!flat[i]) continue;
      if (gx + 1 < gw) {
        const j = i + 1;
        if (flat[j] && TC.colorDist(cR[i], cG[i], cB[i], cR[j], cG[j], cB[j]) < simThresh) union(i, j);
      }
      if (gy + 1 < gh) {
        const j = i + gw;
        if (flat[j] && TC.colorDist(cR[i], cG[i], cB[i], cR[j], cG[j], cB[j]) < simThresh) union(i, j);
      }
    }
  }

  // Collect components
  const comps = new Map();
  for (let i = 0; i < n; i++) {
    if (!flat[i]) continue;
    const r = find(i);
    let c = comps.get(r);
    if (!c) { c = { blocks: 0, r: 0, g: 0, b: 0, x0: 1e9, y0: 1e9, x1: -1e9, y1: -1e9 }; comps.set(r, c); }
    const gy = (i / gw) | 0, gx = i - gy * gw;
    c.blocks++;
    c.r += cR[i]; c.g += cG[i]; c.b += cB[i];
    const px0 = gx * bs, py0 = gy * bs;
    const px1 = Math.min(W, px0 + bs), py1 = Math.min(H, py0 + bs);
    if (px0 < c.x0) c.x0 = px0;
    if (py0 < c.y0) c.y0 = py0;
    if (px1 > c.x1) c.x1 = px1;
    if (py1 > c.y1) c.y1 = py1;
  }

  const boxes = [];
  const rejected = [];
  const pageArea = W * H;
  const minW = Math.max(10, Math.round(W * 0.010));
  const minH = Math.max(5, Math.round(H * 0.004));
  // Pastel fills (#ecfdf5 on #fefefe) differ from the paper by only ~15 units, so
  // the threshold has to be low; genuinely background components are removed by
  // the area/rectangularity gates instead.
  const colorThresh = opts.colorThresh || 12;

  for (const c of comps.values()) {
    const cr = c.r / c.blocks, cg = c.g / c.blocks, cb = c.b / c.blocks;
    if (TC.colorDist(cr, cg, cb, bg.r, bg.g, bg.b) < colorThresh) { rejected.push({ why: 'bgcolor', b: [c.x0, c.y0, c.x1, c.y1], hex: TC.rgbToHex(cr, cg, cb), blocks: c.blocks }); continue; }
    let x0 = c.x0, y0 = c.y0, x1 = c.x1, y1 = c.y1;
    if (x1 - x0 < minW || y1 - y0 < minH) { rejected.push({ why: 'small', b: [x0, y0, x1, y1], hex: TC.rgbToHex(cr, cg, cb), blocks: c.blocks }); continue; }
    // Refine the rectangle at pixel precision against the component colour.
    const padX = bs, padY = bs;
    const sx0 = Math.max(0, x0 - padX), sx1 = Math.min(W, x1 + padX);
    const sy0 = Math.max(0, y0 - padY), sy1 = Math.min(H, y1 + padY);
    const rowCov = new Float32Array(sy1 - sy0);
    const colCov = new Float32Array(sx1 - sx0);
    let match = 0;
    const testR = cr, testG = cg, testB = cb;
    for (let y = sy0; y < sy1; y++) {
      let rc = 0;
      let p = (y * W + sx0) * 4;
      for (let x = sx0; x < sx1; x++, p += 4) {
        if (TC.colorDist2(data[p], data[p + 1], data[p + 2], testR, testG, testB) < 34 * 34) {
          rc++; colCov[x - sx0]++; match++;
        }
      }
      rowCov[y - sy0] = rc / (sx1 - sx0);
    }
    const colCovNorm = new Float32Array(colCov.length);
    for (let i = 0; i < colCov.length; i++) colCovNorm[i] = colCov[i] / (sy1 - sy0);
    const rowOn = (i) => rowCov[i] >= 0.45;
    const colOn = (i) => colCovNorm[i] >= 0.45;
    let ny0 = 0, ny1 = rowCov.length - 1, nx0 = 0, nx1 = colCov.length - 1;
    while (ny0 < rowCov.length && !rowOn(ny0)) ny0++;
    while (ny1 > ny0 && !rowOn(ny1)) ny1--;
    while (nx0 < colCov.length && !colOn(nx0)) nx0++;
    while (nx1 > nx0 && !colOn(nx1)) nx1--;
    y0 = sy0 + ny0; y1 = sy0 + ny1 + 1;
    x0 = sx0 + nx0; x1 = sx0 + nx1 + 1;
    const w = x1 - x0, h = y1 - y0;
    if (w < minW || h < minH) continue;
    const area = w * h;
    if (area > pageArea * 0.9) continue;
    // rectangularity
    let inside = 0;
    for (let y = y0; y < y1; y += 2) {
      let p = (y * W + x0) * 4;
      for (let x = x0; x < x1; x += 2, p += 8) {
        if (TC.colorDist2(data[p], data[p + 1], data[p + 2], testR, testG, testB) < 40 * 40) inside++;
      }
    }
    const samples = Math.ceil(w / 2) * Math.ceil(h / 2);
    const rectangularity = samples ? inside / samples : 0;
    if (rectangularity < 0.58) { rejected.push({ why: 'rect', b: [x0, y0, x1, y1], hex: TC.rgbToHex(cr, cg, cb), rect: rectangularity, blocks: c.blocks }); continue; }
    // sample the rectangle interior (inset) for the true fill colour
    const inset = Math.max(2, Math.round(Math.min(w, h) * 0.06));
    const dom = TC.dominantColor(data, W, x0 + inset, y0 + inset, Math.max(x0 + inset + 1, x1 - inset), Math.max(y0 + inset + 1, y1 - inset), 2);
    boxes.push({
      x: x0, y: y0, w, h,
      r: dom.r, g: dom.g, b: dom.b,
      hex: TC.rgbToHex(dom.r, dom.g, dom.b),
      rect: +rectangularity.toFixed(2),
      area,
    });
  }

  // Stitch same-fill strips split apart by a text row / rule (table bands).
  // A merge is only accepted when the union is still ≥ 55 % the fill colour.
  const isFill = (px, py, r, g, b) => TC.colorDist2(data[px], data[px + 1], data[px + 2], r, g, b) < 42 * 42;
  const unionFillRatio = (nx0, ny0, nx1, ny1, r, g, b) => {
    let hit = 0, tot = 0;
    for (let y = ny0; y < ny1; y += 3) {
      let p = (y * W + nx0) * 4;
      for (let x = nx0; x < nx1; x += 3, p += 12) { tot++; if (isFill(p, 0, r, g, b)) hit++; }
    }
    return tot ? hit / tot : 0;
  };
  // Same-fill regions split into horizontal/vertical bands by their own text.
  // Accept only when the gap between them is *ink* (text/rules), not other content.
  let bandPass = true, bandCount = 0;
  while (bandPass && bandCount++ < 2) {
    bandPass = false;
    outerBand:
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i], b = boxes[j];
        if (TC.colorDist(a.r, a.g, a.b, b.r, b.g, b.b) > 18) continue;
        const ax1 = a.x + a.w, ay1 = a.y + a.h, bx1 = b.x + b.w, by1 = b.y + b.h;
        const ox = Math.min(ax1, bx1) - Math.max(a.x, b.x);
        const oy = Math.min(ay1, by1) - Math.max(a.y, b.y);
        const vGap = Math.max(a.y, b.y) - Math.min(ay1, by1);
        const hGap = Math.max(a.x, b.x) - Math.min(ax1, bx1);
        // Stacked bands: strong horizontal overlap, small vertical gap.
        // The jump is bounded by both heights so it can bridge a text line but
        // never the empty page band between the banner and the table below.
        // Jump bound: never more than ~30 % of the thinner band and never more
        // than 24 px, so a table's row rhythm is not flattened into one block.
        const jump = Math.min(24, Math.max(4, Math.round(Math.min(a.h, b.h) * 0.30)));
        const stacked = ox > Math.min(a.w, b.w) * 0.78 && vGap >= -1 && vGap <= jump;
        // Side-by-side bands: strong vertical overlap, small horizontal gap.
        const side = oy > Math.min(a.h, b.h) * 0.78 && hGap >= -1 && hGap <= jump;
        if (!stacked && !side) continue;
        // The gap must contain ink (text sat between the bands) and little fill.
        const gapIsTextual = () => {
          let ink = 0, tot = 0;
          if (stacked) {
            const gy0 = Math.min(ay1, by1), gy1 = Math.max(a.y, b.y);
            const gx0 = Math.max(a.x, b.x), gx1 = Math.min(ax1, bx1);
            for (let y = gy0; y < gy1; y++) {
              let p = (y * W + gx0) * 4;
              for (let x = gx0; x < gx1; x++, p += 4) { tot++; if (!isFill(p, 0, a.r, a.g, a.b)) ink++; }
            }
          } else {
            const gx0 = Math.min(ax1, bx1), gx1 = Math.max(a.x, b.x);
            const gy0 = Math.max(a.y, b.y), gy1 = Math.min(ay1, by1);
            for (let y = gy0; y < gy1; y++) {
              let p = (y * W + gx0) * 4;
              for (let x = gx0; x < gx1; x++, p += 4) { tot++; if (!isFill(p, 0, a.r, a.g, a.b)) ink++; }
            }
          }
          return tot === 0 ? false : ink / tot >= 0.05;
        };
        if (!gapIsTextual()) continue;
        // A straight rule inside the gap means a real boundary, not wrapping text.
        {
          let ruleRow = 0;
          if (stacked) {
            const gx0 = Math.max(a.x, b.x) + 4, gx1 = Math.min(ax1, bx1) - 4;
            for (let y = Math.min(ay1, by1); y < Math.max(a.y, b.y); y++) {
              if (gx1 <= gx0) break;
              let dark = 0, tot = 0;
              let p = (y * W + gx0) * 4;
              for (let x = gx0; x < gx1; x++, p += 4) {
                tot++;
                if (TC.lumOf(data[p], data[p + 1], data[p + 2]) < 190) dark++;
              }
              if (tot && dark / tot > 0.85) { ruleRow = 1; break; }
            }
          }
          if (ruleRow) continue;
        }
        const nx0 = Math.min(a.x, b.x), ny0 = Math.min(a.y, b.y);
        const nx1 = Math.max(ax1, bx1), ny1 = Math.max(ay1, by1);
        if (unionFillRatio(nx0, ny0, nx1, ny1, a.r, a.g, a.b) < 0.55) continue;
        boxes[i] = { x: nx0, y: ny0, w: nx1 - nx0, h: ny1 - ny0, r: a.r, g: a.g, b: a.b, hex: a.hex, rect: 1, area: (nx1 - nx0) * (ny1 - ny0) };
        boxes.splice(j, 1);
        bandPass = true;
        break outerBand;
      }
    }
  }

  let changed = true, pass = 0;
  while (changed && pass++ < 3) {
    changed = false;
    outer:
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i], b = boxes[j];
        if (TC.colorDist(a.r, a.g, a.b, b.r, b.g, b.b) > 18) continue;
        const ax1 = a.x + a.w, ay1 = a.y + a.h, bx1 = b.x + b.w, by1 = b.y + b.h;
        // Only merge when one strip is *thin* (a sliver) — real regions stay separate.
        const aThin = a.h <= 26 || a.w <= 26;
        const bThin = b.h <= 26 || b.w <= 26;
        if (!aThin && !bThin) continue;
        const ox = Math.min(ax1, bx1) - Math.max(a.x, b.x);
        const oy = Math.min(ay1, by1) - Math.max(a.y, b.y);
        const vGap = Math.max(a.y, b.y) - Math.min(ay1, by1);
        const hGap = Math.max(a.x, b.x) - Math.min(ax1, bx1);
        const canV = ox > Math.min(a.w, b.w) * 0.8 && vGap >= -1 && vGap <= 3;
        const canH = oy > Math.min(a.h, b.h) * 0.8 && hGap >= -1 && hGap <= 3;
        if (!canV && !canH) continue;
        const nx0 = Math.min(a.x, b.x), ny0 = Math.min(a.y, b.y);
        const nx1 = Math.max(ax1, bx1), ny1 = Math.max(ay1, by1);
        const minDimNow = Math.min(a.w, a.h, b.w, b.h);
        if (Math.min(nx1 - nx0, ny1 - ny0) < minDimNow * 0.55) continue; // never squash a band
        if (unionFillRatio(nx0, ny0, nx1, ny1, a.r, a.g, a.b) < 0.62) continue;
        boxes[i] = { x: nx0, y: ny0, w: nx1 - nx0, h: ny1 - ny0, r: a.r, g: a.g, b: a.b, hex: a.hex, rect: 1, area: (nx1 - nx0) * (ny1 - ny0) };
        boxes.splice(j, 1);
        changed = true;
        break outer;
      }
    }
  }

  /* -------------------------------------------------------------------------
   * Rebuild callout / shaded-cell regions from their FILL mask.
   * The block scan splits a callout into thin bands wherever its own heading or
   * caption interrupts the fill. Close the fill mask by roughly one text line so
   * those bands rejoin, then take connected components: the result is one tight
   * rectangle per real fill, with borders and glyphs excluded by construction.
   * ---------------------------------------------------------------------- */
  const rebuilt = [];
  // One seed per block: the same fill occurs in several places (a banner and a
  // table header share the brand colour), and each must be rebuilt separately.
  // Blocks whose fill is already covered by a rebuilt region are skipped below.
  const seeds = boxes.slice();
  const dilate1 = (inp, outp, w, h, r, horiz) => {
    for (let y = 0; y < h; y++) {
      const base = y * w;
      for (let x = 0; x < w; x++) {
        let on = 0;
        for (let k = -r; k <= r && !on; k++) {
          const nx = horiz ? x + k : x, ny = horiz ? y : y + k;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          if (inp[ny * w + nx]) on = 1;
        }
        outp[base + x] = on;
      }
    }
  };
  for (const rawSeed of seeds) {
    const seed = rawSeed;
    // A block already covered by a bigger, differently-coloured fill is a
    // mis-sampled edge fragment, not a region of its own.
    const skippedBy = rebuilt.find((k) => {
      if (TC.colorDist(k.r, k.g, k.b, seed.r, seed.g, seed.b) < 22) return false;
      const cx = seed.x + seed.w / 2, cy = seed.y + seed.h / 2;
      return cx >= k.x && cx <= k.x + k.w && cy >= k.y && cy <= k.y + k.h;
    });
    if (skippedBy) continue;
    // Radius must bridge this fill's text bands but not the gap to a neighbour
    // callout: measure the vertical fill/hole rhythm inside the seed's span.
    // Default to one text-line radius. Growing it with the seed height is wrong:
    // a tall block's "bands" are usually separate blocks stacked on the page.
    let rad = TC.clamp(Math.round(seed.h * 0.12), 5, 12);
    {
      const sx0 = TC.clamp(seed.x + 2, 0, W - 1), sx1 = TC.clamp(seed.x + seed.w - 2, sx0 + 1, W);
      const col = [];
      for (let y = TC.clamp(seed.y - 60, 0, H - 1); y < TC.clamp(seed.y + seed.h + 60, 0, H); y++) {
        let hit = 0, tot = 0;
        for (let x = sx0; x < sx1; x += 2) {
          const p = (y * W + x) * 4;
          tot++;
          if (TC.colorDist2(data[p], data[p + 1], data[p + 2], seed.r, seed.g, seed.b) < 34 * 34) hit++;
        }
        col.push(tot ? hit / tot : 0);
      }
      // longest run of non-fill rows fully inside a stretch of fill on both sides
      let best = 0, run = 0, seenFill = false;
      for (let i = 0; i < col.length; i++) {
        if (col[i] >= 0.90) { if (run > 0 && seenFill) best = Math.max(best, run); run = 0; seenFill = true; }
        else if (col[i] <= 0.55) { run++; }
      }
      if (best > 0) rad = TC.clamp(Math.ceil(best / 2) + 2, 4, 13);
      // A radius larger than ~a third of the seed can only come from the gap to a
      // neighbouring block, never from text inside this one.
      rad = Math.min(rad, Math.max(5, Math.ceil(seed.h / 3)));
    }
    const bx0 = TC.clamp(seed.x - rad - 4, 0, W), by0 = TC.clamp(seed.y - rad - 4, 0, H);
    const bx1 = TC.clamp(seed.x + seed.w + rad + 4, 0, W), by1 = TC.clamp(seed.y + seed.h + rad + 4, 0, H);
    const w = bx1 - bx0, h = by1 - by0;
    if (w < 8 || h < 8) continue;
    const src = new Uint8Array(w * h);
    let cnt = 0;
    for (let y = 0; y < h; y++) {
      let p = ((by0 + y) * W + bx0) * 4;
      for (let x = 0; x < w; x++, p += 4) {
        if (TC.colorDist2(data[p], data[p + 1], data[p + 2], seed.r, seed.g, seed.b) < 40 * 40) { src[y * w + x] = 1; cnt++; }
      }
    }
    if (cnt < 40) continue;
    // Binary closing repeated until the seed's component stops growing. A single
    // pass cannot bridge a two-line caption, and a bigger radius would bridge the
    // gap to a neighbouring callout; iterating closes only *this* callout.
    let closed = src;
    for (let iter = 0; iter < 6; iter++) {
      const d1 = new Uint8Array(w * h), d2 = new Uint8Array(w * h);
      dilate1(closed, d1, w, h, rad, true); dilate1(d1, d2, w, h, rad, false);
      const inv = new Uint8Array(w * h), e1 = new Uint8Array(w * h), e2 = new Uint8Array(w * h);
      for (let i = 0; i < w * h; i++) inv[i] = d2[i] ? 0 : 1;
      dilate1(inv, e1, w, h, rad, true); dilate1(e1, e2, w, h, rad, false);
      const next = new Uint8Array(w * h);
      for (let i = 0; i < w * h; i++) next[i] = e2[i] ? 0 : 1;
      let grew = false;
      for (let i = 0; i < w * h; i++) if (next[i] !== closed[i]) { grew = true; break; }
      closed = next;
      if (!grew) break;
    }
    // connected components of the closed mask
    const labs = new Int32Array(w * h);
    const stack = new Int32Array(w * h);
    let nl = 0;
    for (let i = 0; i < w * h; i++) {
      if (!closed[i] || labs[i]) continue;
      nl++;
      let sp = 0; stack[sp++] = i; labs[i] = nl;
      let minX = w, minY = h, maxX = 0, maxY = 0, area = 0;
      while (sp > 0) {
        const q = stack[--sp];
        const qy = (q / w) | 0, qx = q - qy * w;
        area++;
        if (qx < minX) minX = qx; if (qx > maxX) maxX = qx;
        if (qy < minY) minY = qy; if (qy > maxY) maxY = qy;
        for (let dy = -1; dy <= 1; dy++) {
          const ny = qy + dy; if (ny < 0 || ny >= h) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const nx = qx + dx; if (nx < 0 || nx >= w) continue;
            const ni = ny * w + nx;
            if (closed[ni] && !labs[ni]) { labs[ni] = nl; stack[sp++] = ni; }
          }
        }
      }
      if (area < 120) continue;
      const rw = maxX - minX + 1, rh = maxY - minY + 1;
      if (rw < minW || rh < minH) continue;
      if (rw * rh > W * H * 0.6) continue;
      // Verify the *actual* fill inside this rectangle: a component grown from a
      // neighbouring colour must not be re-painted with this seed's colour.
      const rx0 = bx0 + minX, ry0 = by0 + minY;
      const dom = TC.dominantColor(data, W, rx0, ry0, rx0 + rw, ry0 + rh, 3);
      const domDist = TC.colorDist(dom.r, dom.g, dom.b, seed.r, seed.g, seed.b);
      const domHex0 = TC.rgbToHex(dom.r, dom.g, dom.b);
      const isPaper = TC.colorDist(dom.r, dom.g, dom.b, bg.r, bg.g, bg.b) < 12;
      const thinBand = rh <= Math.max(18, seed.h * 0.75);
      if (domDist > 26 && !(thinBand && isPaper)) continue;
      const ownFill = domDist <= 26;
            // Tighten to the actual fill: the closed mask is dilated by `rad`, so a
      // component can overrun its band into the neighbouring row.
      let fx0 = rx0, fx1 = rx0 + rw, fy0 = ry0, fy1 = ry0 + rh;
      {
        const rowHit = (y) => {
          let hit = 0, tot = 0;
          for (let x = rx0; x < rx0 + rw; x += 2) {
            const p = (y * W + x) * 4; tot++;
            if (TC.colorDist2(data[p], data[p + 1], data[p + 2], seed.r, seed.g, seed.b) < 34 * 34) hit++;
          }
          return tot ? hit / tot : 0;
        };
        const colHit = (x) => {
          let hit = 0, tot = 0;
          for (let y = ry0; y < ry0 + rh; y += 2) {
            const p = (y * W + x) * 4; tot++;
            if (TC.colorDist2(data[p], data[p + 1], data[p + 2], seed.r, seed.g, seed.b) < 34 * 34) hit++;
          }
          return tot ? hit / tot : 0;
        };
        while (fy0 < fy1 - 4 && rowHit(fy0) < 0.5) fy0++;
        while (fy1 > fy0 + 4 && rowHit(fy1 - 1) < 0.5) fy1--;
        while (fx0 < fx1 - 4 && colHit(fx0) < 0.5) fx0++;
        while (fx1 > fx0 + 4 && colHit(fx1 - 1) < 0.5) fx1--;
      }
      const r = { x: fx0, y: fy0, w: fx1 - fx0, h: fy1 - fy0,
        r: ownFill ? dom.r : seed.r, g: ownFill ? dom.g : seed.g, b: ownFill ? dom.b : seed.b,
        hex: ownFill ? domHex0 : seed.hex,
        rect: 1, area: (fx1 - fx0) * (fy1 - fy0), thin: !ownFill };
      // same-fill components that only just touch are one region (a header band
      // split by a cell divider); distant bands stay separate.
      let merged = false;
      for (const k of rebuilt) {
        if (TC.colorDist(k.r, k.g, k.b, r.r, r.g, r.b) > 22) continue;
        // Two pieces of one region must be *adjacent* (≤6 px apart) along the
        // axis where they are split, and overlap along the other axis. Overlap
        // alone is not enough — a header band overlaps the banner in x.
        const ix = Math.min(k.x + k.w, r.x + r.w) - Math.max(k.x, r.x);
        const iy = Math.min(k.y + k.h, r.y + r.h) - Math.max(k.y, r.y);
        const gapX = Math.max(k.x, r.x) - Math.min(k.x + k.w, r.x + r.w);
        const gapY = Math.max(k.y, r.y) - Math.min(k.y + k.h, r.y + r.h);
        const vertSplit = ix > Math.min(k.w, r.w) * 0.6 && gapY >= -1 && gapY <= 6;
        const horzSplit = iy > Math.min(k.h, r.h) * 0.6 && gapX >= -1 && gapX <= 6;
        if (vertSplit || horzSplit) {
          const nx0 = Math.min(k.x, r.x), ny0 = Math.min(k.y, r.y);
          const nx1 = Math.max(k.x + k.w, r.x + r.w), ny1 = Math.max(k.y + k.h, r.y + r.h);
          k.x = nx0; k.y = ny0; k.w = nx1 - nx0; k.h = ny1 - ny0; k.area = k.w * k.h;
          merged = true; break;
        }
      }
      if (!merged) {
        if (r.thin) {
          // A neutral separator band is only meaningful if a real fill of the
          // seed colour touches it.
          const touch = rebuilt.some((k) => TC.colorDist(k.r, k.g, k.b, seed.r, seed.g, seed.b) < 22 &&
            (Math.abs((k.y + k.h) - r.y) <= 3 || Math.abs(r.y + r.h - k.y) <= 3));
          if (!touch) continue;
        }
        rebuilt.push(r);
      }
    }
  }
  // Rejoin a callout that was rebuilt as a band plus a body: same fill, same
  // column, and only a text line apart. Table rows keep a wider rule gap and
  // their heights differ, so they are left alone.
  {
    let more = true, guard = 0;
    while (more && guard++ < 40) {
      more = false;
      outerJoin:
      for (let i = 0; i < rebuilt.length; i++) {
        for (let j = i + 1; j < rebuilt.length; j++) {
          const a = rebuilt[i], c = rebuilt[j];
          if (TC.colorDist(a.r, a.g, a.b, c.r, c.g, c.b) > 18) continue;
          if (Math.abs(a.x - c.x) > 6) continue;
          const wRatio = Math.min(a.w, c.w) / Math.max(1, Math.max(a.w, c.w));
          if (wRatio < 0.92) continue;
          const gap = Math.max(a.y, c.y) - Math.min(a.y + a.h, c.y + c.h);
          if (gap < -2 || gap > 30) continue;
          const nx0 = Math.min(a.x, c.x), ny0 = Math.min(a.y, c.y);
          const nx1 = Math.max(a.x + a.w, c.x + c.w), ny1 = Math.max(a.y + a.h, c.y + c.h);
          // the union must stay mostly this fill (the text line is a small hole)
          let hit = 0, tot = 0;
          for (let y = ny0; y < ny1; y += 3) {
            let p = (y * W + nx0) * 4;
            for (let x = nx0; x < nx1; x += 3, p += 12) { tot++; if (TC.colorDist2(data[p], data[p + 1], data[p + 2], a.r, a.g, a.b) < 44 * 44) hit++; }
          }
          if (!tot || hit / tot < 0.66) continue;
          // A joined shape must be plausibly one block: reject pairs whose heights
          // differ by more than 1.8× (header band vs data row).
          const hRatio = Math.min(a.h, c.h) / Math.max(1, Math.max(a.h, c.h));
          if (hRatio < 0.55) continue;
          rebuilt[i] = { ...a, x: nx0, y: ny0, w: nx1 - nx0, h: ny1 - ny0, area: (nx1 - nx0) * (ny1 - ny0) };
          rebuilt.splice(j, 1);
          more = true;
          break outerJoin;
        }
      }
    }
  }
  if (rebuilt.length) {
    boxes.length = 0;
    for (const r of rebuilt.sort((a, b2) => b2.area - a.area)) boxes.push(r);
  }

  // Drop off-page noise and duplicate/nested boxes (keep the bigger, flat-fill shape).
  boxes.sort((a, b) => b.area - a.area);
  const kept = [];
  for (const b of boxes) {
    let duplicate = false;
    for (const k of kept) {
      const ix = Math.max(0, Math.min(b.x + b.w, k.x + k.w) - Math.max(b.x, k.x));
      const iy = Math.max(0, Math.min(b.y + b.h, k.y + k.h) - Math.max(b.y, k.y));
      const inter = ix * iy;
      if (inter / Math.min(b.area, k.area) > 0.86) { duplicate = true; break; }
    }
    if (!duplicate) kept.push(b);
    if (kept.length >= 220) break;
  }
  // Resolve residual overlaps by subtracting the overlap from the smaller box.
  const separated = [];
  for (const b of kept) {
    let cur = { ...b };
    for (const k of separated) {
      const ix0 = Math.max(cur.x, k.x), ix1 = Math.min(cur.x + cur.w, k.x + k.w);
      const iy0 = Math.max(cur.y, k.y), iy1 = Math.min(cur.y + cur.h, k.y + k.h);
      if (ix1 - ix0 <= 2 || iy1 - iy0 <= 2) continue;
      // trim vertically when the horizontal overlap dominates, else horizontally
      // Remove only the intersecting strip when it leaves a usable rectangle.
      const fracX = (ix1 - ix0) / cur.w, fracY = (iy1 - iy0) / cur.h;
      let next = null;
      if (fracY <= fracX && iy0 - cur.y >= (b.y + b.h) - iy1) next = { x: cur.x, y: cur.y, w: cur.w, h: iy0 - cur.y };
      else if (fracY <= fracX) next = { x: cur.x, y: iy1, w: cur.w, h: (b.y + b.h) - iy1 };
      else if (ix0 - cur.x >= (b.x + b.w) - ix1) next = { x: cur.x, y: cur.y, w: ix0 - cur.x, h: cur.h };
      else next = { x: ix1, y: cur.y, w: (b.x + b.w) - ix1, h: cur.h };
      if (next && next.w >= cur.w * 0.55 && next.h >= cur.h * 0.55) cur = { ...cur, ...next };
    }
    if (cur.w >= 6 && cur.h >= 5) separated.push(cur);
  }
  const ms = performance.now() - t0;
  window.__lastRegionDebug = rejected;
  return { boxes: separated, ms, blocks: bs };
}

/** Snap colour-box edges onto nearby detected lines for crisp alignment. */
function snapBoxesToLines(boxes, lines, tol) {
  const hs = lines.filter((l) => l.orient === 'h');
  const vs = lines.filter((l) => l.orient === 'v');
  for (const b of boxes) {
    let bestD = tol + 1, bestY = null;
    for (const l of hs) {
      const d = Math.abs(l.y1 - b.y);
      if (d < bestD) { bestD = d; bestY = l.y1; }
    }
    if (bestY !== null && bestD <= tol) { const d = b.y - bestY; b.y = bestY; b.h = Math.max(4, b.h + d); }
    bestD = tol + 1; bestY = null;
    for (const l of hs) {
      const d = Math.abs(l.y1 - (b.y + b.h));
      if (d < bestD) { bestD = d; bestY = l.y1; }
    }
    if (bestY !== null && bestD <= tol) b.h = Math.max(4, bestY - b.y);
    let bestX = null; bestD = tol + 1;
    for (const l of vs) {
      const d = Math.abs(l.x1 - b.x);
      if (d < bestD) { bestD = d; bestX = l.x1; }
    }
    if (bestX !== null && bestD <= tol) { const d = b.x - bestX; b.x = bestX; b.w = Math.max(4, b.w + d); }
    bestX = null; bestD = tol + 1;
    for (const l of vs) {
      const d = Math.abs(l.x1 - (b.x + b.w));
      if (d < bestD) { bestD = d; bestX = l.x1; }
    }
    if (bestX !== null && bestD <= tol) b.w = Math.max(4, bestX - b.x);
  }
  return boxes;
}

  // --- exported onto TC ---
  TC.detectColorRegions = detectColorRegions;
  TC.snapBoxesToLines = snapBoxesToLines;
});
