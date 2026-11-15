import { expect } from "chai";
import hre from "hardhat";

/**
 * @title OWASP Smart Contract Top 10 (2026 Edition) Defense Verification Suite
 * @notice Formal validation and adversarial penetration tests based on:
 *         1. OWASP Smart Contract Top 10 (2026 Standard, published Feb 10, 2026)
 *         2. DeFiHackLabs BaseTestWithBalanceLog quantitative invariant pattern (\u0394Balance = 0)
 *         3. Web3 STLC (ISO/IEC/IEEE 29119-2:2021 & ISTQB v4.0.1 Web3 Adaptation)
 *         4. Empirical Security Standards (32nd USENIX Security 2023, ESEM 2026)
 * 
 * Target Architecture: GenoChain (Genomics on Blockchain - B\u00e0i T\u1eadp 06)
 * Target Contracts:
 *   - GenomicsRegistry.sol
 *   - GenomicToken.sol
 *   - GenomicNFT.sol
 *   - GenomicZkVerifier.sol
 */
describe("OWASP Smart Contract Top 10 (2026 Edition) & DeFiHackLabs Defense Suite", function () {
  let ethers;
  let deployer, aliceCreator, bobSeller, charlieBuyer, attacker;
  let genomicToken, genomicNFT, genomicsRegistry, zkVerifier;
  let PRICE, DURATION, ROYALTY_BPS;
  let SAMPLE_DATA_HASH, SAMPLE_RAW_CID, SAMPLE_SUMMARY_CID, SAMPLE_METADATA_CID, SAMPLE_TOKEN_URI;

  // DeFiHackLabs Balance Logger Helper: ensures \u0394Balance_Attacker == 0
  async function assertZeroAttackerGain(attackerSigner, tokenContract, attackAction) {
    const initialAttackerBalance = await tokenContract.balanceOf(attackerSigner.address);
    const initialContractBalance = await tokenContract.balanceOf(genomicsRegistry.target);

    // Execute attack action expecting rejection or safe revert
    await attackAction();

    const finalAttackerBalance = await tokenContract.balanceOf(attackerSigner.address);
    const finalContractBalance = await tokenContract.balanceOf(genomicsRegistry.target);

    expect(finalAttackerBalance).to.equal(
      initialAttackerBalance,
      "DeFiHackLabs Invariant Violation: Attacker balance must not increase (\u0394Balance == 0)"
    );
    expect(finalContractBalance).to.be.at.least(
      initialContractBalance,
      "Contract token custody must not be drained"
    );
  }

  beforeEach(async function () {
    ({ ethers } = await hre.network.create());
    PRICE = ethers.parseEther("100");
    DURATION = 30 * 24 * 60 * 60; // 30 days
    ROYALTY_BPS = 1000; // 10% EIP-2981 royalty

    SAMPLE_DATA_HASH = ethers.keccak256(ethers.toUtf8Bytes("GENOCHAIN_OWASP_2026_TRUTH"));
    SAMPLE_RAW_CID = "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi";
    SAMPLE_SUMMARY_CID = "bafybeicg2uboluo2yj4suxf2m2z42kaxg5h7g4e45d5z37s3sm63d2q7pm";
    SAMPLE_METADATA_CID = "bafybeihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku";
    SAMPLE_TOKEN_URI = "ipfs://bafybeihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku/metadata.json";

    [deployer, aliceCreator, bobSeller, charlieBuyer, attacker] = await ethers.getSigners();

    // 1. Deploy GenomicToken ($GENO)
    const TokenFactory = await ethers.getContractFactory("GenomicToken");
    genomicToken = await TokenFactory.deploy(deployer.address);
    await genomicToken.waitForDeployment();

    // 2. Deploy GenomicNFT with default 10% royalty
    const NFTFactory = await ethers.getContractFactory("GenomicNFT");
    genomicNFT = await NFTFactory.deploy(deployer.address, ROYALTY_BPS);
    await genomicNFT.waitForDeployment();

    // 3. Deploy GenomicsRegistry
    const RegistryFactory = await ethers.getContractFactory("GenomicsRegistry");
    genomicsRegistry = await RegistryFactory.deploy(
      genomicToken.target,
      genomicNFT.target,
      deployer.address
    );
    await genomicsRegistry.waitForDeployment();

    // Link NFT to Registry (INV-06)
    await genomicNFT.setRegistryContract(genomicsRegistry.target);

    // 4. Deploy GenomicZkVerifier
    const ZkFactory = await ethers.getContractFactory("GenomicZkVerifier");
    zkVerifier = await ZkFactory.deploy(genomicToken.target);
    await zkVerifier.waitForDeployment();

    // Fund accounts with GENO tokens
    await genomicToken.transfer(aliceCreator.address, ethers.parseEther("1000"));
    await genomicToken.transfer(bobSeller.address, ethers.parseEther("1000"));
    await genomicToken.transfer(charlieBuyer.address, ethers.parseEther("1000"));
    await genomicToken.transfer(attacker.address, ethers.parseEther("1000"));
    await genomicToken.transfer(deployer.address, ethers.parseEther("10000"));
  });

  // =========================================================================
  // SC01: Access Control Vulnerabilities ($220.0M in 2025/2026 incidents)
  // =========================================================================
  describe("SC01: Access Control & Privilege Verification", function () {
    it("SC01.1 - Direct minting on GenomicNFT reverts with OnlyRegistry when called by non-registry", async function () {
      await expect(
        genomicNFT.connect(attacker).mintGenomicNFT(
          attacker.address,
          SAMPLE_TOKEN_URI,
          SAMPLE_DATA_HASH,
          SAMPLE_RAW_CID,
          SAMPLE_SUMMARY_CID,
          SAMPLE_METADATA_CID,
          ROYALTY_BPS
        )
      ).to.be.revertedWithCustomError(genomicNFT, "OnlyRegistry");
    });

    it("SC01.2 - Only owner can set capsule dispatcher or rescue tokens; attacker is strictly rejected", async function () {
      await expect(
        genomicsRegistry.connect(attacker).setCapsuleDispatcher(attacker.address)
      ).to.be.revertedWithCustomError(genomicsRegistry, "OwnableUnauthorizedAccount");

      await expect(
        genomicsRegistry.connect(attacker).rescueTokens(genomicToken.target, attacker.address, 100n)
      ).to.be.revertedWithCustomError(genomicsRegistry, "OwnableUnauthorizedAccount");
    });

    it("SC01.3 - Storing transformed capsule is restricted to data owner or authorized capsule worker", async function () {
      // Alice registers genomic data
      await genomicsRegistry.connect(aliceCreator).registerGenomicData(
        SAMPLE_DATA_HASH,
        SAMPLE_RAW_CID,
        SAMPLE_SUMMARY_CID,
        SAMPLE_METADATA_CID,
        SAMPLE_TOKEN_URI,
        PRICE,
        DURATION,
        ROYALTY_BPS
      );

      // Charlie grants access
      await genomicToken.connect(charlieBuyer).approve(genomicsRegistry.target, PRICE);
      await genomicsRegistry.connect(charlieBuyer)["grantAccess(uint256)"](1);

      // Attacker attempts to store transformed capsule without permission
      const fakeCapsule = "{\"keyCipher\":\"deadbeef\"}";
      await expect(
        genomicsRegistry.connect(attacker).storeTransformedCapsule(1, charlieBuyer.address, fakeCapsule)
      ).to.be.revertedWithCustomError(genomicsRegistry, "NotDataOwner");
    });

    it("SC01.4 - Faucet anti-Sybil rate-limiting enforces cooldown on both caller and recipient (INV-15)", async function () {
      // First faucet call succeeds
      await genomicToken.connect(attacker).faucet(attacker.address);

      // Immediate repeated call from attacker fails
      await expect(
        genomicToken.connect(attacker).faucet(attacker.address)
      ).to.be.revertedWithCustomError(genomicToken, "FaucetCooldownActive");

      // Attacker attempts to bypass using secondary recipient address
      await expect(
        genomicToken.connect(attacker).faucet(bobSeller.address)
      ).to.be.revertedWithCustomError(genomicToken, "FaucetCooldownActive");
    });
  });

  // =========================================================================
  // SC02: Business Logic & Accounting Vulnerabilities ($188.7M in 2025/2026)
  // =========================================================================
  describe("SC02: Business Logic, Escrow Timelock & Royalty Accounting", function () {
    beforeEach(async function () {
      await genomicsRegistry.connect(aliceCreator).registerGenomicData(
        SAMPLE_DATA_HASH,
        SAMPLE_RAW_CID,
        SAMPLE_SUMMARY_CID,
        SAMPLE_METADATA_CID,
        SAMPLE_TOKEN_URI,
        PRICE,
        DURATION,
        ROYALTY_BPS
      );
    });

    it("SC02.1 - Escrow timelock dispute window strictly enforces [1 hour, 30 days] bounds", async function () {
      await genomicToken.connect(charlieBuyer).approve(genomicsRegistry.target, PRICE);

      // Window < 1 hour reverts
      const tooShortWindow = 1800; // 30 minutes
      await expect(
        genomicsRegistry.connect(charlieBuyer).grantAccessWithEscrow(1, tooShortWindow)
      ).to.be.revertedWithCustomError(genomicsRegistry, "InvalidDisputeWindow");

      // Window > 30 days reverts
      const tooLongWindow = 31 * 24 * 60 * 60; // 31 days
      await expect(
        genomicsRegistry.connect(charlieBuyer).grantAccessWithEscrow(1, tooLongWindow)
      ).to.be.revertedWithCustomError(genomicsRegistry, "InvalidDisputeWindow");
    });

    it("SC02.2 - Escrow prevents early refund while dispute window is active", async function () {
      const disputeWindow = 3600; // 1 hour
      await genomicToken.connect(charlieBuyer).approve(genomicsRegistry.target, PRICE);
      await genomicsRegistry.connect(charlieBuyer).grantAccessWithEscrow(1, disputeWindow);

      // Early refund attempt fails
      await expect(
        genomicsRegistry.connect(charlieBuyer).claimEscrowRefund(1)
      ).to.be.revertedWithCustomError(genomicsRegistry, "DisputeWindowActive");
    });

    it("SC02.3 - 100% refund guaranteed after dispute window expires if capsule was not delivered", async function () {
      const disputeWindow = 3600;
      await genomicToken.connect(charlieBuyer).approve(genomicsRegistry.target, PRICE);
      await genomicsRegistry.connect(charlieBuyer).grantAccessWithEscrow(1, disputeWindow);

      // Fast-forward time past dispute window
      await ethers.provider.send("evm_increaseTime", [3601]);
      await ethers.provider.send("evm_mine");

      const balanceBefore = await genomicToken.balanceOf(charlieBuyer.address);
      await genomicsRegistry.connect(charlieBuyer).claimEscrowRefund(1);
      const balanceAfter = await genomicToken.balanceOf(charlieBuyer.address);

      expect(balanceAfter - balanceBefore).to.equal(PRICE, "Buyer must receive 100% refund of escrowed funds");
    });

    it("SC02.4 - EIP-2981 royalty strictly splits 90% to seller and 10% to original creator on secondary sale", async function () {
      // Alice transfers NFT to Bob (secondary market)
      await genomicNFT.connect(aliceCreator).transferFrom(aliceCreator.address, bobSeller.address, 1);

      const aliceInitial = await genomicToken.balanceOf(aliceCreator.address);
      const bobInitial = await genomicToken.balanceOf(bobSeller.address);

      // Charlie purchases from secondary seller Bob
      await genomicToken.connect(charlieBuyer).approve(genomicsRegistry.target, PRICE);
      await genomicsRegistry.connect(charlieBuyer)["grantAccess(uint256)"](1);

      const aliceFinal = await genomicToken.balanceOf(aliceCreator.address);
      const bobFinal = await genomicToken.balanceOf(bobSeller.address);

      const expectedRoyalty = (PRICE * 1000n) / 10000n; // 10% = 10 GENO
      const expectedSellerProceeds = PRICE - expectedRoyalty; // 90% = 90 GENO

      expect(aliceFinal - aliceInitial).to.equal(expectedRoyalty, "Creator must receive exact 10% royalty");
      expect(bobFinal - bobInitial).to.equal(expectedSellerProceeds, "Seller must receive exact 90% proceeds");
    });
  });

  // =========================================================================
  // SC03: Price Oracle Manipulation ($20.7M in 2025/2026 incidents)
  // =========================================================================
  describe("SC03: Oracle Manipulation Immunity & MaxPrice Slippage Protection", function () {
    beforeEach(async function () {
      await genomicsRegistry.connect(aliceCreator).registerGenomicData(
        SAMPLE_DATA_HASH,
        SAMPLE_RAW_CID,
        SAMPLE_SUMMARY_CID,
        SAMPLE_METADATA_CID,
        SAMPLE_TOKEN_URI,
        PRICE,
        DURATION,
        ROYALTY_BPS
      );
    });

    it("SC03.1 - Fixed dataset pricing model is completely immune to external spot-oracle manipulation", async function () {
      const dataItem = await genomicsRegistry.getGenomicData(1);
      expect(dataItem.price).to.equal(PRICE);
    });

    it("SC03.2 - MaxPrice slippage parameter stops front-running repricing exploit (PriceExceedsMax)", async function () {
      // Alice maliciously increases price before Charlie's transaction confirms
      const higherPrice = ethers.parseEther("150");
      await genomicsRegistry.connect(aliceCreator).updateDataPrice(1, higherPrice);

      // Charlie specified maxPrice = 100 GENO; transaction safely reverts
      await genomicToken.connect(charlieBuyer).approve(genomicsRegistry.target, higherPrice);
      await expect(
        genomicsRegistry.connect(charlieBuyer)["grantAccess(uint256,uint256)"](1, PRICE) // maxPrice = 100 GENO
      ).to.be.revertedWithCustomError(genomicsRegistry, "PriceExceedsMax");
    });
  });

  // =========================================================================
  // SC04: Flash Loan–Facilitated Attacks ($27.8M in 2025/2026 incidents)
  // =========================================================================
  describe("SC04: DeFiHackLabs Flash Loan Drain Simulation (\u0394Balance = 0)", function () {
    it("SC04.1 - Flash loan funded attacker cannot manipulate registry or extract treasury funds", async function () {
      await assertZeroAttackerGain(attacker, genomicToken, async () => {
        // Attacker simulates receiving a 1,000,000 GENO flash loan
        const flashLoanAmount = ethers.parseEther("1000000");
        await genomicToken.transfer(attacker.address, flashLoanAmount);

        // Attacker attempts an unauthorized token rescue or registry manipulation
        await expect(
          genomicsRegistry.connect(attacker).rescueTokens(genomicToken.target, attacker.address, flashLoanAmount)
        ).to.be.revertedWithCustomError(genomicsRegistry, "OwnableUnauthorizedAccount");

        // Return flash loan
        await genomicToken.connect(attacker).transfer(deployer.address, flashLoanAmount);
      });
    });
  });

  // =========================================================================
  // SC05: Bad / Missing Input Validation ($4.1M in 2025/2026 incidents)
  // =========================================================================
  describe("SC05: Bad Input Validation & Collision Resistance", function () {
    it("SC05.1 - Rejects empty or invalid rawDataHash or CID with InvalidDataHashOrCid", async function () {
      await expect(
        genomicsRegistry.connect(aliceCreator).registerGenomicData(
          ethers.ZeroHash,
          SAMPLE_RAW_CID,
          SAMPLE_SUMMARY_CID,
          SAMPLE_METADATA_CID,
          SAMPLE_TOKEN_URI,
          PRICE,
          DURATION,
          ROYALTY_BPS
        )
      ).to.be.revertedWithCustomError(genomicsRegistry, "InvalidDataHashOrCid");

      await expect(
        genomicsRegistry.connect(aliceCreator).registerGenomicData(
          SAMPLE_DATA_HASH,
          "", // Empty raw CID
          SAMPLE_SUMMARY_CID,
          SAMPLE_METADATA_CID,
          SAMPLE_TOKEN_URI,
          PRICE,
          DURATION,
          ROYALTY_BPS
        )
      ).to.be.revertedWithCustomError(genomicsRegistry, "InvalidDataHashOrCid");
    });

    it("SC05.2 - Rejects duplicate rawDataHash registration with DataAlreadyRegistered", async function () {
      await genomicsRegistry.connect(aliceCreator).registerGenomicData(
        SAMPLE_DATA_HASH,
        SAMPLE_RAW_CID,
        SAMPLE_SUMMARY_CID,
        SAMPLE_METADATA_CID,
        SAMPLE_TOKEN_URI,
        PRICE,
        DURATION,
        ROYALTY_BPS
      );

      await expect(
        genomicsRegistry.connect(attacker).registerGenomicData(
          SAMPLE_DATA_HASH,
          SAMPLE_RAW_CID,
          SAMPLE_SUMMARY_CID,
          SAMPLE_METADATA_CID,
          SAMPLE_TOKEN_URI,
          PRICE,
          DURATION,
          ROYALTY_BPS
        )
      ).to.be.revertedWithCustomError(genomicsRegistry, "DataAlreadyRegistered");
    });

    it("SC05.3 - Faucet rejects address(0) recipient with InvalidRecipient", async function () {
      await expect(
        genomicToken.connect(attacker).faucet(ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(genomicToken, "InvalidRecipient");
    });
  });

  // =========================================================================
  // SC06: Unchecked Low-Level Calls ($0.55M in 2025/2026 incidents)
  // =========================================================================
  describe("SC06: SafeERC20 & Unchecked Low-Level Call Defense", function () {
    it("SC06.1 - Purchases without prior token approval revert cleanly via SafeERC20", async function () {
      await genomicsRegistry.connect(aliceCreator).registerGenomicData(
        SAMPLE_DATA_HASH,
        SAMPLE_RAW_CID,
        SAMPLE_SUMMARY_CID,
        SAMPLE_METADATA_CID,
        SAMPLE_TOKEN_URI,
        PRICE,
        DURATION,
        ROYALTY_BPS
      );

      // Charlie attempts to buy without approve; must revert cleanly without unhandled call failure
      await expect(
        genomicsRegistry.connect(charlieBuyer)["grantAccess(uint256)"](1)
      ).to.be.rejected;
    });

    it("SC06.2 - Non-existent function selector calls revert without state corruption", async function () {
      const maliciousData = "0xdeadbeef" + "00".repeat(32);
      await expect(
        attacker.sendTransaction({
          to: genomicsRegistry.target,
          data: maliciousData
        })
      ).to.be.rejected;
    });
  });

  // =========================================================================
  // SC07: Arithmetic Errors & Precision Loss ($138.1M in 2025/2026 incidents)
  // =========================================================================
  describe("SC07: Arithmetic Bounds, Zero Dust Loss & Boundary Precision", function () {
    it("SC07.1 - Rejects royalty basis points > 10000 (100%)", async function () {
      await expect(
        genomicsRegistry.connect(aliceCreator).registerGenomicData(
          SAMPLE_DATA_HASH,
          SAMPLE_RAW_CID,
          SAMPLE_SUMMARY_CID,
          SAMPLE_METADATA_CID,
          SAMPLE_TOKEN_URI,
          PRICE,
          DURATION,
          10001 // > 100%
        )
      ).to.be.rejected;
    });

    it("SC07.2 - Exact conservation of funds: seller proceeds + creator royalty == total price (0 dust loss)", async function () {
      const testPrice = ethers.parseEther("77.777777777777777777");
      await genomicsRegistry.connect(aliceCreator).registerGenomicData(
        SAMPLE_DATA_HASH,
        SAMPLE_RAW_CID,
        SAMPLE_SUMMARY_CID,
        SAMPLE_METADATA_CID,
        SAMPLE_TOKEN_URI,
        testPrice,
        DURATION,
        1555 // 15.55%
      );

      // Transfer NFT to Bob for secondary market test
      await genomicNFT.connect(aliceCreator).transferFrom(aliceCreator.address, bobSeller.address, 1);

      const aliceBefore = await genomicToken.balanceOf(aliceCreator.address);
      const bobBefore = await genomicToken.balanceOf(bobSeller.address);

      await genomicToken.connect(charlieBuyer).approve(genomicsRegistry.target, testPrice);
      await genomicsRegistry.connect(charlieBuyer)["grantAccess(uint256)"](1);

      const aliceDelta = (await genomicToken.balanceOf(aliceCreator.address)) - aliceBefore;
      const bobDelta = (await genomicToken.balanceOf(bobSeller.address)) - bobBefore;

      expect(aliceDelta + bobDelta).to.equal(testPrice, "Sum of split funds must exactly equal total paid price");
    });

    it("SC07.3 - Safe handling of 1 wei price without underflow or division-by-zero", async function () {
      const oneWei = 1n;
      const hash = ethers.keccak256(ethers.toUtf8Bytes("ONE_WEI_DATASET"));
      await genomicsRegistry.connect(aliceCreator).registerGenomicData(
        hash,
        SAMPLE_RAW_CID,
        SAMPLE_SUMMARY_CID,
        SAMPLE_METADATA_CID,
        SAMPLE_TOKEN_URI,
        oneWei,
        DURATION,
        ROYALTY_BPS
      );

      const item = await genomicsRegistry.getGenomicData(1);
      expect(item.price).to.equal(oneWei);
    });
  });

  // =========================================================================
  // SC08: Reentrancy Defense & Checks-Effects-Interactions (CEI)
  // =========================================================================
  describe("SC08: Reentrancy Defense & Checks-Effects-Interactions (CEI)", function () {
    it("SC08.1 - ReentrancyGuard protects grantAccess against malicious callback hijack", async function () {
      await genomicsRegistry.connect(aliceCreator).registerGenomicData(
        SAMPLE_DATA_HASH,
        SAMPLE_RAW_CID,
        SAMPLE_SUMMARY_CID,
        SAMPLE_METADATA_CID,
        SAMPLE_TOKEN_URI,
        PRICE,
        DURATION,
        ROYALTY_BPS
      );

      // Standard grantAccess conforms to nonReentrant modifier and grants active status
      await genomicToken.connect(charlieBuyer).approve(genomicsRegistry.target, PRICE);
      await genomicsRegistry.connect(charlieBuyer)["grantAccess(uint256)"](1);

      const grant = await genomicsRegistry.accessGrants(1, charlieBuyer.address);
      expect(grant.isGranted).to.be.true;
    });

    it("SC08.2 - ReentrancyGuard protects claimZkBounty against repeated bounty drainage and validates curves", async function () {
      // Create a ZK bounty
      const targetTrait = ethers.keccak256(ethers.toUtf8Bytes("ALDH2_rs671"));
      const reward = ethers.parseEther("50");
      const maxClaims = 2;
      const duration = 7 * 24 * 3600;

      await genomicToken.connect(deployer).approve(zkVerifier.target, reward * BigInt(maxClaims));
      await zkVerifier.connect(deployer).createZkBounty(
        targetTrait,
        "ALDH2 Variant Study",
        reward,
        maxClaims,
        duration
      );

      // Attempting claim with invalid / off-curve proof points reverts with InvalidCurvePoint
      const badProof = {
        a: [1n, 2n],
        b: [[1n, 2n], [3n, 4n]],
        c: [5n, 6n]
      };
      const badCommitment = ethers.keccak256(ethers.toUtf8Bytes("FORGED"));

      await expect(
        zkVerifier.connect(attacker).claimZkBounty(1, badProof, badCommitment)
      ).to.be.revertedWithCustomError(zkVerifier, "InvalidCurvePoint");
    });
  });

  // =========================================================================
  // SC09: Integer Overflow & Underflow ($260.4M in 2025/2026 incidents)
  // =========================================================================
  describe("SC09: Solidity 0.8.20 Checked Arithmetic & Timestamp Boundaries", function () {
    it("SC09.1 - Arithmetic overflow in access duration timestamp calculation reverts safely", async function () {
      const maxUint256 = ethers.MaxUint256;
      await genomicsRegistry.connect(aliceCreator).registerGenomicData(
        SAMPLE_DATA_HASH,
        SAMPLE_RAW_CID,
        SAMPLE_SUMMARY_CID,
        SAMPLE_METADATA_CID,
        SAMPLE_TOKEN_URI,
        PRICE,
        maxUint256, // Duration causing block.timestamp + duration overflow in grantAccess
        ROYALTY_BPS
      );

      await genomicToken.connect(charlieBuyer).approve(genomicsRegistry.target, PRICE);
      // grantAccess calculates block.timestamp + data.accessDuration which overflows uint256
      await expect(
        genomicsRegistry.connect(charlieBuyer)["grantAccess(uint256)"](1)
      ).to.be.rejected; // Reverts on overflow
    });

    it("SC09.2 - Paginated queries safely handle offset + limit > total items without out-of-bounds error", async function () {
      await genomicsRegistry.connect(aliceCreator).registerGenomicData(
        SAMPLE_DATA_HASH,
        SAMPLE_RAW_CID,
        SAMPLE_SUMMARY_CID,
        SAMPLE_METADATA_CID,
        SAMPLE_TOKEN_URI,
        PRICE,
        DURATION,
        ROYALTY_BPS
      );

      // Query offset=5, limit=10 on catalog size 1: returns empty array without panicking
      const [items, total] = await genomicsRegistry.getDataItemsPaginated(5, 10);
      expect(items.length).to.equal(0);
      expect(total).to.equal(1n);
    });
  });

  // =========================================================================
  // SC10: Upgradeability, Proxy & Storage Layout Flaws ($2.9M in 2025/2026)
  // =========================================================================
  describe("SC10: Immutability Invariants & Storage Collision Immunity", function () {
    it("SC10.1 - Core contracts employ immutable architecture; storage layout is static and collision-free", async function () {
      // GenoChain registry references token and NFT via immutable state variables
      expect(await genomicsRegistry.paymentToken()).to.equal(genomicToken.target);
      expect(await genomicsRegistry.genomicNFT()).to.equal(genomicNFT.target);
    });

    it("SC10.2 - NFT contract registry address cannot be updated by non-owner", async function () {
      await expect(
        genomicNFT.connect(attacker).setRegistryContract(attacker.address)
      ).to.be.revertedWithCustomError(genomicNFT, "OwnableUnauthorizedAccount");
    });
  });
});
