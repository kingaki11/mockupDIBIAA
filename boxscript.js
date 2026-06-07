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

// ─── 3D Viewer ───────────────────────────────────────────────────────────────

let _3dRenderer  = null;
let _3dFrameId   = null;
let _3dActive    = false;

document.getElementById('view3dBtn').addEventListener('click', function () {
    const wrap = document.getElementById('viewer3dWrap');

    if (_3dActive) {
        // Toggle off
        _3dActive = false;
        this.innerHTML = '&#9654; View in 3D';
        wrap.style.display = 'none';
        _disposeViewer();
        return;
    }

    if (!generatedCanvas1) return;

    _3dActive = true;
    this.innerHTML = '&#9646;&#9646; Close 3D View';

    // Capture the current box canvas as a texture
    const textureURL = generatedCanvas1.toDataURL({ format: 'png', multiplier: 1 });
    const boxColor   = document.getElementById('boxColor').value;

    if (typeof THREE !== 'undefined' && typeof THREE.OrbitControls !== 'undefined') {
        _initViewer(textureURL, boxColor);
    } else {
        _loadScript('https://cdn.jsdelivr.net/npm/three@0.134.0/build/three.min.js', function () {
            _loadScript('https://cdn.jsdelivr.net/npm/three@0.134.0/examples/js/controls/OrbitControls.js', function () {
                _initViewer(textureURL, boxColor);
            });
        });
    }
});

function _loadScript(src, cb) {
    const s = document.createElement('script');
    s.src = src;
    s.onload = cb;
    document.head.appendChild(s);
}

function _disposeViewer() {
    if (_3dFrameId) { cancelAnimationFrame(_3dFrameId); _3dFrameId = null; }
    if (_3dRenderer) { _3dRenderer.dispose(); _3dRenderer = null; }
    document.getElementById('viewer3d').innerHTML = '';
}

function _initViewer(textureURL, boxColor) {
    const wrap      = document.getElementById('viewer3dWrap');
    const container = document.getElementById('viewer3d');
    _disposeViewer();
    wrap.style.display = 'block';

    const W = container.clientWidth  || 640;
    const H = 400;

    // Scene
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x111827);

    // Subtle fog for depth
    scene.fog = new THREE.Fog(0x111827, 12, 25);

    // Camera
    const camera = new THREE.PerspectiveCamera(36, W / H, 0.1, 100);
    camera.position.set(0, 0.7, 6.2);

    // Renderer
    _3dRenderer = new THREE.WebGLRenderer({ antialias: true });
    _3dRenderer.setSize(W, H);
    _3dRenderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    _3dRenderer.shadowMap.enabled = true;
    container.appendChild(_3dRenderer.domElement);

    // Lights
    scene.add(new THREE.AmbientLight(0xffffff, 0.45));

    const key = new THREE.DirectionalLight(0xffffff, 0.9);
    key.position.set(4, 6, 5);
    key.castShadow = true;
    scene.add(key);

    const fill = new THREE.DirectionalLight(0xd0e8ff, 0.35);
    fill.position.set(-4, 0, -3);
    scene.add(fill);

    const rim = new THREE.DirectionalLight(0xfff0d0, 0.2);
    rim.position.set(0, -3, -6);
    scene.add(rim);

    // Box colour palette
    const palette = {
        black: 0x1c1b17, brown: 0x7b4a2d, golden: 0xc9a84c,
        green: 0x3a6b69, maroon: 0x7a2242, mauve: 0x7f5272,
        pink: 0xe8a8b5, blue: 0x3e5980, grey: 0x7a7a7a,
        lightpink: 0xffb0c0, mintgreen: 0x88c8be, white: 0xf0eeec,
        boccumblue: 0x2e4a8a, orange: 0xc85a0a, red: 0xbf2020,
    };

    const base    = palette[boxColor.toLowerCase()] || 0x5a5a5a;
    const lighter = _shift(base, 1.28);
    const darker  = _shift(base, 0.62);

    // Materials
    const mSide  = new THREE.MeshLambertMaterial({ color: base });
    const mTop   = new THREE.MeshLambertMaterial({ color: lighter });
    const mSeam  = new THREE.MeshLambertMaterial({ color: darker });
    const mFront = new THREE.MeshLambertMaterial({ color: base });

    // Load box mockup as front-face texture
    new THREE.TextureLoader().load(textureURL, function (tex) {
        tex.encoding = THREE.sRGBEncoding;
        mFront.map   = tex;
        mFront.color.set(0xffffff); // let texture render true-to-color
        mFront.needsUpdate = true;
    });

    // BoxGeometry face order: +X, -X, +Y(top), -Y(bottom), +Z(front), -Z(back)
    // Box body — front face gets the mockup texture
    const body = new THREE.Mesh(
        new THREE.BoxGeometry(2.4, 1.35, 1.85),
        [mSide, mSide, mTop, mSeam, mFront, mSide]
    );
    body.position.y = -0.08;
    body.castShadow  = true;
    body.receiveShadow = true;
    scene.add(body);

    // Lid (slightly wider/deeper, sits on top of body)
    const lid = new THREE.Mesh(
        new THREE.BoxGeometry(2.44, 0.16, 1.90),
        [mSide, mSide, mTop, mSeam, mSide, mSide]
    );
    lid.position.y = 0.755;
    lid.castShadow  = true;
    scene.add(lid);

    // Floor / shadow catcher
    const floor = new THREE.Mesh(
        new THREE.PlaneGeometry(30, 30),
        new THREE.MeshLambertMaterial({ color: 0x0d1117 })
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -0.84;
    floor.receiveShadow = true;
    scene.add(floor);

    // OrbitControls
    const controls = new THREE.OrbitControls(camera, _3dRenderer.domElement);
    controls.enableDamping   = true;
    controls.dampingFactor   = 0.07;
    controls.minDistance     = 3.5;
    controls.maxDistance     = 14;
    controls.autoRotate      = true;
    controls.autoRotateSpeed = 1.6;
    controls.target.set(0, 0.3, 0);
    controls.update();

    // Stop auto-rotation on any user interaction
    _3dRenderer.domElement.addEventListener('pointerdown', function () {
        controls.autoRotate = false;
    });

    // Handle window resize
    function onResize() {
        if (!_3dRenderer) return;
        const w = container.clientWidth;
        camera.aspect = w / H;
        camera.updateProjectionMatrix();
        _3dRenderer.setSize(w, H);
    }
    window.addEventListener('resize', onResize);

    // Render loop
    (function tick() {
        _3dFrameId = requestAnimationFrame(tick);
        controls.update();
        _3dRenderer.render(scene, camera);
    })();
}

// Brightens or darkens a packed hex colour by a factor
function _shift(hex, f) {
    const r = Math.min(255, Math.round(((hex >> 16) & 0xff) * f));
    const g = Math.min(255, Math.round(((hex >>  8) & 0xff) * f));
    const b = Math.min(255, Math.round(( hex        & 0xff) * f));
    return (r << 16) | (g << 8) | b;
}
