/* ============================================================================
   Sample document generators
   Draws the built-in invoice and worksheet canvases used for demos and tests.
   ========================================================================== */

TC.register(function (TC) {
  'use strict';

const INK = '#0f172a';

function drawInvoiceSample() {
  const W = 1240, H = 1754; // A4-ish at ~150dpi
  const c = TC.makeCanvas(W, H);
  const x = TC.ctxOf(c);
  x.fillStyle = '#ffffff'; x.fillRect(0, 0, W, H);
  const pad = 72;

  // Header banner
  x.fillStyle = '#123c69';
  x.fillRect(0, 0, W, 190);
  x.fillStyle = '#ffffff';
  x.font = '800 54px Arial, Helvetica, sans-serif';
  x.fillText('NORTHWIND STUDIO', pad, 96);
  x.font = '500 23px Arial, Helvetica, sans-serif';
  x.fillStyle = '#b9d4ef';
  x.fillText('Design & Manufacturing · 42 Harbor Lane, Bristol', pad, 141);

  // Logo — teal circle with white monogram + ring
  const lx = W - 150, ly = 96;
  x.strokeStyle = '#16b3a3'; x.lineWidth = 9;
  x.beginPath(); x.arc(lx, ly, 52, 0, Math.PI * 2); x.stroke();
  x.fillStyle = '#16b3a3';
  x.beginPath(); x.arc(lx, ly, 38, 0, Math.PI * 2); x.fill();
  x.fillStyle = '#ffffff';
  x.font = '800 40px Arial, Helvetica, sans-serif';
  x.textAlign = 'center';
  x.fillText('NW', lx, ly + 14);
  x.textAlign = 'left';

  // Invoice meta
  x.fillStyle = INK;
  x.font = '800 30px Arial, Helvetica, sans-serif';
  x.fillText('INVOICE', pad, 268);
  x.font = '400 21px Arial, Helvetica, sans-serif';
  x.fillStyle = '#334155';
  x.fillText('Invoice #:  NW-2026-0491', pad, 310);
  x.fillText('Issued:  November 14, 2026', pad, 342);
  x.fillText('Due:  December 14, 2026', pad, 374);

  x.font = '700 20px Arial, Helvetica, sans-serif';
  x.fillStyle = '#0f172a';
  x.fillText('BILLED TO', 760, 262);
  x.font = '400 21px Arial, Helvetica, sans-serif';
  x.fillStyle = '#334155';
  x.fillText('Jane Okafor', 760, 296);
  x.fillText('Lumen Analytics Ltd.', 760, 328);
  x.fillText('18 Kingsway, London WC2B 6UN', 760, 360);
  x.fillStyle = '#1d4ed8';
  x.fillText('accounts@lumen-analytics.example', 760, 392);

  // Colored callout box
  x.fillStyle = '#ecfdf5';
  x.fillRect(pad, 436, W - pad * 2, 96);
  x.strokeStyle = '#10b981'; x.lineWidth = 3;
  x.strokeRect(pad, 436, W - pad * 2, 96);
  x.fillStyle = '#065f46';
  x.font = '700 22px Arial, Helvetica, sans-serif';
  x.fillText('Payment terms: Net 30 · Late payments accrue 1.5% interest per month.', pad + 26, 480);
  x.font = '400 20px Arial, Helvetica, sans-serif';
  x.fillText('Please reference the invoice number on your bank transfer.', pad + 26, 511);

  // Table header band
  const tx = pad, tw = W - pad * 2, ty = 588, rh = 54;
  x.fillStyle = '#123c69';
  x.fillRect(tx, ty, tw, rh);
  x.fillStyle = '#ffffff';
  x.font = '700 21px Arial, Helvetica, sans-serif';
  x.fillText('DESCRIPTION', tx + 24, ty + 35);
  x.fillText('QTY', tx + 560, ty + 35);
  x.fillText('UNIT PRICE', tx + 660, ty + 35);
  x.fillText('AMOUNT', tx + 880, ty + 35);

  const rows = [
    ['Brand identity system — logotype, palette, type scale', '1', '4,800.00', '4,800.00'],
    ['Packaging artwork (6 SKUs) — dielines + print-ready PDF', '6', '420.00', '2,520.00'],
    ['Website design — 12 responsive screens, design tokens', '1', '3,650.00', '3,650.00'],
    ['Photography direction — 2 studio days', '2', '950.00', '1,900.00'],
    ['Production support — retainer, November', '1', '1,200.00', '1,200.00'],
  ];
  let y = ty + rh;
  rows.forEach((r, i) => {
    const rowH = 66;
    if (i % 2 === 0) { x.fillStyle = '#f4f7fb'; x.fillRect(tx, y, tw, rowH); }
    x.strokeStyle = '#c8d3e2'; x.lineWidth = 1.4;
    x.beginPath(); x.moveTo(tx, y + rowH); x.lineTo(tx + tw, y + rowH); x.stroke();
    x.fillStyle = INK;
    x.font = '400 20px Arial, Helvetica, sans-serif';
    x.fillText(r[0], tx + 24, y + 41);
    x.fillText(r[1], tx + 578, y + 41);
    x.fillText(r[2], tx + 660, y + 41);
    x.font = '600 20px Arial, Helvetica, sans-serif';
    x.fillText(r[3], tx + 880, y + 41);
    y += rowH;
  });
  // Table outer + column rules
  x.strokeStyle = '#94a3b8'; x.lineWidth = 2;
  x.strokeRect(tx, ty, tw, y - ty);
  x.lineWidth = 1.4;
  [548, 646, 862].forEach((cx) => {
    x.beginPath(); x.moveTo(tx + cx, ty); x.lineTo(tx + cx, y); x.stroke();
  });

  // Totals block
  const tby = y + 34;
  x.fillStyle = '#f8fafc';
  x.fillRect(tx + 560, tby, tw - 560, 170);
  x.strokeStyle = '#cbd5e1'; x.lineWidth = 1.4;
  x.strokeRect(tx + 560, tby, tw - 560, 170);
  x.fillStyle = '#334155';
  x.font = '400 20px Arial, Helvetica, sans-serif';
  x.fillText('Subtotal', tx + 588, tby + 42);
  x.fillText('VAT (20%)', tx + 588, tby + 82);
  x.fillText('Shipping', tx + 588, tby + 122);
  x.textAlign = 'right';
  x.fillText('14,070.00', tx + tw - 30, tby + 42);
  x.fillText('2,814.00', tx + tw - 30, tby + 82);
  x.fillText('0.00', tx + tw - 30, tby + 122);
  x.textAlign = 'left';
  x.strokeStyle = '#94a3b8'; x.beginPath(); x.moveTo(tx + 576, tby + 136); x.lineTo(tx + tw - 18, tby + 136); x.stroke();
  x.fillStyle = '#0f172a'; x.font = '800 24px Arial, Helvetica, sans-serif';
  x.fillText('TOTAL DUE', tx + 588, tby + 164);
  x.fillStyle = '#1d4ed8'; x.textAlign = 'right';
  x.fillText('£16,884.00', tx + tw - 30, tby + 164);
  x.textAlign = 'left';

  // PAID stamp (rotated, semi transparent) — becomes a Layer 4 graphic
  x.save();
  x.translate(W - 300, tby + 250);
  x.rotate(-0.16);
  x.globalAlpha = 0.82;
  x.strokeStyle = '#16a34a'; x.lineWidth = 5;
  x.strokeRect(-118, -46, 236, 92);
  x.fillStyle = '#16a34a';
  x.font = '800 46px Arial, Helvetica, sans-serif';
  x.textAlign = 'center';
  x.fillText('PAID', 0, 17);
  x.restore();

  // Signature (hand-drawn polyline) — Layer 4 graphic
  x.strokeStyle = '#0b3d91'; x.lineWidth = 4; x.lineCap = 'round'; x.lineJoin = 'round';
  const sx = pad + 6, sy = tby + 250;
  x.beginPath();
  x.moveTo(sx, sy);
  x.bezierCurveTo(sx + 30, sy - 62, sx + 58, sy + 30, sx + 92, sy - 18);
  x.bezierCurveTo(sx + 120, sy - 54, sx + 136, sy + 26, sx + 168, sy - 8);
  x.bezierCurveTo(sx + 190, sy - 30, sx + 208, sy + 8, sx + 236, sy - 26);
  x.stroke();
  x.strokeStyle = '#94a3b8'; x.lineWidth = 1.6;
  x.beginPath(); x.moveTo(sx, sy + 34); x.lineTo(sx + 300, sy + 34); x.stroke();
  x.fillStyle = '#64748b'; x.font = '400 17px Arial, Helvetica, sans-serif';
  x.fillText('Authorized signature · Northwind Studio', sx, sy + 62);

  // Footer
  x.strokeStyle = '#e2e8f0'; x.lineWidth = 1.4;
  x.beginPath(); x.moveTo(pad, H - 118); x.lineTo(W - pad, H - 118); x.stroke();
  x.fillStyle = '#94a3b8'; x.font = '400 17px Arial, Helvetica, sans-serif';
  x.fillText('Northwind Studio Ltd. · Registered in England & Wales · Company No. 11223344', pad, H - 84);
  x.fillText('Bank: Monzo Business · Sort 04-00-04 · Account 11223344 · IBAN GB29 MONZ 0400 0411 2233 44', pad, H - 56);

  return c;
}

function drawWorksheetSample() {
  const W = 1240, H = 1754;
  const c = TC.makeCanvas(W, H);
  const x = TC.ctxOf(c);
  x.fillStyle = '#fffdf7'; x.fillRect(0, 0, W, H);
  const pad = 64;

  // Top color band
  x.fillStyle = '#7c2d12';
  x.fillRect(0, 0, W, 22);
  x.fillStyle = '#b45309';
  x.fillRect(0, 22, W, 14);

  // Title block
  x.fillStyle = '#7c2d12';
  x.font = '800 44px Georgia, "Times New Roman", serif';
  x.fillText('Ecosystem Energy Flow', pad, 132);
  x.fillStyle = '#92400e';
  x.font = 'italic 400 24px Georgia, "Times New Roman", serif';
  x.fillText('Worksheet 3 · Transfer of energy through a grassland food web', pad, 172);

  x.fillStyle = '#fef3c7';
  x.fillRect(W - 396, 74, 332, 128);
  x.strokeStyle = '#d97706'; x.lineWidth = 2.5;
  x.strokeRect(W - 396, 74, 332, 128);
  x.fillStyle = '#78350f';
  x.font = '700 19px Arial, Helvetica, sans-serif';
  x.fillText('NAME', W - 372, 112);
  x.fillText('DATE', W - 372, 158);
  x.strokeStyle = '#a16207'; x.lineWidth = 1.6;
  x.beginPath(); x.moveTo(W - 300, 118); x.lineTo(W - 88, 118); x.stroke();
  x.beginPath(); x.moveTo(W - 300, 164); x.lineTo(W - 88, 164); x.stroke();

  // Intro paragraph
  x.fillStyle = '#1c1917';
  x.font = '400 21px Arial, Helvetica, sans-serif';
  const intro = [
    'Every organism needs energy to survive. In a grassland, solar energy is captured',
    'by producers, passed to herbivores, and then to predators. At each step the',
    'majority of energy is lost as heat. Use the diagram below to answer the questions.',
  ];
  intro.forEach((line, i) => x.fillText(line, pad, 238 + i * 34));

  // Diagram: food web with colored nodes + arrows (Layer 4 graphic + lines)
  const dx = pad + 40, dy = 372, dw = W - (pad + 40) * 2, dh = 350;
  x.strokeStyle = '#e7e5e4'; x.lineWidth = 2; x.setLineDash([8, 7]);
  x.strokeRect(dx, dy, dw, dh);
  x.setLineDash([]);
  const node = (cx, cy, w, h, fill, label, sub) => {
    x.fillStyle = fill;
    x.fillRect(cx - w / 2, cy - h / 2, w, h);
    x.strokeStyle = '#292524'; x.lineWidth = 2;
    x.strokeRect(cx - w / 2, cy - h / 2, w, h);
    x.fillStyle = '#111';
    x.font = '700 20px Arial, Helvetica, sans-serif';
    x.textAlign = 'center';
    x.fillText(label, cx, cy + (sub ? -2 : 7));
    if (sub) { x.font = '400 15px Arial, Helvetica, sans-serif'; x.fillText(sub, cx, cy + 22); }
    x.textAlign = 'left';
    return { x: cx, y: cy, w, h };
  };
  const sun = node(dx + 92, dy + 72, 128, 60, '#fde68a', '☀ Sun', 'energy source');
  const grass = node(dx + 92, dy + 240, 150, 76, '#bbf7d0', 'Grass', 'producer');
  const insect = node(dx + dw * 0.44, dy + 240, 150, 76, '#fecdd3', 'Grasshopper', 'primary consumer');
  const bird = node(dx + dw * 0.44, dy + 92, 158, 76, '#bae6fd', 'Songbird', 'secondary consumer');
  const snake = node(dx + dw * 0.78, dy + 132, 150, 76, '#e9d5ff', 'Garter snake', 'tertiary consumer');
  const hawk = node(dx + dw * 0.93, dy + 284, 132, 76, '#fca5a5', 'Red-tailed', 'hawk');
  const arrow = (x1, y1, x2, y2, col) => {
    x.strokeStyle = col; x.fillStyle = col; x.lineWidth = 3.4;
    const a = Math.atan2(y2 - y1, x2 - x1);
    const bx = x2 - Math.cos(a) * 13, by = y2 - Math.sin(a) * 13;
    x.beginPath(); x.moveTo(x1, y1); x.lineTo(bx, by); x.stroke();
    x.beginPath();
    x.moveTo(x2, y2);
    x.lineTo(x2 - Math.cos(a - 0.42) * 17, y2 - Math.sin(a - 0.42) * 17);
    x.lineTo(x2 - Math.cos(a + 0.42) * 17, y2 - Math.sin(a + 0.42) * 17);
    x.closePath(); x.fill();
  };
  arrow(sun.x + 20, sun.y + 34, grass.x - 6, grass.y - 40, '#ca8a04');
  arrow(grass.x + 78, grass.y - 14, insect.x - 78, insect.y - 10, '#15803d');
  arrow(insect.x + 10, insect.y - 40, bird.x - 8, bird.y + 40, '#be123c');
  arrow(bird.x + 80, bird.y + 4, snake.x - 78, snake.y - 12, '#0369a1');
  arrow(snake.x + 30, snake.y + 38, hawk.x - 40, hawk.y - 40, '#7e22ce');
  x.fillStyle = '#57534e'; x.font = 'italic 16px Arial, Helvetica, sans-serif';
  x.fillText('Figure 1 — flow of energy (arrows point toward the consumer)', dx + 14, dy + dh - 14);

  // Questions
  let qy = dy + dh + 66;
  x.fillStyle = '#7c2d12';
  x.font = '800 26px Georgia, "Times New Roman", serif';
  x.fillText('Questions', pad, qy);
  qy += 42;
  const questions = [
    ['1.', 'Which organism in the diagram is the primary producer, and where does its energy come from?'],
    ['2.', 'Explain why fewer hawks than grasshoppers can be supported in this ecosystem.'],
    ['3.', 'Calculate: if the grass stores 42,000 kJ of energy, how much reaches the songbird?'],
  ];
  questions.forEach((q) => {
    x.fillStyle = '#1c1917';
    x.font = '700 21px Arial, Helvetica, sans-serif';
    x.fillText(q[0], pad, qy);
    x.font = '400 21px Arial, Helvetica, sans-serif';
    x.fillText(q[1], pad + 34, qy);
    for (let i = 1; i <= 3; i++) {
      x.strokeStyle = '#d6d3d1'; x.lineWidth = 1.3;
      x.beginPath(); x.moveTo(pad, qy + 34 * i); x.lineTo(W - pad, qy + 34 * i); x.stroke();
    }
    qy += 34 * 3 + 34;
  });

  // Data table
  qy += 6;
  x.fillStyle = '#7c2d12';
  x.font = '800 24px Georgia, "Times New Roman", serif';
  x.fillText('Trophic level data', pad, qy);
  qy += 22;
  const cols = [pad, pad + 300, pad + 620, pad + 900];
  const head = ['Trophic level', 'Organisms', 'Energy (kJ/m²/yr)', 'Percent retained'];
  x.fillStyle = '#92400e';
  x.fillRect(pad, qy, W - pad * 2, 46);
  x.fillStyle = '#ffffff'; x.font = '700 18px Arial, Helvetica, sans-serif';
  head.forEach((h, i) => x.fillText(h, cols[i] + 14, qy + 30));
  const data = [
    ['Producers', 'Grasses, wildflowers', '42,000', '100%'],
    ['Primary consumers', 'Grasshoppers, voles', '4,200', '10%'],
    ['Secondary consumers', 'Songbirds, frogs', '420', '1%'],
    ['Tertiary consumers', 'Snakes, hawks', '42', '0.1%'],
  ];
  let ry = qy + 46;
  data.forEach((r, i) => {
    if (i % 2 === 1) { x.fillStyle = '#fef3c7'; x.fillRect(pad, ry, W - pad * 2, 44); }
    x.fillStyle = '#1c1917'; x.font = '400 18px Arial, Helvetica, sans-serif';
    r.forEach((cellV, j) => x.fillText(cellV, cols[j] + 14, ry + 29));
    x.strokeStyle = '#d6d3d1'; x.lineWidth = 1.2;
    x.beginPath(); x.moveTo(pad, ry + 44); x.lineTo(W - pad, ry + 44); x.stroke();
    ry += 44;
  });
  x.strokeStyle = '#78716c'; x.lineWidth = 2;
  x.strokeRect(pad, qy, W - pad * 2, ry - qy);
  [300, 620, 900].forEach((cx) => { x.beginPath(); x.moveTo(pad + cx, qy); x.lineTo(pad + cx, ry); x.stroke(); });

  // Footer note
  x.fillStyle = '#a8a29e'; x.font = '400 16px Arial, Helvetica, sans-serif';
  x.fillText('Typecraft sample worksheet · generated locally in your browser', pad, H - 44);
  return c;
}

/** Subtle scan-style texture: keeps sample realistic for OCR but not too noisy. */
function addPaperNoise(canvas) {
  const x = TC.ctxOf(canvas);
  const { width, height } = canvas;
  const img = x.getImageData(0, 0, width, height);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (Math.random() - 0.5) * 5;
    d[i] = TC.clamp(d[i] + n, 0, 255);
    d[i + 1] = TC.clamp(d[i + 1] + n, 0, 255);
    d[i + 2] = TC.clamp(d[i + 2] + n, 0, 255);
  }
  x.putImageData(img, 0, 0);
}

  // --- exported onto TC ---
  TC.INK = INK;
  TC.addPaperNoise = addPaperNoise;
  TC.drawInvoiceSample = drawInvoiceSample;
  TC.drawWorksheetSample = drawWorksheetSample;
});
