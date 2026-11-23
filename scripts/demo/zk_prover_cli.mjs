#!/usr/bin/env node
/**
 * @file zk_prover_cli.mjs
 * @description Offline Trapdoor-Free BN254 Groth16 Prover CLI for GenoChain Donors.
 *              Uses real snarkjs Groth16 proving against the compiled 366-constraint R1CS
 *              proving key (frontend/public/zk/genomic_variant.zkey) with zero trapdoor secrets.
 *
 * Usage:
 *   node scripts/demo/zk_prover_cli.mjs --bounty 1 --donor 0x... --trait ALDH2_rs671 --secret DONOR_SECRET_V1
 */
import fs from "node:fs";
import path from "node:path";
import { ethers } from "ethers";
import {
  DEFAULT_ZKEY_PATH,
  DEFAULT_VK_PATH,
  computeDonorWitnessCommitment,
  generateAuthenticGroth16Proof,
} from "./zk_ceremony_helper.mjs";

function printUsage() {
  console.error(
    [
      "Usage: node scripts/demo/zk_prover_cli.mjs --donor <0xAddress> --secret <witnessSecret> [options]",
      "",
      "Required:",
      "  --donor <address>        Donor Ethereum wallet address",
      "  --secret <string>        Private witness secret preimage",
      "",
      "Options:",
      "  --bounty <id>            Target ZK bounty ID (default: 1)",
      "  --trait <nameOrHash>     Trait identifier string or bytes32 hex (default: ALDH2_rs671)",
      "  --commitment <0xHash>    Optional expected variantCommitment (must match witness preimage)",
      "  --verifier <0xAddress>   Optional GenomicZkVerifier address override",
      "  --chain-id <number>      Chain ID (default: 31337)",
      "  --vk-epoch <number>      Verification key epoch (default: 1)",
      "  --zkey <path>            Path to Groth16 .zkey proving key (default: frontend/public/zk/genomic_variant.zkey)",
      "  --vk <path>              Path to verification_key.json for local self-check",
      "  --out <path>             Optional output file path to write proof JSON",
    ].join("\n")
  );
}

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  printUsage();
  process.exit(0);
}

const getArg = (flag, fallback = null) => {
  const idx = args.indexOf(flag);
  return idx >= 0 && args[idx + 1] !== undefined ? args[idx + 1] : fallback;
};

const donorAddress = getArg("--donor");
const witnessSecret = getArg("--secret");
if (!donorAddress || !witnessSecret) {
  printUsage();
  process.exit(1);
}

const addrPath = path.resolve("frontend/src/contracts/contractAddresses.json");
const deployed = fs.existsSync(addrPath) ? JSON.parse(fs.readFileSync(addrPath, "utf8")) : {};

const zkeyPath = path.resolve(getArg("--zkey", DEFAULT_ZKEY_PATH));
const vkPath = path.resolve(getArg("--vk", DEFAULT_VK_PATH));
const bountyId = Number(getArg("--bounty", "1"));
const traitRaw = getArg("--trait", "ALDH2_rs671");
const targetTraitId =
  /^0x[0-9a-fA-F]{64}$/.test(traitRaw) ? traitRaw : ethers.id(traitRaw);
const verifierAddress = getArg("--verifier", deployed.GenomicZkVerifier);
if (!verifierAddress || !ethers.isAddress(verifierAddress)) {
  console.error("[ERROR] Missing valid --verifier address and frontend/src/contracts/contractAddresses.json.");
  process.exit(1);
}
const chainId = Number(getArg("--chain-id", String(deployed.chainId || 31337)));
const vkEpoch = Number(getArg("--vk-epoch", "1"));
const explicitCommitment = getArg("--commitment", null);

const variantCommitment =
  explicitCommitment ||
  computeDonorWitnessCommitment(donorAddress, targetTraitId, witnessSecret);

const result = await generateAuthenticGroth16Proof({
  zkeyPath,
  vkPath,
  donorAddress,
  targetTraitId,
  variantCommitment,
  witnessSecret,
  bountyId,
  verifierAddress,
  chainId,
  vkEpoch,
});

const outputPayload = {
  ...result,
  targetTraitId,
  donorAddress,
  verifierAddress,
  chainId,
};

const jsonStr = JSON.stringify(outputPayload, null, 2);
const outPath = getArg("--out", null);
if (outPath) {
  const absOut = path.resolve(outPath);
  fs.mkdirSync(path.dirname(absOut), { recursive: true });
  fs.writeFileSync(absOut, jsonStr + "\n", "utf8");
}

console.log(jsonStr);
process.exit(0);