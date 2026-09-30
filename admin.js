// Site-wide login gate, tab switching, and the Convert Logo tab. Loaded after
// boxscript.js, whose BACKEND_URL it reuses instead of duplicating.
//
// The whole site sits behind one login: #loginScreen is shown until the stored
// password verifies against the backend, then #appContent is revealed as one unit.

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
    // Through switchTab, the way a click gets there, so the first tab opens with
    // its fade-in and its button marked active.
    switchTab(TAB_IDS[0]);
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

// ── Tabs: Convert Logo / Mockup ──
// Both sit in the same logged-in area — switching tabs is pure visibility
// toggling, no separate password step for either.

const TAB_IDS = ['convert', 'boxmockup'];

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
        const isActive = btn.dataset.tab === tab;
        btn.classList.toggle('active', isActive);
        // The bar scrolls sideways on a phone, so the tab you just chose can sit
        // off-screen — leaving no visible indication of where you are.
        if (isActive && btn.scrollIntoView) {
            btn.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        }
    });
    // Templates are fetched on open rather than at load, so one uploaded in
    // another session shows up without a page refresh.
    if (tab === 'boxmockup' && typeof bmLoadTemplates === 'function') bmLoadTemplates();
}

document.querySelectorAll('.app-tab').forEach(function (btn) {
    btn.addEventListener('click', function () { switchTab(this.dataset.tab); });
});

// ── Convert to Vector (JPG/PNG/WEBP → SVG) ──
//
// One upload, one button, no choices. Every conversion removes the background,
// redraws the artwork with OpenAI, then traces the result to full-colour vector
// paths. The tracing knobs VTracer exposes are left at their defaults rather
// than surfaced — they were controls nobody wanted to touch.
//
// If the AI step fails the backend still returns a vector traced from the
// original, and says so, so a lapsed key or an OpenAI outage degrades the
// output instead of breaking the tab.

let MAX_UPLOAD_MB = 15;                 // provisional; the backend's real limit is read below
const INLINE_SVG_LIMIT = 1024 * 1024;   // above this, preview via blob URL, not innerHTML

let convertedSVG = null;
let selectedLogoFile = null;   // kept so a failed convert can be retried without re-uploading
let originalObjectUrl = null;
let previewObjectUrl = null;

// ── Upload: drag-and-drop plus click-to-browse ──

const dropzone = document.getElementById('logoDropzone');
const logoInput = document.getElementById('logoFile');

function acceptLogoFile(file) {
    const msg = document.getElementById('logoFileMsg');
    if (!file) return;
    if (!/^image\/(png|jpeg|webp)$/.test(file.type)) {
        showAdminMsg(msg, 'Only PNG, JPG or WEBP files are accepted.', true);
        return;
    }
    if (file.size > MAX_UPLOAD_MB * 1024 * 1024) {
        showAdminMsg(msg, 'That file is ' + (file.size / 1048576).toFixed(1) + ' MB. The limit is ' + MAX_UPLOAD_MB + ' MB.', true);
        return;
    }

    selectedLogoFile = file;
    if (originalObjectUrl) URL.revokeObjectURL(originalObjectUrl);
    originalObjectUrl = URL.createObjectURL(file);

    dropzone.classList.add('has-file');
    dropzone.querySelector('.dropzone-text').innerHTML = '<strong>' + file.name + '</strong>';
    dropzone.querySelector('.dropzone-sub').textContent = (file.size / 1048576).toFixed(2) + ' MB — click to choose a different file';
    showAdminMsg(msg, 'Ready to convert.', false);
}

dropzone.addEventListener('click', function () { logoInput.click(); });
dropzone.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); logoInput.click(); }
});
logoInput.addEventListener('change', function () { acceptLogoFile(this.files[0]); });

['dragenter', 'dragover'].forEach(function (evt) {
    dropzone.addEventListener(evt, function (e) { e.preventDefault(); dropzone.classList.add('dragging'); });
});
['dragleave', 'drop'].forEach(function (evt) {
    dropzone.addEventListener(evt, function (e) { e.preventDefault(); dropzone.classList.remove('dragging'); });
});
dropzone.addEventListener('drop', function (e) {
    const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (file) acceptLogoFile(file);
});

// ── Convert ──

function renderVectorPreview(svg) {
    const target = document.getElementById('convertPreview');
    if (previewObjectUrl) { URL.revokeObjectURL(previewObjectUrl); previewObjectUrl = null; }

    // A detailed trace can run to several megabytes of path data. Parsing that
    // as live DOM locks the tab up, so hand anything large to the renderer as an
    // image instead — it looks identical and stays responsive.
    if (svg.length > INLINE_SVG_LIMIT) {
        previewObjectUrl = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
        target.innerHTML = '';
        const img = document.createElement('img');
        img.src = previewObjectUrl;
        img.alt = 'Vector result';
        target.appendChild(img);
    } else {
        target.innerHTML = svg;
    }
}

document.getElementById('convertBtn').addEventListener('click', async function () {
    const msg = document.getElementById('convertMsg');
    const previewWrap = document.getElementById('convertPreviewWrap');
    if (!selectedLogoFile) { showAdminMsg(msg, 'Upload an image above first.', true); return; }

    const formData = new FormData();
    formData.append('image', selectedLogoFile);
    formData.append('removeBackground', 'true');
    formData.append('enhance', 'true');

    this.disabled = true;
    const originalLabel = this.textContent;
    this.textContent = 'Converting…';
    showAdminMsg(msg, 'Removing the background, redrawing with AI, then tracing… about 20 seconds.', false);

    try {
        const res = await fetch(BACKEND_URL + '/api/convert/svg', {
            method: 'POST',
            headers: adminAuthHeaders(),
            body: formData,
        });
        const data = await res.json().catch(function () { return {}; });
        if (!res.ok) throw new Error(data.error || 'Conversion failed (' + res.status + ').');

        convertedSVG = data.svg;

        const originalTarget = document.getElementById('convertOriginal');
        originalTarget.innerHTML = '';
        const originalImg = document.createElement('img');
        originalImg.src = originalObjectUrl;
        originalImg.alt = 'Original upload';
        originalTarget.appendChild(originalImg);

        // Show what the AI actually produced, so the difference from the
        // original is visible before anyone downloads the trace of it.
        const enhancedFigure = document.getElementById('enhancedFigure');
        const enhancedTarget = document.getElementById('convertEnhanced');
        enhancedTarget.innerHTML = '';
        if (data.enhancedPng) {
            const enhancedImg = document.createElement('img');
            enhancedImg.src = data.enhancedPng;
            enhancedImg.alt = 'AI redrawn version';
            enhancedTarget.appendChild(enhancedImg);
            enhancedFigure.style.display = '';
        } else {
            enhancedFigure.style.display = 'none';
        }

        renderVectorPreview(data.svg);

        const meta = data.meta || {};
        const ai = meta.aiEnhance;
        let summary = (data.svg.length / 1024).toFixed(0) + ' KB SVG';
        if (meta.size) summary = meta.size.width + '×' + meta.size.height + ' · traced in ' + meta.ms + ' ms · ' + summary;
        if (ai && ai.estimatedCostUsd != null) {
            summary += ' · AI ' + ai.quality + ' (~$' + ai.estimatedCostUsd.toFixed(3) + ')';
        }
        if (ai && ai.verified === true) {
            summary += ' · wording checked' + (ai.expectedText ? ' “' + ai.expectedText + '”' : '');
            if (ai.attempts > 1) summary += ' after ' + ai.attempts + ' tries';
        } else if (ai && ai.verified === null) {
            summary += ' · wording not checked';
        }
        document.getElementById('convertMeta').textContent = summary;

        previewWrap.style.display = 'block';

        if (meta.aiEnhanceError) {
            // Degraded, not failed: they still have a usable vector, but it was
            // traced from the original, so say so rather than let them wonder.
            showAdminMsg(msg, 'Traced — but ' + meta.aiEnhanceError + '.', true);
        } else if (ai && ai.shapesMatch === false) {
            // Flattening a 3D or multi-tone mark to one colour legitimately
            // changes its shape, so this is a prompt to look rather than a fault.
            showAdminMsg(msg, 'Done, and the wording was checked against your original. '
                + 'The logo mark came out differently though — compare the panes above before you download.', true);
        } else if (ai && ai.unverifiable) {
            // The redraw itself is reliable on these scripts; it is the automatic
            // reader that is not. Say which, so "not checked" is not mistaken for
            // "probably wrong".
            showAdminMsg(msg, 'Done — the wording could not be machine-checked for this script, '
                + 'so please compare the panes above before you download.', true);
        } else if (ai && ai.verified === null) {
            showAdminMsg(msg, 'Done — but the wording could not be auto-checked this time, so compare the panes above before you download.', true);
        } else {
            showAdminMsg(msg, 'Done — wording checked against your original. Download below, or import the SVG into CorelDRAW.', false);
        }
    } catch (err) {
        // The upload is deliberately kept, so the user can just press Convert again.
        showAdminMsg(msg, err.message + ' Your image is still loaded — press Convert to try again.', true);
    } finally {
        this.disabled = false;
        this.textContent = originalLabel;
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
    const base = selectedLogoFile ? selectedLogoFile.name.replace(/\.[^.]+$/, '') + '-traced' : 'logo-traced';
    downloadTextFile(convertedSVG, base + '.svg', 'image/svg+xml');
});

// Take the upload ceiling from the server rather than trusting a copy of the
// number here, so raising MAX_UPLOAD_MB in Railway doesn't leave the client
// rejecting files the backend would have accepted.
fetch(BACKEND_URL + '/api/convert/health')
    .then(function (res) { return res.ok ? res.json() : null; })
    .then(function (health) {
        if (!health || !health.limits || !health.limits.maxUploadMb) return;
        MAX_UPLOAD_MB = health.limits.maxUploadMb;
        const label = document.getElementById('maxUploadLabel');
        if (label) label.textContent = MAX_UPLOAD_MB;
    })
    .catch(function () { /* keep the default; the convert call will surface any real problem */ });
