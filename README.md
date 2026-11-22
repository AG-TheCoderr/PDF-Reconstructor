# Typecraft — Visual Document → Typed PDF Reconstructor

A **100 % client-side** tool that reads a flat scan (PNG/JPG/WEBP/BMP/GIF or a single- or
multi-page PDF) and rebuilds it as a **real vector PDF**: solid colour fills, drawn rules and
borders, cropped artwork, and *selectable, searchable* Helvetica text at the original size,
colour and weight.

Everything runs in the browser tab. There is no backend, no API key, no upload and no build
step — just static files: `index.html`, six CSS files, six HTML fragments and a set of plain
JavaScript modules loaded with classic `<script>` tags.

**[Open `index.html`](index.html)** (or serve the repo root with any static server, e.g.
`python3 -m http.server`). It also works straight from disk — double-clicking the file
loads the app, because nothing uses ES modules or `fetch` against the local tree.

---

## Features

| Area | What it does |
| --- | --- |
| **Input** | Drag-and-drop or file picker. Raster images *and* PDFs (each page is rendered to an offscreen canvas with PDF.js). Multi-page PDFs are reconstructed page-for-page. |
| **Layer 1 — colour regions** | Finds the dominant page paper, then grid-samples flat fills and groups them. Every fill mask is re-closed (binary morphology sized to the local text rhythm) and re-labelled, so a banner, a callout split by its own heading, and every shaded table cell come out as one exact rectangle with a sampled RGB. |
| **Layer 2 — structural lines** | Grayscale run-length morphology finds long horizontal/vertical rules while rejecting character strokes. Each line is re-verified against the actual pixels on its centreline and against the page background, so a paper-coloured "line" inside a table can never erase a row. Colour, thickness and endpoints are sampled from the source. |
| **Layer 3 — text** | Tesseract.js (v6) word/line boxes → per-word foreground colour (core-stroke percentile, saturation-aware), bold-vs-regular from stroke width ÷ em, and a **per-line font size** derived from tight ink boxes with content-aware glyph metrics. Two safety-net OCR passes recover what the whole-page layout engine skips: ink bands with no recognised words (footers) and small labels inside pale callouts (`Sun`, `Songbird`, `NAME`). A consolidation pass then removes duplicate/ clipped readings from the overlapping passes. |
| **Layer 4 — graphics** | Masks text, rules and fills, then finds connected components for logos, stamps, arrows, signatures and diagram art. Crops are painted with the *reference* colour at every transparent hole, so re-typed text never sits on a ghost of itself, and crops that are wholly inside a vector fill are rejected. |
| **PDF output** | pdf-lib. Draw order is background → colour regions → graphic crops → rules → selectable text, with the correct Canvas Y-down → PDF Y-up flip. Text is placed on the Tesseract baseline, horizontally scaled (Tz) to match the measured ink span, and rotated when the baseline is slanted. Unsupported characters are dropped rather than corrupting the page. |
| **UI** | Responsive light/dark studio. Live progress per layer, side-by-side original (with a toggleable debug overlay: blue = regions, green = lines, orange = text, purple = graphics) and reconstructed preview (PDF.js render or text layer), plus sliders for contrast boost, line sensitivity, colour-box detection, diagram crops, minimum OCR confidence, bold threshold and page size. |

## Controls

- **Contrast boost** — pre-OCR stretch applied in luminance space (keeps hue).
- **Line sensitivity** — how aggressively long rules are accepted.
- **Colour box detection** — toggle Layer 1.
- **Crop diagrams** — toggle Layer 4.
- **Min OCR confidence** — words below this are discarded (default 45).
- **Bold threshold** — stroke-density cut-off between Helvetica and Helvetica Bold.
- **Page size** — Auto (pixel-accurate, aspect-preserving), A4 or Letter.
- **Fit text** — match the original ink width via horizontal scaling.

## Library loading

The three libraries are pinned and loaded from jsDelivr on first use:

```
tesseract.js@6.0.1  → window.Tesseract
pdf-lib@1.17.1      → window.PDFLib
pdfjs-dist@3.11.174 → window.pdfjsLib
```

Tesseract's `worker.min.js`, WASM core (`tesseract.js-core@6.1.2`) and `eng` traineddata
(`@tesseract.js-data/eng@1.0.0/4.0.0_best_int`) are fetched from the same CDN. An internet
connection is required on first load; nothing is sent anywhere except those CDN requests.

## Limitations

- Text is re-typeset in Helvetica / Helvetica Bold — the closest standard PDF font — so
  display typefaces are approximated, not reproduced.
- WinAnsi is the only encoding used; characters outside it (arrows, some maths symbols,
  CJK, Devanagari, …) are omitted from the typed layer.
- Heavily degraded scans, handwriting and rotated pages produce progressively rougher results.
- Complex artwork is embedded as a PNG crop rather than traced to vectors (all crops are
  capped at 900 px on the long side).

## Project layout

```
index.html   the page shell: <link>s the CSS, inlines the fragments, loads the scripts
css/         tokens, base, layout, components, stage, responsive
html/        markup fragments — topbar, hero, sidebar, stage, export, footer
js/          runtime.js (the TC namespace) + one file per pipeline stage
README.md    this file
```

Everything is verbatim HTML/CSS/JS. There is no bundler, no transpiler and no `npm install`:
open `index.html` and it runs. The only thing that changes load order is the `<script>` list
at the bottom of `index.html` — `js/runtime.js` first, `js/boot.js` last.

### How the JavaScript is organised

`js/runtime.js` defines a single global, `TC`. Every other file registers itself onto it:

```js
TC.register(function (TC) {
  'use strict';

  function detectLines(/* … */) { /* … */ }

  TC.detectLines = detectLines;      // publish what other modules may call
});
```

Each module keeps its own scope, so helpers stay private until they are explicitly published
onto `TC`. Cross-module calls are always written as `TC.something()`, which keeps the
dependency visible at the call site and means load order only matters for top-level code
(function bodies resolve when they run, so two modules may call into each other freely).

The pipeline, in order of execution:

| File | Responsibility |
| --- | --- |
| `runtime.js` | The `TC` namespace and `TC.register` |
| `config.js` | CDN URLs, page sizes |
| `dom.js` | `$`, `clamp`, canvas and colour helpers |
| `state.js`, `progress.js`, `toast.js`, `theme.js`, `loader.js` | App state and UI plumbing |
| `samples.js` | The synthetic invoice and worksheet used by the demo buttons |
| `files.js`, `sample-load.js` | File intake (images + PDFs) and sample loading |
| `pixels.js`, `layer1-regions.js` | Layer 1 — page background and colour regions |
| `layer2-lines.js` | Layer 2 — structural lines, rules and table borders |
| `layer3-text.js`, `ocr.js`, `styled-words.js` | Layer 3 — OCR, word boxes, font size/weight/colour |
| `layer4-graphics.js` | Layer 4 — vector tracing of surviving artwork |
| `pdf-build.js` | pdf-lib assembly: fills, rules, artwork, typed text |
| `pipeline.js` | Orchestrates the four layers over one or more pages |
| `preview.js`, `overlay.js`, `ui.js` | Preview panes, overlays, controls |
| `boot.js` | Starts the app and publishes `window.Typecraft` |

## Development notes

The app exposes a small debug surface on `window.Typecraft`
(`state`, `run`, `loadSample`, `reset`, `detectColorRegions`, `detectLines`,
`samplePageBackground`, `buildStyledWords`, `assemblePdf`, `options`) plus
`__lastRegionDebug`, `__gfxDebug` and `__drawLog` for inspecting the last run.
`TC` itself is deliberately not attached to `window` — use the `Typecraft` handle.

## License

MIT.
