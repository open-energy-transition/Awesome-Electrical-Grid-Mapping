// build_data.mjs — precompute the parsed README as a GeoJSON FeatureCollection so
// the browser fetches ready-made data instead of re-parsing the awesome-list
// markdown on every visit. Run this once per deploy (the Pages workflow does it
// automatically); re-run locally after editing README.md to see changes.
//
//   node scripts/build_data.mjs
//
// Output: docs/data/grid-datasets.geojson — properties only, geometry stripped.
// js/app.js re-attaches each feature's geometry from the (already-fetched, far
// more compact) countries-110m.json topojson at boot — a cheap by-name merge, not
// a re-parse. Keeping geometry out of this file avoids ~3x'ing the payload with
// polygon coordinates that are already on the wire in quantized topojson form.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import * as topojson from "topojson-client";

import { parseReadme, resolveGeoJSON } from "../docs/js/parser.js";
import { fixAntimeridian } from "../docs/js/geo.js";

const __dir = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dir, "..");

function main() {
  const md = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
  const topo = JSON.parse(fs.readFileSync(path.join(ROOT, "docs/data/countries-110m.json"), "utf8"));

  const world = topojson.feature(topo, topo.objects.countries);
  const worldFeatures = world.features
    .filter((f) => f.properties.name !== "Antarctica")
    .map(fixAntimeridian);

  const records = parseReadme(md);
  const { geojson, unresolved } = resolveGeoJSON(records, worldFeatures);
  for (const f of geojson.features) delete f.geometry;

  const dest = path.join(ROOT, "docs", "data", "grid-datasets.geojson");
  fs.writeFileSync(dest, JSON.stringify(geojson));

  console.log(
    `parsed ${records.length} records -> ${geojson.features.length} countries -> ${dest} (${(fs.statSync(dest).size / 1024).toFixed(0)} KB)`
  );
  if (unresolved.length) {
    console.log(`${unresolved.length} record(s) had no resolvable country (cross-border/regional, stay panel-only):`);
    for (const r of unresolved) console.log(`  - ${r.title} [${r.countryTokens.join(", ")}]`);
  }
}

main();
