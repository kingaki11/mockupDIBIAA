// Constants and helpers shared by the Convert Logo and Mockup tabs. Loaded before
// admin.js and mockup.js, which both read these as globals.

// Backend API (Railway): die-line templates, logo cut-out, the AI redraw and the
// vector exports all live behind it.
// When the page is served by the backend itself (a whole-repo deploy, e.g.
// Hostinger), the server sets window.__API_BASE__: empty means "this same
// server". Everywhere else — Vercel, a local static server — it is unset and the
// page uses Railway, as before.
const BACKEND_URL = (typeof window.__API_BASE__ === 'string')
    ? (window.__API_BASE__ || window.location.origin)
    : 'https://mockupdibiaa-backend-production.up.railway.app';

// Printing-colour palette (RGB), keyed by lowercase name. The Mockup tab builds
// its printing-colour dropdown from this and paints the logo with it.
const colorMap = {
    'golden': [215, 181, 109],
    'black': [28, 27, 23],
    'red': [255, 0, 0],
    'brown': [165, 42, 42],
    'green': [62, 112, 110],
    'grey': [128, 128, 128],
    'magenta': [255, 0, 255],
    'maroon': [128, 37, 74],
    'orange': [128, 165, 0],
    'pink': [255, 192, 203],
    'purple': [128, 0, 128],
    'silver': [197, 198, 198],
    'white': [254, 254, 254],
    'blue': [62, 89, 156],
    'yellow': [255, 255, 0],
};

// Trims a canvas's transparent margins down to its actual visible pixels and
// returns a PNG data URL. Without this, a logo that wasn't perfectly centered
// in its own source file (or that came back from removal with extra padding)
// would still be off-center once placed on the box — placement always centers
// on the *image bounds*, so those bounds need to hug the artwork exactly.
function trimCanvasToVisibleBounds(canvas) {
    const w = canvas.width, h = canvas.height;
    const ctx = canvas.getContext('2d');
    const { data } = ctx.getImageData(0, 0, w, h);

    // Anything fainter than this is matte fringe, not artwork. Trimming on
    // alpha > 0 let a barely-visible halo dictate the bounds, which pushed the
    // real logo off-centre once it was placed on the box.
    const ALPHA_FLOOR = 12;

    let minX = w, minY = h, maxX = -1, maxY = -1;
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            if (data[(y * w + x) * 4 + 3] > ALPHA_FLOOR) {
                if (x < minX) minX = x;
                if (x > maxX) maxX = x;
                if (y < minY) minY = y;
                if (y > maxY) maxY = y;
            }
        }
    }
    if (maxX < minX || maxY < minY) {
        // Nothing visible survived (e.g. an all-background image) — fall back
        // to the untrimmed canvas rather than producing an empty image.
        return canvas.toDataURL('image/png');
    }

    const trimmedW = maxX - minX + 1;
    const trimmedH = maxY - minY + 1;
    const trimmedCanvas = document.createElement('canvas');
    trimmedCanvas.width = trimmedW;
    trimmedCanvas.height = trimmedH;
    trimmedCanvas.getContext('2d').drawImage(canvas, minX, minY, trimmedW, trimmedH, 0, 0, trimmedW, trimmedH);
    return trimmedCanvas.toDataURL('image/png');
}
