# Grid Data Explorer

An interactive map for browsing the datasets in the root
[`README.md`](../README.md) by **country, state and province**. Click a region to
see links to every available resource; each is colour-coded by dataset type.

**Live site:** enable GitHub Pages (see below), then open
`https://<owner>.github.io/Awesome-Electrical-Grid-Mapping/`.

## How it works

Parsing the README happens **once, at deploy time** — not in every visitor's
browser. A Node script runs the same parser ahead of time and writes its output as
a static file that the page just fetches.

```
                    ── build time (CI, or by hand) ──          ── every page load ──
README.md ──▶ scripts/build_data.mjs ──▶ data/grid-datasets.geojson ──▶ js/app.js
              (imports js/parser.js,       (properties only;                │
               the "small parser")          geometry stripped)              ▼
                                                                    js/app.js merges
 data/countries-110m.json (world polygons, fetched either way) ──▶ in geometry, renders
```

- **`js/parser.js`** — the parser. It reads the awesome-list markdown, pulls each
  `* (Country)(State) [Title](url) (year) (licence) (type…)` entry apart into a
  record, classifies the trailing tags into **year / licence / type**, derives the
  **source category from the domain** (government, operator/TSO, open-data,
  academic, archived), and resolves each region to a Natural Earth country polygon.
  `resolveGeoJSON()` emits one GeoJSON feature per country with all its datasets
  attached. It has no browser dependencies, so it runs unmodified in Node.
- **`js/regions.js`** — lookup tables (type colours, country-name aliases, domain
  rules). Keeps the parser logic small.
- **`js/geo.js`** — the antimeridian-unwrap helper, shared between the build script
  and the browser (also pure, no browser dependencies).
- **`scripts/build_data.mjs`** — the build step. Runs `parser.js` against the root
  `README.md` and writes `docs/data/grid-datasets.geojson`, with each feature's
  `geometry` stripped (the browser already fetches the full polygons in compact
  topojson form for the base map layer, so shipping them twice would ~3x the
  payload for no reason).
- **`js/app.js`** — fetches `data/grid-datasets.geojson` + `data/countries-110m.json`,
  re-attaches each feature's geometry by country name once at boot (a cheap merge,
  not a re-parse), then renders the choropleth (shaded by resources per country),
  drops a violet dot on countries — and, individually, on states/provinces — that
  publish **capacity data**, and builds the click-through detail panel and search.
  The dots live in their own map pane above the country and admin1 panes so they're
  never buried by a hover highlight. That same merged object (properties +
  geometry) is what the **↓ GeoJSON** button downloads.

### Colours

Dataset **types** use a colourblind-safe categorical palette (validated with the
`dataviz` skill):

| Type | Colour |
|------|--------|
| Capacity data | violet `#9085e9` |
| Map | blue `#3987e5` |
| Dataset | aqua `#199e70` |
| Report | orange `#d95926` |
| Other (project, interconnector, SLD…) | magenta `#d55181` |

Country shading is a single-hue blue ramp by number of resources.

## Run locally

```bash
cd docs
python3 -m http.server 8000
# open http://localhost:8000
```

### Where the data comes from

The page fetches `data/grid-datasets.geojson` directly — it does **not** parse
`README.md` in the browser. That file is a build artifact, committed to the repo
like `data/admin1.geojson`, so a plain `python3 -m http.server` works with no build
step.

After editing the root `README.md`, regenerate it before your changes show up:

```bash
npm install   # once, installs topojson-client
node scripts/build_data.mjs
```

The GitHub Actions deploy (`.github/workflows/pages.yml`) runs this same command on
every push to `main`, so the published site is always parsed fresh from whatever
`README.md` was just pushed — visitors never trigger a parse themselves.

## Enable GitHub Pages

Either:

1. **GitHub Actions** *(recommended)* — Settings → Pages → Source =
   *GitHub Actions*. The included `.github/workflows/pages.yml` deploys `docs/`
   on every push to `main`.
2. **Branch** — Settings → Pages → Source = *Deploy from a branch* →
   `main` / `/docs`.

## States & provinces

Subregions that appear in the README (US states, Canadian provinces, Indian states,
Australian states) are drawn as **clickable dashed polygons on top of their
country**, shaded by their own resource count. Their geometry lives in
`data/admin1.geojson` — a compact, coordinate-rounded slice of Natural Earth 50m
admin-1, containing *only* the units that have data (~34 of them, ~150 KB).

Regenerate it whenever new subregions are added to the README:

```bash
node scripts/build_admin1.mjs
```

The script parses the README for `(Country) (State)` entries, pulls the matching
admin-1 polygons, and reports anything it couldn't match.

## Notes / limitations

- A subregion with no admin-1 polygon in the source (currently only *Northern
  Ireland* — absent from NE 50m) stays grouped inside its country's panel rather
  than drawn on the map.
- Regional/cross-border entries with no single country (e.g. *Central Asia*) and
  countries missing from the 110m dataset (e.g. *Malta*) aren't drawn on the map
  but are otherwise parsed.
- Country matching lives in `COUNTRY_ALIASES` in `js/regions.js`; subregion typo
  fixes in `SUBREGION_FIX`. Add an entry there if a new region doesn't light up.
