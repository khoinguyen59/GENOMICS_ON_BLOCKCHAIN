/**
 * @file pdf_generator.js
 * @description ISO 32000 / PDF-1.4 clinical genomic summary report binary byte generator with XRef table.
 * @module crypto/reporting/pdf_generator
 */

/**
 * Cleanly normalize Vietnamese diacritics and special characters to their
 * clean Latin equivalents for standard PDF-1.4 Type1 / Helvetica font rendering,
 * eliminating corrupt UTF-8 multi-byte mojibake and broken escape sequences.
 * @param {string} str 
 * @returns {string}
 */
export function normalizeVietnameseText(str) {
  if (!str) return "";
  return String(str)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[đĐ]/g, (c) => (c === "đ" ? "d" : "D"))
    .replace(/[^\x20-\x7E\xA0-\xFF]/g, " ");
}

/**
 * Escape string for PDF literal text formatting with full UTF-8 / Vietnamese protection
 * @param {string} str 
 * @returns {string}
 */
export function escapePdfLiteral(str) {
  if (!str) return "";
  const emDashReplaced = String(str)
    .replace(/\u2014/g, "--")
    .replace(/\u2013/g, "-");
  const normalized = normalizeVietnameseText(emDashReplaced);
  return normalized
    .replace(/\\/g, "\\\\")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)");
}

/**
 * Encode a normalized PDF string directly into single-byte /WinAnsiEncoding bytes
 * (code points 0x00..0xFF map 1:1 to single bytes; any code point > 0xFF maps to 0x20),
 * avoiding 2-byte UTF-8 mojibake for \xA0-\xFF characters inside PDF-1.4 Type1 streams.
 * @param {string} str
 * @returns {Uint8Array}
 */
export function encodeWinAnsiBytes(str) {
  const text = String(str ?? "");
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    bytes[i] = code <= 0xff ? code : 0x20;
  }
  return bytes;
}

/**
 * Helvetica advance widths in 1/1000 em for WinAnsi codes 32..255 (codes 127..159 are unused and default to 278).
 * Source: the standard Adobe Helvetica AFM metrics (extracted via ReportLab and cross-checked against pdfminer).
 * Used only to wrap text inside the page margins; the PDF itself references the non-embedded Type1 base font.
 */
const HELVETICA_WIDTHS = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
  1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
  333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,
  556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584, 278,
  278, 278, 278, 278, 278, 278, 278, 278, 278, 278, 278, 278, 278, 278, 278, 278,
  278, 278, 278, 278, 278, 278, 278, 278, 278, 278, 278, 278, 278, 278, 278, 278,
  278, 333, 556, 556, 556, 556, 260, 556, 333, 737, 370, 556, 584, 333, 737, 333,
  400, 584, 333, 333, 333, 556, 537, 278, 333, 333, 365, 556, 834, 834, 834, 611,
  667, 667, 667, 667, 667, 667, 1000, 722, 667, 667, 667, 667, 278, 278, 278, 278,
  722, 722, 778, 778, 778, 778, 778, 584, 778, 722, 722, 722, 722, 667, 667, 611,
  556, 556, 556, 556, 556, 556, 889, 500, 556, 556, 556, 556, 278, 278, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 584, 611, 556, 556, 556, 556, 500, 556, 500,
];

const PAGE_WIDTH_PT = 612;
const PAGE_MARGIN_X_PT = 50;
const PAGE_TOP_Y_PT = 740;
const PAGE_BOTTOM_Y_PT = 50;
const USABLE_WIDTH_PT = PAGE_WIDTH_PT - 2 * PAGE_MARGIN_X_PT;
const MAX_ANNOTATIONS = 4;

export const DEFAULT_REPORT_DISCLAIMER =
  "Research use only. This summary is not a clinical diagnostic report; annotations are not independently validated.";

/** Returns a (text, fontSize) => width-in-points function for the chosen base font. */
function createTextMeasurer(fontName) {
  const isHelvetica = /^Helvetica/i.test(fontName);
  const boldFactor = /bold/i.test(fontName) ? 1.12 : 1;
  return (text, fontSize) => {
    let units = 0;
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      units += isHelvetica
        ? (code >= 32 && code <= 255 ? HELVETICA_WIDTHS[code - 32] : 556) * boldFactor
        : 600; // conservative (Courier-wide) fallback for any other base font
    }
    return (units * fontSize) / 1000;
  };
}

/** Same character folding that escapePdfLiteral() applies, without the PDF escaping (needed before measuring). */
function toPdfPlainText(str) {
  return normalizeVietnameseText(String(str ?? "").replace(/\u2014/g, "--").replace(/\u2013/g, "-"));
}

/**
 * Greedy word wrap on ALREADY-NORMALIZED text. A single token wider than the line is hard-split; when the text needs
 * more than `maxLines` lines the last line is truncated with "...".
 * @param {string} text
 * @param {(text: string) => number} measure width in points of a string at the target font size
 * @param {number} maxWidth available width in points
 * @param {number} [maxLines=Infinity]
 * @returns {string[]} at least one line
 */
export function wrapPdfText(text, measure, maxWidth, maxLines = Infinity) {
  const words = String(text ?? "").split(/\s+/).filter(Boolean);
  let lines = [];
  let line = "";
  const flush = () => { lines.push(line); line = ""; };
  for (let word of words) {
    while (measure(word) > maxWidth && word.length > 1) {
      let cut = 1;
      while (cut < word.length - 1 && measure(word.slice(0, cut + 1)) <= maxWidth) cut++;
      if (line) flush();
      lines.push(word.slice(0, cut));
      word = word.slice(cut);
    }
    const candidate = line ? `${line} ${word}` : word;
    if (line && measure(candidate) > maxWidth) {
      flush();
      line = word;
    } else {
      line = candidate;
    }
  }
  if (line) flush();
  if (lines.length === 0) lines = [""];
  if (lines.length > maxLines) {
    lines = lines.slice(0, maxLines);
    let last = lines[maxLines - 1];
    while (last.length > 0 && measure(`${last}...`) > maxWidth) last = last.slice(0, -1);
    lines[maxLines - 1] = `${last}...`;
  }
  return lines;
}

const orNotSpecified = (value) =>
  value === undefined || value === null || String(value).trim() === "" ? "Not specified" : value;

/**
 * Generate a valid, renderable PDF 1.4 genomic summary report (research use).
 * Long values are wrapped inside the page margins (never clipped); nothing in the report is hard-coded to a particular gene.
 * @param {Object} params
 * @param {string} [params.subjectId] Patient pseudonym ("Not specified" when empty)
 * @param {string} [params.disease] Indication / cohort / trait ("Not specified" when empty)
 * @param {string} [params.gene] Analyzed gene ("Not specified" when empty)
 * @param {string} [params.variant] Variant notation ("Not specified" when empty)
 * @param {string} [params.date] Report issue date (defaults to today, UTC)
 * @param {string} [params.fontName="Helvetica"] Base Type1 font name
 * @param {string[]} [params.annotations] Caller-supplied interpretation lines (max 4); a neutral notice is printed when omitted
 * @param {{rawDataHash?: string, rawCid?: string, chainId?: (string|number), txHash?: string, issuer?: string}} [params.integrity]
 *        Optional on-chain anchor values printed in the footer so the report can be checked against the chain.
 * @param {string} [params.disclaimer] Disclaimer line (defaults to a research-use-only notice)
 * @returns {Uint8Array} Valid ISO 32000 / PDF-1.4 binary bytes
 */
export function generateClinicalPdfReport({
  subjectId,
  disease,
  gene,
  variant,
  date = new Date().toISOString().split("T")[0],
  fontName = "Helvetica",
  annotations = null,
  integrity = null,
  disclaimer = DEFAULT_REPORT_DISCLAIMER,
} = {}) {
  const safeFontName = String(fontName || "Helvetica").replace(/[^A-Za-z0-9-]/g, "") || "Helvetica";
  const measureText = createTextMeasurer(safeFontName);

  const ops = [];
  let y = PAGE_TOP_Y_PT;
  // Emits one wrapped paragraph; `after` is the extra gap below its last line.
  const block = (text, size, { after = size + 8, indent = 0, maxLines = 2 } = {}) => {
    const lines = wrapPdfText(
      toPdfPlainText(text),
      (t) => measureText(t, size),
      USABLE_WIDTH_PT - indent,
      maxLines
    );
    const step = Math.round(size * 1.3);
    lines.forEach((ln, i) => {
      if (y >= PAGE_BOTTOM_Y_PT) {
        ops.push("BT", `/F1 ${size} Tf`, `1 0 0 1 ${PAGE_MARGIN_X_PT + indent} ${y} Tm`, `(${escapePdfLiteral(ln)}) Tj`, "ET");
      }
      y -= i < lines.length - 1 ? step : after;
    });
  };

  block("MOLECULAR GENOMICS & BIO-INFORMATICS SUMMARY", 18, { after: 30, maxLines: 2 });
  block(`Report Date: ${orNotSpecified(date)}`, 11, { after: 20 });
  block(`Sample Pseudonym ID: ${orNotSpecified(subjectId)}`, 11, { after: 20 });
  block(`Genomic Cohort / Trait: ${orNotSpecified(disease)}`, 11, { after: 20 });
  block(`Target Locus / Gene: ${orNotSpecified(gene)}`, 11, { after: 20 });
  block(`Identified Molecular Variant: ${orNotSpecified(variant)}`, 11, { after: 30 });

  block("MOLECULAR INTERPRETATION & ANNOTATION:", 12, { after: 20 });
  const suppliedAnnotations = Array.isArray(annotations)
    ? annotations.map((a) => String(a ?? "").trim()).filter(Boolean).slice(0, MAX_ANNOTATIONS)
    : [];
  const interpretation = suppliedAnnotations.length
    ? suppliedAnnotations
    : ["No variant-specific interpretation was supplied; this summary lists the submitted identifiers only."];
  interpretation.push("Sequencing data is client-side encrypted with AES-256-GCM and pinned to IPFS.");
  interpretation.forEach((text, idx) => block(`${idx + 1}. ${text}`, 10, { after: 18, indent: 0, maxLines: 2 }));

  y -= 12; // extra gap before the footer
  block(disclaimer, 9, { after: 14, maxLines: 2 });

  const anchor = integrity && typeof integrity === "object" ? integrity : {};
  const anchorRows = [
    ["SHA-256 of encrypted package", anchor.rawDataHash],
    ["IPFS CID", anchor.rawCid],
    ["Chain ID", anchor.chainId],
    ["Anchor transaction", anchor.txHash],
    ["Issuer", anchor.issuer],
  ].filter(([, v]) => v !== undefined && v !== null && String(v).trim() !== "");
  if (anchorRows.length === 0) {
    block(
      "Integrity: a SHA-256 digest of the encrypted package is recorded on an EVM blockchain (digest not embedded in this report).",
      8,
      { after: 12, maxLines: 2 }
    );
  } else {
    block("Integrity anchor (SHA-256 of the encrypted package is recorded on an EVM blockchain):", 8, { after: 12, maxLines: 2 });
    anchorRows.forEach(([label, value]) => block(`${label}: ${value}`, 8, { after: 12, maxLines: 2 }));
  }

  const content = ops.join("\n");

  const getByteLen = (str) => encodeWinAnsiBytes(str).length;
  const streamBytes = encodeWinAnsiBytes(content);

  const obj1 = "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n";
  const obj2 = "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n";
  const obj3 =
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n";
  const obj4 = `4 0 obj\n<< /Length ${streamBytes.length} >>\nstream\n${content}\nendstream\nendobj\n`;
  const obj5 = `5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /${safeFontName} /Encoding /WinAnsiEncoding >>\nendobj\n`;

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
  return encodeWinAnsiBytes(fullPdf);
}