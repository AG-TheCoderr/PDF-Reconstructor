/* ============================================================================
   Progress model
   The progress bar and per-layer chips.
   ========================================================================== */

TC.register(function (TC) {
  'use strict';

const STEPS = ['ocr', 'bg', 'boxes', 'lines', 'text', 'gfx', 'pdf'];
const progress = {
  active: false,
  pct: 0,
  step: '',
  set(pct, step, title) {
    this.pct = TC.clamp(pct, 0, 100);
    if (typeof step === 'string') this.step = step;
    if (title) TC.$('progressTitle').textContent = title;
    TC.$('progressFill').style.width = this.pct.toFixed(1) + '%';
    TC.$('progressPct').textContent = Math.round(this.pct) + '%';
    if (typeof step === 'string') {
      TC.$('progressStep').innerHTML = `<span class="dot"></span>${TC.escapeHtml(step)}`;
      const idx = STEPS.indexOf(this.stepKey || '');
      // mark chips
      const keys = this.chipKeys || [];
      document.querySelectorAll('#steps .step-chip').forEach((chip) => {
        const k = chip.dataset.step;
        chip.classList.remove('active', 'done');
        const seen = keys.indexOf(k);
        if (seen === -1) return;
        if (chip.dataset.done === '1') chip.classList.add('done');
        else if (k === this.stepKey) chip.classList.add('active');
      });
    }
  },
  reset(title = 'Idle', step = 'Load a document to begin.') {
    this.pct = 0; this.active = false; this.chipKeys = []; this.stepKey = '';
    TC.$('progressFill').classList.remove('indeterminate');
    TC.$('progressFill').style.width = '0%';
    TC.$('progressPct').textContent = '0%';
    TC.$('progressTitle').textContent = title;
    TC.$('progressStep').textContent = step;
    document.querySelectorAll('#steps .step-chip').forEach((c) => { c.classList.remove('active', 'done'); c.dataset.done = ''; });
  },
  chip(key, stateName) {
    const chip = document.querySelector(`#steps .step-chip[data-step="${key}"]`);
    if (!chip) return;
    if (!this.chipKeys) this.chipKeys = [];
    if (!this.chipKeys.includes(key)) this.chipKeys.push(key);
    chip.dataset.done = stateName === 'done' ? '1' : '';
    chip.classList.toggle('done', stateName === 'done');
    chip.classList.toggle('active', stateName === 'active');
    this.stepKey = stateName === 'active' ? key : (this.stepKey === key ? '' : this.stepKey);
  },
  indeterminate(on) {
    TC.$('progressFill').classList.toggle('indeterminate', !!on);
  },
};

  // --- exported onto TC ---
  TC.STEPS = STEPS;
  TC.progress = progress;
});
