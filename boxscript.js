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

    // Converts an already-loaded HTMLImageElement to a data URL so fabric.js
    // always treats it as same-origin (avoids tainted-canvas / CORS silent failures)
    function imgToDataURL(img) {
        const c = document.createElement('canvas');
        c.width  = img.naturalWidth  || img.width  || 1;
        c.height = img.naturalHeight || img.height || 1;
        c.getContext('2d').drawImage(img, 0, 0);
        return c.toDataURL();
    }

    // Loads an image with correct handler ordering and crossOrigin set
    function loadImage(path, fallbackPath, callback) {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload  = () => callback(img);
        img.onerror = () => {
            const fb = new Image();
            fb.crossOrigin = 'anonymous';
            fb.onload  = () => callback(fb);
            fb.onerror = () => showErrorModal();
            fb.src = fallbackPath;
        };
        img.src = path;
    }

    const boxImagePathPng1 = `boximg/${boxType}/${boxStyle}/${boxColor}.png`;
    const boxImagePathJpg1 = `boximg/${boxType}/${boxStyle}/${boxColor}.jpg`;
    const boxImagePathPng2 = `plainimages/${boxType}/${boxStyle}/${boxColor}.png`;
    const boxImagePathJpg2 = `plainimages/${boxType}/${boxStyle}/${boxColor}.jpg`;

    const canvas1 = new fabric.Canvas('previewCanvas1', { width: 300, height: 300, backgroundColor: '#fff' });
    generatedCanvas1 = canvas1;

    loadImage(boxImagePathPng1, boxImagePathJpg1, (boxImg1) => {
        // Convert to data URL so fabric never hits a cross-origin restriction
        fabric.Image.fromURL(imgToDataURL(boxImg1), function (boxImg1Fabric) {
            boxImg1Fabric.scaleToWidth(300);
            boxImg1Fabric.scaleToHeight(300);
            boxImg1Fabric.selectable = false;
            canvas1.add(boxImg1Fabric);
            canvas1.renderAll();

            loadImage(boxImagePathPng2, boxImagePathJpg2, (boxImg2) => {
                const canvas2Width  = 300;
                const canvas2Height = canvas2Width / (boxImg2.naturalWidth / boxImg2.naturalHeight);

                const canvas2 = new fabric.Canvas('previewCanvas2', {
                    width: canvas2Width, height: canvas2Height, backgroundColor: '#fff'
                });
                generatedCanvas2 = canvas2;
                generatedCanvas2Dims = { width: canvas2Width, height: canvas2Height };

                fabric.Image.fromURL(imgToDataURL(boxImg2), function (boxImg2Fabric) {
                    const scale = Math.min(canvas2Width / boxImg2.naturalWidth, canvas2Height / boxImg2.naturalHeight);
                    boxImg2Fabric.scale(scale);
                    boxImg2Fabric.selectable = false;
                    canvas2.add(boxImg2Fabric);
                    canvas2.renderAll();

                    const logoImg = new Image();
                    logoImg.onload = function () {
                        addLogoToCanvas(logoImg, canvas1, printingColor, 300, 300);
                        addLogoToCanvas(logoImg, canvas2, printingColor, canvas2Width, canvas2Height);
                        document.getElementById('downloadArea').style.display = 'flex';
                    };
                    logoImg.src = processedLogoUrl;
                });
            });
        });
    });
});

document.getElementById('resetBtn').addEventListener('click', resetForm);

// PNG download: exports both canvases at 3× resolution
document.getElementById('downloadPNG').addEventListener('click', function () {
    if (!generatedCanvas1 || !generatedCanvas2) return;
    downloadImage(generatedCanvas1, 'box_mockup.png');
    downloadImage(generatedCanvas2, 'die_template.png');
    successmsg();
    setTimeout(resetForm, 2000);
});

// SVG download: exports both canvases as SVG (opens in CorelDRAW / Illustrator)
document.getElementById('downloadSVG').addEventListener('click', function () {
    if (!generatedCanvas1 || !generatedCanvas2) return;
    downloadSVG(generatedCanvas1, 'box_mockup.svg');
    downloadSVG(generatedCanvas2, 'die_template.svg');
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

function downloadImage(canvas, filename) {
    const dataURL = canvas.toDataURL({ format: 'png', multiplier: 3 });
    const link = document.createElement('a');
    link.href = dataURL;
    link.download = filename;
    link.click();
}

function downloadSVG(canvas, filename) {
    const svgData = canvas.toSVG();
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

// Adds a size label strip at the bottom of the canvas.
// Updates live as the user resizes the logo using the drag handles.
function addSizeLabel(logoFabricImg, canvas, canvasWidth, canvasHeight) {
    const stripHeight = 20;

    const strip = new fabric.Rect({
        left: 0,
        top: canvasHeight - stripHeight,
        width: canvasWidth,
        height: stripHeight,
        fill: 'rgba(255,255,255,0.88)',
        selectable: false,
        evented: false,
    });

    const label = new fabric.Text('', {
        left: canvasWidth / 2,
        top: canvasHeight - stripHeight / 2,
        originX: 'center',
        originY: 'center',
        fontSize: 8,
        fill: '#222',
        fontFamily: 'Arial',
        selectable: false,
        evented: false,
    });

    canvas.add(strip);
    canvas.add(label);

    function updateLabel() {
        const pxW = Math.round(logoFabricImg.width * logoFabricImg.scaleX * 3);
        const pxH = Math.round(logoFabricImg.height * logoFabricImg.scaleY * 3);
        const mmW = Math.round((pxW / 300) * 25.4);
        const mmH = Math.round((pxH / 300) * 25.4);
        label.set('text', `Logo size:  ${pxW} × ${pxH} px  |  ~${mmW} × ${mmH} mm  (@ 300 DPI)`);
        canvas.requestRenderAll();
    }

    // Set initial label text
    updateLabel();

    // Update whenever the user scales or finishes modifying the logo
    canvas.on('object:scaling', function (e) {
        if (e.target === logoFabricImg) updateLabel();
    });
    canvas.on('object:modified', function (e) {
        if (e.target === logoFabricImg) updateLabel();
    });
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
