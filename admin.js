// Site-wide login gate + admin catalog management (Add Fields), both loaded
// after boxscript.js — reuses its BACKEND_URL/colorMap/hexToRgb/mergeBackendCatalog
// globals instead of duplicating them.
//
// The whole site (Create Mockup included) sits behind one login now: #loginScreen
// is shown until the stored password verifies against the backend, then #appContent
// (the entire customer form + canvases + Add Fields panel) is revealed as one unit.

const STATIC_SUGGESTIONS = {
    types: ['Ring Box', 'Bangle Box', 'Earring Box', 'Pendant Box'],
    styles: ['Top-Bottom', 'Magnetic', 'Sliding Box'],
    colors: ['Black', 'Blue', 'Brown', 'Golden', 'Green', 'Grey', 'Maroon', 'Mauve', 'Pink', 'White'],
};

function getStoredAdminPassword() {
    return sessionStorage.getItem('dashboardAdminPassword') || '';
}

function adminAuthHeaders(extra) {
    return Object.assign({ 'x-admin-password': getStoredAdminPassword() }, extra || {});
}

function showAdminMsg(el, text, isError) {
    el.textContent = text;
    el.className = 'admin-msg ' + (isError ? 'error' : 'success');
}

async function verifyAdminPassword(password) {
    const res = await fetch(BACKEND_URL + '/admin/verify', {
        headers: { 'x-admin-password': password },
    });
    return res.ok;
}

// ── Site-wide login gate ──

function showLoginScreen() {
    document.getElementById('loginScreen').style.display = 'flex';
    document.getElementById('appContent').style.display = 'none';
}

function showAppContent() {
    document.getElementById('loginScreen').style.display = 'none';
    document.getElementById('appContent').style.display = 'flex';
}

(function initSiteAuth() {
    const stored = getStoredAdminPassword();
    if (!stored) { showLoginScreen(); return; }
    verifyAdminPassword(stored).then(function (ok) {
        if (ok) showAppContent(); else { sessionStorage.removeItem('dashboardAdminPassword'); showLoginScreen(); }
    }).catch(function () { showLoginScreen(); });
})();

document.getElementById('siteLoginBtn').addEventListener('click', async function () {
    const password = document.getElementById('sitePassword').value;
    const msg = document.getElementById('siteLoginMsg');
    if (!password) { msg.textContent = 'Enter a password.'; msg.className = 'login-msg error'; return; }

    this.disabled = true;
    try {
        const ok = await verifyAdminPassword(password);
        if (ok) {
            sessionStorage.setItem('dashboardAdminPassword', password);
            document.getElementById('sitePassword').value = '';
            msg.className = 'login-msg';
            showAppContent();
        } else {
            msg.textContent = 'Wrong password.';
            msg.className = 'login-msg error';
        }
    } catch (err) {
        msg.textContent = 'Could not reach the backend. Is it online?';
        msg.className = 'login-msg error';
    } finally {
        this.disabled = false;
    }
});

document.getElementById('sitePassword').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); document.getElementById('siteLoginBtn').click(); }
});

document.getElementById('siteLogoutLink').addEventListener('click', function () {
    sessionStorage.removeItem('dashboardAdminPassword');
    showLoginScreen();
});

// ── Tabs: Create Mockup / Add Fields / Convert Logo ──
// All three sit in the same logged-in area — switching tabs is pure visibility
// toggling, no separate password step for any of them.

const TAB_IDS = ['mockup', 'fields', 'convert'];

function switchTab(tab) {
    TAB_IDS.forEach(function (id) {
        const panel = document.getElementById('tabPanel-' + id);
        const active = id === tab;
        panel.style.display = active ? 'block' : 'none';
        if (active) {
            // Force the fade-in to restart every time (classList.add is a
            // no-op if the class is already present from a previous switch).
            panel.classList.remove('admin-panel-open');
            void panel.offsetWidth; // reflow
            panel.classList.add('admin-panel-open');
        }
    });
    document.querySelectorAll('.app-tab').forEach(function (btn) {
        btn.classList.toggle('active', btn.dataset.tab === tab);
    });
    if (tab === 'fields') loadAdminCatalog();
}

document.querySelectorAll('.app-tab').forEach(function (btn) {
    btn.addEventListener('click', function () { switchTab(this.dataset.tab); });
});

function fillAdminDatalist(id, values) {
    const list = document.getElementById(id);
    list.innerHTML = '';
    values.forEach(function (v) {
        const opt = document.createElement('option');
        opt.value = v;
        list.appendChild(opt);
    });
}

async function loadAdminCatalog() {
    let catalog;
    try {
        const res = await fetch(BACKEND_URL + '/catalog');
        catalog = await res.json();
    } catch (err) {
        catalog = { types: {}, styles: {}, colors: {}, printingColors: {}, combos: [] };
    }

    const typeLabels = Object.values(catalog.types).map((t) => t.label);
    const styleLabels = Object.values(catalog.styles).map((s) => s.label);
    const colorLabels = Object.values(catalog.colors).map((c) => c.label);
    fillAdminDatalist('typeSuggestions', STATIC_SUGGESTIONS.types.concat(typeLabels));
    fillAdminDatalist('styleSuggestions', STATIC_SUGGESTIONS.styles.concat(styleLabels));
    fillAdminDatalist('colorSuggestions', STATIC_SUGGESTIONS.colors.concat(colorLabels));

    renderAdminPrintingColors(catalog.printingColors || {});
    renderAdminCombos(catalog);
}

function renderAdminPrintingColors(printingColors) {
    const list = document.getElementById('pcList');
    const emptyHint = document.getElementById('pcEmptyHint');
    list.innerHTML = '';
    const keys = Object.keys(printingColors);
    emptyHint.style.display = keys.length ? 'none' : 'block';

    keys.forEach(function (key) {
        const { label, hex } = printingColors[key];
        const item = document.createElement('div');
        item.className = 'admin-list-item';
        item.innerHTML =
            '<span class="admin-swatch" style="background:' + hex + '"></span>' +
            '<span class="admin-meta">' + label + ' <small>' + hex + '</small></span>' +
            '<button type="button" class="admin-btn-delete">Remove</button>';
        item.querySelector('.admin-btn-delete').addEventListener('click', function () { deleteAdminPrintingColor(key); });
        list.appendChild(item);
    });
}

async function deleteAdminPrintingColor(key) {
    if (!confirm('Remove this printing color?')) return;
    const res = await fetch(BACKEND_URL + '/admin/printing-color/' + encodeURIComponent(key), {
        method: 'DELETE',
        headers: adminAuthHeaders(),
    });
    const data = await res.json();
    renderAdminPrintingColors(data.printingColors || {});
    renderAdminCombos(data);
}

function renderAdminCombos(catalog) {
    const list = document.getElementById('comboList');
    const emptyHint = document.getElementById('comboEmptyHint');
    list.innerHTML = '';
    const combos = catalog.combos || [];
    emptyHint.style.display = combos.length ? 'none' : 'block';

    combos.forEach(function (combo) {
        const typeLabel = (catalog.types[combo.type] || {}).label || combo.type;
        const styleLabel = (catalog.styles[combo.style] || {}).label || combo.style;
        const colorLabel = (catalog.colors[combo.color] || {}).label || combo.color;
        const imgUrl = BACKEND_URL + '/images/' + combo.type + '/' + combo.style + '/' + combo.color + '/mockup';

        const item = document.createElement('div');
        item.className = 'admin-list-item';
        item.innerHTML =
            '<img src="' + imgUrl + '" alt="">' +
            '<span class="admin-meta">' + typeLabel + ' • ' + styleLabel + ' • ' + colorLabel +
            (combo.dimensions ? '<small>' + combo.dimensions + '</small>' : '') + '</span>' +
            '<button type="button" class="admin-btn-delete">Remove</button>';
        item.querySelector('.admin-btn-delete').addEventListener('click', function () {
            deleteAdminCombo(combo.type, combo.style, combo.color);
        });
        list.appendChild(item);
    });
}

async function deleteAdminCombo(type, style, color) {
    if (!confirm('Remove this box template and its images?')) return;
    const url = BACKEND_URL + '/admin/mockup/' + encodeURIComponent(type) + '/' + encodeURIComponent(style) + '/' + encodeURIComponent(color);
    const res = await fetch(url, { method: 'DELETE', headers: adminAuthHeaders() });
    const data = await res.json();
    renderAdminPrintingColors(data.printingColors || {});
    renderAdminCombos(data);
}

document.getElementById('pcSaveBtn').addEventListener('click', async function () {
    const label = document.getElementById('pcLabel').value.trim();
    const hex = document.getElementById('pcHex').value;
    const msg = document.getElementById('pcMsg');
    if (!label) { showAdminMsg(msg, 'Enter a color name.', true); return; }

    this.disabled = true;
    try {
        const res = await fetch(BACKEND_URL + '/admin/printing-color', {
            method: 'POST',
            headers: adminAuthHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({ label, hex }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Failed to save.');

        showAdminMsg(msg, 'Printing color "' + label + '" added.', false);
        document.getElementById('pcLabel').value = '';
        renderAdminPrintingColors(data.printingColors || {});
        renderAdminCombos(data);
        mergeBackendCatalog(data); // make it selectable immediately in the form above
    } catch (err) {
        showAdminMsg(msg, err.message, true);
    } finally {
        this.disabled = false;
    }
});

document.getElementById('mockupSaveBtn').addEventListener('click', async function () {
    const typeLabel = document.getElementById('boxTypeLabel').value.trim();
    const styleLabel = document.getElementById('boxStyleLabel').value.trim();
    const colorLabel = document.getElementById('boxColorLabel').value.trim();
    const dimensions = document.getElementById('boxDims').value.trim();
    const mockupFile = document.getElementById('mockupImage').files[0];
    const dieFile = document.getElementById('dieImage').files[0];
    const msg = document.getElementById('mockupMsg');

    if (!typeLabel || !styleLabel || !colorLabel) {
        showAdminMsg(msg, 'Box type, style and color are all required.', true);
        return;
    }
    if (!mockupFile || !dieFile) {
        showAdminMsg(msg, 'Please choose both the mockup image and the die image.', true);
        return;
    }
    if (mockupFile.type !== 'image/png' || dieFile.type !== 'image/png') {
        showAdminMsg(msg, 'Both images must be PNG files.', true);
        return;
    }

    const formData = new FormData();
    formData.append('typeLabel', typeLabel);
    formData.append('styleLabel', styleLabel);
    formData.append('colorLabel', colorLabel);
    formData.append('dimensions', dimensions);
    formData.append('mockupImage', mockupFile);
    formData.append('dieImage', dieFile);

    this.disabled = true;
    try {
        const res = await fetch(BACKEND_URL + '/admin/mockup', {
            method: 'POST',
            headers: adminAuthHeaders(), // no Content-Type — browser sets the multipart boundary
            body: formData,
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Failed to save.');

        showAdminMsg(msg, 'Box template saved for ' + typeLabel + ' / ' + styleLabel + ' / ' + colorLabel + '.', false);
        document.getElementById('boxTypeLabel').value = '';
        document.getElementById('boxStyleLabel').value = '';
        document.getElementById('boxColorLabel').value = '';
        document.getElementById('boxDims').value = '';
        document.getElementById('mockupImage').value = '';
        document.getElementById('dieImage').value = '';
        renderAdminPrintingColors(data.printingColors || {});
        renderAdminCombos(data);
        mergeBackendCatalog(data); // make it selectable immediately in the form above
    } catch (err) {
        showAdminMsg(msg, err.message, true);
    } finally {
        this.disabled = false;
    }
});

// ── Save Logo Position ──
// Reads wherever the logo was actually dragged to on the just-generated Box
// (canvas1) and Die (canvas2) previews and saves it as that combo's default,
// so future "Create Mockup" runs for the same box land in the right spot.

document.getElementById('saveLogoPosBtn').addEventListener('click', async function () {
    const msg = document.getElementById('saveLogoPosMsg');

    if (!generatedCanvas1 || !generatedCanvas2 || !generatedCanvas1._comboKey) {
        showAdminMsg(msg, 'Click Create Mockup first.', true);
        return;
    }

    const logo1 = generatedCanvas1.getObjects().find(function (o) { return o.isLogo; });
    const logo2 = generatedCanvas2.getObjects().find(function (o) { return o.isLogo; });
    if (!logo1 || !logo2) {
        showAdminMsg(msg, 'No logo found on the preview — upload a logo and Create Mockup first.', true);
        return;
    }

    const [type, style, color] = generatedCanvas1._comboKey.split('|');
    const mockup = { x: logo1.left / 300, y: logo1.top / 300 };
    const die = { x: logo2.left / generatedCanvas2Dims.width, y: logo2.top / generatedCanvas2Dims.height };

    this.disabled = true;
    try {
        const res = await fetch(BACKEND_URL + '/admin/logo-position', {
            method: 'POST',
            headers: adminAuthHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({ type, style, color, mockup, die }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Failed to save.');

        mergeBackendCatalog(data); // picked up by the next Create Mockup click
        showAdminMsg(msg, 'Saved — this box will use this logo spot from now on.', false);
    } catch (err) {
        showAdminMsg(msg, err.message, true);
    } finally {
        this.disabled = false;
    }
});

// ── Convert Logo (PNG/JPG → vector trace: SVG + EPS) ──

// Reads the shared logo upload for the Convert to Vector action.
function getSharedLogoFile(msg) {
    const file = document.getElementById('logoFile').files[0];
    if (!file) { showAdminMsg(msg, 'Upload a logo file above first.', true); return null; }
    if (!/^image\/(png|jpeg|webp)$/.test(file.type)) {
        showAdminMsg(msg, 'Only PNG, JPG or WEBP files are accepted.', true);
        return null;
    }
    return file;
}

let convertedSVG = null;
let convertedEPS = null;

document.getElementById('convertBtn').addEventListener('click', async function () {
    const msg = document.getElementById('convertMsg');
    const previewWrap = document.getElementById('convertPreviewWrap');
    const file = getSharedLogoFile(msg);
    if (!file) return;

    const formData = new FormData();
    formData.append('logo', file);

    this.disabled = true;
    previewWrap.style.display = 'none';
    showAdminMsg(msg, 'Tracing… this can take a few seconds.', false);
    try {
        const res = await fetch(BACKEND_URL + '/convert-logo', {
            method: 'POST',
            headers: adminAuthHeaders(),
            body: formData,
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Conversion failed.');

        convertedSVG = data.svg;
        convertedEPS = data.eps;
        document.getElementById('convertPreview').innerHTML = data.svg;
        previewWrap.style.display = 'block';
        showAdminMsg(msg, 'Traced successfully — download below, or open the SVG/EPS directly in CorelDRAW.', false);
    } catch (err) {
        showAdminMsg(msg, err.message, true);
    } finally {
        this.disabled = false;
    }
});

function downloadTextFile(text, filename, mime) {
    const blob = new Blob([text], { type: mime });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(url);
}

document.getElementById('downloadConvertedSVG').addEventListener('click', function () {
    if (!convertedSVG) return;
    downloadTextFile(convertedSVG, 'logo-traced.svg', 'image/svg+xml');
});

document.getElementById('downloadConvertedEPS').addEventListener('click', function () {
    if (!convertedEPS) return;
    downloadTextFile(convertedEPS, 'logo-traced.eps', 'application/postscript');
});
