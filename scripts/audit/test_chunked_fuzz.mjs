import { expect } from "chai";
import {
  encryptGenomicDataChunked,
  decryptGenomicDataChunked,
} from "../../crypto/client_crypto.js";

async function run() {
  console.log("=== ADVERSARIAL TEST 4: CHUNKED ENCRYPTION BOUNDARY & FUZZ TESTING ===");
  
  // Test A: 0-byte file (Empty Genomic Input)
  try {
    const emptyRes = await encryptGenomicDataChunked(new Uint8Array(0));
    console.log("Empty input chunkCount:", emptyRes.chunkCount, "payload length:", emptyRes.payload.length);
    const decryptedEmpty = await decryptGenomicDataChunked(emptyRes.payload, emptyRes.keyHex, { asString: false });
    console.log("Decrypted empty size:", decryptedEmpty.length);
    if (decryptedEmpty.length === 0) {
      console.log("  [PASS] 0-byte input handled safely.");
    }
  } catch (e) {
    console.log("  [FAIL] 0-byte input threw error:", e.message);
  }

  // Test B: Exactly 64KB chunk boundary
  const boundaryData = new Uint8Array(65536);
  boundaryData.fill(0x42);
  const boundaryRes = await encryptGenomicDataChunked(boundaryData, { chunkSize: 65536 });
  console.log("64KB boundary chunkCount:", boundaryRes.chunkCount);
  const decryptedBoundary = await decryptGenomicDataChunked(boundaryRes.payload, boundaryRes.keyHex, { asString: false });
  console.log("  [PASS] 64KB boundary match:", decryptedBoundary.every(b => b === 0x42));

  // Test C: Header Tampering - Corrupt the Chunk Count in Header
  console.log("\nTesting Header Tampering: modifying chunkCount from 1 to 9999...");
  const validData = new TextEncoder().encode("SAMPLE_GENOME_DATA_FOR_TAMPER_TEST");
  const validEnc = await encryptGenomicDataChunked(validData);
  const tamperedPayload = new Uint8Array(validEnc.payload);
  const view = new DataView(tamperedPayload.buffer, tamperedPayload.byteOffset, tamperedPayload.byteLength);
  view.setUint32(8, 9999, false); // Fake 9999 chunks

  try {
    await decryptGenomicDataChunked(tamperedPayload, validEnc.keyHex);
    console.log("  [FAIL] Header chunkCount tamper was NOT caught!");
  } catch (e) {
    console.log("  [PASS] Header tamper threw error as expected:", e.message);
  }

  // Test D: Payload truncation (Cut off before last byte)
  console.log("\nTesting Payload Truncation: truncating 5 bytes from payload...");
  const truncatedPayload = validEnc.payload.slice(0, validEnc.payload.length - 5);
  try {
    await decryptGenomicDataChunked(truncatedPayload, validEnc.keyHex);
    console.log("  [FAIL] Truncation was NOT caught!");
  } catch (e) {
    console.log("  [PASS] Truncation caught:", e.message);
  }
}

run().catch(console.error);
