/**
 * GenoIcons - Bespoke Handcrafted SVG Icon System for GenoChain
 * Master Barrel Export assembling:
 * - Bio-informatics & Molecular Genetics icons (`bioIcons.jsx`)
 * - Cryptographic, Security & Blockchain Infrastructure icons (`cryptoIcons.jsx`)
 * - Marketplace, Trading & UI Utility icons (`marketIcons.jsx`)
 *
 * Guarantees 100% backward compatibility with zero breaking changes for all importing components.
 */

import * as bioIcons from "./bioIcons.jsx";
import * as cryptoIcons from "./cryptoIcons.jsx";
import * as marketIcons from "./marketIcons.jsx";

export * from "./bioIcons.jsx";
export * from "./cryptoIcons.jsx";
export * from "./marketIcons.jsx";

const GenoIcons = {
  ...bioIcons,
  ...cryptoIcons,
  ...marketIcons
};

export default GenoIcons;
