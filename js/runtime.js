/* ============================================================================
   Runtime
   The tiny namespace every other module registers itself with.

   Why not ES modules?
     This app is advertised as working when index.html is opened straight from
     disk. file:// blocks `import` (CORS), so the whole app is a set of classic
     <script> tags and this file is the only shared state between them.

   How a module is written:
     TC.register(function (TC) {
       'use strict';
       ... your code ...
       TC.myThing = myThing;      // <- anything the outside world may use
     });

   Cross-module calls are written as TC.something(), never a bare identifier.
   That keeps each module's internals private and makes the dependency
   explicit at the call site. Load order only matters for top-level code;
   function bodies resolve at call time, so circular use is fine.
   ========================================================================== */

const TC = (() => {
  const modules = [];
  let sequence = 0;

  const api = {
    version: '1.1',
    modules,

    /**
     * Run a module body. The callback receives the namespace itself so that a
     * module can publish onto it without touching globals.
     */
    register(fn, name) {
      modules.push({ name: name || `module#${++sequence}`, fn });
      try {
        fn(api);
      } catch (err) {
        // One broken module should not take the whole page down: report it
        // loudly, then let the rest load so the UI still renders.
        console.error(`[TC] module "${name || sequence}" failed`, err);
        api.lastError = err;
      }
      return api;
    },

    /** Look up a published symbol, or throw something readable. */
    need(name) {
      if (!(name in api)) throw new Error(`[TC] nothing exported as "${name}"`);
      return api[name];
    },
  };

  return api;
})();
