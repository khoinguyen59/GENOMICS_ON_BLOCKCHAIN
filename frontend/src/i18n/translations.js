/**
 * Master bilingual translation dictionaries for GenoChain
 * Assembles Vietnamese (vi) and English (en) localization with 100% parity
 * Modularized sub-dictionaries satisfy SRP and strict file line constraints.
 */

import { vi } from "./locales/vi.js";
import { en } from "./locales/en.js";

export { vi, en };

export const translations = {
  vi,
  en
};

export default translations;
