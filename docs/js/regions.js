// regions.js — lookup tables shared by the parser and the app.
// Keeps the parser small: it only holds *logic*, these hold *data*.

// Categorical colours for dataset TYPES (validated dark-mode palette, dataviz skill).
// Deliberately clear of the COVERAGE choropleth ramp (regions.js's coverageColor
// buckets run violet -> plum -> red -> orange -> gold) — the two palettes appear
// side by side on the map, so sharing a hue there read as "the type color means
// the same thing as the fill color". Worst all-pairs CVD ΔE 13.7 (protan),
// checked against COVERAGE too, not just internally.
export const TYPES = {
  capacitydata: { label: "Capacity data", color: "#0891b2" }, // cyan — the repo's focus
  map:          { label: "Map",           color: "#3987e5" }, // blue
  dataset:      { label: "Dataset",       color: "#199e70" }, // teal
  report:       { label: "Report",        color: "#16a34a" }, // green
  other:        { label: "Other",         color: "#b25689" }, // rose
};
export const TYPE_ORDER = ["capacitydata", "map", "dataset", "report", "other"];

// Raw README tag token -> normalised type key. Anything not here that also isn't a
// year or a licence is dropped (it's descriptive noise).
export const TYPE_TOKENS = {
  map: "map", maps: "map",
  dataset: "dataset", datasets: "dataset", data: "dataset", "gis map": "dataset", gis: "dataset",
  report: "report",
  capacitydata: "capacitydata", capacity: "capacitydata",
  project: "other", interconnector: "other", sld: "other", "unifilar diagram": "other",
};

// Tokens that look like a licence (kept as metadata, never a type).
export const LICENCE_RE = /(cc[\s-]?(by|0|zero)|cc0|odbl|odc|mit|gpl|agpl|apache|open\s?data|open\s?government|open\s?access|proprietary|dl-de|public\s?domain|licence|license|ogl|nged)/i;

// README country string (loose-normalised) -> Natural Earth name used in the topojson.
// Only entries that differ from an exact match are listed.
export const COUNTRY_ALIASES = {
  "us": "United States of America",
  "united states": "United States of America",
  "usa": "United States of America",
  "democratic republic of the congo": "Dem. Rep. Congo",
  "dr congo": "Dem. Rep. Congo",
  "republic of the congo": "Congo",
  "congo": "Congo",
  "bosnia herzegovina": "Bosnia and Herz.",
  "bosnia and herzegovina": "Bosnia and Herz.",
  "north macedonia": "Macedonia",
  "dominican republic": "Dominican Rep.",
  "dominican rep": "Dominican Rep.",
  "eswatini": "eSwatini",
  "swaziland": "eSwatini",
  "vanatu": "Vanuatu",
  "czech republic": "Czechia",
  "ivory coast": "Côte d'Ivoire",
};

// First-group tokens that are cross-border regions, not a single country.
// They are still browsable (bucketed under "Cross-border"), just not on the choropleth.
export const REGIONAL_TOKENS = new Set([
  "central america", "central asia", "mekong region", "south east asia",
  "country or region", "western balkans", "south east asia",
]);

// Subregion display fixes (typos / accents in the README). Multi-state tokens are
// split on ; and , upstream, so these are single names.
export const SUBREGION_FIX = {
  "delphi": "Delhi",
  "jharkand": "Jharkhand",
  "madhya pradesh": "Madhya Pradesh",
  "quebec": "Québec",
};

// Loose key: lowercase, strip accents, non-alphanumerics -> space, collapse.
export function looseKey(s) {
  return s
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// Domain -> source category. The "official information from the domain name".
export function sourceCategory(url) {
  let host = "";
  try { host = new URL(url).hostname.toLowerCase().replace(/^www\./, ""); }
  catch { return { key: "other", label: "Other", host: "" }; }

  const is = (re) => re.test(host);
  let key, label;
  if (is(/(^|\.)gov(\.|$)|\.gouv\.|(^|\.)gob\.|\.go\.[a-z]{2}(\.|$)|(^|\.)govt(\.|$)|europa\.eu$|\.gc\.ca$|(^|\.)mil(\.|$)|\.gouv\b/)) {
    key = "gov"; label = "Government";
  } else if (is(/(^|\.)(zenodo|arxiv|researchgate|nature|mdpi|sciencedirect|link\.springer|springeropen|iopscience|osti|semanticscholar|scribd)\.|\.edu(\.|$)|uni-[a-z]+\.de/)) {
    key = "academic"; label = "Academic";
  } else if (is(/energydata\.info|opendatasoft|arcgis\.com|kaggle\.com|data\.gov|(^|\.)opendata\.|geonode|databasin\.org|opendata\.swiss|dados\.gov|datos\.gob|huggingface\.co|(^|\.)open\.[a-z]+|hub\.arcgis|data-transpower/)) {
    key = "opendata"; label = "Open data";
  } else if (is(/web\.archive\.org/)) {
    key = "archive"; label = "Archived";
  } else {
    key = "operator"; label = "Operator / TSO";
  }
  return { key, label, host };
}
