// Agent6 audit helper: EN/VI i18n dictionary parity + coverage of t() usage in JSX.
// Read-only analysis; writes nothing to the repo.
import fs from "node:fs";
import path from "node:path";

import { pathToFileURL } from "node:url";
const root = process.argv[2] || "frontend/src";
const { en } = await import(pathToFileURL(path.resolve(root, "i18n/locales/en.js")).href);
const { vi } = await import(pathToFileURL(path.resolve(root, "i18n/locales/vi.js")).href);

function flat(obj, pre = "", out = new Set()) {
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    if (v && typeof v === "object" && !Array.isArray(v)) flat(v, pre + k + ".", out);
    else out.add(pre + k);
  }
  return out;
}

const enK = flat(en);
const viK = flat(vi);
console.log("EN leaf keys:", enK.size);
console.log("VI leaf keys:", viK.size);
const missVi = [...enK].filter((k) => !viK.has(k));
const missEn = [...viK].filter((k) => !enK.has(k));
console.log(`MISSING in VI (${missVi.length}):`, JSON.stringify(missVi.slice(0, 40)));
console.log(`MISSING in EN (${missEn.length}):`, JSON.stringify(missEn.slice(0, 40)));

// VI values that are byte-identical to EN (untranslated strings) - top-level only
const same = [...enK].filter((k) => {
  const get = (o) => k.split(".").reduce((a, c) => (a ? a[c] : undefined), o);
  const a = get(en);
  const b = get(vi);
  return typeof a === "string" && a === b;
});
console.log(`VI values identical to EN (${same.length}):`, JSON.stringify(same.slice(0, 25)));

// Collect t("key") usages across the app
const files = [];
(function walk(d) {
  for (const f of fs.readdirSync(d)) {
    const p = path.join(d, f);
    const st = fs.statSync(p);
    if (st.isDirectory()) walk(p);
    else if (/\.(jsx|js)$/.test(f) && !p.includes("i18n")) files.push(p);
  }
})(root);

const used = new Set();
for (const f of files) {
  const src = fs.readFileSync(f, "utf8");
  for (const m of src.matchAll(/\bt\(\s*["'`]([A-Za-z0-9_.]+)["'`]/g)) used.add(m[1]);
  for (const m of src.matchAll(/\bt\(\s*["'`]([A-Za-z0-9_.]+)["'`]\s*,\s*\{/g)) used.add(m[1]);
}
const dynamicOnly = [...used].filter((k) => k.includes("${"));
const missingEn = [...used].filter((k) => !enK.has(k) && !k.includes("$"));
const missingVi = [...used].filter((k) => !viK.has(k) && !k.includes("$"));
console.log("distinct static t() keys used:", used.size);
console.log(`t() keys NOT in EN dict (${missingEn.length}):`, JSON.stringify(missingEn.slice(0, 40)));
console.log(`t() keys NOT in VI dict (${missingVi.length}):`, JSON.stringify(missingVi.slice(0, 40)));
console.log("files scanned:", files.length);

if (missVi.length > 0 || missEn.length > 0 || missingEn.length > 0 || missingVi.length > 0) {
  console.error(
    `[FAIL] i18n parity check failed: missVi=${missVi.length}, missEn=${missEn.length}, missingStaticEn=${missingEn.length}, missingStaticVi=${missingVi.length}`
  );
  process.exit(1);
}
console.log("[PASS] 100% EN/VI i18n dictionary parity and static t() coverage verified.");
