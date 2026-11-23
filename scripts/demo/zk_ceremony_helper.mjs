#!/usr/bin/env node
/**
 * @file zk_ceremony_helper.mjs
 * @description Trapdoor-free BN254 Groth16 verification key setup and proof generation helper.
 *              Consumes ONLY the public proving key (.zkey) and verification_key.json produced
 *              by scripts/zk/build_groth16_artifacts.mjs (zero toxic waste scalars persisted).
 */
import fs from "node:fs";
import path from "node:path";
import * as snarkjs from "snarkjs";
import {
  computeDonorWitnessCommitment,
  formatVerificationKeyForSolidity,
  generateGroth16ProofWithZkey,
  terminateGroth16Prover,
} from "../../crypto/zk/groth16_prover.js";

export const DEFAULT_ZKEY_PATH = path.resolve("frontend/public/zk/genomic_variant.zkey");
export const DEFAULT_VK_PATH = path.resolve("frontend/public/zk/verification_key.json");

export { computeDonorWitnessCommitment, formatVerificationKeyForSolidity, terminateGroth16Prover };

/**
 * Loads and validates the 3-public-input Groth16 verification_key.json from disk.
 */
export function loadVerificationKey(vkPath = DEFAULT_VK_PATH) {
  const absVkPath = path.resolve(vkPath);
  if (!fs.existsSync(absVkPath)) {
    throw new Error(
      `Missing Groth16 verification key at ${absVkPath}. Run 'node scripts/zk/build_groth16_artifacts.mjs' first.`
    );
  }
  const vk = JSON.parse(fs.readFileSync(absVkPath, "utf8"));
  if (!Array.isArray(vk?.IC) || vk.IC.length < 4) {
    throw new Error(`Invalid verification key at ${absVkPath}: expected 3-public-input VK (IC.length >= 4).`);
  }
  return vk;
}

/**
 * Configures GenomicZkVerifier on-chain with the compiled V2 3-public-input Groth16 VK.
 * Zero toxic-waste scalars are generated, persisted, or returned.
 */
export async function runLocalGroth16Ceremony(zkVerifier, deployer, options = {}) {
  const vkPath = path.resolve(options.vkPath || DEFAULT_VK_PATH);
  const zkeyPath = path.resolve(options.zkeyPath || DEFAULT_ZKEY_PATH);
  const vk = loadVerificationKey(vkPath);
  const formatted = formatVerificationKeyForSolidity(vk);

  const tx = await zkVerifier
    .connect(deployer)
    .setupVerificationKeyV2(
      formatted.alpha,
      formatted.beta,
      formatted.gamma,
      formatted.delta,
      formatted.ic0,
      formatted.ic1,
      formatted.ic2,
      formatted.ic3
    );
  await tx.wait();

  const vkEpoch = Number(await zkVerifier.vkEpoch());
  return {
    vkEpoch,
    vkPath,
    zkeyPath,
    protocol: vk.protocol || "groth16",
    curve: vk.curve || "bn128",
    nPublic: Number(vk.nPublic ?? 3),
    vk,
  };
}

/**
 * Generates an authentic BN254 Groth16 proof using snarkjs + the public .zkey proving key,
 * and self-verifies it against verification_key.json when available.
 */
export async function generateAuthenticGroth16Proof({
  zkeyPath = DEFAULT_ZKEY_PATH,
  vkPath = DEFAULT_VK_PATH,
  donorAddress,
  targetTraitId,
  variantCommitment = null,
  witnessSecret,
  bountyId,
  verifierAddress,
  chainId = 31337,
  vkEpoch = 1,
}) {
  const absZkeyPath = path.resolve(zkeyPath);
  if (!fs.existsSync(absZkeyPath)) {
    throw new Error(
      `Missing Groth16 proving key at ${absZkeyPath}. Run 'node scripts/zk/build_groth16_artifacts.mjs' first.`
    );
  }

  try {
    const result = await generateGroth16ProofWithZkey({
      snarkjs,
      zkeySource: absZkeyPath,
      donorAddress,
      targetTraitId,
      witnessSecret,
      variantCommitment,
      bountyId,
      verifierAddress,
      chainId,
      vkEpoch,
    });

    if (vkPath) {
      const absVkPath = path.resolve(vkPath);
      if (fs.existsSync(absVkPath)) {
        const vk = loadVerificationKey(absVkPath);
        const verified = await snarkjs.groth16.verify(vk, result.publicSignals, result.snarkjsProof);
        if (!verified) {
          throw new Error("Locally generated Groth16 proof failed verification against verification_key.json.");
        }
      }
    }

    return result;
  } finally {
    await terminateGroth16Prover();
  }
}
