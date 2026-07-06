// build_geojson.mjs — precompute the map's GeoJSON at build/deploy time so the
// browser never has to parse README.md itself.
//
//   node scripts/build_geojson.mjs
//
// Runs the same parser/resolver the app used to run on every page load, and
// writes the result to docs/data/grid-data.geojson, which js/app.js fetches
// directly. Re-run after editing README.md (the Pages workflow does this
// automatically on every deploy).

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { feature } from "topojson-client";
import { parseReadme, resolveGeoJSON } from "../docs/js/parser.js";
import { fixAntimeridian } from "../docs/js/geo.js";

const __dir = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dir, "..");

function main() {
  const md = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
  const topo = JSON.parse(
    fs.readFileSync(path.join(ROOT, "docs/data/countries-110m.json"), "utf8")
  );

  const world = feature(topo, topo.objects.countries);
  const worldFeatures = world.features
    .filter((f) => f.properties.name !== "Antarctica")
    .map(fixAntimeridian);

  const records = parseReadme(md);
  const { geojson, unresolved } = resolveGeoJSON(records, worldFeatures);

  const dest = path.join(ROOT, "docs/data/grid-data.geojson");
  fs.writeFileSync(dest, JSON.stringify(geojson));
  console.log(
    `parsed ${records.length} records -> ${geojson.features.length} countries ` +
    `(${unresolved.length} unresolved) -> ${dest} (${(fs.statSync(dest).size / 1024).toFixed(0)} KB)`
  );
}

main();
