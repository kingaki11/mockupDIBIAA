// Simple flat-file catalog store for admin-added box types/styles/colors/printing
// colors and their mockup+die images. Lives on the Railway volume so it survives
// deploys and restarts. This is intentionally additive to (never replacing) the
// static catalog already hardcoded in the frontend's boxscript.js.

const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, 'data');
const IMAGES_DIR = path.join(DATA_DIR, 'images');
// Die-line templates for the Mockup tab. Kept apart from IMAGES_DIR because
// those are per-combo photographs, while these are plain line art recoloured at
// render time and shared across every box colour.
const TEMPLATES_DIR = path.join(DATA_DIR, 'templates');
const CATALOG_FILE = path.join(DATA_DIR, 'catalog.json');

const EMPTY_CATALOG = {
    types: {},
    styles: {},
    colors: {},
    printingColors: {},
    combos: [], // { type, style, color, dimensions }
    // Per-combo logo placement, keyed "type|style|color". Needed because the
    // "mockup" image is often a lifestyle photo where the product occupies only
    // part of the frame — canvas-center isn't the same as "on the box lid".
    // { mockup: {x, y}, die: {x, y} } as fractions (0-1) of each canvas's width/height.
    logoPositions: {},
    // Mockup tab: uploaded die-line artwork.
    // { id, type, style, typeLabel, styleLabel, sizeLabel, length, width, height, ext }
    boxTemplates: [],
};

function ensureDataDir() {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.mkdirSync(IMAGES_DIR, { recursive: true });
    fs.mkdirSync(TEMPLATES_DIR, { recursive: true });
}

function readCatalog() {
    ensureDataDir();
    if (!fs.existsSync(CATALOG_FILE)) {
        return { ...EMPTY_CATALOG };
    }
    try {
        const raw = fs.readFileSync(CATALOG_FILE, 'utf8');
        const parsed = JSON.parse(raw);
        return { ...EMPTY_CATALOG, ...parsed };
    } catch (err) {
        console.error('Failed to read catalog.json, starting fresh:', err);
        return { ...EMPTY_CATALOG };
    }
}

function writeCatalog(catalog) {
    ensureDataDir();
    fs.writeFileSync(CATALOG_FILE, JSON.stringify(catalog, null, 2));
}

function comboDir(type, style, color) {
    return path.join(IMAGES_DIR, type, style, color);
}

function comboImagePath(type, style, color, kind) {
    return path.join(comboDir(type, style, color), `${kind}.png`);
}

function templateImagePath(id, ext) {
    return path.join(TEMPLATES_DIR, `${id}.${ext || 'png'}`);
}

module.exports = {
    DATA_DIR,
    IMAGES_DIR,
    TEMPLATES_DIR,
    templateImagePath,
    readCatalog,
    writeCatalog,
    comboDir,
    comboImagePath,
};
