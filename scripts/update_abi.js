import fs from "node:fs";
import path from "node:path";

const CONTRACTS = [
  ["artifacts/contracts/GenomicsRegistry.sol/GenomicsRegistry.json", "frontend/src/contracts/GenomicsRegistryABI.json"],
  ["artifacts/contracts/GenomicZkVerifier.sol/GenomicZkVerifier.json", "frontend/src/contracts/GenomicZkVerifierABI.json"],
  ["artifacts/contracts/GenomicNFT.sol/GenomicNFT.json", "frontend/src/contracts/GenomicNFTABI.json"],
  ["artifacts/contracts/GenomicToken.sol/GenomicToken.json", "frontend/src/contracts/GenomicTokenABI.json"],
  ["artifacts/contracts/GenomicTimelock.sol/GenomicTimelock.json", "frontend/src/contracts/GenomicTimelockABI.json"],
];

let missing = 0;

function exportAbi(artifactRelativePath, targetRelativePath) {
  const artifactPath = path.resolve(artifactRelativePath);
  const targetPath = path.resolve(targetRelativePath);
  if (fs.existsSync(artifactPath)) {
    const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, JSON.stringify(artifact.abi, null, 2) + "\n", "utf8");
    console.log("[OK] Exported ABI with", artifact.abi.length, "entries to", targetPath);
  } else {
    console.error("[FAIL] Artifact not found:", artifactPath);
    missing++;
  }
}

for (const [src, dst] of CONTRACTS) {
  exportAbi(src, dst);
}

if (missing > 0) {
  process.exit(1);
}
