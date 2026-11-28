/**
 * @file groth16_prover.js
 * @description Browser-native & Node-compatible BN254 Groth16 R1CS witness evaluator
 *              and proof formatter for GenoChain zk-Genomics (zero trapdoor secrets,
 *              zero unconstrained slack variables).
 *
 * Implements the exact 366-constraint R1CS circuit defined in
 * circuits/genomic_variant_proof.circom:
 *   - 3 Public inputs verified on-chain via GenomicZkVerifier.setupVerificationKeyV2:
 *       pub[0] = variantCommitment  (< R_MOD, exact MiMC-7 Miyaguchi-Preneel hash)
 *       pub[1] = donorTraitBind     = keccak256(targetTraitId || donorAddress) % R_MOD
 *       pub[2] = domainHash         = keccak256(targetTraitId || donor || bountyId || verifier || chainId || vkEpoch) % R_MOD
 *   - 2 Private inputs:
 *       witnessSecret, witnessSecretInv (proves witnessSecret != 0)
 *   - 91-round BN254 MiMC-7 (x^7, gcd(7, R_MOD - 1) == 1) Miyaguchi-Preneel hash:
 *       x_91 + donorTraitBind + witnessSecret === variantCommitment
 *   - Quadratic domain-binding constraint:
 *       domainHash * witnessSecret === domainBind
 */
import { ethers } from "ethers";

export const R_MOD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
export const MIMC_ROUNDS = 91;
export const CIRCUIT_PUB_INPUTS = 3; // wires 1..3: variantCommitment, donorTraitBind, domainHash
export const CIRCUIT_PRV_INPUTS = 2; // wires 4..5: witnessSecret, witnessSecretInv
export const CIRCUIT_WIRES = 370;    // 0:ONE, 1..3:pubIn, 4..5:prvIn, 6..368:91 rounds MiMC-7, 369:domainBind
export const CIRCUIT_CONSTRAINTS = 366; // 1 non-zero guard + 91*4 MiMC-7 gates + 1 domainBind gate

/** BN254 BASE-field prime p: the coordinates of G1/G2 proof points live in Fq (not in the scalar field R_MOD). */
export const P_MOD = 21888242871839275222246405745257275088696311157297823662689037894645226208583n;

const UINT256_LIMIT = 1n << 256n;
const INTEGER_STRING_RE = /^(?:0x[0-9a-fA-F]+|[0-9]+)$/;

/**
 * Strict conversion of a bigint | safe-integer number | decimal / 0x-hex string to BigInt.
 * Returns null (never throws) so each caller can raise its own, readable error.
 * Unlike Number(x), a non-numeric string can never slip through as NaN.
 */
function toBigIntStrict(value) {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") return Number.isSafeInteger(value) ? BigInt(value) : null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    return INTEGER_STRING_RE.test(trimmed) ? BigInt(trimmed) : null;
  }
  return null;
}

/** Validates an unsigned 256-bit integer (bountyId / chainId / vkEpoch ...) and returns it as BigInt. */
export function toUint256(value, label = "value") {
  const big = toBigIntStrict(value);
  if (big === null || big < 0n || big >= UINT256_LIMIT) {
    throw new Error(`Invalid ${label}: expected an unsigned 256-bit integer.`);
  }
  return big;
}

/** Validates a bounty id (integer >= 1). Rejects "abc", "1.5", NaN, negatives and unsafe floats. */
export function parseBountyId(value) {
  const big = toBigIntStrict(value);
  if (big === null || big < 1n || big >= UINT256_LIMIT) {
    throw new Error("Valid bountyId (>= 1) is required.");
  }
  return big;
}

/** Number when it is exactly representable, decimal string otherwise (Number() would silently round). */
function bountyIdForReport(big) {
  return big <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(big) : big.toString();
}

function parseBn254BaseFieldElement(value, label) {
  const big = toBigIntStrict(value);
  if (big === null || big < 0n || big >= P_MOD) {
    throw new Error(`Invalid Groth16 proof: ${label} must be an integer in [0, p) of the BN254 base field.`);
  }
  return big.toString();
}

function parseOptionalSafeInteger(value, label, min) {
  if (value === undefined || value === null || value === "") return null;
  const big = toBigIntStrict(value);
  if (big === null || big < BigInt(min) || big > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`Invalid External Groth16 Proof JSON: ${label} must be an integer >= ${min} (and a safe integer).`);
  }
  return Number(big);
}

export const MIMC_ROUND_CONSTANTS = Array.from({ length: MIMC_ROUNDS }, (_, i) =>
  BigInt(ethers.keccak256(ethers.toUtf8Bytes(`GENOCHAIN_MIMC7_BN254_R${i}`))) % R_MOD
);

function frMod(x) {
  const r = x % R_MOD;
  return r >= 0n ? r : r + R_MOD;
}

function frPow(base, exp) {
  let res = 1n;
  let b = frMod(base);
  let e = exp;
  while (e > 0n) {
    if (e & 1n) res = (res * b) % R_MOD;
    b = (b * b) % R_MOD;
    e >>= 1n;
  }
  return res;
}

function frInv(a) {
  const v = frMod(a);
  if (v === 0n) throw new Error("Cannot invert zero in BN254 scalar field Fr.");
  return frPow(v, R_MOD - 2n);
}

function writeUint32LE(buf, offset, val) {
  buf[offset] = val & 0xff;
  buf[offset + 1] = (val >>> 8) & 0xff;
  buf[offset + 2] = (val >>> 16) & 0xff;
  buf[offset + 3] = (val >>> 24) & 0xff;
}

function writeUint64LE(buf, offset, valBig) {
  let v = BigInt(valBig);
  for (let i = 0; i < 8; i++) {
    buf[offset + i] = Number(v & 0xffn);
    v >>= 8n;
  }
}

export function writeBigIntLE(buf, offset, valBig) {
  let v = BigInt(valBig);
  for (let i = 0; i < 32; i++) {
    buf[offset + i] = Number(v & 0xffn);
    v >>= 8n;
  }
}

export function writeFieldLE(buf, offset, fieldBig) {
  writeBigIntLE(buf, offset, frMod(BigInt(fieldBig)));
}

/**
 * Derives a non-zero BN254 scalar field element from a donor's private witness secret string.
 */
export function deriveWitnessSecretField(witnessSecret) {
  if (typeof witnessSecret !== "string" || witnessSecret.trim().length === 0) {
    throw new Error("Non-empty witnessSecret preimage is required to generate a Groth16 proof.");
  }
  let s =
    BigInt(ethers.keccak256(ethers.toUtf8Bytes(`GENOCHAIN_SECRET_FIELD_V1:${witnessSecret}`))) % R_MOD;
  if (s === 0n) s = 1n;
  return s;
}

/**
 * Computes pub[1] = keccak256(targetTraitId || donorAddress) % R_MOD, matching GenomicZkVerifier.sol.
 */
export function computeDonorTraitBind(donorAddress, targetTraitId) {
  if (!donorAddress || !ethers.isAddress(donorAddress)) {
    throw new Error("Valid donorAddress is required for ZK witness commitment.");
  }
  if (!targetTraitId || !/^0x[0-9a-fA-F]{64}$/.test(String(targetTraitId))) {
    throw new Error("Valid bytes32 targetTraitId is required for ZK witness commitment.");
  }
  return (
    BigInt(
      ethers.keccak256(
        ethers.solidityPacked(["bytes32", "address"], [targetTraitId, ethers.getAddress(donorAddress)])
      )
    ) % R_MOD
  );
}

/**
 * Computes pub[2] = keccak256(targetTraitId || donor || bountyId || verifier || chainId || vkEpoch) % R_MOD,
 * matching GenomicZkVerifier.sol.
 */
export function computeDomainHash({
  targetTraitId,
  donorAddress,
  bountyId,
  verifierAddress,
  chainId = 31337,
  vkEpoch = 1,
}) {
  const packed = ethers.solidityPacked(
    ["bytes32", "address", "uint256", "address", "uint256", "uint256"],
    [
      targetTraitId,
      ethers.getAddress(donorAddress),
      toUint256(bountyId, "bountyId"),
      ethers.getAddress(verifierAddress),
      toUint256(chainId, "chainId"),
      toUint256(vkEpoch, "vkEpoch"),
    ]
  );
  return BigInt(ethers.keccak256(packed)) % R_MOD;
}

/**
 * Evaluates the 91-round BN254 MiMC-7 (x^7) Miyaguchi-Preneel hash over Fr:
 *   x_0 = witnessSecret + donorTraitBind
 *   x_{i+1} = (x_i + witnessSecret + C[i])^7   for i = 0..90
 *   H = x_91 + donorTraitBind + witnessSecret  (mod R_MOD)
 */
export function evalMimc7MiyaguchiPreneel(witnessSecretField, donorTraitBind) {
  let curX = frMod(witnessSecretField + donorTraitBind);
  for (let i = 0; i < MIMC_ROUNDS; i++) {
    const u = frMod(curX + witnessSecretField + MIMC_ROUND_CONSTANTS[i]);
    const t2 = frMod(u * u);
    const t4 = frMod(t2 * t2);
    const t6 = frMod(t4 * t2);
    curX = frMod(t6 * u);
  }
  return frMod(curX + donorTraitBind + witnessSecretField);
}

/**
 * Canonical zero-knowledge witness commitment (< R_MOD, 32-byte 0x hex):
 *   bytes32(MiMC7_MP_91(deriveWitnessSecretField(witnessSecret), keccak256(targetTraitId || donor) % R_MOD))
 */
export function computeDonorWitnessCommitment(donorAddress, targetTraitId, witnessSecret) {
  const secretField = deriveWitnessSecretField(witnessSecret);
  const donorTraitBind = computeDonorTraitBind(donorAddress, targetTraitId);
  const commitmentFr = evalMimc7MiyaguchiPreneel(secretField, donorTraitBind);
  return ethers.zeroPadValue(ethers.toBeHex(commitmentFr), 32);
}

/**
 * Backward-compatible alias for legacy callers computing domain context hash.
 */
export function computePublicSignalBound({
  targetTraitId,
  donorAddress,
  bountyId,
  verifierAddress,
  chainId = 31337,
  vkEpoch = 1,
}) {
  return computeDomainHash({
    targetTraitId,
    donorAddress,
    bountyId,
    verifierAddress,
    chainId,
    vkEpoch,
  });
}

/**
 * Returns the exact 366 R1CS constraints [A, B, C] matching circuits/genomic_variant_proof.circom.
 * Every linear combination is sorted by strictly ascending wireId, with ZERO unconstrained slack variables.
 */
export function getCircuitR1csConstraints() {
  const constraints = [];
  // Wire indices:
  // 0 = 1
  // 1 = variantCommitment (pub[0])
  // 2 = donorTraitBind    (pub[1])
  // 3 = domainHash        (pub[2])
  // 4 = witnessSecret     (prv[0])
  // 5 = witnessSecretInv  (prv[1])
  // round i (0..89): t2=6+4i, t4=7+4i, t6=8+4i, x_{i+1}=9+4i
  // round 90 (final): t2=366, t4=367, t6=368 (output directly constrained to w1 - w2 - w4)
  // 369 = domainBind

  // Constraint 0: witnessSecret * witnessSecretInv === 1
  constraints.push([
    [[4, 1n]],
    [[5, 1n]],
    [[0, 1n]],
  ]);

  // Constraints 1..364: 91 rounds of BN254 MiMC-7 (x^7) + Miyaguchi-Preneel feedforward on final gate
  const NEG_ONE = R_MOD - 1n;
  for (let i = 0; i < MIMC_ROUNDS; i++) {
    const c = MIMC_ROUND_CONSTANTS[i];
    const base = 6 + 4 * i;
    const t2Wire = base;
    const t4Wire = base + 1;
    const t6Wire = base + 2;

    let uTerms;
    if (i === 0) {
      // u_0 = (w4 + w2) + w4 + c = c*1 + 1*w2 + 2*w4
      uTerms = [
        [0, c],
        [2, 1n],
        [4, 2n],
      ];
    } else {
      const prevXWire = 9 + 4 * (i - 1);
      // u_i = c*1 + 1*w4 + 1*x_i
      uTerms = [
        [0, c],
        [4, 1n],
        [prevXWire, 1n],
      ];
    }

    // t2 === u * u
    constraints.push([uTerms, uTerms, [[t2Wire, 1n]]]);
    // t4 === t2 * t2
    constraints.push([[[t2Wire, 1n]], [[t2Wire, 1n]], [[t4Wire, 1n]]]);
    // t6 === t4 * t2
    constraints.push([[[t4Wire, 1n]], [[t2Wire, 1n]], [[t6Wire, 1n]]]);

    if (i < MIMC_ROUNDS - 1) {
      const nextXWire = base + 3;
      // x_{i+1} === t6 * u
      constraints.push([[[t6Wire, 1n]], uTerms, [[nextXWire, 1n]]]);
    } else {
      // Final Miyaguchi-Preneel constraint (ZERO slack variables):
      // t6_90 * u_90 === variantCommitment(w1) - donorTraitBind(w2) - witnessSecret(w4)
      constraints.push([
        [[t6Wire, 1n]],
        uTerms,
        [
          [1, 1n],
          [2, NEG_ONE],
          [4, NEG_ONE],
        ],
      ]);
    }
  }

  // Constraint 365: domainHash * witnessSecret === domainBind (wire 369)
  constraints.push([
    [[3, 1n]],
    [[4, 1n]],
    [[369, 1n]],
  ]);

  return constraints;
}

/**
 * Evaluates the witness assignment w[0..369], verifies all 366 R1CS constraints locally,
 * and serializes an iden3 v2 `.wtns` binary Uint8Array consumable by snarkjs.groth16.prove.
 */
export function buildGenomicWitnessBinary({
  donorAddress,
  targetTraitId,
  witnessSecret,
  variantCommitment = null,
  bountyId,
  verifierAddress,
  chainId = 31337,
  vkEpoch = 1,
}) {
  const bountyIdValue = parseBountyId(bountyId);
  if (!verifierAddress || !ethers.isAddress(verifierAddress)) {
    throw new Error("Valid verifierAddress is required.");
  }

  const secretField = deriveWitnessSecretField(witnessSecret);
  const witnessSecretInv = frInv(secretField);
  const donorTraitBind = computeDonorTraitBind(donorAddress, targetTraitId);
  const expectedCommitmentFr = evalMimc7MiyaguchiPreneel(secretField, donorTraitBind);
  const expectedCommitmentHex = ethers.zeroPadValue(ethers.toBeHex(expectedCommitmentFr), 32);

  if (variantCommitment !== null && variantCommitment !== undefined && String(variantCommitment).trim() !== "") {
    if (!/^0x[0-9a-fA-F]{64}$/.test(String(variantCommitment))) {
      throw new Error("Invalid variantCommitment: expected 32-byte 0x-prefixed hex.");
    }
    if (String(variantCommitment).toLowerCase() !== expectedCommitmentHex.toLowerCase()) {
      throw new Error("Witness preimage binding failed: witnessSecret does not match variantCommitment.");
    }
  }

  const domainHash = computeDomainHash({
    targetTraitId,
    donorAddress,
    bountyId: bountyIdValue,
    verifierAddress,
    chainId,
    vkEpoch,
  });

  const w = new Array(CIRCUIT_WIRES).fill(0n);
  w[0] = 1n;
  w[1] = expectedCommitmentFr;
  w[2] = donorTraitBind;
  w[3] = domainHash;
  w[4] = secretField;
  w[5] = witnessSecretInv;

  let curX = frMod(secretField + donorTraitBind);
  for (let i = 0; i < MIMC_ROUNDS; i++) {
    const u = frMod(curX + secretField + MIMC_ROUND_CONSTANTS[i]);
    const t2 = frMod(u * u);
    const t4 = frMod(t2 * t2);
    const t6 = frMod(t4 * t2);
    const nextX = frMod(t6 * u);
    const base = 6 + 4 * i;
    w[base] = t2;
    w[base + 1] = t4;
    w[base + 2] = t6;
    if (i < MIMC_ROUNDS - 1) {
      w[base + 3] = nextX;
    }
    curX = nextX;
  }
  w[369] = frMod(domainHash * secretField);

  // Strict local R1CS constraint verification before invoking Groth16 prover
  const evalLC = (lc) => {
    let acc = 0n;
    for (const [wire, coeff] of lc) {
      acc = frMod(acc + frMod(coeff * w[wire]));
    }
    return acc;
  };
  const constraints = getCircuitR1csConstraints();
  for (let idx = 0; idx < constraints.length; idx++) {
    const [A, B, C] = constraints[idx];
    if (frMod(evalLC(A) * evalLC(B)) !== evalLC(C)) {
      throw new Error(`R1CS constraint #${idx} unsatisfied during witness generation.`);
    }
  }

  // Serialize iden3 wtns v2 binary format
  const sec1Size = 4 + 32 + 4;
  const sec2Size = CIRCUIT_WIRES * 32;
  const totalSize = 12 + (12 + sec1Size) + (12 + sec2Size);
  const wtns = new Uint8Array(totalSize);
  let off = 0;

  // Header "wtns"
  wtns[0] = 0x77; wtns[1] = 0x74; wtns[2] = 0x6e; wtns[3] = 0x73;
  off = 4;
  writeUint32LE(wtns, off, 2); off += 4;
  writeUint32LE(wtns, off, 2); off += 4;

  // Section 1: Metadata
  writeUint32LE(wtns, off, 1); off += 4;
  writeUint64LE(wtns, off, BigInt(sec1Size)); off += 8;
  writeUint32LE(wtns, off, 32); off += 4;
  writeBigIntLE(wtns, off, R_MOD); off += 32;
  writeUint32LE(wtns, off, CIRCUIT_WIRES); off += 4;

  // Section 2: Witness assignments
  writeUint32LE(wtns, off, 2); off += 4;
  writeUint64LE(wtns, off, BigInt(sec2Size)); off += 8;
  for (let i = 0; i < CIRCUIT_WIRES; i++) {
    writeFieldLE(wtns, off, w[i]);
    off += 32;
  }

  return {
    wtns,
    publicSignals: [expectedCommitmentFr, donorTraitBind, domainHash],
    publicSignal: domainHash,
    variantCommitment: expectedCommitmentHex,
  };
}

/**
 * Converts a snarkjs Groth16 proof object into GenomicZkVerifier.ZkProof (EIP-197 G2 order).
 */
export function formatSnarkjsProofForSolidity(snarkProof) {
  if (!snarkProof?.pi_a || !snarkProof?.pi_b || !snarkProof?.pi_c) {
    throw new Error("Invalid snarkjs Groth16 proof payload.");
  }
  return {
    a: [String(snarkProof.pi_a[0]), String(snarkProof.pi_a[1])],
    // snarkjs outputs G2 as [[x_re, x_im], [y_re, y_im]]; EIP-197 expects [[x_im, x_re], [y_im, y_re]]
    b: [
      [String(snarkProof.pi_b[0][1]), String(snarkProof.pi_b[0][0])],
      [String(snarkProof.pi_b[1][1]), String(snarkProof.pi_b[1][0])],
    ],
    c: [String(snarkProof.pi_c[0]), String(snarkProof.pi_c[1])],
  };
}

/**
 * Converts 3-public-input snarkjs verification_key.json into GenomicZkVerifier.setupVerificationKeyV2 arguments.
 */
export function formatVerificationKeyForSolidity(vk) {
  if (
    !vk?.vk_alpha_1 ||
    !vk?.vk_beta_2 ||
    !vk?.vk_gamma_2 ||
    !vk?.vk_delta_2 ||
    !Array.isArray(vk?.IC) ||
    vk.IC.length < 4
  ) {
    throw new Error("Invalid 3-public-input snarkjs verification_key.json structure (expected IC.length >= 4).");
  }
  const g1 = (pt) => [BigInt(pt[0]), BigInt(pt[1])];
  const g2Eip197 = (pt) => [
    [BigInt(pt[0][1]), BigInt(pt[0][0])],
    [BigInt(pt[1][1]), BigInt(pt[1][0])],
  ];
  return {
    alpha: g1(vk.vk_alpha_1),
    beta: g2Eip197(vk.vk_beta_2),
    gamma: g2Eip197(vk.vk_gamma_2),
    delta: g2Eip197(vk.vk_delta_2),
    ic0: g1(vk.IC[0]),
    ic1: g1(vk.IC[1]),
    ic2: g1(vk.IC[2]),
    ic3: g1(vk.IC[3]),
  };
}

/**
 * Cleanly terminates any cached ffjavascript BN254 worker pool on globalThis.curve_bn128
 * so Node.js test runners and CLI scripts exit immediately without hanging.
 */
export async function terminateGroth16Prover() {
  if (typeof globalThis !== "undefined" && globalThis.curve_bn128) {
    try {
      await globalThis.curve_bn128.terminate?.();
    } catch {}
    try {
      delete globalThis.curve_bn128;
    } catch {}
  }
}

/**
 * Generates an authentic BN254 Groth16 proof via snarkjs using ONLY the public .zkey proving key
 * (zero trapdoor scalars) — runs identically in browser (vite dev & vite preview) and Node.js.
 */
export async function generateGroth16ProofWithZkey({
  snarkjs,
  zkeySource,
  donorAddress,
  targetTraitId,
  witnessSecret,
  variantCommitment = null,
  bountyId,
  verifierAddress,
  chainId = 31337,
  vkEpoch = 1,
}) {
  if (!snarkjs?.groth16?.prove) {
    throw new Error("snarkjs.groth16.prove is required to generate a Groth16 proof.");
  }
  const { wtns, publicSignal, variantCommitment: boundCommitment } = buildGenomicWitnessBinary({
    donorAddress,
    targetTraitId,
    witnessSecret,
    variantCommitment,
    bountyId,
    verifierAddress,
    chainId,
    vkEpoch,
  });

  // Use singleThread mode so proving runs cleanly without COOP/COEP SharedArrayBuffer requirements
  // in vite preview browsers and never leaks background worker threads in Node.js.
  // Scrub private witness bytes in finally so secret preimage material never lingers on the JS heap.
  let snarkProof;
  let publicSignals;
  try {
    ({ proof: snarkProof, publicSignals } = await snarkjs.groth16.prove(
      zkeySource,
      wtns,
      undefined,
      { singleThread: true }
    ));
  } finally {
    if (wtns && typeof wtns.fill === "function") {
      wtns.fill(0);
    }
  }
  const solProof = formatSnarkjsProofForSolidity(snarkProof);

  return {
    proof: solProof,
    snarkjsProof: snarkProof,
    publicSignals,
    variantCommitment: boundCommitment,
    publicSignal: publicSignal.toString(),
    bountyId: bountyIdForReport(parseBountyId(bountyId)),
    vkEpoch: Number(vkEpoch),
    protocol: "groth16",
    curve: "bn128",
  };
}

/**
 * Parses an external Groth16 proof JSON payload (either Solidity-formatted { a, b, c }
 * or raw snarkjs { pi_a, pi_b, pi_c } output) into canonical EIP-197 G2 coordinate order.
 */
export function parseExternalGroth16Proof(explicitProofInput) {
  let rawObj = explicitProofInput;
  if (typeof explicitProofInput === "string") {
    try {
      rawObj = JSON.parse(explicitProofInput.trim());
    } catch {
      throw new Error("Invalid External Groth16 Proof JSON: malformed JSON syntax.");
    }
  }
  if (!rawObj || typeof rawObj !== "object") {
    throw new Error("Invalid External Groth16 Proof JSON: expected JSON object.");
  }
  const p = rawObj.proof || rawObj;
  const isRawSnarkjs = !p.b && Boolean(p.pi_b);
  const a = p.a || p.pi_a;
  const b = p.b || p.pi_b;
  const c = p.c || p.pi_c;
  if (
    !Array.isArray(a) || a.length < 2 ||
    !Array.isArray(b) || b.length < 2 || !Array.isArray(b[0]) || b[0].length < 2 || !Array.isArray(b[1]) || b[1].length < 2 ||
    !Array.isArray(c) || c.length < 2
  ) {
    throw new Error("Invalid Groth16 proof structure: expected { proof: { a: [2], b: [[2],[2]], c: [2] } }.");
  }
  // snarkjs outputs G2 as [[x_re, x_im], [y_re, y_im]]; EIP-197 expects [[x_im, x_re], [y_im, y_re]]
  const coord = (value, label) => parseBn254BaseFieldElement(value, label);
  const normalizedB = isRawSnarkjs
    ? [
        [coord(b[0][1], "b[0][1]"), coord(b[0][0], "b[0][0]")],
        [coord(b[1][1], "b[1][1]"), coord(b[1][0], "b[1][0]")],
      ]
    : [
        [coord(b[0][0], "b[0][0]"), coord(b[0][1], "b[0][1]")],
        [coord(b[1][0], "b[1][0]"), coord(b[1][1], "b[1][1]")],
      ];
  const rawComm =
    typeof rawObj.variantCommitment === "string" ? rawObj.variantCommitment.trim() : "";
  let parsedCommitment =
    /^0x[0-9a-fA-F]{64}$/.test(rawComm) && !/^0x0{64}$/.test(rawComm)
      ? rawComm
      : null;
  if (!parsedCommitment && Array.isArray(rawObj.publicSignals) && rawObj.publicSignals.length >= 1) {
    const rawPub0 = rawObj.publicSignals[0];
    const cleanPub0 = typeof rawPub0 === "string" ? rawPub0.trim() : rawPub0;
    if (cleanPub0 !== "" && cleanPub0 !== null && cleanPub0 !== undefined) {
      try {
        const pub0 = BigInt(cleanPub0);
        if (pub0 > 0n && pub0 < R_MOD) {
          parsedCommitment = `0x${pub0.toString(16).padStart(64, "0")}`;
        }
      } catch {}
    }
  }
  return {
    proof: {
      a: [coord(a[0], "a[0]"), coord(a[1], "a[1]")],
      b: normalizedB,
      c: [coord(c[0], "c[0]"), coord(c[1], "c[1]")],
    },
    variantCommitment: parsedCommitment,
    bountyId: parseOptionalSafeInteger(rawObj.bountyId, "bountyId", 1),
    vkEpoch: parseOptionalSafeInteger(rawObj.vkEpoch, "vkEpoch", 0),
    donorAddress: rawObj.donorAddress || null,
    targetTraitId: rawObj.targetTraitId || null,
  };
}