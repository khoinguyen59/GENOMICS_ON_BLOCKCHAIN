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
    "QmTestRaw1111111111111111111111111111111111111",
    "QmTestSum1111111111111111111111111111111111111",
    "QmTestMeta111111111111111111111111111111111111",
    "ipfs://meta",
    price,
    86400,
    1000
  );

  // Researcher buys access
  await token.faucet(researcher.address);
  await token.connect(researcher).approve(registry.target, price);
  await registry.connect(researcher).grantAccess(1);

  // Store capsule
  await registry.storeTransformedCapsule(1, researcher.address, "SECRET_CAPSULE_PAYLOAD");

  // Owner REVOKES data status
  console.log("Owner revoking dataset #1 status...");
  await registry.updateDataStatus(1, 2); // 2 = Revoked

  // Check hasActiveAccess
  const hasAccess = await registry.hasActiveAccess(1, researcher.address);
  console.log("hasActiveAccess for researcher:", hasAccess); // Expect false

  // Call getTransformedCapsule as researcher
  try {
    const capsule = await registry.connect(researcher).getTransformedCapsule(1);
    console.log("CONFIRMED VULNERABILITY/DISCREPANCY: getTransformedCapsule returned:", capsule);
    console.log("Even though dataset status is REVOKED, researcher STILL retrieved the capsule!");
  } catch (e) {
    console.log("getTransformedCapsule reverted with:", e.message);
  }
}

run().catch(console.error);
