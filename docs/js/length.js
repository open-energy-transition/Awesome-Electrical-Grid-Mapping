// length.js — everything that turns the grid-length dataset into pixels, minus the map.
//
// No Leaflet, no mutable state, no reads of module-external globals: app.js owns the
// state and calls in here for colours, formatting and DOM. Same discipline as geo.js
// and regions.js, and the reason this feature didn't push app.js past 900 lines.
//
// Data: docs/data/grid-length.json, built from data/grid-length.csv by
// scripts/build_grid_length.mjs. MapYourGrid Global Transmission Length Index, CC BY 4.0.

import { sourceCategory } from "./regions.js";

// Sequential aqua ramp for the length choropleth — deliberately NOT the COVERAGE ramp
// in app.js. The two views share one map, and a legend swap is a weak cue: with the
// same colours, a screenshot of "Transmission length" would be indistinguishable from one of
// "Data coverage". A hue-family change makes the mode legible at a glance, and costs
// nothing because the two ramps never appear together.
//
// Single hue (16° span vs COVERAGE's 316°), OKLCH lightness strictly monotone
// 0.334 → 0.858 with every adjacent gap ≥ 0.100, and a worst all-pairs ΔE of 9.4
// across normal/protan/deutan/tritan vision — checked over all 15 pairs, because a
// choropleth is an all-pairs form, not just an adjacent-pairs one. Step 1 sits ΔE 10.8
// from NO_DATA, so "very low" still reads as distinct from "unknown".
//
// Known collision: step 4 #2aa87f is ΔE 3.4 from TYPES.dataset #199e70. Accepted
// because length mode removes the admin-1 layer and the capacity dots, so no
// TYPES-coloured mark is on the map at all — the survivors are labelled chips inside
// the panel, on --surface-1, never adjacent to a fill.
//
// Mirrored as --len-1…6 in css/style.css for the panel bar's hatch overlays.
export const LENGTH_RAMP = ["#123f35", "#186052", "#1e8368", "#2aa87f", "#5cc998", "#9ce3bd"];
export const NO_DATA_LEN = "#201f1d";   // same as the coverage ramp's no-data land

// "7.65M" / "133,300" / "92" — thousands separators below a million, two significant
// decimals above, because at that size the last four digits are noise.
export function formatKm(n) {
  if (n === null || n === undefined) return "–";
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  return Math.round(n).toLocaleString("en-US");
}

function fmtDensity(n) {
  if (n === null || n === undefined) return "–";
  return n.toLocaleString("en-US", { maximumFractionDigits: 1 });
}

// Fixed, published breaks — not quantiles. Totals span 79 → 2,477,000 km, so a linear
// ramp puts 130 of 131 countries in one bucket; but quantile breaks shift silently
// whenever the sheet is refreshed (a country crossing a break repaints its neighbours),
// and "1,000 – 4,999 km" is a far more useful legend than "2nd quintile".
// Bucket counts in the comments are against the 2025-11 snapshot.
function ramp(mins) {
  // descending, so lengthColor is the same first-match loop as app.js's coverageColor
  return mins.map((min, i) => ({ min, color: LENGTH_RAMP[i] })).reverse();
}

export const METRICS = {
  total: {
    key: "total",
    label: "Total",
    long: "Total line length",
    unit: "km",
    get: (r) => r.totalKm,
    fmt: (v) => `${formatKm(v)} km`,
    breaks: ramp([1, 1000, 5000, 10000, 25000, 100000]),          // 15/22/34/23/27/10
    ticks: ["0", "1k", "5k", "10k", "25k", "100k+"],
    note: "Total line length at 50 kV and above, all voltages summed.",
  },
  kv220: {
    key: "kv220",
    label: "220 kV+",
    long: "At 220 kV and above",
    unit: "km",
    get: (r) => r.km220plus,
    fmt: (v) => `${formatKm(v)} km`,
    breaks: ramp([1, 500, 2000, 8000, 25000, 100000]),            // 14/22/41/17/11/4
    ticks: ["0", "500", "2k", "8k", "25k", "100k+"],
    note: "The transmission backbone only. Reported by fewer countries than the total.",
  },
  density: {
    key: "density",
    label: "per 1,000 km²",
    long: "Line-km per 1,000 km²",
    unit: "km / 1,000 km²",
    get: (r) => r.densityKmPer1000Km2,
    fmt: (v) => `${fmtDensity(v)} km / 1,000 km²`,
    breaks: ramp([1, 10, 25, 60, 150, 350]),                      // 14/17/28/32/16/3
    ticks: ["0", "10", "25", "60", "150", "350+"],
    note:
      "Grid density — independent of country size, so it is the metric that stops the " +
      "map being a map of big countries. Areas are measured from the Natural Earth 110m " +
      "polygons (±2%, total area including inland water and any overseas territory the " +
      "basemap attaches to the country); countries under 25,000 km² are omitted.",
  },
};

export const METRIC_ORDER = ["total", "kv220", "density"];

export function lengthColor(rec, metricKey) {
  const v = rec ? METRICS[metricKey].get(rec) : null;
  if (v === null || v === undefined) return NO_DATA_LEN;
  for (const b of METRICS[metricKey].breaks) if (v >= b.min) return b.color;
  return LENGTH_RAMP[0];   // a genuine, sourced zero (Dominica, Somalia) — not no-data
}

/* ---------------- index ---------------- */

// byName is keyed on the Natural Earth name, so it joins straight onto the map layers.
// Countries with no 110m polygon (Bahrain, Malta, Singapore, the island micro-states)
// have name === null: they stay in `rows` for the table and are absent from `byName`.
export function buildLengthIndex(json) {
  const rows = json.countries;
  const byName = new Map();
  for (const r of rows) if (r.name) byName.set(r.name, r);
  return { byName, rows, meta: json.meta };
}

export function lengthStats(meta) {
  return [
    { n: `${formatKm(meta.totals.km)} km`, label: "Total line length" },
    { n: `${formatKm(meta.totals.km220plus)} km`, label: "At 220 kV+" },
    { n: String(meta.totals.withTotal), label: "Countries with data" },
  ];
}

/* ---------------- legend ---------------- */

export function renderLengthLegend(swatchEl, labelEl, caveatEl, metricKey, meta) {
  const m = METRICS[metricKey];
  swatchEl.innerHTML = LENGTH_RAMP.map((c, i) => {
    const lo = m.ticks[i];
    const hi = m.ticks[i + 1];
    const title = hi ? `${lo} – ${hi}` : `${lo} and above`;
    return `<span class="sw" style="background:${c}" title="${esc(title)}"></span>`;
  }).join("");
  labelEl.innerHTML = m.ticks.map((t) => `<span>${esc(t)}</span>`).join("");
  // Permanent, not a tooltip: the basis is unrecorded for most countries, so anyone
  // comparing two numbers needs to see the caveat next to the ramp that produced them.
  caveatEl.innerHTML =
    `${esc(m.note)} <span class="cav-2">${esc(meta.scope)} ` +
    `Route- and circuit-length figures are mixed and the basis is unrecorded for most ` +
    `countries, so treat cross-country comparisons as indicative.</span>`;
}

/* ---------------- ranking table ---------------- */

export const RANK_COLUMNS = [
  { key: "rank",    label: "#",             sortable: false, cls: "c-rank" },
  { key: "name",    label: "Country",       sortable: true,  cls: "c-name" },
  { key: "total",   label: "Total km",      sortable: true,  cls: "c-num" },
  { key: "kv220",   label: "220 kV+",       sortable: true,  cls: "c-num" },
  { key: "density", label: "km/1000 km²",   sortable: true,  cls: "c-num c-dens" },
  { key: "year",    label: "Year",          sortable: true,  cls: "c-num c-year" },
  { key: "src",     label: "Src",           sortable: false, cls: "c-src" },
];

const SORT_VALUE = {
  name: (r) => r.sheetName.toLowerCase(),
  total: (r) => r.totalKm,
  kv220: (r) => r.km220plus,
  density: (r) => r.densityKmPer1000Km2,
  year: (r) => r.year,
};

// Nulls always last, whichever direction — otherwise sorting descending by 220 kV+
// opens on 86 consecutive dashes.
export function sortRows(rows, key, dir) {
  const val = SORT_VALUE[key] || SORT_VALUE.total;
  return [...rows].sort((a, b) => {
    const x = val(a), y = val(b);
    const xn = x === null || x === undefined || x === "";
    const yn = y === null || y === undefined || y === "";
    if (xn && yn) return a.sheetName.localeCompare(b.sheetName);
    if (xn) return 1;
    if (yn) return -1;
    if (x === y) return a.sheetName.localeCompare(b.sheetName);
    return (x > y ? 1 : -1) * dir;
  });
}

export function renderRankHead(theadEl, sort) {
  theadEl.innerHTML =
    "<tr>" + RANK_COLUMNS.map((c) => {
      const on = c.sortable && sort.key === c.key;
      const aria = !c.sortable ? "none" : on ? (sort.dir === 1 ? "ascending" : "descending") : "none";
      return `<th class="${c.cls}${c.sortable ? " srt" : ""}${on ? " on" : ""}" ` +
             `aria-sort="${aria}"${c.sortable ? ` tabindex="0" role="button" data-key="${c.key}"` : ""}>` +
             `${esc(c.label)}</th>`;
    }).join("") + "</tr>";
}

export function renderRankBody(tbodyEl, rows, metricKey) {
  tbodyEl.innerHTML = rows.map((r, i) => {
    const orphan = !r.name;
    const swatch = `<span class="rsw" style="background:${lengthColor(r, metricKey)}"></span>`;
    const src = r.sources[0]
      ? `<a href="${esc(r.sources[0])}" target="_blank" rel="noopener" ` +
        `title="${esc(r.sources.map((u) => sourceCategory(u).host || u).join(" · "))}">↗</a>`
      : "";
    return `<tr class="${orphan ? "norow" : ""}" ${orphan ? 'aria-disabled="true"' : 'tabindex="0"'} ` +
      `data-ne="${esc(r.name || "")}" ` +
      `title="${esc(orphan ? `${r.sheetName} — no polygon in the 110m basemap, table only` : r.sheetName)}">` +
      `<td class="c-rank">${i + 1}</td>` +
      `<td class="c-name">${swatch}${esc(r.sheetName)}</td>` +
      `<td class="c-num">${formatKm(r.totalKm)}</td>` +
      `<td class="c-num">${formatKm(r.km220plus)}</td>` +
      `<td class="c-num c-dens">${fmtDensity(r.densityKmPer1000Km2)}</td>` +
      `<td class="c-num c-year">${r.year ?? "–"}${r.yearApprox ? "<i>?</i>" : ""}</td>` +
      `<td class="c-src">${src}</td>` +
      `</tr>`;
  }).join("");
}

/* ---------------- country panel section ---------------- */

// Renders in both map modes: how much grid a country has is a fact about the country,
// not about the view. Returns an element for renderPanel to prepend into .body.
export function renderLengthSection(rec, meta) {
  const el = document.createElement("section");
  el.className = "lenblock";

  const tiles = `
    <div class="ltiles">
      <div class="ltile"><span class="n">${formatKm(rec.totalKm)}<span class="u">km</span></span>
        <span class="l">total, 50 kV+</span></div>
      <div class="ltile"><span class="n">${formatKm(rec.km220plus)}<span class="u">km</span></span>
        <span class="l">at 220 kV+</span></div>
    </div>`;

  const segs = segments(rec, meta);
  const bar = rec.totalKm
    ? `<div class="lbar" role="img" aria-label="${esc(barAria(segs, rec))}">
         ${segs.map((s) => `<span class="lseg${s.cls}" style="flex:${s.km};${s.color ? `background:${s.color}` : ""}"
              title="${esc(`${s.label}: ${formatKm(s.km)} km`)}"></span>`).join("")}
       </div>
       ${segs.length === 1 && segs[0].cls === " un"
          ? `<p class="lcap">No per-voltage breakdown published — the total is a single reported figure.</p>`
          : `<dl class="ltiers">${segs.map((s) => `
              <dt><span class="dot${s.cls}" style="${s.color ? `background:${s.color}` : ""}"></span>${esc(s.label)}</dt>
              <dd>${formatKm(s.km)} km<span class="pct">${((s.km / rec.totalKm) * 100).toFixed(0)}%</span></dd>`).join("")}
            </dl>`}`
    : `<p class="lcap">${rec.totalKm === 0
        ? "No lines at 50 kV or above reported."
        : "No length figure published yet."}</p>`;

  const density = `<div class="lrow"><span class="k">Grid density</span><span class="v"${
    rec.densityKmPer1000Km2 === null
      ? ` title="Not shown: the Natural Earth 110m polygon is under ${meta.minAreaKm2.toLocaleString("en-US")} km², too coarse to divide by"`
      : ""
  }>${METRICS.density.fmt(rec.densityKmPer1000Km2)}</span></div>`;

  const basis = rec.circuit === true ? "Circuit length"
    : rec.circuit === false ? "Route length"
    : "Length basis unspecified";
  const meta1 = `
    <div class="lmeta">
      <span class="lchip">${rec.year ?? "Year unknown"}${
        rec.yearApprox && rec.yearRaw ? `<i title="${esc(`reported as: ${rec.yearRaw}`)}">?</i>` : ""}</span>
      <span class="lchip${rec.circuit === null ? " dim" : ""}"${
        rec.circuitRaw && rec.circuit === null ? ` title="${esc(`reported as: ${rec.circuitRaw}`)}"` : ""
      }>${basis}</span>
      ${rec.iso2 ? `<span class="lchip dim">${esc(rec.iso2)}</span>` : ""}
      ${rec.wikidata
        ? `<a class="lchip dim" href="https://www.wikidata.org/wiki/${esc(rec.wikidata)}"
             target="_blank" rel="noopener">${esc(rec.wikidata)}</a>`
        : ""}
    </div>`;

  const srcLinks = rec.sources.map((u) =>
    `<a href="${esc(u)}" target="_blank" rel="noopener">${esc(sourceCategory(u).host || u)}</a>`).join("");
  const sources = rec.sources.length
    ? `<div class="lrow"><span class="k">Source${rec.sources.length > 1 ? "s" : ""}</span>
         <span class="v lsrc">${srcLinks}</span></div>`
    : "";
  const totalSrc = rec.totalSource
    ? `<div class="lrow"><span class="k">Total from</span><span class="v">${esc(rec.totalSource)}</span></div>`
    : "";

  const notes = rec.notes
    ? rec.notes.length > 140
      ? `<details class="lnotes"><summary>Notes</summary><p>${esc(rec.notes)}</p></details>`
      : `<p class="lnotes-inline">${esc(rec.notes)}</p>`
    : "";

  el.innerHTML = `
    <div class="group-h">Transmission length</div>
    ${tiles}${bar}${density}${meta1}${sources}${totalSrc}${notes}
    <p class="lattr">${esc(meta.publisher)} <a href="${esc(meta.sourceUrl)}" target="_blank"
      rel="noopener">${esc(meta.title)}</a> ·
      <a href="${esc(meta.licenseUrl)}" target="_blank" rel="noopener">${esc(meta.license)}</a>${
        meta.dataUpdated ? ` · updated ${esc(meta.dataUpdated)}` : ""}</p>`;
  return el;
}

// Bar segments: the six voltage tiers, then any range-column bands (hatched, because
// "30–132 kV" is not a tier and pretending otherwise invents precision), then the
// remainder as an explicit grey "not broken out" block.
//
// The bar is never normalised to 100% of the attributed length. 16 countries publish a
// total with no breakdown at all (China, the US, Russia, Canada, Germany, Saudi Arabia)
// and 11 more publish a partial one (Italy accounts for 33%, the UAE 29%). Stretching
// those to fill the bar would fabricate a complete breakdown.
function segments(rec, meta) {
  const out = [];
  for (const t of meta.voltageTiers) {
    const km = rec.tiers[t.key];
    if (km > 0) out.push({ label: t.label, km, color: rampColor(t.loKv, meta), cls: "" });
  }
  for (const b of rec.bands) {
    out.push({ label: b.label, km: b.km, color: rampColor(b.loKv, meta), cls: " band" });
  }
  if (rec.unattributedKm > 0) out.push({ label: "Not broken out", km: rec.unattributedKm, cls: " un" });
  return out;
}

// Voltage tiers are ordinal, so the bar reuses the choropleth ramp — one hue, monotone
// lightness — which also ties the bar visually to the map fill.
function rampColor(loKv, meta) {
  const i = meta.voltageTiers.findIndex((t) => loKv >= t.loKv && (t.hiKv === null || loKv < t.hiKv));
  return LENGTH_RAMP[i < 0 ? 0 : i];
}

function barAria(segs, rec) {
  return `Voltage breakdown of ${formatKm(rec.totalKm)} km: ` +
    segs.map((s) => `${s.label} ${formatKm(s.km)} km`).join(", ");
}

/* ---------------- CSV ---------------- */

// A second export button rather than a mode-switch on the existing one: the two
// datasets carry different licences (the awesome-list is CC0, this is CC BY 4.0) and
// each button sits beside its own badge. CC BY needs the attribution to travel with
// the file, hence the leading comment lines.
export function lengthCsv(rows, meta, csvField) {
  const tierKeys = meta.voltageTiers.map((t) => t.key);
  const header = [
    "Country", "Natural Earth name", "ISO-2", "Wikidata", "Total km (50kV+)", "220 kV+ km",
    "Area km2", "km per 1000 km2", "Year", "Year as reported", "Length basis",
    ...meta.voltageTiers.map((t) => `${t.label} km`),
    "Bands km", "Not broken out km", "Sources", "Notes",
  ];
  const body = rows.map((r) => [
    r.sheetName, r.name || "", r.iso2 || "", r.wikidata || "",
    r.totalKm ?? "", r.km220plus ?? "", r.areaKm2 ?? "", r.densityKmPer1000Km2 ?? "",
    r.year ?? "", r.yearRaw || "", r.circuitRaw || "",
    ...tierKeys.map((k) => r.tiers[k] || ""),
    r.bands.map((b) => `${b.label}: ${b.km}`).join("; "),
    r.unattributedKm ?? "",
    r.sources.join("; "), r.notes || "",
  ]);
  return [
    `# ${meta.publisher} — ${meta.title}. ${meta.license} (${meta.licenseUrl}).`,
    `# ${meta.scope} Source: ${meta.sourceUrl} · sheet last updated ${meta.dataUpdated}.`,
    ...[header, ...body].map((r) => r.map(csvField).join(",")),
  ].join("\r\n");
}

/* ---------------- utils ---------------- */

// Local copy rather than an import: app.js's escapeHtml is private to it, and a
// three-line escaper is cheaper to duplicate than a shared module is to justify.
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
