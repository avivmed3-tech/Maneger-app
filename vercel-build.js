#!/usr/bin/env node
/**
 * Build step for the Vercel deploy.
 *
 * Two jobs, in order:
 *
 *   1. Run build.js, which lifts the JSX out of index.html into app.js and
 *      compiles it, so no browser has to download babel-standalone and
 *      transpile ~670 KB of JSX before the first pixel appears.
 *   2. Copy the files the site actually ships into dist/, which is what
 *      Vercel serves.
 *
 * Step 1 is allowed to fail. index.html is a complete, working application on
 * its own — it compiles itself in the browser exactly as it always has — so a
 * broken compile ships the slower original rather than nothing at all. This
 * mirrors `continue-on-error: true` on the GitHub Pages workflow, which
 * deploys the same tree from the same source files.
 *
 * The staging copy in step 2 exists because build.js edits index.html in
 * place: without a separate output directory, Vercel's output root would be
 * the repo root, node_modules and all.
 */
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = __dirname;
const DIST = path.join(ROOT, "dist");

// Everything the deployed site serves. app.js is only present when the
// compile above succeeded, so it is optional; the rest must exist.
const SHIP = [
  { file: "index.html" },
  { file: "app.js", optional: true },
  { file: "manifest.json" },
  { file: "sw.js" },
  { file: "app-icon-192.png" },
  { file: "app-icon-512.png" },
  { file: "landing.html" },
];

const r = spawnSync(process.execPath, [path.join(ROOT, "build.js")], { stdio: "inherit" });
if (r.status !== 0) {
  console.warn("! JSX pre-compile did not run — shipping index.html as-is (it compiles in the browser).");
}

fs.rmSync(DIST, { recursive: true, force: true });
fs.mkdirSync(DIST, { recursive: true });

for (const { file, optional } of SHIP) {
  const src = path.join(ROOT, file);
  if (!fs.existsSync(src)) {
    if (optional) continue;
    console.error(`✗ missing required file: ${file}`);
    process.exit(1);
  }
  fs.copyFileSync(src, path.join(DIST, file));
  console.log(`  → dist/${file} (${(fs.statSync(src).size / 1024).toFixed(0)} KB)`);
}

console.log("✓ dist/ staged");
