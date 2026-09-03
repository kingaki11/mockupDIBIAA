// Converts the specific, narrow subset of SVG that potrace emits (absolute
// M/L/C path commands only, solid fill colors, no strokes/gradients/text)
// into a real EPS (PostScript) file. This is NOT a general SVG-to-EPS
// converter — it only needs to handle potrace's own output, which keeps it
// small and reliable instead of reimplementing the SVG spec.

function hexToUnitRGB(hex) {
    const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex || '#000000');
    if (!m) return [0, 0, 0];
    return [parseInt(m[1], 16) / 255, parseInt(m[2], 16) / 255, parseInt(m[3], 16) / 255];
}

// Tokenizes a potrace "d" attribute (only M/L/C commands, absolute coords,
// space+comma separated numbers) into a PostScript path-painting sequence.
function pathDataToPS(d) {
    const tokens = d.match(/[MLC]|-?\d*\.?\d+(?:e-?\d+)?/g) || [];
    let i = 0;
    const next = () => parseFloat(tokens[i++]);
    let ps = '';
    let subpathOpen = false;

    while (i < tokens.length) {
        const cmd = tokens[i++];
        if (cmd === 'M') {
            if (subpathOpen) ps += 'closepath\n';
            const x = next(), y = next();
            ps += `${x.toFixed(3)} ${y.toFixed(3)} moveto\n`;
            subpathOpen = true;
        } else if (cmd === 'L') {
            const x = next(), y = next();
            ps += `${x.toFixed(3)} ${y.toFixed(3)} lineto\n`;
        } else if (cmd === 'C') {
            const x1 = next(), y1 = next(), x2 = next(), y2 = next(), x = next(), y = next();
            ps += `${x1.toFixed(3)} ${y1.toFixed(3)} ${x2.toFixed(3)} ${y2.toFixed(3)} ${x.toFixed(3)} ${y.toFixed(3)} curveto\n`;
        } else {
            // Unexpected command — potrace shouldn't emit anything else, but
            // skip forward rather than crashing the whole conversion.
            continue;
        }
    }
    if (subpathOpen) ps += 'closepath\n';
    return ps;
}

// svg: potrace's output string. Returns an EPS (PostScript) file as a string.
function potraceSvgToEps(svg) {
    const widthMatch = /width="([\d.]+)"/.exec(svg);
    const heightMatch = /height="([\d.]+)"/.exec(svg);
    const width = widthMatch ? parseFloat(widthMatch[1]) : 300;
    const height = heightMatch ? parseFloat(heightMatch[1]) : 300;

    const pathRe = /<path\s+([^>]*?)\/?>/g;
    let match;
    const fillOps = [];
    while ((match = pathRe.exec(svg))) {
        const attrs = match[1];
        const fillMatch = /fill="([^"]+)"/.exec(attrs);
        const opacityMatch = /fill-opacity="([^"]+)"/.exec(attrs);
        const dMatch = /d="([^"]+)"/.exec(attrs);
        const ruleMatch = /fill-rule="([^"]+)"/.exec(attrs);
        if (!dMatch) continue;
        fillOps.push({
            fill: fillMatch ? fillMatch[1] : '#000000',
            opacity: opacityMatch ? parseFloat(opacityMatch[1]) : 1,
            // potrace's holes (e.g. the counters in letters like "o"/"g") rely on
            // fill-rule="evenodd" — PostScript's plain `fill` uses nonzero winding
            // instead, which would fill those holes in solid. Must use `eofill`.
            evenOdd: ruleMatch ? ruleMatch[1] === 'evenodd' : false,
            ps: pathDataToPS(dMatch[1]),
        });
    }

    let body = '';
    fillOps.forEach(({ fill, opacity, evenOdd, ps }) => {
        const [r, g, b] = hexToUnitRGB(fill === 'black' ? '#000000' : fill === 'white' ? '#ffffff' : fill);
        body += `newpath\n${ps}${r.toFixed(4)} ${g.toFixed(4)} ${b.toFixed(4)} setrgbcolor\n`;
        // Plain EPS has no native alpha — opacity is approximated by lightening
        // the fill toward white, so posterized (multi-tone) traces still read
        // as distinct shades instead of flattening to one solid color.
        if (opacity < 1) {
            const lr = r + (1 - r) * (1 - opacity);
            const lg = g + (1 - g) * (1 - opacity);
            const lb = b + (1 - b) * (1 - opacity);
            body = body.replace(/[\d.]+ [\d.]+ [\d.]+ setrgbcolor\n$/, `${lr.toFixed(4)} ${lg.toFixed(4)} ${lb.toFixed(4)} setrgbcolor\n`);
        }
        body += evenOdd ? 'eofill\n' : 'fill\n';
    });

    // Fuller DSC structure (LanguageLevel/DocumentData/Prolog/Setup/save-restore)
    // than the bare minimum — hand-written EPS that skips these is a known
    // source of "imports blank" failures in CorelDRAW's own EPS interpreter,
    // which is much stricter/less forgiving than Ghostscript or other renderers.
    return `%!PS-Adobe-3.0 EPSF-3.0
%%Creator: mockupdibiaa-backend (potrace-based vector trace)
%%Title: traced-logo
%%BoundingBox: 0 0 ${Math.ceil(width)} ${Math.ceil(height)}
%%HiResBoundingBox: 0 0 ${width} ${height}
%%DocumentData: Clean7Bit
%%LanguageLevel: 2
%%Pages: 1
%%EndComments
%%BeginProlog
%%EndProlog
%%BeginSetup
%%EndSetup
%%Page: 1 1
save
0 ${height} translate
1 -1 scale
${body}restore
%%Trailer
%%EOF
`;
}

module.exports = { potraceSvgToEps };
