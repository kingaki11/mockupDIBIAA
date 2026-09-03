// Map of valid combinations where images exist in BOTH boximg/ and plainimages/
const availableCombinations = {
    ringbox: {
        magnetic: ["black", "brown", "golden", "green", "maroon"],
    },
    banglebox: {
        magnetic: ["black", "brown", "golden", "green", "maroon"],
    },
    earringbox: {
        magnetic: ["black", "brown", "golden", "green", "maroon"],
    },
    pendantbox: {
        magnetic: ["brown", "golden", "green", "maroon"],
        "top-bottom": ["black", "brown", "golden", "green", "maroon", "mauve", "pink"],
    },
};

const boxTypeLabels = {
    ringbox: "Ring Box",
    banglebox: "Bangle Box",
    earringbox: "Earring Box",
    pendantbox: "Pendant Box",
};

const boxStyleLabels = {
    "top-bottom": "Top-Bottom",
    magnetic: "Magnetic",
    slidingbox: "Sliding Box",
};

const boxDimensions = {
    ringbox:    { magnetic:       '2 × 2 × 1.5 in' },
    banglebox:  { magnetic:       '4 × 4 × 1.5 in' },
    earringbox: { magnetic:       '2.5 × 3.25 × 1.5 in' },
    pendantbox: { magnetic:       '5 × 6 × 1.5 in',
                  'top-bottom':   '5 × 6 × 1.5 in' },
};

const boxColorLabels = {
    black: "Black",
    blue: "Blue",
    boccumblue: "Boccum Blue",
    brown: "Brown",
    golden: "Golden",
    green: "Green",
    grey: "Grey",
    lightpink: "Light Pink",
    maroon: "Maroon",
    mauve: "Mauve",
    mintgreen: "Mint Green",
    orange: "Orange",
    pink: "Pink",
    red: "Red",
    white: "White",
};

// Backend API (Railway) — dashboard-added box combos/printing colors and
// server-side logo background removal. The site works fully without it;
// everything here is additive to the static catalog above.
const BACKEND_URL = 'https://mockupdibiaa-backend-production.up.railway.app';

// Box type/style/color combos created via the dashboard, keyed "type|style|color".
// Populated by mergeBackendCatalog(); checked by the Generate handler to know
// whether to load images from the backend instead of the local boximg/plainimages folders.
const backendCombos = new Set();

// Saved logo placement per combo, keyed "type|style|color" -> { mockup: {x,y}, die: {x,y} }
// (x/y are fractions of that canvas's width/height). Populated by mergeBackendCatalog().
// Falls back to dead-center (0.5, 0.5) for any combo without a saved position — i.e.
// existing behavior is unchanged until someone explicitly saves a position for it.
const logoPositions = {};

function getLogoPosition(comboKey, kind) {
    const saved = (logoPositions[comboKey] || {})[kind];
    return saved || { x: 0.5, y: 0.5 };
}

// Recolor map used by addLogoToCanvas, keyed by lowercase printing-color name.
// Dashboard-added printing colors are merged into this at runtime.
const colorMap = {
    'golden': [215, 181, 109],
    'black': [28, 27, 23],
    'red': [255, 0, 0],
    'brown': [165, 42, 42],
    'green': [62, 112, 110],
    'grey': [128, 128, 128],
    'magenta': [255, 0, 255],
    'maroon': [128, 37, 74],
    'orange': [128, 165, 0],
    'pink': [255, 192, 203],
    'purple': [128, 0, 128],
    'silver': [197, 198, 198],
    'white': [254, 254, 254],
    'blue': [62, 89, 156],
    'yellow': [255, 255, 0],
};

function hexToRgb(hex) {
    const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
    return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : [0, 0, 0];
}

// Holds the background-removed logo PNG data URL after upload
let processedLogoUrl = null;
// Holds fabric canvas references after generation, for download
let generatedCanvas1 = null;
let generatedCanvas2 = null;
let generatedCanvas2Dims = { width: 300, height: 300 };

// Trims a canvas's transparent margins down to its actual visible pixels and
// returns a PNG data URL. Without this, a logo that wasn't perfectly centered
// in its own source file (or that came back from removal with extra padding)
// would still be off-center once placed on the box — placement always centers
// on the *image bounds*, so those bounds need to hug the artwork exactly.
function trimCanvasToVisibleBounds(canvas) {
    const w = canvas.width, h = canvas.height;
    const ctx = canvas.getContext('2d');
    const { data } = ctx.getImageData(0, 0, w, h);

    // Anything fainter than this is matte fringe, not artwork. Trimming on
    // alpha > 0 let a barely-visible halo dictate the bounds, which pushed the
    // real logo off-centre once it was placed on the box.
    const ALPHA_FLOOR = 12;

    let minX = w, minY = h, maxX = -1, maxY = -1;
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            if (data[(y * w + x) * 4 + 3] > ALPHA_FLOOR) {
                if (x < minX) minX = x;
                if (x > maxX) maxX = x;
                if (y < minY) minY = y;
                if (y > maxY) maxY = y;
            }
        }
    }
    if (maxX < minX || maxY < minY) {
        // Nothing visible survived (e.g. an all-background image) — fall back
        // to the untrimmed canvas rather than producing an empty image.
        return canvas.toDataURL('image/png');
    }

    const trimmedW = maxX - minX + 1;
    const trimmedH = maxY - minY + 1;
    const trimmedCanvas = document.createElement('canvas');
    trimmedCanvas.width = trimmedW;
    trimmedCanvas.height = trimmedH;
    trimmedCanvas.getContext('2d').drawImage(canvas, minX, minY, trimmedW, trimmedH, 0, 0, trimmedW, trimmedH);
    return trimmedCanvas.toDataURL('image/png');
}

// Primary background removal: sends the logo to the backend's ML-based cutout
// (@imgly/background-removal-node) — handles any background (not just white/
// near-white), unlike the flood-fill fallback below. Throws on any failure so
// the caller can fall back to the client-side method.
async function removeBackgroundViaBackend(file) {
    const formData = new FormData();
    formData.append('logo', file);
    const res = await fetch(BACKEND_URL + '/remove-bg', { method: 'POST', body: formData });
    if (!res.ok) throw new Error('Backend background removal failed (' + res.status + ')');
    const blob = await res.blob();
    const objectUrl = URL.createObjectURL(blob);

    return new Promise(function (resolve, reject) {
        const img = new Image();
        img.onload = function () {
            const canvas = document.createElement('canvas');
            canvas.width = img.naturalWidth;
            canvas.height = img.naturalHeight;
            canvas.getContext('2d').drawImage(img, 0, 0);
            URL.revokeObjectURL(objectUrl);
            resolve(trimCanvasToVisibleBounds(canvas));
        };
        img.onerror = function () {
            URL.revokeObjectURL(objectUrl);
            reject(new Error('Failed to load the background-removed image.'));
        };
        img.src = objectUrl;
    });
}

// Fallback background removal, used only if the backend is unreachable. BFS
// flood-fill inward from the image edges, clearing pixels connected to the
// border that match the border's OWN colour. Keying it to the sampled colour
// rather than to white is what lets it cope with dark or coloured backgrounds
// too — the white-only version silently left those fully opaque, and the
// recolour pass then filled the whole rectangle with the printing colour.
function removeBackground(img) {
    const tempCanvas = document.createElement('canvas');
    const w = img.naturalWidth || img.width;
    const h = img.naturalHeight || img.height;
    tempCanvas.width = w;
    tempCanvas.height = h;
    const ctx = tempCanvas.getContext('2d');
    ctx.drawImage(img, 0, 0);

    const imageData = ctx.getImageData(0, 0, w, h);
    const data = imageData.data;
    const visited = new Uint8Array(w * h);
    const queue = [];
    let head = 0;

    // Median of the border pixels: robust to a logo that touches one edge, and
    // to JPEG noise, in a way a single corner sample is not.
    const rs = [], gs = [], bs = [];
    function sampleBorder(x, y) {
        const i = (y * w + x) * 4;
        rs.push(data[i]); gs.push(data[i + 1]); bs.push(data[i + 2]);
    }
    for (let x = 0; x < w; x++) { sampleBorder(x, 0); sampleBorder(x, h - 1); }
    for (let y = 0; y < h; y++) { sampleBorder(0, y); sampleBorder(w - 1, y); }
    function median(arr) { arr.sort(function (a, b) { return a - b; }); return arr[arr.length >> 1]; }
    const bgR = median(rs), bgG = median(gs), bgB = median(bs);

    const TOLERANCE_SQ = 70 * 70;

    function isBackground(pi) {
        if (data[pi + 3] < 128) return true;
        const dr = data[pi] - bgR, dg = data[pi + 1] - bgG, db = data[pi + 2] - bgB;
        return dr * dr + dg * dg + db * db <= TOLERANCE_SQ;
    }

    function enqueue(pos) {
        if (!visited[pos]) {
            visited[pos] = 1;
            queue.push(pos);
        }
    }

    // Seed BFS from all border pixels
    for (let x = 0; x < w; x++) {
        enqueue(x);
        enqueue((h - 1) * w + x);
    }
    for (let y = 1; y < h - 1; y++) {
        enqueue(y * w);
        enqueue(y * w + w - 1);
    }

    while (head < queue.length) {
        const pos = queue[head++];
        if (!isBackground(pos * 4)) continue;
        data[pos * 4 + 3] = 0;
        const x = pos % w;
        const y = Math.floor(pos / w);
        if (x > 0) enqueue(pos - 1);
        if (x < w - 1) enqueue(pos + 1);
        if (y > 0) enqueue(pos - w);
        if (y < h - 1) enqueue(pos + w);
    }

    ctx.putImageData(imageData, 0, 0);
    return trimCanvasToVisibleBounds(tempCanvas);
}

// Populate Box Type dropdown on page load
const boxTypeSelect = document.getElementById('boxType');
const boxStyleSelect = document.getElementById('boxStyle');
const boxColorSelect = document.getElementById('boxColor');

Object.keys(availableCombinations).forEach(function (type) {
    const option = document.createElement('option');
    option.value = type;
    option.textContent = boxTypeLabels[type] || type;
    boxTypeSelect.appendChild(option);
});

// When Box Type changes, populate Box Style
boxTypeSelect.addEventListener('change', function () {
    boxStyleSelect.innerHTML = '<option value="">--Select--</option>';
    boxColorSelect.innerHTML = '<option value="">--Select Box Style First--</option>';
    boxColorSelect.disabled = true;

    const selectedType = this.value;
    if (!selectedType || !availableCombinations[selectedType]) {
        boxStyleSelect.disabled = true;
        return;
    }

    boxStyleSelect.disabled = false;
    Object.keys(availableCombinations[selectedType]).forEach(function (style) {
        const option = document.createElement('option');
        option.value = style;
        option.textContent = boxStyleLabels[style] || style;
        boxStyleSelect.appendChild(option);
    });
});

// When Box Style changes, populate Box Color
boxStyleSelect.addEventListener('change', function () {
    boxColorSelect.innerHTML = '<option value="">--Select--</option>';

    const selectedType = boxTypeSelect.value;
    const selectedStyle = this.value;
    if (!selectedType || !selectedStyle || !availableCombinations[selectedType] || !availableCombinations[selectedType][selectedStyle]) {
        boxColorSelect.disabled = true;
        return;
    }

    boxColorSelect.disabled = false;
    availableCombinations[selectedType][selectedStyle].forEach(function (color) {
        const option = document.createElement('option');
        option.value = color;
        option.textContent = boxColorLabels[color] || color;
        boxColorSelect.appendChild(option);
    });
});

// Pulls in dashboard-added box combos + printing colors from the backend and merges
// them into the same lookup objects the static catalog above uses, so the existing
// dropdown/generate/download logic picks them up with no other changes. Fails silently
// (site stays fully static-catalog-functional) if the backend is unreachable.
function mergeBackendCatalog(catalog) {
    (catalog.combos || []).forEach(function (combo) {
        const { type, style, color, dimensions } = combo;
        if (!type || !style || !color) return;

        if (!availableCombinations[type]) {
            availableCombinations[type] = {};
            const option = document.createElement('option');
            option.value = type;
            option.textContent = (catalog.types[type] || {}).label || type;
            boxTypeSelect.appendChild(option);
        }
        if (!availableCombinations[type][style]) availableCombinations[type][style] = [];
        if (!availableCombinations[type][style].includes(color)) {
            availableCombinations[type][style].push(color);
        }

        if (catalog.types[type]) boxTypeLabels[type] = catalog.types[type].label;
        if (catalog.styles[style]) boxStyleLabels[style] = catalog.styles[style].label;
        if (catalog.colors[color]) boxColorLabels[color] = catalog.colors[color].label;
        if (dimensions) {
            boxDimensions[type] = boxDimensions[type] || {};
            boxDimensions[type][style] = dimensions;
        }

        backendCombos.add(type + '|' + style + '|' + color);
    });

    const printingColorSelect = document.getElementById('printingColor');
    Object.keys(catalog.printingColors || {}).forEach(function (key) {
        const { label, hex } = catalog.printingColors[key];
        colorMap[label.toLowerCase()] = hexToRgb(hex);
        const alreadyThere = Array.from(printingColorSelect.options).some(function (o) {
            return o.value.toLowerCase() === label.toLowerCase();
        });
        if (!alreadyThere) {
            const option = document.createElement('option');
            option.value = label;
            option.textContent = label;
            printingColorSelect.appendChild(option);
        }
    });

    // Logo positions apply to ANY combo key (static or dashboard-added) — merge
    // them all in directly, not just for combos found in catalog.combos above.
    Object.keys(catalog.logoPositions || {}).forEach(function (key) {
        logoPositions[key] = catalog.logoPositions[key];
    });
}

fetch(BACKEND_URL + '/catalog')
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (catalog) { if (catalog) mergeBackendCatalog(catalog); })
    .catch(function (err) { console.warn('Backend catalog unavailable, using static catalog only.', err); });

// When a logo file is chosen: validate PNG, remove background, show preview
document.getElementById('logo').addEventListener('change', async function () {
    const file = this.files[0];
    const processingHint = document.getElementById('bgProcessingHint');
    const previewWrap = document.getElementById('logoPreviewWrap');
    const preview = document.getElementById('logoPreview');

    if (!file) {
        processedLogoUrl = null;
        processingHint.style.display = 'none';
        previewWrap.style.display = 'none';
        return;
    }

    if (!/^image\/(png|jpeg|webp)$/.test(file.type)) {
        Swal.fire({ icon: 'error', title: 'Wrong file type', text: 'Please upload a PNG, JPG or WEBP image.' });
        this.value = '';
        processedLogoUrl = null;
        previewWrap.style.display = 'none';
        return;
    }

    processingHint.style.display = 'block';
    previewWrap.style.display = 'none';

    // Prefer the backend's ML-based cutout (handles any background color/
    // pattern); fall back to the client-side white-background flood-fill only
    // if the backend can't be reached, so the feature still works offline.
    try {
        processedLogoUrl = await removeBackgroundViaBackend(file);
    } catch (err) {
        console.warn('Backend background removal unavailable, falling back to client-side removal.', err);
        processedLogoUrl = await new Promise(function (resolve) {
            const reader = new FileReader();
            reader.onload = function (e) {
                const img = new Image();
                img.onload = function () { resolve(removeBackground(img)); };
                img.src = e.target.result;
            };
            reader.readAsDataURL(file);
        });
    }

    processingHint.style.display = 'none';
    preview.src = processedLogoUrl;
    previewWrap.style.display = 'flex';
});

document.getElementById('generateBtn').addEventListener('click', function () {
    const boxType = boxTypeSelect.value;
    const boxStyle = boxStyleSelect.value;
    const boxColor = boxColorSelect.value;
    const printingColor = document.getElementById('printingColor').value;

    if (!boxType) { alert("Please select a box type."); return; }
    if (!boxStyle) { alert("Please select a box style."); return; }
    if (!boxColor) { alert("Please select a box color."); return; }
    if (!processedLogoUrl) { alert("Please upload a logo."); return; }
    if (!printingColor) { alert("Please select a printing color."); return; }

    // Mirror the original working structure: canvas creation and image loading
    // happen inside the logo image's onload, exactly as it worked before.
    const logoImg = new Image();
    logoImg.onload = function () {

        function loadImage(path, fallbackPath, callback) {
            const img = new Image();
            img.onload = function () { callback(img); };
            img.onerror = function () {
                img.onload = function () { callback(img); };
                img.onerror = function () { showErrorModal(); };
                img.src = fallbackPath;
            };
            img.src = path;
        }

        const comboKey = boxType + '|' + boxStyle + '|' + boxColor;

        // Dashboard-created combos live on the backend instead of the local
        // boximg/plainimages folders — route to whichever source has them.
        const isBackendCombo = backendCombos.has(comboKey);
        const png1 = isBackendCombo ? `${BACKEND_URL}/images/${boxType}/${boxStyle}/${boxColor}/mockup` : `boximg/${boxType}/${boxStyle}/${boxColor}.png`;
        const jpg1 = isBackendCombo ? png1 : `boximg/${boxType}/${boxStyle}/${boxColor}.jpg`;
        const png2 = isBackendCombo ? `${BACKEND_URL}/images/${boxType}/${boxStyle}/${boxColor}/die` : `plainimages/${boxType}/${boxStyle}/${boxColor}.png`;
        const jpg2 = isBackendCombo ? png2 : `plainimages/${boxType}/${boxStyle}/${boxColor}.jpg`;

        const canvas1 = new fabric.Canvas('previewCanvas1', { width: 300, height: 300, backgroundColor: '#fff' });
        canvas1._comboKey = comboKey; // read by admin.js's "Save Logo Position"
        generatedCanvas1 = canvas1;

        loadImage(png1, jpg1, function (boxImg1) {
            // physInchPerPx: how many physical inches one canvas pixel represents,
            // based on the source image dimensions at an assumed 300 DPI print resolution.
            canvas1._physInchPerPx = boxImg1.naturalWidth / (300 * 300);

            fabric.Image.fromURL(boxImg1.src, function (boxImg1Fabric) {
                boxImg1Fabric.scaleToWidth(300);
                boxImg1Fabric.scaleToHeight(300);
                boxImg1Fabric.selectable = false;
                canvas1.add(boxImg1Fabric);
                canvas1.renderAll();

                loadImage(png2, jpg2, function (boxImg2) {
                    const canvas2Width  = 300;
                    const canvas2Height = Math.round(canvas2Width / (boxImg2.naturalWidth / boxImg2.naturalHeight));

                    const canvas2 = new fabric.Canvas('previewCanvas2', {
                        width: canvas2Width, height: canvas2Height, backgroundColor: '#fff'
                    });
                    canvas2._comboKey = comboKey;
                    generatedCanvas2 = canvas2;
                    generatedCanvas2Dims = { width: canvas2Width, height: canvas2Height };
                    // Die image is larger (1840×3350 etc.) — gives accurate physical die dimensions.
                    canvas2._physInchPerPx = boxImg2.naturalWidth / (300 * canvas2Width);

                    fabric.Image.fromURL(boxImg2.src, function (boxImg2Fabric) {
                        const scale = Math.min(canvas2Width / boxImg2.naturalWidth, canvas2Height / boxImg2.naturalHeight);
                        boxImg2Fabric.scale(scale);
                        boxImg2Fabric.selectable = false;
                        canvas2.add(boxImg2Fabric);
                        canvas2.renderAll();

                        addLogoToCanvas(logoImg, canvas1, printingColor, 300, 300, getLogoPosition(comboKey, 'mockup'));
                        addLogoToCanvas(logoImg, canvas2, printingColor, canvas2Width, canvas2Height, getLogoPosition(comboKey, 'die'));
                        document.getElementById('downloadArea').style.display = 'flex';
                    }, { crossOrigin: 'anonymous' });
                });
            }, { crossOrigin: 'anonymous' });
        });
    };
    logoImg.src = processedLogoUrl;
});

document.getElementById('resetBtn').addEventListener('click', resetForm);

function getFileBaseName() {
    const t = boxTypeSelect.value;
    const s = boxStyleSelect.value;
    const c = boxColorSelect.value;
    return (t + '_' + s + '_' + c).toLowerCase().replace(/\s+/g, '_');
}

// PNG download: exports both canvases at 3× resolution
document.getElementById('downloadPNG').addEventListener('click', function () {
    if (!generatedCanvas1 || !generatedCanvas2) return;
    const base = getFileBaseName();
    downloadImage(generatedCanvas1, base + '_mockup.png');
    downloadImage(generatedCanvas2, base + '_die.png');
    successmsg();
    setTimeout(resetForm, 2000);
});

// SVG download: exports both canvases as SVG (opens in CorelDRAW / Illustrator)
document.getElementById('downloadSVG').addEventListener('click', function () {
    if (!generatedCanvas1 || !generatedCanvas2) return;
    const base = getFileBaseName();
    downloadSVG(generatedCanvas1, base + '_mockup.svg');
    downloadSVG(generatedCanvas2, base + '_die.svg');
    successmsg();
    setTimeout(resetForm, 2000);
});

function resetForm() {
    location.reload();
}

function showErrorModal() {
    Swal.fire({
        icon: "error",
        title: "Oops...",
        text: "Image Not Found! Try other",
    });
    setTimeout(resetForm, 2000);
}

// Temporarily adds a size annotation near each selectable object (logo, text, shapes).
// Returns the list of added labels so they can be removed after capture.
function addTempSizeLabels(canvas) {
    var labels = [];

    // Box info banner at the top of the canvas
    var dimStr = (boxDimensions[boxTypeSelect.value] || {})[boxStyleSelect.value];
    if (dimStr) {
        var typeName  = boxTypeLabels[boxTypeSelect.value]  || boxTypeSelect.value;
        var styleName = boxStyleLabels[boxStyleSelect.value] || boxStyleSelect.value;
        var colorName = boxColorLabels[boxColorSelect.value] || boxColorSelect.value;
        var boxInfoText = typeName + '  •  ' + styleName + '  •  ' + colorName + '   |   Box Size: ' + dimStr;
        var boxLbl = new fabric.Text(boxInfoText, {
            left: canvas.width / 2,
            top: 3,
            originX: 'center',
            fontSize: 8,
            fill: '#ffffff',
            fontFamily: 'Arial',
            backgroundColor: 'rgba(0,0,0,0.72)',
            padding: 3,
            selectable: false,
            evented: false,
        });
        canvas.add(boxLbl);
        labels.push(boxLbl);
    }
    canvas.getObjects().filter(function (o) { return o.selectable; }).forEach(function (obj) {
        var ppm = canvas._physInchPerPx || (1 / 90);
        var inW = (obj.width  * obj.scaleX * ppm).toFixed(2);
        var inH = (obj.height * obj.scaleY * ppm).toFixed(2);
        var cmW = (inW * 2.54).toFixed(1);
        var cmH = (inH * 2.54).toFixed(1);
        var b   = obj.getBoundingRect(true);
        var top = b.top >= 15 ? b.top - 15 : b.top + 2;
        var lbl = new fabric.Text(cmW + '\xd7' + cmH + ' cm  (' + inW + '\xd7' + inH + ' in)', {
            left: Math.max(2, b.left),
            top: top,
            fontSize: 9,
            fill: '#ffffff',
            fontFamily: 'Arial',
            backgroundColor: 'rgba(0,0,0,0.68)',
            padding: 2,
            selectable: false,
            evented: false,
        });
        canvas.add(lbl);
        labels.push(lbl);
    });
    canvas.renderAll();
    return labels;
}

function removeTempSizeLabels(canvas, labels) {
    labels.forEach(function (l) { canvas.remove(l); });
    canvas.renderAll();
}

function downloadImage(canvas, filename) {
    var labels = addTempSizeLabels(canvas);
    const dataURL = canvas.toDataURL({ format: 'png', multiplier: 3 });
    removeTempSizeLabels(canvas, labels);
    const link = document.createElement('a');
    link.href = dataURL;
    link.download = filename;
    link.click();
}

function downloadSVG(canvas, filename) {
    var labels = addTempSizeLabels(canvas);
    const svgData = canvas.toSVG();
    removeTempSizeLabels(canvas, labels);
    const blob = new Blob([svgData], { type: 'image/svg+xml' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(url);
}

function successmsg() {
    Swal.fire({
        position: "top-end",
        icon: "success",
        title: "Your Images have been Downloaded!",
        showConfirmButton: false,
        timer: 1500
    });
}

// Shared size label strip at the bottom of the canvas.
// Created once per canvas; reused (brought to front) for every subsequent object.
// Updates live on scale/modify, and also when the selection changes.
function addSizeLabel(fabricObj, canvas, canvasWidth, canvasHeight) {
    const stripHeight = 20;

    if (!canvas._sizeStrip) {
        const strip = new fabric.Rect({
            left: 0, top: canvasHeight - stripHeight,
            width: canvasWidth, height: stripHeight,
            fill: 'rgba(255,255,255,0.88)', selectable: false, evented: false,
        });
        const label = new fabric.Text('', {
            left: canvasWidth / 2, top: canvasHeight - stripHeight / 2,
            originX: 'center', originY: 'center',
            fontSize: 8, fill: '#222', fontFamily: 'Arial',
            selectable: false, evented: false,
        });
        canvas.add(strip);
        canvas.add(label);
        canvas._sizeStrip = strip;
        canvas._sizeLabel = label;

        canvas.on('object:scaling', function (e) {
            if (e.target && e.target.selectable) updateCanvasLabel(canvas, e.target);
        });
        canvas.on('object:modified', function (e) {
            if (e.target && e.target.selectable) updateCanvasLabel(canvas, e.target);
        });
        canvas.on('selection:created', function (e) {
            updateCanvasLabel(canvas, e.target || (e.selected && e.selected[0]));
        });
        canvas.on('selection:updated', function (e) {
            updateCanvasLabel(canvas, e.target || (e.selected && e.selected[0]));
        });
        canvas.on('selection:cleared', function () {
            if (canvas._sizeLabel) { canvas._sizeLabel.set('text', ''); canvas.requestRenderAll(); }
        });
    } else {
        canvas.bringToFront(canvas._sizeStrip);
        canvas.bringToFront(canvas._sizeLabel);
    }

    updateCanvasLabel(canvas, fabricObj);
}

function updateCanvasLabel(canvas, obj) {
    if (!canvas._sizeLabel || !obj) return;
    const ppm = canvas._physInchPerPx || (1 / 90);
    const inW = (obj.width  * obj.scaleX * ppm).toFixed(2);
    const inH = (obj.height * obj.scaleY * ppm).toFixed(2);
    const cmW = (inW * 2.54).toFixed(1);
    const cmH = (inH * 2.54).toFixed(1);
    canvas._sizeLabel.set('text', `Size: ${cmW} × ${cmH} cm  |  ${inW} × ${inH} in`);
    canvas.requestRenderAll();
}

document.getElementById('addTextBtn').addEventListener('click', function () {
    const text = document.getElementById('textInput').value.trim();
    if (!text) {
        alert('Please enter some text first.');
        return;
    }
    if (!generatedCanvas1 || !generatedCanvas2) {
        alert('Please click Generate first to create the canvas preview.');
        return;
    }

    const color    = document.getElementById('textColor').value;
    const fontSize = parseInt(document.getElementById('textSize').value, 10);

    function addText(canvas, cW, cH) {
        const t = new fabric.IText(text, {
            left: cW / 2,
            top: cH / 2,
            originX: 'center',
            originY: 'center',
            fontSize: fontSize,
            fill: color,
            fontFamily: 'Arial',
            selectable: true,
            hasControls: true,
            editable: true,
        });
        canvas.add(t);
        canvas.setActiveObject(t);
        addSizeLabel(t, canvas, cW, cH);
        canvas.renderAll();
    }

    addText(generatedCanvas1, 300, 300);
    addText(generatedCanvas2, generatedCanvas2Dims.width, generatedCanvas2Dims.height);

    document.getElementById('textInput').value = '';
});

document.getElementById('textInput').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') {
        e.preventDefault();
        document.getElementById('addTextBtn').click();
    }
});

// ── Shapes & Icons ──

var ICON_SVGS = {
    // Accurate single-path brand glyphs (Simple Icons, CC0) — recolorable via fill,
    // same mechanism as the shapes below.
    fb: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M9.101 23.691v-7.98H6.627v-3.667h2.474v-1.58c0-4.085 1.848-5.978 5.858-5.978.401 0 .955.042 1.468.103a8.68 8.68 0 0 1 1.141.195v3.325a8.623 8.623 0 0 0-.653-.036 26.805 26.805 0 0 0-.733-.009c-.707 0-1.259.096-1.675.309a1.686 1.686 0 0 0-.679.622c-.258.42-.374.995-.374 1.752v1.297h3.919l-.386 2.103-.287 1.564h-3.246v8.245C19.396 23.238 24 18.179 24 12.044c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.628 3.874 10.35 9.101 11.647Z"/></svg>',
    x:  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M18.901 1.153h3.68l-8.04 9.19L24 22.846h-7.406l-5.8-7.584-6.638 7.584H.474l8.6-9.83L0 1.154h7.594l5.243 6.932ZM17.61 20.644h2.039L6.486 3.24H4.298Z"/></svg>',
    ig: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M7.0301.084c-1.2768.0602-2.1487.264-2.911.5634-.7888.3075-1.4575.72-2.1228 1.3877-.6652.6677-1.075 1.3368-1.3802 2.127-.2954.7638-.4956 1.6365-.552 2.914-.0564 1.2775-.0689 1.6882-.0626 4.947.0062 3.2586.0206 3.6671.0825 4.9473.061 1.2765.264 2.1482.5635 2.9107.308.7889.72 1.4573 1.388 2.1228.6679.6655 1.3365 1.0743 2.1285 1.38.7632.295 1.6361.4961 2.9134.552 1.2773.056 1.6884.069 4.9462.0627 3.2578-.0062 3.668-.0207 4.9478-.0814 1.28-.0607 2.147-.2652 2.9098-.5633.7889-.3086 1.4578-.72 2.1228-1.3881.665-.6682 1.0745-1.3378 1.3795-2.1284.2957-.7632.4966-1.636.552-2.9124.056-1.2809.0692-1.6898.063-4.948-.0063-3.2583-.021-3.6668-.0817-4.9465-.0607-1.2797-.264-2.1487-.5633-2.9117-.3084-.7889-.72-1.4568-1.3876-2.1228C21.2982 1.33 20.628.9208 19.8378.6165 19.074.321 18.2017.1197 16.9244.0645 15.6471.0093 15.236-.005 11.977.0014 8.718.0076 8.31.0215 7.0301.0839m.1402 21.6932c-1.17-.0509-1.8053-.2453-2.2287-.408-.5606-.216-.96-.4771-1.3819-.895-.422-.4178-.6811-.8186-.9-1.378-.1644-.4234-.3624-1.058-.4171-2.228-.0595-1.2645-.072-1.6442-.079-4.848-.007-3.2037.0053-3.583.0607-4.848.05-1.169.2456-1.805.408-2.2282.216-.5613.4762-.96.895-1.3816.4188-.4217.8184-.6814 1.3783-.9003.423-.1651 1.0575-.3614 2.227-.4171 1.2655-.06 1.6447-.072 4.848-.079 3.2033-.007 3.5835.005 4.8495.0608 1.169.0508 1.8053.2445 2.228.408.5608.216.96.4754 1.3816.895.4217.4194.6816.8176.9005 1.3787.1653.4217.3617 1.056.4169 2.2263.0602 1.2655.0739 1.645.0796 4.848.0058 3.203-.0055 3.5834-.061 4.848-.051 1.17-.245 1.8055-.408 2.2294-.216.5604-.4763.96-.8954 1.3814-.419.4215-.8181.6811-1.3783.9-.4224.1649-1.0577.3617-2.2262.4174-1.2656.0595-1.6448.072-4.8493.079-3.2045.007-3.5825-.006-4.848-.0608M16.953 5.5864A1.44 1.44 0 1 0 18.39 4.144a1.44 1.44 0 0 0-1.437 1.4424M5.8385 12.012c.0067 3.4032 2.7706 6.1557 6.173 6.1493 3.4026-.0065 6.157-2.7701 6.1506-6.1733-.0065-3.4032-2.771-6.1565-6.174-6.1498-3.403.0067-6.156 2.771-6.1496 6.1738M8 12.0077a4 4 0 1 1 4.008 3.9921A3.9996 3.9996 0 0 1 8 12.0077"/></svg>',
    wa: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413Z"/></svg>',
    yt: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z"/></svg>',
    tt: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M12.525.02c1.31-.02 2.61-.01 3.91-.02.08 1.53.63 3.09 1.75 4.17 1.12 1.11 2.7 1.62 4.24 1.79v4.03c-1.44-.05-2.89-.35-4.2-.97-.57-.26-1.1-.59-1.62-.93-.01 2.92.01 5.84-.02 8.75-.08 1.4-.54 2.79-1.35 3.94-1.31 1.92-3.58 3.17-5.91 3.21-1.43.08-2.86-.31-4.08-1.03-2.02-1.19-3.44-3.37-3.65-5.71-.02-.5-.03-1-.01-1.49.18-1.9 1.12-3.72 2.58-4.96 1.66-1.44 3.98-2.13 6.15-1.72.02 1.48-.04 2.96-.04 4.44-.99-.32-2.15-.23-3.02.37-.63.41-1.11 1.04-1.36 1.75-.21.51-.15 1.07-.14 1.61.24 1.64 1.82 3.02 3.5 2.87 1.12-.01 2.19-.66 2.77-1.61.19-.33.4-.67.41-1.06.1-1.79.06-3.57.07-5.36.01-4.03-.01-8.05.02-12.07z"/></svg>',
    th: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M12.186 24h-.007c-3.581-.024-6.334-1.205-8.184-3.509C2.35 18.44 1.5 15.586 1.472 12.01v-.017c.03-3.579.879-6.43 2.525-8.482C5.845 1.205 8.6.024 12.18 0h.014c2.746.02 5.043.725 6.826 2.098 1.677 1.29 2.858 3.13 3.509 5.467l-2.04.569c-1.104-3.96-3.898-5.984-8.304-6.015-2.91.022-5.11.936-6.54 2.717C4.307 6.504 3.616 8.914 3.589 12c.027 3.086.718 5.496 2.057 7.164 1.43 1.783 3.631 2.698 6.54 2.717 2.623-.02 4.358-.631 5.8-2.045 1.647-1.613 1.618-3.593 1.09-4.798-.31-.71-.873-1.3-1.634-1.75-.192 1.352-.622 2.446-1.284 3.272-.886 1.102-2.14 1.704-3.73 1.79-1.202.065-2.361-.218-3.259-.801-1.063-.689-1.685-1.74-1.752-2.964-.065-1.19.408-2.285 1.33-3.082.88-.76 2.119-1.207 3.583-1.291a13.853 13.853 0 0 1 3.02.142c-.126-.742-.375-1.332-.75-1.757-.513-.586-1.308-.883-2.359-.89h-.029c-.844 0-1.992.232-2.721 1.32L7.734 7.847c.98-1.454 2.568-2.256 4.478-2.256h.044c3.194.02 5.097 1.975 5.287 5.388.108.046.216.094.321.142 1.49.7 2.58 1.761 3.154 3.07.797 1.82.871 4.79-1.548 7.158-1.85 1.81-4.094 2.628-7.277 2.65Zm1.003-11.69c-.242 0-.487.007-.739.021-1.836.103-2.98.946-2.916 2.143.067 1.256 1.452 1.839 2.784 1.767 1.224-.065 2.818-.543 3.086-3.71a10.5 10.5 0 0 0-2.215-.221z"/></svg>',
    fragile:   '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path d="M38,5 L62,5 L70,38 Q74,52 60,58 L60,80 L70,80 L70,95 L30,95 L30,80 L40,80 L40,58 Q26,52 30,38 Z"/></svg>',
    dry:       '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path d="M50,8 Q8,8 8,48 L46,48 L46,78 Q46,88 38,88 L38,97 L62,97 L62,88 Q54,88 54,78 L54,48 L92,48 Q92,8 50,8 Z M26,62 A5,8 0 1,1 26.01,62 Z M44,72 A5,8 0 1,1 44.01,72 Z M62,62 A5,8 0 1,1 62.01,62 Z"/></svg>',
    upright:   '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><polygon points="28,48 14,70 22,70 22,90 34,90 34,70 42,70"/><polygon points="72,48 58,70 66,70 66,90 78,90 78,70 86,70"/></svg>',
    recycle:   '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path d="M50,5 L60,28 L54,28 L66,50 L80,50 L73,36 L79,36 L62,5 Z M85,58 L72,58 L59,78 L68,78 L50,95 L32,78 L41,78 L28,58 L15,58 L20,50 L8,50 L8,65 L50,100 L92,65 L92,50 Z"/></svg>',
    flammable: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path d="M52,5 Q65,18 62,32 Q72,20 70,8 Q90,25 88,52 Q93,44 90,32 Q100,48 97,68 Q90,92 66,97 Q78,80 70,64 Q66,75 66,88 Q52,78 50,62 Q42,72 44,88 Q28,76 22,55 Q14,36 28,20 Q26,35 36,40 Q34,22 52,5 Z"/></svg>',
    handle:    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path d="M50,90 Q8,62 8,35 A22,22 0 0,1 50,22 A22,22 0 0,1 92,35 Q92,62 50,90 Z"/></svg>',
};

document.querySelectorAll('.shape-btn').forEach(function (btn) {
    btn.addEventListener('click', function () {
        if (!generatedCanvas1 || !generatedCanvas2) {
            alert('Please click Generate first to create the canvas preview.');
            return;
        }
        const shapeType = this.dataset.shape;
        const color = document.getElementById('shapeColor').value;
        const size  = parseInt(document.getElementById('shapeSize').value, 10);
        if (ICON_SVGS[shapeType]) {
            addIconToCanvas(shapeType, color, size, generatedCanvas1, 300, 300);
            addIconToCanvas(shapeType, color, size, generatedCanvas2, generatedCanvas2Dims.width, generatedCanvas2Dims.height);
        } else {
            addShapeToCanvas(shapeType, color, size, generatedCanvas1, 300, 300);
            addShapeToCanvas(shapeType, color, size, generatedCanvas2, generatedCanvas2Dims.width, generatedCanvas2Dims.height);
        }
    });
});

function addIconToCanvas(type, color, size, canvas, cW, cH) {
    fabric.loadSVGFromString(ICON_SVGS[type], function (objects, options) {
        objects.forEach(function (obj) { obj.set('fill', color); });
        var group = fabric.util.groupSVGElements(objects, options);
        var maxDim = Math.max(group.width || 1, group.height || 1);
        group.scale(size / maxDim);
        group.set({ left: cW / 2, top: cH / 2, originX: 'center', originY: 'center', selectable: true, hasControls: true });
        canvas.add(group);
        canvas.setActiveObject(group);
        addSizeLabel(group, canvas, cW, cH);
        canvas.renderAll();
    });
}

function starPoints(outerR, innerR, numPts) {
    const pts = [];
    for (let i = 0; i < numPts * 2; i++) {
        const angle = (i * Math.PI) / numPts - Math.PI / 2;
        const r = i % 2 === 0 ? outerR : innerR;
        pts.push({ x: r * Math.cos(angle), y: r * Math.sin(angle) });
    }
    return pts;
}

function addShapeToCanvas(type, color, size, canvas, cW, cH) {
    const cx = cW / 2, cy = cH / 2;
    let obj;

    switch (type) {
        case 'rect':
            obj = new fabric.Rect({ width: size * 1.6, height: size, fill: color });
            break;
        case 'roundrect':
            obj = new fabric.Rect({ width: size * 1.6, height: size, rx: size * 0.15, ry: size * 0.15, fill: color });
            break;
        case 'circle':
            obj = new fabric.Circle({ radius: size / 2, fill: color });
            break;
        case 'oval':
            obj = new fabric.Ellipse({ rx: size * 0.75, ry: size * 0.45, fill: color });
            break;
        case 'triangle':
            obj = new fabric.Triangle({ width: size, height: size, fill: color });
            break;
        case 'star':
            obj = new fabric.Polygon(starPoints(size / 2, size / 4, 5), { fill: color });
            break;
        default:
            return;
    }

    obj.set({ left: cx, top: cy, originX: 'center', originY: 'center', selectable: true, hasControls: true });
    canvas.add(obj);
    canvas.setActiveObject(obj);
    addSizeLabel(obj, canvas, cW, cH);
    canvas.renderAll();
}

function addLogoToCanvas(logoImg, canvas, printingColor, canvasWidth, canvasHeight, position) {
    const pos = position || { x: 0.5, y: 0.5 };

    if (printingColor.toLowerCase() === 'none') {
        fabric.Image.fromURL(logoImg.src, function (logoFabricImg) {
            logoFabricImg.scaleToWidth(50);
            logoFabricImg.set({
                left: canvasWidth * pos.x,
                top: canvasHeight * pos.y,
                originX: 'center',
                originY: 'center',
                selectable: true,
                hasControls: true,
                isLogo: true,
            });
            canvas.add(logoFabricImg);
            canvas.setActiveObject(logoFabricImg);
            addSizeLabel(logoFabricImg, canvas, canvasWidth, canvasHeight);
            canvas.renderAll();
        });
        return;
    }

    const tempCanvas = document.createElement('canvas');
    const tempCtx = tempCanvas.getContext('2d');
    tempCanvas.width = logoImg.width;
    tempCanvas.height = logoImg.height;
    tempCtx.drawImage(logoImg, 0, 0);

    const imageData = tempCtx.getImageData(0, 0, logoImg.width, logoImg.height);
    const data = imageData.data;

    const selectedColor = colorMap[printingColor.toLowerCase()] || [0, 0, 0];

    // Only recolour pixels that are actually artwork. Recolouring everything
    // with alpha > 0 painted the cutout's faint edge fringe in the printing
    // colour too, which read as a coloured haze around the logo — and if the
    // background hadn't been cleared at all, as a solid coloured rectangle.
    // Clearing the fringe outright is what makes the colour change look clean.
    const RECOLOR_ALPHA_FLOOR = 24;

    for (let i = 0; i < data.length; i += 4) {
        if (data[i + 3] <= RECOLOR_ALPHA_FLOOR) { data[i + 3] = 0; continue; }
        data[i] = selectedColor[0];
        data[i + 1] = selectedColor[1];
        data[i + 2] = selectedColor[2];
    }
    tempCtx.putImageData(imageData, 0, 0);
    const recoloredLogoURL = tempCanvas.toDataURL();

    fabric.Image.fromURL(recoloredLogoURL, function (logoFabricImg) {
        logoFabricImg.scaleToWidth(50);
        logoFabricImg.set({
            left: canvasWidth * pos.x,
            top: canvasHeight * pos.y,
            originX: 'center',
            originY: 'center',
            selectable: true,
            hasControls: true,
            isLogo: true,
        });
        canvas.add(logoFabricImg);
        canvas.setActiveObject(logoFabricImg);
        addSizeLabel(logoFabricImg, canvas, canvasWidth, canvasHeight);
        canvas.renderAll();
    });
}
