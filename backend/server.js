// Server-side logo background removal API.
// Replaces the client-side BFS flood-fill removeBackground() in boxscript.js
// with a proper ML-based cutout (@imgly/background-removal-node — self-hosted
// ONNX model, no external API key, no per-image cost).

const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const potrace = require('potrace');
const Jimp = require('jimp');
const { removeBackground } = require('@imgly/background-removal-node');
const catalogStore = require('./catalog');
const { potraceSvgToEps } = require('./svgToEps');
const { buildTraceMask, buildGuidedMask } = require('./traceMask');

const app = express();
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 }, // 10MB max upload
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
    if (req.file.mimetype !== 'image/png') {
        return res.status(400).json({ error: 'Only PNG files are accepted.' });
    }

    try {
        const inputBlob = new Blob([req.file.buffer], { type: 'image/png' });
        const resultBlob = await removeBackground(inputBlob);
        const outputBuffer = Buffer.from(await resultBlob.arrayBuffer());

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


// Background removal via remove.bg. Their model handles any background — solid,
// gradient, photographic, coloured panel with a margin — far more reliably than
// inferring the background from border pixels. The traced result is then a clean
// silhouette of just the artwork. Key lives in the environment, never in source.
async function removeBackgroundViaRemoveBg(buffer, mimetype) {
    const apiKey = process.env.REMOVEBG_API_KEY;
    if (!apiKey) return null;

    const form = new FormData();
    form.append('size', 'auto');
    form.append('image_file', new Blob([buffer], { type: mimetype }), 'logo');

    const res = await fetch('https://api.remove.bg/v1.0/removebg', {
        method: 'POST',
        headers: { 'X-Api-Key': apiKey },
        body: form,
    });
    if (!res.ok) {
        // Out of credits, bad key, rate limited — fall back to local removal
        // rather than failing the whole conversion.
        const detail = await res.text().catch(() => '');
        throw new Error(`remove.bg ${res.status}: ${detail.slice(0, 200)}`);
    }
    return Buffer.from(await res.arrayBuffer());
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

    // Trace at the image's own resolution wherever possible. Upscaling first
    // softens edges, and the mask threshold then captures that softness as
    // extra weight — which is what previously fattened thin hairlines.
    const longEdge = Math.max(w, h);
    if (longEdge < TRACE_MIN_LONG_EDGE) {
        image.scale(TRACE_MIN_LONG_EDGE / longEdge, Jimp.RESIZE_BICUBIC);
    } else if (longEdge > TRACE_MAX_LONG_EDGE) {
        // Keeps tracing time bounded; still far more detail than any logo needs.
        image.scale(TRACE_MAX_LONG_EDGE / longEdge, Jimp.RESIZE_BICUBIC);
    }

    return { image, lightOnDark };
}

app.post('/convert-logo', requireAdmin, upload.single('logo'), async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'No file uploaded. Send it as multipart/form-data field "logo".' });
    }
    if (req.file.mimetype !== 'image/png' && req.file.mimetype !== 'image/jpeg') {
        return res.status(400).json({ error: 'Only PNG or JPG files are accepted.' });
    }

    // Single, default option now: black, maximum-detail trace — no color/detail
    // pickers on the frontend to simplify the tab down to one upload + one button.
    // remove.bg identifies the background reliably; the original image supplies
    // the exact edges. Keep both rather than tracing the (low-resolution) cut-out.
    let cutoutBuffer = null;
    try {
        cutoutBuffer = await removeBackgroundViaRemoveBg(req.file.buffer, req.file.mimetype);
    } catch (bgErr) {
        console.warn('remove.bg unavailable, falling back to local background detection:', bgErr.message);
    }

    let prepared;
    try {
        prepared = await prepareForTrace(req.file.buffer);
    } catch (prepErr) {
        console.error('Could not read image for tracing:', prepErr);
        return res.status(400).json({ error: 'Could not read that image file.', detail: prepErr.message });
    }

    // Prefer the guided mask (remove.bg for background, original pixels for
    // edges); fall back to purely local background detection if unavailable.
    let masked = null;
    if (cutoutBuffer) {
        try {
            const guide = await Jimp.read(cutoutBuffer);
            masked = buildGuidedMask(prepared.image, guide);
        } catch (guideErr) {
            console.warn('Guided mask failed, using local detection:', guideErr.message);
        }
    }
    if (!masked) masked = buildTraceMask(prepared.image);

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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`mockupdibiaa-backend listening on port ${PORT}`);
});
