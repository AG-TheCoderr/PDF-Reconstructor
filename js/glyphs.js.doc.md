# Character-level verification: what works, what does not

This note is the evidence log for `js/glyphs.js`. It exists so the dead ends are
not re-attempted.

## What is reliable

Comparing a **single glyph cell** against a rendered reference, with the
reference's ink height matched to the page glyph's, separates shapes confidently
*when the cell is well segmented and the glyph is large enough*:

| glyph | size | truth | runner-up | margin |
|---|---|---|---|---|
| O (INVOICE) | 24x21 | O .97 | D .75 | .22 |
| C (INVOICE) | 19x21 | C .95 | G .73 | .22 |
| O (DESCRIPTION) | 16x14 | O .94 | D .78 | .16 |
| D (PDF, wide cell) | 16x14 | D .58 | O .43 | .14 |

The pass is therefore safe as an *abstaining* check. `verifyWord` only acts on a
margin >= .16 with a score >= .45, refuses degenerate references, refuses cells
the segmentation had to shave, and refuses numeric words. On the samples it now
makes **zero** changes — which is the honest outcome: it also fails to fix the
one word it was written for.

## What is not reliable, and why

**D vs O at 11-15 px is not separable by this method.** The invoice's "PDF" is
rendered at a 14 px ink height. At that size a D and an O differ by a single
column of a 12x16 coverage grid. Repeated measurement: the D/O margin sits
between .14 and .19 against a .16 gate, so the outcome flips between builds.
An earlier session reported "POF -> PDF in 5/5 runs"; that did not reproduce on
Chromium 153, where the same code makes no correction at all. The 5/5 was a
property of that session's rasterisation.

**Whole-word template matching, instead of per-cell.** The idea: render the
candidate spelling as a whole word at native resolution and slide it over the
word's ink, which preserves letter widths and spacing and never needs a
segmentation. Measured on all 138 words of the invoice against exact ground
truth (captured from the sample's own `fillText` calls):

    fixed 0-1   broke 10-11

It corrupts `Payment`->`Fayment`, `DESCRIPTION`->`DESGRIPTION`,
`Subtotal`->`5ubtotal`, `BILLED`->`8ILLED`, `IBAN`->`I8AN`, and does not even
reliably fix `POF`. The margins are ties — `Fackaging` .76 vs `Packaging` .76 —
so it is coin-flipping, not measuring. At an 11-15 px ink height a P and an F
differ by one pixel column and the correlation cannot resolve it.

**Wider segmentation window.** Reaches real gutters, but lets cuts slice through
glyphs: `POF` became `FOF`, and 4-5 false corrections appeared
(`STUDIO`->`STUOIO`, `NORTHWIND`->`NORTHWINO`).

**Cut-cost terms on the DP.** Scoring "prefer empty columns" rewards both cuts
around a stub equally and produced 4-5 false corrections. Penalising wet
neighbours made it worse.

**Aspect ratio as a scoring term.** Correct in principle (D ~0.64, O ~1.14) but
`coverageGrid` squashes to a fixed 12x16 and discards it. Adding it back moves
the O-vs-D margin from .19 to .15 — not enough, and it *favours* O when the cell
is too wide from bad segmentation.

**Left-stem test** (a D has a solid vertical stem, an O does not). A real O
scores 1.0 too: at 30 % of a narrow cell the bowl's left wall is a full-height
stem.

## The actual fix, if someone wants to pursue it

Not another threshold. Either:

1. **Better segmentation of wide letters** — the DP fails specifically when one
   glyph is much wider than its neighbours (`AMOUNT`'s M and O, `PDF`'s D).
   That is a segmentation problem, and fixing it would make the existing
   classifier's margins usable.
2. **Sub-pixel / higher-resolution input** — at 14 px the information needed to
   separate D from O is roughly one column of contrast. Supersampling the page
   region before classification, or classifying from the source PDF's vector
   data where available, would give the matcher something to work with.

Neither is a tuning change, and both are larger than the current module.
