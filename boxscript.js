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

// Holds the background-removed logo PNG data URL after upload
let processedLogoUrl = null;
// Holds fabric canvas references after generation, for download
let generatedCanvas1 = null;
let generatedCanvas2 = null;
let generatedCanvas2Dims = { width: 300, height: 300 };

// Removes the white/light background from a logo image using BFS flood-fill from edges.
// Only removes pixels connected to the border that are near-white (tolerance 40/255 per channel).
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
    const TOLERANCE = 40;

    function isBackground(pi) {
        if (data[pi + 3] < 128) return true;
        return data[pi] > 255 - TOLERANCE && data[pi + 1] > 255 - TOLERANCE && data[pi + 2] > 255 - TOLERANCE;
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
    return tempCanvas.toDataURL('image/png');
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

// When a logo file is chosen: validate PNG, remove background, show preview
document.getElementById('logo').addEventListener('change', function () {
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

    if (file.type !== 'image/png') {
        Swal.fire({ icon: 'error', title: 'Wrong file type', text: 'Please upload a PNG file only.' });
        this.value = '';
        processedLogoUrl = null;
        previewWrap.style.display = 'none';
        return;
    }

    processingHint.style.display = 'block';
    previewWrap.style.display = 'none';

    const reader = new FileReader();
    reader.onload = function (e) {
        const img = new Image();
        img.onload = function () {
            processedLogoUrl = removeBackground(img);
            processingHint.style.display = 'none';
            preview.src = processedLogoUrl;
            previewWrap.style.display = 'flex';
        };
        img.src = e.target.result;
    };
    reader.readAsDataURL(file);
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

        const png1 = `boximg/${boxType}/${boxStyle}/${boxColor}.png`;
        const jpg1 = `boximg/${boxType}/${boxStyle}/${boxColor}.jpg`;
        const png2 = `plainimages/${boxType}/${boxStyle}/${boxColor}.png`;
        const jpg2 = `plainimages/${boxType}/${boxStyle}/${boxColor}.jpg`;

        const canvas1 = new fabric.Canvas('previewCanvas1', { width: 300, height: 300, backgroundColor: '#fff' });
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

                        addLogoToCanvas(logoImg, canvas1, printingColor, 300, 300);
                        addLogoToCanvas(logoImg, canvas2, printingColor, canvas2Width, canvas2Height);
                        document.getElementById('downloadArea').style.display = 'flex';
                    });
                });
            });
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
    fb: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path d="M30,5 L70,5 L70,20 L45,20 L45,45 L65,45 L65,60 L45,60 L45,95 L30,95 Z"/></svg>',
    x:  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><polygon points="8,10 42,52 8,90 24,90 50,64 76,90 92,90 58,48 92,10 76,10 50,36 24,10"/></svg>',
    ig: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path fill-rule="evenodd" d="M30,5 Q5,5 5,30 L5,70 Q5,95 30,95 L70,95 Q95,95 95,70 L95,30 Q95,5 70,5 Z M50,32 A18,18 0 1,0 50.01,32 Z"/><circle cx="75" cy="25" r="7"/></svg>',
    wa: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path d="M50,8 A42,42 0 0,0 8,50 A42,42 0 0,0 26,80 L16,92 L32,86 A42,42 0 0,0 50,92 A42,42 0 0,0 92,50 A42,42 0 0,0 50,8 Z"/></svg>',
    yt: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path fill-rule="evenodd" d="M12,20 Q5,20 5,28 L5,72 Q5,80 12,80 L88,80 Q95,80 95,72 L95,28 Q95,20 88,20 Z M40,36 L68,50 L40,64 Z"/></svg>',
    tt: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path d="M57,8 L57,64 A16,16 0 1,1 41,54 A16,16 0 0,1 57,64 L57,36 L80,24 L80,8 Z"/></svg>',
    th: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path d="M50,5 A45,45 0 0,0 5,50 A45,45 0 0,0 50,95 L50,82 A32,32 0 0,1 18,50 A32,32 0 0,1 50,18 A32,32 0 0,1 82,50 L82,55 Q82,65 72,65 Q64,65 64,57 L64,35 A14,14 0 1,0 58,57 Q62,67 72,67 Q90,67 90,55 L90,50 A45,45 0 0,0 50,5 Z"/></svg>',
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

function addLogoToCanvas(logoImg, canvas, printingColor, canvasWidth, canvasHeight) {
    if (printingColor.toLowerCase() === 'none') {
        fabric.Image.fromURL(logoImg.src, function (logoFabricImg) {
            logoFabricImg.scaleToWidth(50);
            logoFabricImg.set({
                left: canvasWidth / 2,
                top: canvasHeight / 2,
                originX: 'center',
                originY: 'center',
                selectable: true,
                hasControls: true,
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
    const selectedColor = colorMap[printingColor.toLowerCase()] || [0, 0, 0];

    for (let i = 0; i < data.length; i += 4) {
        if (data[i + 3] === 0) continue;
        data[i] = selectedColor[0];
        data[i + 1] = selectedColor[1];
        data[i + 2] = selectedColor[2];
    }
    tempCtx.putImageData(imageData, 0, 0);
    const recoloredLogoURL = tempCanvas.toDataURL();

    fabric.Image.fromURL(recoloredLogoURL, function (logoFabricImg) {
        logoFabricImg.scaleToWidth(50);
        logoFabricImg.set({
            left: canvasWidth / 2,
            top: canvasHeight / 2,
            originX: 'center',
            originY: 'center',
            selectable: true,
            hasControls: true,
        });
        canvas.add(logoFabricImg);
        canvas.setActiveObject(logoFabricImg);
        addSizeLabel(logoFabricImg, canvas, canvasWidth, canvasHeight);
        canvas.renderAll();
    });
}
