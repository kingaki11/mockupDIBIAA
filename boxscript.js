document.getElementById('generateBtn').addEventListener('click', function () {


    const boxType = document.getElementById('boxType').value;
    const boxStyle = document.getElementById('boxStyle').value;
    const boxColor = document.getElementById('boxColor').value;
    const printingColor = document.getElementById('printingColor').value;
    const logoInput = document.getElementById('logo').files[0];

    if (!logoInput) {
        alert("Please upload a logo.");
        return;
    }

    if (!printingColor) {
        alert("Please select a printing color.");
        return;
    }
    const imageContainer = document.getElementById('imgcontains');
    const downloadbutton = document.getElementById('downloadArea');

    // Adjust styles based on viewport width
    if (window.matchMedia("(max-width: 430px)").matches) {
        imageContainer.style.transform = 'translateX(0px)';
        imageContainer.style.width = '100%';
        imageContainer.style.margin = '0 auto';
        downloadbutton.style.transform = 'translateX(90px) translateY(20px)';
    } else {
        imageContainer.style.transform = 'translateX(50px)';
        downloadbutton.style.transform = 'translateX(-610px) translateY(-200px)';
    }

    const reader = new FileReader();
    reader.onload = function (event) {
        const logoImg = new Image();
        logoImg.src = event.target.result;
        logoImg.onload = function () {
            const canvas1 = new fabric.Canvas('previewCanvas1', { width: 300, height: 300, backgroundColor: '#fff' });

            const loadImage = (path, fallbackPath, callback) => {
                const img = new Image();
                img.src = path;

                img.onerror = () => {
                    img.src = fallbackPath;
                    img.onerror = () => {
                        showErrorModal();
                    };
                };

                img.onload = () => {
                    callback(img);
                };
            };

            const boxImagePathPng1 = `boximg/${boxType}/${boxStyle}/${boxColor}.png`;
            const boxImagePathJpg1 = `boximg/${boxType}/${boxStyle}/${boxColor}.jpg`;
            const boxImagePathPng2 = `plainimages/${boxType}/${boxStyle}/${boxColor}.png`;
            const boxImagePathJpg2 = `plainimages/${boxType}/${boxStyle}/${boxColor}.jpg`;

            loadImage(boxImagePathPng1, boxImagePathJpg1, (boxImg1) => {
                fabric.Image.fromURL(boxImg1.src, function (boxImg1Fabric) {
                    boxImg1Fabric.scaleToWidth(300);
                    boxImg1Fabric.scaleToHeight(300);
                    boxImg1Fabric.selectable = false;
                    canvas1.add(boxImg1Fabric);

                    loadImage(boxImagePathPng2, boxImagePathJpg2, (boxImg2) => {
                        const canvas2Width = 300;
                        const aspectRatio = boxImg2.width / boxImg2.height;
                        const canvas2Height = canvas2Width / aspectRatio;

                        const canvas2 = new fabric.Canvas('previewCanvas2', {
                            width: canvas2Width,
                            height: canvas2Height,
                            backgroundColor: '#fff'
                        });

                        fabric.Image.fromURL(boxImg2.src, function (boxImg2Fabric) {
                            const scaleFactor = Math.min(
                                canvas2Width / boxImg2.width,
                                canvas2Height / boxImg2.height
                            );
                            boxImg2Fabric.scale(scaleFactor);
                            boxImg2Fabric.selectable = false;
                            canvas2.add(boxImg2Fabric);

                            addLogoToCanvas(logoImg, canvas1, printingColor, 300, 300);
                            addLogoToCanvas(logoImg, canvas2, printingColor, canvas2Width, canvas2Height);

                            document.getElementById('downloadArea').style.display = 'block';

                            document.getElementById('downloadBoth').addEventListener('click', function () {
                                downloadImage(canvas1, 1000, 1000, 'image_option_1.png', 3);
                                downloadImage(canvas2, canvas2Width * 3, canvas2Height * 3, 'image_option_2.png', 3);
                            });
                        });
                    });
                });
            });
        };
    };
    reader.readAsDataURL(logoInput);
});

document.getElementById('resetBtn').addEventListener('click', resetForm);

function resetForm() {
 
    location.reload();
}

function showErrorModal(message) {
    Swal.fire({
        icon: "error",
        title: "Oops...",
        text: "Image Not Found! Try other",
    });
    setTimeout(function(){
        resetForm();
    },2000); 
   
}

function downloadImage(canvas, exportWidth, exportHeight, filename, multiplier = 1) {
    const dataURL = canvas.toDataURL({
        format: 'png',
        multiplier: multiplier,
    });

    const link = document.createElement('a');
    link.href = dataURL;
    link.download = filename;
    link.click();
    successmsg();
    setTimeout(function(){
        resetForm();
    },2000); 
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

function addLogoToCanvas(logoImg, canvas, printingColor, canvasWidth, canvasHeight) {
    if (printingColor.toLowerCase() === 'none') {
        // Add original logo without recoloring
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
        const a = data[i + 3];
        if (a === 0) continue;
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
        canvas.renderAll();
    });
}
