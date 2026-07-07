// geo.js — geometry helpers shared between the browser app (js/app.js) and the
// Node build script (scripts/build_data.mjs). Pure functions only: no DOM, no
// browser globals, so it runs unmodified in both places.

// Antimeridian fix. Countries whose rings cross ±180° (Fiji, Russia) otherwise draw
// a full-width horizontal streak. "Unwrap" each ring so consecutive vertices never
// jump >180°; the wrapping tail then renders just past the map edge and is clipped.
export function fixAntimeridian(feature) {
  const unwrapRing = (ring) => {
    if (!ring.length) return ring;
    const out = [ring[0].slice()];
    let lon = ring[0][0];
    for (let i = 1; i < ring.length; i++) {
      let d = ring[i][0] - ring[i - 1][0];
      d -= 360 * Math.round(d / 360);
      lon += d;
      out.push([lon, ring[i][1]]);
    }
    return out;
  };
  const g = feature.geometry;
  if (!g) return feature;
  const rings = (polys) => polys.map(unwrapRing);
  const geometry = g.type === "Polygon"
    ? { ...g, coordinates: rings(g.coordinates) }
    : g.type === "MultiPolygon"
      ? { ...g, coordinates: g.coordinates.map(rings) }
      : g;
  return { ...feature, geometry };
}

// Largest polygon (as its ring list) of a Polygon/MultiPolygon feature — the
// "mainland" of a country whose geometry also carries far-flung territories.
export function largestPolygon(feature) {
  const g = feature.geometry;
  if (!g) return null;
  const polys = g.type === "Polygon" ? [g.coordinates]
    : g.type === "MultiPolygon" ? g.coordinates
    : [];

  const ringArea = (ring) => {
    let a = 0;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      a += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
    }
    return a / 2;
  };

  let best = null, bestArea = -1;
  for (const poly of polys) {
    if (!poly.length || poly[0].length < 3) continue;
    const a = Math.abs(ringArea(poly[0]));
    if (a > bestArea) { bestArea = a; best = poly; }
  }
  return best;
}

// Bounding box of the mainland only, as [minLon, minLat, maxLon, maxLat].
// Full-geometry bounds mislead for the same reason as above: France + French
// Guiana spans the Atlantic, so zoom-to-country would frame open ocean.
export function mainlandBounds(feature) {
  const poly = largestPolygon(feature);
  if (!poly) return null;
  let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity;
  for (const [lon, lat] of poly[0]) {
    if (lon < minLon) minLon = lon;
    if (lat < minLat) minLat = lat;
    if (lon > maxLon) maxLon = lon;
    if (lat > maxLat) maxLat = lat;
  }
  return [minLon, minLat, maxLon, maxLat];
}

// Representative point for a marker, as [lon, lat]. A bounding-box center fails for
// countries with far-flung territories (France + French Guiana centers in the
// Atlantic), so instead: take the largest polygon (the mainland), use its centroid
// latitude, and place the point at the midpoint of the widest interior span of a
// horizontal line at that latitude — guaranteed inside, even for concave shapes
// and shapes with holes.
export function representativePoint(feature) {
  const bestPoly = largestPolygon(feature);
  if (!bestPoly) return null;

  // centroid latitude of the outer ring
  const outer = bestPoly[0];
  let a2 = 0, cy = 0;
  for (let i = 0, j = outer.length - 1; i < outer.length; j = i++) {
    const cross = outer[j][0] * outer[i][1] - outer[i][0] * outer[j][1];
    a2 += cross;
    cy += (outer[j][1] + outer[i][1]) * cross;
  }
  const lat = a2 ? cy / (3 * a2) : outer[0][1];

  // horizontal scanline at that latitude, against every ring (holes included) —
  // sorted crossings alternate outside/inside, so [xs[0],xs[1]], [xs[2],xs[3]]…
  // are the interior spans; take the widest one's midpoint
  const xs = [];
  for (const ring of bestPoly) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [x1, y1] = ring[j], [x2, y2] = ring[i];
      if ((y1 > lat) !== (y2 > lat)) {
        xs.push(x1 + ((lat - y1) / (y2 - y1)) * (x2 - x1));
      }
    }
  }
  if (xs.length < 2) return [outer[0][0], lat];
  xs.sort((p, q) => p - q);
  let lon = outer[0][0], widest = -1;
  for (let i = 0; i + 1 < xs.length; i += 2) {
    const w = xs[i + 1] - xs[i];
    if (w > widest) { widest = w; lon = (xs[i] + xs[i + 1]) / 2; }
  }
  return [lon, lat];
}
