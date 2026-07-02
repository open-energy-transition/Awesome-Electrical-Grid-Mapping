// build_admin1.mjs — generate docs/data/admin1.geojson: a compact set of state/
// province polygons for exactly the subregions that appear in README.md.
//
//   node scripts/build_admin1.mjs
//
// Source: Natural Earth 50m admin-1 states/provinces (fetched). Output keeps only
// the units we have data for, with rounded coordinates and clean properties
// { country: <NE country name>, name: <README display name>, iso }.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const NE_URL =
  "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_50m_admin_1_states_provinces.geojson";

const __dir = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dir, "..");

// --- tiny, self-contained parse of (country, subregion) pairs from the README ---
const COUNTRY_NE = {
  "united states": "United States of America", "us": "United States of America",
  "canada": "Canada", "india": "India", "australia": "Australia",
  "united kingdom": "United Kingdom",
};
const SUB_FIX = {
  delphi: "Delhi", jharkand: "Jharkhand", "madhya pradesh": "Madhya Pradesh", quebec: "Québec",
};
const looseKey = (s) =>
  s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const titleCase = (s) =>
  s.replace(/\w[^\s/-]*/g, (w) => (w.length <= 3 && w === w.toUpperCase() ? w : w[0].toUpperCase() + w.slice(1).toLowerCase()));

function subregionPairs(md) {
  const clean = md.replace(/<!--[\s\S]*?-->/g, "");
  const pairs = new Set();
  for (const ln of clean.split(/\r?\n/)) {
    const m = ln.match(/^\s*\*\s+((?:\([^)]*\)\s*)+)\[/);
    if (!m) continue;
    const groups = [...m[1].matchAll(/\(([^)]*)\)/g)].map((g) => g[1].trim());
    if (groups.length < 2) continue;
    const country = COUNTRY_NE[looseKey(groups[0].split(/[;,]/)[0])];
    if (!country) continue;
    for (const g of groups.slice(1)) {
      for (const raw of g.split(/[;,]/).map((s) => s.trim()).filter(Boolean)) {
        const name = SUB_FIX[looseKey(raw)] || titleCase(raw);
        pairs.add(country + "||" + name);
      }
    }
  }
  return [...pairs].map((p) => { const [country, name] = p.split("||"); return { country, name }; });
}

// --- coordinate rounding to shrink the payload (~100 m precision) ---
const round = (n) => Math.round(n * 1000) / 1000;
function roundGeom(geom) {
  const rc = (c) => (typeof c[0] === "number" ? [round(c[0]), round(c[1])] : c.map(rc));
  return { type: geom.type, coordinates: geom.coordinates.map(rc) };
}

async function main() {
  const md = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
  const wanted = subregionPairs(md);

  console.log(`README subregions: ${wanted.length}`);
  const src = await (await fetch(NE_URL)).json();

  // index admin1 features by admin + loose(name / name_en)
  const idx = new Map();
  for (const f of src.features) {
    const admin = f.properties.admin;
    for (const nm of [f.properties.name, f.properties.name_en]) {
      if (nm) idx.set(admin + "||" + looseKey(nm), f);
    }
  }

  const out = [];
  const missing = [];
  for (const w of wanted) {
    const f = idx.get(w.country + "||" + looseKey(w.name));
    if (!f) { missing.push(w); continue; }
    out.push({
      type: "Feature",
      properties: { country: w.country, name: w.name, iso: f.properties.iso_3166_2 || null },
      geometry: roundGeom(f.geometry),
    });
  }

  const fc = { type: "FeatureCollection", features: out };
  const dest = path.join(ROOT, "docs", "data", "admin1.geojson");
  fs.writeFileSync(dest, JSON.stringify(fc));
  console.log(`matched ${out.length} / ${wanted.length} → ${dest} (${(fs.statSync(dest).size / 1024).toFixed(0)} KB)`);
  if (missing.length) console.log("unmatched (stay panel-only):", missing.map((m) => `${m.name} [${m.country}]`).join(", "));
}

main().catch((e) => { console.error(e); process.exit(1); });
