// app.js — wires the precomputed GeoJSON to a Leaflet map + detail panel.
import { TYPES, TYPE_ORDER, sourceCategory } from "./regions.js";
import { fixAntimeridian } from "./geo.js";

// Parsing README.md into GeoJSON happens once at deploy time (scripts/build_geojson.mjs),
// not on every page load — the browser just fetches the resulting static file.
const GRID_DATA_URL = "./data/grid-data.geojson";
const TOPO_URL = "./data/countries-110m.json";
const ADMIN1_URL = "./data/admin1.geojson";

// Coverage buckets — "Ember" sequential heat ramp: dim/cool = few resources,
// hot/bright = many. Monotonic lightness (contrast vs the dark map climbs 1.5→12),
// intuitive as intensity, and distinct from the blue/aqua dataset-type colours.
const COVERAGE = [
  { min: 21, color: "#f6c53b", label: "21+" },   // gold
  { min: 11, color: "#e8842f", label: "11–20" }, // orange
  { min: 6,  color: "#c24d4d", label: "6–10" },  // red
  { min: 3,  color: "#7d3a6b", label: "3–5" },   // plum
  { min: 1,  color: "#3a2c50", label: "1–2" },   // dim violet
];
const NO_DATA = "#201f1d";

function coverageColor(n) {
  for (const b of COVERAGE) if (n >= b.min) return b.color;
  return NO_DATA;
}

let MAP, LAYER, CAP_LAYER, SUB_LAYER;
let FEATURE_BY_NAME = new Map();
let LAYER_BY_NAME = new Map();
let SUB_LAYER_BY_KEY = new Map();   // "country||sub" -> leaflet layer
let SUBREGION_DATA = new Map();     // "country||sub" -> { count, capacity }
let REGION_INDEX = []; // {name, country, count, kind, feature}
let GEOJSON = null;

async function boot() {
  const [geojson, topoRes, admin1] = await Promise.all([
    fetch(GRID_DATA_URL, { cache: "no-store" }).then((r) => r.json()),
    fetch(TOPO_URL).then((r) => r.json()),
    fetch(ADMIN1_URL).then((r) => r.ok ? r.json() : null).catch(() => null),
  ]);

  const world = topojson.feature(topoRes, topoRes.objects.countries);
  const worldFeatures = world.features
    .filter((f) => f.properties.name !== "Antarctica")
    .map(fixAntimeridian);

  GEOJSON = geojson;

  for (const f of geojson.features) FEATURE_BY_NAME.set(f.properties.name, f);
  SUBREGION_DATA = buildSubregionIndex(geojson);

  buildMap(worldFeatures, geojson);
  if (admin1) buildAdmin1(admin1);
  buildStats(geojson);
  buildLegend();
  buildSearchIndex(geojson);
  wireUI();

  document.getElementById("loading").classList.add("hidden");
}

function buildMap(worldFeatures, geojson) {
  MAP = L.map("map", {
    crs: L.CRS.EPSG4326,
    minZoom: 1, maxZoom: 6,
    zoomControl: false,
    attributionControl: false,
    worldCopyJump: false,
    zoomSnap: 0.25,
  });
  L.control.zoom({ position: "bottomright" }).addTo(MAP);

  const dataByName = new Map(geojson.features.map((f) => [f.properties.name, f.properties]));

  LAYER = L.geoJSON({ type: "FeatureCollection", features: worldFeatures }, {
    style: (f) => styleFor(f, dataByName),
    onEachFeature: (f, layer) => {
      const name = f.properties.name;
      LAYER_BY_NAME.set(name, layer);
      const props = dataByName.get(name);
      layer.on({
        mouseover: () => layer.setStyle({ weight: 1.2, color: "rgba(255,255,255,0.55)" }).bringToFront(),
        mouseout:  () => LAYER.resetStyle(layer),
        click:     () => props ? selectCountry(name) : null,
      });
      if (props) layer.bindTooltip(`${name} · ${props.count}`, { sticky: true, className: "lf-tip", opacity: 0.9 });
    },
  }).addTo(MAP);

  // Violet dots on countries that carry capacity data — surfaces the repo's focus.
  const capFeatures = geojson.features.filter((f) => f.properties.capacity > 0);
  CAP_LAYER = L.layerGroup(
    capFeatures.map((f) => {
      const c = LAYER_BY_NAME.get(f.properties.name)?.getBounds().getCenter();
      if (!c) return null;
      return L.circleMarker(c, {
        radius: 3.4, color: "#9085e9", weight: 0, fillColor: "#9085e9",
        fillOpacity: 0.95, interactive: false,
      });
    }).filter(Boolean)
  ).addTo(MAP);

  // Fit to a fixed world extent (not LAYER.getBounds(), whose Russia tail now
  // reaches ~190°E after the antimeridian unwrap and would skew the view).
  MAP.fitBounds([[-58, -175], [78, 179]], { padding: [8, 8] });
  MAP.setMaxBounds([[-95, -220], [95, 220]]);
}

// Aggregate per-subregion counts from the resolved datasets.
function buildSubregionIndex(geojson) {
  const m = new Map();
  for (const f of geojson.features) {
    const country = f.properties.name;
    for (const d of f.properties.datasets) {
      for (const s of (d.subregions || [])) {
        const key = country + "||" + s;
        if (!m.has(key)) m.set(key, { count: 0, capacity: 0 });
        const e = m.get(key);
        e.count++;
        if (d.types.includes("capacitydata")) e.capacity++;
      }
    }
  }
  return m;
}

// Draw state/province polygons (only those with data) on top of the countries.
// They live in a dedicated pane above the country pane, so hovering a country never
// hides them and we never have to reorder layers on hover (which breaks tooltips).
function buildAdmin1(admin1) {
  MAP.createPane("admin1");
  MAP.getPane("admin1").style.zIndex = 450; // country overlayPane is 400, markers 600
  const renderer = L.svg({ pane: "admin1" });
  const feats = admin1.features.map(fixAntimeridian);
  SUB_LAYER = L.geoJSON({ type: "FeatureCollection", features: feats }, {
    pane: "admin1",
    renderer,
    style: (f) => {
      const data = SUBREGION_DATA.get(f.properties.country + "||" + f.properties.name);
      return {
        fillColor: coverageColor(data ? data.count : 0),
        fillOpacity: 0.95,
        color: "rgba(255,255,255,0.42)",   // brighter hairline marks a sub-unit boundary
        weight: 0.7,
        dashArray: "2 2",
      };
    },
    onEachFeature: (f, layer) => {
      const { country, name } = f.properties;
      const key = country + "||" + name;
      SUB_LAYER_BY_KEY.set(key, layer);
      const data = SUBREGION_DATA.get(key);
      layer.on({
        mouseover: () => layer.setStyle({ weight: 1.4, color: "rgba(255,255,255,0.8)", dashArray: null }).bringToFront(),
        mouseout:  () => SUB_LAYER.resetStyle(layer),
        click:     (e) => { L.DomEvent.stop(e); selectSubregion(country, name); },
      });
      layer.bindTooltip(`${name} · ${data ? data.count : 0}`, { sticky: true, className: "lf-tip", opacity: 0.9 });
    },
  }).addTo(MAP);
}

function styleFor(f, dataByName) {
  const p = dataByName.get(f.properties.name);
  const n = p ? p.count : 0;
  return {
    fillColor: coverageColor(n),
    fillOpacity: p ? 0.92 : 0.5,
    color: "rgba(255,255,255,0.10)",
    weight: 0.6,
  };
}

let SELECTED = null, SELECTED_SUB = null;

function clearSubSelection() {
  if (SELECTED_SUB && SUB_LAYER) { SUB_LAYER.resetStyle(SELECTED_SUB); SELECTED_SUB = null; }
}

function selectCountry(name, opts = {}) {
  const layer = LAYER_BY_NAME.get(name);
  if (SELECTED && LAYER) LAYER.resetStyle(SELECTED);
  SELECTED = layer || null;
  clearSubSelection();
  if (layer) {
    layer.setStyle({ color: "#3987e5", weight: 2 }).bringToFront();
    if (opts.fly) MAP.flyToBounds(layer.getBounds().pad(0.4), { maxZoom: 4, duration: 0.6 });
  }
  renderPanel(name, opts.scrollTo);
}

// Clicking a state/province: highlight it and open its country's panel scrolled to
// that state's section.
function selectSubregion(country, name, opts = {}) {
  const layer = SUB_LAYER_BY_KEY.get(country + "||" + name);
  if (SELECTED && LAYER) { LAYER.resetStyle(SELECTED); SELECTED = null; }
  clearSubSelection();
  SELECTED_SUB = layer || null;
  if (layer) {
    layer.setStyle({ color: "#9085e9", weight: 2.2, dashArray: null }).bringToFront();
    if (opts.fly) MAP.flyToBounds(layer.getBounds().pad(0.6), { maxZoom: 5, duration: 0.6 });
  }
  renderPanel(country, name);
}

/* ---------------- panel ---------------- */
function renderPanel(name, scrollToSub) {
  const f = FEATURE_BY_NAME.get(name);
  const panel = document.getElementById("panel");
  const body = panel.querySelector(".body");
  if (!f) return;
  const p = f.properties;

  panel.querySelector(".title").textContent = name;
  const capTxt = p.capacity ? ` · ${p.capacity} with capacity data` : "";
  panel.querySelector(".sub").textContent = `${p.count} resource${p.count === 1 ? "" : "s"}${capTxt}`;

  // type chips (only types present), ordered
  const typebar = panel.querySelector(".typebar");
  typebar.innerHTML = "";
  TYPE_ORDER.filter((t) => p.types.includes(t)).forEach((t) => {
    const c = document.createElement("span");
    c.className = "chip";
    c.innerHTML = `<span class="dot" style="background:${TYPES[t].color}"></span>${TYPES[t].label}`;
    typebar.appendChild(c);
  });

  // group datasets: national first, then by subregion
  const national = [];
  const bySub = new Map();
  for (const d of p.datasets) {
    if (d.subregions && d.subregions.length) {
      for (const s of d.subregions) {
        if (!bySub.has(s)) bySub.set(s, []);
        bySub.get(s).push(d);
      }
    } else {
      national.push(d);
    }
  }

  body.innerHTML = "";
  if (national.length) {
    body.appendChild(groupHeader(bySub.size ? "National" : `${national.length} resources`));
    national.forEach((d) => body.appendChild(card(d)));
  }
  [...bySub.keys()].sort((a, b) => a.localeCompare(b)).forEach((sub) => {
    const h = groupHeader(sub);
    h.dataset.sub = sub;
    body.appendChild(h);
    bySub.get(sub).forEach((d) => body.appendChild(card(d)));
  });

  panel.classList.add("open");
  if (scrollToSub) {
    const el = body.querySelector(`[data-sub="${cssEscape(scrollToSub)}"]`);
    if (el) el.scrollIntoView({ block: "start", behavior: "smooth" });
  } else {
    body.scrollTop = 0;
  }
}

function groupHeader(text) {
  const h = document.createElement("div");
  h.className = "group-h";
  h.textContent = text;
  return h;
}

function card(d) {
  const a = document.createElement("a");
  a.className = "card";
  a.href = d.url; a.target = "_blank"; a.rel = "noopener";
  const primary = TYPE_ORDER.find((t) => d.types.includes(t)) || "other";
  a.style.borderLeftColor = TYPES[primary].color;

  const tags = d.types
    .sort((x, y) => TYPE_ORDER.indexOf(x) - TYPE_ORDER.indexOf(y))
    .map((t) => `<span class="tag" style="background:${TYPES[t].color}">${TYPES[t].label}</span>`)
    .join("");

  const src = d.source || sourceCategory(d.url);
  const bits = [];
  if (d.year) bits.push(`<span class="yr">${d.year}</span>`);
  bits.push(`<span class="src" title="${src.label}"><span class="sdot"></span><span class="host">${d.host || ""}</span></span>`);
  if (d.licence) bits.push(`<span class="lic">${escapeHtml(d.licence)}</span>`);

  a.innerHTML = `
    <div class="ct">${escapeHtml(d.title)}</div>
    <div class="cmeta">
      <span class="tags">${tags}</span>
      ${bits.join('<span style="opacity:.4">·</span>')}
    </div>`;
  return a;
}

/* ---------------- header, legend, search ---------------- */
function buildStats(geojson) {
  const countries = geojson.features.length;
  const datasets = geojson.features.reduce((s, f) => s + f.properties.count, 0);
  const capacity = geojson.features.reduce((s, f) => s + f.properties.capacity, 0);
  setStat("s-countries", countries);
  setStat("s-datasets", datasets);
  setStat("s-capacity", capacity);
}
function setStat(id, n) { document.getElementById(id).textContent = n.toLocaleString(); }

function buildLegend() {
  const types = document.getElementById("legend-types");
  TYPE_ORDER.forEach((t) => {
    const row = document.createElement("div");
    row.className = "type";
    const round = t === "capacitydata" ? " cap" : "";
    row.innerHTML = `<span class="dot${round}" style="background:${TYPES[t].color}"></span>${TYPES[t].label}`;
    types.appendChild(row);
  });
  const cov = document.getElementById("legend-cov");
  [...COVERAGE].reverse().forEach((b) => {
    const sw = document.createElement("span");
    sw.className = "sw"; sw.style.background = b.color;
    cov.appendChild(sw);
  });
}

function buildSearchIndex(geojson) {
  REGION_INDEX = [];
  for (const f of geojson.features) {
    const p = f.properties;
    REGION_INDEX.push({ name: p.name, country: p.name, count: p.count, kind: "country" });
    const subs = new Map();
    for (const d of p.datasets) for (const s of (d.subregions || [])) subs.set(s, (subs.get(s) || 0) + 1);
    for (const [s, c] of subs) REGION_INDEX.push({ name: s, country: p.name, count: c, kind: "sub" });
  }
  REGION_INDEX.sort((a, b) => b.count - a.count);
}

function wireUI() {
  const input = document.getElementById("search");
  const results = document.getElementById("results");
  let active = -1, shown = [];

  const render = (q) => {
    const norm = q.trim().toLowerCase();
    shown = norm
      ? REGION_INDEX.filter((r) =>
          r.name.toLowerCase().includes(norm) ||
          (r.kind === "sub" && r.country.toLowerCase().includes(norm))).slice(0, 40)
      : REGION_INDEX.slice(0, 12);
    active = -1;
    results.innerHTML = shown.map((r, i) =>
      `<div class="r" data-i="${i}">
        <span>${escapeHtml(r.name)}${r.kind === "sub" ? ` <span class="sub">${escapeHtml(r.country)}</span>` : ""}</span>
        <span class="cnt">${r.count}</span>
      </div>`).join("");
    results.classList.toggle("open", shown.length > 0);
  };

  const choose = (r) => {
    input.value = "";
    results.classList.remove("open");
    input.blur();
    if (r.kind === "sub" && SUB_LAYER_BY_KEY.has(r.country + "||" + r.name)) {
      selectSubregion(r.country, r.name, { fly: true });
    } else if (r.kind === "sub") {
      selectCountry(r.country, { fly: true, scrollTo: r.name }); // panel-only subregion (no polygon)
    } else {
      selectCountry(r.country, { fly: true });
    }
  };

  input.addEventListener("input", () => render(input.value));
  input.addEventListener("focus", () => render(input.value));
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { active = Math.min(active + 1, shown.length - 1); markActive(); e.preventDefault(); }
    else if (e.key === "ArrowUp") { active = Math.max(active - 1, 0); markActive(); e.preventDefault(); }
    else if (e.key === "Enter" && shown[active]) { choose(shown[active]); }
    else if (e.key === "Escape") { results.classList.remove("open"); input.blur(); }
  });
  const markActive = () => {
    [...results.children].forEach((el, i) => el.classList.toggle("active", i === active));
    results.children[active]?.scrollIntoView({ block: "nearest" });
  };
  results.addEventListener("mousedown", (e) => {
    const el = e.target.closest(".r"); if (!el) return;
    choose(shown[+el.dataset.i]);
  });
  document.addEventListener("click", (e) => {
    if (!e.target.closest(".search")) results.classList.remove("open");
  });

  document.querySelector(".panel .close").addEventListener("click", () => {
    document.getElementById("panel").classList.remove("open");
    if (SELECTED && LAYER) { LAYER.resetStyle(SELECTED); SELECTED = null; }
    clearSubSelection();
  });

  document.getElementById("download").addEventListener("click", () => {
    const blob = new Blob([JSON.stringify(GEOJSON, null, 2)], { type: "application/geo+json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "grid-datasets.geojson";
    a.click();
    URL.revokeObjectURL(a.href);
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "/" && document.activeElement !== input) { input.focus(); e.preventDefault(); }
    if (e.key === "Escape") document.getElementById("panel").classList.remove("open");
  });
}

/* ---------------- utils ---------------- */
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function cssEscape(s) { return String(s).replace(/["\\]/g, "\\$&"); }

boot().catch((err) => {
  console.error(err);
  const l = document.getElementById("loading");
  l.innerHTML = `<div style="max-width:340px;text-align:center">Failed to load data.<br><span style="color:#898781">${escapeHtml(err.message)}</span></div>`;
});
