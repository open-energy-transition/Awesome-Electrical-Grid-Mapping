// app.js — wires the precomputed dataset to a Leaflet map + detail panel.
// The README is parsed once at deploy time (scripts/build_data.mjs), not on every
// visit — this just fetches the resulting GeoJSON and renders it.
import { TYPES, TYPE_ORDER, sourceCategory } from "./regions.js";
import { fixAntimeridian, representativePoint, mainlandBounds } from "./geo.js";
import {
  buildLengthIndex, lengthStats, lengthColor, formatKm, METRICS, METRIC_ORDER,
  renderLengthLegend, renderRankHead, renderRankBody, sortRows, renderLengthSection,
  lengthCsv,
} from "./length.js";

const GEOJSON_URL = "./data/grid-datasets.geojson";
const TOPO_URL = "./data/countries-110m.json";
const ADMIN1_URL = "./data/admin1.geojson";
const LENGTH_URL = "./data/grid-length.json";

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

function capDot(latlng) {
  const c = TYPES.capacitydata.color;
  return L.circleMarker(latlng, {
    pane: "capdots",
    radius: 3.4, color: c, weight: 0, fillColor: c,
    fillOpacity: 0.95, interactive: false,
  });
}

let MAP, LAYER, CAP_LAYER, SUB_LAYER, SUB_CAP_LAYER;
let HOVERED = null, HOVERED_SUB = null;
let FEATURE_BY_NAME = new Map();
let LAYER_BY_NAME = new Map();
let SUB_LAYER_BY_KEY = new Map();   // "country||sub" -> leaflet layer
let SUBREGION_DATA = new Map();     // "country||sub" -> { count, capacity }
let REGION_INDEX = []; // {name, country, count, km, kind}
let GEOJSON = null;
let WORLD_BY_NAME = new Map();      // NE name -> world feature (geometry source)
let DATA_BY_NAME = new Map();       // NE name -> grid-datasets properties

// Which dataset the choropleth encodes. "coverage" = resources per country (the
// original view), "length" = the MapYourGrid grid-length database. LENGTH is null when
// data/grid-length.json is absent, and then the whole feature hides itself.
let MODE = "coverage";
let METRIC = "total";               // total | kv220 | density (see METRICS in length.js)
let LENGTH = null;                  // { byName, rows, meta }
let RANK_SORT = { key: "total", dir: -1 };
let COVERAGE_STATS = [];
let RERENDER_SEARCH = () => {};     // set by wireUI — the .cnt column is mode-dependent

async function boot() {
  // grid-length.json is optional on purpose: if it 404s the site is byte-for-byte the
  // coverage explorer it was before, rather than a broken map.
  const [geojson, topoRes, admin1, lengthJson] = await Promise.all([
    fetch(GEOJSON_URL, { cache: "no-store" }).then((r) => r.json()),
    fetch(TOPO_URL).then((r) => r.json()),
    fetch(ADMIN1_URL).then((r) => r.ok ? r.json() : null).catch(() => null),
    fetch(LENGTH_URL).then((r) => r.ok ? r.json() : null).catch(() => null),
  ]);

  const world = topojson.feature(topoRes, topoRes.objects.countries);
  const worldFeatures = world.features
    .filter((f) => f.properties.name !== "Antarctica")
    .map(fixAntimeridian);

  // geojson ships with geometry stripped (see build_data.mjs) — re-attach it from
  // the topojson we already fetched instead of shipping every polygon twice.
  WORLD_BY_NAME = new Map(worldFeatures.map((f) => [f.properties.name, f]));
  for (const f of geojson.features) f.geometry = WORLD_BY_NAME.get(f.properties.name)?.geometry ?? null;
  GEOJSON = geojson;
  LENGTH = lengthJson ? buildLengthIndex(lengthJson) : null;

  for (const f of geojson.features) FEATURE_BY_NAME.set(f.properties.name, f);
  DATA_BY_NAME = new Map(geojson.features.map((f) => [f.properties.name, f.properties]));
  SUBREGION_DATA = buildSubregionIndex(geojson);

  buildMap(worldFeatures);
  if (admin1) buildAdmin1(admin1);
  buildStats(geojson);
  buildLegend();
  buildSearchIndex(geojson);
  wireUI();
  wireLengthUI();

  document.getElementById("loading").classList.add("hidden");
}

// Initial world extent — a fixed frame, not LAYER.getBounds(), whose Russia tail
// reaches ~190°E after the antimeridian unwrap and would skew the view.
const WORLD_VIEW = [[-58, -175], [78, 179]];

function buildMap(worldFeatures) {
  MAP = L.map("map", {
    crs: L.CRS.EPSG4326,
    minZoom: 1, maxZoom: 6,
    zoomControl: false,
    attributionControl: false,
    worldCopyJump: false,
    zoomSnap: 0.25,
  });
  L.control.zoom({ position: "bottomright" }).addTo(MAP);

  // Reset-view button, stacked with the zoom control
  const home = L.control({ position: "bottomright" });
  home.onAdd = () => {
    const div = L.DomUtil.create("div", "leaflet-bar leaflet-control");
    const a = L.DomUtil.create("a", "home-btn", div);
    a.href = "#";
    a.title = "Reset view";
    a.setAttribute("role", "button");
    a.setAttribute("aria-label", "Reset view to the whole world");
    a.innerHTML = `<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true">
      <path d="M12 3.2 3 11h2.5v9.8h5.3v-6h2.4v6h5.3V11H21z"/></svg>`;
    L.DomEvent.on(a, "click", (e) => {
      L.DomEvent.stop(e);
      MAP.flyToBounds(WORLD_VIEW, { padding: [8, 8], duration: 0.6 });
    });
    return div;
  };
  home.addTo(MAP);

  // Safety net: if the cursor leaves the map faster than a per-layer mouseout
  // fires (or a browser drops it after the bringToFront DOM reorder above),
  // this guarantees any stuck hover highlight still gets cleared.
  MAP.getContainer().addEventListener("mouseleave", () => {
    if (HOVERED) { LAYER.resetStyle(HOVERED); HOVERED.closeTooltip(); HOVERED = null; }
    if (HOVERED_SUB && SUB_LAYER) { SUB_LAYER.resetStyle(HOVERED_SUB); HOVERED_SUB.closeTooltip(); HOVERED_SUB = null; }
  });

  LAYER = L.geoJSON({ type: "FeatureCollection", features: worldFeatures }, {
    // A named module-scope function, not a closure over the data: resetStyle() re-invokes
    // this option on every mouseout, so a baked-in mode would snap hovered countries
    // back to coverage colours the moment the cursor left them in length mode.
    style: countryStyle,
    onEachFeature: (f, layer) => {
      const name = f.properties.name;
      LAYER_BY_NAME.set(name, layer);
      const props = DATA_BY_NAME.get(name);
      const hasLength = !!(LENGTH && LENGTH.byName.has(name));
      layer.on({
        // bringToFront() reorders the SVG path node mid-event, which in some
        // browsers desyncs mouse tracking so the matching mouseout never fires,
        // leaving the highlight stuck — defer it a tick and rely on HOVERED as
        // a safety net (see MAP mouseleave below) instead of trusting mouseout alone.
        mouseover: () => {
          if (HOVERED && HOVERED !== layer) { LAYER.resetStyle(HOVERED); HOVERED.closeTooltip(); }
          HOVERED = layer;
          layer.setStyle({ weight: 1.2, color: "rgba(255,255,255,0.55)" });
          requestAnimationFrame(() => layer.bringToFront());
        },
        mouseout:  () => { LAYER.resetStyle(layer); layer.closeTooltip(); if (HOVERED === layer) HOVERED = null; },
        // on phones the bottom sheet would cover the tapped country — fly it
        // into the strip that stays visible; desktop keeps the map still.
        // If this country's panel is already open the click is a no-op: most of
        // a country's area belongs to states without their own polygon, so a
        // tap aimed at one would otherwise re-select the country — yanking the
        // panel scroll away from the state sections and re-flying the map.
        click:     () => {
          if ((!props && !hasLength) || panelShowing(name)) return;
          selectCountry(name, { fly: MOBILE_MQ.matches });
        },
      });
      // Bound for the union of both datasets — a country with length data but no
      // catalogued resource would otherwise hover silently in length mode. Countries
      // in neither source stay untooltipped, as before.
      if (props || hasLength) {
        layer.bindTooltip(tooltipText(name), { sticky: true, className: "lf-tip", opacity: 0.9 });
      }
    },
  }).addTo(MAP);

  // Violet dots mark capacity data — surface the repo's focus. They live in their
  // own pane above both the country fill and the admin1 pane so a hover's
  // bringToFront() (which reorders paths within *its* pane only) never buries a
  // dot under the very polygon it's centered on.
  MAP.createPane("capdots");
  MAP.getPane("capdots").style.zIndex = 460; // country overlayPane 400, admin1 450
  MAP.getPane("capdots").style.pointerEvents = "none";

  // representativePoint(), not bounds-center: France's bounds (mainland + French
  // Guiana) center in the Atlantic; the mainland's interior point stays on it.
  const capFeatures = GEOJSON.features.filter((f) => f.properties.capacity > 0);
  CAP_LAYER = L.layerGroup(
    capFeatures.map((f) => {
      const pt = representativePoint(f);
      return pt ? capDot([pt[1], pt[0]]) : null;
    }).filter(Boolean)
  ).addTo(MAP);

  MAP.fitBounds(WORLD_VIEW, { padding: [8, 8] });
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
        mouseover: () => {
          if (HOVERED_SUB && HOVERED_SUB !== layer) { SUB_LAYER.resetStyle(HOVERED_SUB); HOVERED_SUB.closeTooltip(); }
          HOVERED_SUB = layer;
          layer.setStyle({ weight: 1.4, color: "rgba(255,255,255,0.8)", dashArray: null });
          requestAnimationFrame(() => layer.bringToFront());
        },
        mouseout:  () => { SUB_LAYER.resetStyle(layer); layer.closeTooltip(); if (HOVERED_SUB === layer) HOVERED_SUB = null; },
        click:     (e) => {
          L.DomEvent.stop(e);
          // re-clicking the state already shown: keep the view and panel as-is
          if (SELECTED_SUB === layer && panelShowing(country)) return;
          selectSubregion(country, name, { fly: MOBILE_MQ.matches });
        },
      });
      layer.bindTooltip(`${name} · ${data ? data.count : 0}`, { sticky: true, className: "lf-tip", opacity: 0.9 });
    },
  }).addTo(MAP);

  // Same violet capacity-data dots as countries get, one per state/province that
  // has its own capacitydata resource. Lives in the "capdots" pane created in
  // buildMap(), above admin1, so it's immune to the same hover/bringToFront issue.
  SUB_CAP_LAYER = L.layerGroup(feats
    .filter((f) => SUBREGION_DATA.get(f.properties.country + "||" + f.properties.name)?.capacity > 0)
    .map((f) => representativePoint(f))
    .filter(Boolean)
    .map(([lon, lat]) => capDot([lat, lon]))).addTo(MAP);
}

function countryStyle(f) {
  const name = f.properties.name;
  if (MODE === "length" && LENGTH) {
    const rec = LENGTH.byName.get(name);
    // A sourced zero (Dominica, Somalia) is data and gets the ramp's darkest step;
    // an unresearched country is not, and gets the no-data fill.
    const has = rec && METRICS[METRIC].get(rec) !== null;
    return {
      fillColor: lengthColor(rec, METRIC),
      fillOpacity: has ? 0.92 : 0.5,
      color: "rgba(255,255,255,0.10)",
      weight: 0.6,
    };
  }
  const p = DATA_BY_NAME.get(name);
  return {
    fillColor: coverageColor(p ? p.count : 0),
    fillOpacity: p ? 0.92 : 0.5,
    color: "rgba(255,255,255,0.10)",
    weight: 0.6,
  };
}

function tooltipText(name) {
  if (MODE === "length" && LENGTH) {
    const rec = LENGTH.byName.get(name);
    const v = rec ? METRICS[METRIC].get(rec) : null;
    return v === null || v === undefined ? `${name} · no data` : `${name} · ${METRICS[METRIC].fmt(v)}`;
  }
  const p = DATA_BY_NAME.get(name);
  return `${name} · ${p ? p.count : 0}`;
}

// setStyle() wipes the selected country's outline, so it has to be reapplied here.
function restyleCountries() {
  LAYER.setStyle(countryStyle);
  LAYER_BY_NAME.forEach((layer, name) => {
    if (layer.getTooltip()) layer.setTooltipContent(tooltipText(name));
  });
  if (SELECTED) SELECTED.setStyle({ color: "#3987e5", weight: 2 }).bringToFront();
}

let SELECTED = null, SELECTED_SUB = null;
let PANEL_COUNTRY = null; // country whose datasets the open panel shows

function panelShowing(country) {
  return PANEL_COUNTRY === country &&
         document.getElementById("panel").classList.contains("open");
}

const MOBILE_MQ = window.matchMedia("(max-width: 640px)");
// Below this a 340px ranking rail and a 420px detail drawer can't share the viewport,
// so opening a country collapses the rail behind its toggle pill.
const NARROW_MQ = window.matchMedia("(max-width: 1023px)");

// The open panel hides part of the map — bottom sheet on phones, right drawer on
// desktop — so a plain flyToBounds centers the region underneath it. Fly so the
// region centers in the part of the map that stays visible (measured from the
// panel element, so it tracks the CSS).
function flyToRegion(bounds, maxZoom) {
  const panel = document.getElementById("panel");
  const rank = document.getElementById("rank");
  if (!MOBILE_MQ.matches) {
    // the ranking rail hides the left edge the same way the panel hides the right
    const leftPad = rank.classList.contains("open") ? rank.offsetWidth + 40 : 0;
    MAP.flyToBounds(bounds, {
      maxZoom, duration: 0.6,
      paddingTopLeft: [leftPad, 0],
      paddingBottomRight: [panel.offsetWidth, 0],
    });
    return;
  }
  // On phones the rail and the panel are mutually exclusive sheets, so the strip
  // arithmetic below only ever has to account for the panel.
  // The sheet + topbar cover ~85% of a phone screen, and Leaflet's padded
  // fitBounds breaks down there (the fitted zoom drops below minZoom and the
  // padding offset overshoots). Compute the view by hand instead: a zoom that
  // fits the bounds into the visible strip — but never below 2, where pixel
  // offsets stop being meaningful — then center the bounds in that strip.
  const size = MAP.getSize();
  const topbar = document.querySelector(".topbar").offsetHeight;
  const strip = Math.max(size.y - topbar - panel.offsetHeight, 60);
  const dy = size.y / 2 - (topbar + strip / 2);
  const target = (z) => MAP.unproject(MAP.project(bounds.getCenter(), z).add([0, dy]), z);
  const reachable = (z) => {
    const mb = MAP.options.maxBounds;
    if (!mb) return true;
    const y = MAP.project(target(z), z).y;
    return y - size.y / 2 >= MAP.project(mb.getNorthWest(), z).y &&
           y + size.y / 2 <= MAP.project(mb.getSouthEast(), z).y;
  };
  const fitZoom = MAP.getBoundsZoom(bounds, false, L.point(24, size.y - strip));
  let zoom = Math.min(Math.max(fitZoom, 2), maxZoom);
  // shifting a large country into the strip can push the map center past
  // maxBounds at low zoom, and Leaflet would clamp the fly-to back under the
  // sheet — zoom in until the shifted center is legal
  while (zoom < maxZoom && !reachable(zoom)) zoom += 0.5;
  MAP.flyTo(target(zoom), zoom, { duration: 0.6 });
}

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
    if (opts.fly) {
      // frame the mainland, not the full bounds — France's full bounds (mainland
      // + French Guiana) would center the fly-to on open Atlantic
      // length-only countries have no grid-datasets feature — fall back to the basemap
      const mb = mainlandBounds(FEATURE_BY_NAME.get(name) || WORLD_BY_NAME.get(name) || {});
      const bounds = mb ? L.latLngBounds([mb[1], mb[0]], [mb[3], mb[2]]) : layer.getBounds();
      flyToRegion(bounds.pad(0.4), 4);
    }
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
    layer.setStyle({ color: TYPES.capacitydata.color, weight: 2.2, dashArray: null }).bringToFront();
    if (opts.fly) flyToRegion(layer.getBounds().pad(0.6), 5);
  }
  renderPanel(country, name);
}

/* ---------------- panel ---------------- */
function renderPanel(name, scrollToSub) {
  const f = FEATURE_BY_NAME.get(name);
  const rec = LENGTH ? LENGTH.byName.get(name) : null;
  const panel = document.getElementById("panel");
  const body = panel.querySelector(".body");
  // 30-odd countries are in the length database with no catalogued resource yet — their
  // panel still has something to say, so the guard is "neither source", not "no feature".
  if (!f && !rec) return;
  PANEL_COUNTRY = name;
  const p = f ? f.properties : null;

  panel.querySelector(".title").textContent = name;
  if (p) {
    const capTxt = p.capacity ? ` · ${p.capacity} with capacity data` : "";
    panel.querySelector(".sub").textContent = `${p.count} resource${p.count === 1 ? "" : "s"}${capTxt}`;
  } else {
    panel.querySelector(".sub").textContent = "No datasets listed yet";
  }

  // type chips (only types present), ordered
  const typebar = panel.querySelector(".typebar");
  typebar.innerHTML = "";
  TYPE_ORDER.filter((t) => p && p.types.includes(t)).forEach((t) => {
    const c = document.createElement("span");
    c.className = "chip";
    c.innerHTML = `<span class="dot" style="background:${TYPES[t].color}"></span>${TYPES[t].label}`;
    typebar.appendChild(c);
  });

  // group datasets: national first, then by subregion
  const national = [];
  const bySub = new Map();
  for (const d of (p ? p.datasets : [])) {
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
  // Transmission length renders in both modes: how much grid a country has is a fact about the
  // country, not about the view.
  if (rec) body.appendChild(renderLengthSection(rec, LENGTH.meta));
  if (!p) body.appendChild(emptyState(name));
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
  // the rail and the drawer can't share a narrow viewport
  if (NARROW_MQ.matches) closeRank();
  if (scrollToSub) {
    const el = body.querySelector(`[data-sub="${cssEscape(scrollToSub)}"]`);
    if (el) el.scrollIntoView({ block: "start", behavior: "smooth" });
  } else {
    body.scrollTop = 0;
  }
}

// A country that has length data but no catalogued resources — turn the gap into an ask.
function emptyState(name) {
  const d = document.createElement("div");
  d.className = "empty";
  const url = document.getElementById("contribute").href;
  d.innerHTML = `No maps, datasets or reports for ${escapeHtml(name)} in the list yet. ` +
    `<a href="${url}" target="_blank" rel="noopener">Know one? Add it →</a>`;
  return d;
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
const STAT_IDS = ["s-countries", "s-datasets", "s-capacity"];

function buildStats(geojson) {
  COVERAGE_STATS = [
    { n: geojson.features.length.toLocaleString(), label: "Countries" },
    { n: geojson.features.reduce((s, f) => s + f.properties.count, 0).toLocaleString(), label: "Resources" },
    { n: geojson.features.reduce((s, f) => s + f.properties.capacity, 0).toLocaleString(), label: "Capacity" },
  ];
  applyStats();
}

// Both the number and its label change with the mode, so a screenshot identifies which
// view it came from even without the legend.
function applyStats() {
  const stats = MODE === "length" && LENGTH ? lengthStats(LENGTH.meta) : COVERAGE_STATS;
  STAT_IDS.forEach((id, i) => {
    const el = document.getElementById(id);
    el.textContent = stats[i].n;
    el.nextElementSibling.textContent = stats[i].label;
  });
}

function buildLegend() {
  const cov = document.getElementById("legend-cov");
  [...COVERAGE].reverse().forEach((b) => {
    const sw = document.createElement("span");
    sw.className = "sw"; sw.style.background = b.color;
    cov.appendChild(sw);
  });
}

function buildSearchIndex(geojson) {
  REGION_INDEX = [];
  const seen = new Set();
  for (const f of geojson.features) {
    const p = f.properties;
    seen.add(p.name);
    REGION_INDEX.push({
      name: p.name, country: p.name, count: p.count, kind: "country",
      km: LENGTH ? LENGTH.byName.get(p.name)?.totalKm ?? null : null,
    });
    const subs = new Map();
    for (const d of p.datasets) for (const s of (d.subregions || [])) subs.set(s, (subs.get(s) || 0) + 1);
    for (const [s, c] of subs) REGION_INDEX.push({ name: s, country: p.name, count: c, km: null, kind: "sub" });
  }
  // Countries that only appear in the length database are searchable too — otherwise
  // they'd be visible on the length choropleth but unreachable from the search box.
  if (LENGTH) {
    for (const r of LENGTH.rows) {
      if (!r.name || seen.has(r.name)) continue;
      REGION_INDEX.push({ name: r.name, country: r.name, count: 0, km: r.totalKm, kind: "country" });
    }
  }
  REGION_INDEX.sort((a, b) => b.count - a.count);
}

function wireUI() {
  const input = document.getElementById("search");
  const results = document.getElementById("results");
  let active = -1, shown = [];

  const render = (q) => {
    const norm = q.trim().toLowerCase();
    let pool = REGION_INDEX;
    // in length mode rank by line-km, so the empty-query list is the biggest grids
    if (MODE === "length" && LENGTH) {
      pool = [...REGION_INDEX].sort((a, b) => (b.km ?? -1) - (a.km ?? -1));
    }
    shown = norm
      ? pool.filter((r) =>
          r.name.toLowerCase().includes(norm) ||
          (r.kind === "sub" && r.country.toLowerCase().includes(norm))).slice(0, 40)
      : pool.slice(0, 12);
    active = -1;
    const cnt = (r) => (MODE === "length" && LENGTH ? formatKm(r.km) : String(r.count));
    results.innerHTML = shown.map((r, i) =>
      `<div class="r" data-i="${i}">
        <span>${escapeHtml(r.name)}${r.kind === "sub" ? ` <span class="sub">${escapeHtml(r.country)}</span>` : ""}</span>
        <span class="cnt">${escapeHtml(cnt(r))}</span>
      </div>`).join("");
    results.classList.toggle("open", shown.length > 0);
  };
  RERENDER_SEARCH = () => { if (results.classList.contains("open")) render(input.value); };

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
    // deliberately no auto-reopen of the ranking rail — surprise motion, and the
    // toggle pill is right there.
  });

  document.getElementById("download-csv").addEventListener("click", () => {
    const blob = new Blob([toCSV(GEOJSON)], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `grid-datasets-${dateStamp()}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "/" && document.activeElement !== input) { input.focus(); e.preventDefault(); }
    if (e.key === "Escape") document.getElementById("panel").classList.remove("open");
  });
}


/* ---------------- grid-length mode ---------------- */

function wireLengthUI() {
  if (!LENGTH) {
    // no data on the wire — hide the feature rather than offer an empty view
    for (const id of ["modeswitch", "rank", "rank-toggle", "length-download"]) {
      document.getElementById(id).hidden = true;
    }
    return;
  }

  document.getElementById("mode-coverage").addEventListener("click", () => setMode("coverage"));
  document.getElementById("mode-length").addEventListener("click", () => setMode("length"));

  document.querySelector(".metricswitch").addEventListener("click", (e) => {
    const b = e.target.closest(".mt");
    if (b) setMetric(b.dataset.metric);
  });

  const table = document.getElementById("rank-table");
  const onSort = (th) => {
    const key = th.dataset.key;
    if (!key) return;
    RANK_SORT = RANK_SORT.key === key
      ? { key, dir: -RANK_SORT.dir }
      : { key, dir: key === "name" ? 1 : -1 };
    renderRank();
  };
  table.tHead.addEventListener("click", (e) => {
    const th = e.target.closest("th.srt");
    if (th) onSort(th);
  });
  table.tHead.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const th = e.target.closest("th.srt");
    if (th) { e.preventDefault(); onSort(th); }
  });

  const pick = (tr) => {
    const ne = tr.dataset.ne;
    if (!ne || !LAYER_BY_NAME.has(ne)) return;   // .norow: real data, no polygon
    selectCountry(ne, { fly: true });
  };
  table.tBodies[0].addEventListener("click", (e) => {
    const tr = e.target.closest("tr");
    if (tr && !e.target.closest("a")) pick(tr);
  });
  table.tBodies[0].addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const tr = e.target.closest("tr");
    if (tr) { e.preventDefault(); pick(tr); }
  });

  document.querySelector(".rank-close").addEventListener("click", closeRank);
  document.getElementById("rank-toggle").addEventListener("click", openRank);

  // A second button rather than a mode-switch on the existing one: the awesome-list is
  // CC0, this database is CC BY 4.0, and each button sits next to its own badge.
  document.getElementById("download-length-csv").addEventListener("click", () => {
    const blob = new Blob([lengthCsv(LENGTH.rows, LENGTH.meta, csvField)], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `grid-length-${dateStamp()}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  });

  const attr = document.getElementById("len-attr");
  if (LENGTH.meta.dataUpdated) {
    attr.textContent = `${LENGTH.meta.license} · ${LENGTH.meta.publisher} · sheet updated ${LENGTH.meta.dataUpdated}`;
    attr.href = LENGTH.meta.sourceUrl;
  }

  const url = readUrlState();
  setMetric(url.metric, { silent: true });
  setMode(url.mode, { silent: true });
}

function setMode(mode, opts = {}) {
  if (mode === "length" && !LENGTH) return;
  MODE = mode;
  document.body.dataset.mode = mode;
  for (const [id, m] of [["mode-coverage", "coverage"], ["mode-length", "length"]]) {
    const b = document.getElementById(id);
    b.classList.toggle("is-on", m === mode);
    b.setAttribute("aria-selected", String(m === mode));
  }

  // There is no sub-national length data, so in length mode the dashed states and the
  // capacity dots would encode a different dataset than the fill beneath them.
  const overlays = [SUB_LAYER, CAP_LAYER, SUB_CAP_LAYER].filter(Boolean);
  if (mode === "length") {
    clearSubSelection();
    for (const l of overlays) if (MAP.hasLayer(l)) MAP.removeLayer(l);
    openRank();
  } else {
    for (const l of overlays) if (!MAP.hasLayer(l)) l.addTo(MAP);
    closeRank();
    document.getElementById("rank-toggle").hidden = true;
  }

  restyleCountries();
  applyStats();
  RERENDER_SEARCH();
  if (!opts.silent) writeUrlState();
}

function setMetric(metric, opts = {}) {
  METRIC = METRIC_ORDER.includes(metric) ? metric : "total";
  document.body.dataset.metric = METRIC;
  document.querySelectorAll(".metricswitch .mt").forEach((b) => {
    const on = b.dataset.metric === METRIC;
    b.classList.toggle("is-on", on);
    b.setAttribute("aria-selected", String(on));
  });
  renderLengthLegend(
    document.getElementById("legend-len"),
    document.getElementById("legend-len-labels"),
    document.getElementById("len-caveat"),
    METRIC, LENGTH.meta
  );
  RANK_SORT = { key: METRIC, dir: -1 };
  renderRank();
  if (LAYER) restyleCountries();
  RERENDER_SEARCH();
  if (!opts.silent) writeUrlState();
}

function renderRank() {
  const table = document.getElementById("rank-table");
  renderRankHead(table.tHead, RANK_SORT);
  renderRankBody(table.tBodies[0], sortRows(LENGTH.rows, RANK_SORT.key, RANK_SORT.dir), METRIC);
}

function openRank() {
  if (!LENGTH || MODE !== "length") return;
  const panelOpen = document.getElementById("panel").classList.contains("open");
  if (MOBILE_MQ.matches && panelOpen) document.getElementById("panel").classList.remove("open");
  document.getElementById("rank").classList.add("open");
  document.getElementById("rank-toggle").hidden = true;
  document.querySelector(".rank-scroll").scrollTop = 0;
}

function closeRank() {
  document.getElementById("rank").classList.remove("open");
  document.getElementById("rank-toggle").hidden = !(LENGTH && MODE === "length");
}

// Shareable state, without piling up history entries on every toggle.
function writeUrlState() {
  const q = new URLSearchParams();
  if (MODE === "length") {
    q.set("view", "length");
    if (METRIC !== "total") q.set("metric", METRIC);
  }
  history.replaceState(null, "", q.toString() ? `?${q}` : location.pathname);
}

function readUrlState() {
  const q = new URLSearchParams(location.search);
  const metric = q.get("metric");
  return {
    mode: q.get("view") === "length" ? "length" : "coverage",
    metric: METRIC_ORDER.includes(metric) ? metric : "total",
  };
}

/* ---------------- utils ---------------- */
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function cssEscape(s) { return String(s).replace(/["\\]/g, "\\$&"); }

// One row per resource: country, subregions and dataset metadata flattened out.
function toCSV(geojson) {
  const header = ["Country", "Subregions", "Title", "URL", "Types", "Year", "Licence", "Source", "Host"];
  const rows = [header];
  for (const f of geojson.features) {
    const country = f.properties.name;
    for (const d of f.properties.datasets) {
      rows.push([
        country,
        (d.subregions || []).join("; "),
        d.title,
        d.url,
        d.types.join("; "),
        d.year || "",
        d.licence || "",
        d.source ? d.source.label : "",
        d.host || "",
      ]);
    }
  }
  return rows.map((r) => r.map(csvField).join(",")).join("\r\n");
}
function csvField(v) {
  const s = String(v ?? "");
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// Local YYYY-MM-DD for the moment the export is generated.
function dateStamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

boot().catch((err) => {
  console.error(err);
  const l = document.getElementById("loading");
  l.innerHTML = `<div style="max-width:340px;text-align:center">Failed to load data.<br><span style="color:#898781">${escapeHtml(err.message)}</span></div>`;
});
