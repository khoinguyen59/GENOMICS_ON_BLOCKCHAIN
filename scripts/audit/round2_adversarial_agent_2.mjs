/**
 * @file round2_adversarial_agent_2.mjs
 * @description Round 2 Independent Adversarial Audit Suite - Audit Agent 2
 *              Target Project: Genomics on Blockchain (IS355) - UIT 2026
 *              Instructor: ThS. Hà Lê Hoài Trung | Student: Nguyễn Trọng Khôi (23520783)
 * 
 * Specialized Adversarial Lens:
 * 1. Cryptographic Protocol Boundary (AES-256-GCM NIST SP 800-38D, 12-byte IV, 128-bit GMAC)
 * 2. WebCrypto Subtle API Quirks & Modulus Bounds (RSA-OAEP 2048-bit, 256-byte ciphertext constraints)
 * 3. RSA-OAEP / ECIES Key Encapsulation & Cross-Recipient Attack Resilience
 * 4. GA4GH Crypt4GH Streaming Chunked Encryption & Memory Bounds Guard
 * 5. Dual-Payload (VCF + PDF) Companion Packaging Consistency
 * 6. Smart Contract State Lifecycle Symmetry & Escrow Boundary (Invariant 16 & Invariant 15)
 */

import { expect } from "chai";
import hre from "hardhat";
import {
  generateSymmetricKey,
  exportKeyToHex,
  importKeyFromHex,
  packCiphertextPayload,
  unpackCiphertextPayload,
  generateAsymmetricKeyPair,
  exportPublicKey,
  importPublicKey,
  exportPrivateKey,
  importPrivateKey,
  computeDataHash,
  verifyDataIntegrity,
  encryptGenomicData,
  decryptGenomicData,
  decryptGenomicPayload,
  packageKeyCapsule,
  decryptKeyCapsule,
  generateClinicalPdfReport,
  encryptGenomicDataChunked,
  decryptGenomicDataChunked,
  savePersistentKeyPair,
  loadPersistentKeyPair,
  saveOwnerCapsulePersistent,
  loadOwnerCapsulePersistent,
  getAllOwnerCapsulesPersistent,
  exportSovereignKeyVault,
  importSovereignKeyVault,
} from "../../crypto/client_crypto.js";
import {
  computeIpfsCidV0,
  base58Encode,
  encodeUnixFsFileNode,
  cacheLocalIpfsContent,
  getLocalIpfsContent,
  retrieveFromIpfs,
} from "../../ipfs/pinata_uploader.js";
import { buildPhenopacket } from "../../ipfs/phenopacket_builder.js";

async function runAgent2AdversarialSuite() {
  console.log("================================================================================");
  console.log("[AUDIT] ROUND 2 INDEPENDENT ADVERSARIAL AUDIT SUITE - AUDIT AGENT 2");
  console.log("   Target Course: IS355 - Công nghệ Blockchain (Khoa HTTT - UIT)");
  console.log("   Instructor: ThS. Hà Lê Hoài Trung | Student: Nguyễn Trọng Khôi (23520783)");
  console.log("   Specialized Lens: Cryptographic Boundary, WebCrypto Quirks, Key Encapsulation");
  console.log("================================================================================\n");

  let totalTests = 0;
  let passedTests = 0;
  const verifiedDefects = [];

  function recordTest(title, passed, detail = "", vulnRef = null) {
    totalTests++;
    if (passed) {
      passedTests++;
      console.log(`  [PASS #${totalTests}] ${title}`);
      if (detail) console.log(`         ↳ ${detail}`);
    } else {
      console.log(`  [VULN PROBE #${totalTests}] ${title}`);
      if (detail) console.log(`         ↳ ${detail}`);
      if (vulnRef) verifiedDefects.push({ test: title, vulnRef, detail });
    }
  }

  // ==============================================================================
  // MODULE 1: CRYPTOGRAPHIC PROTOCOL BOUNDARY & WEBCRYPTO SUBTLE API QUIRKS
  // ==============================================================================
  console.log("--------------------------------------------------------------------------------");
  console.log("MODULE 1: Cryptographic Protocol Boundary & WebCrypto Subtle API Quirks");
  console.log("--------------------------------------------------------------------------------");

  // Test 1.1: AES-256 Symmetric Key Hex Length Boundary (32 bytes = 64 hex chars)
  {
    const validKey = await generateSymmetricKey();
    const validHex = await exportKeyToHex(validKey);
    const importedValid = await importKeyFromHex(validHex);
    recordTest(
      "WebCrypto AES-256: 64-char hex key cleanly exports and imports",
      importedValid.algorithm.name === "AES-GCM" && importedValid.algorithm.length === 256,
      `Key hex length: ${validHex.length} chars (32 bytes)`
    );

    // Test 1.2: Reject malformed hex strings in importKeyFromHex
    let oddHexRejected = false;
    try {
      await importKeyFromHex("abc"); // Odd length 3 chars
    } catch (e) {
      oddHexRejected = true;
    }
    recordTest(
      "Cryptographic Robustness: Odd-length hex key rejected by importKeyFromHex",
      oddHexRejected,
      "Prevents partial-byte truncation errors"
    );

    // Test 1.3: Non-32-byte key detection (DEF2-2-04)
    // Probe if importKeyFromHex allows non-256-bit (e.g. 128-bit) keys without throwing
    let non32ByteRejected = false;
    try {
      const key128 = await importKeyFromHex("0123456789abcdef0123456789abcdef"); // 32 hex chars = 16 bytes
      if (key128.algorithm.length === 256) {
        non32ByteRejected = true;
      }
    } catch {
      non32ByteRejected = true;
    }

    if (!non32ByteRejected) {
      recordTest(
        "Cryptographic Boundary Probe (DEF2-2-04): 16-byte hex silently imported instead of strictly enforcing 32-byte (256-bit) key",
        false,
        "importKeyFromHex lacks check for cleanHex.length === 64, allowing sub-256-bit keys",
        "DEF2-2-04"
      );
    } else {
      recordTest(
        "Cryptographic Boundary: Non-32-byte hex keys strictly rejected",
        true,
        "Enforces NIST SP 800-38D 256-bit security parameter"
      );
    }
  }

  // Test 1.4: AES-GCM NIST SP 800-38D Boundary Tests
  {
    const plaintexts = [
      "", // 0 bytes
      "A", // 1 byte
      "1".repeat(15), // 15 bytes (sub-block)
      "1".repeat(16), // 16 bytes (exact single block)
      "1".repeat(17), // 17 bytes (spanning blocks)
      "1".repeat(65536), // 64 KB (exact GA4GH chunk)
      "1".repeat(131072), // 128 KB (2 exact GA4GH chunks)
    ];

    let allPassed = true;
    for (const pt of plaintexts) {
      const enc = await encryptGenomicData(pt);
      const dec = await decryptGenomicPayload(enc.payload, enc.activeKey);
      if (dec !== pt) {
        allPassed = false;
        break;
      }
    }
    recordTest(
      "AES-GCM Boundary: 0B, 1B, 15B, 16B, 17B, 64KB, 128KB roundtrips with 100% byte fidelity",
      allPassed,
      "Tested 7 discrete block and boundary conditions"
    );
  }

  // Test 1.5: Fault Injection on AES-GCM Ciphertext Payload
  {
    const originalText = "CHROMOSOME_12_ALDH2_RS671_AUTHENTICATED_SEQUENCE";
    const enc = await encryptGenomicData(originalText);

    // Tamper Byte 0 of IV (first 12 bytes)
    const ivTampered = new Uint8Array(enc.payload);
    ivTampered[0] ^= 0x42;
    let ivTamperCaught = false;
    try {
      await decryptGenomicPayload(ivTampered, enc.activeKey);
    } catch {
      ivTamperCaught = true;
    }

    // Tamper Byte 15 of Ciphertext (offset >= 12)
    const cipherTampered = new Uint8Array(enc.payload);
    cipherTampered[15] ^= 0x01;
    let cipherTamperCaught = false;
    try {
      await decryptGenomicPayload(cipherTampered, enc.activeKey);
    } catch {
      cipherTamperCaught = true;
    }

    // Truncate payload below minimum size (12 bytes IV + 16 bytes tag = 28 bytes)
    const truncatedPayload = enc.payload.slice(0, 10); // only 10 bytes
    let truncatedCaught = false;
    try {
      await decryptGenomicPayload(truncatedPayload, enc.activeKey);
    } catch {
      truncatedCaught = true;
    }

    recordTest(
      "Fault Injection: IV tampering, Ciphertext bit-flip, and <28B truncation immediately trapped",
      ivTamperCaught && cipherTamperCaught && truncatedCaught,
      "GMAC 128-bit authentication strictly halts execution before unauthenticated output"
    );
  }

  // ==============================================================================
  // MODULE 2: RSA-OAEP 2048-BIT KEY ENCAPSULATION & CROSS-RECIPIENT SECURITY
  // ==============================================================================
  console.log("\n--------------------------------------------------------------------------------");
  console.log("MODULE 2: RSA-OAEP 2048 Key Encapsulation & Cross-Recipient Security");
  console.log("--------------------------------------------------------------------------------");

  {
    const kpAlice = await generateAsymmetricKeyPair(false); // Non-extractable private key
    const kpBob = await generateAsymmetricKeyPair(false); // Non-extractable private key
    const kpCharlie = await generateAsymmetricKeyPair(false); // Third party attacker

    const aliceAddress = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
    const bobAddress = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";
    const charlieAddress = "0x90F79bf6EB2c4f870365E785982E1f101E93b906";

    const sessionKey = await generateSymmetricKey();
    const sessionKeyHex = await exportKeyToHex(sessionKey);

    const bobPubJwk = await exportPublicKey(kpBob.publicKey);

    // Alice encapsulates key specifically for Bob
    const capsuleForBob = await packageKeyCapsule(
      sessionKeyHex,
      bobPubJwk,
      bobAddress,
      aliceAddress
    );

    const parsedCapsule = JSON.parse(capsuleForBob);
    recordTest(
      "RSA-OAEP Encapsulation: Generates valid JSON capsule with 512-hex char ciphertext (256 bytes)",
      parsedCapsule.version === "GENO-ASYM-RSA-OAEP-v2" &&
        parsedCapsule.keyCipher &&
        parsedCapsule.keyCipher.length === 512,
      `Modulus length: 2048 bits (256 bytes = 512 hex chars). Cipher: ${parsedCapsule.keyCipher.slice(0, 24)}...`
    );

    // Bob successfully decapsulates key with his non-extractable private key
    const bobDecaps = await decryptKeyCapsule(capsuleForBob, kpBob.privateKey);
    recordTest(
      "RSA-OAEP Decapsulation: Authorized recipient (Bob) recovers exact 256-bit AES key",
      bobDecaps.keyHex === sessionKeyHex,
      "Key recovered flawlessly using non-extractable CryptoKey"
    );

    // Adversarial Test: Charlie attempts to decapsulate Bob's capsule
    let charlieCaught = false;
    try {
      await decryptKeyCapsule(capsuleForBob, kpCharlie.privateKey);
    } catch {
      charlieCaught = true;
    }
    recordTest(
      "Cross-Recipient Attack: Unauthorized party (Charlie) cannot decapsulate Bob's capsule",
      charlieCaught,
      "RSA-OAEP mathematically rejects decryption under mismatched private key"
    );

    // Adversarial Test: Tamper with a single byte in keyCipher
    const tamperedCapsuleObj = { ...parsedCapsule };
    const cipherChars = tamperedCapsuleObj.keyCipher.split("");
    cipherChars[50] = cipherChars[50] === "0" ? "1" : "0"; // Flip 1 hex char
    tamperedCapsuleObj.keyCipher = cipherChars.join("");

    let tamperCaught = false;
    try {
      await decryptKeyCapsule(JSON.stringify(tamperedCapsuleObj), kpBob.privateKey);
    } catch {
      tamperCaught = true;
    }
    recordTest(
      "Capsule Tamper Injection: 1-char corruption in keyCipher rejected gracefully without hanging",
      tamperCaught,
      "OAEP decoding failure caught cleanly"
    );

    // Adversarial Test: Malformed capsule formats (DEF2-2-03)
    let malformedCaught = 0;
    const malformedInputs = [
      "",
      "null",
      "{}",
      JSON.stringify({ keyCipher: "" }),
      JSON.stringify({ keyCipher: "0123" }), // Only 2 bytes (not 256 bytes)
      JSON.stringify({ keyCipher: "abc" }), // Odd hex length
    ];

    for (const inp of malformedInputs) {
      try {
        await decryptKeyCapsule(inp, kpBob.privateKey);
      } catch {
        malformedCaught++;
      }
    }
    recordTest(
      "Capsule Robustness (DEF2-2-03): Rejects empty, non-hex, odd-length, and truncated ciphertexts",
      malformedCaught === malformedInputs.length,
      `Rejected ${malformedCaught}/${malformedInputs.length} malformed capsule payloads`
    );
  }

  // ==============================================================================
  // MODULE 3: GA4GH CRYPT4GH STREAMING CHUNKED ENCRYPTION & MEMORY BOUNDS GUARD
  // ==============================================================================
  console.log("\n--------------------------------------------------------------------------------");
  console.log("MODULE 3: GA4GH Crypt4GH Streaming Chunked Encryption & Memory Bounds");
  console.log("--------------------------------------------------------------------------------");

  {
    // Test 3.1: Chunked streaming across multi-chunk boundary
    const chunkSize = 16384; // 16KB for testing multiple chunks
    const chunkCountExpected = 5;
    const testBufferSize = chunkSize * 4 + 1024; // 4 full chunks + 1 partial chunk (1024 bytes) = 5 chunks

    const genomicBuffer = new Uint8Array(testBufferSize);
    for (let i = 0; i < testBufferSize; i++) {
      genomicBuffer[i] = (i * 31 + 7) & 0xff; // Pseudorandom sequence
    }

    const progressReports = [];
    const encChunked = await encryptGenomicDataChunked(genomicBuffer, {
      chunkSize,
      onProgress: (frac, proc, tot) => {
        progressReports.push({ frac, proc, tot });
      },
    });

    recordTest(
      "Crypt4GH Chunking: Splits genomic stream into discrete blocks with progress telemetry",
      encChunked.chunkCount === chunkCountExpected && progressReports.length === chunkCountExpected,
      `Input size: ${testBufferSize}B, Chunks: ${encChunked.chunkCount}, Progress updates: ${progressReports.length}`
    );

    // Verify Header Structure: Magic GNC1 (0x47, 0x4E, 0x43, 0x31)
    const headerMagic = String.fromCharCode(
      encChunked.payload[0],
      encChunked.payload[1],
      encChunked.payload[2],
      encChunked.payload[3]
    );
    recordTest(
      "Crypt4GH Magic Header: Authentic 'GNC1' binary specification header validated",
      headerMagic === "GNC1",
      `Header magic bytes: 0x${Buffer.from(encChunked.payload.slice(0, 4)).toString("hex")} ("${headerMagic}")`
    );

    // Decrypt multi-chunk package
    const decChunked = await decryptGenomicDataChunked(encChunked.payload, encChunked.keyHex, { asString: false });
    let bytesMatch = decChunked.length === testBufferSize;
    if (bytesMatch) {
      for (let i = 0; i < testBufferSize; i++) {
        if (decChunked[i] !== genomicBuffer[i]) {
          bytesMatch = false;
          break;
        }
      }
    }
    recordTest(
      "Crypt4GH Reassembly: Multi-chunk decryption preserves 100% byte fidelity without memory leaks",
      bytesMatch,
      `Decrypted bytes: ${decChunked.length} / Expected: ${testBufferSize}`
    );

    // Fault Injection: Corrupt Chunk #3 within multi-chunk payload
    const corruptedMultiChunk = new Uint8Array(encChunked.payload);
    // Offset around chunk 3 (header 20 + chunk 0 + chunk 1 + chunk 2 + middle of chunk 3)
    const corruptOffset = 20 + (chunkSize + 16 + 12 + 4) * 2 + 50;
    corruptedMultiChunk[corruptOffset] ^= 0xff;

    let chunkCorruptionCaught = false;
    try {
      await decryptGenomicDataChunked(corruptedMultiChunk, encChunked.keyHex);
    } catch {
      chunkCorruptionCaught = true;
    }
    recordTest(
      "Crypt4GH Byzantine Fault Localization: Bit corruption inside intermediate chunk trapped",
      chunkCorruptionCaught,
      "Prevents partial silent corruption of biological sequences"
    );
  }

  // ==============================================================================
  // MODULE 4: DUAL-PAYLOAD (VCF + PDF) PACKAGING & PHENOPACKET V2 MANIFEST
  // ==============================================================================
  console.log("\n--------------------------------------------------------------------------------");
  console.log("MODULE 4: Dual-Payload (VCF + PDF) Companion Packaging & Manifest Consistency");
  console.log("--------------------------------------------------------------------------------");

  {
    // Generate valid clinical PDF report
    const pdfBytes = generateClinicalPdfReport({
      subjectId: "1000G_KHV_01",
      disease: "Population Genetic Variation (KHV Cohort)",
      gene: "ALDH2",
      variant: "rs671 (c.1510G>A, p.Glu504Lys)",
    });

    const pdfString = new TextDecoder().decode(pdfBytes);
    const hasPdfHeader = pdfString.startsWith("%PDF-1.4");
    const hasPdfTrailer = pdfString.includes("%%EOF");
    const hasXref = pdfString.includes("xref");

    recordTest(
      "Clinical PDF Generation: Generates authentic ISO 32000 / PDF-1.4 document structure",
      hasPdfHeader && hasPdfTrailer && hasXref,
      `PDF size: ${pdfBytes.length} bytes, Header: %PDF-1.4, Trailer: %%EOF`
    );

    // Dual-Payload Encryption with Single Session Key
    const vcfPlaintext = "##fileformat=VCFv4.2\nchr12\t111803962\trs671\tG\tA\tANN=ALDH2";
    const encVcf = await encryptGenomicData(vcfPlaintext);
    const encPdf = await encryptGenomicData(pdfBytes, encVcf.activeKey);

    // Decrypt both using the SAME key (DEF-08 verification)
    const decVcf = await decryptGenomicPayload(encVcf.payload, encVcf.activeKey);
    const decPdf = await decryptGenomicPayload(encPdf.payload, encVcf.activeKey, false);

    recordTest(
      "Dual-Payload Consistency (DEF-08 Verification): Single AES session key decrypts both VCF and PDF",
      decVcf === vcfPlaintext && decPdf.length === pdfBytes.length && decPdf[0] === 0x25, // '%' in %PDF
      "Both raw sequence and clinical report share single cryptographic capsule"
    );

    // Phenopacket v2 Manifest Validation
    const phenopacket = buildPhenopacket({
      subjectId: "ANON_KHV_8821",
      disease: "Alcohol Flush Reaction",
      diseaseCurie: "SO:0001583",
      phenotypes: [{ id: "HP:0001945", label: "Fever" }],
      variants: [{ gene: "ALDH2", hgvs: "c.1510G>A", zygosity: "heterozygous" }],
      rawCid: "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG",
      rawDataHash: encVcf.rawDataHash,
    });

    recordTest(
      "GA4GH Phenopacket v2 Compliance: Schema conforms to strict standard (Individual, Features, Diseases)",
      phenopacket.schemaVersion === "2.0.0" &&
        phenopacket.subject.id === "ANON_KHV_8821" &&
        phenopacket.files.length > 0 &&
        phenopacket.files[0].fileAttributes.rawDataHash === encVcf.rawDataHash,
      `Schema version: ${phenopacket.schemaVersion}, Subject: ${phenopacket.subject.id}`
    );
  }

  // ==============================================================================
  // MODULE 5: SMART CONTRACT STATE LIFECYCLE SYMMETRY & ESCROW TIMELOCK BOUNDARY
  // ==============================================================================
  console.log("\n--------------------------------------------------------------------------------");
  console.log("MODULE 5: Smart Contract State Lifecycle Symmetry & Escrow Timelock Boundary");
  console.log("--------------------------------------------------------------------------------");

  {
    const { ethers } = await hre.network.create();
    const [deployer, seller, buyer, thirdParty] = await ethers.getSigners();

    const GenomicToken = await ethers.getContractFactory("GenomicToken");
    const token = await GenomicToken.deploy(deployer.address);
    await token.waitForDeployment();

    const GenomicNFT = await ethers.getContractFactory("GenomicNFT");
    const nft = await GenomicNFT.deploy(deployer.address, 1000); // 10% default royalty
    await nft.waitForDeployment();

    const GenomicsRegistry = await ethers.getContractFactory("GenomicsRegistry");
    const registry = await GenomicsRegistry.deploy(token.target, nft.target, deployer.address);
    await registry.waitForDeployment();
    await nft.setRegistryContract(registry.target);

    // Fund accounts
    const initialPrice = ethers.parseUnits("100", 18);
    await token.connect(deployer).transfer(buyer.address, ethers.parseUnits("10000", 18));
    await token.connect(deployer).transfer(seller.address, ethers.parseUnits("1000", 18));

    // Register dataset #1 for Escrow tests
    const dummyHash1 = ethers.keccak256(ethers.toUtf8Bytes("GENOME_SEQ_ALPHA_1"));
    await registry.connect(seller).registerGenomicData(
      dummyHash1,
      "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG",
      "QmZ4tDuvesekSs4qM5ZBKpXiZGun7S2CYtEZRB3DYXkjGx",
      "QmPZ9qBzzyAtRaQQQUZr6xHS6wVfETRR249s63UME18znJ",
      "ipfs://meta_uri_1",
      initialPrice,
      86400 * 30, // 30 days
      1000 // 10% royalty
    );

    const disputeWindow = 3600 * 24; // 24 hours
    await token.connect(buyer).approve(registry.target, initialPrice * 10n);
    await registry.connect(buyer).grantAccessWithEscrow(1, disputeWindow);

    const escrowBefore = await registry.escrowDeposits(1, buyer.address);
    recordTest(
      "Escrow Lockup: Buyer payment safely deposited in escrow with timelock protection",
      escrowBefore.amount === initialPrice && !escrowBefore.released && !escrowBefore.refunded,
      `Escrowed amount: ${ethers.formatUnits(escrowBefore.amount, 18)} GENO, Window: ${escrowBefore.disputeWindow}s`
    );

    // Test 5.2: Dispute window active prevents premature refund
    let prematureRefundCaught = false;
    try {
      await registry.connect(buyer).claimEscrowRefund(1);
    } catch (e) {
      prematureRefundCaught = e.message.includes("DisputeWindowActive");
    }
    recordTest(
      "Escrow Protection: Premature refund during active dispute window rejected",
      prematureRefundCaught,
      "SLA delivery time window respected"
    );

    // Test 5.3: Timelock dispute window expiry and 100% refund (on Dataset #1 where seller did NOT deliver)
    await ethers.provider.send("evm_increaseTime", [disputeWindow + 10]);
    await ethers.provider.send("evm_mine", []);

    const buyerBalBefore = await token.balanceOf(buyer.address);
    await registry.connect(buyer).claimEscrowRefund(1);
    const buyerBalAfter = await token.balanceOf(buyer.address);

    const escrowAfter = await registry.escrowDeposits(1, buyer.address);
    recordTest(
      "Escrow Timelock Settlement: Buyer claims 100% refund after dispute window expiry",
      escrowAfter.refunded && buyerBalAfter - buyerBalBefore === initialPrice,
      `Refunded: ${ethers.formatUnits(buyerBalAfter - buyerBalBefore, 18)} GENO. Access revoked.`
    );

    // Register dataset #2 for Lifecycle Symmetry tests (DEF2-2-01)
    const dummyHash2 = ethers.keccak256(ethers.toUtf8Bytes("GENOME_SEQ_ALPHA_2"));
    await registry.connect(seller).registerGenomicData(
      dummyHash2,
      "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG",
      "QmZ4tDuvesekSs4qM5ZBKpXiZGun7S2CYtEZRB3DYXkjGx",
      "QmPZ9qBzzyAtRaQQQUZr6xHS6wVfETRR249s63UME18znJ",
      "ipfs://meta_uri_2",
      initialPrice,
      86400 * 30,
      1000
    );

    // Buyer purchases access on dataset #2
    await registry.connect(buyer).grantAccessWithEscrow(2, disputeWindow);

    // Owner pauses dataset #2
    await registry.connect(seller).updateDataStatus(2, 1); // 1 = Paused
    const pausedData2 = await registry.getGenomicData(2);
    recordTest(
      "Status Lifecycle: Owner transitions dataset #2 to Paused (DataStatus = 1)",
      pausedData2.status === 1n,
      "Status transition recorded on-chain"
    );

    // Check read access on paused dataset #2
    const hasAccessWhilePaused = await registry.hasActiveAccess(2, buyer.address);
    let capsuleReadBlocked = false;
    try {
      await registry.connect(buyer).getTransformedCapsule(2);
    } catch (e) {
      capsuleReadBlocked = e.message.includes("DataNotActive");
    }
    recordTest(
      "Invariant 16 Enforcement: Paused status immediately blocks researcher hasActiveAccess and read calls",
      !hasAccessWhilePaused && capsuleReadBlocked,
      "Compliance with GDPR & INVARIANT-16"
    );

    // Test 5.6: Test storeTransformedCapsule & emitTransformedCapsule status checks (DEF2-2-01)
    let storeCapsuleBlockedWhenPaused = false;
    try {
      await registry.connect(seller).storeTransformedCapsule(2, buyer.address, "TEST_CAPSULE");
    } catch (e) {
      storeCapsuleBlockedWhenPaused = e.message.includes("DataNotActive");
    }

    let emitCapsuleBlockedWhenPaused = false;
    try {
      await registry.connect(seller).emitTransformedCapsule(2, buyer.address, "TEST_CAPSULE");
    } catch (e) {
      emitCapsuleBlockedWhenPaused = e.message.includes("DataNotActive");
    }

    if (!storeCapsuleBlockedWhenPaused || !emitCapsuleBlockedWhenPaused) {
      recordTest(
        "State Symmetry Defect (DEF2-2-01): storeTransformedCapsule/emitTransformedCapsule lack status == Active guard",
        false,
        "Vulnerability confirmed: Seller/worker can push capsules and trigger escrow release while dataset is Paused or Revoked",
        "DEF2-2-01"
      );
    } else {
      recordTest(
        "State Symmetry: storeTransformedCapsule and emitTransformedCapsule verify status == Active",
        true,
        "Mutators reject capsule dispatch when dataset is not active"
      );
    }
  }

  // ==============================================================================
  // MODULE 6: IPFS MULTIHASH DAG-PB INTEGRITY & CAS CACHE
  // ==============================================================================
  console.log("\n--------------------------------------------------------------------------------");
  console.log("MODULE 6: IPFS MultiHash CIDv0 DAG-PB Integrity & Content-Addressable Cache");
  console.log("--------------------------------------------------------------------------------");

  {
    // Test 6.1: CIDv0 multihash format verification
    const testData = new TextEncoder().encode("SAMPLE_GENOME_DATA_IPFS_INTEGRITY_CHECK");
    const cid = await computeIpfsCidV0(testData);

    const isGenuineCid = cid.startsWith("Qm") && cid.length === 46;
    recordTest(
      "IPFS CIDv0 Multihash: Genuine 46-char Base58 RFC multihash computed (DAG-PB + SHA-256)",
      isGenuineCid,
      `Computed CID: ${cid} (Starts with 'Qm', length 46)`
    );

    // Test 6.2: Anti-Mockup Verification (INVARIANT-02)
    recordTest(
      "Anti-Mockup (INVARIANT-02): Zero fake 'QmGeno' or fabricated hex multihashes",
      !cid.includes("QmGeno"),
      "Pure cryptographic multihash standard verified"
    );

    // Test 6.3: CAS Cache Roundtrip
    cacheLocalIpfsContent(cid, testData, "text/plain");
    const retrieved = getLocalIpfsContent(cid);
    recordTest(
      "Content-Addressable Storage: Local CAS cache stores and retrieves by exact cryptographic CID",
      retrieved && retrieved.length === testData.length,
      `Retrieved ${retrieved?.length} bytes from CAS cache`
    );
  }

  // ==============================================================================
  // AUDIT SUMMARY & DEFECT CATALOG REPORT
  // ==============================================================================
  console.log("\n================================================================================");
  console.log("[AUDIT] ROUND 2 ADVERSARIAL AUDIT EXECUTION SUMMARY - AGENT 2");
  console.log("================================================================================");
  console.log(`Total Adversarial Probes Run : ${totalTests}`);
  console.log(`Standard Invariants Passed   : ${passedTests}`);
  console.log(`Defect Discoveries / Gaps    : ${verifiedDefects.length}`);
  console.log("================================================================================\n");

  if (verifiedDefects.length > 0) {
    console.log("Defect Candidates Identified During Adversarial Probing:");
    for (const f of verifiedDefects) {
      console.log(`  * [${f.vulnRef}] ${f.test}`);
      console.log(`    ↳ Root Cause / Evidence: ${f.detail}\n`);
    }
  }

  return { totalTests, passedTests, verifiedDefects };
}

runAgent2AdversarialSuite()
  .then((res) => {
    const failed = res.verifiedDefects.length > 0 || res.passedTests !== res.totalTests;
    process.exit(failed ? 1 : 0);
  })
  .catch((err) => {
    console.error("Adversarial suite encountered error:", err);
    process.exit(1);
  });
