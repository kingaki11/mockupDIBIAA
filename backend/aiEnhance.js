// Optional AI clean-up pass, run before tracing.
//
// Sends the upload to OpenAI's image model and asks it to redraw the artwork
// cleanly with the background removed, at a higher resolution than the source.
// The redrawn PNG is then traced by the normal pipeline, so a small, noisy or
// badly-scanned logo can produce a cleaner vector than the original would.
//
// IMPORTANT, and the reason this is off by default: the model REDRAWS, it does
// not upscale. Measured on a Georgia-set wordmark, it kept the spelling, the
// colours and the layout, but returned visibly bolder letterforms with blunter
// serifs and a different 'g'. That is fine for tidying up a rough scan and wrong
// for a client's brand mark, where the typeface has to survive exactly. Callers
// opt in per conversion, and the frontend shows the redraw beside the original
// so the difference is visible before anyone downloads it.

const OPENAI_IMAGE_EDITS_URL = 'https://api.openai.com/v1/images/edits';

const DEFAULT_MODEL = 'gpt-image-1';
const DEFAULT_QUALITY = 'medium';   // low | medium | high — medium is the cost/quality middle

// Published per-million-token rates for gpt-image-1, used only to show an
// estimated cost alongside the (factual) token counts the API returns.
const RATE_TEXT_INPUT_PER_M = 5;
const RATE_IMAGE_INPUT_PER_M = 10;
const RATE_IMAGE_OUTPUT_PER_M = 40;

// Flat black, not the original colours. Two reasons. It is what the artwork is
// for — single-colour printing on boxes — and it also traces far better: a gold
// gradient gets quantised into dozens of colour bands, so the vector visibly
// drifts from the image it was traced from, while flat black comes back as
// clean single-colour paths.
const PROMPT = [
    'Redraw this exact logo as flat, solid black artwork on a fully transparent background.',
    'Keep the lettering, wording, spelling, typeface, proportions, spacing and layout identical to the original,',
    'including every decorative element such as sparkles, stars, rules and sub-text.',
    'Render everything in pure solid black (#000000).',
    'No gradients, no gold, no metallic effect, no shading, no highlights, no 3D bevel, no drop shadow, no outline.',
    'Enclosed areas inside letters must stay fully transparent, not filled.',
    'The result must look like a clean single-colour vector logo ready for printing.',
].join(' ');

// gpt-image-1 only accepts these three sizes, so pick the one matching the
// source's orientation rather than squashing everything into a square.
function sizeForAspect(width, height) {
    const ratio = width / height;
    if (ratio > 1.2) return '1536x1024';
    if (ratio < 0.83) return '1024x1536';
    return '1024x1024';
}

function estimateCostUsd(usage) {
    if (!usage) return null;
    const details = usage.input_tokens_details || {};
    const textIn = details.text_tokens || 0;
    const imageIn = details.image_tokens || 0;
    const imageOut = (usage.output_tokens_details || {}).image_tokens || usage.output_tokens || 0;
    const usd = (textIn * RATE_TEXT_INPUT_PER_M
        + imageIn * RATE_IMAGE_INPUT_PER_M
        + imageOut * RATE_IMAGE_OUTPUT_PER_M) / 1e6;
    return Math.round(usd * 10000) / 10000;
}

function isConfigured() {
    return Boolean(process.env.OPENAI_API_KEY);
}

// Returns a PNG buffer of the redrawn artwork, plus what it cost.
async function enhanceImage(buffer, mimetype, { width, height }, timeoutMs) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
        const err = new Error('AI enhancement is not configured on this server.');
        err.code = 'ENOKEY';
        throw err;
    }

    const model = process.env.OPENAI_IMAGE_MODEL || DEFAULT_MODEL;
    const quality = process.env.OPENAI_IMAGE_QUALITY || DEFAULT_QUALITY;
    const size = sizeForAspect(width, height);

    const form = new FormData();
    form.append('model', model);
    form.append('image', new Blob([buffer], { type: mimetype }), 'logo.png');
    form.append('prompt', PROMPT);
    form.append('quality', quality);
    form.append('size', size);
    form.append('background', 'transparent');

    // The call took 17s on a small logo in testing, so the timeout is generous;
    // AbortController actually cancels the request, unlike the trace timeout.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let res;
    try {
        res = await fetch(OPENAI_IMAGE_EDITS_URL, {
            method: 'POST',
            headers: { Authorization: `Bearer ${apiKey}` },
            body: form,
            signal: controller.signal,
        });
    } catch (fetchErr) {
        if (fetchErr.name === 'AbortError') {
            const err = new Error(`AI enhancement timed out after ${timeoutMs}ms`);
            err.code = 'ETIMEDOUT';
            throw err;
        }
        throw fetchErr;
    } finally {
        clearTimeout(timer);
    }

    if (!res.ok) {
        const detail = await res.text().catch(() => '');
        let message = `OpenAI returned ${res.status}`;
        try {
            const parsed = JSON.parse(detail);
            if (parsed.error && parsed.error.message) message = parsed.error.message;
        } catch (_) { /* keep the status-only message */ }
        const err = new Error(message);
        err.code = res.status === 401 ? 'EBADKEY' : 'EUPSTREAM';
        err.status = res.status;
        throw err;
    }

    const payload = await res.json();
    const b64 = payload.data && payload.data[0] && payload.data[0].b64_json;
    if (!b64) throw new Error('OpenAI returned no image data.');

    return {
        buffer: Buffer.from(b64, 'base64'),
        meta: {
            model,
            quality,
            size,
            usage: payload.usage || null,
            estimatedCostUsd: estimateCostUsd(payload.usage),
        },
    };
}

module.exports = { enhanceImage, isConfigured, DEFAULT_MODEL, DEFAULT_QUALITY };
