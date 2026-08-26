// fetch_grid_length.mjs — download the MapYourGrid "Global Transmission Length Index"
// Google Sheet as CSV and store it as a committed snapshot.
//
//   node scripts/fetch_grid_length.mjs        (npm run fetch:length)
//
// Output: data/grid-length.csv
//
// Run this by hand when the sheet has been updated, review the diff, commit it, then
// run build:length. Deliberately split from the build step: this one touches the
// network, so a Google outage or a permissions change must not be able to silently
// produce a broken docs/data/grid-length.json. The committed CSV is the review gate.
// Same posture as build_admin1.mjs — network at build time, never in CI.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const SHEET_ID = "1qmVIQ2_ynVVfbTWcMXJQWb4Sq0Dq-1fu8zgZ9J_0cZI";
const CSV_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=0`;

// The sheet's first row is a banner; row 2 is the real header. Assert its opening
// columns so a restructured sheet fails loudly here instead of downstream.
const HEADER_PREFIX = "Countries,Found,Circuit";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEST = path.join(ROOT, "data", "grid-length.csv");

const res = await fetch(CSV_URL);
if (!res.ok) {
  console.error(`fetch failed: ${res.status} ${res.statusText}\n  ${CSV_URL}`);
  process.exit(1);
}

const csv = (await res.text()).replace(/^﻿/, "").replace(/\r\n?/g, "\n");
const secondLine = csv.split("\n")[1] ?? "";
if (!secondLine.startsWith(HEADER_PREFIX)) {
  console.error(
    `unexpected sheet shape — row 2 should start with "${HEADER_PREFIX}", got:\n  ${secondLine.slice(0, 120)}\n` +
    `Nothing written. Check the sheet layout before updating the snapshot.`
  );
  process.exit(1);
}

fs.mkdirSync(path.dirname(DEST), { recursive: true });
fs.writeFileSync(DEST, csv);
console.log(`fetched ${(csv.length / 1024).toFixed(0)} KB -> ${path.relative(ROOT, DEST)}`);
console.log(`next: node scripts/build_grid_length.mjs`);
