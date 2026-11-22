/* ============================================================================
   Toasts
   Transient status messages bottom-right.
   ========================================================================== */

TC.register(function (TC) {
  'use strict';

const ICONS = {
  ok: '<svg viewBox="0 0 24 24" fill="none" stroke="#34d399" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>',
  err: '<svg viewBox="0 0 24 24" fill="none" stroke="#ff5d73" stroke-width="2.2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 7.5v6M12 16.6v.2"/></svg>',
  info: '<svg viewBox="0 0 24 24" fill="none" stroke="#22d3ee" stroke-width="2.2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.7v.2"/></svg>',
};
function toast(message, kind = 'info', ms = 4200) {
  const host = TC.$('toasts');
  const el = document.createElement('div');
  el.className = 'toast ' + (kind === 'err' ? 'err' : '');
  el.setAttribute('role', kind === 'err' ? 'alert' : 'status');
  el.innerHTML = `${ICONS[kind] || ICONS.info}<div>${TC.escapeHtml(message)}</div>`;
  host.appendChild(el);
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 280); }, ms);
}

  // --- exported onto TC ---
  TC.ICONS = ICONS;
  TC.toast = toast;
});
