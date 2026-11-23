import { expect } from "chai";
import hre from "hardhat";

async function run() {
  console.log("=== ADVERSARIAL TEST 3: DATASET CLONING / FRONT-RUNNING VULNERABILITY ===");
  const { ethers } = await hre.network.create();
  const [owner, honestPatient, copycatAttacker] = await ethers.getSigners();

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

  const rawHash = ethers.keccak256(ethers.toUtf8Bytes("PATIENT_GENOME_CONFIDENTIAL_1"));
  const rawCid = "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG";
  const sumCid = "QmZ4tDuvesekSs4qM5ZBKpXiZGun7S2CYtEZRB3DYXkjGx";
  const metaCid = "QmPZ9qBzzyAtRaQQQUZr6xHS6wVfETRR249s63UME18znJ";

  // Honest patient registers dataset
  const id1 = await registry.connect(honestPatient).registerGenomicData.staticCall(
    rawHash,
    rawCid,
    sumCid,
    metaCid,
    `ipfs://${metaCid}`,
    ethers.parseUnits("100", 18),
    86400,
    1000
  );
  await registry.connect(honestPatient).registerGenomicData(
    rawHash,
    rawCid,
    sumCid,
    metaCid,
    `ipfs://${metaCid}`,
    ethers.parseUnits("100", 18),
    86400,
    1000
  );
  console.log("Honest patient registered dataset dataId:", id1.toString());

  // Copycat attempts to register the exact same rawDataHash at half price -> MUST BE BLOCKED
  let cloneReverted = false;
  try {
    await registry.connect(copycatAttacker).registerGenomicData(
      rawHash,
      rawCid,
      sumCid,
      metaCid,
      `ipfs://${metaCid}`,
      ethers.parseUnits("50", 18),
      86400,
      1000
    );
  } catch (err) {
    cloneReverted = err.message.includes("DataAlreadyRegistered");
    console.log("Copycat registration correctly reverted with error:", err.message);
  }

  if (cloneReverted) {
    console.log("SUCCESS: Duplicate dataset registration (cloning/counterfeiting) is strictly blocked by GenomicsRegistry!");
  } else {
    throw new Error("FAIL: Clone dataset was allowed to register!");
  }
}

run()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
