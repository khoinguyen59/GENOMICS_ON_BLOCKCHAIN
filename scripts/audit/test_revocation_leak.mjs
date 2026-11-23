import { expect } from "chai";
import hre from "hardhat";

async function run() {
  console.log("=== ADVERSARIAL TEST 2: REVOKED STATUS VS GET TRANSFORMED CAPSULE ===");
  const { ethers } = await hre.network.create();
  const [owner, researcher] = await ethers.getSigners();

  const GenomicToken = await ethers.getContractFactory("GenomicToken");
  const token = await GenomicToken.deploy(owner.address);
  await token.waitForDeployment();

  const GenomicNFT = await ethers.getContractFactory("GenomicNFT");
  const nft = await GenomicNFT.deploy(owner.address, 1000);
  await nft.waitForDeployment();

  const GenomicsRegistry = await ethers.getContractFactory("GenomicsRegistry");
  const registry = await GenomicsRegistry.deploy(token.target, nft.target, owner.address);
  await registry.waitForDeployment();
  await nft.setRegistryContract(registry.target);

  // Register data
  const price = ethers.parseUnits("100", 18);
  await registry.registerGenomicData(
    ethers.keccak256(ethers.toUtf8Bytes("DNA")),
    "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG",
    "QmZ4tDuvesekSs4qM5ZBKpXiZGun7S2CYtEZRB3DYXkjGx",
    "QmPZ9qBzzyAtRaQQQUZr6xHS6wVfETRR249s63UME18znJ",
    "ipfs://QmPZ9qBzzyAtRaQQQUZr6xHS6wVfETRR249s63UME18znJ",
    price,
    86400,
    1000
  );

  // Researcher buys access
  await token.faucet(researcher.address);
  await token.connect(researcher).approve(registry.target, price);
  await registry.connect(researcher)["grantAccess(uint256)"](1);

  // Store valid RFC 8259 RSA-OAEP capsule
  const validCapsule = JSON.stringify({ version: "GENO-ASYM-RSA-OAEP-v2", keyCipher: "ab".repeat(256) });
  await registry.storeTransformedCapsule(1, researcher.address, validCapsule);

  // Owner REVOKES data status
  console.log("Owner revoking dataset #1 status...");
  await registry.updateDataStatus(1, 2); // 2 = Revoked

  // Check hasActiveAccess
  const hasAccess = await registry.hasActiveAccess(1, researcher.address);
  console.log("hasActiveAccess for researcher:", hasAccess);
  if (hasAccess !== false) {
    throw new Error("FAIL: hasActiveAccess remained true after dataset revocation!");
  }

  // Call getTransformedCapsule as researcher -> MUST revert
  let reverted = false;
  try {
    const capsule = await registry.connect(researcher).getTransformedCapsule(1);
    throw new Error(`FAIL: Revoked dataset leaked capsule via getTransformedCapsule: ${capsule.slice(0, 32)}...`);
  } catch (e) {
    if (String(e.message || "").startsWith("FAIL:")) throw e;
    reverted = true;
    console.log("PASS: getTransformedCapsule reverted as expected on Revoked dataset:", e.message);
  }
  if (!reverted) {
    throw new Error("FAIL: Expected getTransformedCapsule to revert on Revoked dataset.");
  }
}

run()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
