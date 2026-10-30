import { expect } from "chai";
import hre from "hardhat";
import crypto from "crypto";


describe("Independent External Repositories & Formal Security Audit", function () {
    let ethers;
    let deployer, aliceCreator, bobSeller, charlieSeller, researcher1, researcher2, researcher3, researcher4, researcher5;
    let genomicToken, genomicNFT, genomicsRegistry;
    let PRICE, DURATION, ROYALTY_BPS;
    let SAMPLE_DATA_HASH, SAMPLE_RAW_CID, SAMPLE_SUMMARY_CID, SAMPLE_METADATA_CID, SAMPLE_TOKEN_URI;

    beforeEach(async function () {
        ({ ethers } = await hre.network.create());
        PRICE = ethers.parseEther("100"); // 100 GENO
        DURATION = 30 * 24 * 60 * 60; // 30 days in seconds
        ROYALTY_BPS = 1000; // 10% (EIP-2981)

        SAMPLE_DATA_HASH = ethers.keccak256(ethers.toUtf8Bytes("ACTGACTG_CHOP21_SYNTHETIC_WGS_RAW"));
        SAMPLE_RAW_CID = "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi";
        SAMPLE_SUMMARY_CID = "bafybeicg2uboluo2yj4suxf2m2z42kaxg5h7g4e45d5z37s3sm63d2q7pm";
        SAMPLE_METADATA_CID = "bafybeihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku";
        SAMPLE_TOKEN_URI = "ipfs://bafybeihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku/metadata.json";

        [
            deployer,
            aliceCreator,
            bobSeller,
            charlieSeller,
            researcher1,
            researcher2,
            researcher3,
            researcher4,
            researcher5
        ] = await ethers.getSigners();

        // 1. Deploy Core GenomicToken ($GENO)
        const GenomicTokenFactory = await ethers.getContractFactory("GenomicToken");
        genomicToken = await GenomicTokenFactory.deploy(deployer.address);
        await genomicToken.waitForDeployment();

        // 2. Deploy GenomicNFT
        const GenomicNFTFactory = await ethers.getContractFactory("GenomicNFT");
        genomicNFT = await GenomicNFTFactory.deploy(deployer.address, ROYALTY_BPS);
        await genomicNFT.waitForDeployment();

        // 3. Deploy GenomicsRegistry
        const GenomicsRegistryFactory = await ethers.getContractFactory("GenomicsRegistry");
        genomicsRegistry = await GenomicsRegistryFactory.deploy(
            await genomicToken.getAddress(),
            await genomicNFT.getAddress(),
            deployer.address
        );
        await genomicsRegistry.waitForDeployment();

        // 4. Authorize GenomicsRegistry on GenomicNFT
        await genomicNFT.setRegistryContract(await genomicsRegistry.getAddress());

        // 5. Fund researchers with GENO tokens
        const researchers = [researcher1, researcher2, researcher3, researcher4, researcher5];
        for (const r of researchers) {
            await genomicToken.transfer(r.address, ethers.parseEther("10000"));
            await genomicToken.connect(r).approve(await genomicsRegistry.getAddress(), ethers.MaxUint256);
        }
    });

    describe("Section 1: Trail of Bits 'building-secure-contracts' Security Benchmarks", function () {
        it("1.1 [Reentrancy] Reentrancy attack attempt via ERC721 onERC721Received hook is blocked", async function () {
            const MaliciousReceiverFactory = await ethers.getContractFactory("MaliciousReentrantReceiver");
            const attacker = await MaliciousReceiverFactory.deploy(await genomicsRegistry.getAddress());
            await attacker.waitForDeployment();

            // Attacker initiates registration which triggers _safeMint -> onERC721Received callback
            await attacker.registerWithRegistry(
                SAMPLE_DATA_HASH,
                SAMPLE_RAW_CID,
                SAMPLE_SUMMARY_CID,
                SAMPLE_METADATA_CID,
                SAMPLE_TOKEN_URI,
                PRICE,
                DURATION,
                ROYALTY_BPS
            );

            const attackSucceeded = await attacker.attackSucceeded();
            const lastError = await attacker.lastErrorMessage();

            expect(attackSucceeded).to.be.false;
            expect(lastError).to.equal("ReentrancyGuardReentrantCall()");

            // Only 1 dataset was registered, not 2
            expect(await genomicsRegistry.dataCount()).to.equal(1n);
        });

        it("1.2 [Reentrancy] Reentrancy attack attempt during grantAccess via paymentToken transferFrom callback is blocked", async function () {
            // Deploy MaliciousReentrantToken
            const MaliciousTokenFactory = await ethers.getContractFactory("MaliciousReentrantToken");
            const malToken = await MaliciousTokenFactory.deploy(deployer.address);
            await malToken.waitForDeployment();

            // Deploy a secondary registry using the malicious payment token
            const GenomicsRegistryFactory = await ethers.getContractFactory("GenomicsRegistry");
            const testRegistry = await GenomicsRegistryFactory.deploy(
                await malToken.getAddress(),
                await genomicNFT.getAddress(),
                deployer.address
            );
            await testRegistry.waitForDeployment();

            // Temporarily set registry on GenomicNFT
            await genomicNFT.setRegistryContract(await testRegistry.getAddress());

            // Alice registers data on testRegistry
            await testRegistry.connect(aliceCreator).registerGenomicData(
                SAMPLE_DATA_HASH,
                SAMPLE_RAW_CID,
                SAMPLE_SUMMARY_CID,
                SAMPLE_METADATA_CID,
                SAMPLE_TOKEN_URI,
                PRICE,
                DURATION,
                ROYALTY_BPS
            );

            // Fund researcher1 with malicious token
            await malToken.transfer(researcher1.address, ethers.parseEther("5000"));
            await malToken.connect(researcher1).approve(await testRegistry.getAddress(), ethers.MaxUint256);

            // Configure attack target
            await malToken.setRegistryAndTarget(await testRegistry.getAddress(), 1n);

            // Researcher1 buys access - during transferFrom, it tries to call grantAccess again
            await testRegistry.connect(researcher1).grantAccess(1n);

            const attackSucceeded = await malToken.attackSucceeded();
            const lastError = await malToken.lastErrorMessage();

            expect(attackSucceeded).to.be.false;
            expect(lastError).to.equal("ReentrancyGuardReentrantCall()");

            // Restore primary registry
            await genomicNFT.setRegistryContract(await genomicsRegistry.getAddress());
        });

        it("1.3 [Non-Standard Tokens] Non-standard ERC20 (USDT void return) compatibility via SafeERC20", async function () {
            const NonStandardERC20Factory = await ethers.getContractFactory("NonStandardERC20");
            const nonStdToken = await NonStandardERC20Factory.deploy(ethers.parseEther("1000000"));
            await nonStdToken.waitForDeployment();

            // Deploy a dedicated registry with the non-standard token
            const GenomicsRegistryFactory = await ethers.getContractFactory("GenomicsRegistry");
            const nstRegistry = await GenomicsRegistryFactory.deploy(
                await nonStdToken.getAddress(),
                await genomicNFT.getAddress(),
                deployer.address
            );
            await nstRegistry.waitForDeployment();

            await genomicNFT.setRegistryContract(await nstRegistry.getAddress());

            // Alice registers dataset
            await nstRegistry.connect(aliceCreator).registerGenomicData(
                SAMPLE_DATA_HASH,
                SAMPLE_RAW_CID,
                SAMPLE_SUMMARY_CID,
                SAMPLE_METADATA_CID,
                SAMPLE_TOKEN_URI,
                PRICE,
                DURATION,
                ROYALTY_BPS
            );

            // Fund researcher1 with non-standard token
            await nonStdToken.transfer(researcher1.address, ethers.parseEther("500"));
            await nonStdToken.connect(researcher1).approve(await nstRegistry.getAddress(), ethers.MaxUint256);

            // Researcher1 grants access using non-standard token
            await expect(nstRegistry.connect(researcher1).grantAccess(1n))
                .to.emit(nstRegistry, "AccessGranted");

            // Check that SafeERC20 correctly handled transfers
            const aliceBalance = await nonStdToken.balanceOf(aliceCreator.address);
            expect(aliceBalance).to.equal(PRICE); // 100% since Alice is both creator and current owner

            // Restore primary registry
            await genomicNFT.setRegistryContract(await genomicsRegistry.getAddress());
        });

        it("1.4 [Zero-Address Checks] Reverts when setting address(0) on dispatcher or constructor", async function () {
            await expect(
                genomicsRegistry.setCapsuleDispatcher(ethers.ZeroAddress)
            ).to.be.revertedWithCustomError(genomicsRegistry, "InvalidRecipient");

            const GenomicsRegistryFactory = await ethers.getContractFactory("GenomicsRegistry");
            await expect(
                GenomicsRegistryFactory.deploy(ethers.ZeroAddress, await genomicNFT.getAddress(), deployer.address)
            ).to.be.revertedWithCustomError(genomicsRegistry, "InvalidRecipient");
            await expect(
                GenomicsRegistryFactory.deploy(await genomicToken.getAddress(), ethers.ZeroAddress, deployer.address)
            ).to.be.revertedWithCustomError(genomicsRegistry, "InvalidRecipient");
            await expect(
                GenomicsRegistryFactory.deploy(await genomicToken.getAddress(), await genomicNFT.getAddress(), ethers.ZeroAddress)
            ).to.be.revertedWithCustomError(genomicsRegistry, "OwnableInvalidOwner");
        });
    });

    describe("Section 2: Ocean Protocol ('ocean-contracts') Marketplace Benchmarks", function () {
        it("2.1 [EIP-2981 Royalty Multi-Hop] Correctly disburses royalty to original creator across multiple secondary NFT transfers", async function () {
            // Alice registers dataset (Original Creator, 10% royalty)
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

            // Alice transfers NFT to Bob (First secondary sale)
            await genomicNFT.connect(aliceCreator).transferFrom(aliceCreator.address, bobSeller.address, 1n);
            expect(await genomicNFT.ownerOf(1n)).to.equal(bobSeller.address);

            // Bob transfers NFT to Charlie (Second secondary sale)
            await genomicNFT.connect(bobSeller).transferFrom(bobSeller.address, charlieSeller.address, 1n);
            expect(await genomicNFT.ownerOf(1n)).to.equal(charlieSeller.address);

            const aliceBalBefore = await genomicToken.balanceOf(aliceCreator.address);
            const bobBalBefore = await genomicToken.balanceOf(bobSeller.address);
            const charlieBalBefore = await genomicToken.balanceOf(charlieSeller.address);

            // Researcher1 purchases access
            await expect(genomicsRegistry.connect(researcher1).grantAccess(1n))
                .to.emit(genomicsRegistry, "RoyaltyPaid")
                .withArgs(1n, aliceCreator.address, ethers.parseEther("10")); // 10% of 100 = 10 GENO

            const aliceBalAfter = await genomicToken.balanceOf(aliceCreator.address);
            const bobBalAfter = await genomicToken.balanceOf(bobSeller.address);
            const charlieBalAfter = await genomicToken.balanceOf(charlieSeller.address);

            // Ocean Protocol / EIP-2981 Benchmark Assertions:
            // 1. Alice (Original Creator) received exactly 10 GENO (10%)
            expect(aliceBalAfter - aliceBalBefore).to.equal(ethers.parseEther("10"));
            // 2. Charlie (Current NFT Owner) received exactly 90 GENO (90% seller proceeds)
            expect(charlieBalAfter - charlieBalBefore).to.equal(ethers.parseEther("90"));
            // 3. Bob (Intermediary previous owner) received 0 GENO
            expect(bobBalAfter - bobBalBefore).to.equal(0n);
        });

        it("2.2 [Concurrent Multi-Buyer] 5 researchers purchase access without race condition or state collision", async function () {
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

            const buyers = [researcher1, researcher2, researcher3, researcher4, researcher5];
            for (const b of buyers) {
                await genomicsRegistry.connect(b).grantAccess(1n);
            }

            // Verify all 5 have active access
            for (const b of buyers) {
                expect(await genomicsRegistry.hasActiveAccess(1n, b.address)).to.be.true;
            }

            // Verify data accessCount is exactly 5
            const dataItem = await genomicsRegistry.getGenomicData(1n);
            expect(dataItem.accessCount).to.equal(5n);

            // Verify Alice received 5 * 100 = 500 GENO
            const aliceBal = await genomicToken.balanceOf(aliceCreator.address);
            expect(aliceBal).to.equal(ethers.parseEther("500"));
        });

        it("2.3 [Access Lifecycle] Access expires after exact duration and can be re-purchased", async function () {
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

            await genomicsRegistry.connect(researcher1).grantAccess(1n);
            expect(await genomicsRegistry.hasActiveAccess(1n, researcher1.address)).to.be.true;

            // Attempting to buy again while active should revert
            await expect(
                genomicsRegistry.connect(researcher1).grantAccess(1n)
            ).to.be.revertedWithCustomError(genomicsRegistry, "AccessAlreadyActive");

            // Fast-forward time past 30 days
            await ethers.provider.send("evm_increaseTime", [DURATION + 1]);
            await ethers.provider.send("evm_mine");

            // Access must now be inactive
            expect(await genomicsRegistry.hasActiveAccess(1n, researcher1.address)).to.be.false;

            // Researcher1 re-purchases access (Renewal)
            await expect(genomicsRegistry.connect(researcher1).grantAccess(1n))
                .to.emit(genomicsRegistry, "AccessGranted");

            expect(await genomicsRegistry.hasActiveAccess(1n, researcher1.address)).to.be.true;
        });
    });

    describe("Section 3: Governome & Medical Records Revocation Benchmarks", function () {
        it("3.1 [Emergency Kill-Switch] Revoked status immediately cuts off active researcher access", async function () {
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

            await genomicsRegistry.connect(researcher1).grantAccess(1n);
            expect(await genomicsRegistry.hasActiveAccess(1n, researcher1.address)).to.be.true;

            // Alice discovers patient consent withdrawal -> updates status to Revoked (2)
            await genomicsRegistry.connect(aliceCreator).updateDataStatus(1n, 2);

            // Researcher1's access is immediately revoked on-chain despite non-expired time-lock
            expect(await genomicsRegistry.hasActiveAccess(1n, researcher1.address)).to.be.false;

            // New buyers cannot purchase
            await expect(
                genomicsRegistry.connect(researcher2).grantAccess(1n)
            ).to.be.revertedWithCustomError(genomicsRegistry, "DataNotActive");
        });

        it("3.2 [Temporary Suspension] Paused status suspends access and restores on unpause", async function () {
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

            await genomicsRegistry.connect(researcher1).grantAccess(1n);
            expect(await genomicsRegistry.hasActiveAccess(1n, researcher1.address)).to.be.true;

            // Pause dataset (Status 1)
            await genomicsRegistry.connect(aliceCreator).updateDataStatus(1n, 1);
            expect(await genomicsRegistry.hasActiveAccess(1n, researcher1.address)).to.be.false;

            // Resume dataset (Status 0 = Active)
            await genomicsRegistry.connect(aliceCreator).updateDataStatus(1n, 0);
            expect(await genomicsRegistry.hasActiveAccess(1n, researcher1.address)).to.be.true;
        });

        it("3.3 [Institutional Direct Grant] Data owner can grant direct access to research institutions without fee", async function () {
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

            // Alice grants direct free access to researcher2 (hospital/university)
            await expect(genomicsRegistry.connect(aliceCreator).grantDirectAccess(1n, researcher2.address))
                .to.emit(genomicsRegistry, "DirectAccessGranted");

            expect(await genomicsRegistry.hasActiveAccess(1n, researcher2.address)).to.be.true;

            // Researcher2 was not charged any tokens
            const researcher2Bal = await genomicToken.balanceOf(researcher2.address);
            expect(researcher2Bal).to.equal(ethers.parseEther("10000"));
        });
    });

    describe("Section 4: GA4GH Crypt4GH & Big Data Streaming Cryptography Audit", function () {
        it("4.1 [Chunked Streaming Crypto] Encrypts and decrypts multi-chunk genomic stream without data loss", async function () {
            // Generate 256 KB of synthetic genomic sequence (4 chunks of 64 KB)
            const CHUNK_SIZE = 64 * 1024;
            const TOTAL_SIZE = 256 * 1024;
            const bases = ["A", "C", "G", "T"];
            let rawSequence = "";
            for (let i = 0; i < TOTAL_SIZE; i++) {
                rawSequence += bases[i % 4];
            }
            const rawBytes = Buffer.from(rawSequence, "utf-8");

            // Key setup: 256-bit AES session key
            const sessionKey = crypto.randomBytes(32);

            // Encrypt in 64KB Crypt4GH style chunks
            const chunks = [];
            const numChunks = Math.ceil(rawBytes.length / CHUNK_SIZE);
            for (let i = 0; i < numChunks; i++) {
                const chunkData = rawBytes.subarray(i * CHUNK_SIZE, Math.min((i + 1) * CHUNK_SIZE, rawBytes.length));
                const iv = crypto.randomBytes(12);
                const cipher = crypto.createCipheriv("aes-256-gcm", sessionKey, iv);
                const ciphertext = Buffer.concat([cipher.update(chunkData), cipher.final()]);
                const tag = cipher.getAuthTag();
                chunks.push({ iv, tag, ciphertext });
            }

            expect(chunks.length).to.equal(4);

            // Decrypt all chunks and reassemble
            const decryptedChunks = [];
            for (let i = 0; i < chunks.length; i++) {
                const { iv, tag, ciphertext } = chunks[i];
                const decipher = crypto.createDecipheriv("aes-256-gcm", sessionKey, iv);
                decipher.setAuthTag(tag);
                const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
                decryptedChunks.push(plain);
            }

            const reconstructedBytes = Buffer.concat(decryptedChunks);
            expect(reconstructedBytes.toString("utf-8")).to.equal(rawSequence);
        });

        it("4.2 [Fault Injection Detection] Single-bit tampering on any chunk is detected and rejects decryption", async function () {
            const CHUNK_SIZE = 64 * 1024;
            const rawBytes = Buffer.from("GATTACAGATTACAGATTACA_GENOMIC_SURVEILLANCE_PAYLOAD_CHUNK_TEST", "utf-8");
            const sessionKey = crypto.randomBytes(32);
            const iv = crypto.randomBytes(12);

            const cipher = crypto.createCipheriv("aes-256-gcm", sessionKey, iv);
            const ciphertext = Buffer.concat([cipher.update(rawBytes), cipher.final()]);
            const tag = cipher.getAuthTag();

            // Tamper 1 bit in ciphertext
            const tamperedCiphertext = Buffer.from(ciphertext);
            tamperedCiphertext[0] ^= 0x01;

            const decipher = crypto.createDecipheriv("aes-256-gcm", sessionKey, iv);
            decipher.setAuthTag(tag);

            expect(() => {
                decipher.update(tamperedCiphertext);
                decipher.final();
            }).to.throw();
        });
    });
});
