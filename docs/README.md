# Grid Data Explorer

An interactive map with two views over the same world:

- **Data coverage** — the datasets in the root [`README.md`](../README.md) by
  **country, state and province**. Click a region to see links to every available
  resource; each is colour-coded by dataset type.
- **Grid length** — the MapYourGrid [Global Grid Length
  Database](https://docs.google.com/spreadsheets/d/1qmVIQ2_ynVVfbTWcMXJQWb4Sq0Dq-1fu8zgZ9J_0cZI/edit):
  how many kilometres of 50 kV+ line each country actually has, with a ranked table,
  a metric selector and per-country voltage breakdowns.

The switch is in the top bar, and the view is shareable: `?view=length&metric=density`.

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
                                                                            ▲
../data/grid-length.csv ──▶ scripts/build_grid_length.mjs ──▶ data/grid-length.json
 (committed snapshot of        (also measures each country's
  the Google Sheet)             area from the topojson)
```

The Google Sheet is fetched by a **separate, manual** step
(`scripts/fetch_grid_length.mjs`) that only writes the CSV snapshot. Nothing in CI
touches the network, and every data change arrives as a reviewable diff.

- **`js/parser.js`** — the parser. It reads the awesome-list markdown, pulls each
  `* (Country)(State) [Title](url) (year) (licence) (type…)` entry apart into a
  record, classifies the trailing tags into **year / licence / type**, derives the
  **source category from the domain** (government, operator/TSO, open-data,
  academic, archived), and resolves each region to a Natural Earth country polygon.
  `resolveGeoJSON()` emits one GeoJSON feature per country with all its datasets
  attached. It has no browser dependencies, so it runs unmodified in Node.
- **`js/regions.js`** — lookup tables (type colours, country-name aliases, domain
  rules). Keeps the parser logic small.
- **`js/geo.js`** — geometry helpers shared between the build scripts and the
  browser (also pure, no browser dependencies): the antimeridian unwrap, the
  representative-point scanline used to place capacity dots, and
  `polygonAreaKm2()`, the spherical-excess area used for grid density. That last one
  **must** be called on an unwrapped feature — on raw NE 110m, Russia's ±180° rings
  cancel and it measures 37% small.
- **`js/length.js`** — everything that turns the grid-length data into pixels, minus
  the map: the colour ramp, the three metrics and their breaks, the ranking table,
  the panel's stacked voltage bar and the CSV export. Pure functions and DOM out; no
  Leaflet, no state. `js/app.js` owns the state and calls in here.
- **`scripts/fetch_grid_length.mjs`** / **`scripts/build_grid_length.mjs`** — the
  grid-length pipeline. See *Grid length* below.
- **`scripts/build_data.mjs`** — the build step. Runs `parser.js` against the root
  `README.md` and writes `docs/data/grid-datasets.geojson`, with each feature's
  `geometry` stripped (the browser already fetches the full polygons in compact
  topojson form for the base map layer, so shipping them twice would ~3x the
  payload for no reason).
- **`js/app.js`** — fetches `data/grid-datasets.geojson` + `data/countries-110m.json`,
  re-attaches each feature's geometry by country name once at boot (a cheap merge,
  not a re-parse), then renders the choropleth (shaded by resources per country),
  drops a cyan dot on countries — and, individually, on states/provinces — that
  publish **capacity data**, and builds the click-through detail panel, search, and
  the two dataset exports (**↓ Download Grid Data Sources**, CC0, and
  **↓ Download Global Transmission Length Index**, CC BY 4.0 — separate buttons with
  separate licence badges, because overloading one button behind the view toggle
  would be a licensing footgun). The dots live in their own map pane above the
  country and admin1 panes so they're never buried by a hover highlight. It also owns
  the coverage/length mode switch: `countryStyle()` and `tooltipText()` branch on the
  current mode, and `restyleCountries()` repaints the layer and reapplies the
  selected-country outline (`setStyle` wipes it). If `data/grid-length.json` is
  missing or unreadable the whole length feature hides itself and the page is exactly
  the coverage explorer it was before.

### Colours

Dataset **types** use a colourblind-safe categorical palette (validated with the
`dataviz` skill):

| Type | Colour |
|------|--------|
| Capacity data | cyan `#0891b2` |
| Map | blue `#3987e5` |
| Dataset | teal `#199e70` |
| Report | green `#16a34a` |
| Other (project, interconnector, SLD…) | rose `#b25689` |

`TYPES` in `js/regions.js` is the source of truth — chips and dots take their colour
inline from JS. The `--t-*` custom properties in `css/style.css` mirror it.

Country shading uses **two** ramps, one per view, deliberately in different hue
families. Coverage (resources per country) runs violet → plum → red → orange → gold;
grid length is a single-hue aqua ramp (`LENGTH_RAMP` in `js/length.js`,
`--len-1…6` in the CSS). Same colours for both would make a screenshot of one view
indistinguishable from the other, since the legend is the only other cue. The aqua
ramp has strictly monotone OKLCH lightness (0.334 → 0.858, every adjacent gap
≥ 0.100) and a worst all-pairs ΔE of 9.4 across normal, protan, deutan and tritan
vision — checked over all 15 pairs, because a choropleth is an all-pairs form.

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

## Grid length

The **Grid length** view renders the MapYourGrid *Global Grid Length Database* — a
public Google Sheet, CC BY 4.0 — covering transmission lines at **50 kV and above**,
overhead lines and cables, for 195 countries. 131 of them currently have a total.

### Refreshing it

```bash
npm run fetch:length     # downloads the sheet to ../data/grid-length.csv
git diff data/grid-length.csv   # review — this is the whole point of the snapshot
npm run build:length     # -> docs/data/grid-length.json + the root README table
```

`fetch:length` is the only step that touches the network, it is never run in CI, and
it refuses to write if the sheet's header row no longer starts `Countries,Found,
Circuit`. `build:length` is pure: it resolves every column **by header name** (never
by index, so an inserted voltage column is reported rather than silently shifting the
rest), logs anything it can't resolve, and takes `--check` to verify the committed
artifacts match the CSV without writing.

`build:length` also rewrites the top-25 table between the
`<!-- GRID-LENGTH-TABLE:start -->` / `:end` markers in the root `README.md`. If the
markers are missing it warns and leaves the file alone.

### Data rules worth knowing before you touch the numbers

- **A zero is not always a zero.** Twelve rows report `Total = 0`. Ten are
  `Found = No` — nobody has researched them yet — and become `null`; two are
  `Found = Yes` with a note (Dominica *"0km for now above 50kv"*, Somalia *"Does not
  yet have 50kv+"*) and stay a real `0`. Without that gate the map claims North Korea
  has no transmission grid, in the same colour as a country that genuinely has none.
- **Route length and circuit length are not comparable**, and the sheet records which
  one it is for only 56 of 195 countries. Hence the permanent caveat in the rail head
  and the *Circuit / Route / unspecified* chip in each country panel.
- **The voltage bar is never normalised to 100%.** 16 countries publish a total with
  no breakdown at all (China, the US, Russia, Canada, Germany, Saudi Arabia) and 11
  more publish a partial one (Italy accounts for 33% of its total, the UAE 29%). The
  remainder renders as an explicit grey *"not broken out"* segment.
- **The nine range columns stay ranges.** Spain reports 22,656 km as `30kv-132kv` — a
  third of its national total — so those become hatched `bands` segments labelled with
  the literal range, not filed under a single tier.
- **Grid density is suppressed below 25,000 km².** Areas come from the NE 110m
  polygons: median error 1.8%, everything over ~250,000 km² within 4%, but Trinidad
  and Tobago is +51% and Cyprus −33% (NE splits Northern Cyprus off). It is also
  *total* area — inland water included, and any overseas territory the basemap
  attaches to the country, which understates France by ~17%.
- **Seven countries have length data but no 110m polygon** — Bahrain (1,923 km),
  Mauritius, Barbados, Malta, Andorra, Cabo Verde, Dominica. They stay in the ranking
  table, marked *table only*, and are excluded from the choropleth. Upgrading the
  basemap to NE 50m would ~5× a 108 KB file for seven rows.

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
  fixes in `SUBREGION_FIX`. Add an entry there if a new region doesn't light up —
  the same alias table serves both the README and the grid-length sheet, and both
  build scripts log every name they couldn't resolve.
- The **Grid length** view hides the dashed state/province polygons and the capacity
  dots: there is no sub-national length data, so leaving them up would put two
  different datasets in one frame.
- 22 countries in the grid-length sheet have no 110m polygon *and* no data — the
  Caribbean and Pacific micro-states, Singapore, Monaco, San Marino, Liechtenstein,
  the Vatican. Expected, and reported separately from real alias failures.
