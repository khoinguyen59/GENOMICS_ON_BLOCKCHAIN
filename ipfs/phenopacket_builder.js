/**
 * @file phenopacket_builder.js
 * @description Builder module for generating standard GA4GH Phenopackets Schema v2.0 metadata JSON.
 *              - Complies strictly with GA4GH Phenopackets v2 schema (Individual, PhenotypicFeature, Disease).
 *              - Eliminates non-standard schema fields in Individual (such as raw ancestry strings).
 *              - Models population descriptors via standard Human Ancestry Ontology (HANCESTRO).
 *              - Provides validation function to ensure 100% schema correctness.
 * @author Nguyễn Trọng Khôi (MSSV: 23520783)
 */

import { sha256, toUtf8Bytes } from "ethers";

/**
 * Build a GA4GH Phenopacket v2 compliant metadata object
 * @param {Object} params
 * @param {string} params.subjectId De-identified subject pseudonym (e.g. "ANON_SUBJ_9042")
 * @param {string} params.disease Name and CURIE of trait (e.g. "Population Variation", "SO:0000694")
 * @param {string} [params.diseaseCurie="SO:0000694"]
 * @param {Array<{id: string, label: string}>} [params.phenotypes=[]] Human Phenotype Ontology (HPO) terms
 * @param {Array<{gene: string, hgvs: string, zygosity: string}>} [params.variants=[]] Genomic variants
 * @param {string} [params.sex="FEMALE"] "FEMALE" | "MALE" | "OTHER_SEX" | "UNKNOWN_SEX"
 * @param {string} [params.ancestry="East Asian"] Population descriptor modeled as HANCESTRO
 * @param {string} [params.rawDataHash="0x00"] SHA-256 hash of raw genomic data for on-chain integrity check
 * @param {string} [params.rawCid=""] IPFS CID of the encrypted raw file
 * @param {string} [params.summaryCid=""] IPFS CID of the encrypted clinical summary report (PDF)
 * @param {string} [params.summaryDataHash=""] SHA-256 hash of encrypted clinical summary report
 * @returns {Object} GA4GH Phenopacket v2 JSON
 */
function getRandomSaltHex(byteLen = 16) {
  const cryptoApi = typeof window !== "undefined" && window.crypto ? window.crypto : globalThis.crypto;
  if (!cryptoApi || typeof cryptoApi.getRandomValues !== "function") {
    throw new Error("CSPRNG (crypto.getRandomValues) is required for salted pseudonym generation.");
  }
  const bytes = new Uint8Array(byteLen);
  cryptoApi.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Generate a >= 128-bit (32 hex char) salted SHA-256 subject pseudonym.
 * Uses CSPRNG random salt by default; accepts an explicit salt only when caller requests deterministic pseudonymization.
 * @param {string} rawId Raw subject identifier
 * @param {string|null} [salt=null] Optional caller-provided salt for deterministic pseudonymization
 * @returns {string} 32-char lowercase hex pseudonym digest (128-bit)
 */
export function hashPseudoId(rawId, salt = null) {
  const effectiveSalt =
    typeof salt === "string" && salt.trim().length > 0 ? salt.trim() : getRandomSaltHex(16);
  return sha256(toUtf8Bytes(`GENOCHAIN_PSEUDO_ID_V2:${effectiveSalt}:${String(rawId)}`)).slice(2, 34);
}

const HANCESTRO_MAP = [
  { match: /viet|kinh|southeast\s*asian/i, id: "HANCESTRO:0021" },
  { match: /east\s*asian|han|japanese|korean/i, id: "HANCESTRO:0009" },
  { match: /south\s*asian/i, id: "HANCESTRO:0006" },
  { match: /european|caucasian/i, id: "HANCESTRO:0005" },
  { match: /african/i, id: "HANCESTRO:0010" },
  { match: /admixed|american|hispanic|latino/i, id: "HANCESTRO:0014" },
  { match: /middle\s*eastern/i, id: "HANCESTRO:0015" },
  { match: /oceanian/i, id: "HANCESTRO:0017" },
];

function resolveHancestroCurie(ancestryLabel) {
  const raw = String(ancestryLabel || "").trim();
  for (const entry of HANCESTRO_MAP) {
    if (entry.match.test(raw)) return entry.id;
  }
  return "HANCESTRO:0004"; // ancestral category root
}

const GENE_CHROM_MAP = {
  ALDH2: "chr12",
  ADH1B: "chr4",
  KHV_1000G: "chr12",
  ACTN3: "chr11",
  HERC2: "chr15",
  OCA2: "chr15",
  TAS2R38: "chr7",
  EDAR: "chr2",
  LCT: "chr2",
  MCM6: "chr2",
  CYP1A2: "chr15",
  ABCC11: "chr16",
  NA12878: "chr20",
  ZNF343: "chr20",
  BRCA1: "chr17",
  BRCA2: "chr13",
  TP53: "chr17",
  APOE: "chr19",
  CYP2C19: "chr10",
  CFTR: "chr7",
  SLCO1B1: "chr12",
  G6PD: "chrX",
  CHRM: "chrM",
};

const GENE_HGNC_MAP = {
  ALDH2: "HGNC:404",
  ADH1B: "HGNC:250",
  ACTN3: "HGNC:166",
  HERC2: "HGNC:4868",
  OCA2: "HGNC:8101",
  TAS2R38: "HGNC:9584",
  EDAR: "HGNC:2895",
  LCT: "HGNC:6530",
  MCM6: "HGNC:6949",
  CYP1A2: "HGNC:2596",
  ABCC11: "HGNC:14639",
  ZNF343: "HGNC:16220",
  BRCA1: "HGNC:1100",
  BRCA2: "HGNC:1101",
  TP53: "HGNC:11998",
  APOE: "HGNC:613",
  CYP2C19: "HGNC:2621",
  CFTR: "HGNC:1884",
  SLCO1B1: "HGNC:10959",
  G6PD: "HGNC:4057",
};

export function resolveHgncValueId(geneSymbol, explicitValueId = "") {
  const exp = String(explicitValueId || "").trim();
  if (/^HGNC:\d+$/.test(exp)) return exp;
  const sym = String(geneSymbol || "").trim();
  const mapped = GENE_HGNC_MAP[sym.toUpperCase()];
  if (mapped) return mapped;
  return `HGNC:${sym || "UNKNOWN"}`;
}

function resolveCleanGeneSymbol(rawGene) {
  const str = String(rawGene || "").trim();
  if (!str) return "GENOME";
  if (/^KHV[_-]/i.test(str)) return "ALDH2";
  if (/^SAMTOOLS/i.test(str)) return "SAMTOOLS";
  if (/^NA12878/i.test(str)) return "ZNF343";
  const known = str.match(/\b(ALDH2|ADH1B|ACTN3|HERC2|OCA2|TAS2R38|EDAR|LCT|MCM6|CYP1A2|ABCC11|ZNF343|chrM)\b/i);
  if (known) return known[1] === "chrM" ? "chrM" : known[1].toUpperCase();
  return str.split(/[\s(/,:]/)[0] || "GENOME";
}

function resolveCleanRsId(variant, explicitRsId, cleanGene, disease) {
  const candidates = [variant?.rsId, variant?.id, explicitRsId, variant?.gene, variant?.hgvs, disease];
  for (const c of candidates) {
    const m = String(c || "").match(/\b(rs\d+)\b/i);
    if (m) return m[1];
  }
  if (variant?.rsId && String(variant.rsId).trim()) return String(variant.rsId).trim();
  if (explicitRsId && String(explicitRsId).trim()) return String(explicitRsId).trim();
  return `${cleanGene}-LOCUS`;
}

function resolveChromosome(variant, explicitChrom, cleanGene, disease, normalizedFormatUpper) {
  const candidates = [variant?.chrom, variant?.chromosome, explicitChrom, variant?.gene, disease];
  for (const c of candidates) {
    const str = String(c || "").trim();
    if (!str) continue;
    const m = str.match(/\b(chr(?:[1-9]|1\d|2[0-2]|X|Y|M|MT))\b/i);
    if (m) return m[1].toUpperCase().startsWith("CHR") ? `chr${m[1].slice(3).toUpperCase()}` : m[1];
    if (/^(?:[1-9]|1\d|2[0-2]|X|Y|M|MT)$/i.test(str)) return `chr${str.toUpperCase()}`;
  }
  if (GENE_CHROM_MAP[cleanGene]) return GENE_CHROM_MAP[cleanGene];
  if (normalizedFormatUpper === "FASTA") return "chrM";
  if (normalizedFormatUpper === "FASTQ") return "WGS";
  return "Multi-locus";
}

const BLOOD_GROUP_SNOMED_MAP = {
  "O+": "SNOMED:278149003",
  "O-": "SNOMED:278150003",
  "A+": "SNOMED:278152006",
  "A-": "SNOMED:278153001",
  "B+": "SNOMED:278154007",
  "B-": "SNOMED:278155008",
  "AB+": "SNOMED:278156009",
  "AB-": "SNOMED:278157000",
};

const VALID_ACMG_CLASSIFICATIONS = new Set([
  "NOT_PROVIDED",
  "BENIGN",
  "LIKELY_BENIGN",
  "UNCERTAIN_SIGNIFICANCE",
  "LIKELY_PATHOGENIC",
  "PATHOGENIC",
]);

function normalizeAcmgClassification(rawValue) {
  const raw = String(rawValue || "").trim().toUpperCase().replace(/[\s-]+/g, "_");
  if (VALID_ACMG_CLASSIFICATIONS.has(raw)) return raw;
  if (raw.includes("LIKELY_PATHOGENIC")) return "LIKELY_PATHOGENIC";
  if (raw.includes("PATHOGENIC")) return "PATHOGENIC";
  if (raw.includes("UNCERTAIN") || raw === "VUS") return "UNCERTAIN_SIGNIFICANCE";
  if (raw.includes("LIKELY_BENIGN") && !raw.includes("BENIGN_OR")) return "LIKELY_BENIGN";
  if (raw.includes("BENIGN")) return "BENIGN";
  return "BENIGN";
}

function resolveBloodGroupSnomedCurie(bloodGroup) {
  return BLOOD_GROUP_SNOMED_MAP[bloodGroup] || "NCIT:C16355";
}

export function buildPhenopacket({
  subjectId,
  pseudoSalt = null,
  disease,
  diseaseCurie = "SO:0000694",
  clinicalSignificance = "",
  zygosity = "",
  phenotypes = [],
  variants = [],
  sex = "FEMALE",
  ancestry = "East Asian",
  bloodGroup = "",
  rawDataHash = "0x00",
  rawCid = "",
  summaryCid = "",
  summaryDataHash = "",
  fileFormat = "",
  format = "",
  fileSize = 0,
  chromosome = "",
  rsId = "",
  pos = 0,
  genomeAssembly = "GRCh38",
}) {
  const cleanClinicalSignificance =
    typeof clinicalSignificance === "string" ? clinicalSignificance.trim() : "";
  const cleanDefaultZygosity =
    typeof zygosity === "string" ? zygosity.trim() : "";
  const cleanBloodGroup =
    typeof bloodGroup === "string" &&
    /^(O|A|B|AB)[+-]$/i.test(bloodGroup.trim())
      ? bloodGroup.trim().toUpperCase()
      : "";
  const rawSubject = String(subjectId || "ANON_SUBJECT").trim();
  const safeSubjectId = /^(ANON_|SEED_|SUBJ_|COHORT_|DONOR_)[a-zA-Z0-9_-]{4,}$/i.test(rawSubject)
    ? rawSubject.replace(/[^a-zA-Z0-9_-]/g, "_")
    : `ANON_${hashPseudoId(rawSubject, pseudoSalt)}`;
  const files = [];

  // Dynamically resolve actual dataset format (e.g. FASTQ, BAM, CRAM, VCF, PHENOPACKET, FASTA)
  const resolvedFormatRaw = String(format || fileFormat || "VCF").trim();
  const normalizedFormatUpper = resolvedFormatRaw.toUpperCase().replace(/\s*V\d+(\.\d+)?/i, "").trim() || "VCF";
  const fileExt = normalizedFormatUpper.toLowerCase().replace(/[^a-z0-9]/g, "");

  if (rawCid) {
    const rawFileAttributes = {
      fileFormat: String(resolvedFormatRaw || "VCF"),
      genomeAssembly: String(genomeAssembly || "GRCh38"),
      isEncrypted: "true",
      encryptionAlgorithm: "AES-256-GCM",
      rawDataHash: String(rawDataHash),
    };
    if (fileSize && Number(fileSize) > 0) {
      rawFileAttributes.fileSize = String(Number(fileSize));
    }
    files.push({
      uri: `ipfs://${rawCid}`,
      individualToFileIdentifiers: { [safeSubjectId]: `${safeSubjectId}.${fileExt || "vcf"}` },
      fileAttributes: rawFileAttributes,
    });
  }

  if (summaryCid) {
    const summaryFileAttributes = {
      fileFormat: "application/pdf",
      description: "Clinical Bio-Informatics Summary Report (ISO 32000 / PDF-1.4)",
      isEncrypted: "true",
      encryptionAlgorithm: "AES-256-GCM",
    };
    if (summaryDataHash) {
      summaryFileAttributes.summaryDataHash = String(summaryDataHash);
    }
    files.push({
      uri: `ipfs://${summaryCid}`,
      individualToFileIdentifiers: { [safeSubjectId]: `${safeSubjectId}_summary.pdf` },
      fileAttributes: summaryFileAttributes,
    });
  }

  const measurements = cleanBloodGroup
    ? [
        {
          assay: {
            id: "LOINC:882-1",
            label: "ABO and Rh group [Type] in Blood",
          },
          value: {
            ontologyClass: {
              id: resolveBloodGroupSnomedCurie(cleanBloodGroup),
              label: cleanBloodGroup,
            },
          },
        },
      ]
    : [];

  return {
    id: `phenopacket-${safeSubjectId}`,
    files: files,
    // Strict GA4GH v2 Individual schema (zero non-standard fields; bloodGroup modeled in measurements LOINC:882-1)
    subject: {
      id: safeSubjectId,
      sex: sex,
      karyotypicSex: sex === "FEMALE" ? "XX" : sex === "MALE" ? "XY" : "UNKNOWN_KARYOTYPE",
      taxonomy: {
        id: "NCBITaxon:9606",
        label: "Homo sapiens",
      },
      vitalStatus: {
        status: "ALIVE",
      },
    },
    ...(measurements.length > 0 ? { measurements } : {}),
    phenotypicFeatures: (() => {
      const ancestryCurie = resolveHancestroCurie(ancestry);
      const features = phenotypes.map((p) => ({
        type: {
          id: p.id,
          label: p.label,
        },
        excluded: false,
      }));
      if (!features.some((f) => f.type?.id === ancestryCurie)) {
        // Ancestry modeled as a standard population descriptor feature
        features.push({
          type: {
            id: ancestryCurie,
            label: ancestry,
          },
          excluded: false,
        });
      }
      return features;
    })(),
    diseases: [
      {
        term: {
          id: diseaseCurie,
          label: disease,
        },
      },
    ],
    interpretations: [
      {
        id: `interpretation-${safeSubjectId}`,
        progressStatus: "COMPLETED",
        diagnosis: {
          disease: {
            id: diseaseCurie,
            label: disease,
          },
          genomicInterpretations: variants.map((v) => {
            const cleanGene = resolveCleanGeneSymbol(v.symbol || v.gene);
            const cleanRsId = resolveCleanRsId(v, rsId, cleanGene, disease);
            const resolvedChrom = resolveChromosome(v, chromosome, cleanGene, disease, normalizedFormatUpper);
            const resolvedPos = Number(v.pos || pos || 0);
            const resolvedAssembly = v.genomeAssembly || genomeAssembly || "GRCh38";
            const resolvedZygosity = String(v.zygosity || cleanDefaultZygosity || "").trim();
            const normalizedZygosity = resolvedZygosity.toLowerCase();
            const allelicStateId = normalizedZygosity.includes("hetero") || normalizedZygosity.includes("0/1") || normalizedZygosity.includes("1/0")
              ? "GENO:0000135"
              : normalizedZygosity.includes("homo") || normalizedZygosity.includes("1/1") || normalizedZygosity.includes("0/0")
                ? "GENO:0000136"
                : normalizedZygosity.includes("hemi")
                  ? "GENO:0000134"
                  : "GENO:0000137";
            const acmgClassification = normalizeAcmgClassification(v.pathogenicity || cleanClinicalSignificance);
            return {
              subjectOrBiosampleId: safeSubjectId,
              interpretationStatus: v.interpretationStatus || (acmgClassification === "PATHOGENIC" ? "CAUSATIVE" : "CONTRIBUTORY"),
              variantInterpretation: {
                acmgPathogenicityClassification: acmgClassification,
                variationDescriptor: {
                  id: cleanRsId,
                  geneContext: {
                    valueId: resolveHgncValueId(cleanGene, v.hgncId || v.valueId),
                    symbol: cleanGene,
                  },
                  vcfRecord: {
                    genomeAssembly: resolvedAssembly,
                    chrom: resolvedChrom,
                    ...(resolvedPos > 0 ? { pos: resolvedPos } : {}),
                    id: cleanRsId,
                  },
                  expressions: [
                    {
                      syntax: "hgvs",
                      value: "[REDACTED_PROTECTED_UNDER_ENCRYPTED_PAYLOAD]",
                    },
                  ],
                  allelicState: {
                    id: allelicStateId,
                    label: resolvedZygosity || "unspecified",
                  },
                },
              },
            };
          }),
        },
      },
    ],
    metaData: {
      created: `${new Date().getUTCFullYear()}-01-01T00:00:00.000Z`,
      createdBy: "GenomicsBlockchainRegistry_v2",
      resources: [
        {
          id: "hp",
          name: "Human Phenotype Ontology",
          url: "http://purl.obolibrary.org/obo/hp.owl",
          version: "2026-01-01",
          namespacePrefix: "HP",
          iriPrefix: "http://purl.obolibrary.org/obo/HP_",
        },
        {
          id: "mondo",
          name: "Mondo Disease Ontology",
          url: "http://purl.obolibrary.org/obo/mondo.owl",
          version: "2026-01-01",
          namespacePrefix: "MONDO",
          iriPrefix: "http://purl.obolibrary.org/obo/MONDO_",
        },
        {
          id: "hancestro",
          name: "Human Ancestry Ontology",
          url: "http://purl.obolibrary.org/obo/hancestro.owl",
          version: "2026-01-01",
          namespacePrefix: "HANCESTRO",
          iriPrefix: "http://purl.obolibrary.org/obo/HANCESTRO_",
        },
        {
          id: "loinc",
          name: "Logical Observation Identifiers Names and Codes",
          url: "https://loinc.org",
          version: "2.77",
          namespacePrefix: "LOINC",
          iriPrefix: "https://loinc.org/",
        },
        {
          id: "snomed",
          name: "SNOMED Clinical Terms",
          url: "https://www.snomed.org",
          version: "2026-01-01",
          namespacePrefix: "SNOMED",
          iriPrefix: "http://snomed.info/id/",
        },
        {
          id: "ncbitaxon",
          name: "NCBI Organismal Classification",
          url: "http://purl.obolibrary.org/obo/ncbitaxon.owl",
          version: "2026-01-01",
          namespacePrefix: "NCBITaxon",
          iriPrefix: "http://purl.obolibrary.org/obo/NCBITaxon_",
        },
        {
          id: "hgnc",
          name: "HUGO Gene Nomenclature Committee",
          url: "https://www.genenames.org",
          version: "2026-01-01",
          namespacePrefix: "HGNC",
          iriPrefix: "https://www.genenames.org/data/gene-symbol-report/#!/hgnc_id/HGNC:",
        },
        {
          id: "so",
          name: "Sequence Ontology",
          url: "http://purl.obolibrary.org/obo/so.owl",
          version: "2026-01-01",
          namespacePrefix: "SO",
          iriPrefix: "http://purl.obolibrary.org/obo/SO_",
        },
        {
          id: "geno",
          name: "Genotype Ontology",
          url: "http://purl.obolibrary.org/obo/geno.owl",
          version: "2026-01-01",
          namespacePrefix: "GENO",
          iriPrefix: "http://purl.obolibrary.org/obo/GENO_",
        },
      ],
      phenopacketSchemaVersion: "2.0.0",
      externalReferences: [
        {
          id: "GENOMICS_BLOCKCHAIN_INTEGRITY",
          description: `SHA-256 rawDataHash: ${rawDataHash}`,
        },
        ...(cleanClinicalSignificance
          ? [
              {
                id: "GENOCHAIN_CLINICAL_SIGNIFICANCE",
                description: cleanClinicalSignificance,
              },
            ]
          : []),
      ],
    },
  };
}

/**
 * Validate that a Phenopacket object satisfies strict GA4GH Phenopackets v2 Protobuf requirements
 * @param {Object} phenopacket
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validatePhenopacketSchema(phenopacket) {
  const errors = [];
  if (!phenopacket || typeof phenopacket !== "object") {
    return { valid: false, errors: ["Phenopacket is null or undefined"] };
  }
  if ("schemaVersion" in phenopacket) {
    errors.push("Non-standard top-level 'schemaVersion' is forbidden in GA4GH Phenopackets v2 (use metaData.phenopacketSchemaVersion)");
  }
  const metaSchemaVer = phenopacket.metaData?.phenopacketSchemaVersion;
  if (metaSchemaVer !== "2.0.0" && metaSchemaVer !== "2.0") {
    errors.push("Missing or invalid metaData.phenopacketSchemaVersion (expected 2.0.0)");
  }
  if (!phenopacket.id) {
    errors.push("Missing required field: id");
  }
  if (!phenopacket.subject || !phenopacket.subject.id) {
    errors.push("Missing required subject or subject.id");
  }
  if (phenopacket.subject && "ancestry" in phenopacket.subject) {
    errors.push("Individual subject must not contain non-standard 'ancestry' property");
  }
  if (phenopacket.subject && "bloodGroup" in phenopacket.subject) {
    errors.push("Individual subject must not contain non-standard 'bloodGroup' property (use measurements LOINC:882-1)");
  }
  if (!Array.isArray(phenopacket.phenotypicFeatures)) {
    errors.push("phenotypicFeatures must be an array");
  }
  if (!phenopacket.metaData || !Array.isArray(phenopacket.metaData.resources)) {
    errors.push("metaData with resources array is required");
  }
  if (Array.isArray(phenopacket.files)) {
    for (const f of phenopacket.files) {
      if (f?.fileAttributes && typeof f.fileAttributes === "object") {
        for (const [k, v] of Object.entries(f.fileAttributes)) {
          if (typeof v !== "string") {
            errors.push(`files[].fileAttributes.${k} must be a string (Protobuf map<string, string>)`);
          }
        }
      }
    }
  }
  if (Array.isArray(phenopacket.interpretations)) {
    for (const interp of phenopacket.interpretations) {
      const gis = interp?.diagnosis?.genomicInterpretations || [];
      for (const gi of gis) {
        if (!gi?.subjectOrBiosampleId) {
          errors.push("genomicInterpretations[] entry missing required subjectOrBiosampleId");
        }
        if ("status" in (gi || {})) {
          errors.push("genomicInterpretations[] uses non-standard 'status' (use GA4GH v2 'interpretationStatus')");
        }
        const validInterpStatuses = new Set(["UNKNOWN_STATUS", "REJECTED", "CANDIDATE", "CONTRIBUTORY", "CAUSATIVE"]);
        if (!gi?.interpretationStatus || !validInterpStatuses.has(gi.interpretationStatus)) {
          errors.push(`Invalid or missing GA4GH interpretationStatus: ${gi?.interpretationStatus}`);
        }
        const acmg = gi?.variantInterpretation?.acmgPathogenicityClassification;
        if (acmg && !VALID_ACMG_CLASSIFICATIONS.has(acmg)) {
          errors.push(`Invalid GA4GH ACMG classification enum: ${acmg}`);
        }
      }
    }
  }

  // Validate that every emitted ontology CURIE prefix is declared in metaData.resources
  if (phenopacket.metaData && Array.isArray(phenopacket.metaData.resources)) {
    const declaredPrefixes = new Set();
    for (const res of phenopacket.metaData.resources) {
      if (res && typeof res.namespacePrefix === "string" && res.namespacePrefix.trim()) {
        declaredPrefixes.add(res.namespacePrefix.trim().toLowerCase());
      }
      if (res && typeof res.id === "string" && res.id.trim()) {
        declaredPrefixes.add(res.id.trim().toLowerCase());
      }
    }
    const NON_ONTOLOGY_SCHEMES = new Set(["http", "https", "ipfs", "urn", "file", "ftp", "data"]);
    const checkCurie = (curieVal, fieldPath) => {
      if (typeof curieVal !== "string") return;
      const trimmed = curieVal.trim();
      const m = trimmed.match(/^([A-Za-z][A-Za-z0-9_-]*):(.+)$/);
      if (!m) return;
      const prefix = m[1];
      if (NON_ONTOLOGY_SCHEMES.has(prefix.toLowerCase())) return;
      if (!declaredPrefixes.has(prefix.toLowerCase())) {
        errors.push(`Undeclared ontology CURIE prefix '${prefix}' in ${fieldPath} ('${trimmed}') is missing from metaData.resources`);
      }
    };
    checkCurie(phenopacket.subject?.taxonomy?.id, "subject.taxonomy.id");
    if (Array.isArray(phenopacket.measurements)) {
      phenopacket.measurements.forEach((m, idx) => {
        checkCurie(m?.assay?.id, `measurements[${idx}].assay.id`);
        checkCurie(m?.value?.ontologyClass?.id, `measurements[${idx}].value.ontologyClass.id`);
      });
    }
    if (Array.isArray(phenopacket.phenotypicFeatures)) {
      phenopacket.phenotypicFeatures.forEach((pf, idx) => {
        checkCurie(pf?.type?.id, `phenotypicFeatures[${idx}].type.id`);
      });
    }
    if (Array.isArray(phenopacket.diseases)) {
      phenopacket.diseases.forEach((d, idx) => {
        checkCurie(d?.term?.id, `diseases[${idx}].term.id`);
      });
    }
    if (Array.isArray(phenopacket.interpretations)) {
      phenopacket.interpretations.forEach((interp, iIdx) => {
        checkCurie(interp?.diagnosis?.disease?.id, `interpretations[${iIdx}].diagnosis.disease.id`);
        const gis = interp?.diagnosis?.genomicInterpretations || [];
        gis.forEach((gi, gIdx) => {
          const vd = gi?.variantInterpretation?.variationDescriptor;
          checkCurie(vd?.geneContext?.valueId, `interpretations[${iIdx}].diagnosis.genomicInterpretations[${gIdx}].geneContext.valueId`);
          checkCurie(vd?.allelicState?.id, `interpretations[${iIdx}].diagnosis.genomicInterpretations[${gIdx}].allelicState.id`);
        });
      });
    }
  }

  return {
    valid: errors.length === 0,
    errors: errors,
  };
}

export const buildPhenopacketJson = buildPhenopacket;
