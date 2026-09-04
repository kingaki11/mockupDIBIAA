// Splits potrace's single compound path into one path per shape.
//
// potrace emits the whole trace as one <path> holding every contour, relying on
// fill-rule="evenodd" to knock the holes out. That renders correctly everywhere,
// but an editor imports it as a single curve object: in CorelDRAW there is
// nothing to ungroup and no way to select or recolour one piece of the logo.
//
// Splitting naively would break it — a letter counter is a separate contour, and
// on its own it fills in solid. So contours are nested first: a contour enclosed
// by an odd number of others is a hole and stays with the shape that encloses it,
// while one enclosed by an even number is itself a filled shape and becomes its
// own object. That is the same rule even-odd fill applies, so the result is
// pixel-identical to the compound version.

// Flattens a subpath into a polygon that actually follows the curve.
//
// Endpoints alone are not enough. A circle traced by potrace is a handful of
// cubics, and joining only their endpoints gives an INSCRIBED polygon smaller
// than the real circle — so on two concentric rings, points of the inner circle
// fell outside the outer circle's polygon, the enclosure test failed, and a hole
// was promoted to a filled shape. That turned a ring into a solid disc.
// Control points cannot be used either: they sit outside the curve and inflate
// the bounds the other way. So sample along each cubic instead.
const CURVE_SAMPLES = 8;

function cubicAt(p0, p1, p2, p3, t) {
    const u = 1 - t;
    const a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
    return [
        a * p0[0] + b * p1[0] + c * p2[0] + d * p3[0],
        a * p0[1] + b * p1[1] + c * p2[1] + d * p3[1],
    ];
}

function pointsOf(d) {
    const tokens = d.match(/[MmLlHhVvCcSsQqTtAaZz]|-?\d*\.?\d+(?:e[-+]?\d+)?/gi);
    if (!tokens) return [];
    const pts = [];
    let cmd = null;
    let i = 0;
    let cur = [0, 0];
    const num = () => parseFloat(tokens[i++]);
    const push = (p) => { pts.push(p); cur = p; };

    while (i < tokens.length) {
        const t = tokens[i];
        if (/^[A-Za-z]$/.test(t)) { cmd = t; i++; continue; }
        switch (cmd) {
            case 'M': case 'L': case 'T':
                push([num(), num()]);
                break;
            case 'C': {
                const c1 = [num(), num()];
                const c2 = [num(), num()];
                const end = [num(), num()];
                const from = cur;
                for (let k = 1; k <= CURVE_SAMPLES; k++) {
                    pts.push(cubicAt(from, c1, c2, end, k / CURVE_SAMPLES));
                }
                cur = end;
                break;
            }
            case 'S': case 'Q': {
                const c1 = [num(), num()];
                const end = [num(), num()];
                const from = cur;
                for (let k = 1; k <= CURVE_SAMPLES; k++) {
                    pts.push(cubicAt(from, c1, c1, end, k / CURVE_SAMPLES));
                }
                cur = end;
                break;
            }
            case 'A':
                num(); num(); num(); num(); num();
                push([num(), num()]);
                break;
            case 'H': push([num(), cur[1]]); break;
            case 'V': push([cur[0], num()]); break;
            default: i++; break;
        }
    }
    return pts;
}

function boundsOf(pts) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [x, y] of pts) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
    }
    return { minX, minY, maxX, maxY };
}

function boxInside(a, b) {
    return a.minX >= b.minX && a.maxX <= b.maxX && a.minY >= b.minY && a.maxY <= b.maxY;
}

// Standard ray cast. potrace's contours never cross each other, so testing a
// single point of one against another settles it for the whole contour.
function pointInPolygon(pt, poly) {
    const [x, y] = pt;
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const [xi, yi] = poly[i];
        const [xj, yj] = poly[j];
        if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi + Number.EPSILON) + xi) {
            inside = !inside;
        }
    }
    return inside;
}

// Rewrites an SVG so each shape is its own <path>. Returns the SVG unchanged if
// there is nothing to split or the path data cannot be parsed.
function splitCompoundPaths(svg) {
    const pathTag = /<path\b([^>]*?)\bd="([^"]+)"([^>]*)>/i;
    const m = svg.match(pathTag);
    if (!m) return svg;

    const before = m[1] || '';
    const after = m[3] || '';
    const d = m[2];

    // Each subpath starts at a moveto. Anything with one contour is already a
    // single object.
    const subs = d.split(/(?=M)/i).map((s) => s.trim()).filter(Boolean);
    if (subs.length < 2) return svg;

    const shapes = subs.map((sd) => {
        const pts = pointsOf(sd);
        return { d: sd, pts, box: boundsOf(pts) };
    }).filter((s) => s.pts.length >= 3);
    if (shapes.length < 2) return svg;

    // Enclosure depth decides filled vs hole, exactly as even-odd does.
    for (const s of shapes) {
        s.depth = 0;
        s.parent = -1;
        for (let j = 0; j < shapes.length; j++) {
            const o = shapes[j];
            if (o === s) continue;
            if (!boxInside(s.box, o.box)) continue;
            if (!pointInPolygon(s.pts[0], o.pts)) continue;
            s.depth++;
            // Immediate parent is the tightest enclosing contour.
            if (s.parent === -1 || boxInside(o.box, shapes[s.parent].box)) s.parent = j;
        }
    }

    const groups = new Map();
    shapes.forEach((s, i) => { if (s.depth % 2 === 0) groups.set(i, [s.d]); });
    shapes.forEach((s) => {
        if (s.depth % 2 === 0) return;              // filled shape, already its own group
        if (s.parent !== -1 && groups.has(s.parent)) groups.get(s.parent).push(s.d);
    });
    if (groups.size < 2) return svg;

    // fill-rule stays on every emitted path: a shape keeps its own holes. The
    // trailing slash of a self-closing source tag is captured by the attribute
    // group and has to go, or it lands mid-tag and the SVG will not parse.
    const attrs = (before + after).replace(/\/\s*$/, '').replace(/\s+/g, ' ').trim();
    const paths = [...groups.values()]
        .map((parts) => `<path ${attrs} d="${parts.join(' ')}"/>`)
        .join('\n\t');

    // Grouped so an editor offers one ungroup rather than dozens of loose objects.
    return svg.replace(pathTag, `<g>\n\t${paths}\n</g>`).replace(/<\/path>/i, '');
}

module.exports = { splitCompoundPaths };
