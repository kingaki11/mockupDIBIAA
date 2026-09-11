// ── Mockup tab ───────────────────────────────────────────────────────────────
//
// Die-line templates are stored once as plain line art on white. Selecting a box
// colour repaints that white in the browser rather than fetching a different
// image, so one template covers all 26 colours instead of 26 stored variants.
//
// Loaded after admin.js, so BACKEND_URL, colorMap, adminAuthHeaders and
// showAdminMsg are already defined.

const BOX_COLOURS = [
    ['YELLOW GOLDEN', '#DB9739'],
    ['ROSE PINK', '#D9A2B5'],
    ['BABY PINK', '#F5B5D2'],
    ['MAROON', '#90385B'],
    ['PINK', '#E67F9C'],
    ['DARK GREY', '#727271'],
    ['GREY', '#C3C3C3'],
    ['DARK BROWN', '#634C3F'],
    ['WINE', '#4F2737'],
    ['RUST', '#B7410E'],
    ['Laminated - Mouve', '#857DB8'],
    ['RED', '#E31E24'],
    ['BLACK', '#2B2A29'],
    ['YELLOW', '#FECC00'],
    ['COLOMBO CREAM', '#C9B591'],
    ['CREAM', '#FFF9D7'],
    ['DARK BLUE', '#212163'],
    ['BLUE', '#3E599C'],
    ['GREEN', '#2B6360'],
    ['MINT GREEN', '#95BB96'],
    ['PARROT GREEN', '#78D62B'],
    ['OLIVE GREEN', '#5C6621'],
    ['SKY BLUE', '#0DADDE'],
    ['Laminate - White', '#FEFEFE'],
    ['Laminated - PINK', '#E67F9C'],
    ['Laminated - Green', '#26514E'],
];

// Fabric writes its own pixel width/height onto the canvas elements inline, so
// a fixed size cannot be reined in by CSS afterwards without breaking the
// pointer maths that makes the logo draggable. Measure the space available and
// build the canvas at that size instead.
const BM_CANVAS_MIN = 260;
const BM_CANVAS_MAX = 1100;

let bmTemplates = [];
let bmLogoFile = null;
let bmLogoUrl = null;            // background-removed logo, as a data URL
let bmLogoNatural = { w: 0, h: 0 };
let bmCanvas = null;
let bmLogoObject = null;
let bmExportMultiplier = 1;
// What the vector export needs, captured while rendering: the same masks the
// recolour worked from, so the SVG cannot disagree with the picture on screen.
let bmLastRender = null;
let bmLogoSource = null;      // recoloured logo PNG, reused by the vector export
let bm3dContext = null;       // geometry the live logo update needs

function bmHex(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(hex).trim());
    if (!m) return [0, 0, 0];
    const n = parseInt(m[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

// ── Template selection ──

function bmPopulateColours() {
    const sel = document.getElementById('bmColor');
    const grid = document.getElementById('bmSwatches');
    const nameEl = document.getElementById('bmColorName');

    BOX_COLOURS.forEach(function (pair) {
        const o = document.createElement('option');
        o.value = pair[1];
        o.textContent = pair[0];
        sel.appendChild(o);

        // Twenty-six colours are unusable as a list of names — you cannot tell
        // MAROON from WINE without seeing them. The select still holds the value;
        // this is just a legible way to set it.
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'bm-swatch';
        b.style.background = pair[1];
        b.title = pair[0] + ' · ' + pair[1];
        b.setAttribute('aria-label', pair[0]);
        b.addEventListener('click', function () {
            sel.value = pair[1];
            nameEl.textContent = pair[0];
            grid.querySelectorAll('.bm-swatch').forEach(function (el) { el.classList.remove('is-active'); });
            b.classList.add('is-active');
        });
        grid.appendChild(b);
    });

    // Printing colours come from the same map the Create Mockup tab recolours
    // with, so the two tabs cannot drift apart.
    const print = document.getElementById('bmPrintColor');
    const none = document.createElement('option');
    none.value = 'None';
    none.textContent = 'None (keep logo colours)';
    print.appendChild(none);
    Object.keys(colorMap).sort().forEach(function (key) {
        const o = document.createElement('option');
        o.value = key;
        o.textContent = key.charAt(0).toUpperCase() + key.slice(1);
        print.appendChild(o);
    });

    // Show the ink colour rather than only naming it.
    const chip = document.getElementById('bmPrintChip');
    const syncChip = function () {
        const rgb = colorMap[(print.value || '').toLowerCase()];
        chip.style.background = rgb ? 'rgb(' + rgb.join(',') + ')' : 'transparent';
        chip.style.display = rgb ? 'block' : 'none';
    };
    print.addEventListener('change', syncChip);
    syncChip();
}

function bmRefreshStyleOptions() {
    // Lives here rather than in the loader so it also updates straight after an
    // upload or a delete, not just on a fresh fetch.
    const empty = document.getElementById('bmEmptyState');
    if (empty) empty.style.display = bmTemplates.length ? 'none' : 'flex';

    const styleSel = document.getElementById('bmStyle');
    const current = styleSel.value;
    const styles = [...new Set(bmTemplates.map(function (t) { return t.styleLabel; }).filter(Boolean))];
    styleSel.innerHTML = '<option value="">--Select--</option>';
    styles.forEach(function (s) {
        const o = document.createElement('option');
        o.value = s; o.textContent = s;
        styleSel.appendChild(o);
    });
    if (styles.includes(current)) styleSel.value = current;
    bmRefreshTypeOptions();
}

function bmRefreshTypeOptions() {
    const style = document.getElementById('bmStyle').value;
    const typeSel = document.getElementById('bmType');
    const current = typeSel.value;
    const matches = bmTemplates.filter(function (t) { return t.styleLabel === style; });
    typeSel.innerHTML = '<option value="">--Select--</option>';
    matches.forEach(function (t) {
        const o = document.createElement('option');
        o.value = t.id;
        // A style like 100 CUT has no separate type, so fall back to the size.
        o.textContent = (t.typeLabel || t.styleLabel) + (t.sizeLabel ? ' — ' + t.sizeLabel : '');
        typeSel.appendChild(o);
    });
    if ([...typeSel.options].some(function (o) { return o.value === current; })) typeSel.value = current;
}

function bmSelectedTemplate() {
    const id = document.getElementById('bmType').value;
    return bmTemplates.find(function (t) { return t.id === id; }) || null;
}

async function bmLoadTemplates() {
    try {
        const res = await fetch(BACKEND_URL + '/box-templates');
        const data = await res.json();
        bmTemplates = data.templates || [];
    } catch (err) {
        bmTemplates = [];
    }
    bmRefreshStyleOptions();
    bmRenderTemplateList();
}

// ── Recolouring ──

// Repaints only the box itself, leaving everything around it transparent.
//
// Painting every white pixel floods the whole sheet — the margins and the
// printed caption end up the box colour too, which is not what a mockup shows.
// The die-line encloses the panels, so a flood fill inward from the image border
// separates the two: white reachable from an edge is the sheet around the box,
// white the fill cannot reach is a panel. Cut lines block the fill, which is
// exactly what they represent.
//
// Panels are then painted and the surrounding sheet is dropped to transparent,
// keeping only its ink so the caption stays readable.
const BM_WHITE = 205;        // luminance above which a pixel counts as blank
const BM_EDGE_GROW = 2;      // px of panel edge absorbed into the painted area
// A panel that survives the fill should account for a decent share of the sheet.
// Well under this means the fill escaped through a broken line rather than that
// the die-line genuinely has little area.
const BM_MIN_PAINTED = 0.25;

// Marks the sheet around the box, stopping at cut lines. Lines are thickened by
// `grow` first: a hairline in a scaled or JPEG-compressed die-line breaks into
// gaps a single pixel wide, and one gap anywhere lets the fill flood a panel and
// leave it unpainted.
function bmFloodOutside(lum, w, h, grow) {
    const total = w * h;
    const blocked = new Uint8Array(total);
    for (let p = 0; p < total; p++) if (lum[p] <= BM_WHITE) blocked[p] = 1;

    for (let step = 0; step < grow; step++) {
        const wider = new Uint8Array(blocked);
        for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
                const p = y * w + x;
                if (blocked[p]) continue;
                if ((x > 0 && blocked[p - 1]) || (x < w - 1 && blocked[p + 1])
                    || (y > 0 && blocked[p - w]) || (y < h - 1 && blocked[p + w])) wider[p] = 1;
            }
        }
        blocked.set(wider);
    }

    const outside = new Uint8Array(total);
    const queue = new Int32Array(total);
    let head = 0, tail = 0;
    const push = (p) => { if (!outside[p] && !blocked[p]) { outside[p] = 1; queue[tail++] = p; } };
    for (let x = 0; x < w; x++) { push(x); push((h - 1) * w + x); }
    for (let y = 0; y < h; y++) { push(y * w); push(y * w + w - 1); }
    while (head < tail) {
        const p = queue[head++];
        const x = p % w, y = (p / w) | 0;
        if (x > 0) push(p - 1);
        if (x < w - 1) push(p + 1);
        if (y > 0) push(p - w);
        if (y < h - 1) push(p + w);
    }
    return { outside, blocked };
}

// Repaints only the box itself, leaving everything around it transparent.
//
// Painting every white pixel floods the whole sheet — the margins and the
// printed caption end up the box colour too, which is not what a mockup shows.
// The die-line encloses the panels, so a flood fill inward from the image border
// separates the two: white reachable from an edge is the sheet around the box,
// white the fill cannot reach is a panel.
//
// Panels are then painted and the surrounding sheet is dropped to transparent,
// keeping only its ink so the caption stays readable.
function bmRecolour(sourceCanvas, hex, region) {
    const w = sourceCanvas.width, h = sourceCanvas.height;
    const total = w * h;
    const [br, bg, bb] = bmHex(hex);
    const boxLum = 0.299 * br + 0.587 * bg + 0.114 * bb;
    // On a dark box, black ink on near-black card is invisible.
    const ink = boxLum < 110 ? [245, 245, 245] : [26, 26, 26];

    const ctx = sourceCanvas.getContext('2d');
    const img = ctx.getImageData(0, 0, w, h);
    const d = img.data;

    const lum = new Uint8Array(total);
    for (let p = 0; p < total; p++) {
        const i = p * 4;
        lum[p] = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    }

    // How much of the drawing we would expect a healthy fill to cover.
    const artArea = region
        ? Math.max(1, (region.right - region.left) * (region.bottom - region.top))
        : total;

    // Try progressively thicker lines until the panels stop leaking. A clean
    // die-line succeeds on the first pass and never pays for the rest.
    let best = null;
    for (const grow of [1, 2, 3, 5]) {
        const { outside } = bmFloodOutside(lum, w, h, grow);
        let painted = 0;
        const mask = new Uint8Array(total);
        for (let p = 0; p < total; p++) {
            if (!outside[p] && lum[p] > BM_WHITE) { mask[p] = 1; painted++; }
        }
        if (!best || painted > best.painted) best = { mask, painted };
        if (painted / artArea >= BM_MIN_PAINTED) break;
    }

    // Enclosed does not always mean panel: the counters inside caption letters —
    // the hole in an O or a Q — are enclosed too, and painting them speckles the
    // text. Panels and counters are far apart in size (measured: 5,000-44,000 px
    // against 13-16), so discarding small components is safe.
    const enclosed = best.mask;
    const label = new Int32Array(total);
    const queue = new Int32Array(total);
    const sizes = [0];
    let next = 1;
    for (let start = 0; start < total; start++) {
        if (!enclosed[start] || label[start]) continue;
        let count = 0, head = 0, tail = 0;
        queue[tail++] = start;
        label[start] = next;
        while (head < tail) {
            const p = queue[head++];
            count++;
            const x = p % w, y = (p / w) | 0;
            const step = (q) => { if (enclosed[q] && !label[q]) { label[q] = next; queue[tail++] = q; } };
            if (x > 0) step(p - 1);
            if (x < w - 1) step(p + 1);
            if (y > 0) step(p - w);
            if (y < h - 1) step(p + w);
        }
        sizes.push(count);
        next++;
    }
    let largest = 0;
    for (let i = 1; i < sizes.length; i++) if (sizes[i] > largest) largest = sizes[i];
    const minArea = Math.max(total * 0.0006, largest * 0.02);

    let panel = new Uint8Array(total);
    for (let p = 0; p < total; p++) if (label[p] && sizes[label[p]] >= minArea) panel[p] = 1;

    // Measure each panel that survived. Which one the logo is sitting on decides
    // which face of the folded box it belongs to, so the die-line's own layout
    // has to be readable, not just its total ink.
    const boxes = new Map();
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const p = y * w + x;
            const id = label[p];
            if (!id || sizes[id] < minArea) continue;
            let b = boxes.get(id);
            if (!b) { b = { id, minX: x, maxX: x, minY: y, maxY: y, area: sizes[id] }; boxes.set(id, b); }
            if (x < b.minX) b.minX = x;
            if (x > b.maxX) b.maxX = x;
            if (y < b.minY) b.minY = y;
            if (y > b.maxY) b.maxY = y;
        }
    }
    const panelBoxes = [...boxes.values()].map(function (b) {
        return { ...b, cx: (b.minX + b.maxX) / 2, cy: (b.minY + b.maxY) / 2,
                 width: b.maxX - b.minX + 1, height: b.maxY - b.minY + 1 };
    });

    // Grow over the cut lines so a panel edge is drawn on the box colour rather
    // than left stranded on the transparent sheet.
    for (let step = 0; step < BM_EDGE_GROW; step++) {
        const grown = new Uint8Array(panel);
        for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
                const p = y * w + x;
                if (panel[p]) continue;
                if ((x > 0 && panel[p - 1]) || (x < w - 1 && panel[p + 1])
                    || (y > 0 && panel[p - w]) || (y < h - 1 && panel[p + w])) grown[p] = 1;
            }
        }
        panel = grown;
    }

    for (let p = 0; p < total; p++) {
        const i = p * 4;
        const t = lum[p] / 255;
        if (panel[p]) {
            d[i] = ink[0] + (br - ink[0]) * t;
            d[i + 1] = ink[1] + (bg - ink[1]) * t;
            d[i + 2] = ink[2] + (bb - ink[2]) * t;
            d[i + 3] = 255;
        } else {
            // Off the box: keep the ink, drop the paper.
            d[i] = 26; d[i + 1] = 26; d[i + 2] = 26;
            d[i + 3] = Math.round((1 - t) * 255);
        }
    }
    ctx.putImageData(img, 0, 0);

    // Black-on-white copies of the two layers, for potrace to trace later. Built
    // here because this is where the panel/ink split is actually decided.
    const layerCanvas = (test) => {
        const c = document.createElement('canvas');
        c.width = w; c.height = h;
        const cctx = c.getContext('2d');
        const li = cctx.createImageData(w, h);
        const ld = li.data;
        for (let p = 0; p < total; p++) {
            const v = test(p) ? 0 : 255;
            const i = p * 4;
            ld[i] = v; ld[i + 1] = v; ld[i + 2] = v; ld[i + 3] = 255;
        }
        cctx.putImageData(li, 0, 0);
        return c;
    };

    return {
        canvas: sourceCanvas,
        panelBoxes,
        panelMask: layerCanvas((p) => panel[p]),
        inkMask: layerCanvas((p) => lum[p] <= BM_WHITE),
        ink: '#' + ink.map((n) => n.toString(16).padStart(2, '0')).join(''),
    };
}

// Finds where the die-line drawing ends and its printed caption begins.
//
// Every template has a block of text under the artwork, and a logo centred on
// the whole image would land in that text. Gap width is not a reliable way to
// split them — the blank band between drawing and caption can be as narrow as
// the leading between two caption lines.
//
// What does separate them cleanly is run length. A die-line is made of long
// continuous edges: a panel edge is a run of hundreds of dark pixels across a
// single row. Text is made of short strokes, a few pixels each, however bold it
// is. So the last row containing a long unbroken run marks the bottom of the
// drawing, and everything below it is caption. Measured on a template whose
// drawing rows carry runs of 200+ px against caption strokes under 15 px, the
// two populations do not overlap anywhere near the threshold.
const BM_STRUCTURAL_RUN = 0.15;   // fraction of image width

function bmArtworkRegion(sourceCanvas) {
    const w = sourceCanvas.width, h = sourceCanvas.height;
    const ctx = sourceCanvas.getContext('2d');
    const d = ctx.getImageData(0, 0, w, h).data;
    const minRun = Math.max(8, Math.round(w * BM_STRUCTURAL_RUN));

    const dark = (x, y) => {
        const i = (y * w + x) * 4;
        return (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]) < 160;
    };

    let firstStructural = -1;
    let lastStructural = -1;
    for (let y = 0; y < h; y++) {
        let run = 0;
        let structural = false;
        for (let x = 0; x < w; x++) {
            if (dark(x, y)) {
                run++;
                if (run >= minRun) { structural = true; break; }
            } else {
                run = 0;
            }
        }
        if (structural) {
            if (firstStructural === -1) firstStructural = y;
            lastStructural = y;
        }
    }

    // A template with no long edges at all (an unusual die-line, or a photo)
    // falls back to the full frame rather than placing the logo somewhere
    // arbitrary.
    if (firstStructural === -1) return { top: 0, bottom: h, left: 0, right: w };

    // Vertical panel edges sit between the horizontal ones and carry no long
    // horizontal run, so widen the band to whatever ink lies within it.
    let top = firstStructural, bottom = lastStructural + 1;
    let left = w, right = 0;
    for (let y = top; y < bottom; y++) {
        for (let x = 0; x < w; x++) {
            if (dark(x, y)) {
                if (x < left) left = x;
                if (x > right) right = x;
            }
        }
    }
    if (left > right) { left = 0; right = w; }
    return { top, bottom, left, right };
}

// Pixels per inch for the template. The flat die-line spans the box's length
// plus a wall on each side, which is the closest estimate available without
// hand-measuring every template; the logo stays draggable so it can be nudged.
function bmPixelsPerInch(tpl, region) {
    if (!tpl || !tpl.length) return null;
    const flatInches = tpl.length + 2 * (tpl.height || 0);
    if (!(flatInches > 0)) return null;
    return (region.right - region.left) / flatInches;
}

// ── Logo upload ──

const bmDrop = document.getElementById('bmDropzone');
const bmInput = document.getElementById('bmLogoFile');

function bmAcceptLogo(file) {
    const msg = document.getElementById('bmMsg');
    if (!file) return;
    if (!/^image\/(png|jpeg|webp)$/.test(file.type)) {
        showAdminMsg(msg, 'Only PNG, JPG or WEBP files are accepted.', true);
        return;
    }
    bmLogoFile = file;
    bmLogoUrl = null;               // force a fresh cutout for the new file
    bmDrop.classList.add('has-file');
    bmDrop.querySelector('.dropzone-text').innerHTML = '<strong>' + file.name + '</strong>';
    bmDrop.querySelector('.dropzone-sub').textContent = (file.size / 1048576).toFixed(2) + ' MB — click to choose another';
    showAdminMsg(msg, 'Ready. Press Generate Mockup.', false);
}

bmDrop.addEventListener('click', function () { bmInput.click(); });
bmDrop.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); bmInput.click(); }
});
bmInput.addEventListener('change', function () { bmAcceptLogo(this.files[0]); });
['dragenter', 'dragover'].forEach(function (evt) {
    bmDrop.addEventListener(evt, function (e) { e.preventDefault(); bmDrop.classList.add('dragging'); });
});
['dragleave', 'drop'].forEach(function (evt) {
    bmDrop.addEventListener(evt, function (e) { e.preventDefault(); bmDrop.classList.remove('dragging'); });
});
bmDrop.addEventListener('drop', function (e) {
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) bmAcceptLogo(f);
});

// Reuses the same server-side cutout the other tabs use, so "background removed"
// means the same thing everywhere.
async function bmCutoutLogo(file) {
    const form = new FormData();
    form.append('logo', file);
    const res = await fetch(BACKEND_URL + '/remove-bg', { method: 'POST', body: form });
    if (!res.ok) throw new Error('Could not remove the logo background (' + res.status + ').');
    const blob = await res.blob();
    return await new Promise(function (resolve, reject) {
        const url = URL.createObjectURL(blob);
        const img = new Image();
        img.onload = function () {
            const c = document.createElement('canvas');
            c.width = img.naturalWidth; c.height = img.naturalHeight;
            c.getContext('2d').drawImage(img, 0, 0);
            URL.revokeObjectURL(url);
            resolve(trimCanvasToVisibleBounds(c));   // from boxscript.js
        };
        img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('Could not read the cut-out logo.')); };
        img.src = url;
    });
}

// Applies the printing colour, exactly as the Create Mockup tab does: pixels
// below the alpha floor are cleared rather than painted, so a soft matte edge
// does not become a coloured haze.
function bmApplyPrintingColour(dataUrl, printing) {
    if (!printing || printing.toLowerCase() === 'none') return Promise.resolve(dataUrl);
    const rgb = colorMap[printing.toLowerCase()];
    if (!rgb) return Promise.resolve(dataUrl);
    return new Promise(function (resolve) {
        const img = new Image();
        img.onload = function () {
            const c = document.createElement('canvas');
            c.width = img.naturalWidth; c.height = img.naturalHeight;
            const ctx = c.getContext('2d');
            ctx.drawImage(img, 0, 0);
            const d = ctx.getImageData(0, 0, c.width, c.height);
            const px = d.data;
            for (let i = 0; i < px.length; i += 4) {
                if (px[i + 3] <= 24) { px[i + 3] = 0; continue; }
                px[i] = rgb[0]; px[i + 1] = rgb[1]; px[i + 2] = rgb[2];
            }
            ctx.putImageData(d, 0, 0);
            resolve(c.toDataURL('image/png'));
        };
        img.src = dataUrl;
    });
}

// Print wants 300 DPI. A raster die-line cannot be given detail it never had, so
// this only lifts vector templates — but for those it is the whole difference
// between a usable file and a soft one.
const BM_TARGET_DPI = 300;
const BM_MAX_RASTER = 4200;   // keeps a 15-inch sheet from becoming unworkable

function bmTargetPixels(tpl) {
    const flatInches = (tpl.length || 0) + 2 * (tpl.height || 0);
    if (!(flatInches > 0)) return tpl.pixelWidth || 1200;
    return Math.min(BM_MAX_RASTER, Math.max(tpl.pixelWidth || 0, Math.round(flatInches * BM_TARGET_DPI)));
}

// Rasterises a vector die-line at whatever size we ask for.
//
// The SVG is fetched as text and its width/height rewritten before it is handed
// to the browser, because an <img> rasterises an SVG at its own declared size and
// then scales that bitmap — drawing it larger on the canvas would just enlarge a
// small rendering. A viewBox is added when the file lacks one, or changing
// width/height resizes the canvas without scaling what is drawn on it. The blob
// is same-origin, so the canvas stays readable for the mask work.
async function bmLoadVectorTemplate(tpl, targetW, targetH) {
    const res = await fetch(BACKEND_URL + '/box-template-image/' + tpl.id);
    if (!res.ok) throw new Error('Could not load the die-line (' + res.status + ').');
    let text = await res.text();

    if (!/viewBox\s*=/i.test(text)) {
        text = text.replace(/<svg\b/i, '<svg viewBox="0 0 ' + (tpl.pixelWidth || targetW) + ' ' + (tpl.pixelHeight || targetH) + '"');
    }
    text = text.replace(/<svg\b([^>]*)>/i, function (m, attrs) {
        const cleaned = attrs
            .replace(/\s+width\s*=\s*(["'])[^"']*\1/i, '')
            .replace(/\s+height\s*=\s*(["'])[^"']*\1/i, '');
        return '<svg' + cleaned + ' width="' + targetW + '" height="' + targetH + '">';
    });

    const url = URL.createObjectURL(new Blob([text], { type: 'image/svg+xml' }));
    try {
        return await new Promise(function (resolve, reject) {
            const img = new Image();
            img.onload = function () { resolve(img); };
            img.onerror = function () { reject(new Error('That SVG die-line could not be rendered.')); };
            img.src = url;
        });
    } finally {
        // Revoked after decode; the canvas keeps its own copy of the pixels.
        setTimeout(function () { URL.revokeObjectURL(url); }, 0);
    }
}

function bmLoadImage(src) {
    return new Promise(function (resolve, reject) {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = function () { resolve(img); };
        img.onerror = function () { reject(new Error('Could not load the template image.')); };
        img.src = src;
    });
}

// ── Generate ──

document.getElementById('bmGenerate').addEventListener('click', async function () {
    const msg = document.getElementById('bmMsg');
    const tpl = bmSelectedTemplate();
    const colour = document.getElementById('bmColor').value;
    const printing = document.getElementById('bmPrintColor').value;

    if (!tpl) { showAdminMsg(msg, 'Choose a box style and type first.', true); return; }
    if (!colour) { showAdminMsg(msg, 'Choose a box colour.', true); return; }
    if (!bmLogoFile) { showAdminMsg(msg, 'Upload a logo first.', true); return; }

    const wantLen = parseFloat(document.getElementById('bmLogoLength').value);
    const wantBre = parseFloat(document.getElementById('bmLogoBreadth').value);
    if (!(wantLen > 0) || !(wantBre > 0)) { showAdminMsg(msg, 'Enter a logo length and breadth in inches.', true); return; }

    this.disabled = true;
    const label = this.textContent;
    this.textContent = 'Generating…';
    showAdminMsg(msg, 'Removing the logo background and placing it…', false);

    try {
        if (!bmLogoUrl) bmLogoUrl = await bmCutoutLogo(bmLogoFile);
        const coloured = await bmApplyPrintingColour(bmLogoUrl, printing);
        bmLogoSource = coloured;

        // Work at print resolution where the source allows it. A vector die-line
        // is rasterised to the size we actually want; a raster one is used as-is,
        // since enlarging it would only make a soft picture bigger.
        const rasterW = bmTargetPixels(tpl);
        const aspect = (tpl.pixelHeight && tpl.pixelWidth) ? tpl.pixelHeight / tpl.pixelWidth : 1;
        const tplImg = tpl.vector
            ? await bmLoadVectorTemplate(tpl, rasterW, Math.round(rasterW * aspect))
            : await bmLoadImage(BACKEND_URL + '/box-template-image/' + tpl.id);

        // Recolour at that resolution, then scale down for display so the export
        // can go back up to full size without re-reading anything.
        const full = document.createElement('canvas');
        full.width = tplImg.naturalWidth || rasterW;
        full.height = tplImg.naturalHeight || Math.round(rasterW * aspect);
        const fullCtx = full.getContext('2d');
        // White ground first. A vector die-line is line work on transparency, and
        // an unpainted canvas reads as rgb(0,0,0) — so every pixel looked like
        // ink, nothing was left for the fill to reach, and the whole export came
        // out solid dark. A raster template is opaque and covers this anyway.
        fullCtx.fillStyle = '#ffffff';
        fullCtx.fillRect(0, 0, full.width, full.height);
        fullCtx.drawImage(tplImg, 0, 0, full.width, full.height);
        const region = bmArtworkRegion(full);
        const layers = bmRecolour(full, colour, region);

        // Reveal the result first: a hidden element measures zero wide.
        document.getElementById('bmPlaceholder').style.display = 'none';
        document.getElementById('bmResultWrap').style.display = 'block';

        const wrap = document.querySelector('.bm-canvas-wrap');
        const styles = window.getComputedStyle(wrap);
        const inner = wrap.clientWidth
            - parseFloat(styles.paddingLeft || 0) - parseFloat(styles.paddingRight || 0);
        const displayWidth = Math.max(BM_CANVAS_MIN, Math.min(BM_CANVAS_MAX, Math.floor(inner) || BM_CANVAS_MIN));
        const scale = displayWidth / full.width;
        bmExportMultiplier = 1 / scale;
        const dispW = Math.round(full.width * scale);
        const dispH = Math.round(full.height * scale);

        if (!bmCanvas) {
            bmCanvas = new fabric.Canvas('bmCanvas', { preserveObjectStacking: true });
            // Live link to the 3D preview. 'moving'/'scaling' fire continuously,
            // so the repaint is throttled to a frame; 'modified' catches the
            // final position once the pointer is released.
            let queued = false;
            const follow = function () {
                if (queued) return;
                queued = true;
                requestAnimationFrame(function () { queued = false; bm3dSyncFromCanvas(); });
            };
            bmCanvas.on('object:moving', follow);
            bmCanvas.on('object:scaling', follow);
            bmCanvas.on('object:rotating', follow);
            bmCanvas.on('object:modified', bm3dSyncFromCanvas);
        }
        bmCanvas.clear();
        bmCanvas.setDimensions({ width: dispW, height: dispH });
        bmCanvas.setBackgroundImage(full.toDataURL('image/png'), bmCanvas.renderAll.bind(bmCanvas), {
            scaleX: scale, scaleY: scale,
        });

        const logoImg = await bmLoadImage(coloured);
        bmLogoNatural = { w: logoImg.naturalWidth, h: logoImg.naturalHeight };

        const ppi = bmPixelsPerInch(tpl, region);
        let targetW;
        let sizeNote;
        if (ppi) {
            targetW = wantLen * ppi * scale;
            sizeNote = wantLen + '×' + wantBre + ' in at ' + ppi.toFixed(0) + ' px/in';
        } else {
            // No usable size on the template, so fall back to a share of the panel
            // rather than guessing an inch scale that would be wrong.
            targetW = (region.right - region.left) * scale * 0.35;
            sizeNote = 'template has no size, placed at 35% of panel width';
        }
        const keepRatio = document.getElementById('bmKeepRatio').checked;
        const targetH = keepRatio
            ? targetW * (bmLogoNatural.h / bmLogoNatural.w)
            : wantBre * (ppi || 1) * scale;

        fabric.Image.fromURL(coloured, function (obj) {
            obj.set({
                left: ((region.left + region.right) / 2) * scale,
                top: ((region.top + region.bottom) / 2) * scale,
                originX: 'center',
                originY: 'center',
                scaleX: targetW / bmLogoNatural.w,
                scaleY: targetH / bmLogoNatural.h,
                cornerColor: '#2563eb',
                borderColor: '#2563eb',
                transparentCorners: false,
            });
            bmLogoObject = obj;
            bmCanvas.add(obj);
            bmCanvas.setActiveObject(obj);
            bmCanvas.renderAll();
        });

        const printRgb = colorMap[(printing || '').toLowerCase()];
        bmLastRender = {
            panelMask: layers.panelMask,
            inkMask: layers.inkMask,
            width: full.width,
            height: full.height,
            boxColor: colour,
            inkColor: layers.ink,
            printColor: printRgb
                ? '#' + printRgb.map(function (n) { return n.toString(16).padStart(2, '0'); }).join('')
                : null,
            scale: scale,
        };

        // Quality is worth stating rather than leaving to be discovered on the
        // printer: the number here is what the download is actually worth.
        const flatInches = (tpl.length || 0) + 2 * (tpl.height || 0);
        const dpi = flatInches > 0 ? Math.round(full.width / flatInches) : null;

        const colourName = document.getElementById('bmColorName').textContent;
        document.getElementById('bmMeta').textContent =
            tpl.styleLabel + (tpl.typeLabel ? ' · ' + tpl.typeLabel : '') + ' · ' + colourName
            + ' · ' + sizeNote
            + (dpi ? ' · ' + dpi + ' DPI' + (tpl.vector ? ' vector' : (dpi < 200 ? ' — upload the SVG die-line for print quality' : '')) : '')
            + ' · drag or resize the logo to adjust';

        // Fold the same box in 3D. The logo is sized as a fraction of the lid so
        // it stays true to the inches entered, not to the die-line's pixels.
        try {
            const lidL = tpl.length || 0;
            const lidW = tpl.width || 0;
            const twoPiece = bmIsTopBottom(tpl.styleLabel);
            const allow = twoPiece ? BM_LID_ALLOWANCE : 0;
            const logoWIn = wantLen;
            const logoHIn = keepRatio ? wantLen * (bmLogoNatural.h / bmLogoNatural.w) : wantBre;

            // Everything the live position update needs, so dragging the logo does
            // not have to re-derive the geometry. The panel map is the important
            // part: it is what lets a logo dragged onto a side wing appear on
            // that wall rather than being pinned to the lid.
            bm3dContext = {
                scale: scale,
                faces: bmClassifyFaces(layers.panelBoxes),
            };

            const placement = bm3dLogoPlacement();
            bmRender3D(
                { length: lidL || 2, width: lidW || 2, height: tpl.height || 1 },
                colour,
                logoImg,
                placement,
                { separateLid: twoPiece }
            );
            const faceName = {
                top: 'the lid', left: 'the left wall', right: 'the right wall',
                front: 'the front wall', back: 'the back wall',
            }[placement.face] || 'the lid';
            document.getElementById('bm3dMeta').textContent = (lidL && lidW)
                ? lidL + '×' + lidW + '×' + (tpl.height || 0) + ' in · logo on ' + faceName + ' at '
                  + logoWIn.toFixed(2) + '×' + logoHIn.toFixed(2) + ' in'
                  + (twoPiece ? ' · lid covers the base, ' + BM_LID_ALLOWANCE + ' in oversize to clear it' : '')
                : 'This template has no size on it, so the proportions are approximate.';
        } catch (err) {
            // A 3D failure must not cost the user the mockup they just made.
            console.warn('3D preview unavailable:', err);
            document.getElementById('bm3dStage').style.display = 'none';
            document.getElementById('bm3dPlaceholder').style.display = 'flex';
            document.getElementById('bm3dMeta').textContent = '3D preview unavailable in this browser.';
        }
        showAdminMsg(msg, 'Done — drag the logo if it needs nudging, then download.', false);
    } catch (err) {
        showAdminMsg(msg, err.message, true);
    } finally {
        this.disabled = false;
        this.textContent = label;
    }
});

document.getElementById('bmDownload').addEventListener('click', function () {
    if (!bmCanvas) return;
    bmCanvas.discardActiveObject();
    bmCanvas.renderAll();
    // Export at the template's real resolution, not the on-screen size.
    const url = bmCanvas.toDataURL({ format: 'png', multiplier: bmExportMultiplier });
    const tpl = bmSelectedTemplate();
    const name = (tpl ? tpl.id : 'mockup') + '-mockup.png';
    const a = document.createElement('a');
    a.href = url; a.download = name; a.click();
});

// Vector export. Each layer is traced separately on the server and returned as
// individually selectable paths, so the file opens in CorelDRAW as real curves
// that can be ungrouped — not a PNG in an SVG wrapper.
function bmCanvasToBlob(canvas) {
    return new Promise(function (resolve) { canvas.toBlob(resolve, 'image/png'); });
}

function bmDataUrlToBlob(dataUrl) {
    const [head, body] = dataUrl.split(',');
    const mime = /:(.*?);/.exec(head)[1];
    const bin = atob(body);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: mime });
}

document.getElementById('bmDownloadSvg').addEventListener('click', async function () {
    const msg = document.getElementById('bmMsg');
    if (!bmLastRender) { showAdminMsg(msg, 'Generate a mockup first.', true); return; }

    this.disabled = true;
    const label = this.textContent;
    this.textContent = 'Tracing…';
    showAdminMsg(msg, 'Tracing the die-line and logo into vector paths…', false);

    try {
        const form = new FormData();
        form.append('panelMask', await bmCanvasToBlob(bmLastRender.panelMask), 'panel.png');
        form.append('inkMask', await bmCanvasToBlob(bmLastRender.inkMask), 'ink.png');
        form.append('width', String(bmLastRender.width));
        form.append('height', String(bmLastRender.height));
        form.append('boxColor', bmLastRender.boxColor);
        form.append('inkColor', bmLastRender.inkColor);
        if (bmLastRender.printColor) form.append('printColor', bmLastRender.printColor);

        // Take the placement off the canvas, not from the form: the logo may have
        // been dragged or resized since it was generated.
        if (bmLogoObject && bmLogoSource) {
            const s = bmLastRender.scale;
            const w = bmLogoObject.width * bmLogoObject.scaleX;
            const h = bmLogoObject.height * bmLogoObject.scaleY;
            form.append('logo', bmDataUrlToBlob(bmLogoSource), 'logo.png');
            form.append('logoX', String((bmLogoObject.left - w / 2) / s));
            form.append('logoY', String((bmLogoObject.top - h / 2) / s));
            form.append('logoW', String(w / s));
            form.append('logoH', String(h / s));
        }

        const res = await fetch(BACKEND_URL + '/api/mockup/svg', {
            method: 'POST', headers: adminAuthHeaders(), body: form,
        });
        const data = await res.json().catch(function () { return {}; });
        if (!res.ok) throw new Error(data.error || 'Vector export failed (' + res.status + ').');

        const tpl = bmSelectedTemplate();
        const blob = new Blob([data.svg], { type: 'image/svg+xml' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = (tpl ? tpl.id : 'mockup') + '-mockup.svg';
        a.click();
        URL.revokeObjectURL(url);

        const objects = (data.svg.match(/<path/g) || []).length;
        showAdminMsg(msg, 'Vector downloaded — ' + objects + ' separate objects, ungroup in CorelDRAW to edit them.', false);
    } catch (err) {
        showAdminMsg(msg, err.message, true);
    } finally {
        this.disabled = false;
        this.textContent = label;
    }
});

document.getElementById('bmStyle').addEventListener('change', bmRefreshTypeOptions);

document.getElementById('bmGoUpload').addEventListener('click', function () {
    const d = document.getElementById('bmTplDetails');
    d.open = true;
    d.scrollIntoView({ behavior: 'smooth', block: 'center' });
});

// ── Template management ──

function bmRenderTemplateList() {
    const wrap = document.getElementById('bmTplList');
    if (!bmTemplates.length) {
        wrap.innerHTML = '<p class="convert-advanced-hint">No die-lines uploaded yet.</p>';
        return;
    }
    wrap.innerHTML = '';
    bmTemplates.forEach(function (t) {
        const row = document.createElement('div');
        row.className = 'admin-list-item';
        const label = document.createElement('span');
        label.className = 'admin-meta';
        label.textContent = t.styleLabel + (t.typeLabel ? ' · ' + t.typeLabel : '') + (t.sizeLabel ? ' · ' + t.sizeLabel : '');
        const del = document.createElement('button');
        del.type = 'button';
        del.className = 'admin-btn-delete';
        del.textContent = 'Remove';
        del.addEventListener('click', async function () {
            const msg = document.getElementById('bmTplMsg');
            del.disabled = true;
            try {
                const res = await fetch(BACKEND_URL + '/admin/box-template/' + encodeURIComponent(t.id), {
                    method: 'DELETE', headers: adminAuthHeaders(),
                });
                const data = await res.json();
                if (!res.ok) throw new Error(data.error || 'Delete failed.');
                bmTemplates = data.templates || [];
                bmRefreshStyleOptions();
                bmRenderTemplateList();
                showAdminMsg(msg, 'Deleted.', false);
            } catch (err) {
                showAdminMsg(msg, err.message, true);
                del.disabled = false;
            }
        });
        row.appendChild(label);
        row.appendChild(del);
        wrap.appendChild(row);
    });
}

document.getElementById('bmTplUpload').addEventListener('click', async function () {
    const msg = document.getElementById('bmTplMsg');
    const files = [...document.getElementById('bmTplFile').files];
    if (!files.length) { showAdminMsg(msg, 'Choose at least one die-line image first.', true); return; }

    // The manual overrides only make sense for a single file — with several
    // selected, every caption is read from its own artwork.
    const overrides = {};
    if (files.length === 1) {
        ['Style', 'Type', 'Size'].forEach(function (k) {
            const v = document.getElementById('bmTpl' + k).value.trim();
            if (v) overrides[k.toLowerCase() + 'Label'] = v;
        });
    }

    this.disabled = true;
    const label = this.textContent;
    const done = [];
    const failed = [];

    try {
        for (let i = 0; i < files.length; i++) {
            this.textContent = files.length > 1 ? ('Uploading ' + (i + 1) + ' of ' + files.length + '…') : 'Uploading…';
            showAdminMsg(msg, 'Reading the caption off ' + files[i].name + '…', false);

            const form = new FormData();
            form.append('template', files[i]);
            Object.keys(overrides).forEach(function (k) { form.append(k, overrides[k]); });

            try {
                const res = await fetch(BACKEND_URL + '/admin/box-template', {
                    method: 'POST', headers: adminAuthHeaders(), body: form,
                });
                const data = await res.json();
                if (!res.ok) throw new Error(data.error || 'upload failed');
                bmTemplates = data.templates || [];
                const t = data.template;
                done.push(t.styleLabel + (t.typeLabel ? ' · ' + t.typeLabel : '') + (t.sizeLabel ? ' · ' + t.sizeLabel : ''));
            } catch (err) {
                // One bad file must not abandon the rest of the batch.
                failed.push(files[i].name + ' (' + err.message + ')');
            }
            bmRefreshStyleOptions();
            bmRenderTemplateList();
        }

        if (done.length && !failed.length) {
            showAdminMsg(msg, 'Saved ' + done.length + ': ' + done.join(', '), false);
            document.getElementById('bmTplFile').value = '';
            ['Style', 'Type', 'Size'].forEach(function (k) { document.getElementById('bmTpl' + k).value = ''; });
        } else if (done.length) {
            showAdminMsg(msg, 'Saved ' + done.length + ', but these failed: ' + failed.join('; '), true);
        } else {
            showAdminMsg(msg, 'Nothing saved: ' + failed.join('; '), true);
        }
    } finally {
        this.disabled = false;
        this.textContent = label;
    }
});

bmPopulateColours();

// ── 3D preview ───────────────────────────────────────────────────────────────
//
// A folded view of the same box the flat die-line describes: its real length,
// width and height, its colour, and the logo on the lid at the size that was
// asked for. Built with three.js because a lit, perspective solid reads as a box
// in a way a CSS-transformed cube does not, and it can be turned to check the
// logo from another angle.

let bm3d = null;   // { renderer, scene, camera, mesh, frame, observer }

// Paints one face. The lid also carries the logo, sized as a fraction of the
// face rather than in pixels, so it stays true to the inches that were entered
// whatever texture resolution is used.
function bm3dFaceTexture(hex, faceW, faceH, logoImage, logoFrac) {
    const LONG = 1024;
    const ratio = faceH / faceW;
    const c = document.createElement('canvas');
    c.width = LONG;
    c.height = Math.max(8, Math.round(LONG * ratio));
    const ctx = c.getContext('2d');
    ctx.fillStyle = hex;
    ctx.fillRect(0, 0, c.width, c.height);

    if (logoImage && logoFrac) {
        const lw = c.width * logoFrac.w;
        const lh = c.height * logoFrac.h;
        // x/y are offsets from the centre of the face, as a fraction of it, so
        // moving the logo on the flat mockup moves it on the face by the same
        // amount.
        const cx = c.width * (0.5 + (logoFrac.x || 0));
        const cy = c.height * (0.5 + (logoFrac.y || 0));
        // Turned about its own centre, matching the flat mockup. This canvas is
        // built to the face's aspect ratio, so its pixels are square against the
        // face and an angle here is the same angle on the box — no correction
        // needed for the face being oblong.
        const angle = ((logoFrac.angle || 0) * Math.PI) / 180;
        ctx.save();
        ctx.translate(cx, cy);
        if (angle) ctx.rotate(angle);
        ctx.drawImage(logoImage, -lw / 2, -lh / 2, lw, lh);
        ctx.restore();
    }

    const tex = new THREE.Texture(c);
    tex.needsUpdate = true;
    tex.anisotropy = 4;
    return tex;
}

function bm3dDispose() {
    if (!bm3d) return;
    cancelAnimationFrame(bm3d.frame);
    if (bm3d.observer) bm3d.observer.disconnect();
    (bm3d.meshes || []).forEach(function (m) {
        m.geometry.dispose();
        (Array.isArray(m.material) ? m.material : [m.material]).forEach(function (mat) {
            if (mat.map) mat.map.dispose();
            mat.dispose();
        });
    });
    bm3d.renderer.dispose();
    if (bm3d.renderer.domElement.parentNode) {
        bm3d.renderer.domElement.parentNode.removeChild(bm3d.renderer.domElement);
    }
    bm3d = null;
}

// A TOP-BOTTOM box is two pieces, not one solid: a base, and a lid that slides
// over it. The lid is cut slightly larger in both horizontal directions so it
// clears the base walls — the standard allowance is a quarter inch — which is
// why a real one has a visible lip and a seam partway down the side. Modelling
// it as a single block hid exactly the detail the customer is looking at.
const BM_LID_ALLOWANCE = 0.25;   // inches added to length and width
// The lid runs the full assembled height: it telescopes right down over the
// base and covers it completely, so a closed box shows no seam, no step and no
// strip of base along the bottom. Anything less left a visible joint partway
// down the side, which is not what these boxes look like shut.
const BM_LID_HEIGHT_FRACTION = 1;
// The base is a touch shorter so it sits inside the lid rather than holding it
// off the ground and reopening the gap the full-height lid exists to remove.
const BM_BASE_HEIGHT_FRACTION = 0.94;
// Board has a thickness and a crease; nothing folded from paper has a
// mathematically sharp corner. Rounding by a small fraction of the shortest edge
// is most of what separates a rendered box from a rendered cube.
const BM_CORNER_ROUND = 0.045;

// A box with softened edges.
//
// three's RoundedBoxGeometry lives in examples/, which the UMD build on the CDN
// does not carry, so this rounds a segmented BoxGeometry directly: each vertex is
// pushed out from the nearest point on an inset box, which leaves flat faces flat
// and curves only the edges and corners. Face UVs are untouched, so the logo
// still lands where it should.
function bmRoundedBox(w, h, d, radius) {
    const r = Math.min(radius, w / 2, h / 2, d / 2);
    const geo = new THREE.BoxGeometry(w, h, d, 5, 5, 5);
    const pos = geo.attributes.position;
    const ix = w / 2 - r, iy = h / 2 - r, iz = d / 2 - r;
    const v = new THREE.Vector3();
    const inner = new THREE.Vector3();
    for (let i = 0; i < pos.count; i++) {
        v.fromBufferAttribute(pos, i);
        inner.set(
            Math.max(-ix, Math.min(ix, v.x)),
            Math.max(-iy, Math.min(iy, v.y)),
            Math.max(-iz, Math.min(iz, v.z))
        );
        v.sub(inner);
        if (v.lengthSq() > 1e-10) v.setLength(r);
        v.add(inner);
        pos.setXYZ(i, v.x, v.y, v.z);
    }
    geo.computeVertexNormals();
    return geo;
}

// A soft contact shadow so the box sits on something instead of floating.
function bmShadowPlane(spanX, spanZ) {
    const c = document.createElement('canvas');
    c.width = c.height = 256;
    const ctx = c.getContext('2d');
    const g = ctx.createRadialGradient(128, 128, 8, 128, 128, 126);
    g.addColorStop(0, 'rgba(15,23,42,0.46)');
    g.addColorStop(0.5, 'rgba(15,23,42,0.18)');
    g.addColorStop(1, 'rgba(15,23,42,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 256, 256);
    const tex = new THREE.Texture(c);
    tex.needsUpdate = true;
    const mesh = new THREE.Mesh(
        new THREE.PlaneGeometry(spanX, spanZ),
        new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false })
    );
    mesh.rotation.x = -Math.PI / 2;
    return mesh;
}

function bmIsTopBottom(styleLabel) {
    const t = String(styleLabel || '').toUpperCase();
    return t.indexOf('TOP') !== -1 && t.indexOf('BOTTOM') !== -1;
}

// Works out which panel of the die-line is which face of the folded box.
//
// The largest panel is the one the lid is printed on. The others are read off
// its edges: a panel sitting to its left, overlapping it vertically, folds up as
// the left wall, and so on. That is the whole reason this exists — a logo
// dragged onto a side wing has to appear on that wall in 3D, not be clamped back
// onto the lid because the lid is the only face we bothered to map.
function bmClassifyFaces(panelBoxes) {
    if (!panelBoxes || !panelBoxes.length) return null;
    const sorted = [...panelBoxes].sort(function (a, b) { return b.area - a.area; });
    const main = sorted[0];
    const faces = { top: main, left: null, right: null, front: null, back: null };

    const overlaps = (a1, a2, b1, b2) => Math.min(a2, b2) - Math.max(a1, b1) > 0;

    sorted.slice(1).forEach(function (b) {
        const dx = b.cx - main.cx;
        const dy = b.cy - main.cy;
        if (Math.abs(dx) > Math.abs(dy)) {
            // Must share rows with the lid, or a corner ear would be mistaken
            // for a wall.
            if (!overlaps(b.minY, b.maxY, main.minY, main.maxY)) return;
            const key = dx < 0 ? 'left' : 'right';
            if (!faces[key] || Math.abs(b.cx - main.cx) < Math.abs(faces[key].cx - main.cx)) faces[key] = b;
        } else {
            if (!overlaps(b.minX, b.maxX, main.minX, main.maxX)) return;
            const key = dy < 0 ? 'back' : 'front';
            if (!faces[key] || Math.abs(b.cy - main.cy) < Math.abs(faces[key].cy - main.cy)) faces[key] = b;
        }
    });
    return faces;
}

// Which face the logo is on, and where within it.
//
// Position and size are expressed against the panel's own box rather than
// converted through inches, because that panel IS the face — mapping one
// rectangle onto the other keeps the logo exactly where it was put, at the size
// it was drawn.
function bm3dLogoPlacement() {
    const c = bm3dContext;
    const fallback = { face: 'top', w: 0.5, h: 0.25, x: 0, y: 0 };
    if (!c || !c.faces || !bmLogoObject) return fallback;

    const cx = bmLogoObject.left / c.scale;
    const cy = bmLogoObject.top / c.scale;
    const lw = (bmLogoObject.width * bmLogoObject.scaleX) / c.scale;
    const lh = (bmLogoObject.height * bmLogoObject.scaleY) / c.scale;

    const entries = Object.keys(c.faces)
        .filter(function (k) { return c.faces[k]; })
        .map(function (k) { return { key: k, box: c.faces[k] }; });
    if (!entries.length) return fallback;

    // Prefer the panel the logo actually sits inside; otherwise the nearest, so
    // a logo over a fold line or an ear still lands somewhere sensible.
    let chosen = entries.find(function (e) {
        return cx >= e.box.minX && cx <= e.box.maxX && cy >= e.box.minY && cy <= e.box.maxY;
    });
    if (!chosen) {
        let best = Infinity;
        entries.forEach(function (e) {
            const d = Math.pow(cx - e.box.cx, 2) + Math.pow(cy - e.box.cy, 2);
            if (d < best) { best = d; chosen = e; }
        });
    }

    const b = chosen.box;
    return {
        face: chosen.key,
        // Unrotated dimensions: the turn is applied when the face is painted, so
        // measuring the turned bounding box here would swell the logo as it spun.
        w: Math.min(0.98, lw / b.width),
        h: Math.min(0.98, lh / b.height),
        x: Math.max(-0.5, Math.min(0.5, (cx - b.cx) / b.width)),
        y: Math.max(-0.5, Math.min(0.5, (cy - b.cy) / b.height)),
        angle: bmLogoObject.angle || 0,
    };
}

// A flat panel lying in the XZ plane, printed side up. Every piece of the box is
// one of these; folding is done by the group each one hangs from.
function bmPanel(sizeX, sizeZ, material) {
    const g = new THREE.PlaneGeometry(sizeX, sizeZ);
    g.rotateX(-Math.PI / 2);
    return new THREE.Mesh(g, material);
}

// Builds one tray — a base or a lid — as a centre panel with four walls on
// hinges, plus the corner ears that hold a real tray together.
//
// The walls are not part of the centre panel's geometry: each hangs from a group
// positioned exactly on its fold line, so folding is a rotation of that group
// rather than a morph between two shapes. That is what makes the open state a
// true die-line — the flat layout is the same panels, just unfolded.
// `dirSign` is +1 for a base, whose walls fold up, and -1 for a lid, whose walls
// fold down. A lid is not a flipped base: its printed face is the outside, so it
// lies print-up on the sheet and stays print-up on the box — the walls simply
// crease the other way. Turning the whole lid over instead put the camera behind
// its centre panel, and a double-sided plane seen from behind shows its texture
// mirrored, which is why the logo read backwards.
// `floor` optionally widens just the centre panel beyond the walls. The base
// needs that: its walls are cut narrower so the lid can slide over them, which
// leaves a ring of daylight between the two at the bottom rim — real board
// closes that with its own thickness, but a zero-thickness plane cannot, so you
// could see straight into the box whenever it was tilted. Widening the floor to
// the lid's own footprint seals the underside without moving any wall.
function bmBuildTray(L, W, H, hex, logoImage, logoFrac, dirSign, floor) {
    const dir = dirSign === -1 ? -1 : 1;
    const floorL = (floor && floor.L) || L;
    const floorW = (floor && floor.W) || W;
    const group = new THREE.Group();
    const mat = (fw, fh, img, frac) => new THREE.MeshLambertMaterial({
        map: bm3dFaceTexture(hex, fw, fh, img, frac),
        side: THREE.DoubleSide,
    });

    // Every face keeps a handle on its material and its real size, so the logo
    // can be repainted onto whichever one it has been dragged to.
    const faceInfo = {};
    const onFace = (key) => (logoFrac && logoFrac.face === key ? logoFrac : null);

    const centreMaterial = mat(floorL, floorW, logoImage, onFace('top'));
    faceInfo.top = { material: centreMaterial, w: floorL, h: floorW };
    group.add(bmPanel(floorL, floorW, centreMaterial));

    const hinges = [];
    const ears = [];

    // +X and -X walls fold about the Z axis; +Z and -Z about the X axis.
    const makeWall = (key, pos, panelOffset, size, axis, sign) => {
        const hinge = new THREE.Group();
        hinge.position.set(pos[0], 0, pos[2]);
        const material = mat(size[0], size[1], logoImage, onFace(key));
        faceInfo[key] = { material, w: size[0], h: size[1] };
        const panel = bmPanel(size[0], size[1], material);
        panel.position.set(panelOffset[0], 0, panelOffset[2]);
        hinge.add(panel);
        group.add(hinge);
        hinges.push({ hinge, axis, sign });
        return hinge;
    };

    const right = makeWall('right', [L / 2, 0, 0], [H / 2, 0, 0], [H, W], 'z', 1);
    const left = makeWall('left', [-L / 2, 0, 0], [-H / 2, 0, 0], [H, W], 'z', -1);
    makeWall('front', [0, 0, W / 2], [0, 0, H / 2], [L, H], 'x', -1);
    makeWall('back', [0, 0, -W / 2], [0, 0, -H / 2], [L, H], 'x', 1);

    // Corner ears: hinged on the ends of the side walls, folding inward to sit
    // against the end walls. They are children of the wall hinge, so they inherit
    // the wall's fold and only add their own on top.
    const earDepth = Math.min(H * 0.92, W * 0.30);
    [[right, 1], [left, -1]].forEach(function (pair) {
        const wall = pair[0];
        [1, -1].forEach(function (zSign) {
            const earHinge = new THREE.Group();
            // Hinged a hair inside the end wall's fold line. Exactly on it the
            // folded ear ends up coplanar with that wall and the two z-fight,
            // which showed as a nick in the corner of the closed box.
            earHinge.position.set(pair[1] * H / 2, 0, zSign * (W / 2 - W * 0.012));
            // Slightly shorter than the wall it hangs from. At exactly the wall
            // height the ear's own edge showed past the fold as a tab sticking
            // out of the closed box.
            const ear = bmPanel(H * 0.94, earDepth, mat(H, earDepth));
            ear.position.set(0, 0, zSign * earDepth / 2);
            earHinge.add(ear);
            wall.add(earHinge);
            ears.push({ hinge: earHinge, zSign });
        });
    });

    function setFold(t) {
        const a = (Math.PI / 2) * t * dir;
        hinges.forEach(function (h) {
            h.hinge.rotation.set(0, 0, 0);
            if (h.axis === 'z') h.hinge.rotation.z = h.sign * a;
            else h.hinge.rotation.x = h.sign * a;
        });
        // Ears tuck in slightly behind the walls, so they trail the main fold.
        const et = Math.max(0, (t - 0.35) / 0.65);
        ears.forEach(function (e) {
            e.hinge.rotation.x = -e.zSign * (Math.PI / 2) * et * dir;
        });
    }

    setFold(0);
    return { group, setFold, centreMaterial, faceInfo };
}

function bmRender3D(dims, hex, logoImage, logoFrac, opts) {
    const stage = document.getElementById('bm3dStage');
    document.getElementById('bm3dPlaceholder').style.display = 'none';
    document.getElementById('bm3dFoldRow').style.display = 'flex';
    stage.style.display = 'block';

    bm3dDispose();

    const options = opts || {};
    const width = Math.max(200, stage.clientWidth);
    const height = Math.max(260, Math.round(width * 0.92));

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(width, height);
    stage.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(35, width / height, 0.1, 100);

    const L = dims.length || 2, W = dims.width || 2, H = dims.height || 1;
    const twoPiece = Boolean(options.separateLid);
    const gap = twoPiece ? BM_LID_ALLOWANCE : 0;

    const longest = Math.max(L + gap, W + gap, H);
    const u = 1 / longest;

    const lidH = twoPiece ? H * BM_LID_HEIGHT_FRACTION : H;
    const baseH = twoPiece ? H * BM_BASE_HEIGHT_FRACTION : H;

    const pivot = new THREE.Group();
    const trays = [];

    // Base tray. Its centre panel is the floor, so it sits at the bottom.
    const base = bmBuildTray(L * u, W * u, baseH * u, hex, null, null, 1, {
        L: (L + gap) * u, W: (W + gap) * u,
    });
    base.group.position.y = -H * u / 2;
    pivot.add(base.group);
    trays.push(base);

    // Lid tray. Same construction, but its walls crease downward, so it only has
    // to travel across and settle — no turning over.
    const lid = bmBuildTray((L + gap) * u, (W + gap) * u, lidH * u, hex, logoImage, logoFrac, -1);
    pivot.add(lid.group);
    trays.push(lid);

    scene.add(pivot);

    // Where the lid rests when the box is open: beside the base, flat, the way
    // two die-lines are laid out on a sheet.
    //
    // The gap has to clear the UNFOLDED footprint, not the box. A flat tray is
    // its floor plus a wall on each side — for a 2x2x1.5 that is five inches
    // across, not two — so an offset sized to the box left the two die-lines
    // lying on top of each other.
    const baseFlatX = (L + 2 * baseH) * u;
    const lidFlatX = ((L + gap) + 2 * lidH) * u;
    const baseFlatZ = (W + 2 * baseH) * u;
    const lidFlatZ = ((W + gap) + 2 * lidH) * u;
    const openOffsetX = ((baseFlatX + lidFlatX) / 2) * 1.06;
    const openOffsetZ = ((baseFlatZ + lidFlatZ) / 2) * 0.22;

    const shadow = bmShadowPlane((L + gap) * u * 2.2, (W + gap) * u * 2.2);
    shadow.position.y = -H * u / 2 - 0.004;
    scene.add(shadow);

    scene.add(new THREE.AmbientLight(0xffffff, 0.40));
    scene.add(new THREE.HemisphereLight(0xffffff, 0xc9d2e0, 0.34));
    const key = new THREE.DirectionalLight(0xfff8f0, 0.92);
    key.position.set(2.0, 3.6, 2.0);
    scene.add(key);
    const fill = new THREE.DirectionalLight(0xffffff, 0.20);
    fill.position.set(-2.4, 1.0, -1.8);
    scene.add(fill);

    // The camera pulls back as the box opens instead of being fixed at the
    // widest extent. Framed for the open state alone, the closed box — which is
    // what you look at most — sat small in the middle of the frame.
    const fovRad = (camera.fov * Math.PI) / 180;
    const distanceFor = (r) => (r / Math.sin(fovRad / 2)) * 1.06;

    const closedRadius = Math.sqrt(
        Math.pow((L + gap) * u, 2) + Math.pow(H * u, 2) + Math.pow((W + gap) * u, 2)
    ) / 2;
    const openSpanX = openOffsetX + (baseFlatX + lidFlatX) / 2;
    const openSpanZ = openOffsetZ + (baseFlatZ + lidFlatZ) / 2;
    // The lid now rises well above the base before dropping, so the vertical
    // extent has to count toward the framing or it leaves the top of the view.
    const openSpanY = (H * u / 2) + lidH * u * 2.0;
    const openRadius = Math.sqrt(openSpanX * openSpanX + openSpanY * openSpanY + openSpanZ * openSpanZ) / 2;

    const distClosed = distanceFor(closedRadius);
    const distOpen = distanceFor(openRadius);
    const dir = new THREE.Vector3(0.56, 0.68, 0.80).normalize();
    const placeCamera = (t) => {
        const d = distOpen + (distClosed - distOpen) * t;
        camera.position.copy(dir.clone().multiplyScalar(d));
        camera.lookAt(0, 0, 0);
    };
    placeCamera(1);

    pivot.rotation.x = 0;
    pivot.rotation.y = -0.42;

    // t: 0 flat on the sheet, 1 closed. The walls come up first and the lid only
    // starts travelling once they are mostly there, so the two never intersect.
    // A lid goes on from directly above, not in from the side. So the travel is
    // two distinct moves rather than one diagonal: the lid lifts and comes across
    // until it is squarely over the base, and only then drops straight down onto
    // it. Sliding it along one path looked like the lid was being posted in
    // sideways, which is not how the box shuts.
    const easeInOut = (v) => (v < 0.5 ? 2 * v * v : 1 - Math.pow(-2 * v + 2, 2) / 2);
    const hoverY = (H * u / 2) + lidH * u * 0.95;   // clear of the base walls
    const TRAVEL_PART = 0.6;                        // of the move, before the drop

    function setFold(t) {
        const foldT = Math.min(1, t / 0.62);
        const moveT = Math.max(0, Math.min(1, (t - 0.5) / 0.5));
        const travel = easeInOut(Math.min(1, moveT / TRAVEL_PART));
        const descend = easeInOut(Math.max(0, (moveT - TRAVEL_PART) / (1 - TRAVEL_PART)));

        base.setFold(foldT);
        lid.setFold(foldT);

        // Across first — finished before the drop begins.
        lid.group.position.x = openOffsetX * (1 - travel);
        lid.group.position.z = openOffsetZ * (1 - travel);
        // Then straight down, from the hover height to seated.
        lid.group.position.y = (1 - descend) * (hoverY * travel) + descend * (H * u / 2);

        shadow.material.opacity = 0.25 + 0.75 * t;
        shadow.material.transparent = true;
        placeCamera(t);
    }

    let auto = true;
    let dragging = false;
    let lastX = 0, lastY = 0;
    const el = renderer.domElement;
    el.style.touchAction = 'none';
    el.style.cursor = 'grab';

    el.addEventListener('pointerdown', function (e) {
        dragging = true; auto = false;
        lastX = e.clientX; lastY = e.clientY;
        el.style.cursor = 'grabbing';
        el.setPointerCapture(e.pointerId);
    });
    el.addEventListener('pointermove', function (e) {
        if (!dragging) return;
        pivot.rotation.y += (e.clientX - lastX) * 0.008;
        pivot.rotation.x = Math.max(-1.2, Math.min(1.2, pivot.rotation.x + (e.clientY - lastY) * 0.008));
        lastX = e.clientX; lastY = e.clientY;
    });
    const stop = function () { dragging = false; el.style.cursor = 'grab'; };
    el.addEventListener('pointerup', stop);
    el.addEventListener('pointercancel', stop);

    function loop() {
        if (auto) pivot.rotation.y += 0.004;
        renderer.render(scene, camera);
        bm3d.frame = requestAnimationFrame(loop);
    }

    let observer = null;
    if (window.ResizeObserver) {
        observer = new ResizeObserver(function () {
            const w = Math.max(200, stage.clientWidth);
            const h = Math.max(260, Math.round(w * 0.92));
            renderer.setSize(w, h);
            camera.aspect = w / h;
            camera.updateProjectionMatrix();
        });
        observer.observe(stage);
    }

    const meshes = [];
    scene.traverse(function (o) { if (o.isMesh) meshes.push(o); });

    // Faces belong to the lid: that is the piece the print goes on, and the base
    // is hidden once the box is shut.
    const faceInfo = lid.faceInfo;
    Object.keys(faceInfo).forEach(function (k) {
        faceInfo[k].hasLogo = Boolean(logoFrac && logoFrac.face === k);
    });

    bm3d = {
        renderer, scene, camera, pivot, meshes, frame: 0, observer,
        setFold,
        faceInfo,
        hex, logoImage,
    };

    setFold(bm3dFoldValue());
    loop();
}

// Reads the open/close slider. Closed by default: that is the product, and the
// fold is something you go looking for.
function bm3dFoldValue() {
    const el = document.getElementById('bm3dFold');
    const v = el ? parseFloat(el.value) : 1;
    return Number.isFinite(v) ? v : 1;
}

document.getElementById('bm3dFold').addEventListener('input', function () {
    if (bm3d && bm3d.setFold) bm3d.setFold(bm3dFoldValue());
});

function bm3dSyncFromCanvas() {
    if (!bm3dContext || !bm3d || !bmLogoObject) return;
    const placement = bm3dLogoPlacement();
    bm3dUpdateLogo(placement);

    // Say which face it landed on, so moving across a fold line is confirmed in
    // words as well as in the picture.
    const meta = document.getElementById('bm3dMeta');
    const faceName = {
        top: 'the lid', left: 'the left wall', right: 'the right wall',
        front: 'the front wall', back: 'the back wall',
    }[placement.face];
    if (meta && faceName) meta.textContent = meta.textContent.replace(/logo on [a-z ]+ at/, 'logo on ' + faceName + ' at');
}

// Repaints whichever face the logo is on, and clears the rest, so dragging it
// across a fold line on the flat mockup moves it onto the matching wall here.
// Only the affected materials are touched — rebuilding the scene per pointer
// move would throw away the angle the box had been turned to.
function bm3dUpdateLogo(placement) {
    if (!bm3d || !bm3d.faceInfo) return;
    const want = (placement && placement.face) || 'top';
    Object.keys(bm3d.faceInfo).forEach(function (key) {
        const f = bm3d.faceInfo[key];
        if (!f) return;
        const carries = key === want;
        // Leave a face alone if it is already blank and should stay blank.
        if (!carries && !f.hasLogo) return;
        const old = f.material.map;
        f.material.map = bm3dFaceTexture(
            bm3d.hex, f.w, f.h, carries ? bm3d.logoImage : null, carries ? placement : null
        );
        f.material.needsUpdate = true;
        f.hasLogo = carries;
        if (old) old.dispose();
    });
}
