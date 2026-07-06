// geo.js — pure geometry helpers with no DOM/browser dependency, shared between
// the app (browser) and the build script (Node).

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
