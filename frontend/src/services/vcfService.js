/**
 * @file vcfService.js
 * @description Master Barrel Facade for Genomic VCF & Reference Datasets Service.
 *              Re-exports PRESET_CATALOG and parseVcfMetadata identically for 100% backward compatibility.
 * @author Nguyễn Trọng Khôi (MSSV: 23520783)
 */

import { PRESET_CATALOG } from "./vcf/presetCatalog.js";
import { parseVcfMetadata } from "./vcf/vcfParser.js";

export { PRESET_CATALOG } from "./vcf/presetCatalog.js";
export { parseVcfMetadata } from "./vcf/vcfParser.js";

export default {
  PRESET_CATALOG,
  parseVcfMetadata,
};
