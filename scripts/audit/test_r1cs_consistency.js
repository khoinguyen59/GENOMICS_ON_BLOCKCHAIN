/**
 * @file verify_r1cs_consistency.mjs
 * @description CI guard for the zk circuit artifacts. The circuit is NOT compiled by circom in this repo:
 *   scripts/zk/build_groth16_artifacts.mjs renders circuits/genomic_variant_proof.circom and serializes
 *   circuits/build/genomic_variant.r1cs from the SAME JS definition (crypto/zk/groth16_prover.js), and the witness
 *   is also hand-built in JS. This script makes sure those independent artifacts cannot silently drift apart:
 *     1. committed .r1cs header (prime / wires / public+private inputs / constraints) == JS circuit constants
 *     2. committed .r1cs constraints == getCircuitR1csConstraints(), constraint by constraint
 *     3. 91 MiMC round constants in the .circom source == MIMC_ROUND_CONSTANTS used by the JS witness builder
 *     4. an honest witness produced by buildGenomicWitnessBinary() satisfies EVERY constraint of the committed .r1cs
 *     5. tampering with any public signal, or the private secret, violates at least one constraint
 *
 * Usage: node scripts/audit/verify_r1cs_consistency.mjs [path/to/genomic_variant.r1cs] [path/to/genomic_variant_proof.circom]
 * Exit code: 0 = consistent, 1 = at least one check failed.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  R_MOD,
  CIRCUIT_WIRES,
  CIRCUIT_CONSTRAINTS,
  CIRCUIT_PUB_INPUTS,
  CIRCUIT_PRV_INPUTS,
  MIMC_ROUND_CONSTANTS,
  getCircuitR1csConstraints,
  buildGenomicWitnessBinary,
} from "../../crypto/zk/groth16_prover.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const r1csPath = path.resolve(process.argv[2] || path.join(ROOT, "circuits", "build", "genomic_variant.r1cs"));
const circomPath = path.resolve(process.argv[3] || path.join(ROOT, "circuits", "genomic_variant_proof.circom"));

let failures = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`  [${ok ? "PASS" : "FAIL"}] ${name}${detail ? ` -> ${detail}` : ""}`);
};

// ---------- minimal iden3 binary readers ----------
const leToBig = (buf, off, len) => {
  let v = 0n;
  for (let i = len - 1; i >= 0; i--) v = (v << 8n) | BigInt(buf[off + i]);
  return v;
};
function readSections(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const magic = String.fromCharCode(...buf.subarray(0, 4));
  const nSections = dv.getUint32(8, true);
  const sections = new Map();
  let off = 12;
  for (let i = 0; i < nSections; i++) {
    const type = dv.getUint32(off, true);
    const size = Number(dv.getBigUint64(off + 4, true));
    off += 12;
    sections.set(type, { off, size });
    off += size;
  }
  return { magic, sections, dv };
}
function parseR1cs(buf) {
  const { magic, sections, dv } = readSections(buf);
  if (magic !== "r1cs") throw new Error("not an r1cs file");
  const h = sections.get(1).off;
  const fieldSize = dv.getUint32(h, true);
  const prime = leToBig(buf, h + 4, fieldSize);
  const p = h + 4 + fieldSize;
  const header = {
    prime,
    nWires: dv.getUint32(p, true),
    nPubOut: dv.getUint32(p + 4, true),
    nPubIn: dv.getUint32(p + 8, true),
    nPrvIn: dv.getUint32(p + 12, true),
    nConstraints: dv.getUint32(p + 24, true),
  };
  let c = sections.get(2).off;
  const readLc = () => {
    const n = dv.getUint32(c, true);
    c += 4;
    const lc = new Map();
    for (let i = 0; i < n; i++) {
      const wire = dv.getUint32(c, true);
      c += 4;
      const coeff = leToBig(buf, c, fieldSize) % R_MOD;
      c += fieldSize;
      lc.set(wire, ((lc.get(wire) ?? 0n) + coeff) % R_MOD);
    }
    return lc;
  };
  const constraints = [];
  for (let i = 0; i < header.nConstraints; i++) constraints.push([readLc(), readLc(), readLc()]);
  return { header, constraints };
}
function parseWtns(buf) {
  const { magic, sections, dv } = readSections(buf);
  if (magic !== "wtns") throw new Error("not a wtns file");
  const h = sections.get(1).off;
  const n8 = dv.getUint32(h, true);
  const nWitness = dv.getUint32(h + 4 + n8, true);
  const base = sections.get(2).off;
  return Array.from({ length: nWitness }, (_, i) => leToBig(buf, base + i * n8, n8));
}
const normLc = (lc) => {
  const m = new Map();
  for (const [wire, coeff] of lc) m.set(wire, ((m.get(wire) ?? 0n) + (coeff % R_MOD)) % R_MOD);
  return m;
};
const sameLc = (a, b) => {
  const strip = (m) => new Map([...m].filter(([, v]) => v !== 0n));
  const x = strip(a);
  const y = strip(b);
  return x.size === y.size && [...x].every(([k, v]) => y.get(k) === v);
};
const evalLc = (lc, w) => {
  let acc = 0n;
  for (const [wire, coeff] of lc) acc = (acc + coeff * w[wire]) % R_MOD;
  return acc;
};
const unsatisfied = (constraints, w) =>
  constraints.reduce((n, [A, B, C]) => n + ((evalLc(A, w) * evalLc(B, w)) % R_MOD === evalLc(C, w) ? 0 : 1), 0);

// ---------- 1 + 2: committed r1cs vs JS definition ----------
console.log("=== zk circuit artifact consistency ===");
console.log(`r1cs  : ${path.relative(ROOT, r1csPath)}\ncircom: ${path.relative(ROOT, circomPath)}`);
const r1cs = parseR1cs(new Uint8Array(fs.readFileSync(r1csPath)));
check("r1cs prime is the BN254 scalar field", r1cs.header.prime === R_MOD);
check("r1cs wires == CIRCUIT_WIRES", r1cs.header.nWires === CIRCUIT_WIRES, `${r1cs.header.nWires}`);
check("r1cs public inputs == CIRCUIT_PUB_INPUTS", r1cs.header.nPubIn === CIRCUIT_PUB_INPUTS && r1cs.header.nPubOut === 0);
check("r1cs private inputs == CIRCUIT_PRV_INPUTS", r1cs.header.nPrvIn === CIRCUIT_PRV_INPUTS);
check("r1cs constraints == CIRCUIT_CONSTRAINTS", r1cs.header.nConstraints === CIRCUIT_CONSTRAINTS, `${r1cs.header.nConstraints}`);

const jsConstraints = getCircuitR1csConstraints();
let structuralMismatch = -1;
for (let i = 0; i < jsConstraints.length && structuralMismatch < 0; i++) {
  for (let k = 0; k < 3; k++) {
    if (!sameLc(normLc(jsConstraints[i][k]), r1cs.constraints[i]?.[k] ?? new Map())) {
      structuralMismatch = i;
      break;
    }
  }
}
check(
  "every committed r1cs constraint equals getCircuitR1csConstraints()",
  jsConstraints.length === r1cs.constraints.length && structuralMismatch < 0,
  structuralMismatch >= 0 ? `first mismatch at constraint #${structuralMismatch}` : `${jsConstraints.length} constraints`
);

// ---------- 3: circom source constants vs JS ----------
const circomSrc = fs.readFileSync(circomPath, "utf8");
const circomConstants = [...circomSrc.matchAll(/^\s+(\d{10,})\s*,?\s*$/gm)].map((m) => BigInt(m[1]));
check(
  "91 MiMC round constants in .circom == MIMC_ROUND_CONSTANTS",
  circomConstants.length === MIMC_ROUND_CONSTANTS.length && circomConstants.every((c, i) => c === MIMC_ROUND_CONSTANTS[i]),
  `${circomConstants.length} parsed`
);

// ---------- 4 + 5: honest witness satisfies the COMMITTED r1cs; tampering breaks it ----------
const witnessInput = {
  donorAddress: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
  targetTraitId: "0x" + crypto.createHash("sha256").update("audit-trait").digest("hex"),
  witnessSecret: crypto.randomBytes(32).toString("hex"),
  bountyId: 1,
  verifierAddress: "0x5FbDB2315678afecb367f032d93F642f64180aa3",
  chainId: 31337,
  vkEpoch: 1,
};
const built = buildGenomicWitnessBinary(witnessInput);
const w = parseWtns(built.wtns);
check("witness length == CIRCUIT_WIRES", w.length === CIRCUIT_WIRES, `${w.length}`);
check("honest witness satisfies ALL committed r1cs constraints", unsatisfied(r1cs.constraints, w) === 0);
for (const [name, idx] of [["variantCommitment", 1], ["donorTraitBind", 2], ["domainHash", 3], ["witnessSecret", 4]]) {
  const tampered = [...w];
  tampered[idx] = (tampered[idx] + 1n) % R_MOD;
  const bad = unsatisfied(r1cs.constraints, tampered);
  check(`tampering with ${name} violates the r1cs`, bad >= 1, `${bad} constraint(s) unsatisfied`);
}

console.log(failures === 0 ? "\nRESULT: circuit artifacts are consistent." : `\nRESULT: ${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
