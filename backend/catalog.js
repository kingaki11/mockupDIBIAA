// Storage for everything the admin side saves: the catalog (box templates, their
// labels and colours, printing colours, legacy combos) and the images that go
// with it (die-line templates, their printed colour artworks, combo photos).
//
// Two interchangeable backends behind one asynchronous API:
//
//   files  — the default. catalog.json plus image files under DATA_DIR, laid out
//            exactly as before, so a Railway deploy with its volume keeps working
//            unchanged.
//   mysql  — chosen when DB_HOST is set (e.g. a Hostinger MySQL database). The
//            catalog is one JSON row and every image is a row of its own, so the
//            data survives redeploys of a host whose disk is replaced each time.
//
// Images are addressed by a relative key such as "templates/<id>.png" or
// "templates/<id>/<colour>.png"; the file backend maps it onto DATA_DIR and the
// database backend uses it as a primary key, so both store the same shape.

const fs = require('fs');
const path = require('path');

const EMPTY_CATALOG = {
    types: {},
    styles: {},
    colors: {},
    printingColors: {},
    combos: [], // { type, style, color, dimensions }
    // Per-combo logo placement, keyed "type|style|color":
    // { mockup: {x, y}, die: {x, y} } as fractions (0-1) of each canvas.
    logoPositions: {},
    // Mockup tab die-line artwork:
    // { id, styleLabel, typeLabel, sizeLabel, length, width, height, ext, colors? }
    boxTemplates: [],
};

function withDefaults(parsed) {
    return { ...EMPTY_CATALOG, ...(parsed || {}) };
}

// ── Keys ─────────────────────────────────────────────────────────────────────

const templateKey = (id, ext) => `templates/${id}.${ext || 'png'}`;
const templateColorKey = (id, slug, ext) => `templates/${id}/${slug}.${ext || 'png'}`;
const templateColorPrefix = (id) => `templates/${id}/`;
const comboKey = (type, style, color, kind) => `images/${type}/${style}/${color}/${kind}.png`;
const comboPrefix = (type, style, color) => `images/${type}/${style}/${color}/`;

// Keys are built from slugs, but a URL parameter reaches comboKey unfiltered, so
// anything that could climb out of the store is refused outright.
function assertSafeKey(key) {
    if (typeof key !== 'string' || !key || key.length > 250
        || key.includes('..') || key.startsWith('/') || key.includes('\\')
        || !/^[\x21-\x7e]+$/.test(key)) {
        const err = new Error('Invalid storage key.');
        err.code = 'EBADKEY';
        throw err;
    }
}

// ── File backend ─────────────────────────────────────────────────────────────

function fileStore() {
    // DATA_DIR is the generic setting; the Railway volume is kept as before.
    const DATA_DIR = process.env.DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, 'data');
    const CATALOG_FILE = path.join(DATA_DIR, 'catalog.json');
    const resolve = (key) => {
        assertSafeKey(key);
        const p = path.resolve(DATA_DIR, key);
        if (!p.startsWith(path.resolve(DATA_DIR) + path.sep)) {
            const err = new Error('Invalid storage key.');
            err.code = 'EBADKEY';
            throw err;
        }
        return p;
    };
    return {
        kind: 'files',
        describe: () => 'files in ' + DATA_DIR,
        async init() { fs.mkdirSync(DATA_DIR, { recursive: true }); },
        async readCatalog() {
            if (!fs.existsSync(CATALOG_FILE)) return withDefaults();
            try {
                return withDefaults(JSON.parse(fs.readFileSync(CATALOG_FILE, 'utf8')));
            } catch (err) {
                console.error('Failed to read catalog.json, starting fresh:', err);
                return withDefaults();
            }
        },
        async writeCatalog(catalog) {
            fs.mkdirSync(DATA_DIR, { recursive: true });
            fs.writeFileSync(CATALOG_FILE, JSON.stringify(catalog, null, 2));
        },
        async putFile(key, buffer) {
            const p = resolve(key);
            fs.mkdirSync(path.dirname(p), { recursive: true });
            fs.writeFileSync(p, buffer);
        },
        async getFile(key) {
            const p = resolve(key);
            return fs.existsSync(p) && fs.statSync(p).isFile() ? fs.readFileSync(p) : null;
        },
        async deleteFile(key) {
            const p = resolve(key);
            if (fs.existsSync(p)) fs.unlinkSync(p);
        },
        async deletePrefix(prefix) {
            const p = resolve(prefix.replace(/\/+$/, ''));
            fs.rmSync(p, { recursive: true, force: true });
        },
    };
}

// ── MySQL backend ────────────────────────────────────────────────────────────

function mysqlStore() {
    const mysql = require('mysql2/promise');
    const config = {
        host: process.env.DB_HOST,
        port: parseInt(process.env.DB_PORT || '3306', 10),
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME,
        connectionLimit: parseInt(process.env.DB_POOL_SIZE || '5', 10),
        // A template image is up to a few megabytes; keep the connection lean otherwise.
        charset: 'utf8mb4',
        supportBigNumbers: true,
    };
    let pool = null;
    const db = () => {
        if (!pool) pool = mysql.createPool(config);
        return pool;
    };
    return {
        kind: 'mysql',
        describe: () => `MySQL database "${config.database}" on ${config.host}:${config.port}`,
        async init() {
            const missing = ['DB_HOST', 'DB_USER', 'DB_NAME'].filter((k) => !process.env[k]);
            if (missing.length) throw new Error('Missing ' + missing.join(', ') + ' for the MySQL store.');
            // The key is ASCII so a 250-character primary key fits any InnoDB index limit.
            await db().query(`CREATE TABLE IF NOT EXISTS app_kv (
                k VARCHAR(100) CHARACTER SET ascii NOT NULL PRIMARY KEY,
                v LONGTEXT NOT NULL,
                updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
            await db().query(`CREATE TABLE IF NOT EXISTS app_files (
                k VARCHAR(250) CHARACTER SET ascii NOT NULL PRIMARY KEY,
                data LONGBLOB NOT NULL,
                size INT UNSIGNED NOT NULL,
                updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
            ) ENGINE=InnoDB`);
        },
        async readCatalog() {
            const [rows] = await db().query('SELECT v FROM app_kv WHERE k = ?', ['catalog']);
            if (!rows.length) return withDefaults();
            try {
                return withDefaults(JSON.parse(rows[0].v));
            } catch (err) {
                console.error('Stored catalog is not valid JSON, starting fresh:', err);
                return withDefaults();
            }
        },
        async writeCatalog(catalog) {
            await db().query(
                'INSERT INTO app_kv (k, v) VALUES (?, ?) ON DUPLICATE KEY UPDATE v = VALUES(v)',
                ['catalog', JSON.stringify(catalog)],
            );
        },
        async putFile(key, buffer) {
            assertSafeKey(key);
            await db().query(
                'INSERT INTO app_files (k, data, size) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE data = VALUES(data), size = VALUES(size)',
                [key, buffer, buffer.length],
            );
        },
        async getFile(key) {
            assertSafeKey(key);
            const [rows] = await db().query('SELECT data FROM app_files WHERE k = ?', [key]);
            return rows.length ? rows[0].data : null;
        },
        async deleteFile(key) {
            assertSafeKey(key);
            await db().query('DELETE FROM app_files WHERE k = ?', [key]);
        },
        async deletePrefix(prefix) {
            assertSafeKey(prefix);
            const like = prefix.replace(/[\\%_]/g, (c) => '\\' + c) + '%';
            await db().query('DELETE FROM app_files WHERE k LIKE ?', [like]);
        },
    };
}

const store = process.env.DB_HOST ? mysqlStore() : fileStore();

const MIME_BY_EXT = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', svg: 'image/svg+xml' };
const mimeFor = (key) => MIME_BY_EXT[String(key).split('.').pop().toLowerCase()] || 'application/octet-stream';

module.exports = {
    kind: store.kind,
    describe: store.describe,
    init: store.init,
    readCatalog: store.readCatalog,
    writeCatalog: store.writeCatalog,
    putFile: store.putFile,
    getFile: store.getFile,
    deleteFile: store.deleteFile,
    deletePrefix: store.deletePrefix,
    templateKey,
    templateColorKey,
    templateColorPrefix,
    comboKey,
    comboPrefix,
    mimeFor,
};
