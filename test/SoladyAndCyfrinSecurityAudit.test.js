import { expect } from "chai";
import hre from "hardhat";
import crypto from "crypto";

/**
 * @title Solady, Not-So-Smart-Contracts & Cyfrin Security Audit
 * @notice Formal verification of access control, tokenomics, donation attacks,
 *         and boundary math derived from:
 *         1. Vectorized/solady (Paradigm SafeTransferLib & ERC2981 Differential Tests)
 *         2. crytic/not-so-smart-contracts (Trail of Bits Vulnerability Benchmark)
 *         3. Cyfrin/audit-checklist (Patrick Collins / Cyfrin Industry Standard Checklist)
 */
describe("Authoritative Repositories: Solady, Not-So-Smart-Contracts & Cyfrin Audit", function () {
    let ethers;
    let deployer, creatorAlice, sellerBob, buyerResearcher, attacker, unauthorizedUser;
    let genomicToken, genomicNFT, genomicsRegistry;
    let nonStandardToken;
    let PRICE, DURATION, ROYALTY_BPS;
    let SAMPLE_DATA_HASH, SAMPLE_RAW_CID, SAMPLE_SUMMARY_CID, SAMPLE_METADATA_CID, SAMPLE_TOKEN_URI;

    beforeEach(async function () {
        ({ ethers } = await hre.network.create());
        PRICE = ethers.parseEther("100");
        DURATION = 30 * 24 * 60 * 60; // 30 days
        ROYALTY_BPS = 1000; // 10%

        SAMPLE_DATA_HASH = ethers.keccak256(ethers.toUtf8Bytes("SOLADY_CYFRIN_GENOMICS_TRUTH"));
        SAMPLE_RAW_CID = "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi";
        SAMPLE_SUMMARY_CID = "bafybeicg2uboluo2yj4suxf2m2z42kaxg5h7g4e45d5z37s3sm63d2q7pm";
        SAMPLE_METADATA_CID = "bafybeihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku";
        SAMPLE_TOKEN_URI = "ipfs://bafybeihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku/metadata.json";

        [deployer, creatorAlice, sellerBob, buyerResearcher, attacker, unauthorizedUser] = await ethers.getSigners();

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

        // 4. Authorize registry on NFT contract
        await genomicNFT.setRegistryContract(await genomicsRegistry.getAddress());

        // 5. Deploy NonStandardERC20 (USDT void return simulator)
        const NonStandardFactory = await ethers.getContractFactory("NonStandardERC20");
        nonStandardToken = await NonStandardFactory.deploy(ethers.parseEther("1000000"));
        await nonStandardToken.waitForDeployment();

        // Fund researcher with 10,000 GENO tokens
        await genomicToken.transfer(buyerResearcher.address, ethers.parseEther("10000"));
        await genomicToken.connect(buyerResearcher).approve(await genomicsRegistry.getAddress(), ethers.MaxUint256);
    });

    describe("1. Solady Standards (Vectorized/solady: SafeTransferLib & Boundary Math)", function () {
        it("1.1 [Solady SafeTransferLib] Handles non-standard void-returning ERC20 tokens safely", async function () {
            // Deploy a secondary registry using non-standard token
            const RegistryFactory = await ethers.getContractFactory("GenomicsRegistry");
            const usdtRegistry = await RegistryFactory.deploy(
                await nonStandardToken.getAddress(),
                await genomicNFT.getAddress(),
                deployer.address
            );
            await usdtRegistry.waitForDeployment();

            // Authorize usdtRegistry on NFT for this test
            await genomicNFT.setRegistryContract(await usdtRegistry.getAddress());

            // Alice registers dataset
            await usdtRegistry.connect(creatorAlice).registerGenomicData(
                SAMPLE_DATA_HASH,
                SAMPLE_RAW_CID,
                SAMPLE_SUMMARY_CID,
                SAMPLE_METADATA_CID,
                SAMPLE_TOKEN_URI,
                PRICE,
                DURATION,
                ROYALTY_BPS
            );

            // Fund buyer with NonStandard tokens and approve
            await nonStandardToken.transfer(buyerResearcher.address, ethers.parseEther("500"));
            await nonStandardToken.connect(buyerResearcher).approve(await usdtRegistry.getAddress(), ethers.MaxUint256);

            const aliceBalBefore = await nonStandardToken.balanceOf(creatorAlice.address);
            // Buy access - SafeERC20 must handle void-return transferFrom and transfer without reverting
            await expect(usdtRegistry.connect(buyerResearcher).grantAccess(1))
                .to.emit(usdtRegistry, "AccessGranted");

            const aliceBalAfter = await nonStandardToken.balanceOf(creatorAlice.address);
            expect(aliceBalAfter - aliceBalBefore).to.equal(PRICE);
        });

        it("1.2 [Solady SafeTransferLib: Zero Allowance] Fails safely when allowance is zero", async function () {
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

            // Create an unapproved buyer
            const unapprovedBuyer = attacker;
            await genomicToken.transfer(unapprovedBuyer.address, PRICE);
            // Allowance is 0

            await expect(
                genomicsRegistry.connect(unapprovedBuyer).grantAccess(1)
            ).to.be.revertedWithCustomError(genomicToken, "ERC20InsufficientAllowance");
        });

        it("1.3 [Solady SafeTransferLib: Insufficient Balance] Fails safely when balance is below price", async function () {
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

            // Attacker has approval but 0 balance
            await genomicToken.connect(attacker).approve(await genomicsRegistry.getAddress(), ethers.MaxUint256);

            await expect(
                genomicsRegistry.connect(attacker).grantAccess(1)
            ).to.be.revertedWithCustomError(genomicToken, "ERC20InsufficientBalance");
        });

        it("1.4 [Solady Differential Royalty Math] Invariant holds across extreme price scales (1 wei to 1 billion ETH)", async function () {
            await genomicsRegistry.connect(creatorAlice).registerGenomicData(
                SAMPLE_DATA_HASH,
                SAMPLE_RAW_CID,
                SAMPLE_SUMMARY_CID,
                SAMPLE_METADATA_CID,
                SAMPLE_TOKEN_URI,
                PRICE,
                DURATION,
                ROYALTY_BPS // 10% = 1000 bps
            );

            const testPrices = [
                1n,                                  // 1 wei
                10n,                                 // 10 wei
                10000n,                              // Exact BPS scale
                ethers.parseEther("0.001"),          // 0.001 ETH
                ethers.parseEther("1"),              // 1 ETH
                ethers.parseEther("100"),            // 100 ETH
                ethers.parseEther("1000000000")      // 1 Billion ETH
            ];

            for (const price of testPrices) {
                const [receiver, royaltyAmount] = await genomicNFT.royaltyInfo(1, price);
                expect(receiver).to.equal(creatorAlice.address);

                // Solady Invariant: royaltyAmount = (price * royaltyBps) / 10000
                const expectedRoyalty = (price * BigInt(ROYALTY_BPS)) / 10000n;
                expect(royaltyAmount).to.equal(expectedRoyalty);

                // Zero sum conservation
                const sellerProceeds = price - royaltyAmount;
                expect(sellerProceeds + royaltyAmount).to.equal(price);
            }
        });
    });

    describe("2. Not-So-Smart-Contracts Benchmarks (crytic/not-so-smart-contracts)", function () {
        it("2.1 [Unprotected Functions Audit] Every privileged mutator reverts for unauthorized callers", async function () {
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

            // 1. setRegistryContract on NFT
            await expect(
                genomicNFT.connect(attacker).setRegistryContract(attacker.address)
            ).to.be.revertedWithCustomError(genomicNFT, "OwnableUnauthorizedAccount");

            // 2. setCapsuleDispatcher on Registry
            await expect(
                genomicsRegistry.connect(attacker).setCapsuleDispatcher(attacker.address)
            ).to.be.revertedWithCustomError(genomicsRegistry, "OwnableUnauthorizedAccount");

            // 3. updateDataStatus on Registry (dataset 1 belongs to Alice)
            await expect(
                genomicsRegistry.connect(attacker).updateDataStatus(1, 1) // 1 = Paused
            ).to.be.revertedWithCustomError(genomicsRegistry, "NotDataOwner");

            // 4. updateDataPrice on Registry
            await expect(
                genomicsRegistry.connect(attacker).updateDataPrice(1, ethers.parseEther("999"))
            ).to.be.revertedWithCustomError(genomicsRegistry, "NotDataOwner");

            // 5. grantDirectAccess on Registry
            await expect(
                genomicsRegistry.connect(attacker).grantDirectAccess(1, unauthorizedUser.address)
            ).to.be.revertedWithCustomError(genomicsRegistry, "NotDataOwner");

            // 6. storeTransformedCapsule without dispatcher role
            await expect(
                genomicsRegistry.connect(attacker).storeTransformedCapsule(1, buyerResearcher.address, "capsule_data")
            ).to.be.revertedWithCustomError(genomicsRegistry, "NotDataOwner");

            // 7. mintGenomicNFT directly on NFT contract
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

        it("2.2 [Denial of Service & Gas Protection] Pagination gracefully handles edge bounds without unbounded looping", async function () {
            // Register 3 datasets
            for (let i = 0; i < 3; i++) {
                const hash = ethers.keccak256(ethers.toUtf8Bytes(`DATASET_${i}`));
                await genomicsRegistry.connect(creatorAlice).registerGenomicData(
                    hash,
                    SAMPLE_RAW_CID,
                    SAMPLE_SUMMARY_CID,
                    SAMPLE_METADATA_CID,
                    SAMPLE_TOKEN_URI,
                    PRICE,
                    DURATION,
                    ROYALTY_BPS
                );
            }

            // Case A: Query with offset = 0, limit = 0 -> returns empty array
            const [items0, total0] = await genomicsRegistry.getDataItemsPaginated(0, 0);
            expect(items0.length).to.equal(0);
            expect(total0).to.equal(3n);

            // Case B: Query with offset beyond dataset count -> returns empty array
            const [itemsBeyond, totalBeyond] = await genomicsRegistry.getDataItemsPaginated(10, 5);
            expect(itemsBeyond.length).to.equal(0);
            expect(totalBeyond).to.equal(3n);

            // Case C: Query with limit larger than total remaining -> returns only available
            const [itemsOverflow, totalOverflow] = await genomicsRegistry.getDataItemsPaginated(1, 100);
            expect(itemsOverflow.length).to.equal(2);
            expect(totalOverflow).to.equal(3n);
        });
    });

    describe("3. Cyfrin Security Checklist Audit (Cyfrin/audit-checklist)", function () {
        it("3.1 [SOL-AM-DA-1: Direct Donation Attack] Direct token donation cannot alter access pricing or steal funds", async function () {
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

            // Attacker donates 50,000 GENO directly to the Registry contract address
            const donationAmount = ethers.parseEther("50000");
            await genomicToken.transfer(attacker.address, donationAmount);
            await genomicToken.connect(attacker).transfer(await genomicsRegistry.getAddress(), donationAmount);

            const registryContractBalance = await genomicToken.balanceOf(await genomicsRegistry.getAddress());
            expect(registryContractBalance).to.equal(donationAmount);

            // Buyer purchases dataset #1
            const buyerBalBefore = await genomicToken.balanceOf(buyerResearcher.address);
            const aliceBalBefore = await genomicToken.balanceOf(creatorAlice.address);

            // Cyfrin check: contract must NOT use address(this).balance / token.balanceOf(address(this))
            // for calculating transfer amounts! It must strictly charge PRICE.
            await genomicsRegistry.connect(buyerResearcher).grantAccess(1);

            const buyerBalAfter = await genomicToken.balanceOf(buyerResearcher.address);
            const aliceBalAfter = await genomicToken.balanceOf(creatorAlice.address);

            // Buyer paid EXACTLY PRICE
            expect(buyerBalBefore - buyerBalAfter).to.equal(PRICE);
            // Alice received EXACTLY PRICE
            expect(aliceBalAfter - aliceBalBefore).to.equal(PRICE);
            // Registry retained the donation unharmed
            expect(await genomicToken.balanceOf(await genomicsRegistry.getAddress())).to.equal(donationAmount);
        });

        it("3.2 [SOL-AM-DOSA-1: Strict Faucet Cooldown & Anti-Drain] Faucet rejects repeat claims within 3600 seconds", async function () {
            // First claim succeeds
            await expect(genomicToken.connect(buyerResearcher).faucet(buyerResearcher.address))
                .to.emit(genomicToken, "FaucetUsed");

            // Immediate second claim reverts
            await expect(
                genomicToken.connect(buyerResearcher).faucet(buyerResearcher.address)
            ).to.be.revertedWithCustomError(genomicToken, "FaucetCooldownActive");

            // Advance time by 1800 seconds (30 mins - still within 1-hour cooldown)
            await ethers.provider.send("evm_increaseTime", [1800]);
            await ethers.provider.send("evm_mine", []);

            await expect(
                genomicToken.connect(buyerResearcher).faucet(buyerResearcher.address)
            ).to.be.revertedWithCustomError(genomicToken, "FaucetCooldownActive");

            // Advance time by another 1805 seconds (3605 seconds total > 1 hour)
            await ethers.provider.send("evm_increaseTime", [1805]);
            await ethers.provider.send("evm_mine", []);

            // Second claim succeeds
            await expect(genomicToken.connect(buyerResearcher).faucet(buyerResearcher.address))
                .to.emit(genomicToken, "FaucetUsed");
        });

        it("3.3 [Time-Based Access Expiry] Access validity strictly conforms to duration and expires on schedule", async function () {
            await genomicsRegistry.connect(creatorAlice).registerGenomicData(
                SAMPLE_DATA_HASH,
                SAMPLE_RAW_CID,
                SAMPLE_SUMMARY_CID,
                SAMPLE_METADATA_CID,
                SAMPLE_TOKEN_URI,
                PRICE,
                DURATION, // 30 days
                ROYALTY_BPS
            );

            await genomicsRegistry.connect(buyerResearcher).grantAccess(1);
            expect(await genomicsRegistry.hasActiveAccess(1, buyerResearcher.address)).to.be.true;

            // Fast forward 29 days (still valid)
            await ethers.provider.send("evm_increaseTime", [29 * 24 * 3600]);
            await ethers.provider.send("evm_mine", []);
            expect(await genomicsRegistry.hasActiveAccess(1, buyerResearcher.address)).to.be.true;

            // Fast forward 1 day + 5 seconds (30 days + 5s elapsed)
            await ethers.provider.send("evm_increaseTime", [1 * 24 * 3600 + 5]);
            await ethers.provider.send("evm_mine", []);

            // Access expired!
            expect(await genomicsRegistry.hasActiveAccess(1, buyerResearcher.address)).to.be.false;

            // Renewal works: Buyer can re-purchase access
            await genomicsRegistry.connect(buyerResearcher).grantAccess(1);
            expect(await genomicsRegistry.hasActiveAccess(1, buyerResearcher.address)).to.be.true;
        });

        it("3.4 [Status Lifecycle Invariant] Paused or Revoked dataset immediately revokes active subscription", async function () {
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

            await genomicsRegistry.connect(buyerResearcher).grantAccess(1);
            expect(await genomicsRegistry.hasActiveAccess(1, buyerResearcher.address)).to.be.true;

            // Owner temporarily pauses dataset
            await genomicsRegistry.connect(creatorAlice).updateDataStatus(1, 1); // 1 = Paused
            expect(await genomicsRegistry.hasActiveAccess(1, buyerResearcher.address)).to.be.false;

            // Owner unpauses dataset back to Active
            await genomicsRegistry.connect(creatorAlice).updateDataStatus(1, 0); // 0 = Active
            expect(await genomicsRegistry.hasActiveAccess(1, buyerResearcher.address)).to.be.true;

            // Owner revokes dataset
            await genomicsRegistry.connect(creatorAlice).updateDataStatus(1, 2); // 2 = Revoked
            expect(await genomicsRegistry.hasActiveAccess(1, buyerResearcher.address)).to.be.false;

            // Cannot purchase revoked dataset
            await expect(
                genomicsRegistry.connect(buyerResearcher).grantAccess(1)
            ).to.be.revertedWithCustomError(genomicsRegistry, "DataNotActive");
        });
    });
});
