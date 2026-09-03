// Full-colour raster -> SVG vectorisation, backed by VTracer.
//
// VTracer (MIT, Rust) is used through @neplex/vectorizer, a napi binding that
// ships prebuilt binaries for linux-x64-gnu among others. That is deliberate:
// the alternative was installing the VTracer CLI into the container and shelling
// out to it, which would have meant introducing a Dockerfile purely to fetch one
// binary — Railway builds this service with Nixpacks today. Running in-process
// also removes the whole temp-file lifecycle: nothing is ever written to disk, so
// there is no upload directory to clean up and no way for it to grow unbounded.
//
// This complements rather than replaces the potrace path in server.js. VTracer's
// colour mode is far better at general artwork, but its binary mode ignores the
// alpha channel and inverts a cut-out logo into white-on-black, so black
// silhouette output stays on potrace, which is already tuned for it.

const Jimp = require('jimp');
const { vectorize } = require('@neplex/vectorizer');

// @neplex/vectorizer exports ColorMode/Hierarchical/PathSimplifyMode, but in
// 0.1.0 those objects come back empty at runtime, so `ColorMode.Color` is
// undefined and silently falls back to a default. The numeric values below are
// the ones the native ABI actually expects (js-bindings.d.ts), so pass them
// directly rather than trusting the exported enums.
const COLOR_MODE_COLOR = 0;
const HIERARCHICAL_STACKED = 0;
const PATH_MODE_POLYGON = 1;
const PATH_MODE_SPLINE = 2;

// Tracing cost grows with pixel count, and the SVG grows with it: measured on a
// synthetic photo, 1000px took 0.4s for a 4MB SVG, 1600px 1.8s/11MB, and 4000px
// 23.7s for a 74MB SVG. A 74MB SVG is useless to a browser and to CorelDRAW, and
// 23.7s is close enough to the timeout to fail intermittently. So large inputs
// are downscaled before tracing — a logo is never affected, and a photo loses
// nothing that survives vectorisation anyway.
const DEFAULT_MAX_EDGE = 2000;

const DEFAULTS = {
    colorPrecision: 6,
    filterSpeckle: 4,
    cornerThreshold: 60,
    mode: 'spline',
    layerDifference: 16,
    lengthThreshold: 4,
    maxIterations: 10,
    spliceThreshold: 45,
};

function clampInt(value, min, max, fallback) {
    const n = typeof value === 'string' ? parseInt(value, 10) : value;
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, Math.round(n)));
}

function parseBool(value, fallback) {
    if (value === undefined || value === null || value === '') return fallback;
    if (typeof value === 'boolean') return value;
    return !/^(false|0|no|off)$/i.test(String(value).trim());
}

// Reads the tracing knobs off a request, clamped to ranges VTracer accepts.
function parseVectorizeOptions(src = {}) {
    const mode = String(src.mode || DEFAULTS.mode).toLowerCase() === 'polygon' ? 'polygon' : 'spline';
    return {
        // Bits per RGB channel. The spec sketched a 1-10 slider, but the channels
        // are 8-bit, so anything above 8 is meaningless — clamped, and the UI
        // slider matches.
        colorPrecision: clampInt(src.colorPrecision, 1, 8, DEFAULTS.colorPrecision),
        filterSpeckle: clampInt(src.filterSpeckle, 0, 128, DEFAULTS.filterSpeckle),
        cornerThreshold: clampInt(src.cornerThreshold, 0, 180, DEFAULTS.cornerThreshold),
        mode,
        layerDifference: clampInt(src.layerDifference, 0, 128, DEFAULTS.layerDifference),
        lengthThreshold: clampInt(src.lengthThreshold, 0, 128, DEFAULTS.lengthThreshold),
        maxIterations: clampInt(src.maxIterations, 1, 64, DEFAULTS.maxIterations),
        spliceThreshold: clampInt(src.spliceThreshold, 0, 180, DEFAULTS.spliceThreshold),
    };
}

function toVtracerConfig(opts) {
    return {
        colorMode: COLOR_MODE_COLOR,
        hierarchical: HIERARCHICAL_STACKED,
        filterSpeckle: opts.filterSpeckle,
        colorPrecision: opts.colorPrecision,
        layerDifference: opts.layerDifference,
        mode: opts.mode === 'polygon' ? PATH_MODE_POLYGON : PATH_MODE_SPLINE,
        cornerThreshold: opts.cornerThreshold,
        lengthThreshold: opts.lengthThreshold,
        maxIterations: opts.maxIterations,
        spliceThreshold: opts.spliceThreshold,
    };
}

// Rejects with a tagged error once ms elapses. The underlying trace keeps running
// on the napi thread pool — it cannot be cancelled from JS — but the request stops
// waiting on it, which is what the caller needs in order to answer with a 504.
function withTimeout(promise, ms, label) {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
            const err = new Error(`${label} timed out after ${ms}ms`);
            err.code = 'ETIMEDOUT';
            reject(err);
        }, ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function vectorizeToSvg(pngBuffer, opts, timeoutMs) {
    const config = toVtracerConfig(opts);
    const started = Date.now();
    const svg = await withTimeout(vectorize(pngBuffer, config), timeoutMs, 'Vector trace');
    return { svg, ms: Date.now() - started };
}

// Reports whether the native binary actually loaded, for debugging deploys where
// the prebuilt package for the container's platform failed to install.
async function vectorizeHealth() {
    const probe = await new Jimp(8, 8, 0xff0000ff).getBufferAsync(Jimp.MIME_PNG);
    const svg = await vectorize(probe, toVtracerConfig(parseVectorizeOptions()));
    return {
        engine: 'vtracer',
        binding: '@neplex/vectorizer',
        version: require('@neplex/vectorizer/package.json').version,
        ok: typeof svg === 'string' && svg.includes('<svg'),
    };
}

module.exports = {
    DEFAULTS,
    DEFAULT_MAX_EDGE,
    parseVectorizeOptions,
    parseBool,
    clampInt,
    vectorizeToSvg,
    vectorizeHealth,
    withTimeout,
};
