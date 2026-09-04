// Server-side logo background removal + vector tracing API.
// Background removal is entirely our own: the same colour-distance mask
// pipeline that drives tracing (traceMask.js) also produces the cutout, so
// there is no external API, no key, no per-image cost and no ML model to
// download on cold start. It handles any background colour, not just white.

const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');
const compression = require('compression');
const multer = require('multer');
const potrace = require('potrace');
const Jimp = require('jimp');
const catalogStore = require('./catalog');
const { potraceSvgToEps } = require('./svgToEps');
const { buildTraceMask, grayscaleForTrace, grayscaleFromAlpha } = require('./traceMask');
const {
    DEFAULTS: VECTORIZE_DEFAULTS,
    DEFAULT_MAX_EDGE,
    parseVectorizeOptions,
    parseBool,
    clampInt,
    vectorizeToSvg,
    vectorizeHealth,
} = require('./vectorize');
const aiEnhance = require('./aiEnhance');

// Tunable via Railway env vars; see .env.example.
const MAX_UPLOAD_MB = clampInt(process.env.MAX_UPLOAD_MB, 1, 64, 15);
const VTRACER_TIMEOUT_MS = clampInt(process.env.VTRACER_TIMEOUT_MS, 1000, 300000, 30000);
const VTRACER_MAX_EDGE = clampInt(process.env.VTRACER_MAX_EDGE, 200, 4000, DEFAULT_MAX_EDGE);
const OPENAI_TIMEOUT_MS = clampInt(process.env.OPENAI_TIMEOUT_MS, 5000, 600000, 120000);

const app = express();
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024 },
});

// Allow the deployed frontend (and local dev) to call this API cross-origin.
// Set ALLOWED_ORIGIN in Railway env vars to your Vercel URL, e.g.
// https://mockup-dibiaa.vercel.app — comma-separate multiple origins.
const allowedOrigins = (process.env.ALLOWED_ORIGIN || '*')
    .split(',')
    .map((o) => o.trim());

app.use(cors({
    origin: allowedOrigins.includes('*') ? true : allowedOrigins,
}));

// Traced SVG is highly repetitive text, so it gzips by roughly 10:1. That is the
// difference between a photo conversion sending ~9.5MB and ~1MB over the wire.
app.use(compression());

app.get('/', (req, res) => {
    res.json({ status: 'ok', service: 'mockupdibiaa-backend' });
});

app.get('/health', (req, res) => {
    res.json({ status: 'ok' });
});

// ── Admin dashboard: catalog (box type/style/color, printing colors, mockup images) ──
// Additive to the frontend's static hardcoded catalog — never touches it. Dashboard
// creates new combos here; the frontend merges them in at runtime via GET /catalog.

function slugify(label) {
    return String(label).toLowerCase().trim().replace(/[^a-z0-9]+/g, '');
}

function requireAdmin(req, res, next) {
    const provided = req.header('x-admin-password') || '';
    const expected = process.env.ADMIN_PASSWORD || '';
    if (!expected || provided !== expected) {
        return res.status(401).json({ error: 'Invalid or missing admin password.' });
    }
    next();
}

app.get('/admin/verify', requireAdmin, (req, res) => {
    res.json({ ok: true });
});

// Public: frontend fetches this at load to merge admin-added entries into its dropdowns.
app.get('/catalog', (req, res) => {
    res.json(catalogStore.readCatalog());
});

// Public: serves the mockup/die images the dashboard uploaded.
app.get('/images/:type/:style/:color/:kind', (req, res) => {
    const { type, style, color, kind } = req.params;
    if (kind !== 'mockup' && kind !== 'die') {
        return res.status(400).json({ error: 'kind must be "mockup" or "die".' });
    }
    const filePath = catalogStore.comboImagePath(type, style, color, kind);
    if (!filePath.startsWith(catalogStore.IMAGES_DIR) || !fs.existsSync(filePath)) {
        return res.status(404).json({ error: 'Image not found.' });
    }
    res.sendFile(filePath);
});

// Add (or update) a printing color available in the customer form's dropdown.
app.post('/admin/printing-color', requireAdmin, express.json(), (req, res) => {
    const { label, hex } = req.body || {};
    if (!label || !hex) {
        return res.status(400).json({ error: 'label and hex are required.' });
    }
    if (!/^#[0-9a-fA-F]{6}$/.test(hex)) {
        return res.status(400).json({ error: 'hex must look like #RRGGBB.' });
    }
    const key = slugify(label);
    const catalog = catalogStore.readCatalog();
    catalog.printingColors[key] = { label: String(label).trim(), hex };
    catalogStore.writeCatalog(catalog);
    res.json(catalog);
});

// Save where the logo should sit for a given box combo — separately for the
// "mockup" (often a lifestyle photo where the product isn't centered in the
// frame) and the "die" (flat template) canvases. x/y are fractions (0-1) of
// that canvas's width/height. Works for both dashboard-added combos AND the
// frontend's static hardcoded combos — this endpoint doesn't care where the
// combo's images actually live, it just keys positions by type|style|color.
app.post('/admin/logo-position', requireAdmin, express.json(), (req, res) => {
    const { type, style, color, mockup, die } = req.body || {};
    if (!type || !style || !color) {
        return res.status(400).json({ error: 'type, style and color are required.' });
    }
    const isFrac = (v) => typeof v === 'number' && v >= 0 && v <= 1;
    if (mockup && (!isFrac(mockup.x) || !isFrac(mockup.y))) {
        return res.status(400).json({ error: 'mockup.x/mockup.y must be numbers between 0 and 1.' });
    }
    if (die && (!isFrac(die.x) || !isFrac(die.y))) {
        return res.status(400).json({ error: 'die.x/die.y must be numbers between 0 and 1.' });
    }

    const key = `${type}|${style}|${color}`;
    const catalog = catalogStore.readCatalog();
    const existing = catalog.logoPositions[key] || {};
    catalog.logoPositions[key] = {
        mockup: mockup ? { x: mockup.x, y: mockup.y } : existing.mockup,
        die: die ? { x: die.x, y: die.y } : existing.die,
    };
    catalogStore.writeCatalog(catalog);
    res.json(catalog);
});

app.delete('/admin/printing-color/:key', requireAdmin, (req, res) => {
    const catalog = catalogStore.readCatalog();
    delete catalog.printingColors[req.params.key];
    catalogStore.writeCatalog(catalog);
    res.json(catalog);
});

// Create (or replace) a box type/style/color combo: saves the two uploaded images
// and registers the combo + dimensions so the customer form can offer it.
app.post(
    '/admin/mockup',
    requireAdmin,
    upload.fields([{ name: 'mockupImage', maxCount: 1 }, { name: 'dieImage', maxCount: 1 }]),
    (req, res) => {
        const { typeLabel, styleLabel, colorLabel, dimensions } = req.body || {};
        const mockupFile = req.files && req.files.mockupImage && req.files.mockupImage[0];
        const dieFile = req.files && req.files.dieImage && req.files.dieImage[0];

        if (!typeLabel || !styleLabel || !colorLabel) {
            return res.status(400).json({ error: 'typeLabel, styleLabel and colorLabel are required.' });
        }
        if (!mockupFile || !dieFile) {
            return res.status(400).json({ error: 'Both mockupImage and dieImage files are required.' });
        }
        if (mockupFile.mimetype !== 'image/png' || dieFile.mimetype !== 'image/png') {
            return res.status(400).json({ error: 'Both images must be PNG files.' });
        }

        const type = slugify(typeLabel);
        const style = slugify(styleLabel);
        const color = slugify(colorLabel);

        try {
            fs.mkdirSync(catalogStore.comboDir(type, style, color), { recursive: true });
            fs.writeFileSync(catalogStore.comboImagePath(type, style, color, 'mockup'), mockupFile.buffer);
            fs.writeFileSync(catalogStore.comboImagePath(type, style, color, 'die'), dieFile.buffer);

            const catalog = catalogStore.readCatalog();
            catalog.types[type] = { label: String(typeLabel).trim() };
            catalog.styles[style] = { label: String(styleLabel).trim() };
            catalog.colors[color] = { label: String(colorLabel).trim() };

            const existing = catalog.combos.find((c) => c.type === type && c.style === style && c.color === color);
            if (existing) {
                existing.dimensions = dimensions || existing.dimensions || '';
            } else {
                catalog.combos.push({ type, style, color, dimensions: dimensions || '' });
            }
            catalogStore.writeCatalog(catalog);
            res.json(catalog);
        } catch (err) {
            console.error('Failed to save mockup combo:', err);
            res.status(500).json({ error: 'Failed to save mockup combo.', detail: err.message });
        }
    }
);

// Removes a dashboard-added combo and its images (mistakes/test entries), plus
// any type/style/color label left with no remaining combo using it.
app.delete('/admin/mockup/:type/:style/:color', requireAdmin, (req, res) => {
    const { type, style, color } = req.params;
    const catalog = catalogStore.readCatalog();
    catalog.combos = catalog.combos.filter((c) => !(c.type === type && c.style === style && c.color === color));

    if (!catalog.combos.some((c) => c.type === type)) delete catalog.types[type];
    if (!catalog.combos.some((c) => c.style === style)) delete catalog.styles[style];
    if (!catalog.combos.some((c) => c.color === color)) delete catalog.colors[color];

    catalogStore.writeCatalog(catalog);
    fs.rmSync(catalogStore.comboDir(type, style, color), { recursive: true, force: true });
    res.json(catalog);
});

// POST /remove-bg  (multipart/form-data, field name "logo")
// Returns the cutout as a PNG with transparent background.
app.post('/remove-bg', upload.single('logo'), async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'No file uploaded. Send it as multipart/form-data field "logo".' });
    }
    if (!ACCEPTED_IMAGE_TYPES.has(req.file.mimetype)) {
        return res.status(400).json({ error: 'Only PNG, JPG or WEBP files are accepted.' });
    }

    try {
        const outputBuffer = await cutoutToPng(req.file.buffer);
        res.set('Content-Type', 'image/png');
        res.send(outputBuffer);
    } catch (err) {
        console.error('Background removal failed:', err);
        res.status(500).json({ error: 'Background removal failed.', detail: err.message });
    }
});

// POST /convert-logo  (multipart/form-data, field "logo" = PNG or JPG, protected)
// Vector-traces the raster logo into real vector paths and returns both an SVG
// and an EPS — both open directly in CorelDRAW (File > Open), which can then
// Save As .cdr. A true .cdr can't be written outside CorelDRAW itself, so this
// is the honest closest equivalent, not a fake ".cdr" file.
//
// "simple" = one flat fill color (best for normal logos — matches how the
// rest of this app already treats logos as one printing color).
// "detailed" = multiple tonal layers of the same color (for logos with
// shading/gradients) — EPS has no native alpha, so layers are approximated
// by lightening the fill toward white rather than true transparency.
// Trace settings, chosen by measuring output against a known-good reference
// rather than by eye. Resolution is the lever that actually matters: at 2400px
// the traced shape sits within ~2% of the original artwork, versus ~4% at
// 1600px. Going higher is worse, not better — upscaling smears the edges and
// the trace then follows the smear.
const MAX_DETAIL_TRACE_OPTIONS = {
    background: 'transparent',
    threshold: potrace.Potrace.THRESHOLD_AUTO,
    // Measured against a known-good reference: these reproduce the artwork most
    // faithfully. turdSize 2 at this resolution drops JPEG speckle without
    // touching real detail; a tighter optTolerance just chases compression
    // ringing and makes edges ragged.
    turdSize: 2,
    optTolerance: 0.2,
    alphaMax: 1,
};


// Potrace assumes the shape is DARK on a LIGHT ground. A logo that's light on a
// dark ground (gold/white on black, etc.) would otherwise trace the *background*
// and knock the logo out as holes — a solid rectangle with the logo missing.
// It also works off the raw pixel grid, so a small source yields blobby curves
// on fine detail (small taglines, thin strokes); upscaling first fixes that.
const TRACE_MIN_LONG_EDGE = 1000;
const TRACE_MAX_LONG_EDGE = 3000;



// Most logos arrive as JPGs. Rejecting them was the root cause of "the
// background isn't cleared": the frontend fell back to its white-only
// flood-fill, left a coloured rectangle opaque, and the recolour pass then
// painted that whole rectangle in the printing colour.
const ACCEPTED_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);

// Longest edge we cut out at. The mask work is O(pixels), and a logo placed on
// a box never needs more resolution than this.
const CUTOUT_MAX_LONG_EDGE = 2000;

// Writes the artwork mask into the ORIGINAL image's alpha channel, so the logo
// keeps its own colours (the "None" printing colour shows the artwork as-is)
// while the background becomes fully transparent.
//
// The feather is deliberately inward-only: giving a *background* pixel partial
// alpha would leave a fringe of background colour around the logo, which is
// exactly the halo we are trying to get rid of. So background pixels go hard to
// zero, and only artwork pixels on the outline are softened, by their own 3x3
// coverage. That keeps edges smooth without importing any background colour.
function applyMaskAsAlpha(image, mask) {
    const { width: w, height: h, data } = image.bitmap;
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const p = y * w + x;
            const i = p * 4;
            if (!mask[p]) { data[i + 3] = 0; continue; }

            let covered = 0;
            let counted = 0;
            for (let dy = -1; dy <= 1; dy++) {
                const yy = y + dy;
                if (yy < 0 || yy >= h) continue;
                for (let dx = -1; dx <= 1; dx++) {
                    const xx = x + dx;
                    if (xx < 0 || xx >= w) continue;
                    counted++;
                    if (mask[yy * w + xx]) covered++;
                }
            }
            // +0.35 bias so only genuinely thin outline pixels lose opacity;
            // a stroke's own body stays fully solid.
            const coverage = counted ? covered / counted : 1;
            data[i + 3] = Math.round(Math.min(1, coverage + 0.35) * 255);
        }
    }
    return image;
}

// Safety net for when the mask pipeline bails out (artwork bleeding to every
// edge, so "the border is background" no longer holds): flood-fill inward from
// the border, clearing whatever matches the border's own colour. Unlike the old
// client-side fallback this is keyed to the sampled colour, not to white, so it
// still works on dark or coloured backgrounds.
function floodFillBackgroundAlpha(image) {
    const { width: w, height: h, data } = image.bitmap;
    const rs = [], gs = [], bs = [];
    const sample = (x, y) => {
        const i = (y * w + x) * 4;
        rs.push(data[i]); gs.push(data[i + 1]); bs.push(data[i + 2]);
    };
    for (let x = 0; x < w; x++) { sample(x, 0); sample(x, h - 1); }
    for (let y = 0; y < h; y++) { sample(0, y); sample(w - 1, y); }
    const median = (arr) => { arr.sort((a, b) => a - b); return arr[arr.length >> 1]; };
    const br = median(rs), bgc = median(gs), bb = median(bs);

    const TOLERANCE = 70 * 70; // squared per-pixel colour distance
    const total = w * h;
    const visited = new Uint8Array(total);
    const queue = new Int32Array(total);
    let head = 0, tail = 0;

    const enqueue = (pos) => { if (!visited[pos]) { visited[pos] = 1; queue[tail++] = pos; } };
    for (let x = 0; x < w; x++) { enqueue(x); enqueue((h - 1) * w + x); }
    for (let y = 0; y < h; y++) { enqueue(y * w); enqueue(y * w + w - 1); }

    while (head < tail) {
        const pos = queue[head++];
        const i = pos * 4;
        const dr = data[i] - br, dg = data[i + 1] - bgc, db = data[i + 2] - bb;
        if (data[i + 3] > 0 && dr * dr + dg * dg + db * db > TOLERANCE) continue;
        data[i + 3] = 0;
        const x = pos % w, y = (pos / w) | 0;
        if (x > 0) enqueue(pos - 1);
        if (x < w - 1) enqueue(pos + 1);
        if (y > 0) enqueue(pos - w);
        if (y < h - 1) enqueue(pos + w);
    }
    return image;
}

// Forces every visible pixel to pure black while leaving alpha untouched.
//
// The prompt already asks for flat black, but a generative model is not a
// guarantee — it sometimes returns the original gold, or black with a faint
// metallic sheen. Alpha carries the shape, so overwriting only the colour
// channels turns whatever came back into a solid black version of exactly that
// shape, with anti-aliased edges intact. That makes black output certain rather
// than likely, and it is what single-colour box printing needs.
async function forceBlack(buffer) {
    const image = await Jimp.read(buffer);
    const { data } = image.bitmap;
    for (let i = 0; i < data.length; i += 4) {
        if (data[i + 3] === 0) continue;
        data[i] = 0; data[i + 1] = 0; data[i + 2] = 0;
    }
    return image.getBufferAsync(Jimp.MIME_PNG);
}

// Recolours every visible pixel black, leaving alpha alone. Asking for the AI
// pass is a request for black print-ready artwork, and that has to hold even when
// the redraw was rejected or skipped — blackening the traced original keeps the
// promise without reintroducing the risk, since nothing is reinterpreted, only
// recoloured.
function blackenVisible(image) {
    const { data } = image.bitmap;
    for (let i = 0; i < data.length; i += 4) {
        if (data[i + 3] === 0) continue;
        data[i] = 0; data[i + 1] = 0; data[i + 2] = 0;
    }
    return image;
}

// True when the image already carries a real alpha channel — an AI redraw always
// does. Such an image needs no background detection at all: transparency IS the
// answer, and running colour-distance masking over it can only damage it.
function hasUsableAlpha(image) {
    const { width: w, height: h, data } = image.bitmap;
    const total = w * h;
    let transparent = 0;
    for (let p = 0; p < total; p++) if (data[p * 4 + 3] < 128) transparent++;
    return transparent / total >= 0.05;
}

// True when the visible artwork is effectively one colour, which decides the
// tracer. A single-colour image belongs to potrace: it fits one path with proper
// curve optimisation, whereas VTracer's colour clustering treats each
// anti-aliasing gradation as its own region and emits thousands of stacked
// slivers. Measured on an AI-blackened logo: potrace 1 path / 15.5KB / IoU
// 0.983, VTracer 2014 paths / 196KB.
function isEffectivelyMonochrome(image) {
    const { width: w, height: h, data } = image.bitmap;
    const total = w * h;
    const step = Math.max(1, Math.floor(total / 40000));
    let n = 0, sr = 0, sg = 0, sb = 0;
    for (let p = 0; p < total; p += step) {
        const i = p * 4;
        if (data[i + 3] < 128) continue;
        sr += data[i]; sg += data[i + 1]; sb += data[i + 2]; n++;
    }
    if (n < 16) return false;
    const mr = sr / n, mg = sg / n, mb = sb / n;
    let spread = 0, c = 0;
    for (let p = 0; p < total; p += step) {
        const i = p * 4;
        if (data[i + 3] < 128) continue;
        const dr = data[i] - mr, dg = data[i + 1] - mg, db = data[i + 2] - mb;
        spread += Math.sqrt(dr * dr + dg * dg + db * db);
        c++;
    }
    return (spread / Math.max(1, c)) < 40;
}

// Flattens transparency onto white so potrace sees plain black-on-white with its
// anti-aliasing intact as grey. This also removes the background implicitly —
// transparent becomes white, and white is not traced.
async function flattenOntoWhite(image) {
    const flat = new Jimp(image.bitmap.width, image.bitmap.height, 0xffffffff);
    flat.composite(image, 0, 0);
    return flat.getBufferAsync(Jimp.MIME_PNG);
}

// One background-removal path shared by the mockup tab and the converter, so
// both tabs always agree on what counts as background.
async function cutoutToPng(buffer, maxEdge = CUTOUT_MAX_LONG_EDGE) {
    const image = await Jimp.read(buffer);
    const longEdge = Math.max(image.bitmap.width, image.bitmap.height);
    if (longEdge > maxEdge) {
        image.scale(maxEdge / longEdge, Jimp.RESIZE_BICUBIC);
    }

    const masked = buildTraceMask(image);
    if (masked.stats.usable && masked.mask) applyMaskAsAlpha(image, masked.mask);
    else floodFillBackgroundAlpha(image);

    return image.getBufferAsync(Jimp.MIME_PNG);
}

async function prepareForTrace(buffer) {
    const image = await Jimp.read(buffer);
    const w = image.bitmap.width;
    const h = image.bitmap.height;

    // The border of a logo image is background, effectively without exception,
    // so its mean luminance tells us which way round the artwork is. Transparent
    // counts as light because potrace composites non-opaque pixels over white.
    const step = Math.max(1, Math.floor(Math.min(w, h) / 120));
    let sum = 0;
    let count = 0;
    const sample = (x, y) => {
        const { r, g, b, a } = Jimp.intToRGBA(image.getPixelColor(x, y));
        sum += a < 128 ? 255 : (0.299 * r + 0.587 * g + 0.114 * b);
        count++;
    };
    for (let x = 0; x < w; x += step) { sample(x, 0); sample(x, h - 1); }
    for (let y = 0; y < h; y += step) { sample(0, y); sample(w - 1, y); }
    const lightOnDark = (sum / count) < 128;

    // Detect at the image's OWN resolution — never upscale before masking.
    // Interpolating first turns a crisp margin/panel boundary into a colour
    // ramp, and the panel test measures colour spread along exactly that
    // boundary: the ramp inflates the spread past its limit, the coloured panel
    // stops being recognised as background, and the trace comes out as the
    // filled panel instead of the lettering. Any upscaling for potrace's benefit
    // happens after masking, on the finished black-and-white mask.
    const longEdge = Math.max(w, h);
    if (longEdge > TRACE_MAX_LONG_EDGE) {
        // Keeps tracing time bounded; still far more detail than any logo needs.
        image.scale(TRACE_MAX_LONG_EDGE / longEdge, Jimp.RESIZE_BICUBIC);
    }

    return { image, lightOnDark };
}

app.post('/convert-logo', requireAdmin, upload.single('logo'), async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'No file uploaded. Send it as multipart/form-data field "logo".' });
    }
    if (!ACCEPTED_IMAGE_TYPES.has(req.file.mimetype)) {
        return res.status(400).json({ error: 'Only PNG, JPG or WEBP files are accepted.' });
    }

    // Single, default option: black, maximum-detail trace — no colour/detail
    // pickers, so the tab stays one upload plus one button. Background detection
    // is entirely local, from the image's own border colour, and runs against the
    // full-resolution original so hairlines keep their true weight.
    let prepared;
    try {
        prepared = await prepareForTrace(req.file.buffer);
    } catch (prepErr) {
        console.error('Could not read image for tracing:', prepErr);
        return res.status(400).json({ error: 'Could not read that image file.', detail: prepErr.message });
    }

    const masked = buildTraceMask(prepared.image);

    // Now that detection is done, give potrace more pixels to fit curves to if
    // the source was small. Scaling the binary mask can only smooth its outline;
    // it cannot change which pixels were judged to be artwork.
    if (masked.image) {
        const maskEdge = Math.max(masked.image.bitmap.width, masked.image.bitmap.height);
        if (maskEdge < TRACE_MIN_LONG_EDGE) {
            masked.image.scale(TRACE_MIN_LONG_EDGE / maskEdge, Jimp.RESIZE_BICUBIC);
        }
    }

    try {
        let svg;
        if (masked.stats.usable) {
            // Solid black artwork on a cleared background. The mask already has
            // the background (and any coloured panel behind the logo) removed,
            // so every artwork pixel — bright highlight and dark bevel alike —
            // is filled the same solid black rather than being split by tone.
            svg = await new Promise((resolve, reject) => {
                potrace.trace(masked.image, {
                    ...MAX_DETAIL_TRACE_OPTIONS,
                    color: '#000000',
                    threshold: 128,
                    blackOnWhite: true,
                }, (err, out) => (err ? reject(err) : resolve(out)));
            });
        } else {
            // The border-is-background assumption failed (artwork bleeds to the
            // edge), so fall back to potrace's own thresholding with the
            // detected polarity.
            svg = await new Promise((resolve, reject) => {
                potrace.trace(prepared.image, {
                    ...MAX_DETAIL_TRACE_OPTIONS,
                    color: '#000000',
                    blackOnWhite: !prepared.lightOnDark,
                }, (err, out) => (err ? reject(err) : resolve(out)));
            });
        }
        const eps = potraceSvgToEps(svg);
        res.json({ svg, eps });
    } catch (traceErr) {
        console.error('Vector trace failed:', traceErr);
        res.status(500).json({ error: 'Vector trace failed.', detail: traceErr.message });
    }
});

// ── Full-colour vectorisation (VTracer) ──────────────────────────────────────
// Sits alongside /convert-logo rather than replacing it: this route produces
// full-colour SVG suitable for general artwork, while /convert-logo stays the
// black-silhouette path used for box printing. VTracer's own binary mode is not
// a substitute — it ignores the alpha channel and turns a cut-out logo into
// white-on-black.

// Deploy debugging: confirms the prebuilt native binary for this container's
// platform actually loaded, which is the failure mode worth catching early.
app.get('/api/convert/health', async (req, res) => {
    try {
        const health = await vectorizeHealth();
        res.json({
            status: 'ok',
            ...health,
            limits: {
                maxUploadMb: MAX_UPLOAD_MB,
                timeoutMs: VTRACER_TIMEOUT_MS,
                maxTraceEdge: VTRACER_MAX_EDGE,
            },
            defaults: VECTORIZE_DEFAULTS,
            aiEnhance: {
                available: aiEnhance.isConfigured(),
                model: process.env.OPENAI_IMAGE_MODEL || aiEnhance.DEFAULT_MODEL,
                quality: process.env.OPENAI_IMAGE_QUALITY || aiEnhance.DEFAULT_QUALITY,
            },
        });
    } catch (err) {
        console.error('VTracer health check failed:', err);
        res.status(500).json({ status: 'error', engine: 'vtracer', detail: err.message });
    }
});

app.post('/api/convert/svg', requireAdmin, upload.single('image'), async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'No file uploaded. Send it as multipart/form-data field "image".' });
    }
    if (!ACCEPTED_IMAGE_TYPES.has(req.file.mimetype)) {
        return res.status(400).json({ error: 'Only PNG, JPG or WEBP files are accepted.' });
    }

    const opts = parseVectorizeOptions({ ...req.query, ...req.body });
    // On by default: this is a logo tool, and VTracer traces a background panel
    // as a filled rectangle if you leave one there. Turn it off for photographs,
    // where the "background" is part of the subject.
    const wantsCutout = parseBool(req.body.removeBackground ?? req.query.removeBackground, true);
    // Off unless asked for: it costs money per call, and the model redraws rather
    // than upscales, so it must never run silently over a client's brand mark.
    const wantsEnhance = parseBool(req.body.enhance ?? req.query.enhance, false);

    // Decode up front so a corrupt or mislabelled file fails as a 400 here rather
    // than as an opaque engine error later — and so the AI step, if it runs, is
    // never billed for a file that was never going to trace.
    let sourceBuffer = req.file.buffer;
    let sourceMime = req.file.mimetype;
    let enhanceMeta = null;
    let enhanceError = null;
    let enhancedDataUrl = null;

    // Decode first: a file that was never going to trace must not be billed for.
    let probe;
    try {
        probe = await Jimp.read(sourceBuffer);
    } catch (readErr) {
        console.warn('Rejected unreadable upload:', readErr.message);
        return res.status(400).json({ error: 'Could not read that image file.', detail: readErr.message });
    }

    if (wantsEnhance) {
        // The AI step is the default path, so a failure here must not take the
        // whole conversion down with it. Out of credit, a revoked key, a slow day
        // at OpenAI — the user still gets a vector traced from their original,
        // and the response says why it is not the enhanced one.
        const originalBuffer = req.file.buffer;
        const originalMime = req.file.mimetype;
        try {
            // Read the wording first so it can be pinned into the prompt. A model
            // told the exact string to reproduce drops letters far less often than
            // one asked to copy what it sees.
            let exactText = '';
            try {
                exactText = await aiEnhance.readLogoText(originalBuffer, originalMime, OPENAI_TIMEOUT_MS);
            } catch (textErr) {
                console.warn('Could not pre-read logo text:', textErr.message);
            }

            // Non-Latin scripts used to skip the redraw entirely, because
            // gpt-image-1 corrupted them and the verifier could not read them well
            // enough to notice. gpt-image-2 reproduces them correctly — verified
            // across three runs on a Gujarati logo, every glyph right — so the
            // redraw now runs for every script. The verifier still cannot read
            // them, so what changed is the claim made afterwards, not whether we
            // attempt it.
            const scriptIsVerifiable = !aiEnhance.hasNonLatinScript(exactText);

            // Then check the wording actually survived. A redraw that silently
            // drops a letter is worse than no redraw at all — it is a corrupted
            // brand mark that still looks plausible. So try twice, and if the
            // wording still does not match, throw the redraw away and trace the
            // original, which cannot lose a character because nothing
            // reinterprets it.
            const attempts = [];
            let accepted = null;
            let lastError = null;
            // Three, not two, and a failed generation now costs an attempt rather
            // than the whole conversion. OpenAI's safety filter rejects perfectly
            // ordinary logos intermittently — one in three on a jewellery mark in
            // testing — and previously that exception escaped the loop, so a
            // transient refusal silently downgraded the result to a plain trace
            // and looked like the redraw had stopped working.
            for (let attempt = 1; attempt <= 3 && !accepted; attempt++) {
                let enhanced;
                try {
                    enhanced = await aiEnhance.enhanceImage(
                        originalBuffer,
                        originalMime,
                        { width: probe.bitmap.width, height: probe.bitmap.height },
                        OPENAI_TIMEOUT_MS,
                        exactText,
                    );
                } catch (genErr) {
                    // A missing or rejected key will fail identically every time,
                    // so give up immediately rather than burning three calls.
                    if (genErr.code === 'ENOKEY' || genErr.code === 'EBADKEY') throw genErr;
                    lastError = genErr;
                    console.warn(`Redraw attempt ${attempt} failed:`, genErr.message);
                    continue;
                }
                const black = await forceBlack(enhanced.buffer);

                let check = null;
                try {
                    check = await aiEnhance.verifyRedraw(originalBuffer, originalMime, black, OPENAI_TIMEOUT_MS);
                } catch (verifyErr) {
                    console.warn('Redraw verification unavailable:', verifyErr.message);
                }

                // On a script the verifier cannot read, an unsure answer is not
                // evidence of a problem — it is the absence of evidence either
                // way. Rejecting on it would mean never redrawing a Gujarati logo
                // no matter how well the model did. So accept, and say plainly
                // afterwards that the wording was not machine-checked.
                // Not conditional on the verifier's own confidence. On a script
                // it cannot read it once reported a confident match on text that
                // was already wrong in its own transcription, so its confidence
                // there carries no information. Trust the redraw, not the check.
                const unverifiable = !scriptIsVerifiable;
                attempts.push({ buffer: black, meta: enhanced.meta, check, unverifiable });

                // Unverifiable is not the same as wrong: keep the redraw but flag
                // that it could not be checked, rather than disabling the feature
                // every time the verifier has a bad minute.
                if (!check || check.textMatches || unverifiable) accepted = attempts[attempts.length - 1];
            }

            if (accepted) {
                sourceBuffer = accepted.buffer;
                sourceMime = 'image/png';
                enhanceMeta = {
                    ...accepted.meta,
                    attempts: attempts.length,
                    expectedText: exactText || null,
                    verified: accepted.unverifiable ? null : (accepted.check ? accepted.check.textMatches : null),
                    confident: accepted.check ? accepted.check.confident : null,
                    unverifiable: Boolean(accepted.unverifiable),
                    shapesMatch: accepted.check ? accepted.check.shapesMatch : null,
                };
                // Preview the blackened version, so what is shown is what gets traced.
                enhancedDataUrl = 'data:image/png;base64,' + sourceBuffer.toString('base64');
            } else if (attempts.length === 0) {
                // Every generation failed outright, so there is no redraw to
                // report on — only why we never got one.
                const msg = (lastError && lastError.message) || 'unknown error';
                enhanceError = /safety system/i.test(msg)
                    ? 'the AI image service refused this image on every attempt, so your original was traced instead'
                    : 'the AI clean-up failed (' + msg.slice(0, 120) + '), so your original was traced instead';
                console.warn('AI redraw produced nothing after 3 attempts —', msg);
            } else {
                const last = attempts[attempts.length - 1].check;
                enhanceError = 'the AI changed the wording (it produced "' + last.text2
                    + '" instead of "' + last.text1 + '"), so your original was traced instead to keep the logo exact';
                console.warn('AI redraw rejected after', attempts.length, 'attempts —', enhanceError);
            }
        } catch (aiErr) {
            if (aiErr && aiErr.code === 'ESKIP') {
                // Deliberate skip; enhanceError already explains why.
            } else {
                const reasons = {
                    ENOKEY: 'AI clean-up is not configured on the server',
                    EBADKEY: 'the AI service rejected our API key',
                    ETIMEDOUT: 'the AI clean-up timed out',
                };
                enhanceError = reasons[aiErr.code] || ('the AI clean-up failed: ' + aiErr.message);
                console.warn('AI enhancement skipped —', enhanceError);
            }
        }
    }

    let raster;          // PNG with alpha, for VTracer
    let flattened;       // continuous greyscale, for potrace
    let sourceSize;
    let monochrome = false;
    let maskedBackground = false;
    try {
        const image = await Jimp.read(sourceBuffer);
        const longEdge = Math.max(image.bitmap.width, image.bitmap.height);
        if (longEdge > VTRACER_MAX_EDGE) {
            image.scale(VTRACER_MAX_EDGE / longEdge, Jimp.RESIZE_BICUBIC);
        }
        sourceSize = { width: image.bitmap.width, height: image.bitmap.height };

        let gray = null;

        if (hasUsableAlpha(image)) {
            // Already cut out — an AI redraw always is. Alpha is the coverage
            // ramp, so read it directly; inferring a background here could only
            // damage what is already exact.
            const cut = image.clone();
            if (wantsEnhance) blackenVisible(cut);
            raster = await cut.getBufferAsync(Jimp.MIME_PNG);
            monochrome = isEffectivelyMonochrome(cut);
            gray = grayscaleFromAlpha(cut);
        } else if (wantsCutout) {
            const masked = buildTraceMask(image);
            const cut = image.clone();
            if (masked.stats.usable && masked.mask) applyMaskAsAlpha(cut, masked.mask);
            else floodFillBackgroundAlpha(cut);

            monochrome = isEffectivelyMonochrome(cut);
            if (wantsEnhance) blackenVisible(cut);
            raster = await cut.getBufferAsync(Jimp.MIME_PNG);

            // Trace the raw distance field, not the mask built from it. The mask
            // is binary, and by this point has had small components deleted and
            // enclosed holes filled — on one Gujarati logo, 305 removed and 24
            // filled, which is what notched the monogram circle and doubled a
            // digit. The distance field is untouched by either, and being
            // continuous it lets potrace place each edge between pixels rather
            // than tracing a staircase.
            gray = (masked.distances && masked.stats.threshold)
                ? grayscaleForTrace(image, masked.distances, masked.stats.threshold)
                : grayscaleFromAlpha(cut);
            maskedBackground = true;
        } else {
            const cut = image.clone();
            if (wantsEnhance) blackenVisible(cut);
            raster = await cut.getBufferAsync(Jimp.MIME_PNG);
            monochrome = isEffectivelyMonochrome(cut);
        }

        if (monochrome) {
            flattened = gray
                ? await gray.getBufferAsync(Jimp.MIME_PNG)
                : await flattenOntoWhite(image);
        }
    } catch (readErr) {
        console.warn('Rejected unreadable upload:', readErr.message);
        return res.status(400).json({ error: 'Could not read that image file.', detail: readErr.message });
    }

    try {
        let svg;
        let eps = null;
        let ms;
        let engine;

        if (monochrome) {
            // Single colour: potrace fits one optimised path, and svgToEps can
            // convert that, so an EPS comes back for free.
            engine = 'potrace';
            const started = Date.now();
            svg = await new Promise((resolve, reject) => {
                potrace.trace(flattened, {
                    ...MAX_DETAIL_TRACE_OPTIONS,
                    color: '#000000',
                    threshold: 128,
                    blackOnWhite: true,
                }, (err, out) => (err ? reject(err) : resolve(out)));
            });
            ms = Date.now() - started;
            try {
                eps = potraceSvgToEps(svg);
            } catch (epsErr) {
                console.warn('EPS conversion skipped:', epsErr.message);
            }
        } else {
            engine = 'vtracer';
            const traced = await vectorizeToSvg(raster, opts, VTRACER_TIMEOUT_MS);
            svg = traced.svg;
            ms = traced.ms;
        }

        res.json({
            svg,
            eps,
            enhancedPng: enhancedDataUrl,
            meta: {
                engine,
                ms,
                backgroundRemoved: maskedBackground || wantsCutout,
                monochrome,
                options: monochrome ? null : opts,
                size: sourceSize,
                aiEnhance: enhanceMeta,
                aiEnhanceError: enhanceError,
            },
        });
    } catch (traceErr) {
        if (traceErr.code === 'ETIMEDOUT') {
            console.error('VTracer timed out:', traceErr.message);
            return res.status(504).json({ error: 'Conversion took too long. Try a smaller image or fewer colours.' });
        }
        console.error('VTracer failed:', traceErr);
        res.status(500).json({ error: 'Vector trace failed.' });
    }
});

// Multer rejects an oversized upload by throwing rather than calling the route,
// so without this the client sees an HTML error page instead of a usable message.
app.use((err, req, res, next) => {
    if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
            return res.status(413).json({ error: `File is too large. Maximum upload size is ${MAX_UPLOAD_MB} MB.` });
        }
        return res.status(400).json({ error: `Upload rejected: ${err.message}` });
    }
    if (err) {
        console.error('Unhandled error:', err);
        return res.status(500).json({ error: 'Server error.' });
    }
    next();
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`mockupdibiaa-backend listening on port ${PORT}`);
});
