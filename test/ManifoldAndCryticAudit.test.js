import { expect } from "chai";
import hre from "hardhat";
import crypto from "crypto";
import {
    encryptGenomicDataChunked,
    decryptGenomicDataChunked
} from "../crypto/client_crypto.js";

describe("Authoritative Repositories: Manifold EIP-2981 & Crytic Formal Invariants", function () {
    let ethers;
    let deployer, creatorAlice, sellerBob, buyerResearcher, buyerResearcher2, attacker;
    let genomicToken, genomicNFT, genomicsRegistry;
    let PRICE, DURATION, ROYALTY_BPS;
    let SAMPLE_DATA_HASH, SAMPLE_RAW_CID, SAMPLE_SUMMARY_CID, SAMPLE_METADATA_CID, SAMPLE_TOKEN_URI;

    beforeEach(async function () {
        ({ ethers } = await hre.network.create());
        PRICE = ethers.parseEther("100");
        DURATION = 30 * 24 * 60 * 60;
        ROYALTY_BPS = 1000; // 10%

        SAMPLE_DATA_HASH = ethers.keccak256(ethers.toUtf8Bytes("MANIFOLD_CRYPTIC_GENOME_TRUTH"));
        SAMPLE_RAW_CID = "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi";
        SAMPLE_SUMMARY_CID = "bafybeicg2uboluo2yj4suxf2m2z42kaxg5h7g4e45d5z37s3sm63d2q7pm";
        SAMPLE_METADATA_CID = "bafybeihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku";
        SAMPLE_TOKEN_URI = "ipfs://bafybeihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku/metadata.json";

        [deployer, creatorAlice, sellerBob, buyerResearcher, buyerResearcher2, attacker] = await ethers.getSigners();

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
            await genomicToken.getAddress(),
            await genomicNFT.getAddress(),
            deployer.address
        );
        await genomicsRegistry.waitForDeployment();

        // Authorize registry
        await genomicNFT.setRegistryContract(await genomicsRegistry.getAddress());

        // Fund researchers
        await genomicToken.transfer(buyerResearcher.address, ethers.parseEther("10000"));
        await genomicToken.connect(buyerResearcher).approve(await genomicsRegistry.getAddress(), ethers.MaxUint256);

        await genomicToken.transfer(buyerResearcher2.address, ethers.parseEther("10000"));
        await genomicToken.connect(buyerResearcher2).approve(await genomicsRegistry.getAddress(), ethers.MaxUint256);
    });

    describe("1. Manifold EIP-2981 Royalty Registry Reference Tests (manifoldxyz/royalty-registry-solidity)", function () {
        it("1.1 [EIP-165 Interface Check] Correctly advertises EIP-2981, ERC-721, and ERC-165 interfaces", async function () {
            const EIP2981_INTERFACE_ID = "0x2a55205a";
            const ERC721_INTERFACE_ID = "0x80ac58cd";
            const ERC721_METADATA_INTERFACE_ID = "0x5b5e139f";
            const ERC165_INTERFACE_ID = "0x01ffc9a7";
            const INVALID_INTERFACE_ID = "0xffffffff";

            expect(await genomicNFT.supportsInterface(EIP2981_INTERFACE_ID)).to.be.true;
            expect(await genomicNFT.supportsInterface(ERC721_INTERFACE_ID)).to.be.true;
            expect(await genomicNFT.supportsInterface(ERC721_METADATA_INTERFACE_ID)).to.be.true;
            expect(await genomicNFT.supportsInterface(ERC165_INTERFACE_ID)).to.be.true;
            expect(await genomicNFT.supportsInterface(INVALID_INTERFACE_ID)).to.be.false;
        });

        it("1.2 [Manifold Boundary Math] Royalty calculation never overflows and handles edge-case sale prices", async function () {
            await genomicsRegistry.connect(creatorAlice).registerGenomicData(
                SAMPLE_DATA_HASH,
                SAMPLE_RAW_CID,
                SAMPLE_SUMMARY_CID,
                SAMPLE_METADATA_CID,
                SAMPLE_TOKEN_URI,
                PRICE,
                DURATION,
                ROYALTY_BPS // 10%
            );

            // Test 1: Sale price = 0
            const [rec0, amt0] = await genomicNFT.royaltyInfo(1n, 0n);
            expect(rec0).to.equal(creatorAlice.address);
            expect(amt0).to.equal(0n);

            // Test 2: Sale price = 1 wei
            const [rec1, amt1] = await genomicNFT.royaltyInfo(1n, 1n);
            expect(rec1).to.equal(creatorAlice.address);
            expect(amt1).to.equal(0n); // 1 * 1000 / 10000 = 0 (no fractional wei)

            // Test 3: Sale price = 9 wei
            const [rec9, amt9] = await genomicNFT.royaltyInfo(1n, 9n);
            expect(amt9).to.equal(0n);

            // Test 4: Sale price = 10 wei
            const [rec10, amt10] = await genomicNFT.royaltyInfo(1n, 10n);
            expect(amt10).to.equal(1n); // 10 * 1000 / 10000 = 1 wei

            // Test 5: Sale price = 10,000,000 ETH (Massive volume)
            const hugePrice = ethers.parseEther("10000000");
            const [recHuge, amtHuge] = await genomicNFT.royaltyInfo(1n, hugePrice);
            expect(amtHuge).to.equal(ethers.parseEther("1000000")); // Exactly 10%
        });

        it("1.3 [Zero Sum Conservation] sellerProceeds + royaltyAmount strictly equals totalPrice", async function () {
            await genomicsRegistry.connect(creatorAlice).registerGenomicData(
                SAMPLE_DATA_HASH,
                SAMPLE_RAW_CID,
                SAMPLE_SUMMARY_CID,
                SAMPLE_METADATA_CID,
                SAMPLE_TOKEN_URI,
                PRICE,
                DURATION,
                ROYALTY_BPS
            );

            // Transfer to Bob
            await genomicNFT.connect(creatorAlice).transferFrom(creatorAlice.address, sellerBob.address, 1n);

            const aliceBalBefore = await genomicToken.balanceOf(creatorAlice.address);
            const bobBalBefore = await genomicToken.balanceOf(sellerBob.address);
            const buyerBalBefore = await genomicToken.balanceOf(buyerResearcher.address);

            await genomicsRegistry.connect(buyerResearcher).grantAccess(1n);

            const aliceBalAfter = await genomicToken.balanceOf(creatorAlice.address);
            const bobBalAfter = await genomicToken.balanceOf(sellerBob.address);
            const buyerBalAfter = await genomicToken.balanceOf(buyerResearcher.address);

            const royaltyPaid = aliceBalAfter - aliceBalBefore;
            const sellerProceeds = bobBalAfter - bobBalBefore;
            const buyerSpent = buyerBalBefore - buyerBalAfter;

            expect(buyerSpent).to.equal(PRICE);
            expect(royaltyPaid + sellerProceeds).to.equal(buyerSpent);
        });
    });

    describe("2. Crytic Formal Invariant Properties (crytic/properties)", function () {
        it("2.1 [Crytic ERC20 Invariant] Conservation of supply: Total supply strictly equals sum of all user balances", async function () {
            const initialSupply = await genomicToken.totalSupply();
            const signers = [deployer, creatorAlice, sellerBob, buyerResearcher, buyerResearcher2, attacker];

            let sumBalances = 0n;
            for (const s of signers) {
                sumBalances += await genomicToken.balanceOf(s.address);
            }

            expect(sumBalances).to.equal(initialSupply);

            // Execute transfers between users
            await genomicToken.connect(buyerResearcher).transfer(creatorAlice.address, ethers.parseEther("100"));
            await genomicToken.connect(buyerResearcher).transfer(sellerBob.address, ethers.parseEther("200"));

            sumBalances = 0n;
            for (const s of signers) {
                sumBalances += await genomicToken.balanceOf(s.address);
            }
            expect(sumBalances).to.equal(await genomicToken.totalSupply());
        });

        it("2.2 [Crytic Burn Invariant] Burning strictly decreases totalSupply and caller balance by exact burned amount", async function () {
            const burnAmount = ethers.parseEther("75");
            const supplyBefore = await genomicToken.totalSupply();
            const balanceBefore = await genomicToken.balanceOf(buyerResearcher.address);

            await genomicToken.connect(buyerResearcher).burn(burnAmount);

            const supplyAfter = await genomicToken.totalSupply();
            const balanceAfter = await genomicToken.balanceOf(buyerResearcher.address);

            expect(supplyBefore - supplyAfter).to.equal(burnAmount);
            expect(balanceBefore - balanceAfter).to.equal(burnAmount);
        });

        it("2.3 [Crytic Zero Address Protection] Transfers to address(0) strictly revert", async function () {
            await expect(
                genomicToken.connect(buyerResearcher).transfer(ethers.ZeroAddress, ethers.parseEther("10"))
            ).to.be.revertedWithCustomError(genomicToken, "ERC20InvalidReceiver");

            await expect(
                genomicToken.connect(buyerResearcher).approve(ethers.ZeroAddress, ethers.parseEther("10"))
            ).to.be.revertedWithCustomError(genomicToken, "ERC20InvalidSpender");
        });

        it("2.4 [Crytic ERC721 Invariant] Token uniqueness and clear approval upon transfer", async function () {
            await genomicsRegistry.connect(creatorAlice).registerGenomicData(
                SAMPLE_DATA_HASH,
                SAMPLE_RAW_CID,
                SAMPLE_SUMMARY_CID,
                SAMPLE_METADATA_CID,
                SAMPLE_TOKEN_URI,
                PRICE,
                DURATION,
                ROYALTY_BPS
            );

            // Alice approves Bob for token 1
            await genomicNFT.connect(creatorAlice).approve(sellerBob.address, 1n);
            expect(await genomicNFT.getApproved(1n)).to.equal(sellerBob.address);

            // Alice transfers to attacker
            await genomicNFT.connect(creatorAlice).transferFrom(creatorAlice.address, attacker.address, 1n);

            // Transfer MUST clear approval for Bob (Crytic invariant)
            expect(await genomicNFT.getApproved(1n)).to.equal(ethers.ZeroAddress);

            // Non-existent token queries must revert
            await expect(genomicNFT.ownerOf(9999n)).to.be.revertedWithCustomError(
                genomicNFT,
                "ERC721NonexistentToken"
            );
        });

        it("2.5 [Crytic Access Control] Direct NFT minting is strictly restricted to verified Registry", async function () {
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
    });

    describe("3. GA4GH Crypt4GH Streaming Compliance & Byzantine Fault Injection (neicnordic/crypt4gh)", function () {
        it("3.1 [Crypt4GH Boundary Chunks] Accurately encrypts and decrypts across byte boundaries", async function () {
            // Test 1: Empty payload (0 bytes)
            const emptyPlain = new Uint8Array(0);
            const encEmpty = await encryptGenomicDataChunked(emptyPlain);
            expect(encEmpty.chunkCount).to.equal(1);
            const decEmpty = await decryptGenomicDataChunked(encEmpty.payload, encEmpty.keyHex, { asString: false });
            expect(decEmpty.length).to.equal(0);

            // Test 2: Single byte payload (1 byte)
            const singleByte = new Uint8Array([0x42]);
            const encSingle = await encryptGenomicDataChunked(singleByte);
            expect(encSingle.chunkCount).to.equal(1);
            const decSingle = await decryptGenomicDataChunked(encSingle.payload, encSingle.keyHex, { asString: false });
            expect(decSingle[0]).to.equal(0x42);

            // Test 3: Exactly 1 Crypt4GH standard chunk (65,536 bytes = 64 KB)
            const chunk64K = crypto.randomBytes(65536);
            const enc64K = await encryptGenomicDataChunked(chunk64K);
            expect(enc64K.chunkCount).to.equal(1);
            const dec64K = await decryptGenomicDataChunked(enc64K.payload, enc64K.keyHex, { asString: false });
            expect(Buffer.from(dec64K).equals(chunk64K)).to.be.true;

            // Test 4: Exactly 64KB + 1 byte (Boundary spanning 2 chunks)
            const chunk64KPlus1 = crypto.randomBytes(65537);
            const encSpan = await encryptGenomicDataChunked(chunk64KPlus1);
            expect(encSpan.chunkCount).to.equal(2);
            const decSpan = await decryptGenomicDataChunked(encSpan.payload, encSpan.keyHex, { asString: false });
            expect(Buffer.from(decSpan).equals(chunk64KPlus1)).to.be.true;
        });

        it("3.2 [Byzantine Fault Localization] Traps bit corruption on any arbitrary chunk index", async function () {
            // 3 chunks (192 KB)
            const multiChunkData = crypto.randomBytes(3 * 65536);
            const encrypted = await encryptGenomicDataChunked(multiChunkData);

            // Corruption on chunk 0 ciphertext (inside payload)
            const tampered0 = new Uint8Array(encrypted.payload);
            tampered0[36] ^= 0xff; // Flip bits in chunk 0 ciphertext
            await expect(
                decryptGenomicDataChunked(tampered0, encrypted.keyHex, { asString: false })
            ).to.be.rejected;

            // Corruption on middle chunk 1
            const tampered1 = new Uint8Array(encrypted.payload);
            tampered1[65568 + 40] ^= 0xff; // Flip bits in chunk 1
            await expect(
                decryptGenomicDataChunked(tampered1, encrypted.keyHex, { asString: false })
            ).to.be.rejected;

            // Corruption on last chunk 2
            const tampered2 = new Uint8Array(encrypted.payload);
            tampered2[tampered2.length - 10] ^= 0xff; // Flip bits in last chunk
            await expect(
                decryptGenomicDataChunked(tampered2, encrypted.keyHex, { asString: false })
            ).to.be.rejected;
        });
    });
});
