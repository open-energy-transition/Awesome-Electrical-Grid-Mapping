// build_grid_length.mjs — turn the committed grid-length CSV snapshot into the JSON
// the site fetches at runtime, and refresh the top-25 table in README.md.
//
//   node scripts/build_grid_length.mjs            (npm run build:length)
//   node scripts/build_grid_length.mjs --check    (verify, write nothing, exit 1 on drift)
//
//   data/grid-length.csv ──▶ docs/data/grid-length.json
//                        └─▶ README.md, between the GRID-LENGTH-TABLE markers
//
// Pure and offline — the network step is scripts/fetch_grid_length.mjs. Country areas
// come from the same Natural Earth topojson the map already ships, so grid density
// needs no extra data file.
//
// Source: MapYourGrid "Global Transmission Length Index", CC BY 4.0.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import * as topojson from "topojson-client";

import { COUNTRY_ALIASES, looseKey } from "../docs/js/regions.js";
import { fixAntimeridian, polygonAreaKm2 } from "../docs/js/geo.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "data", "grid-length.csv");
const DEST = path.join(ROOT, "docs", "data", "grid-length.json");
const README = path.join(ROOT, "README.md");
const TOPO = path.join(ROOT, "docs", "data", "countries-110m.json");

const SHEET_ID = "1qmVIQ2_ynVVfbTWcMXJQWb4Sq0Dq-1fu8zgZ9J_0cZI";
const SHEET_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit?usp=sharing`;
const CSV_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=0`;
const EXPLORER_URL =
  "https://open-energy-transition.github.io/Awesome-Electrical-Grid-Mapping/?view=length";

// Below this, Natural Earth 110m polygon area is too coarse to divide by: the median
// error over all countries is 1.8%, but Trinidad and Tobago comes out +51% and Cyprus
// -33% (NE splits Northern Cyprus into its own geometry). Suppress density there
// rather than publish a number we know is wrong. See polygonAreaKm2 in docs/js/geo.js.
const MIN_AREA_KM2 = 25000;

// Voltage tiers the 45 per-voltage columns are binned into. Six, to match the six-step
// choropleth ramp the panel's stacked bar reuses (docs/js/length.js).
const TIERS = [
  { key: "t50",  loKv: 50,  hiKv: 100,  label: "50–99 kV" },
  { key: "t100", loKv: 100, hiKv: 150,  label: "100–149 kV" },
  { key: "t150", loKv: 150, hiKv: 220,  label: "150–219 kV" },
  { key: "t220", loKv: 220, hiKv: 400,  label: "220–399 kV" },
  { key: "t400", loKv: 400, hiKv: 750,  label: "400–749 kV" },
  { key: "t750", loKv: 750, hiKv: null, label: "750 kV+" },
];

const README_START = "<!-- GRID-LENGTH-TABLE:start -->";
const README_END = "<!-- GRID-LENGTH-TABLE:end -->";
const README_TOP_N = 25;

/* ---------------- CSV ---------------- */

// Character scanner, not a line split: 31 fields in this sheet contain commas, three
// contain quotes and one contains a newline.
function parseCsv(text) {
  const s = text.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  const rows = [];
  let row = [], field = "", inQ = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQ) {
      if (c !== '"') field += c;
      else if (s[i + 1] === '"') { field += '"'; i++; }
      else inQ = false;
    } else if (c === '"') inQ = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else field += c;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows;
}

/* ---------------- field normalisation ---------------- */

const warnings = [];

function num(raw, what) {
  const s = String(raw ?? "").replace(/[, ]/g, "").replace(/\s*km$/i, "").trim();
  if (!s) return null;
  if (!/^-?\d+(\.\d+)?$/.test(s)) {
    warnings.push(`non-numeric ${what}: "${String(raw).trim()}"`);
    return null;
  }
  return Number(s);
}

// The most important rule in this file. Twelve rows carry Total = 0, and they mean two
// different things: ten are `Found = No` (Haiti, North Korea, Papua New Guinea, …)
// where 0 means "nobody has researched this yet", and two are `Found = Yes` with a note
// (Dominica "0km for now above 50kv", Somalia "Does not yet have 50kv+") where 0 is the
// real figure. Without this gate the map claims North Korea has no transmission grid,
// and paints it the same colour as Dominica, which genuinely has none above 50 kV.
function gatedTotal(v, found) {
  if (v === null) return null;
  return v === 0 && !found ? null : v;
}

// "2024/2023/2022" -> 2024: report the freshest figure the cell contains.
function parseYear(raw) {
  const s = String(raw ?? "").trim();
  if (!s || /^unknown$/i.test(s)) return { year: null, yearRaw: s || null, yearApprox: false };
  const years = [...s.matchAll(/\b(19|20)\d{2}\b/g)].map((m) => Number(m[0]));
  if (!years.length) return { year: null, yearRaw: s, yearApprox: true };
  return {
    year: Math.max(...years),
    yearRaw: s,
    // "Post-2021", "2023/2024" — the cell doesn't pin down a single reporting year
    yearApprox: years.length > 1 || /post|pre|circa|ca\.|~|\?/i.test(s),
  };
}

// Route length and circuit length are not comparable, and the sheet records the basis
// for only 56 of 195 countries. true = circuit, false = route, null = unrecorded.
function parseCircuit(raw) {
  const s = String(raw ?? "").trim();
  if (!s) return { circuit: null, circuitRaw: null };
  if (/route/i.test(s)) return { circuit: false, circuitRaw: s };
  if (/^yes$/i.test(s)) return { circuit: true, circuitRaw: s };
  return { circuit: null, circuitRaw: s };   // e.g. "OHL is ckm, cables are rkm"
}

function splitSources(raw) {
  const parts = String(raw ?? "").split(/\s*;\s*/).map((s) => s.trim()).filter(Boolean);
  const urls = parts.filter((p) => /^https?:\/\//.test(p));
  const prose = parts.filter((p) => !/^https?:\/\//.test(p));
  return { urls, prose };
}

function cleanNotes(raw) {
  return String(raw ?? "").replace(/\s*\n+\s*/g, " · ").replace(/\s+/g, " ").trim();
}

// "31/10/2025" / "4/11/2025" -> "2025-10-31". The sheet's own bookkeeping column.
function parseSheetDate(raw) {
  const m = String(raw ?? "").trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  const [, d, mo, y] = m;
  return `${y}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}`;
}

function tierFor(kv) {
  return TIERS.find((t) => kv >= t.loKv && (t.hiKv === null || kv < t.hiKv)) || null;
}

/* ---------------- header classification ---------------- */

const META_HEADERS = new Set([
  "countries", "found", "circuit", "total (220kv+)", "total", "date",
  "source for total if different", "source", "notes", "iso-2 code",
  "wikidata qid", "last updated",
]);

// Columns are resolved by header text, never by index, so a voltage column inserted
// into the sheet is surfaced as a warning rather than silently shifting everything.
function classifyHeaders(header) {
  const byName = new Map();
  const voltages = [];   // { i, kv, label }
  const bands = [];      // { i, loKv, hiKv, label }
  header.forEach((raw, i) => {
    const h = raw.trim();
    const key = h.toLowerCase();
    if (!h) return;
    if (META_HEADERS.has(key)) { byName.set(key, i); return; }
    const band = h.match(/^([\d.]+)\s*kv\s*-\s*([\d.]+)\s*kv/i);   // must precede the single-voltage test
    if (band) {
      bands.push({ i, loKv: Number(band[1]), hiKv: Number(band[2]), label: `${band[1]}–${band[2]} kV` });
      return;
    }
    const single = h.match(/^([\d.]+)\s*kv/i);
    if (single) { voltages.push({ i, kv: Number(single[1]), label: h }); return; }
    warnings.push(`unrecognised column ${i} "${h}" — ignored`);
  });
  for (const k of META_HEADERS) {
    if (!byName.has(k)) warnings.push(`expected column "${k}" not found in the header row`);
  }
  return { byName, voltages, bands };
}

/* ---------------- build ---------------- */

function main() {
  const check = process.argv.includes("--check");

  const rows = parseCsv(fs.readFileSync(SRC, "utf8"));
  const header = rows[1] ?? [];
  const { byName, voltages, bands } = classifyHeaders(header);
  const col = (name) => byName.get(name);
  const cell = (r, name) => (col(name) === undefined ? "" : r[col(name)] ?? "");

  // Country areas from the topojson the map already ships. fixAntimeridian first —
  // Russia's ±180° rings otherwise cancel and it measures 37% small.
  const topo = JSON.parse(fs.readFileSync(TOPO, "utf8"));
  const world = topojson.feature(topo, topo.objects.countries);
  const neIndex = new Map();
  for (const f of world.features) {
    if (f.properties.name === "Antarctica") continue;
    neIndex.set(looseKey(f.properties.name), f);
  }

  const dataRows = rows.slice(2).filter((r) => {
    const n = (r[0] ?? "").trim();
    return n && n.toLowerCase() !== "total";
  });

  const countries = [];
  let dataUpdated = null;

  for (const r of dataRows) {
    const sheetName = (r[0] ?? "").trim();
    const found = /^yes$/i.test(cell(r, "found").trim());

    // Same resolution order as parser.js's resolveCountry: alias, then exact loose match.
    const lk = looseKey(sheetName);
    const aliased = COUNTRY_ALIASES[lk];
    const ne = aliased && neIndex.has(looseKey(aliased)) ? aliased
      : neIndex.has(lk) ? neIndex.get(lk).properties.name
      : null;

    const totalKm = gatedTotal(num(cell(r, "total"), `Total for ${sheetName}`), found);
    const km220plus = gatedTotal(num(cell(r, "total (220kv+)"), `Total (220kv+) for ${sheetName}`), found);

    const vList = [];
    const tiers = Object.fromEntries(TIERS.map((t) => [t.key, 0]));
    for (const v of voltages) {
      const km = num(r[v.i], `${v.label} for ${sheetName}`);
      if (km === null || km === 0) continue;
      vList.push({ kv: v.kv, label: v.label, km });
      const t = tierFor(v.kv);
      if (t) tiers[t.key] += km;
      else warnings.push(`${v.label} (${v.kv} kV) for ${sheetName} falls outside every tier`);
    }

    // The nine range columns stay ranges. Spain reports 22,656 km as "30kv-132kv" —
    // a third of its national total — and filing that under a single tier would
    // invent precision the source doesn't have.
    const bList = [];
    for (const b of bands) {
      const km = num(r[b.i], `${b.label} for ${sheetName}`);
      if (km === null || km === 0) continue;
      bList.push({ loKv: b.loKv, hiKv: b.hiKv, label: b.label, km });
    }

    const attributed = vList.reduce((s, v) => s + v.km, 0) + bList.reduce((s, b) => s + b.km, 0);
    const unattributedKm = totalKm === null ? null : Math.max(0, round1(totalKm - attributed));

    const area = ne ? polygonAreaKm2(fixAntimeridian(neIndex.get(looseKey(ne)))) : null;
    const areaKm2 = area === null ? null : Math.round(area);
    const density = totalKm === null || areaKm2 === null || areaKm2 < MIN_AREA_KM2
      ? null
      : round1((totalKm / areaKm2) * 1000);

    const { urls, prose } = splitSources(cell(r, "source"));
    const notesParts = [cleanNotes(cell(r, "notes"))];
    for (const p of prose) notesParts.push(`Source: ${p}`);

    const iso2raw = cell(r, "iso-2 code").trim().toUpperCase();
    const qid = (cell(r, "wikidata qid").match(/Q\d+/) || [null])[0];

    const stamp = parseSheetDate(cell(r, "last updated"));
    if (stamp && (!dataUpdated || stamp > dataUpdated)) dataUpdated = stamp;

    countries.push({
      name: ne,
      sheetName,
      iso2: /^[A-Z]{2}$/.test(iso2raw) ? iso2raw : null,
      wikidata: qid,
      found,
      totalKm,
      km220plus,
      areaKm2,
      densityKmPer1000Km2: density,
      ...parseYear(cell(r, "date")),
      ...parseCircuit(cell(r, "circuit")),
      voltages: vList,
      bands: bList,
      tiers,
      unattributedKm,
      sources: urls,
      totalSource: cell(r, "source for total if different").trim() || null,
      notes: notesParts.filter(Boolean).join(" · ") || null,
    });
  }

  countries.sort((a, b) => (b.totalKm ?? -1) - (a.totalKm ?? -1) || a.sheetName.localeCompare(b.sheetName));

  const withTotal = countries.filter((c) => c.totalKm !== null);
  const with220 = countries.filter((c) => c.km220plus !== null);
  const mapped = countries.filter((c) => c.name);
  const totals = {
    km: Math.round(withTotal.reduce((s, c) => s + c.totalKm, 0)),
    km220plus: Math.round(with220.reduce((s, c) => s + c.km220plus, 0)),
    countries: countries.length,
    withTotal: withTotal.length,
    with220plus: with220.length,
    withBreakdown: countries.filter((c) => c.voltages.length || c.bands.length).length,
    mapped: mapped.length,
  };

  const out = {
    meta: {
      title: "Global Transmission Length Index",
      publisher: "MapYourGrid",
      license: "CC BY 4.0",
      licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
      sourceUrl: SHEET_URL,
      csvUrl: CSV_URL,
      dataUpdated,
      scope: "Transmission lines at 50 kV and above, overhead lines and cables.",
      rowCount: countries.length,
      minAreaKm2: MIN_AREA_KM2,
      voltageTiers: TIERS,
      totals,
    },
    countries,
  };

  const json = JSON.stringify(out);
  const readme = renderReadme(fs.readFileSync(README, "utf8"), withTotal, totals, dataUpdated);

  if (check) {
    const drift = [];
    if (!fs.existsSync(DEST) || fs.readFileSync(DEST, "utf8") !== json) drift.push(path.relative(ROOT, DEST));
    if (readme !== null && readme !== fs.readFileSync(README, "utf8")) drift.push("README.md");
    if (drift.length) {
      console.error(`--check: out of date with data/grid-length.csv: ${drift.join(", ")}`);
      console.error(`run: node scripts/build_grid_length.mjs`);
      process.exit(1);
    }
    console.log("--check: docs/data/grid-length.json and README.md are up to date");
    return;
  }

  fs.writeFileSync(DEST, json);
  if (readme !== null) fs.writeFileSync(README, readme);

  report(countries, totals, dataUpdated, json.length, readme !== null);
}

function round1(n) { return Math.round(n * 10) / 10; }

/* ---------------- README table ---------------- */

// Rewrites only what sits between the two markers. If either is missing we warn and
// leave README.md alone rather than guess where the table belongs.
function renderReadme(md, withTotal, totals, dataUpdated) {
  const a = md.indexOf(README_START);
  const b = md.indexOf(README_END);
  if (a === -1 || b === -1 || b < a) {
    warnings.push(`README.md: ${README_START} / ${README_END} markers not found — table not written`);
    return null;
  }
  const rows = withTotal.slice(0, README_TOP_N).map((c, i) => {
    const name = c.sheetName;
    const src = c.sources[0] ? `[source](${c.sources[0]})` : "";
    return `| ${i + 1} | ${name} | ${fmt(c.totalKm)} | ${c.km220plus === null ? "–" : fmt(c.km220plus)} | ${c.year ?? "–"} | ${src} |`;
  });
  const table = [
    README_START,
    `<!-- generated by \`npm run build:length\` from data/grid-length.csv — do not edit by hand -->`,
    ``,
    `Top ${README_TOP_N} of ${totals.withTotal} countries with data. Sheet last updated ${dataUpdated ?? "unknown"}.`,
    ``,
    `| # | Country | Total km (50 kV+) | 220 kV+ km | Year | Source |`,
    `| --: | --- | --: | --: | --: | --- |`,
    ...rows,
    `| | **All ${totals.withTotal} countries with data** | **${fmt(totals.km)}** | **${fmt(totals.km220plus)}** | | |`,
    ``,
    `Route- and circuit-length figures are mixed; the basis is unrecorded for most countries. Data: MapYourGrid Global Transmission Length Index, [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).`,
    README_END,
  ].join("\n");
  return md.slice(0, a) + table + md.slice(b + README_END.length);
}

function fmt(n) { return Math.round(n).toLocaleString("en-US"); }

/* ---------------- log ---------------- */

function report(countries, totals, dataUpdated, bytes, wroteReadme) {
  console.log(
    `parsed ${countries.length} rows -> ${totals.mapped} mapped countries, ` +
    `${totals.withTotal} with a total, ${fmt(totals.km)} km`
  );
  console.log(`  -> ${path.relative(ROOT, DEST)} (${(bytes / 1024).toFixed(0)} KB), sheet updated ${dataUpdated}`);
  if (wroteReadme) console.log(`  -> README.md transmission-length table (top ${README_TOP_N})`);

  // Two very different problems, so two lists: an unmatched row *with* data is a
  // missing alias to fix now; an unmatched empty micro-state is expected forever.
  const orphansWithData = countries.filter((c) => !c.name && c.totalKm !== null);
  const orphansEmpty = countries.filter((c) => !c.name && c.totalKm === null);
  if (orphansWithData.length) {
    console.log(`${orphansWithData.length} row(s) have length data but no 110m polygon (table-only):`);
    for (const c of orphansWithData) {
      console.log(`  - ${c.sheetName} [${c.iso2 ?? "??"}] ${fmt(c.totalKm)} km`);
    }
  }
  if (orphansEmpty.length) {
    console.log(
      `${orphansEmpty.length} row(s) unresolved and empty (micro-states absent from NE 110m) — ` +
      `add to COUNTRY_ALIASES in docs/js/regions.js if a name changed:`
    );
    console.log(`  ${orphansEmpty.map((c) => c.sheetName).join(", ")}`);
  }
  if (warnings.length) {
    console.log(`${warnings.length} warning(s):`);
    for (const w of warnings) console.log(`  ! ${w}`);
  }
}

main();
