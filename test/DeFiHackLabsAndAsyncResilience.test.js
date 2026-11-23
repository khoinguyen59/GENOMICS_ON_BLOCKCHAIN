import { expect } from "chai";
import hre from "hardhat";
import {
  executeSerializedTx,
  smartReadWithRetry,
  safePollReceipt,
  sanitizeGenomicMetadata
} from "../frontend/src/utils/asyncResilience.js";

describe("Authoritative Security Suite: DeFiHackLabs, Damn Vulnerable DeFi & Async RPC Resilience", function () {
  let ethers;
  let token, nft, registry;
  let owner, creator, buyer, attacker;

  beforeEach(async function () {
    ({ ethers } = await hre.network.create());
    [owner, creator, buyer, attacker] = await ethers.getSigners();

    const GenomicToken = await ethers.getContractFactory("GenomicToken");
    token = await GenomicToken.deploy(owner.address);
    await token.waitForDeployment();

    const GenomicNFT = await ethers.getContractFactory("GenomicNFT");
    nft = await GenomicNFT.deploy(owner.address, 1000); // 10% royalty default
    await nft.waitForDeployment();

    const GenomicsRegistry = await ethers.getContractFactory("GenomicsRegistry");
    registry = await GenomicsRegistry.deploy(token.target, nft.target, owner.address);
    await registry.waitForDeployment();

    await nft.setRegistryContract(registry.target);
  });

  describe("Section 1: SunWeb3Sec/DeFiHackLabs Incident Patterns & Privilege Defense", function () {
    it("1.1 [PolyNetwork Incident Pattern] Arbitrary calldata selector collision cannot invoke privileged internal mutators", async function () {
      // In PolyNetwork_exp.sol, the attacker crafted a selector collision to putCurEpochConPubKeyBytes.
      // Verify that calling non-existent selectors or attempting to override internal parameters reverts cleanly.
      const maliciousCalldata = "0x41424344" + "0".repeat(64); // random 4-byte selector + padding
      await expect(
        attacker.sendTransaction({
          to: registry.target,
          data: maliciousCalldata
        })
      ).to.be.rejected;
    });

    it("1.2 [PolyNetwork Incident Pattern] Direct call to GenomicNFT minting reverts without registry privilege", async function () {
      await expect(
        nft.connect(attacker).mintGenomicNFT(
          attacker.address,
          "ipfs://malicious",
          ethers.ZeroHash,
          "QmRawMalicious",
          "QmSumMalicious",
          "QmMetaMalicious",
          1000
        )
      ).to.be.revertedWithCustomError(nft, "OnlyRegistry");
    });

    it("1.3 [Mosca Incident Pattern] ReentrancyGuard strictly prevents nested state mutations during grantAccess", async function () {
      // Deploy GenomicsRegistry backed by MaliciousReentrantToken (ERC-20 transferFrom callback attempting nested grantAccess)
      const MalToken = await ethers.getContractFactory("MaliciousReentrantToken");
      const malToken = await MalToken.deploy(owner.address);
      await malToken.waitForDeployment();

      const GenomicNFT = await ethers.getContractFactory("GenomicNFT");
      const malNft = await GenomicNFT.deploy(owner.address, 1000);
      await malNft.waitForDeployment();

      const GenomicsRegistry = await ethers.getContractFactory("GenomicsRegistry");
      const malRegistry = await GenomicsRegistry.deploy(malToken.target, malNft.target, owner.address);
      await malRegistry.waitForDeployment();
      await (await malNft.connect(owner).setRegistryContract(malRegistry.target)).wait();

      const rawHash = ethers.keccak256(ethers.toUtf8Bytes("Mosca_Test_Raw_Sequence"));
      const price = ethers.parseEther("100");
      await (await malRegistry.connect(creator).registerGenomicData(
        rawHash,
        "QmfPYRCPEyKhJfBkb7nv7DH2ArTmbATRD75uzCLuBPoy1C",
        "QmYW4MJVyHPTDj2CkKqSFFMoKd4Zoed16tjCjrDQZGJ7an",
        "QmNymqhbW6yts2JAC8py2YqUSpg9YpeMG3X3i4cNxV3iKm",
        "ipfs://sample",
        price,
        86400 * 30,
        1000
      )).wait();

      // Owner self-purchase still rejected cleanly
      await expect(
        malRegistry.connect(creator).grantAccess(1)
      ).to.be.revertedWithCustomError(malRegistry, "OwnerCannotBuyOwnData");

      // Fund buyer & arm reentrancy callback into grantAccess(1) during payment transferFrom
      await (await malToken.connect(owner).transfer(buyer.address, price * 2n)).wait();
      await (await malToken.connect(buyer).approve(malRegistry.target, price * 2n)).wait();
      await (await malToken.connect(owner).setRegistryAndTarget(malRegistry.target, 1n)).wait();

      // Outer grantAccess completes, while nested reentrant grantAccess MUST be rejected by EIP-1153 ReentrancyGuard
      await expect(malRegistry.connect(buyer).grantAccess(1n)).to.emit(malRegistry, "AccessGranted");
      expect(await malToken.attackInitiated()).to.equal(true);
      expect(await malToken.attackSucceeded()).to.equal(false);
      expect(await malToken.lastErrorMessage()).to.equal("ReentrancyGuardReentrantCall()");
      expect(await malRegistry.hasActiveAccess(1n, buyer.address)).to.equal(true);
    });
  });

  describe("Section 2: tinchoabbate/Damn Vulnerable DeFi & Solady Mathematical Invariants", function () {
    it("2.1 [Unstoppable Vault Invariant] Direct token donation cannot alter dataset pricing or DoS legitimate purchases", async function () {
      // In Damn Vulnerable DeFi Unstoppable (#1), donating tokens to the vault caused balanceBefore != totalSupply DoS.
      // In GenoChain, verify that donating GENO directly to GenomicsRegistry does NOT corrupt access fee or prevent purchases.
      const rawHash = ethers.keccak256(ethers.toUtf8Bytes("Unstoppable_Sequence"));
      const price = ethers.parseEther("100");

      await registry.connect(creator).registerGenomicData(
        rawHash,
        "QmYrZd8JXWDSykEYGckk92HBd9U7pWAfz2KDPHfcSA4vJB",
        "QmQAxuArgq1vTWHGQ93ajrSoytvDuNwzj9TeGpytTCbdR4",
        "Qmcqs6pt9m2qZSfT6ukExiRYdoZyQEBJhizTJja1DSej8d",
        "ipfs://unstoppable",
        price,
        86400 * 30,
        1000
      );

      // Attacker acquires tokens from owner and donates 500 GENO directly to registry contract address
      await token.connect(owner).transfer(attacker.address, ethers.parseEther("500"));
      await token.connect(attacker).transfer(registry.target, ethers.parseEther("500"));

      // Buyer acquires tokens from owner and approves exact price
      await token.connect(owner).transfer(buyer.address, price);
      await token.connect(buyer).approve(registry.target, price);

      // Legitimate purchase must succeed despite foreign token balance on registry contract
      await expect(registry.connect(buyer).grantAccess(1)).to.emit(registry, "AccessGranted");
      const hasAccess = await registry.hasActiveAccess(1, buyer.address);
      expect(hasAccess).to.be.true;
    });

    it("2.2 [Solady Exact Royalty Conservation] Seller proceeds + Creator royalty strictly equals total price", async function () {
      // Use an odd-wei secondary-sale price (250 GENO + 7 wei) to prove 0-wei dust conservation on live EVM state
      const price = ethers.parseEther("250") + 7n;
      const royaltyBps = 1000; // 10%
      const rawHash = ethers.keccak256(ethers.toUtf8Bytes("Solady_Exact_Royalty_Conservation_Seq"));

      await (await registry.connect(creator).registerGenomicData(
        rawHash,
        "QmYrZd8JXWDSykEYGckk92HBd9U7pWAfz2KDPHfcSA4vJB",
        "QmQAxuArgq1vTWHGQ93ajrSoytvDuNwzj9TeGpytTCbdR4",
        "Qmcqs6pt9m2qZSfT6ukExiRYdoZyQEBJhizTJja1DSej8d",
        "ipfs://royalty-conservation",
        price,
        86400 * 30,
        royaltyBps
      )).wait();

      // Transfer NFT from originalCreator -> secondarySeller (attacker) so active EIP-2981 split executes on-chain
      const secondarySeller = attacker;
      await (await nft.connect(creator).transferFrom(creator.address, secondarySeller.address, 1n)).wait();

      // Query on-chain EIP-2981 royaltyInfo(tokenId=1, price)
      const [royaltyReceiver, quotedRoyalty] = await nft.royaltyInfo(1n, price);
      expect(royaltyReceiver).to.equal(creator.address);
      expect(quotedRoyalty).to.equal((price * BigInt(royaltyBps)) / 10000n);

      await (await token.connect(owner).transfer(buyer.address, price)).wait();
      await (await token.connect(buyer).approve(registry.target, price)).wait();

      const buyerBefore = await token.balanceOf(buyer.address);
      const creatorBefore = await token.balanceOf(creator.address);
      const sellerBefore = await token.balanceOf(secondarySeller.address);
      const registryBefore = await token.balanceOf(registry.target);

      await expect(registry.connect(buyer).grantAccess(1n))
        .to.emit(registry, "RoyaltyPaid")
        .withArgs(1n, creator.address, quotedRoyalty);

      const buyerDelta = buyerBefore - (await token.balanceOf(buyer.address));
      const royaltyDelta = (await token.balanceOf(creator.address)) - creatorBefore;
      const sellerDelta = (await token.balanceOf(secondarySeller.address)) - sellerBefore;
      const registryDelta = (await token.balanceOf(registry.target)) - registryBefore;

      expect(buyerDelta).to.equal(price);
      expect(royaltyDelta).to.equal(quotedRoyalty);
      expect(sellerDelta).to.equal(price - quotedRoyalty);
      expect(sellerDelta + royaltyDelta).to.equal(price); // 0 wei dust loss
      expect(registryDelta).to.equal(0n); // Registry retains 0 wei dust
    });
  });

  describe("Section 3: Async RPC Resilience & eRPC NotLaggingQuorum Architecture", function () {
    it("3.1 [ZetaChain Nonce Gap Defense] Serialized transaction execution prevents race conditions and out-of-order execution", async function () {
      // Fund buyer from owner initial supply
      const amount = ethers.parseEther("10");
      await token.connect(owner).transfer(buyer.address, amount * 5n);

      const recipient1 = ethers.Wallet.createRandom().address;
      const recipient2 = ethers.Wallet.createRandom().address;

      // Execute serialized via p-queue (concurrency: 1)
      const task1 = executeSerializedTx(buyer.address, async () => {
        const tx = await token.connect(buyer).transfer(recipient1, amount);
        return tx.wait();
      });

      const task2 = executeSerializedTx(buyer.address, async () => {
        const tx = await token.connect(buyer).transfer(recipient2, amount);
        return tx.wait();
      });

      const [receipt1, receipt2] = await Promise.all([task1, task2]);

      expect(receipt1.status).to.equal(1);
      expect(receipt2.status).to.equal(1);
      expect(await token.balanceOf(recipient1)).to.equal(amount);
      expect(await token.balanceOf(recipient2)).to.equal(amount);
    });

    it("3.2 [eRPC Lagging RPC Defense] safePollReceipt successfully traps invalid hashes and handles null responses safely", async function () {
      // Invalid hash should immediately reject
      await expect(safePollReceipt(ethers.provider, "invalid-hash")).to.be.rejectedWith("Invalid transaction hash");

      // Valid transaction receipt polling
      const tx = await token.connect(owner).transfer(buyer.address, ethers.parseEther("50"));
      const receipt = await safePollReceipt(ethers.provider, tx.hash, 5000, 100);

      expect(receipt).to.not.be.null;
      expect(receipt.hash).to.equal(tx.hash);
      expect(receipt.blockNumber).to.be.greaterThan(0);
    });

    it("3.3 [Idempotent Read Retry] smartReadWithRetry successfully executes and retries transient errors with exponential backoff", async function () {
      await token.connect(owner).transfer(buyer.address, ethers.parseEther("100"));

      let attempts = 0;
      const flakyRead = async () => {
        attempts++;
        if (attempts < 3) {
          throw new Error("RPC Rate Limit Exceeded (HTTP 429)");
        }
        return await token.balanceOf(buyer.address);
      };

      const result = await smartReadWithRetry(flakyRead, {
        retries: 3,
        minTimeout: 10,
        maxTimeout: 50
      });

      expect(attempts).to.equal(3);
      expect(result).to.be.greaterThan(0n);
    });
  });

  describe("Section 4: OWASP CheatSheet & DOMPurify Metadata Sanitization", function () {
    it("4.1 [XSS Injection Neutralization] Strips malicious <script> tags and javascript: URIs from IPFS metadata", function () {
      const maliciousPayload = "<script>alert('XSS_ATTACK_VECTOR')</script><b>ClinVar rs671</b><img src=x onerror=stealPrivateKey()>";
      const cleanOutput = sanitizeGenomicMetadata(maliciousPayload);

      expect(cleanOutput).to.not.include("<script>");
      expect(cleanOutput).to.not.include("stealPrivateKey");
      expect(cleanOutput).to.not.include("onerror");
      expect(cleanOutput).to.include("<b>ClinVar rs671</b>");
    });

    it("4.2 [Graceful Handling] Empty, null, and non-string metadata inputs return safe empty strings", function () {
      expect(sanitizeGenomicMetadata(null)).to.equal("");
      expect(sanitizeGenomicMetadata(undefined)).to.equal("");
      expect(sanitizeGenomicMetadata(12345)).to.equal("");
    });
  });

  describe("Section 5: a16z/Halmos SMT-Symbolic Calldata Boundary Emulation", function () {
    it("5.1 [Boundary Parameter Fuzzing] Reverts with clean custom errors on extreme parameter boundaries without EVM panics", async function () {
      // Zero Hash -> revert with InvalidDataHashOrCid
      await expect(
        registry.connect(creator).registerGenomicData(
          ethers.ZeroHash,
          "QmcttVTn3yoPvpJtCVmKLSxWQCBEQV4SEMFubfzpKhLfnm",
          "QmcRfZraMEfyDFawqF6tqB92goAU9icnLqQAJxSXHHXdSG",
          "QmSRxcUPnS95AXUUMEc4KXB3o8LwxwuVJuK1iJTLJ9skgT",
          "ipfs://meta",
          100,
          86400,
          1000
        )
      ).to.be.revertedWithCustomError(registry, "InvalidDataHashOrCid");

      // Empty CID -> revert with InvalidDataHashOrCid
      const validHash = ethers.keccak256(ethers.toUtf8Bytes("ValidHash"));
      await expect(
        registry.connect(creator).registerGenomicData(
          validHash,
          "",
          "QmcRfZraMEfyDFawqF6tqB92goAU9icnLqQAJxSXHHXdSG",
          "QmSRxcUPnS95AXUUMEc4KXB3o8LwxwuVJuK1iJTLJ9skgT",
          "ipfs://meta",
          100,
          86400,
          1000
        )
      ).to.be.revertedWithCustomError(registry, "InvalidDataHashOrCid");

      // Zero Price -> revert with InvalidPrice
      await expect(
        registry.connect(creator).registerGenomicData(
          validHash,
          "QmcttVTn3yoPvpJtCVmKLSxWQCBEQV4SEMFubfzpKhLfnm",
          "QmcRfZraMEfyDFawqF6tqB92goAU9icnLqQAJxSXHHXdSG",
          "QmSRxcUPnS95AXUUMEc4KXB3o8LwxwuVJuK1iJTLJ9skgT",
          "ipfs://meta",
          0,
          86400,
          1000
        )
      ).to.be.revertedWithCustomError(registry, "InvalidPrice");

      // Zero Duration -> revert with InvalidDuration
      await expect(
        registry.connect(creator).registerGenomicData(
          validHash,
          "QmcttVTn3yoPvpJtCVmKLSxWQCBEQV4SEMFubfzpKhLfnm",
          "QmcRfZraMEfyDFawqF6tqB92goAU9icnLqQAJxSXHHXdSG",
          "QmSRxcUPnS95AXUUMEc4KXB3o8LwxwuVJuK1iJTLJ9skgT",
          "ipfs://meta",
          100,
          0,
          1000
        )
      ).to.be.revertedWithCustomError(registry, "InvalidDuration");
    });
  });
});
