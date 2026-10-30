/**
 * @file pdf_generator.js
 * @description ISO 32000 / PDF-1.4 clinical genomic summary report binary byte generator with XRef table.
 * @module crypto/reporting/pdf_generator
 */

import { computeDataHash } from "../core/symmetric.js";

/**
 * Escape string for PDF literal text formatting
 * @param {string} str 
 * @returns {string}
 */
function escapePdfLiteral(str) {
  if (!str) return "";
  return String(str)
    .replace(/—/g, "--")
    .replace(/\\/g, "\\\\")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)");
}

/**
 * Generate a valid, renderable PDF 1.4 clinical genomic summary report
 * @param {Object} params
 * @param {string} [params.subjectId="1000G_KHV_01"] Patient pseudonym
 * @param {string} [params.disease="1000 Genomes Project -- Population Genomic Variation (KHV Cohort)"] Indication or condition
 * @param {string} [params.gene="ALDH2"] Analyzed gene
 * @param {string} [params.variant="rs671 (c.1510G>A, p.Glu504Lys)"] Pathogenic variant notation
 * @param {string} [params.date] Report issue date
 * @returns {Uint8Array} Valid ISO 32000 / PDF-1.4 binary bytes
 */
export function generateClinicalPdfReport({
  subjectId = "1000G_KHV_01",
  disease = "1000 Genomes Project -- Population Genomic Variation (KHV Cohort)",
  gene = "ALDH2",
  variant = "rs671 (c.1510G>A, p.Glu504Lys)",
  date = new Date().toISOString().split("T")[0],
} = {}) {
  const safeSubjectId = escapePdfLiteral(subjectId);
  const safeDisease = escapePdfLiteral(disease);
  const safeGene = escapePdfLiteral(gene);
  const safeVariant = escapePdfLiteral(variant);
  const safeDate = escapePdfLiteral(date);

  const content = [
    "BT",
    "/F1 18 Tf",
    "50 740 Td",
    "(MOLECULAR GENOMICS & BIO-INFORMATICS SUMMARY) Tj",
    "0 -30 Td",
    "/F1 11 Tf",
    `(Report Date: ${safeDate}) Tj`,
    "0 -20 Td",
    `(Sample Pseudonym ID: ${safeSubjectId}) Tj`,
    "0 -20 Td",
    `(Genomic Cohort / Trait: ${safeDisease}) Tj`,
    "0 -20 Td",
    `(Target Locus / Gene: ${safeGene}) Tj`,
    "0 -20 Td",
    `(Identified Molecular Variant: ${safeVariant}) Tj`,
    "0 -30 Td",
    "/F1 12 Tf",
    "(MOLECULAR INTERPRETATION & ANNOTATION:) Tj",
    "0 -20 Td",
    "/F1 10 Tf",
    "(1. Molecular variant catalogued in 1000 Genomes Project & dbSNP benchmark.) Tj",
    "0 -18 Td",
    "(2. Functional metabolic polymorphism associated with enzyme activity.) Tj",
    "0 -18 Td",
    "(3. Sequencing data is client-side encrypted with AES-256-GCM and pinned to IPFS.) Tj",
    "0 -30 Td",
    "/F1 9 Tf",
    "(Integrity Verification: SHA-256 Authenticated Ciphertext on EVM Blockchain) Tj",
    "ET",
  ].join("\n");

  const encoder = new TextEncoder();
  const getByteLen = (str) => encoder.encode(str).length;

  const streamBytes = encoder.encode(content);

  const obj1 = "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n";
  const obj2 = "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n";
  const obj3 =
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n";
  const obj4 = `4 0 obj\n<< /Length ${streamBytes.length} >>\nstream\n${content}\nendstream\nendobj\n`;
  const obj5 = "5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n";

  const header = "%PDF-1.4\n";
  const offset1 = getByteLen(header);
  const offset2 = offset1 + getByteLen(obj1);
  const offset3 = offset2 + getByteLen(obj2);
  const offset4 = offset3 + getByteLen(obj3);
  const offset5 = offset4 + getByteLen(obj4);
  const xrefOffset = offset5 + getByteLen(obj5);

  const pad = (n) => n.toString().padStart(10, "0");
  const xref = [
    "xref",
    "0 6",
    "0000000000 65535 f ",
    `${pad(offset1)} 00000 n `,
    `${pad(offset2)} 00000 n `,
    `${pad(offset3)} 00000 n `,
    `${pad(offset4)} 00000 n `,
    `${pad(offset5)} 00000 n `,
  ].join("\n");

  const trailer = `\ntrailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  const fullPdf = header + obj1 + obj2 + obj3 + obj4 + obj5 + xref + trailer;
  return new TextEncoder().encode(fullPdf);
}
