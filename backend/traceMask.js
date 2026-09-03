// Turns an arbitrary logo image into a clean two-tone mask (black artwork on a
// white ground) for potrace to trace.
//
// Why not just let potrace threshold it? Potrace applies ONE global luminance
// cutoff. Logos with 3D bevels / metallic gradients (gold, chrome) swing from
// bright highlight to near-background shadow *within a single letter*, so a
// luminance cutoff slices through the middle of the artwork and punches the
// dark bands out as holes — the "patches" this replaces.
//
// Instead: measure each pixel's distance from the *background colour* (sampled
// from the border), which stays large across an entire shaded letter, then fill
// small enclosed holes so speckle can't survive while real letter counters do.

const Jimp = require('jimp');

const BG_SAMPLE_DIVISOR = 120;
// An enclosed background region smaller than this fraction of the image is
// treated as a threshold artifact and filled in. Real letter counters (the
// hole in a "G", "O", "e") are far larger than this; speckle is far smaller.
const HOLE_FILL_MAX_AREA_FRACTION = 0.0012;
// Boundary smoothing radius, in pixels, applied to the mask before tracing.
// Boundary smoothing radius. Measured at 0: smoothing made shapes measurably
// *less* faithful (IoU 0.960 -> 0.930) and over-rounded edges that were already
// slightly smoother than the original artwork. Kept available but off.
const MASK_SMOOTH_RADIUS = 0;
// Isolated artwork specks below this fraction are threshold noise. Kept well
// under the size of real punctuation (a comma/period survives comfortably).
const SPECK_MAX_AREA_FRACTION = 0.000015;

function sampleBackground(bitmap) {
    const { width: w, height: h, data } = bitmap;
    const step = Math.max(1, Math.floor(Math.min(w, h) / BG_SAMPLE_DIVISOR));
    let r = 0, g = 0, b = 0, n = 0, transparent = 0;

    const take = (x, y) => {
        const i = (y * w + x) * 4;
        const a = data[i + 3];
        // potrace composites non-opaque pixels over white, so match that here.
        if (a < 128) { r += 255; g += 255; b += 255; transparent++; }
        else { r += data[i]; g += data[i + 1]; b += data[i + 2]; }
        n++;
    };
    for (let x = 0; x < w; x += step) { take(x, 0); take(x, h - 1); }
    for (let y = 0; y < h; y += step) { take(0, y); take(w - 1, y); }

    return { r: r / n, g: g / n, b: b / n, mostlyTransparent: transparent / n > 0.5 };
}

// The background sits in a tight cluster near distance 0; the artwork spreads
// far above it. So rather than splitting the histogram (Otsu lands mid-artwork
// when the logo is only a few percent of the frame), measure the spread of the
// *known* background samples and cut just above their noise floor.
function thresholdFromBackgroundNoise(borderDistances) {
    const n = borderDistances.length;
    const mean = borderDistances.reduce((s, v) => s + v, 0) / n;
    const variance = borderDistances.reduce((s, v) => s + (v - mean) * (v - mean), 0) / n;
    const sd = Math.sqrt(variance);
    // Floor covers JPEG ringing and anti-aliased edges on a perfectly flat
    // background; the ceiling stops a noisy/gradient background from raising
    // the cut so far that it eats the artwork.
    return Math.min(60, Math.max(14, mean + 5 * sd));
}

// Marks background regions that are sealed off from the image border and small
// enough to be artifacts, then flips them to artwork.
function fillEnclosedHoles(mask, w, h) {
    const total = w * h;
    const reachable = new Uint8Array(total);
    const stack = [];

    for (let x = 0; x < w; x++) {
        if (!mask[x]) { reachable[x] = 1; stack.push(x); }
        const bottom = (h - 1) * w + x;
        if (!mask[bottom]) { reachable[bottom] = 1; stack.push(bottom); }
    }
    for (let y = 0; y < h; y++) {
        const left = y * w, right = y * w + w - 1;
        if (!mask[left]) { reachable[left] = 1; stack.push(left); }
        if (!mask[right]) { reachable[right] = 1; stack.push(right); }
    }
    while (stack.length) {
        const p = stack.pop();
        const x = p % w, y = (p - x) / w;
        if (x > 0 && !mask[p - 1] && !reachable[p - 1]) { reachable[p - 1] = 1; stack.push(p - 1); }
        if (x < w - 1 && !mask[p + 1] && !reachable[p + 1]) { reachable[p + 1] = 1; stack.push(p + 1); }
        if (y > 0 && !mask[p - w] && !reachable[p - w]) { reachable[p - w] = 1; stack.push(p - w); }
        if (y < h - 1 && !mask[p + w] && !reachable[p + w]) { reachable[p + w] = 1; stack.push(p + w); }
    }

    const maxArea = Math.max(24, Math.floor(total * HOLE_FILL_MAX_AREA_FRACTION));
    const seen = new Uint8Array(total);
    let filled = 0;
    for (let start = 0; start < total; start++) {
        if (mask[start] || reachable[start] || seen[start]) continue;
        const region = [];
        seen[start] = 1;
        const queue = [start];
        while (queue.length) {
            const p = queue.pop();
            region.push(p);
            const x = p % w, y = (p - x) / w;
            const push = (q) => { if (!mask[q] && !reachable[q] && !seen[q]) { seen[q] = 1; queue.push(q); } };
            if (x > 0) push(p - 1);
            if (x < w - 1) push(p + 1);
            if (y > 0) push(p - w);
            if (y < h - 1) push(p + w);
        }
        if (region.length <= maxArea) {
            for (const p of region) mask[p] = 1;
            filled++;
        }
    }
    return filled;
}


// Drops isolated artwork blobs too small to be real — the scatter that a
// threshold leaves behind around shaded edges.
function removeSmallSpecks(mask, w, h) {
    const total = w * h;
    const maxArea = Math.max(6, Math.floor(total * SPECK_MAX_AREA_FRACTION));
    const seen = new Uint8Array(total);
    let removed = 0;
    for (let start = 0; start < total; start++) {
        if (!mask[start] || seen[start]) continue;
        const region = [];
        seen[start] = 1;
        const queue = [start];
        while (queue.length) {
            const p = queue.pop();
            region.push(p);
            if (region.length > maxArea) break; // too big to be a speck
            const x = p % w, y = (p - x) / w;
            const push = (q) => { if (mask[q] && !seen[q]) { seen[q] = 1; queue.push(q); } };
            if (x > 0) push(p - 1);
            if (x < w - 1) push(p + 1);
            if (y > 0) push(p - w);
            if (y < h - 1) push(p + w);
        }
        if (region.length <= maxArea) {
            for (const p of region) mask[p] = 0;
            removed++;
        }
    }
    return removed;
}


// A logo exported with a margin (white frame around a coloured panel) would
// otherwise trace the panel itself as artwork — a big filled rectangle with the
// logo sitting on it. So after masking out the border colour, check whether
// what's left is dominated by one large, flat region: that's another background
// layer, not artwork. Strip it and look again.
const PANEL_MIN_AREA_FRACTION = 0.4;
const PANEL_MAX_COLOR_SPREAD = 34;
// A background panel is a filled rectangle spanning most of the frame. Real
// artwork — even a big solid emblem — has gaps and curves, so its area falls
// well short of its bounding box. These two keep the panel test from eating a
// logo that simply happens to be large and flat.
const PANEL_MIN_BBOX_SPAN = 0.7;
const PANEL_MIN_FILL_RATIO = 0.85;

function largestComponentStats(mask, bitmap) {
    const { width: w, height: h, data } = bitmap;
    const total = w * h;
    const seen = new Uint8Array(total);
    let best = null;

    for (let start = 0; start < total; start++) {
        if (!mask[start] || seen[start]) continue;
        const pixels = [];
        seen[start] = 1;
        const queue = [start];
        while (queue.length) {
            const p = queue.pop();
            pixels.push(p);
            const x = p % w, y = (p - x) / w;
            const push = (q) => { if (mask[q] && !seen[q]) { seen[q] = 1; queue.push(q); } };
            if (x > 0) push(p - 1);
            if (x < w - 1) push(p + 1);
            if (y > 0) push(p - w);
            if (y < h - 1) push(p + w);
        }
        if (!best || pixels.length > best.pixels.length) best = { pixels };
    }
    if (!best) return null;

    let r = 0, g = 0, b = 0;
    let minX = w, maxX = -1, minY = h, maxY = -1;
    for (const p of best.pixels) {
        const i = p * 4;
        r += data[i]; g += data[i + 1]; b += data[i + 2];
        const x = p % w, y = (p - x) / w;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
    }
    const bboxW = maxX - minX + 1;
    const bboxH = maxY - minY + 1;
    const n = best.pixels.length;
    r /= n; g /= n; b /= n;
    // Uniformity is measured on the region's OUTER EDGE, not the whole region.
    // A background panel's rim is pure panel colour no matter how much artwork
    // sits in the middle of it; measuring the whole region instead makes a
    // panel with large artwork on it look "non-uniform" and slip through.
    const inRegion = new Uint8Array(total);
    for (const p of best.pixels) inRegion[p] = 1;
    const edge = [];
    for (const p of best.pixels) {
        const x = p % w, y = (p - x) / w;
        const outside =
            (x === 0 || !inRegion[p - 1]) ||
            (x === w - 1 || !inRegion[p + 1]) ||
            (y === 0 || !inRegion[p - w]) ||
            (y === h - 1 || !inRegion[p + w]);
        if (outside) edge.push(p);
    }
    let er = 0, eg = 0, eb = 0;
    for (const p of edge) {
        const i = p * 4;
        er += data[i]; eg += data[i + 1]; eb += data[i + 2];
    }
    const en = Math.max(1, edge.length);
    er /= en; eg /= en; eb /= en;
    let spread = 0;
    const step = Math.max(1, Math.floor(edge.length / 5000));
    let counted = 0;
    for (let i = 0; i < edge.length; i += step) {
        const idx = edge[i] * 4;
        const dr = data[idx] - er, dg = data[idx + 1] - eg, db = data[idx + 2] - eb;
        spread += Math.sqrt(dr * dr + dg * dg + db * db);
        counted++;
    }
    return {
        area: n,
        fraction: n / total,
        color: { r: er, g: eg, b: eb },
        spread: spread / Math.max(1, counted),
        bboxSpanX: bboxW / w,
        bboxSpanY: bboxH / h,
        fillRatio: n / (bboxW * bboxH),
    };
}


// When the image already carries transparency — a cut-out PNG, or the result of
// remove.bg — the alpha channel IS the mask, exactly and without guessing. Use
// it directly rather than inferring the background from colour.
const ALPHA_MASK_MIN_TRANSPARENT_FRACTION = 0.05;

function alphaMask(bitmap) {
    const { width: w, height: h, data } = bitmap;
    const total = w * h;
    let transparent = 0;
    for (let p = 0; p < total; p++) {
        if (data[p * 4 + 3] < 128) transparent++;
    }
    if (transparent / total < ALPHA_MASK_MIN_TRANSPARENT_FRACTION) return null;

    const mask = new Uint8Array(total);
    for (let p = 0; p < total; p++) {
        if (data[p * 4 + 3] >= 128) mask[p] = 1;
    }
    return mask;
}


// Smooths the mask boundary: box-blur the binary mask and re-threshold at half.
// JPEG ringing and pixel staircasing otherwise get traced faithfully as jagged
// edges; this removes those without moving the shape itself.
function smoothMask(mask, w, h, radius) {
    if (!radius || radius < 1) return mask;
    const total = w * h;
    // Integral image for an O(1)-per-pixel box blur.
    const sum = new Int32Array((w + 1) * (h + 1));
    for (let y = 0; y < h; y++) {
        let rowSum = 0;
        for (let x = 0; x < w; x++) {
            rowSum += mask[y * w + x];
            sum[(y + 1) * (w + 1) + (x + 1)] = sum[y * (w + 1) + (x + 1)] + rowSum;
        }
    }
    const out = new Uint8Array(total);
    for (let y = 0; y < h; y++) {
        const y0 = Math.max(0, y - radius), y1 = Math.min(h - 1, y + radius);
        for (let x = 0; x < w; x++) {
            const x0 = Math.max(0, x - radius), x1 = Math.min(w - 1, x + radius);
            const area = (x1 - x0 + 1) * (y1 - y0 + 1);
            const s = sum[(y1 + 1) * (w + 1) + (x1 + 1)]
                    - sum[y0 * (w + 1) + (x1 + 1)]
                    - sum[(y1 + 1) * (w + 1) + x0]
                    + sum[y0 * (w + 1) + x0];
            out[y * w + x] = (s * 2 >= area) ? 1 : 0;
        }
    }
    return out;
}


// Builds the mask from the ORIGINAL full-resolution image, using a remove.bg
// cut-out purely as a guide to *where* the background is.
//
// Why not just trace the cut-out directly? remove.bg's free tier returns a
// ~0.25MP preview, so a detailed logo comes back at roughly 500px — tracing
// that (and upscaling it) destroys thin hairlines and fattens every stroke.
// The guide only needs to be coarse; the original supplies the exact edges.
const GUIDE_BACKGROUND_ALPHA = 60;
const GUIDE_FOREGROUND_ALPHA = 200;
// The true edge of a stroke sits halfway between background and solid artwork.
const EDGE_MIDPOINT_FRACTION = 0.45;

function buildGuidedMask(image, guide) {
    const { width: w, height: h, data } = image.bitmap;
    const total = w * h;

    // Match the guide to the original's dimensions; it is deliberately coarse.
    const scaled = guide.clone().resize(w, h, Jimp.RESIZE_BILINEAR);
    const gd = scaled.bitmap.data;

    let br = 0, bg = 0, bb = 0, bn = 0;
    for (let p = 0; p < total; p++) {
        if (gd[p * 4 + 3] < GUIDE_BACKGROUND_ALPHA) {
            const i = p * 4;
            br += data[i]; bg += data[i + 1]; bb += data[i + 2];
            bn++;
        }
    }
    if (!bn) return null;
    br /= bn; bg /= bn; bb /= bn;

    const distanceTo = (p) => {
        const i = p * 4;
        const dr = data[i] - br, dg = data[i + 1] - bg, db = data[i + 2] - bb;
        return Math.sqrt(dr * dr + dg * dg + db * db);
    };

    // How far solid artwork sits from the background sets the edge midpoint,
    // which is what keeps stroke weight true instead of running fat.
    const fgDistances = [];
    for (let p = 0; p < total; p++) {
        if (gd[p * 4 + 3] > GUIDE_FOREGROUND_ALPHA) fgDistances.push(distanceTo(p));
    }
    if (fgDistances.length < 32) return null;
    fgDistances.sort((a, b) => a - b);
    const medianFg = fgDistances[Math.floor(fgDistances.length / 2)];
    const threshold = medianFg * EDGE_MIDPOINT_FRACTION;

    const mask = new Uint8Array(total);
    let count = 0;
    for (let p = 0; p < total; p++) {
        if (distanceTo(p) > threshold) { mask[p] = 1; count++; }
    }

    const smoothed = smoothMask(mask, w, h, MASK_SMOOTH_RADIUS);
    mask.set(smoothed);
    const removed = removeSmallSpecks(mask, w, h);
    const filled = fillEnclosedHoles(mask, w, h);
    count = 0;
    for (let p = 0; p < total; p++) if (mask[p]) count++;
    const fgRatio = count / total;
    if (fgRatio < 0.002 || fgRatio > 0.9) return null;

    const out = new Jimp(w, h, 0xffffffff);
    const od = out.bitmap.data;
    for (let p = 0; p < total; p++) {
        const i = p * 4;
        const v = mask[p] ? 0 : 255;
        od[i] = v; od[i + 1] = v; od[i + 2] = v; od[i + 3] = 255;
    }
    return { image: out, mask, stats: { threshold, medianFg, filled, removed, fgRatio, source: 'guided', usable: true } };
}

// image: a Jimp instance. Returns { image, stats } where image is a two-tone
// Jimp bitmap (black artwork on white) ready for potrace.
function buildTraceMask(image) {
    const { width: w, height: h, data } = image.bitmap;
    const total = w * h;

    let fromAlpha = alphaMask(image.bitmap);
    if (fromAlpha) {
        fromAlpha = smoothMask(fromAlpha, w, h, MASK_SMOOTH_RADIUS);
        const removedA = removeSmallSpecks(fromAlpha, w, h);
        const filledA = fillEnclosedHoles(fromAlpha, w, h);
        let countA = 0;
        for (let p = 0; p < total; p++) if (fromAlpha[p]) countA++;
        const ratioA = countA / total;
        if (ratioA >= 0.002 && ratioA <= 0.9) {
            const outA = new Jimp(w, h, 0xffffffff);
            const dA = outA.bitmap.data;
            for (let p = 0; p < total; p++) {
                const i = p * 4;
                const v = fromAlpha[p] ? 0 : 255;
                dA[i] = v; dA[i + 1] = v; dA[i + 2] = v; dA[i + 3] = 255;
            }
            return {
                image: outA,
                mask: fromAlpha,
                stats: { threshold: null, filled: filledA, removed: removedA, fgRatio: ratioA, source: 'alpha', usable: true },
            };
        }
    }

    const bg = sampleBackground(image.bitmap);

    // Background colours to subtract. Starts with the border colour; a nested
    // panel (margin around a coloured background) adds another below.
    const backgrounds = [{ r: bg.r, g: bg.g, b: bg.b }];

    const distances = new Uint8Array(total);
    const step = Math.max(1, Math.floor(Math.min(w, h) / BG_SAMPLE_DIVISOR));

    let mask = null;
    let threshold = 0;
    let fgCount = 0;

    for (let pass = 0; pass < 3; pass++) {
        for (let p = 0; p < total; p++) {
            const i = p * 4;
            const a = data[i + 3];
            let r, g, b;
            if (a < 128) { r = 255; g = 255; b = 255; }
            else { r = data[i]; g = data[i + 1]; b = data[i + 2]; }
            // Distance to the NEAREST background colour, so every background
            // layer is subtracted at once.
            let nearest = Infinity;
            for (const c of backgrounds) {
                const dr = r - c.r, dg = g - c.g, db = b - c.b;
                const d = dr * dr + dg * dg + db * db;
                if (d < nearest) nearest = d;
            }
            distances[p] = Math.min(255, Math.round(Math.sqrt(nearest) * 0.65));
        }

        const borderDistances = [];
        for (let x = 0; x < w; x += step) {
            borderDistances.push(distances[x], distances[(h - 1) * w + x]);
        }
        for (let y = 0; y < h; y += step) {
            borderDistances.push(distances[y * w], distances[y * w + w - 1]);
        }
        threshold = thresholdFromBackgroundNoise(borderDistances);

        mask = new Uint8Array(total);
        fgCount = 0;
        for (let p = 0; p < total; p++) {
            if (distances[p] > threshold) { mask[p] = 1; fgCount++; }
        }

        const largest = largestComponentStats(mask, image.bitmap);
        const isPanel = largest
            && largest.fraction > PANEL_MIN_AREA_FRACTION
            && largest.spread < PANEL_MAX_COLOR_SPREAD
            && largest.bboxSpanX > PANEL_MIN_BBOX_SPAN
            && largest.bboxSpanY > PANEL_MIN_BBOX_SPAN
            && largest.fillRatio > PANEL_MIN_FILL_RATIO;
        if (!isPanel) break;
        backgrounds.push(largest.color);
    }

    // Second pass: the first threshold only had to separate artwork from the
    // background's noise floor, which sits well below the real edge and so runs
    // fat. Now that we know which pixels are artwork, put the threshold at the
    // midpoint between background and solid artwork — that's where the true
    // edge of a stroke lies, and it keeps hairlines at their real weight.
    const confident = [];
    for (let p = 0; p < total; p++) {
        if (mask[p]) confident.push(distances[p]);
    }
    if (confident.length > 32) {
        confident.sort((a, b) => a - b);
        const medianFg = confident[Math.floor(confident.length / 2)];
        const midpoint = medianFg * EDGE_MIDPOINT_FRACTION;
        if (midpoint > threshold) {
            threshold = midpoint;
            for (let p = 0; p < total; p++) mask[p] = distances[p] > threshold ? 1 : 0;
        }
    }

    // JPEG ringing along high-contrast edges otherwise gets traced as hair-like
    // fringes; smoothing the mask boundary removes those without moving the shape.
    mask = smoothMask(mask, w, h, MASK_SMOOTH_RADIUS);

    const removed = removeSmallSpecks(mask, w, h);
    const filled = fillEnclosedHoles(mask, w, h);

    fgCount = 0;
    for (let p = 0; p < total; p++) if (mask[p]) fgCount++;
    const fgRatio = fgCount / total;

    // Sanity guard: the border-is-background assumption breaks if the artwork
    // bleeds to the edge, which would leave a near-empty or near-solid mask.
    if (fgRatio < 0.002 || fgRatio > 0.9) {
        return { image: null, mask: null, stats: { threshold, filled, removed, fgRatio, bg, backgrounds, usable: false } };
    }

    const out = new Jimp(w, h, 0xffffffff);
    const outData = out.bitmap.data;
    for (let p = 0; p < total; p++) {
        const i = p * 4;
        const v = mask[p] ? 0 : 255;
        outData[i] = v; outData[i + 1] = v; outData[i + 2] = v; outData[i + 3] = 255;
    }

    return { image: out, mask, stats: { threshold, filled, removed, fgRatio, bg, backgrounds, usable: true } };
}

module.exports = { buildTraceMask, buildGuidedMask, smoothMask };
