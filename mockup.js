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
    return sourceCanvas;
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

        const tplImg = await bmLoadImage(BACKEND_URL + '/box-template-image/' + tpl.id);

        // Recolour at the template's own resolution, then scale for display so
        // the export can go back up to full size without re-reading anything.
        const full = document.createElement('canvas');
        full.width = tplImg.naturalWidth;
        full.height = tplImg.naturalHeight;
        full.getContext('2d').drawImage(tplImg, 0, 0);
        const region = bmArtworkRegion(full);
        bmRecolour(full, colour, region);

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

        const colourName = document.getElementById('bmColorName').textContent;
        document.getElementById('bmMeta').textContent =
            tpl.styleLabel + (tpl.typeLabel ? ' · ' + tpl.typeLabel : '') + ' · ' + colourName
            + ' · ' + sizeNote + ' · drag or resize the logo to adjust';
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
