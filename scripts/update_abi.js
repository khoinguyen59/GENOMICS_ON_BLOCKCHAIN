import fs from "node:fs";
import path from "node:path";

function exportAbi(artifactRelativePath, targetRelativePath) {
  const artifactPath = path.resolve(artifactRelativePath);
  const targetPath = path.resolve(targetRelativePath);
  if (fs.existsSync(artifactPath)) {
    const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
    fs.writeFileSync(targetPath, JSON.stringify(artifact.abi, null, 2));
    console.log("Exported ABI with", artifact.abi.length, "entries to", targetPath);
  } else {
    console.warn("Artifact not found:", artifactPath);
  }
}

exportAbi("artifacts/contracts/GenomicsRegistry.sol/GenomicsRegistry.json", "frontend/src/contracts/GenomicsRegistryABI.json");
exportAbi("artifacts/contracts/GenomicZkVerifier.sol/GenomicZkVerifier.json", "frontend/src/contracts/GenomicZkVerifierABI.json");
