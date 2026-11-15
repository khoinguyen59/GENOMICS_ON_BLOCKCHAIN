import fs from "fs";
import path from "path";
import { translations, vi, en } from "../../frontend/src/i18n/translations.js";

console.log("=== VERIFYING FRONTEND DICTIONARY DECOMPOSITION ===");

const filesToCheck = [
  { path: "frontend/src/i18n/locales/vi.js", maxLines: 450 },
  { path: "frontend/src/i18n/locales/en.js", maxLines: 450 },
  { path: "frontend/src/i18n/translations.js", maxLines: 50 },
  { path: "frontend/src/components/icons/bioIcons.jsx", maxLines: 300 },
  { path: "frontend/src/components/icons/cryptoIcons.jsx", maxLines: 300 },
  { path: "frontend/src/components/icons/marketIcons.jsx", maxLines: 400 },
  { path: "frontend/src/components/icons/GenoIcons.jsx", maxLines: 100 }
];

let allPassed = true;

for (const item of filesToCheck) {
  const content = fs.readFileSync(item.path, "utf8");
  const lineCount = content.split(/\r?\n/).length;
  const ok = lineCount <= item.maxLines;
  if (!ok) allPassed = false;
  console.log(`[${ok ? "PASS" : "FAIL"}] ${item.path}: ${lineCount} lines (limit <= ${item.maxLines})`);
}

// Check translations
const viKeyCount = Object.keys(translations.vi).length;
const enKeyCount = Object.keys(translations.en).length;
console.log(`Translation keys: vi=${viKeyCount}, en=${enKeyCount}`);
if (viKeyCount !== 353 || enKeyCount !== 353) {
  console.error("FAIL: Key count mismatch in translations!");
  allPassed = false;
}

// Check named exports
if (Object.keys(vi).length !== 353 || Object.keys(en).length !== 353) {
  console.error("FAIL: Named exports mismatch!");
  allPassed = false;
}

// Extract all exported functions from icon files
function getExports(filePath) {
  const code = fs.readFileSync(filePath, "utf8");
  const matches = [...code.matchAll(/export\s+function\s+([A-Za-z0-9_]+)/g)];
  return matches.map(m => m[1]);
}

const bioExports = getExports("frontend/src/components/icons/bioIcons.jsx");
const cryptoExports = getExports("frontend/src/components/icons/cryptoIcons.jsx");
const marketExports = getExports("frontend/src/components/icons/marketIcons.jsx");

const allIconExports = new Set([...bioExports, ...cryptoExports, ...marketExports]);
console.log(`Extracted icons: bio=${bioExports.length}, crypto=${cryptoExports.length}, market=${marketExports.length}, total=${allIconExports.size}`);

if (allIconExports.size !== 70) {
  console.error(`FAIL: Expected 70 total unique icons, got ${allIconExports.size}`);
  allPassed = false;
}

// Check all frontend imports from GenoIcons
function walkDir(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const results = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkDir(full));
    } else if (full.endsWith(".jsx") || full.endsWith(".js")) {
      results.push(full);
    }
  }
  return results;
}

const frontendSourceFiles = walkDir("frontend/src");
const importPattern = /import\s+\{([^}]+)\}\s+from\s+['"][^'"]*icons\/GenoIcons['"]/g;
const usedIcons = new Set();

for (const file of frontendSourceFiles) {
  const text = fs.readFileSync(file, "utf8");
  let match;
  while ((match = importPattern.exec(text)) !== null) {
    const list = match[1].split(",").map(s => s.trim()).filter(Boolean);
    for (const iconName of list) {
      usedIcons.add(iconName);
      if (!allIconExports.has(iconName)) {
        console.error(`FAIL: File ${file} imports unknown icon ${iconName}!`);
        allPassed = false;
      }
    }
  }
}

console.log(`Verified ${usedIcons.size} uniquely imported icons across all frontend components.`);

if (allPassed) {
  console.log("=== ALL CHECKS PASSED PERFECTLY ===");
  process.exit(0);
} else {
  console.error("=== SOME CHECKS FAILED ===");
  process.exit(1);
}
