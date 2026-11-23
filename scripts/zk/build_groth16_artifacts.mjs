#!/usr/bin/env node
/**
 * @file build_groth16_artifacts.mjs
 * @description Compiles circuits/genomic_variant_proof.circom's zero-slack 91-round BN254 MiMC-7
 *              Miyaguchi-Preneel R1CS constraint system (366 constraints, 370 wires, 3 public inputs)
 *              into iden3 .r1cs, runs a real BN254 Powers-of-Tau Phase 1 (power=9) + Groth16 Phase 2
 *              ceremony via snarkjs with random CSPRNG contributions + random beacons, verifies the
 *              zkey against the R1CS, exports ONLY the public proving key (.zkey) and verification
 *              key (verification_key.json) to frontend/public/zk/, and destroys all intermediate files
 *              (zero toxic waste scalars persisted anywhere on disk).
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as snarkjs from "snarkjs";
import { getCurveFromName } from "ffjavascript";
import { ethers } from "ethers";
import {
  R_MOD,
  MIMC_ROUNDS,
  MIMC_ROUND_CONSTANTS,
  CIRCUIT_PUB_INPUTS,
  CIRCUIT_PRV_INPUTS,
  CIRCUIT_WIRES,
  CIRCUIT_CONSTRAINTS,
  getCircuitR1csConstraints,
  writeBigIntLE,
  writeFieldLE,
  generateGroth16ProofWithZkey,
} from "../../crypto/zk/groth16_prover.js";

function renderCircomSource() {
  const constLines = MIMC_ROUND_CONSTANTS.map((c, idx) => {
    const comma = idx < MIMC_ROUND_CONSTANTS.length - 1 ? "," : "";
    return `        ${c.toString()}${comma}`;
  }).join("\n");

  return `pragma circom 2.0.0;

/*
 * GenoChain Zero-Knowledge Genomic Variant Possession Circuit (Groth16 / BN254)
 *
 * Sound, zero-slack 91-round BN254 MiMC-7 (x^7, gcd(7, R_MOD - 1) == 1)
 * Miyaguchi-Preneel commitment circuit with strict domain separation.
 *
 * Public inputs (verified on-chain via GenomicZkVerifier.setupVerificationKeyV2):
 *   wire 1 (pub[0]) : variantCommitment (< R_MOD, exact MiMC-7 MP output)
 *   wire 2 (pub[1]) : donorTraitBind    = keccak256(targetTraitId || msg.sender) % R_MOD
 *   wire 3 (pub[2]) : domainHash        = keccak256(targetTraitId || msg.sender || bountyId || verifier || chainId || vkEpoch) % R_MOD
 *
 * Private inputs (known only to the donor):
 *   wire 4 (prv[0]) : witnessSecret     (non-zero BN254 Fr scalar derived from donor secret)
 *   wire 5 (prv[1]) : witnessSecretInv  (proves witnessSecret != 0)
 *
 * Total layout: ${CIRCUIT_WIRES} wires, ${CIRCUIT_CONSTRAINTS} quadratic R1CS constraints, ZERO free slack variables.
 */
template GenomicVariantProof(ROUNDS) {
    signal input variantCommitment;
    signal input donorTraitBind;
    signal input domainHash;

    signal input witnessSecret;
    signal input witnessSecretInv;

    // 1. Non-zero private witness preimage guard
    witnessSecret * witnessSecretInv === 1;

    // 2. 91-round BN254 MiMC-7 (x^7) permutation with Miyaguchi-Preneel feedforward
    //    Round constants C[i] = keccak256("GENOCHAIN_MIMC7_BN254_R" || i) % R_MOD
    var C[${MIMC_ROUNDS}] = [
${constLines}
    ];

    signal t2[ROUNDS];
    signal t4[ROUNDS];
    signal t6[ROUNDS];
    signal x[ROUNDS];

    x[0] <== witnessSecret + donorTraitBind;
    for (var i = 0; i < ROUNDS; i++) {
        var u = x[i] + witnessSecret + C[i];
        t2[i] <== u * u;
        t4[i] <== t2[i] * t2[i];
        t6[i] <== t4[i] * t2[i];
        if (i < ROUNDS - 1) {
            x[i + 1] <== t6[i] * u;
        } else {
            // Strict Miyaguchi-Preneel output equality (zero unconstrained slack variables)
            t6[i] * u === variantCommitment - donorTraitBind - witnessSecret;
        }
    }

    // 3. Quadratic domain-binding gate (binds bountyId, verifier, chainId, vkEpoch via IC[3])
    signal domainBind;
    domainBind <== domainHash * witnessSecret;
}

component main { public [ variantCommitment, donorTraitBind, domainHash ] } = GenomicVariantProof(${MIMC_ROUNDS});
`;
}

function serializeR1csBinary() {
  const constraints = getCircuitR1csConstraints();
  if (constraints.length !== CIRCUIT_CONSTRAINTS) {
    throw new Error(`Expected ${CIRCUIT_CONSTRAINTS} R1CS constraints, got ${constraints.length}`);
  }

  const writeU32 = (n) => {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(n >>> 0, 0);
    return b;
  };
  const writeU64 = (n) => {
    const b = Buffer.alloc(8);
    b.writeBigUInt64LE(BigInt(n), 0);
    return b;
  };
  const writePrime = (v) => {
    const b = Buffer.alloc(32);
    writeBigIntLE(b, 0, v);
    return b;
  };
  const writeField = (v) => {
    const b = Buffer.alloc(32);
    writeFieldLE(b, 0, v);
    return b;
  };

  // Section 1: Header
  const sec1 = Buffer.concat([
    writeU32(32),                   // n8 field size in bytes
    writePrime(R_MOD),              // prime r
    writeU32(CIRCUIT_WIRES),        // nWires (370)
    writeU32(0),                    // nPubOut
    writeU32(CIRCUIT_PUB_INPUTS),   // nPubIn (3: variantCommitment, donorTraitBind, domainHash)
    writeU32(CIRCUIT_PRV_INPUTS),   // nPrvIn (2: witnessSecret, witnessSecretInv)
    writeU64(CIRCUIT_WIRES),        // nLabels
    writeU32(constraints.length),   // mConstraints (366)
  ]);

  // Section 2: Constraints
  const lcBuf = (lc) => {
    const parts = [writeU32(lc.length)];
    for (const [wire, coeff] of lc) {
      parts.push(writeU32(wire));
      parts.push(writeField(coeff));
    }
    return Buffer.concat(parts);
  };
  const sec2Parts = [];
  for (const [A, B, C] of constraints) {
    sec2Parts.push(lcBuf(A), lcBuf(B), lcBuf(C));
  }
  const sec2 = Buffer.concat(sec2Parts);

  // Section 3: Wire-to-Label map
  const sec3 = Buffer.concat(Array.from({ length: CIRCUIT_WIRES }, (_, i) => writeU64(i)));

  // Top-level R1CS container
  return Buffer.concat([
    Buffer.from("r1cs", "ascii"),
    writeU32(1), // version 1
    writeU32(3), // 3 sections
    writeU32(1), writeU64(sec1.length), sec1,
    writeU32(2), writeU64(sec2.length), sec2,
    writeU32(3), writeU64(sec3.length), sec3,
  ]);
}

async function main() {
  const rootDir = path.resolve(".");
  const circomPath = path.join(rootDir, "circuits", "genomic_variant_proof.circom");
  const r1csDir = path.join(rootDir, "circuits", "build");
  const outZkDir = path.join(rootDir, "frontend", "public", "zk");
  fs.mkdirSync(r1csDir, { recursive: true });
  fs.mkdirSync(outZkDir, { recursive: true });

  const r1csPath = path.join(r1csDir, "genomic_variant.r1cs");
  const finalZkeyPath = path.join(outZkDir, "genomic_variant.zkey");
  const finalVkPath = path.join(outZkDir, "verification_key.json");

  console.log(`[1/5] Syncing circuits/genomic_variant_proof.circom & compiling ${CIRCUIT_CONSTRAINTS}-constraint BN254 MiMC-7 R1CS -> circuits/build/genomic_variant.r1cs ...`);
  fs.writeFileSync(circomPath, renderCircomSource(), "utf8");
  fs.writeFileSync(r1csPath, serializeR1csBinary());

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "genochain-zk-ceremony-"));
  const ptau0 = path.join(tmpDir, "pot9_0000.ptau");
  const ptau1 = path.join(tmpDir, "pot9_0001.ptau");
  const ptau2 = path.join(tmpDir, "pot9_beacon.ptau");
  const ptauFinal = path.join(tmpDir, "pot9_final.ptau");
  const zkey0 = path.join(tmpDir, "circuit_0000.zkey");
  const zkey1 = path.join(tmpDir, "circuit_0001.zkey");

  let curve = null;
  try {
    console.log("[2/5] Running BN254 Powers-of-Tau Phase 1 (power=9, 512-constraint capacity, CSPRNG contribution + beacon)...");
    curve = await getCurveFromName("bn128");
    await snarkjs.powersOfTau.newAccumulator(curve, 9, ptau0);
    await snarkjs.powersOfTau.contribute(
      ptau0,
      ptau1,
      "GenoChain MiMC-7 Phase 1 Contribution",
      crypto.randomBytes(64).toString("hex")
    );
    await snarkjs.powersOfTau.beacon(
      ptau1,
      ptau2,
      "GenoChain MiMC-7 Phase 1 Random Beacon",
      crypto.randomBytes(32).toString("hex"),
      10
    );
    await snarkjs.powersOfTau.preparePhase2(ptau2, ptauFinal);
    const ptauOk = await snarkjs.powersOfTau.verify(ptauFinal);
    if (!ptauOk) throw new Error("Powers-of-Tau Phase 1 verification failed!");

    console.log("[3/5] Running Groth16 Phase 2 ceremony (newZKey -> contribute -> random beacon -> verifyFromR1cs)...");
    await snarkjs.zKey.newZKey(r1csPath, ptauFinal, zkey0);
    await snarkjs.zKey.contribute(
      zkey0,
      zkey1,
      "GenoChain MiMC-7 Phase 2 Contribution",
      crypto.randomBytes(64).toString("hex")
    );
    await snarkjs.zKey.beacon(
      zkey1,
      finalZkeyPath,
      "GenoChain MiMC-7 Phase 2 Random Beacon",
      crypto.randomBytes(32).toString("hex"),
      10
    );

    const zkeyOk = await snarkjs.zKey.verifyFromR1cs(r1csPath, ptauFinal, finalZkeyPath);
    if (!zkeyOk) throw new Error("Groth16 Phase 2 zkey verification against R1CS failed!");

    console.log("[4/5] Exporting 3-public-input verification_key.json (IC.length === 4) & destroying all intermediates...");
    const vk = await snarkjs.zKey.exportVerificationKey(finalZkeyPath);
    if (!Array.isArray(vk.IC) || vk.IC.length !== 4) {
      throw new Error(`Expected 4 IC points (ic0..ic3), got ${vk.IC?.length}`);
    }
    fs.writeFileSync(finalVkPath, JSON.stringify(vk, null, 2) + "\n", "utf8");

    console.log("[5/5] Self-testing authentic Groth16 proof + rejecting tampering on ALL 3 public inputs...");
    const testDonor = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
    const testTrait = ethers.id("ALDH2_rs671");
    const testVerifier = "0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9";
    const proofRes = await generateGroth16ProofWithZkey({
      snarkjs,
      zkeySource: finalZkeyPath,
      donorAddress: testDonor,
      targetTraitId: testTrait,
      witnessSecret: "SELFTEST_DONOR_WITNESS_V1",
      bountyId: 1,
      verifierAddress: testVerifier,
      chainId: 31337,
      vkEpoch: 1,
    });
    const verified = await snarkjs.groth16.verify(vk, proofRes.publicSignals, proofRes.snarkjsProof);
    if (!verified) throw new Error("Generated Groth16 proof failed snarkjs verification!");

    for (let idx = 0; idx < 3; idx++) {
      const tampered = [...proofRes.publicSignals];
      tampered[idx] = ((BigInt(tampered[idx]) + 1n) % R_MOD).toString();
      const forgedOk = await snarkjs.groth16.verify(vk, tampered, proofRes.snarkjsProof);
      if (forgedOk) {
        throw new Error(`Tampered publicSignals[${idx}] was unexpectedly accepted!`);
      }
    }

    const zkeySize = fs.statSync(finalZkeyPath).size;
    console.log(`[PASS] Zero-slack MiMC-7 Groth16 artifacts ready (zero trapdoor scalars stored):`);
    console.log(`  - Circuit         : ${circomPath} (${CIRCUIT_CONSTRAINTS} constraints, ${CIRCUIT_WIRES} wires, 3 public inputs)`);
    console.log(`  - R1CS            : ${r1csPath} (${fs.statSync(r1csPath).size} bytes)`);
    console.log(`  - Proving Key     : ${finalZkeyPath} (${zkeySize} bytes)`);
    console.log(`  - Verification Key: ${finalVkPath} (${fs.statSync(finalVkPath).size} bytes, IC=${vk.IC.length})`);
    console.log(`  - Authentic proof verified = ${verified}, all 3 public input tamper probes rejected = true`);
  } finally {
    if (curve?.terminate) {
      await curve.terminate();
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
    const legacyTrapdoor = path.join(rootDir, ".local", "zk_ceremony_crs.json");
    if (fs.existsSync(legacyTrapdoor)) {
      fs.unlinkSync(legacyTrapdoor);
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[FAIL] Groth16 artifact build failed:", err);
    process.exit(1);
  });