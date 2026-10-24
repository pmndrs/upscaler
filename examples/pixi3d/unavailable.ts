/**
 * Stands in for a pixi-3d example while the closed-beta package isn't unpacked
 * at examples/pixi3d/vendor/ (examples/vite.config.ts swaps it in), so the
 * gallery, CI and Pages build without the beta.
 */

const badge = document.getElementById('badge');
if (badge) {
    badge.style.pointerEvents = 'auto';
    badge.style.whiteSpace = 'normal';
    badge.style.maxWidth = '460px';
    badge.innerHTML = `<b>pixi-3d is in closed beta</b><br><br>
This example needs the <code>@pixi/3d</code> beta, which isn't on npm yet and isn't
bundled here. Beta testers: download the release tarball, then from the repo root
<pre>mkdir -p examples/pixi3d/vendor
tar -xzf pixi-3d-*.tgz -C examples/pixi3d/vendor --strip-components=1
pnpm examples</pre>
Details: <a href="https://github.com/pmndrs/upscaler/blob/main/examples/pixi3d/README.md">examples/pixi3d/README.md</a>.
The plain pixi.js example (P1) runs without it.`;
}
