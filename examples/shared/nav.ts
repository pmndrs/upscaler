/**
 * The gallery frame every example gets: a small top-centre pill with a link
 * back to the gallery, the example's title and its source on GitHub.
 * examples/vite.config.ts injects this module into every page except the
 * gallery itself, so examples never import it. A page whose own top-centre
 * is taken moves the pill down with
 * `<meta name="example-nav-top" content="64px">`.
 */

const REPO_TREE = 'https://github.com/pmndrs/upscaler/tree/main/examples/';

const STYLE = `
.example-nav {
    position: fixed;
    top: 10px;
    left: 50%;
    transform: translateX(-50%);
    z-index: 100000;
    display: flex;
    align-items: center;
    gap: 2px;
    padding: 3px;
    background: rgba(8, 10, 14, 0.82);
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: 999px;
    backdrop-filter: blur(6px);
    font: 12px/1 ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif;
    color: #cfd8e3;
    white-space: nowrap;
    user-select: none;
}
.example-nav a,
.example-nav span {
    padding: 6px 10px;
    border-radius: 999px;
    color: inherit;
    text-decoration: none;
}
.example-nav a:hover,
.example-nav a:focus-visible {
    background: rgba(125, 211, 252, 0.14);
    color: #7dd3fc;
    outline: none;
}
.example-nav .back {
    color: #7dd3fc;
    font-weight: 600;
}
.example-nav .title {
    color: #8b97a6;
    border-left: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 0;
}
@media (max-width: 720px) {
    .example-nav .title,
    .example-nav .source {
        display: none;
    }
}
`;

function link(className: string, href: string, text: string, external = false): HTMLAnchorElement {
    const a = document.createElement('a');
    a.className = className;
    a.href = href;
    a.textContent = text;
    if (external) {
        a.target = '_blank';
        a.rel = 'noopener';
    }
    return a;
}

function mount(): void {
    const base = import.meta.env.BASE_URL;
    // The page's folder relative to the gallery root, e.g. '07-tsl-node/' or 'babylon/hello/'.
    const folder = location.pathname.startsWith(base)
        ? location.pathname.slice(base.length).replace(/index\.html$/, '')
        : '';

    const style = document.createElement('style');
    style.textContent = STYLE;
    document.head.append(style);

    const nav = document.createElement('nav');
    nav.className = 'example-nav';
    nav.setAttribute('aria-label', 'Examples');
    const top = document.querySelector<HTMLMetaElement>('meta[name="example-nav-top"]')?.content;
    if (top) nav.style.top = top;
    nav.append(link('back', base, '← Examples'));
    const title = document.createElement('span');
    title.className = 'title';
    title.textContent = document.title;
    nav.append(title);
    if (folder) nav.append(link('source', REPO_TREE + folder, 'Source ↗', true));
    document.body.append(nav);
}

mount();
