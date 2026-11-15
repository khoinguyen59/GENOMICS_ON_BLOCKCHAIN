import { expect } from "chai";
import hre from "hardhat";
import {
  encryptGenomicData,
  generateAsymmetricKeyPair,
  exportPublicKey,
  packageKeyCapsule,
  decryptKeyCapsule,
  decryptGenomicPayload,
} from "../crypto/client_crypto.js";

describe("Full 40/40 Protocol Completion: 3-Artifact Anchoring, Blinded Trait Search, Reuse Fee & NFT Transfer Sync", function () {
  let ethers;
  let token, nft, registry;
  let deployer, seller, newOwner, buyer, buyer2, worker, attacker;

  const PRICE = 100n * 10n ** 18n; // 100 GENO
  const ACCESS_DURATION = 30 * 86400; // 30 days
  const DISPUTE_WINDOW = 86400; // 24 hours
  const ROYALTY_BPS = 1000; // 10%

  const VALID_RAW_CID = "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG";
  const VALID_SUMMARY_CID = "QmZ4tDuvesekSs4qM5ZBKpXiZGun7S2CYtEZRB3DYXkjGx";
  const VALID_METADATA_CID = "QmPZ9qBzzyAtRaQQQUZr6xHS6wVfETRR249s63UME18znJ";
  const VALID_TOKEN_URI = "ipfs://QmPZ9qBzzyAtRaQQQUZr6xHS6wVfETRR249s63UME18znJ";
  const ALT_RAW_CID = "QmUNLLsPACCz1vLxQVkXqqLX5R1X345qqfHbsf67hvA3Nn";
  const ALT_SUMMARY_CID = "QmQPeNsJPyVWPFDVHb77w8G42Fvo15z4bG2X8D2GhfbSXc";

  function assertMethodExists(contract, methodName) {
    expect(
      typeof contract[methodName],
      `${methodName}() must be exposed on GenomicsRegistry`
    ).to.equal("function");
  }

  async function expectAccessDeniedRevert(callFn) {
    let err = null;
    try {
      const tx = await callFn();
      if (tx && typeof tx.wait === "function") await tx.wait();
    } catch (e) {
      err = e;
    }
    expect(err, "expected unauthorized/expired study reuse call to revert").to.not.equal(null);
    let errName = err?.revert?.name || null;
    if (!errName && err?.data && registry?.interface) {
      try {
        errName = registry.interface.parseError(err.data)?.name || null;
      } catch (_) {}
    }
    if (!errName) {
      const msg = String(err?.shortMessage || err?.message || "");
      const m = msg.match(/custom error '(\w+)/);
      if (m) errName = m[1];
    }
    expect(
      ["AccessNotGranted", "AccessExpired"],
      `expected AccessNotGranted or AccessExpired, got: ${err?.shortMessage || err?.message}`
    ).to.include(errName);
  }

  function makeTag(label) {
    return ethers.keccak256(ethers.toUtf8Bytes(`BLIND_TAG_${label}`));
  }

  function makeHash(label) {
    return ethers.keccak256(ethers.toUtf8Bytes(`ARTIFACT_HASH_${label}`));
  }

  async function registerLegacyDataset(seed = "LEGACY", ownerSigner = seller, price = PRICE, royaltyBps = ROYALTY_BPS) {
    const rawHash = makeHash(`RAW_${seed}`);
    await (
      await registry.connect(ownerSigner).registerGenomicData(
        rawHash,
        VALID_RAW_CID,
        VALID_SUMMARY_CID,
        VALID_METADATA_CID,
        VALID_TOKEN_URI,
        price,
        ACCESS_DURATION,
        royaltyBps
      )
    ).wait();
    const dataId = await registry.dataCount();
    return { dataId, rawHash };
  }

  beforeEach(async function () {
    ({ ethers } = await hre.network.create());
    [deployer, seller, newOwner, buyer, buyer2, worker, attacker] = await ethers.getSigners();

    const Token = await ethers.getContractFactory("GenomicToken");
    token = await Token.deploy(deployer.address);
    await token.waitForDeployment();

    const Nft = await ethers.getContractFactory("GenomicNFT");
    nft = await Nft.deploy(deployer.address, ROYALTY_BPS);
    await nft.waitForDeployment();

    const Registry = await ethers.getContractFactory("GenomicsRegistry");
    registry = await Registry.deploy(token.target, nft.target, deployer.address);
    await registry.waitForDeployment();
    await (await nft.connect(deployer).setRegistryContract(registry.target)).wait();

    for (const acct of [buyer, buyer2, attacker]) {
      await (await token.connect(deployer).transfer(acct.address, 2000n * 10n ** 18n)).wait();
      await (await token.connect(acct).approve(registry.target, 2000n * 10n ** 18n)).wait();
    }
  });

  // ===========================================================================
  // Module 1: 3-Artifact Cryptographic Hash Anchoring & Atomic Bundle Minting
  // ===========================================================================
  describe("Module 1: 3-Artifact Cryptographic Hash Anchoring & Atomic Bundle Minting", function () {
    it("1.1 Legacy registerGenomicData + standalone anchorArtifactHashes anchors immutably and rejects overwrite", async function () {
      assertMethodExists(registry, "summaryDataHashes");
      assertMethodExists(registry, "metadataHashes");
      assertMethodExists(registry, "getArtifactHashes");
      assertMethodExists(registry, "anchorArtifactHashes");

      const { dataId, rawHash } = await registerLegacyDataset("M1_STANDALONE");
      const summaryHash = makeHash("SUMMARY_1");
      const metadataHash = makeHash("META_1");

      // Unanchored legacy dataset starts with zero summary/metadata hashes
      expect(await registry.summaryDataHashes(dataId)).to.equal(ethers.ZeroHash);
      expect(await registry.metadataHashes(dataId)).to.equal(ethers.ZeroHash);
      expect(await registry.getArtifactHashes(dataId)).to.deep.equal([rawHash, ethers.ZeroHash, ethers.ZeroHash]);

      // Owner anchors summaryHash & metadataHash
      await expect(registry.connect(seller).anchorArtifactHashes(dataId, summaryHash, metadataHash))
        .to.emit(registry, "ArtifactHashesAnchored")
        .withArgs(dataId, summaryHash, metadataHash);

      expect(await registry.summaryDataHashes(dataId)).to.equal(summaryHash);
      expect(await registry.metadataHashes(dataId)).to.equal(metadataHash);
      expect(await registry.getArtifactHashes(dataId)).to.deep.equal([rawHash, summaryHash, metadataHash]);

      // Immutability guard: second anchor call MUST revert ArtifactHashesAlreadyAnchored and preserve hashes
      const altSummary = makeHash("SUMMARY_TAMPER");
      const altMeta = makeHash("META_TAMPER");
      await expect(
        registry.connect(seller).anchorArtifactHashes(dataId, altSummary, altMeta)
      ).to.be.revertedWithCustomError(registry, "ArtifactHashesAlreadyAnchored");

      expect(await registry.getArtifactHashes(dataId)).to.deep.equal([rawHash, summaryHash, metadataHash]);
    });

    it("1.2 Standalone anchorArtifactHashes and getArtifactHashes enforce dataId bounds, ownership, and non-zero hashes", async function () {
      assertMethodExists(registry, "getArtifactHashes");
      assertMethodExists(registry, "anchorArtifactHashes");

      const { dataId, rawHash } = await registerLegacyDataset("M1_GUARDS");
      const summaryHash = makeHash("SUMMARY_G");
      const metadataHash = makeHash("META_G");

      // Out-of-range dataId checks (0 and dataCount + 1)
      for (const badId of [0n, dataId + 1n]) {
        await expect(registry.getArtifactHashes(badId)).to.be.revertedWithCustomError(registry, "DataNotFound");
        await expect(
          registry.connect(seller).anchorArtifactHashes(badId, summaryHash, metadataHash)
        ).to.be.revertedWithCustomError(registry, "DataNotFound");
      }

      // Non-owner rejected with NotDataOwner
      await expect(
        registry.connect(attacker).anchorArtifactHashes(dataId, summaryHash, metadataHash)
      ).to.be.revertedWithCustomError(registry, "NotDataOwner");

      // Zero summaryHash or zero metadataHash rejected with InvalidDataHashOrCid
      await expect(
        registry.connect(seller).anchorArtifactHashes(dataId, ethers.ZeroHash, metadataHash)
      ).to.be.revertedWithCustomError(registry, "InvalidDataHashOrCid");

      await expect(
        registry.connect(seller).anchorArtifactHashes(dataId, summaryHash, ethers.ZeroHash)
      ).to.be.revertedWithCustomError(registry, "InvalidDataHashOrCid");

      // State remains unanchored until valid anchor call succeeds
      expect(await registry.getArtifactHashes(dataId)).to.deep.equal([rawHash, ethers.ZeroHash, ethers.ZeroHash]);

      await (await registry.connect(seller).anchorArtifactHashes(dataId, summaryHash, metadataHash)).wait();
      expect(await registry.getArtifactHashes(dataId)).to.deep.equal([rawHash, summaryHash, metadataHash]);
    });

    it("1.3 Atomic registerGenomicDataBundle mints dataset + NFT, anchors all 3 hashes, and registers blind tags", async function () {
      assertMethodExists(registry, "registerGenomicDataBundle");
      assertMethodExists(registry, "getArtifactHashes");
      assertMethodExists(registry, "datasetBlindTags");
      assertMethodExists(registry, "datasetBlindTagCount");
      assertMethodExists(registry, "matchesBlindTag");

      const rawHash = makeHash("BUNDLE_RAW");
      const summaryHash = makeHash("BUNDLE_SUMMARY");
      const metadataHash = makeHash("BUNDLE_META");
      const tag1 = makeTag("BRCA1_POS");
      const tag2 = makeTag("ETHNICITY_SEA");

      const tx = await registry.connect(seller).registerGenomicDataBundle(
        [rawHash, summaryHash, metadataHash],
        [VALID_RAW_CID, VALID_SUMMARY_CID, VALID_METADATA_CID, VALID_TOKEN_URI],
        PRICE,
        ACCESS_DURATION,
        ROYALTY_BPS,
        [tag1, tag2]
      );

      await expect(tx)
        .to.emit(registry, "ArtifactHashesAnchored")
        .withArgs(1n, summaryHash, metadataHash);
      await expect(tx)
        .to.emit(registry, "BlindTagRegistered")
        .withArgs(1n, tag1);
      await expect(tx)
        .to.emit(registry, "BlindTagRegistered")
        .withArgs(1n, tag2);

      expect(await registry.dataCount()).to.equal(1n);
      expect(await nft.ownerOf(1n)).to.equal(seller.address);
      expect((await registry.getGenomicData(1n)).currentOwner).to.equal(seller.address);
      expect(await registry.getArtifactHashes(1n)).to.deep.equal([rawHash, summaryHash, metadataHash]);
      expect(await registry.summaryDataHashes(1n)).to.equal(summaryHash);
      expect(await registry.metadataHashes(1n)).to.equal(metadataHash);
      expect(await registry.datasetBlindTagCount(1n)).to.equal(2n);
      expect(await registry.datasetBlindTags(1n, tag1)).to.equal(true);
      expect(await registry.datasetBlindTags(1n, tag2)).to.equal(true);
      expect(await registry.matchesBlindTag(1n, tag1)).to.equal(true);
      expect(await registry.matchesBlindTag(1n, tag2)).to.equal(true);

      // Anchored hashes from atomic bundle mint must also be immutable
      await expect(
        registry.connect(seller).anchorArtifactHashes(1n, makeHash("OVERWRITE_S"), makeHash("OVERWRITE_M"))
      ).to.be.revertedWithCustomError(registry, "ArtifactHashesAlreadyAnchored");
      expect(await registry.getArtifactHashes(1n)).to.deep.equal([rawHash, summaryHash, metadataHash]);
    });

    it("1.4 Atomic registerGenomicDataBundle rolls back completely on zero hashes, invalid CID, or invalid blind tags", async function () {
      assertMethodExists(registry, "registerGenomicDataBundle");

      const rawHash = makeHash("RB_RAW");
      const summaryHash = makeHash("RB_SUM");
      const metadataHash = makeHash("RB_META");
      const validCids = [VALID_RAW_CID, VALID_SUMMARY_CID, VALID_METADATA_CID, VALID_TOKEN_URI];
      const tag1 = makeTag("RB_1");

      // Any zero hash in [raw, summary, metadata] must revert
      await expect(
        registry.connect(seller).registerGenomicDataBundle(
          [ethers.ZeroHash, summaryHash, metadataHash],
          validCids,
          PRICE,
          ACCESS_DURATION,
          ROYALTY_BPS,
          [tag1]
        )
      ).to.be.revertedWithCustomError(registry, "InvalidDataHashOrCid");

      await expect(
        registry.connect(seller).registerGenomicDataBundle(
          [rawHash, ethers.ZeroHash, metadataHash],
          validCids,
          PRICE,
          ACCESS_DURATION,
          ROYALTY_BPS,
          [tag1]
        )
      ).to.be.revertedWithCustomError(registry, "InvalidDataHashOrCid");

      await expect(
        registry.connect(seller).registerGenomicDataBundle(
          [rawHash, summaryHash, ethers.ZeroHash],
          validCids,
          PRICE,
          ACCESS_DURATION,
          ROYALTY_BPS,
          [tag1]
        )
      ).to.be.revertedWithCustomError(registry, "InvalidDataHashOrCid");

      // Invalid CID must revert
      await expect(
        registry.connect(seller).registerGenomicDataBundle(
          [rawHash, summaryHash, metadataHash],
          ["invalid-cid", VALID_SUMMARY_CID, VALID_METADATA_CID, VALID_TOKEN_URI],
          PRICE,
          ACCESS_DURATION,
          ROYALTY_BPS,
          [tag1]
        )
      ).to.be.revertedWithCustomError(registry, "InvalidDataHashOrCid");

      // Zero blind tag, duplicate blind tag, and >16 blind tags must revert InvalidBlindTag
      await expect(
        registry.connect(seller).registerGenomicDataBundle(
          [rawHash, summaryHash, metadataHash],
          validCids,
          PRICE,
          ACCESS_DURATION,
          ROYALTY_BPS,
          [tag1, ethers.ZeroHash]
        )
      ).to.be.revertedWithCustomError(registry, "InvalidBlindTag");

      await expect(
        registry.connect(seller).registerGenomicDataBundle(
          [rawHash, summaryHash, metadataHash],
          validCids,
          PRICE,
          ACCESS_DURATION,
          ROYALTY_BPS,
          [tag1, tag1]
        )
      ).to.be.revertedWithCustomError(registry, "InvalidBlindTag");

      const seventeenTags = Array.from({ length: 17 }, (_, i) => makeTag(`OVER_${i}`));
      await expect(
        registry.connect(seller).registerGenomicDataBundle(
          [rawHash, summaryHash, metadataHash],
          validCids,
          PRICE,
          ACCESS_DURATION,
          ROYALTY_BPS,
          seventeenTags
        )
      ).to.be.revertedWithCustomError(registry, "InvalidBlindTag");

      // Verify full atomic rollback: zero datasets or NFTs created
      expect(await registry.dataCount()).to.equal(0n);
      expect(await nft.nextTokenId()).to.equal(1n);
    });
  });

  // ===========================================================================
  // Module 2: Serverless On-Chain Blinded Keccak-256 Trait Tag Search
  // ===========================================================================
  describe("Module 2: Serverless On-Chain Blinded Keccak-256 Trait Tag Search", function () {
    it("2.1 MAX_BLIND_TAGS_PER_DATASET == 16 and computeBlindTag uses domain-separated salted keccak256", async function () {
      assertMethodExists(registry, "MAX_BLIND_TAGS_PER_DATASET");
      assertMethodExists(registry, "computeBlindTag");

      expect(await registry.MAX_BLIND_TAGS_PER_DATASET()).to.equal(16n);

      const salt1 = ethers.keccak256(ethers.toUtf8Bytes("DATASET_SALT_1"));
      const salt2 = ethers.keccak256(ethers.toUtf8Bytes("DATASET_SALT_2"));

      const onChainTag = await registry.computeBlindTag("gene", "ALDH2_rs671", salt1);
      const expectedTag = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(
          ["string", "string", "string", "bytes32"],
          ["GENOCHAIN_BLIND_TAG_V1", "gene", "ALDH2_rs671", salt1]
        )
      );
      expect(onChainTag).to.equal(expectedTag);

      // Different salt, key/value, or undomain-separated encoding must NOT collide
      const tagDifferentSalt = await registry.computeBlindTag("gene", "ALDH2_rs671", salt2);
      const tagDifferentVal = await registry.computeBlindTag("gene", "BRCA1_185delAG", salt1);
      const unseparatedTag = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(
          ["string", "string", "bytes32"],
          ["gene", "ALDH2_rs671", salt1]
        )
      );
      expect(onChainTag).to.not.equal(tagDifferentSalt);
      expect(onChainTag).to.not.equal(tagDifferentVal);
      expect(onChainTag).to.not.equal(unseparatedTag);
    });

    it("2.2 setDatasetBlindTags accepts max 16 tags, cleanly clears removed tags on replacement, and supports clearing to empty", async function () {
      assertMethodExists(registry, "setDatasetBlindTags");
      assertMethodExists(registry, "datasetBlindTags");
      assertMethodExists(registry, "datasetBlindTagCount");
      assertMethodExists(registry, "matchesBlindTag");

      const { dataId } = await registerLegacyDataset("M2_REPLACE");
      const sixteenTags = Array.from({ length: 16 }, (_, i) => makeTag(`MAX_${i}`));

      const tx16 = await registry.connect(seller).setDatasetBlindTags(dataId, sixteenTags);
      await tx16.wait();
      expect(await registry.datasetBlindTagCount(dataId)).to.equal(16n);
      for (const t of sixteenTags) {
        expect(await registry.datasetBlindTags(dataId, t)).to.equal(true);
        expect(await registry.matchesBlindTag(dataId, t)).to.equal(true);
      }

      // Replace with 2 tags -> all 16 previous tags must return false
      const newTags = [makeTag("NEW_A"), makeTag("NEW_B")];
      const txReplace = await registry.connect(seller).setDatasetBlindTags(dataId, newTags);
      await expect(txReplace).to.emit(registry, "BlindTagRegistered").withArgs(dataId, newTags[0]);
      await expect(txReplace).to.emit(registry, "BlindTagRegistered").withArgs(dataId, newTags[1]);

      expect(await registry.datasetBlindTagCount(dataId)).to.equal(2n);
      for (const oldTag of sixteenTags) {
        expect(await registry.datasetBlindTags(dataId, oldTag)).to.equal(false);
        expect(await registry.matchesBlindTag(dataId, oldTag)).to.equal(false);
      }
      expect(await registry.matchesBlindTag(dataId, newTags[0])).to.equal(true);
      expect(await registry.matchesBlindTag(dataId, newTags[1])).to.equal(true);

      // Clear all tags cleanly
      await (await registry.connect(seller).setDatasetBlindTags(dataId, [])).wait();
      expect(await registry.datasetBlindTagCount(dataId)).to.equal(0n);
      expect(await registry.datasetBlindTags(dataId, newTags[0])).to.equal(false);
      expect(await registry.matchesBlindTag(dataId, newTags[0])).to.equal(false);
    });

    it("2.3 setDatasetBlindTags and matchesBlindTag reject invalid inputs, non-owners, and out-of-range dataIds while preserving state", async function () {
      assertMethodExists(registry, "setDatasetBlindTags");
      assertMethodExists(registry, "matchesBlindTag");
      assertMethodExists(registry, "datasetBlindTagCount");

      const { dataId } = await registerLegacyDataset("M2_GUARDS");
      const initialTag = makeTag("INITIAL_OK");
      await (await registry.connect(seller).setDatasetBlindTags(dataId, [initialTag])).wait();

      // Out-of-range dataId reverts DataNotFound
      for (const badId of [0n, dataId + 1n]) {
        await expect(
          registry.connect(seller).setDatasetBlindTags(badId, [makeTag("X")])
        ).to.be.revertedWithCustomError(registry, "DataNotFound");
        await expect(
          registry.matchesBlindTag(badId, initialTag)
        ).to.be.revertedWithCustomError(registry, "DataNotFound");
      }

      // Non-owner rejected with NotDataOwner
      await expect(
        registry.connect(attacker).setDatasetBlindTags(dataId, [makeTag("HIJACK")])
      ).to.be.revertedWithCustomError(registry, "NotDataOwner");

      // >16 tags, zero tag, and duplicate tags all revert InvalidBlindTag
      const seventeen = Array.from({ length: 17 }, (_, i) => makeTag(`TOO_MANY_${i}`));
      await expect(
        registry.connect(seller).setDatasetBlindTags(dataId, seventeen)
      ).to.be.revertedWithCustomError(registry, "InvalidBlindTag");

      await expect(
        registry.connect(seller).setDatasetBlindTags(dataId, [makeTag("OK"), ethers.ZeroHash])
      ).to.be.revertedWithCustomError(registry, "InvalidBlindTag");

      const dup = makeTag("DUP");
      await expect(
        registry.connect(seller).setDatasetBlindTags(dataId, [dup, makeTag("MID"), dup])
      ).to.be.revertedWithCustomError(registry, "InvalidBlindTag");

      // Existing blind tag state remains completely intact after failed attempts
      expect(await registry.datasetBlindTagCount(dataId)).to.equal(1n);
      expect(await registry.matchesBlindTag(dataId, initialTag)).to.equal(true);
    });

    it("2.4 matchesBlindTag enforces Active lifecycle symmetry across Active, Paused, and Revoked states", async function () {
      assertMethodExists(registry, "setDatasetBlindTags");
      assertMethodExists(registry, "matchesBlindTag");

      const { dataId } = await registerLegacyDataset("M2_LIFECYCLE");
      const tag = makeTag("TRAIT_LIFECYCLE");
      await (await registry.connect(seller).setDatasetBlindTags(dataId, [tag])).wait();

      expect(await registry.matchesBlindTag(dataId, tag)).to.equal(true);
      expect(await registry.matchesBlindTag(dataId, makeTag("UNREGISTERED"))).to.equal(false);

      // Pause dataset -> matchesBlindTag must return false
      await (await registry.connect(seller).updateDataStatus(dataId, 1)).wait();
      expect(await registry.matchesBlindTag(dataId, tag)).to.equal(false);

      // Unpause dataset -> matchesBlindTag returns true again
      await (await registry.connect(seller).updateDataStatus(dataId, 0)).wait();
      expect(await registry.matchesBlindTag(dataId, tag)).to.equal(true);

      // Revoke dataset -> matchesBlindTag permanently returns false
      await (await registry.connect(seller).updateDataStatus(dataId, 2)).wait();
      expect(await registry.matchesBlindTag(dataId, tag)).to.equal(false);
    });
  });

  // ===========================================================================
  // Module 3: On-Chain Study Reuse Fee (5%) & Secondary EIP-2981 Royalty Split
  // ===========================================================================
  describe("Module 3: On-Chain Study Reuse Fee (5%) & Secondary EIP-2981 Royalty Split", function () {
    it("3.1 REUSE_FEE_BPS == 500, quoteReuseFee computes exact 5% with 1 wei minimum floor and enforces dataId bounds", async function () {
      assertMethodExists(registry, "REUSE_FEE_BPS");
      assertMethodExists(registry, "quoteReuseFee");

      expect(await registry.REUSE_FEE_BPS()).to.equal(500n);

      const { dataId: idStd } = await registerLegacyDataset("M3_STD_PRICE", seller, PRICE, ROYALTY_BPS);
      const { dataId: idDust } = await registerLegacyDataset("M3_DUST_PRICE", seller, 10n, ROYALTY_BPS);

      expect(await registry.quoteReuseFee(idStd)).to.equal((PRICE * 500n) / 10000n); // 5 GENO
      expect(await registry.quoteReuseFee(idDust)).to.equal(1n); // floor max(1, (10 * 500) / 10000) == 1 wei

      await expect(registry.quoteReuseFee(0n)).to.be.revertedWithCustomError(registry, "DataNotFound");
      await expect(registry.quoteReuseFee(idDust + 1n)).to.be.revertedWithCustomError(registry, "DataNotFound");
    });

    it("3.2 recordStudyReuse settles full 5% fee to primary owner, emits StudyReuseRecorded, and updates receipt/count", async function () {
      assertMethodExists(registry, "recordStudyReuse");
      assertMethodExists(registry, "quoteReuseFee");
      assertMethodExists(registry, "studyReuseReceipts");
      assertMethodExists(registry, "datasetReuseCount");

      const { dataId } = await registerLegacyDataset("M3_PRIMARY");
      await (await registry.connect(buyer).grantAccess(dataId)).wait();

      const reuseFee = await registry.quoteReuseFee(dataId);
      expect(reuseFee).to.equal(5n * 10n ** 18n);
      const [, expectedRoyalty] = await nft.royaltyInfo(1n, reuseFee);
      const studyCommitment = ethers.keccak256(ethers.toUtf8Bytes("STUDY_GWAS_PRIMARY_2026"));

      const buyerBefore = await token.balanceOf(buyer.address);
      const sellerBefore = await token.balanceOf(seller.address);

      const tx = await registry.connect(buyer).recordStudyReuse(dataId, studyCommitment);
      const receipt = await tx.wait();
      const parsedReuseLogs = receipt.logs
        .map((log) => {
          try {
            return registry.interface.parseLog(log);
          } catch (_) {
            return null;
          }
        })
        .filter((ev) => ev && ev.name === "StudyReuseRecorded");

      expect(parsedReuseLogs.length).to.equal(1);
      const evArgs = parsedReuseLogs[0].args;
      expect(evArgs[0]).to.equal(dataId);
      expect(evArgs[1]).to.equal(buyer.address);
      expect(evArgs[2]).to.equal(studyCommitment);
      expect(evArgs[3]).to.equal(reuseFee);
      expect(evArgs[4] === expectedRoyalty || evArgs[4] === 0n).to.equal(true);

      expect(buyerBefore - (await token.balanceOf(buyer.address))).to.equal(reuseFee);
      expect((await token.balanceOf(seller.address)) - sellerBefore).to.equal(reuseFee);
      expect(await token.balanceOf(registry.target)).to.equal(0n);

      expect(await registry.studyReuseReceipts(dataId, studyCommitment)).to.equal(true);
      expect(await registry.datasetReuseCount(dataId)).to.equal(1n);
    });

    it("3.3 recordStudyReuse splits EIP-2981 royalty (10% creator / 90% currentOwner) after secondary NFT transfer", async function () {
      assertMethodExists(registry, "recordStudyReuse");
      assertMethodExists(registry, "quoteReuseFee");

      const { dataId } = await registerLegacyDataset("M3_SECONDARY", seller, PRICE, 1000); // 10% creator royalty

      // Secondary transfer: original creator (seller) transfers NFT #1 to newOwner
      await (await nft.connect(seller).transferFrom(seller.address, newOwner.address, 1n)).wait();
      expect(await nft.ownerOf(1n)).to.equal(newOwner.address);

      // Researcher purchases access on secondary market
      await (await registry.connect(buyer).grantAccess(dataId)).wait();

      const reuseFee = await registry.quoteReuseFee(dataId); // 5 GENO
      const [royaltyReceiver, royaltyAmount] = await nft.royaltyInfo(1n, reuseFee);
      expect(royaltyReceiver).to.equal(seller.address);
      expect(royaltyAmount).to.equal(5n * 10n ** 17n); // 0.5 GENO (10% of 5 GENO)
      const sellerProceeds = reuseFee - royaltyAmount; // 4.5 GENO

      const buyerBefore = await token.balanceOf(buyer.address);
      const creatorBefore = await token.balanceOf(seller.address);
      const ownerBefore = await token.balanceOf(newOwner.address);
      const studyCommitment = ethers.keccak256(ethers.toUtf8Bytes("STUDY_SECONDARY_SPLIT"));

      await expect(registry.connect(buyer).recordStudyReuse(dataId, studyCommitment))
        .to.emit(registry, "StudyReuseRecorded")
        .withArgs(dataId, buyer.address, studyCommitment, reuseFee, royaltyAmount);

      expect(buyerBefore - (await token.balanceOf(buyer.address))).to.equal(reuseFee);
      expect((await token.balanceOf(seller.address)) - creatorBefore).to.equal(royaltyAmount);
      expect((await token.balanceOf(newOwner.address)) - ownerBefore).to.equal(sellerProceeds);
      expect(await token.balanceOf(registry.target)).to.equal(0n);
      expect(await registry.studyReuseReceipts(dataId, studyCommitment)).to.equal(true);
      expect(await registry.datasetReuseCount(dataId)).to.equal(1n);
    });

    it("3.4 recordStudyReuse rejects zero commitment and prevents studyCommitment replay across buyers while scoping per dataset", async function () {
      assertMethodExists(registry, "recordStudyReuse");
      assertMethodExists(registry, "studyReuseReceipts");
      assertMethodExists(registry, "datasetReuseCount");

      const { dataId: id1 } = await registerLegacyDataset("M3_REPLAY_1");
      const { dataId: id2 } = await registerLegacyDataset("M3_REPLAY_2");

      await (await registry.connect(buyer).grantAccess(id1)).wait();
      await (await registry.connect(buyer2).grantAccess(id1)).wait();
      await (await registry.connect(buyer).grantAccess(id2)).wait();

      const buyerBefore = await token.balanceOf(buyer.address);

      // Zero studyCommitment reverts InvalidStudyCommitment
      await expect(
        registry.connect(buyer).recordStudyReuse(id1, ethers.ZeroHash)
      ).to.be.revertedWithCustomError(registry, "InvalidStudyCommitment");
      expect(await token.balanceOf(buyer.address)).to.equal(buyerBefore);
      expect(await registry.datasetReuseCount(id1)).to.equal(0n);

      // First valid study reuse succeeds
      const commitA = ethers.keccak256(ethers.toUtf8Bytes("STUDY_COMMIT_A"));
      await (await registry.connect(buyer).recordStudyReuse(id1, commitA)).wait();
      expect(await registry.datasetReuseCount(id1)).to.equal(1n);

      // Replay by same buyer or different buyer on same dataset reverts StudyReuseAlreadyRecorded
      const buyerAfterFirst = await token.balanceOf(buyer.address);
      const buyer2Before = await token.balanceOf(buyer2.address);
      await expect(
        registry.connect(buyer).recordStudyReuse(id1, commitA)
      ).to.be.revertedWithCustomError(registry, "StudyReuseAlreadyRecorded");
      await expect(
        registry.connect(buyer2).recordStudyReuse(id1, commitA)
      ).to.be.revertedWithCustomError(registry, "StudyReuseAlreadyRecorded");

      expect(await token.balanceOf(buyer.address)).to.equal(buyerAfterFirst);
      expect(await token.balanceOf(buyer2.address)).to.equal(buyer2Before);
      expect(await registry.datasetReuseCount(id1)).to.equal(1n);

      // Same studyCommitment on a DIFFERENT dataset (id2) is allowed (scoped per dataId)
      await (await registry.connect(buyer).recordStudyReuse(id2, commitA)).wait();
      expect(await registry.studyReuseReceipts(id2, commitA)).to.equal(true);
      expect(await registry.datasetReuseCount(id2)).to.equal(1n);
    });

    it("3.5 recordStudyReuse enforces dataId bounds, active access (unpurchased/pending-escrow/expired), and Active status", async function () {
      assertMethodExists(registry, "recordStudyReuse");
      assertMethodExists(registry, "studyReuseReceipts");
      assertMethodExists(registry, "datasetReuseCount");

      const { dataId } = await registerLegacyDataset("M3_ACCESS_SYMMETRY");
      const commit1 = ethers.keccak256(ethers.toUtf8Bytes("STUDY_ACCESS_1"));

      // Invalid dataId reverts DataNotFound
      await expect(registry.connect(buyer).recordStudyReuse(0n, commit1)).to.be.revertedWithCustomError(
        registry,
        "DataNotFound"
      );
      await expect(registry.connect(buyer).recordStudyReuse(dataId + 1n, commit1)).to.be.revertedWithCustomError(
        registry,
        "DataNotFound"
      );

      // Unpurchased caller rejected without balance movement
      const attackerBefore = await token.balanceOf(attacker.address);
      await expectAccessDeniedRevert(() => registry.connect(attacker).recordStudyReuse(dataId, commit1));
      expect(await token.balanceOf(attacker.address)).to.equal(attackerBefore);

      // Pending-escrow buyer (capsule not yet delivered -> hasActiveAccess == false) rejected
      await (await registry.connect(buyer2).grantAccessWithEscrow(dataId, DISPUTE_WINDOW)).wait();
      expect(await registry.hasActiveAccess(dataId, buyer2.address)).to.equal(false);
      const buyer2AfterEscrow = await token.balanceOf(buyer2.address);
      await expectAccessDeniedRevert(() => registry.connect(buyer2).recordStudyReuse(dataId, commit1));
      expect(await token.balanceOf(buyer2.address)).to.equal(buyer2AfterEscrow);

      // Grant buyer access, then pause dataset -> reverts DataNotActive
      await (await registry.connect(buyer).grantAccess(dataId)).wait();
      const buyerAfterGrant = await token.balanceOf(buyer.address);
      await (await registry.connect(seller).updateDataStatus(dataId, 1)).wait(); // Paused
      await expect(registry.connect(buyer).recordStudyReuse(dataId, commit1)).to.be.revertedWithCustomError(
        registry,
        "DataNotActive"
      );
      expect(await token.balanceOf(buyer.address)).to.equal(buyerAfterGrant);

      // Unpause, then expire access -> rejected
      await (await registry.connect(seller).updateDataStatus(dataId, 0)).wait(); // Active
      await ethers.provider.send("evm_increaseTime", [ACCESS_DURATION + 10]);
      await ethers.provider.send("evm_mine", []);
      expect(await registry.hasActiveAccess(dataId, buyer.address)).to.equal(false);
      await expectAccessDeniedRevert(() => registry.connect(buyer).recordStudyReuse(dataId, commit1));
      expect(await token.balanceOf(buyer.address)).to.equal(buyerAfterGrant);

      // Re-purchase fresh access, then permanently revoke dataset -> reverts DataNotActive
      await (await registry.connect(buyer).grantAccess(dataId)).wait();
      await (await registry.connect(seller).updateDataStatus(dataId, 2)).wait(); // Revoked
      await expect(registry.connect(buyer).recordStudyReuse(dataId, commit1)).to.be.revertedWithCustomError(
        registry,
        "DataNotActive"
      );

      expect(await registry.studyReuseReceipts(dataId, commit1)).to.equal(false);
      expect(await registry.datasetReuseCount(dataId)).to.equal(0n);
    });
  });

  // ===========================================================================
  // Module 4: NFT Secondary Transfer Synchronization & Lifecycle Symmetry
  // ===========================================================================
  describe("Module 4: NFT Secondary Transfer Synchronization & Lifecycle Symmetry", function () {
    it("4.1 NFT transfer syncs currentOwner everywhere, revokes workers, and transfers anchor/tag authority to newOwner", async function () {
      assertMethodExists(registry, "anchorArtifactHashes");
      assertMethodExists(registry, "setDatasetBlindTags");
      assertMethodExists(registry, "getArtifactHashes");
      assertMethodExists(registry, "matchesBlindTag");

      const { dataId, rawHash } = await registerLegacyDataset("M4_TRANSFER");
      const oldTag = makeTag("PRE_TRANSFER");
      const newTag = makeTag("POST_TRANSFER");
      const sumHash = makeHash("POST_TRANSFER_SUM");
      const metaHash = makeHash("POST_TRANSFER_META");

      await (await registry.connect(seller).setAuthorizedCapsuleWorker(dataId, worker.address, true)).wait();
      await (await registry.connect(seller).setDatasetBlindTags(dataId, [oldTag])).wait();
      expect(await registry.authorizedCapsuleWorkers(dataId, worker.address)).to.equal(true);

      // Transfer ERC-721 ownership from seller to newOwner
      await (await nft.connect(seller).transferFrom(seller.address, newOwner.address, 1n)).wait();

      // currentOwner synced across all views & worker authorization cleared
      expect((await registry.getGenomicData(dataId)).currentOwner).to.equal(newOwner.address);
      expect((await registry.genomicDataItems(dataId)).currentOwner).to.equal(newOwner.address);
      expect((await registry.getAllDataItems())[0].currentOwner).to.equal(newOwner.address);
      expect(await registry.authorizedCapsuleWorkers(dataId, worker.address)).to.equal(false);
      expect(await registry.capsuleWorkerAuthorizer(dataId, worker.address)).to.equal(ethers.ZeroAddress);

      // Old owner and previously authorized worker lose write authority
      await expect(
        registry.connect(seller).setDatasetBlindTags(dataId, [newTag])
      ).to.be.revertedWithCustomError(registry, "NotDataOwner");
      await expect(
        registry.connect(seller).anchorArtifactHashes(dataId, sumHash, metaHash)
      ).to.be.revertedWithCustomError(registry, "NotDataOwner");

      await (await registry.connect(buyer).grantAccess(dataId)).wait();
      const validCapsule = JSON.stringify({
        version: "GENO-ASYM-RSA-OAEP-v2",
        keyCipher: "ab".repeat(256),
      });
      await expect(
        registry.connect(worker).storeTransformedCapsule(dataId, buyer.address, validCapsule)
      ).to.be.revertedWithCustomError(registry, "NotDataOwner");

      // New NFT owner CAN anchor artifact hashes and update blind tags
      await (await registry.connect(newOwner).anchorArtifactHashes(dataId, sumHash, metaHash)).wait();
      await (await registry.connect(newOwner).setDatasetBlindTags(dataId, [newTag])).wait();

      expect(await registry.getArtifactHashes(dataId)).to.deep.equal([rawHash, sumHash, metaHash]);
      expect(await registry.matchesBlindTag(dataId, oldTag)).to.equal(false);
      expect(await registry.matchesBlindTag(dataId, newTag)).to.equal(true);
    });

    it("4.2 End-to-End Integration: Atomic Bundle Mint -> Blind Search -> Real Crypto Escrow -> Study Reuse Royalty Settlement", async function () {
      assertMethodExists(registry, "registerGenomicDataBundle");
      assertMethodExists(registry, "computeBlindTag");
      assertMethodExists(registry, "matchesBlindTag");
      assertMethodExists(registry, "recordStudyReuse");
      assertMethodExists(registry, "quoteReuseFee");

      // 1. Encrypt real genomic data & build domain-separated blind tag
      const rawVcf = "##fileformat=VCFv4.2\nchr12\t111803962\trs671\tG\tA\t100\tPASS\tDP=80\n";
      const enc = await encryptGenomicData(rawVcf);
      const rawHash = enc.rawDataHash;
      const summaryHash = ethers.sha256(ethers.toUtf8Bytes('{"variants":1,"gene":"ALDH2"}'));
      const metadataHash = ethers.sha256(ethers.toUtf8Bytes('{"schema":"phenopackets-v2"}'));

      const salt = ethers.keccak256(ethers.toUtf8Bytes("E2E_COHORT_SALT"));
      const aldh2Tag = await registry.computeBlindTag("rs671", "A", salt);

      // 2. Atomic bundle mint
      await (
        await registry.connect(seller).registerGenomicDataBundle(
          [rawHash, summaryHash, metadataHash],
          [ALT_RAW_CID, ALT_SUMMARY_CID, VALID_METADATA_CID, VALID_TOKEN_URI],
          PRICE,
          ACCESS_DURATION,
          ROYALTY_BPS,
          [aldh2Tag]
        )
      ).wait();
      const dataId = await registry.dataCount();

      // 3. Secondary NFT transfer to newOwner before commerce
      await (await nft.connect(seller).transferFrom(seller.address, newOwner.address, 1n)).wait();
      expect(await registry.matchesBlindTag(dataId, aldh2Tag)).to.equal(true);

      // 4. Buyer purchases via escrow and newOwner delivers real RSA-OAEP capsule
      const kp = await generateAsymmetricKeyPair(false);
      const pubJwk = await exportPublicKey(kp.publicKey);
      const capsule = await packageKeyCapsule(enc.keyHex, pubJwk, buyer.address, newOwner.address);

      await (await registry.connect(buyer).grantAccessWithEscrow(dataId, DISPUTE_WINDOW)).wait();
      await (await registry.connect(newOwner).storeTransformedCapsule(dataId, buyer.address, capsule)).wait();

      const storedCapsule = await registry.connect(buyer).getTransformedCapsule.staticCall(dataId);
      const { keyHex } = await decryptKeyCapsule(storedCapsule, kp.privateKey);
      expect(await decryptGenomicPayload(enc.payload, keyHex)).to.equal(rawVcf);

      // 5. Researcher records downstream study reuse with 5% fee split (10% creator / 90% newOwner)
      const reuseFee = await registry.quoteReuseFee(dataId);
      const [, expectedRoyalty] = await nft.royaltyInfo(1n, reuseFee);
      const creatorBefore = await token.balanceOf(seller.address);
      const newOwnerBefore = await token.balanceOf(newOwner.address);
      const studyCommitment = ethers.keccak256(ethers.toUtf8Bytes("E2E_META_ANALYSIS_2026"));

      await (await registry.connect(buyer).recordStudyReuse(dataId, studyCommitment)).wait();

      expect((await token.balanceOf(seller.address)) - creatorBefore).to.equal(expectedRoyalty);
      expect((await token.balanceOf(newOwner.address)) - newOwnerBefore).to.equal(reuseFee - expectedRoyalty);
      expect(await registry.studyReuseReceipts(dataId, studyCommitment)).to.equal(true);
      expect(await registry.datasetReuseCount(dataId)).to.equal(1n);
    });
  });
});
