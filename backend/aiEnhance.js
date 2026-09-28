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
const OPENAI_CHAT_URL = 'https://api.openai.com/v1/chat/completions';

// Two vision models, not one, and they have different jobs.
//
// The everyday reader is the cheap one — a read costs a fraction of a cent
// against about a cent for a redraw. But a single reading is a single point of
// failure: on a stylised serif wordmark it once read VASTUKOSH as VANILLA, that
// misreading was pinned into the redraw as the text to reproduce, the image
// model duly drew VANILLA, and the verifier — the same model, with the same
// eye — read the original the same wrong way and passed it. Every check leaned
// on one misreading eye.
//
// So the wording is read twice, by two different models, and only pinned when
// they agree. The second opinion is the stronger model: it is also the one that
// verifies a redraw whenever the two readers disagreed, since that is exactly
// the case where the cheap eye has shown it cannot be trusted on this logo.
// gpt-6-luna replaces gpt-4o-mini as the everyday reader — the GPT-4 line is
// superseded, and luna is both cheaper and current.
const VERIFY_MODEL = 'gpt-6-luna';
const SECOND_OPINION_MODEL = 'gpt-6-sol';

// The model matters more here than anything else in the redraw path, because the
// failure it prevents is the model REINVENTING the artwork. gpt-image-1 returned
// "dbiaa" for "dibiaa", swapped a box mark for a chevron, and mangled Gujarati
// beyond use (રાણીંગા -> રાશીંગા, જવેલર્સ -> જ્બેલર્સ). Every model since has
// reproduced the same logos exactly.
//
// gpt-image-2.5-sunburst, because OpenAI is retiring the transparent-background
// preview on gpt-image-2 on 30 September 2026 and this path cannot work without
// it — a logo on an opaque ground is not a logo you can print on a box. Of the
// two replacements, sunburst is the one built for edits where precision matters
// most, which is exactly this: copying a real company's logo character for
// character. Its sibling gpt-image-2.5-flare is the same price and about twice
// as fast, so OPENAI_IMAGE_MODEL=gpt-image-2.5-flare is a fair trade if a
// conversion ever feels slow.
//
// Quality low, not medium, for the same reason the model changed: measurement.
// Low was indistinguishable from medium on every logo tried, at roughly a
// quarter of the price — $0.014 to $0.021 a conversion against $0.045 to $0.067
// on gpt-image-1 medium. Better and cheaper, so there is nothing to trade off.
// These models also accept xhigh and max, which cost more and buy nothing here.
const DEFAULT_MODEL = 'gpt-image-2.5-sunburst';
const DEFAULT_QUALITY = 'low';   // low | medium | high | xhigh | max

// Published per-million-token rates for the 2.5 image models, used only to show
// an estimated cost alongside the (factual) token counts the API returns. Both
// 2.5 models are cheaper than the one they replace — image output $30 against
// $40 — so the displayed figure would have been overstated had this stayed put.
const RATE_TEXT_INPUT_PER_M = 5;
const RATE_IMAGE_INPUT_PER_M = 8;
const RATE_IMAGE_OUTPUT_PER_M = 30;

// Flat black, not the original colours. Two reasons. It is what the artwork is
// for — single-colour printing on boxes — and it also traces far better: a gold
// gradient gets quantised into dozens of colour bands, so the vector visibly
// drifts from the image it was traced from, while flat black comes back as
// clean single-colour paths.
const PROMPT = [
    'Reproduce this logo EXACTLY as flat, solid black artwork on a fully transparent background.',
    'This is a real company logo: it must be copied faithfully, not reinterpreted or redesigned.',
    'Copy the wording character for character — same spelling, same number of letters, same case, same word order.',
    'Copy the typeface, letter shapes, proportions, spacing, alignment and layout.',
    'Copy every icon, symbol, mark or emblem in its original form and position — do NOT substitute,',
    'simplify, restyle or replace any mark with a different shape.',
    'Keep every decorative element such as sparkles, stars, rules and sub-text.',
    'Render everything in pure solid black (#000000).',
    'No gradients, no colour, no metallic effect, no shading, no highlights, no 3D bevel, no drop shadow, no outline.',
    'Enclosed areas inside letters must stay fully transparent, not filled.',
    'The result must look like a clean single-colour vector version of the SAME logo, ready for printing.',
].join(' ');

// Pick the standard size matching the source's orientation rather than squashing
// everything into a square. The 2.5 models accept arbitrary WIDTHxHEIGHT too,
// but the three fixed sizes are what every logo tried here was measured on.
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

// Scripts the image model cannot draw and the vision model cannot reliably read.
//
// A Gujarati jewellery logo came back with three corrupted words — રાણીંગા became
// રાશીંગા, જવેલર્સ became જ્બેલર્સ — and the verifier still passed it, because its own
// transcription of the original was already wrong. A verifier that cannot read the
// script cannot police it, and a confident "wording checked" on corrupted text is
// worse than no check at all.
//
// So anything outside Latin skips the redraw entirely. Tracing the original keeps
// every glyph exactly as supplied, costs nothing, and is the better output anyway.
// Common and Inherited cover digits, punctuation and combining marks, which appear
// in Latin logos too.
function hasNonLatinScript(text) {
    if (!text) return false;
    return /[^\p{Script=Latin}\p{Script=Common}\p{Script=Inherited}]/u.test(text);
}

async function chatJson(messages, timeoutMs, model) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
        const err = new Error('AI is not configured on this server.');
        err.code = 'ENOKEY';
        throw err;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await fetch(OPENAI_CHAT_URL, {
            method: 'POST',
            headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: model || process.env.OPENAI_VERIFY_MODEL || VERIFY_MODEL,
                // No temperature. The GPT-6 models accept only their default and
                // return 400 for anything else — which silently took out every
                // wording read and the verifier at once, and the redraw went
                // through with no checks at all.
                response_format: { type: 'json_object' },
                messages,
            }),
            signal: controller.signal,
        });
        if (!res.ok) {
            const detail = await res.text().catch(() => '');
            throw new Error(`verify call returned ${res.status}: ${detail.slice(0, 200)}`);
        }
        const payload = await res.json();
        const content = payload.choices && payload.choices[0] && payload.choices[0].message.content;
        return { data: JSON.parse(content), usage: payload.usage || null };
    } finally {
        clearTimeout(timer);
    }
}

function imagePart(buffer, mimetype) {
    return {
        type: 'image_url',
        image_url: { url: `data:${mimetype};base64,${buffer.toString('base64')}`, detail: 'high' },
    };
}

// Reads the wording off the original so it can be pinned into the redraw prompt.
// Telling the model the exact string it must reproduce is far more reliable than
// asking it to copy what it sees.
async function readLogoText(buffer, mimetype, timeoutMs, model) {
    const { data } = await chatJson([{
        role: 'user',
        content: [
            { type: 'text', text:
                'Transcribe every character of text in this logo exactly, preserving spelling, '
                + 'letter count, case and word order. Reply as JSON: {"text":"<exact text, empty string if none>"}.' },
            imagePart(buffer, mimetype),
        ],
    }], timeoutMs, model);
    return typeof data.text === 'string' ? data.text.trim() : '';
}

// The same compare used by the verifier: whitespace and case are what the
// models are inconsistent about; letters are what matter.
const normWording = (t) => String(t || '').replace(/\s+/g, ' ').trim().toLowerCase();
function sameWording(a, b) {
    return normWording(a).length > 0 && normWording(a) === normWording(b);
}

// How far apart two readings are, as a share of the longer one. Two readers
// that differ by one letter both saw the same word and one slipped; two that
// differ by most of the word saw different words, and one of them made it up.
// Those are different kinds of evidence and are treated differently.
function wordingDistance(a, b) {
    const x = normWording(a), y = normWording(b);
    if (!x.length && !y.length) return 0;
    if (!x.length || !y.length) return 1;
    let prev = Array.from({ length: y.length + 1 }, (_, j) => j);
    for (let i = 1; i <= x.length; i++) {
        const cur = [i];
        for (let j = 1; j <= y.length; j++) {
            cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1));
        }
        prev = cur;
    }
    return prev[y.length] / Math.max(x.length, y.length);
}

// Up to this share of the wording differing counts as the two readers seeing
// the same word — a slipped letter, a doubled one. On a nine-letter word with
// a subtitle, one letter is about 3%; VANILLA against VASTUKOSH is over 50%.
const NEAR_AGREEMENT = 0.15;

// Reads the wording with both models at once. `text` is set only when the two
// agree — that is the string safe to pin into the redraw. When they do not,
// nothing is pinned and both readings are handed back so the caller can say
// what each eye saw.
async function readLogoTextTwice(buffer, mimetype, timeoutMs) {
    const secondModel = process.env.OPENAI_SECOND_OPINION_MODEL || SECOND_OPINION_MODEL;
    const settled = await Promise.allSettled([
        readLogoText(buffer, mimetype, timeoutMs),
        readLogoText(buffer, mimetype, timeoutMs, secondModel),
    ]);
    const first = settled[0].status === 'fulfilled' ? settled[0].value : null;
    const second = settled[1].status === 'fulfilled' ? settled[1].value : null;
    settled.forEach((r, i) => {
        if (r.status === 'rejected') console.warn(`Wording read ${i + 1} failed:`, r.reason && r.reason.message);
    });
    // One eye is no better than before; only two eyes that agree count.
    const agree = first !== null && second !== null && sameWording(first, second);
    const distance = (first !== null && second !== null) ? wordingDistance(first, second) : 1;
    return {
        text: agree ? first : '',
        agree,
        // Not agreed, but close: both saw the same word and one slipped a
        // letter. Nothing is pinned — we do not know which one slipped — but
        // this is not the evidence of a made-up word either.
        near: !agree && distance <= NEAR_AGREEMENT,
        distance,
        reads: [first, second],
        secondModel,
    };
}

// Compares original against redraw in ONE call. Two independent transcriptions
// would each carry their own reading errors and disagree on correct output;
// asking for a direct comparison sidesteps that. Verified on a wordmark where
// dropping a single letter was correctly flagged.
async function verifyRedraw(originalBuf, originalMime, redrawBuf, timeoutMs, model) {
    const { data } = await chatJson([{
        role: 'user',
        content: [
            { type: 'text', text:
                'IMAGE 1 is an original logo. IMAGE 2 is a redraw of it. Compare them strictly. '
                + 'Reply as JSON: {"text1":"<exact text in image 1>","text2":"<exact text in image 2>",'
                + '"text_matches":true|false,"shapes_match":true|false,"confident":true|false}. '
                + 'text_matches must be false if the wording differs by even one character, '
                + 'including a single missing or added letter. '
                + 'shapes_match must be false if any non-text symbol, icon or mark differs in form. '
                + 'confident must be false if you cannot read the script in either image reliably enough '
                + 'to be sure of every character — never guess.' },
            imagePart(originalBuf, originalMime),
            imagePart(redrawBuf, 'image/png'),
        ],
    }], timeoutMs, model);
    // The model sometimes answers text_matches:false while quoting two identical
    // strings — a real conversion was rejected for "producing MAN instead of
    // MAN". Its own transcriptions are the evidence and its boolean is only a
    // judgement about them, so when the two readings agree, that settles it.
    // Compared case- and whitespace-insensitively because the verifier is
    // inconsistent about both; letters are compared exactly, so a dropped
    // character is still caught.
    const normalise = (t) => String(t || '').replace(/\s+/g, ' ').trim().toLowerCase();
    const t1 = normalise(data.text1);
    const t2 = normalise(data.text2);
    const transcriptsAgree = t1.length > 0 && t1 === t2;

    // A dropped accent is a different kind of miss from a dropped letter. The
    // model rendered MUSKĀN as MUSKAN — the word is intact, the macron is not.
    // Worth separating, because falling all the way back to tracing over one
    // diacritic loses the redraw entirely.
    const stripMarks = (t) => t.normalize('NFD').replace(/\p{M}/gu, '');
    const bare1 = stripMarks(t1);
    const differsOnlyByDiacritics = !transcriptsAgree && bare1.length > 0 && bare1 === stripMarks(t2);

    return {
        text1: data.text1 || '',
        text2: data.text2 || '',
        // Unreadable script is treated as a failed check, not a pass. The Gujarati
        // case passed precisely because an unsure verifier defaulted to yes.
        textMatches: transcriptsAgree || (data.text_matches !== false && data.confident !== false),
        transcriptsAgree,
        differsOnlyByDiacritics,
        shapesMatch: data.shapes_match !== false,
        confident: data.confident !== false,
    };
}

// Reads the caption printed under a die-line: style, box type and size.
//
// Every template carries its own description ("TOP-BOTTOM / RING BOX / BOX SIZE -
// 2X2X1.5"), so asking a vision model to read it beats making someone retype it
// for each of dozens of templates. The caller can still override anything it
// returns — this fills the form in, it does not own the values.
async function readBoxTemplateInfo(buffer, mimetype, timeoutMs) {
    const { data } = await chatJson([{
        role: 'user',
        content: [
            { type: 'text', text:
                'This is a packaging die-line with a caption underneath. Read the caption and reply as JSON: '
                + '{"style":"<construction style, e.g. TOP-BOTTOM or 100 CUT>",'
                + '"type":"<box type, e.g. RING BOX, EARRING BOX, HARAM BOX; empty string if the caption names none>",'
                + '"size":"<the value after BOX SIZE, e.g. 2X2X1.5>"}. '
                + 'Copy the wording exactly as printed. Use an empty string for anything not shown.' },
            imagePart(buffer, mimetype),
        ],
    }], timeoutMs);
    return {
        style: String(data.style || '').trim(),
        type: String(data.type || '').trim(),
        size: String(data.size || '').trim(),
    };
}

// Splits "2X2X1.5" into inches. Returns null when the caption has no usable size,
// so the caller can fall back rather than invent a scale.
function parseBoxSize(sizeLabel) {
    const parts = String(sizeLabel || '')
        .split(/[^0-9.]+/)
        .filter(Boolean)
        .map(parseFloat)
        .filter((n) => Number.isFinite(n) && n > 0);
    if (parts.length < 2) return null;
    return { length: parts[0], width: parts[1], height: parts[2] || 0 };
}

// Returns a PNG buffer of the redrawn artwork, plus what it cost.
async function enhanceImage(buffer, mimetype, { width, height }, timeoutMs, exactText) {
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
    // Pinning the exact string is the single biggest reliability win: left to
    // copy what it sees, the model drops letters — one real logo came back as
    // "dbiaa" instead of "dibiaa".
    const prompt = exactText
        ? PROMPT + ` The text must read EXACTLY "${exactText}" — every character, same spelling, same letter count. Do not drop, add or alter a single letter.`
        // No string to pin, so the instruction has to close the door the pinned
        // one closes by naming the word: copy the lettering that is there, and
        // never swap in a different word that merely looks similar.
        : PROMPT + ' Copy the lettering exactly as it appears in the image, letter by letter. Never replace it with a different or similar-looking word.';
    form.append('prompt', prompt);
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

module.exports = {
    enhanceImage,
    readLogoText,
    readLogoTextTwice,
    verifyRedraw,
    SECOND_OPINION_MODEL,
    readBoxTemplateInfo,
    parseBoxSize,
    hasNonLatinScript,
    isConfigured,
    DEFAULT_MODEL,
    DEFAULT_QUALITY,
};
