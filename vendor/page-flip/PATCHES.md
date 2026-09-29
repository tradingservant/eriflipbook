# Patches to StPageFlip 2.0.7

`page-flip.browser.js` is the upstream browser build, with three small changes:

1. **Stop the animation loop on destroy.** The original `requestAnimationFrame` loop never ends, so opening another PDF would leave a loop running. `destroy()` now sets `render.disposed` and the loop returns.

2. **Skip repeated hiding work.** While idle, the renderer walked every page and rewrote inline styles on each frame. Hidden pages are now left alone until they are shown again. This matters for books with hundreds of pages.

3. **`forcePortrait` setting.** The original library switches to a single page only when the book is narrower than `minWidth * 2`, and that same `minWidth` is also a CSS minimum. Phones need a single page even after the page is zoomed wider than the screen, so `getSettings().forcePortrait = true` locks portrait mode without inflating `minWidth`.

Upstream license: MIT. See `LICENSE`.
