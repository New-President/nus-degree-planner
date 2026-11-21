#!/usr/bin/env node
/*
 * Flags when the sources behind programmes.js may be out of date. It never edits programmes.js.
 *
 *   node scripts/check-requirements.mjs            compare against the saved baseline
 *   node scripts/check-requirements.mjs --update   save the current state as the new baseline
 *   node scripts/check-requirements.mjs --report report.md   also write the findings as markdown (used by the GitHub bot)
 *
 * 1. Source pages: every `sources` / `source` URL in programmes.js is fetched and a hash of its
 *    visible text (or the bytes, for PDFs) is compared with scripts/source-hashes.json.
 *    A changed hash means the page changed: re-read it and update programmes.js by hand.
 * 2. Course codes: every concrete course code written in programmes.js is looked up in the live
 *    NUSMods module list. Codes that no longer exist are listed (retired or renamed courses).
 *
 * Exit code 1 if a page changed or is unreachable, or a course code is newly missing. Course codes already
 * listed in scripts/known-missing-codes.json are not reported again.
 * Needs Node 18+ (global fetch).
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const progFile = path.join(root, "programmes.js");
const hashFile = path.join(root, "scripts", "source-hashes.json");
const update = process.argv.includes("--update");
const reportIdx = process.argv.indexOf("--report");
const reportFile = reportIdx > 0 ? process.argv[reportIdx + 1] : null;
const knownFile = path.join(root, "scripts", "known-missing-codes.json");

/* ---------- load programmes.js ---------- */
const src = fs.readFileSync(progFile, "utf8");
const sandbox = { window: {} };
vm.createContext(sandbox);
vm.runInContext(src, sandbox, { filename: "programmes.js" });
const P = sandbox.window.PROGRAMMES;

/* every {label, url} object, with where it was found */
const sources = new Map();
(function walk(node, where, seen = new Set()) {
  if (!node || typeof node !== "object" || seen.has(node)) return;
  seen.add(node);
  if (typeof node.url === "string" && /^https?:/.test(node.url)) {
    const list = sources.get(node.url) || [];
    list.push(`${where}${node.label ? ` (${node.label})` : ""}`);
    sources.set(node.url, list);
  }
  for (const [k, v] of Object.entries(node)) if (typeof v === "object") walk(v, `${where}/${k}`, seen);
})({ MAJORS: P.MAJORS, SECOND: P.SECOND, MINORS: P.MINORS, RCS: P.RCS, NUSC: P.NUSC, DDP: P.DDP }, "");

/* ---------- helpers ---------- */
const sha = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
async function pool(items, size, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: size }, async () => {
    while (i < items.length) { const n = i++; out[n] = await fn(items[n]); }
  }));
  return out;
}
async function fingerprint(url) {
  const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(25000), headers: { "user-agent": "nus-degree-planner-source-check" } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const type = res.headers.get("content-type") || "";
  const buf = Buffer.from(await res.arrayBuffer());
  if (!/html/i.test(type)) return { hash: sha(buf) };   /* PDFs: bytes are stable, so hash them */
  const text = buf.toString("utf8")
    .replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z#0-9]+;/gi, " ")
    .replace(/\s+/g, " ");
  /* HTML pages carry rotating content (news, dates), so a whole-page hash changes every load.
     Track what the requirements depend on instead: course codes and unit counts. */
  const tokens = new Set([
    ...(text.match(/\b[A-Z]{2,4}\d{4}[A-Z]{0,2}\b/g) || []),
    ...[...text.matchAll(/\b(\d{1,3})\s*(?:units|MCs?|credits)\b/gi)].map((m) => `${m[1]} units`),
  ]);
  return { tokens: [...tokens].sort() };
}
const same = (a, b) => (a.hash ? a.hash === b.hash : a.tokens.length === b.tokens.length && a.tokens.every((t, i) => t === b.tokens[i]));
const diff = (old, now) => ({
  added: (now.tokens || []).filter((t) => !(old.tokens || []).includes(t)),
  removed: (old.tokens || []).filter((t) => !(now.tokens || []).includes(t)),
});

/* ---------- 1. source pages ---------- */
const baseline = fs.existsSync(hashFile) ? JSON.parse(fs.readFileSync(hashFile, "utf8")) : null;
const urls = [...sources.keys()];
console.log(`Checking ${urls.length} source pages…`);
const results = await pool(urls, 6, async (url) => {
  try { return { url, fp: await fingerprint(url) }; }
  catch (e) { return { url, error: e.message }; }
});

const changed = [], failed = [], added = [], untracked = [];
const next = {};
for (const r of results) {
  const old = baseline && baseline[r.url];
  if (r.error) { failed.push(r); if (old) next[r.url] = old; continue; }
  /* keep the stored entry when nothing changed, so the baseline file only changes when a page does */
  next[r.url] = old && same(old, r.fp) ? old : { ...r.fp, checked: new Date().toISOString().slice(0, 10) };
  if (r.fp.tokens && !r.fp.tokens.length) untracked.push(r.url);   /* e.g. page is rendered by JavaScript */
  if (baseline && !old) added.push(r);
  else if (old && !same(old, r.fp)) changed.push({ ...r, since: old.checked, d: old.hash || r.fp.hash ? null : diff(old, r.fp) });
}

/* ---------- 2. course codes against live NUSMods ---------- */
const codes = [...new Set([...src.matchAll(/"([A-Z]{2,4}\d{4}[A-Z]{0,2})"/g)].map((m) => m[1]))];
let missing = [], listAY = null;
{
  const y = new Date().getFullYear();
  const start = new Date().getMonth() >= 6 ? y : y - 1;
  /* a module list only holds courses offered that year, so a code must be absent from the last
     few years' lists before it is reported as retired or renamed */
  const live = new Set(), years = [];
  for (let s = start; s >= start - 2; s--) {
    const ay = `${s}-${s + 1}`;
    try {
      const res = await fetch(`https://api.nusmods.com/v2/${ay}/moduleList.json`, { signal: AbortSignal.timeout(30000) });
      if (!res.ok) continue;
      (await res.json()).forEach((m) => live.add(m.moduleCode));
      years.push(ay);
    } catch { /* skip this year */ }
  }
  if (years.length) { missing = codes.filter((c) => !live.has(c)).sort(); listAY = years.join(", "); }
}
const known = fs.existsSync(knownFile) ? JSON.parse(fs.readFileSync(knownFile, "utf8")) : [];
const newMissing = missing.filter((c) => !known.includes(c));

/* ---------- report ---------- */
const out = [];
const line = (s = "") => out.push(s);
const usedBy = (u) => `${sources.get(u).slice(0, 3).join(", ")}${sources.get(u).length > 3 ? ", …" : ""}`;
if (!baseline) line("No baseline yet (scripts/source-hashes.json). Run with --update to create one.\n");
if (changed.length) {
  line(`CHANGED since last baseline (${changed.length}): re-read each page and update programmes.js`);
  changed.forEach((c) => line(`  - ${c.url}\n      last seen ${c.since}; used by ${usedBy(c.url)}${
      c.d ? `\n      added: ${c.d.added.join(", ") || "none"}\n      removed: ${c.d.removed.join(", ") || "none"}` : "\n      (PDF contents changed)"}`));
  line();
}
if (added.length) { line(`NEW sources (${added.length}), not in baseline:`); added.forEach((a) => line(`  - ${a.url}`)); line(); }
if (failed.length) {
  line(`UNREACHABLE (${failed.length}): page moved, removed or blocking the check`);
  failed.forEach((f) => line(`  - ${f.url}  [${f.error}]`));
  line();
}
if (untracked.length) line(`Not tracked (${untracked.length} pages show no course codes or unit counts, e.g. JavaScript-rendered or landing pages): changes there won't be detected.\n`);
if (listAY) {
  if (newMissing.length) line(`NEW COURSE CODES not in NUSMods AY${listAY} (${newMissing.length}): retired or renamed?\n  ${newMissing.join(", ")}\n`);
  else line(`No new missing course codes. ${missing.length} known ones are listed in scripts/known-missing-codes.json (${codes.length} codes checked against NUSMods AY${listAY}).\n`);
} else line("Could not reach NUSMods, so course codes were not checked.\n");

if (update) {
  fs.writeFileSync(hashFile, JSON.stringify(next, null, 2) + "\n");
  if (listAY) fs.writeFileSync(knownFile, JSON.stringify(missing, null, 2) + "\n");
  line(`Baseline saved (${Object.keys(next).length} pages, ${missing.length} known missing codes).`);
}
const problems = changed.length + failed.length + newMissing.length;
if (!problems && baseline) line("Nothing changed.");
console.log(out.join("\n"));
if (reportFile) fs.writeFileSync(reportFile, out.join("\n") + "\n");
process.exit(problems ? 1 : 0);
