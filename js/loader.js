/* ============================================================================
   Script loading
   Loads the CDN libraries on demand with friendly errors.
   ========================================================================== */

TC.register(function (TC) {
  'use strict';

const scriptPromises = {};
function loadScript(src, timeoutMs = 45000) {
  if (scriptPromises[src]) return scriptPromises[src];
  scriptPromises[src] = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      s.remove();
      reject(new Error(`Timed out loading ${new URL(src).pathname.split('/').pop()}`));
    }, timeoutMs);
    s.src = src;
    s.async = true;
    s.crossOrigin = 'anonymous';
    s.onload = () => { if (done) return; done = true; clearTimeout(timer); resolve(); };
    s.onerror = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      reject(new Error(`Could not load ${src}. Check your connection, then reload the page.`));
    };
    document.head.appendChild(s);
  });
  return scriptPromises[src];
}

  // --- exported onto TC ---
  TC.loadScript = loadScript;
  TC.scriptPromises = scriptPromises;
});
