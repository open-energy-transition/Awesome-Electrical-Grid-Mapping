// parser.js — the "small parser" that turns the awesome-list README into GeoJSON.
//
//   README.md ──parseReadme()──▶ [dataset records]
//   [records] + world polygons ──resolveGeoJSON()──▶ FeatureCollection (one feature
//                                                    per region, datasets attached)
//
// A dataset record looks like:
//   { title, url, host, source:{key,label}, year, licence, types:[...],
//     countries:[neName,...], subregions:[...], line }

import {
  TYPE_TOKENS, LICENCE_RE, COUNTRY_ALIASES, REGIONAL_TOKENS,
  SUBREGION_FIX, looseKey, sourceCategory,
} from "./regions.js";

// Strip <!-- html comments --> so the contribution-format example line is ignored.
function stripComments(md) {
  return md.replace(/<!--[\s\S]*?-->/g, "");
}

// Classify the trailing "(...)" tokens of a line into year / licence / types.
function classifyMeta(tokens) {
  let year = null, licence = null;
  const types = new Set();
  for (const raw of tokens) {
    const t = raw.trim();
    if (!t) continue;
    const key = looseKey(t);
    if (/^\d{4}$/.test(t)) { year = year || t; continue; }
    if (TYPE_TOKENS[key]) { types.add(TYPE_TOKENS[key]); continue; }
    if (LICENCE_RE.test(t)) { licence = licence || t; continue; }
    // unknown descriptor (e.g. "unofficial") — ignore for typing
  }
  return { year, licence, types: [...types] };
}

// Split a country group on ; or , into individual names.
function splitNames(group) {
  return group.split(/[;,]/).map((s) => s.trim()).filter(Boolean);
}

// Parse the README markdown into flat dataset records (no geometry yet).
export function parseReadme(md) {
  const lines = stripComments(md).split(/\r?\n/);
  const records = [];

  for (const ln of lines) {
    // A geolocated entry: "* (Group)(Group…) [Title](url) (meta) (meta)…"
    const head = ln.match(/^\s*\*\s+((?:\([^)]*\)\s*)+)\[([^\]]+)\]\(([^)\s]+)[^)]*\)(.*)$/);
    if (!head) continue;

    const groups = [...head[1].matchAll(/\(([^)]*)\)/g)].map((g) => g[1].trim());
    if (!groups.length) continue;

    const title = head[2].trim();
    const url = head[3].trim();
    const rest = head[4];

    const countryGroup = groups[0];
    const subGroups = groups.slice(1);

    // meta tokens are the "(...)" after the link
    const metaTokens = [...rest.matchAll(/\(([^)]*)\)/g)].map((g) => g[1]);
    const { year, licence, types } = classifyMeta(metaTokens);

    const src = sourceCategory(url);

    records.push({
      title, url,
      host: src.host,
      source: { key: src.key, label: src.label },
      year, licence,
      types: types.length ? types : ["other"],
      // raw region strings — resolved to geometry later
      countryTokens: splitNames(countryGroup),
      subregions: subGroups.flatMap(splitNames).map((s) => {
        const fixed = SUBREGION_FIX[looseKey(s)];
        return fixed || titleCase(s);
      }),
    });
  }
  return records;
}

function titleCase(s) {
  return s.replace(/\w[^\s/-]*/g, (w) =>
    w.length <= 3 && w === w.toUpperCase() ? w : w[0].toUpperCase() + w.slice(1).toLowerCase()
  );
}

// Resolve a README country token to a Natural Earth name present in the world data.
export function resolveCountry(token, neIndex) {
  const key = looseKey(token);
  if (REGIONAL_TOKENS.has(key)) return null;
  const aliased = COUNTRY_ALIASES[key];
  if (aliased && neIndex.has(looseKey(aliased))) return aliased;
  if (neIndex.has(key)) return neIndex.get(key).properties.name;
  return null;
}

// Build a GeoJSON FeatureCollection: each country feature that has datasets is
// returned with a `datasets` array + summary counts in its properties.
// worldFeatures: array of GeoJSON country features (properties.name = NE name).
export function resolveGeoJSON(records, worldFeatures) {
  const neIndex = new Map();
  for (const f of worldFeatures) neIndex.set(looseKey(f.properties.name), f);

  const byCountry = new Map(); // neName -> { datasets:Set-ish array }
  const unresolved = [];       // records that matched no country (cross-border etc.)

  for (const r of records) {
    const matched = new Set();
    for (const tok of r.countryTokens) {
      const ne = resolveCountry(tok, neIndex);
      if (ne) matched.add(ne);
    }
    if (matched.size === 0) { unresolved.push(r); continue; }
    for (const ne of matched) {
      if (!byCountry.has(ne)) byCountry.set(ne, []);
      byCountry.get(ne).push(r);
    }
  }

  const features = [];
  for (const [ne, datasets] of byCountry) {
    const f = neIndex.get(looseKey(ne));
    if (!f) continue;
    const typeSet = new Set();
    let capacity = 0;
    for (const d of datasets) {
      d.types.forEach((t) => typeSet.add(t));
      if (d.types.includes("capacitydata")) capacity++;
    }
    features.push({
      type: "Feature",
      geometry: f.geometry,
      properties: {
        name: ne,
        count: datasets.length,
        capacity,
        types: [...typeSet],
        datasets: datasets.map(slimDataset),
      },
    });
  }

  return {
    geojson: { type: "FeatureCollection", features },
    unresolved,
    byCountry,
  };
}

function slimDataset(d) {
  return {
    title: d.title, url: d.url, host: d.host, source: d.source,
    year: d.year, licence: d.licence, types: d.types, subregions: d.subregions,
  };
}
