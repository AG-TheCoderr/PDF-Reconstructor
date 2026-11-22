/* ============================================================================
   PDF assembly
   Builds the output PDF: fills, traced artwork, rules and typed text.
   ========================================================================== */

TC.register(function (TC) {
  'use strict';

const PAGE_SIZES = { a4: [595.28, 841.89], letter: [612, 792] };

/**
 * Page geometry. Source pixels are treated as 96-dpi CSS pixels, so a page of
 * W×H px maps to W*76/96 × H*76/96 pt (≈ html2canvas “exact” convention).
 */
function computePageGeometry(imgW, imgH, mode) {
  if (mode === 'exact') {
    const s = 76 / 96;
    return { pageW: imgW * s, pageH: imgH * s, s, ox: 0, oy: 0 };
  }
  let [pw, ph] = PAGE_SIZES[mode] || PAGE_SIZES.a4;
  if (imgW > imgH) [pw, ph] = [ph, pw];
  const s = Math.min(pw / imgW, ph / imgH);
  return { pageW: pw, pageH: ph, s, ox: (pw - imgW * s) / 2, oy: (ph - imgH * s) / 2 };
}
const pxToPtX = (g, x) => g.ox + x * g.s;
const pxToPtY = (g, y) => g.pageH - (g.oy + y * g.s);

function pdfColor([r, g, b]) {
  const { rgb } = window.PDFLib;
  return rgb(TC.clamp(r / 255, 0, 1), TC.clamp(g / 255, 0, 1), TC.clamp(b / 255, 0, 1));
}

const round4 = (v) => Math.round(v * 1e4) / 1e4;

/**
 * Draw a single string with an exact baseline anchor, rotation and horizontal
 * scale (Tz). Raw operators are required because pdf-lib's drawText() cannot
 * express per-word horizontal scaling.
 */
function drawTextExact(page, font, fontKey, opts) {
  const { PDFOperator, PDFOperatorNames: N, PDFNumber } = window.PDFLib;
  const { text, x, y, size, rotateDeg = 0, hScale = 1, color } = opts;
  if (!text || !(size > 0.3)) return false;
  let hex;
  try { hex = font.encodeText(text); } catch (e) { return false; }
  const op = (name, ...args) => PDFOperator.of(name, args.map((a) => (typeof a === 'number' ? PDFNumber.of(round4(a)) : a)));
  const rad = (rotateDeg * Math.PI) / 180;
  const cos = Math.cos(rad), sin = Math.sin(rad);
  const ops = [
    op(N.PushGraphicsState),
    op(N.BeginText),
    op(N.NonStrokingColorRgb, color[0], color[1], color[2]),
    op(N.SetFontAndSize, fontKey, size),
  ];
  if (Math.abs(hScale - 1) > 0.004) ops.push(op(N.SetTextHorizontalScaling, hScale * 100));
  ops.push(
    op(N.SetTextMatrix, cos, sin, -sin, cos, x, y),
    op(N.ShowText, hex),
    op(N.EndText),
    op(N.PopGraphicsState),
  );
  page.pushOperators(...ops);
  return true;
}

/** Advance width of `text` at size 1 for the given standard font. */
function naturalWidth(font, text) {
  try { return Math.max(0.001, font.widthOfTextAtSize(text, 1)); } catch (e) { return Math.max(0.001, text.length * 0.5); }
}

const CAPS_RE = /[A-Z0-9]/;
const ASC_RE = /[bdfhkltÄÖÜß]/;
const DESC_RE = /[gjpqyQ@(),;£]/;

/** Estimate the em size (px) that produces a Tesseract word box of this size. */
function estimateFontSizePx(word) {
  const text = word.text || '';
  const hasCap = CAPS_RE.test(text);
  const hasAsc = ASC_RE.test(text);
  const hasDesc = DESC_RE.test(text);
  const h = Math.max(3, word.h);
  // Helvetica at size 1: cap 0.718, x-height 0.523, ascender ≈ 0.73, descender ≈ 0.21
  let pxPerEm;
  if (hasCap) pxPerEm = 0.722;
  else if (hasAsc) pxPerEm = 0.735;
  else pxPerEm = 0.532;
  if (hasDesc) pxPerEm += 0.212;
  let size = h / pxPerEm;
  // Tesseract boxes have a little vertical slack; cross-check with the row height.
  const ra = word.rowAttributes;
  if (ra && ra.rowHeight > 2 && isFinite(ra.rowHeight)) {
    const boxH = word.lineBbox ? Math.max(3, word.lineBbox.y1 - word.lineBbox.y0) : h;
    let rowPx = ra.rowHeight;
    // rowHeight from tesseract is already in image pixels of the OCR raster (≈ page px here)
    if (rowPx > boxH * 1.9) rowPx = boxH;
    const sizeRow = rowPx * 0.93;
    if (Math.abs(sizeRow - size) / size > 0.3) size = size * 0.6 + sizeRow * 0.4;
  }
  return TC.clamp(size, 1.5, 400);
}

/**
 * Final word consolidation. Several OCR passes contribute words (whole page, gap
 * bands, region crops) and they can disagree slightly. Keep one word per spot:
 * prefer the highest confidence, drop fragments produced by clipping a longer
 * word, and drop duplicates.
 */
function consolidateWords(words) {
  if (!words || words.length < 2) return words || [];
  const norm = (t) => t.toLowerCase().replace(/[^a-z0-9]/g, '');
  // 1) sort by confidence so the best reading wins
  const sorted = words.slice().sort((a, b) => (b.conf || 0) - (a.conf || 0));
  const kept = [];
  for (const w of sorted) {
    const nb = w.bbox;
    if (!nb) continue;
    const area = Math.max(1, (nb.x1 - nb.x0) * (nb.y1 - nb.y0));
    const nw = norm(w.text);
    let drop = false;
    for (let i = 0; i < kept.length; i++) {
      const k = kept[i], kb = k.bbox;
      const ix = Math.min(nb.x1, kb.x1) - Math.max(nb.x0, kb.x0);
      const iy = Math.min(nb.y1, kb.y1) - Math.max(nb.y0, kb.y0);
      if (ix <= 0 || iy <= 0) continue;
      const inter = ix * iy;
      const kArea = Math.max(1, (kb.x1 - kb.x0) * (kb.y1 - kb.y0));
      const overlapSelf = inter / area, overlapOther = inter / kArea;
      const kn = norm(k.text);
      const sameText = nw && kn && (nw === kn || nw.includes(kn) || kn.includes(nw));
      // Same spot: nearly identical boxes (or one nested in the other).
      if ((overlapSelf > 0.55 || overlapOther > 0.55) && (sameText || overlapSelf > 0.75 || overlapOther > 0.75)) {
        drop = true; break;
      }
      // A single missing glyph at the edge of a longer word ("consume" / "a").
      if (inter / Math.min(area, kArea) > 0.70) {
        const shorter = area < kArea ? nw : kn;
        const longer = area < kArea ? kn : nw;
        if (shorter.length <= 2 && longer.length >= 4) { drop = true; break; }
      }
    }
    if (!drop) kept.push(w);
  }
  return kept;
}

/**
 * Height of the *ink* produced by one em, depending on which glyph classes a
 * word contains (Helvetica metrics: cap .717, ascender .735, x-height .523,
 * descender .211). Used to convert a tight ink box back into a font size.
 */
function inkHeightPerEm(text) {
  const hasCap = /[A-Z0-9£€TC.$@#%&]/.test(text);
  const hasAsc = /[bdfhklt]/.test(text);
  const hasDesc = /[gjpqyQ(),;]/.test(text);
  let r;
  if (hasCap) r = 0.717;
  else if (hasAsc) r = 0.735;
  else r = 0.523;
  if (hasDesc) r += 0.211;
  return r;
}

/**
 * Font size (px) for a text line: median of per-word estimates taken from the
 * tight ink box, so caps-only lines, x-height words and descenders all agree.
 */
function estimateLineFontSizePx(arr) {
  const sizes = [];
  for (const w of arr) {
    const text = (w.text || '').replace(/[^A-Za-z0-9]/g, '') ? w.text : w.text;
    const h = Math.max(3, w.h);
    const r = inkHeightPerEm(text || 'x');
    if (h <= 4) continue;
    sizes.push(h / r);
  }
  const med = sizes.length ? TC.medianOfNumbers(sizes) : 12;
  // Tesseract boxes are usually ~2–4 % taller than the true ink (anti-aliasing).
  return TC.clamp(med * 0.985, 3, 400);
}

/** Per-text-line ink angle (radians) from the Tesseract baseline. */
function lineAngleDeg(words) {
  const b = words.find((w) => w.baseline && w.baseline.has_baseline !== false && w.baseline.x1 !== undefined)?.baseline;
  if (!b) return 0;
  const dx = b.x1 - b.x0, dy = b.y1 - b.y0;
  if (Math.abs(dx) < 4) return 0;
  const deg = Math.atan2(-dy, dx) * 180 / Math.PI;
  if (!isFinite(deg) || Math.abs(deg) > 12) return 0;
  return deg;
}

/** Re-encode crop canvases as PNG (long side ≤ 900 px, transparent OK). */
function cropToPngDataUrl(canvas) {
  const maxSide = 900;
  if (Math.max(canvas.width, canvas.height) <= maxSide) return canvas.toDataURL('image/png');
  const s = maxSide / Math.max(canvas.width, canvas.height);
  const c = TC.makeCanvas(canvas.width * s, canvas.height * s);
  const x = TC.ctxOf(c);
  x.imageSmoothingQuality = 'high';
  x.drawImage(canvas, 0, 0, c.width, c.height);
  return c.toDataURL('image/png');
}

/**
 * Median colour of the darkest/most saturated pixels inside a word box — the
 * ink core, ignoring anti-aliased edges and the background.
 */
function sampleWordColor(data, W, H, box, bg) {
  const x0 = TC.clamp(Math.floor(box.x), 0, W - 1), y0 = TC.clamp(Math.floor(box.y), 0, H - 1);
  const x1 = TC.clamp(Math.ceil(box.x + box.w), x0 + 1, W), y1 = TC.clamp(Math.ceil(box.y + box.h), y0 + 1, H);
  const px = [];
  const bgLum = TC.lumOf(bg.r, bg.g, bg.b);
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * W + x) * 4;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      const l = TC.lumOf(r, g, b);
      const dist = Math.abs(r - bg.r) + Math.abs(g - bg.g) + Math.abs(b - bg.b);
      if (dist < 60) continue;
      if (bgLum > 128 ? l > bgLum - 30 : l < bgLum + 30) continue;
      px.push([l, r, g, b]);
    }
  }
  if (px.length < 4) return null;
  px.sort((a, b) => a[0] - b[0]);
  // Take the ink core: the darkest (or lightest on a dark page) quartile.
  const slice = bgLum > 128 ? px.slice(0, Math.max(1, Math.floor(px.length * 0.4)))
                            : px.slice(-Math.max(1, Math.floor(px.length * 0.4)));
  let r = 0, g = 0, b = 0;
  for (const p of slice) { r += p[1]; g += p[2]; b += p[3]; }
  return [Math.round(r / slice.length), Math.round(g / slice.length), Math.round(b / slice.length)];
}

/** Rough bold test for a word box: mean stroke ink density relative to its height. */
function isBoxBold(data, W, H, box) {
  const x0 = TC.clamp(Math.floor(box.x), 0, W - 1), y0 = TC.clamp(Math.floor(box.y), 0, H - 1);
  const x1 = TC.clamp(Math.ceil(box.x + box.w), x0 + 1, W), y1 = TC.clamp(Math.ceil(box.y + box.h), y0 + 1, H);
  const h = Math.max(1, y1 - y0);
  let ink = 0, n = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * W + x) * 4;
      const l = TC.lumOf(data[i], data[i + 1], data[i + 2]);
      if (l < 140) ink++;
      n++;
    }
  }
  void H;
  return n > 0 && ink / n > 0.22 + 12 / h;
}

/**
 * Longest-edge angle of the crop's ink, in degrees. A rotated word or badge is
 * a set of strokes lying along one direction; the dominant near-horizontal
 * direction is the skew we need to undo before OCR.
 */
function estimateCropSkew(canvas) {
  const W = canvas.width, H = canvas.height;
  if (W < 14 || H < 10) return 0;
  const d = TC.ctxOf(canvas).getImageData(0, 0, W, H).data;

  // Collect ink points (subsampled — a stamp has plenty).
  const pts = [];
  const step = Math.max(1, Math.round(Math.max(W, H) / 260));
  for (let y = 0; y < H; y += step) {
    for (let x = 0; x < W; x += step) {
      if (d[(y * W + x) * 4 + 3] >= 128) pts.push(x, y);
    }
  }
  const n = pts.length / 2;
  if (n < 24) return 0;

  // Projection-profile sharpness: rotate the ink by theta and bin by y. Text
  // lies along its baseline, so the histogram is sharpest at the true angle.
  const score = (deg) => {
    const t = (deg * Math.PI) / 180;
    const ct = Math.cos(t), st = Math.sin(t);
    const bins = new Map();
    for (let i = 0; i < pts.length; i += 2) {
      const py = Math.round(-pts[i] * st + pts[i + 1] * ct);
      bins.set(py, (bins.get(py) || 0) + 1);
    }
    let sum = 0, sum2 = 0;
    for (const v of bins.values()) { sum += v; sum2 += v * v; }
    return sum2 / Math.max(1, sum);
  };

  let best = 0, bestScore = -Infinity;
  for (let deg = -20; deg <= 20; deg += 0.5) {
    const sc = score(deg);
    if (sc > bestScore) { bestScore = sc; best = deg; }
  }
  // Refine in 0.1° steps around the winner.
  for (let deg = best - 0.6; deg <= best + 0.6; deg += 0.1) {
    const sc = score(deg);
    if (sc > bestScore + 1e-9) { bestScore = sc; best = deg; }
  }
  const at0 = score(0);
  // Only report a skew when it clearly beats "no rotation".
  if (bestScore < at0 * 1.18) return 0;
  if (Math.abs(best) < 1.0 || Math.abs(best) > 22) return 0;
  return Math.round(best * 10) / 10;
}

/** Erase recovered word boxes from a crop's alpha so artwork is not doubled. */
function maskTextInCrop(gf, words) {
  const c = gf.canvas;
  const x = TC.ctxOf(c);
  const sx = c.width / Math.max(1, gf.w);
  const sy = c.height / Math.max(1, gf.h);
  x.save();
  x.globalCompositeOperation = 'destination-out';
  for (const w of words) {
    const lx = (w.x - gf.x) * sx, ly = (w.y - gf.y) * sy;
    x.fillRect(lx - 2, ly - 2, w.w * sx + 4, w.h * sy + 4);
  }
  x.restore();
  // If almost nothing is left, skip tracing entirely.
  const d = x.getImageData(0, 0, c.width, c.height).data;
  let left = 0;
  for (let i = 3; i < d.length; i += 4 * 17) if (d[i] >= 128) left++;
  if (left < 8) gf.emptied = true;
}

/* ---------------------------------------------------------------------------
 * 18b. VECTOR ARTWORK TRACING
 *   Artwork is re-drawn as real filled paths, never pasted as a bitmap: the
 *   brief is a fully typed, fully vector document. Palette-quantise the crop,
 *   trace each ink colour into closed contours, simplify, and emit one filled
 *   path per colour.
 * ------------------------------------------------------------------------- */


/**
 * Trace a binary mask into closed outlines by following the "cracks" between
 * ink and empty pixels on the integer lattice.
 *
 * Each boundary unit segment is oriented so the ink is always on the right
 * (clockwise in a y-down coordinate system). That makes the segment set
 * globally consistent: every lattice vertex has matching in/out degree, so the
 * segments chain into exact closed loops. Outer outlines and interior holes come
 * out with opposite winding, which the even-odd fill rule renders correctly.
 *
 * This is deliberately not a marching-squares triangulation: axis-aligned
 * cracks reproduce rectangles and straight rules exactly after simplification.
 */
function traceMask(mask, W, H) {
  /* Boundary "crack" tracer.
   *
   * Follows the unit steps between ink and empty pixels. Each step is oriented so
   * the ink is on the right, which makes the segment set globally consistent:
   * every lattice vertex has matching in/out degree, so segments chain into exact
   * closed loops. Outer outlines and interior holes come out with opposite
   * winding, which the even-odd fill rule renders correctly.
   *
   * Axis-aligned cracks are deliberate: after simplification they reproduce
   * rectangles and straight rules exactly, with no resampling error.
   */
  const at = (x, y) => (x < 0 || y < 0 || x >= W || y >= H) ? 0 : (mask[y * W + x] ? 1 : 0);

  const startOf = new Map();
  const vkey = (x, y) => y * (W + 2) + x;
  const push = (x0, y0, x1, y1) => {
    const k = vkey(x0, y0);
    let a = startOf.get(k);
    if (!a) { a = []; startOf.set(k, a); }
    a.push([x0, y0, x1, y1]);
  };

  let count = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (!mask[y * W + x]) continue;
      count++;
      if (!at(x, y - 1)) push(x, y, x + 1, y);           // top    ->
      if (!at(x + 1, y)) push(x + 1, y, x + 1, y + 1);   // right  v
      if (!at(x, y + 1)) push(x + 1, y + 1, x, y + 1);   // bottom <-
      if (!at(x - 1, y)) push(x, y + 1, x, y);           // left   ^
    }
  }
  if (!count) return [];

  const all = [];
  for (const arr of startOf.values()) for (const s of arr) all.push(s);

  const used = new Set();
  const segKey = (s) => s[0] + ',' + s[1] + ',' + s[2] + ',' + s[3];
  const loops = [];

  for (let i = 0; i < all.length; i++) {
    const seed = all[i];
    if (used.has(segKey(seed))) continue;
    const loop = [];
    let cur = seed;
    for (let guard = 0; guard <= all.length + 4; guard++) {
      const k = segKey(cur);
      if (used.has(k)) break;
      used.add(k);
      loop.push(cur[0], cur[1]);
      const nxt = startOf.get(vkey(cur[2], cur[3]));
      if (!nxt || !nxt.length) break;
      let found = null;
      for (const cand of nxt) {
        if (!used.has(segKey(cand))) { found = cand; break; }
      }
      if (!found) break;
      cur = found;
      if (cur[0] === seed[0] && cur[1] === seed[1]) break;
    }
    if (loop.length >= 8) loops.push(loop);
  }
  return loops;
}

/**
 * Douglas–Peucker polyline simplification. Keeps glyph corners while cutting
 * the point count enough that a traced page stays small.
 */
function simplifyContour(pts, tol) {
  const n = pts.length / 2;
  if (n < 4) return pts.slice();
  const keep = new Uint8Array(n);
  keep[0] = 1; keep[n - 1] = 1;
  const stack = [[0, n - 1]];
  const t2 = tol * tol;
  while (stack.length) {
    const [a, b] = stack.pop();
    const ax = pts[a * 2], ay = pts[a * 2 + 1];
    const bx = pts[b * 2], by = pts[b * 2 + 1];
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let best = -1, bestD = t2;
    for (let i = a + 1; i < b; i++) {
      const qx = pts[i * 2], qy = pts[i * 2 + 1];
      let d2;
      if (len2 < 1e-12) {
        d2 = (qx - ax) * (qx - ax) + (qy - ay) * (qy - ay);
      } else {
        let t = ((qx - ax) * dx + (qy - ay) * dy) / len2;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const px = ax + t * dx, py = ay + t * dy;
        d2 = (qx - px) * (qx - px) + (qy - py) * (qy - py);
      }
      if (d2 > bestD) { bestD = d2; best = i; }
    }
    if (best > 0) { keep[best] = 1; stack.push([a, best], [best, b]); }
  }
  const res = [];
  for (let i = 0; i < n; i++) if (keep[i]) res.push(pts[i * 2], pts[i * 2 + 1]);
  return res;
}

/** Shoelace area — used for tests and for rejecting sliver rings. */
function contourSignedArea(pts) {
  let a = 0;
  const n = pts.length / 2;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    a += pts[i * 2] * pts[j * 2 + 1] - pts[j * 2] * pts[i * 2 + 1];
  }
  return a / 2;
}

/** Trace + simplify + drop slivers. Returns rings in mask pixel units. */
function contoursToRings(contours, tol, minArea) {
  const rings = [];
  for (const c of contours) {
    const simp = simplifyContour(c, tol);
    if (simp.length < 6) continue;
    if (Math.abs(contourSignedArea(simp)) < minArea) continue;
    rings.push(simp);
  }
  return rings;
}

/**
 * Emit rings as one filled PDF path. `toPt` maps mask pixels to page points.
 * Even-odd fill punches interior holes correctly without reversing winding.
 */
function emitFilledRings(page, rings, toPt, color) {
  if (!rings.length) return 0;
  const { PDFOperator, PDFOperatorNames: N, PDFNumber } = window.PDFLib;
  const op = (name, ...args) => PDFOperator.of(name, args.map((a) => (typeof a === 'number' ? PDFNumber.of(round4(a)) : a)));
  const ops = [op(N.PushGraphicsState), op(N.NonStrokingColorRgb, color[0], color[1], color[2])];
  let emitted = 0;
  for (const ring of rings) {
    const n = ring.length / 2;
    if (n < 3) continue;
    const p0 = toPt(ring[0], ring[1]);
    ops.push(op(N.MoveTo, p0[0], p0[1]));
    for (let i = 1; i < n; i++) {
      const p = toPt(ring[i * 2], ring[i * 2 + 1]);
      ops.push(op(N.LineTo, p[0], p[1]));
    }
    ops.push(op(N.ClosePath));
    emitted++;
  }
  ops.push(op(N.FillEvenOdd), op(N.PopGraphicsState));
  page.pushOperators(...ops);
  return emitted;
}

/** Tight bounding box of the set pixels in a mask. */
function maskBBox(mask, W, H) {
  let x0 = W, y0 = H, x1 = -1, y1 = -1;
  for (let y = 0; y < H; y++) {
    const base = y * W;
    for (let x = 0; x < W; x++) {
      if (mask[base + x]) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) return null;
  return { x0, y0, x1, y1 };
}

/**
 * Vectorise the artwork inside a graphic crop into filled geometric shapes.
 * The crop's dominant opaque colour is the page fill and is skipped; every
 * other ink colour becomes one or more traced paths.
 *
 * Returns { shapes:[{rings,color,count}], ink, covered, palette } in crop px.
 */
function vectoriseCrop(crop) {
  const W = crop.width, H = crop.height;
  if (W < 3 || H < 3) return { shapes: [], ink: 0, covered: 0, palette: [] };
  const ctx = TC.ctxOf(crop);
  const im = ctx.getImageData(0, 0, W, H);
  const d = im.data;
  const total = W * H;

  // Low threshold: restoreCropAlpha gives anti-aliased stroke edges partial
  // alpha, and clipping at 128 would erase thin signature/underline strokes.
  const ink = new Uint8Array(total);
  let inkCount = 0;
  for (let i = 0, p = 3; i < total; i++, p += 4) {
    if (d[p] >= 40) { ink[i] = 1; inkCount++; }
  }
  if (!inkCount) return { shapes: [], ink: 0, covered: 0, palette: [] };

  // Quantise ink colours to a 4-bit-per-channel palette.
  const buckets = new Map();
  for (let i = 0, p = 0; i < total; i++, p += 4) {
    if (!ink[i]) continue;
    const k = ((d[p] >> 4) << 8) | ((d[p + 1] >> 4) << 4) | (d[p + 2] >> 4);
    const e = buckets.get(k);
    if (e) { e.n++; e.r += d[p]; e.g += d[p + 1]; e.b += d[p + 2]; }
    else buckets.set(k, { n: 1, r: d[p], g: d[p + 1], b: d[p + 2] });
  }

  const palette = [...buckets.entries()]
    .map(([k, e]) => ({ k, n: e.n, rgb: [Math.round(e.r / e.n), Math.round(e.g / e.n), Math.round(e.b / e.n)] }))
    .sort((a, b) => b.n - a.n);

  // Merge palette entries that are visually the same ink.
  const groups = [];
  for (const p of palette) {
    let hit = null;
    for (const g of groups) {
      const c = g.rgb;
      if (Math.abs(c[0] - p.rgb[0]) + Math.abs(c[1] - p.rgb[1]) + Math.abs(c[2] - p.rgb[2]) < 42) { hit = g; break; }
    }
    if (hit) {
      const t = hit.n + p.n;
      hit.rgb = [
        Math.round((hit.rgb[0] * hit.n + p.rgb[0] * p.n) / t),
        Math.round((hit.rgb[1] * hit.n + p.rgb[1] * p.n) / t),
        Math.round((hit.rgb[2] * hit.n + p.rgb[2] * p.n) / t),
      ];
      hit.n = t;
      hit.keys.push(p.k);
    } else {
      groups.push({ rgb: p.rgb, n: p.n, keys: [p.k] });
    }
  }
  groups.sort((a, b) => b.n - a.n);

  const tol = Math.max(0.7, Math.min(1.5, Math.max(W, H) / 700));
  const minArea = Math.max(1.5, W * H * 0.00008);
  const MAX_GROUPS = 6;
  const shapes = [];
  let covered = 0;

  // groups[0] is the dominant colour = the page fill already painted underneath.
  for (let gi = 1; gi < groups.length && gi < MAX_GROUPS; gi++) {
    const grp = groups[gi];
    const keySet = new Set(grp.keys);
    const mask = new Uint8Array(total);
    let n = 0;
    for (let i = 0, p = 0; i < total; i++, p += 4) {
      if (!ink[i]) continue;
      const k = ((d[p] >> 4) << 8) | ((d[p + 1] >> 4) << 4) | (d[p + 2] >> 4);
      let hit = keySet.has(k);
      if (!hit) {
        const c = grp.rgb;
        hit = Math.abs(d[p] - c[0]) + Math.abs(d[p + 1] - c[1]) + Math.abs(d[p + 2] - c[2]) < 42;
      }
      if (hit) { mask[i] = 1; n++; }
    }
    if (n < 8) continue;

    const bb = maskBBox(mask, W, H);
    if (!bb) continue;

    let rings;
    if (bb.x1 - bb.x0 <= 1 || bb.y1 - bb.y0 <= 1) {
      // 1px rule or tick: a traced rectangle would be degenerate — emit it flat.
      rings = [[bb.x0, bb.y0, bb.x1 + 1, bb.y0, bb.x1 + 1, bb.y1 + 1, bb.x0, bb.y1 + 1]];
    } else {
      rings = contoursToRings(traceMask(mask, W, H), tol, minArea);
    }
    if (!rings.length) continue;

    shapes.push({ rings, color: grp.rgb, count: n });
    covered += n;
  }

  return { shapes, ink: inkCount, covered, palette: groups.slice(0, MAX_GROUPS).map((g) => g.rgb) };
}


/**
 * Assemble the final PDF from every page's reconstructed layers.
 * @returns {Promise<{bytes:Uint8Array, stats:object}>}
 */
async function assemblePdf(pages, options) {
  const { PDFDocument, StandardFonts } = window.PDFLib;
  if (!PDFDocument) throw new Error('pdf-lib failed to load.');
  const doc = await PDFDocument.create();
  doc.setTitle('Reconstructed document — Typecraft');
  doc.setProducer('Typecraft (pdf-lib + tesseract.js)');
  doc.setCreator('Typecraft — client-side visual document reconstructor');

  const helv = await doc.embedFont(StandardFonts.Helvetica);
  const helvB = await doc.embedFont(StandardFonts.HelveticaBold);
  const widths = {
    regular: (t) => naturalWidth(helv, t),
    bold: (t) => naturalWidth(helvB, t),
  };

  const stats = { words: 0, boxes: 0, lines: 0, graphics: 0, vectorPaths: 0, graphicsFlattened: 0, chars: 0, droppedText: 0 };
  const usedGlyphs = new Set();

  for (let pi = 0; pi < pages.length; pi++) {
    const pg = pages[pi];
    const L = pg.layers;
    if (!L) continue;
    const imgW = pg.canvas.width, imgH = pg.canvas.height;
    const g = computePageGeometry(imgW, imgH, options.pageSize);
    const page = doc.addPage([g.pageW, g.pageH]);
    const fontKeys = new Map();
    const fontKeyFor = (font) => {
      if (fontKeys.has(font.name)) return fontKeys.get(font.name);
      const key = page.node.newFontDictionary(font.name, font.ref);
      fontKeys.set(font.name, key);
      return key;
    };

    /* 1 — page background ------------------------------------------------ */
    page.drawRectangle({ x: 0, y: 0, width: g.pageW, height: g.pageH, color: pdfColor([L.bg.r, L.bg.g, L.bg.b]) });

    /* 2 — colour regions (banners, callouts, cell fills) ------------------ */
    for (const b of L.boxes) {
      page.drawRectangle({
        x: pxToPtX(g, b.x), y: pxToPtY(g, b.y + b.h),
        width: Math.max(0.1, b.w * g.s), height: Math.max(0.1, b.h * g.s),
        color: pdfColor([b.r, b.g, b.b]),
      });
      stats.boxes++;
    }

    /* 3 — artwork re-drawn as vectors (never pasted as a bitmap) ---------- */
    for (const gf of L.graphics) {
      try {
        const traced = gf.vector;
        if (!traced || !traced.shapes || !traced.shapes.length) {
          // Nothing traceable (fully flat crop): the fill is already painted.
          stats.graphicsFlattened++;
          continue;
        }
        // Crop-local pixel -> page points.
        const sx = (gf.w * g.s) / Math.max(1, gf.canvas.width);
        const sy = (gf.h * g.s) / Math.max(1, gf.canvas.height);
        const x0pt = pxToPtX(g, gf.x);
        const y0pt = pxToPtY(g, gf.y + gf.h);
        const toPt = (cx, cy) => [x0pt + cx * sx, y0pt + (gf.canvas.height - cy) * sy];
        let drawn = 0;
        for (const sh of traced.shapes) {
          drawn += emitFilledRings(page, sh.rings, toPt, [
            sh.color[0] / 255, sh.color[1] / 255, sh.color[2] / 255,
          ]);
        }
        stats.vectorPaths += drawn;
        if (drawn) stats.graphics++;
        else stats.graphicsFlattened++;
      } catch (e) {
        console.warn('Artwork vectorisation failed', e);
        stats.graphicsFlattened++;
      }
    }

    /* 4 — structural lines ------------------------------------------------ */
    for (const l of L.lines) {
      const t = Math.max(0.32, l.thickness * g.s);
      const x1 = pxToPtX(g, l.x1), y1 = pxToPtY(g, l.y1);
      const x2 = pxToPtX(g, l.x2), y2 = pxToPtY(g, l.y2);
      page.drawLine({
        start: { x: x1, y: y1 },
        end: { x: x2, y: y2 },
        thickness: t,
        color: pdfColor([l.r, l.g, l.b]),
      });
      stats.lines++;
    }

    /* 5 — typed text ------------------------------------------------------ */
    const linesMap = new Map();
    for (const w of L.words) {
      const lb = w.lineBbox;
      const k = lb ? `${Math.round(lb.x0)},${Math.round(lb.y0)},${Math.round(lb.x1)}` : `solo-${Math.round(w.y)}`;
      let arr = linesMap.get(k);
      if (!arr) { arr = []; linesMap.set(k, arr); }
      arr.push(w);
    }
    for (const arr of linesMap.values()) {
      const angle = lineAngleDeg(arr);
      // One font size per text line — short words ("is", "a") have x-height-only
      // boxes and would otherwise be over-sized.
      const lineSizePx = estimateLineFontSizePx(arr);
      for (const w of arr) {
        const text = w.text;
        if (!text) continue;
        // Text recovered from rotated artwork carries its own angle.
        const wordAngle = (w.angleDeg !== undefined && w.angleDeg !== null) ? w.angleDeg : angle;
        const font = w.bold ? helvB : helv;
        const nat = (w.bold ? widths.bold : widths.regular)(text);
        let size = lineSizePx * g.s;
        // 2) match the original ink span exactly via horizontal scaling
        let hScale = 1;
        if (options.fitText) {
          const targetPt = w.w * g.s;
          let ratio = targetPt / (nat * size);
          if (ratio < 0.72 || ratio > 1.36) {
            // Rebalance: trust the width when the line estimate is clearly off,
            // then squeeze the residual difference.
            size = TC.clamp(size * TC.clamp(ratio, 0.72, 1.6) ** 0.75, size * 0.62, size * 1.5);
            ratio = targetPt / (nat * size);
          }
          hScale = TC.clamp(ratio, 0.74, 1.3);
        }
        if (!isFinite(size) || size <= 0.3) continue;
        // 3) anchor: Tesseract's baseline when present, else the box bottom.
        const baseY = (w.baseline && isFinite(w.baseline.y0)) ? w.baseline.y0 : (w.y + w.h);
        // 4) optical alignment: pull left by the left side bearing of the first glyph
        const bearing = leftBearing(font, text) * size;
        let xPt = pxToPtX(g, w.x) - bearing;
        let yPt = pxToPtY(g, baseY);
        /* Rotated text was recovered from a crop, so its box is the axis-aligned
         * bounds of a tilted line and the box origin is NOT the text origin.
         * Pivot about the measured ink centre instead: the drawn string is
         * centred on its origin (Tz taken into account), so rotating about the
         * centre lands it back on the original slanted line. */
        if (w.angleDeg !== undefined && w.angleDeg !== null && w.center) {
          const rad = (wordAngle * Math.PI) / 180;
          const drawnW = nat * size * hScale;
          const halfW = drawnW / 2;
          const cxPt = pxToPtX(g, w.center.x);
          const cyPt = pxToPtY(g, w.center.y);
          // Offset from the origin to the string centre, rotated into place.
          const dx = -halfW * Math.cos(rad);
          const dy = -halfW * Math.sin(rad) - size * 0.18;
          xPt = cxPt + dx;
          yPt = cyPt + dy;
        }
        const wc = (w.color && w.color.length >= 3) ? w.color : [0, 0, 0];
        const col = [wc[0] / 255, wc[1] / 255, wc[2] / 255];
        if (!window.__drawLog) window.__drawLog = [];
        if (window.__drawLog.length < 500) window.__drawLog.push({ text, size: +size.toFixed(2), hScale: +hScale.toFixed(2), x: +xPt.toFixed(1), y: +yPt.toFixed(1), boxH: Math.round(w.h), boxW: Math.round(w.w), angle: +angle.toFixed(1) });
        let drawable = text;
        if (!TC.canEncode(drawable, font)) {
          drawable = Array.from(drawable).filter((ch) => TC.canEncode(ch, font)).join('');
          if (!drawable) { stats.droppedText++; continue; }
        }
        const ok = drawTextExact(page, font, fontKeyFor(font), {
          text: drawable, x: xPt, y: yPt, size, rotateDeg: wordAngle, hScale, color: col,
        });
        if (ok) { stats.words++; stats.chars += text.length; for (const ch of text) usedGlyphs.add(ch); }
        else stats.droppedText++;
      }
    }
  }

  doc.setSubject(`Reconstructed ${pages.length} page(s) · ${stats.words} typed words`);
  const bytes = await doc.save({ useObjectStreams: true });
  return { bytes, stats };
}

/**
 * Left side bearing (em fraction) of the first visible glyph. pdf-lib does not
 * expose glyph metrics, so approximate using the advance of a space glyph and
 * the known Helvetica left-bearings of common first characters.
 */
const LSB_EM = { ' ': 0.278, 'I': 0.078, 'J': 0.038, 'T': 0.028, 'L': 0.058, '1': 0.222, '(': 0.075, '[': 0.075, '"': 0.05, "'": 0.1, ',': 0.075, '.': 0.075 };
function leftBearing(font, text) {
  const first = text[0] || '';
  if (LSB_EM[first] !== undefined) return LSB_EM[first] * 0.5;
  return 0.045;
}

  // --- exported onto TC ---
  TC.ASC_RE = ASC_RE;
  TC.CAPS_RE = CAPS_RE;
  TC.DESC_RE = DESC_RE;
  TC.LSB_EM = LSB_EM;
  TC.PAGE_SIZES = PAGE_SIZES;
  TC.assemblePdf = assemblePdf;
  TC.computePageGeometry = computePageGeometry;
  TC.consolidateWords = consolidateWords;
  TC.contourSignedArea = contourSignedArea;
  TC.contoursToRings = contoursToRings;
  TC.cropToPngDataUrl = cropToPngDataUrl;
  TC.drawTextExact = drawTextExact;
  TC.emitFilledRings = emitFilledRings;
  TC.estimateCropSkew = estimateCropSkew;
  TC.estimateFontSizePx = estimateFontSizePx;
  TC.estimateLineFontSizePx = estimateLineFontSizePx;
  TC.inkHeightPerEm = inkHeightPerEm;
  TC.isBoxBold = isBoxBold;
  TC.leftBearing = leftBearing;
  TC.lineAngleDeg = lineAngleDeg;
  TC.maskBBox = maskBBox;
  TC.maskTextInCrop = maskTextInCrop;
  TC.naturalWidth = naturalWidth;
  TC.pdfColor = pdfColor;
  TC.pxToPtX = pxToPtX;
  TC.pxToPtY = pxToPtY;
  TC.round4 = round4;
  TC.sampleWordColor = sampleWordColor;
  TC.simplifyContour = simplifyContour;
  TC.traceMask = traceMask;
  TC.vectoriseCrop = vectoriseCrop;
});
