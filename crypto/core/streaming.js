/**
 * @file streaming.js
 * @description 64KB chunked AEAD framing encryption/decryption architecture inspired by GA4GH Crypt4GH
 *              block framing (Blob.slice per-chunk slicing with a bounded 500MB payload ceiling),
 *              upgraded to FIPS 140-3 standards with AES-256-GCM and RSA-OAEP 2048-bit on native
 *              W3C Web Crypto API, leveraging hardware acceleration (Intel AES-NI and ARMv8 Crypto).
 * @module crypto/core/streaming
 */

import {
  generateSymmetricKey,
  importKeyFromHex,
  packCiphertextPayload,
  unpackCiphertextPayload,
  computeDataHash,
  decryptGenomicPayload,
  consumeKeyInvocationBudget,
} from "./symmetric.js";

const cryptoObj =
  typeof window !== "undefined" && window.crypto
    ? window.crypto
    : globalThis.crypto;

if (!cryptoObj || !cryptoObj.subtle) {
  throw new Error("Web Crypto API (crypto.subtle) is required but not available in this environment.");
}

function buildChunkAadV1(chunkIndex, chunkCount, totalPlaintextSize) {
  const aad = new Uint8Array(16);
  const view = new DataView(aad.buffer);
  view.setUint32(0, chunkIndex >>> 0, false);
  view.setUint32(4, chunkCount >>> 0, false);
  view.setBigUint64(8, BigInt(totalPlaintextSize), false);
  return aad;
}

function buildChunkAadV2(chunkSize, chunkIndex, chunkCount, totalPlaintextSize) {
  // 25-byte AAD: magic[4] ("GNC2") || chunkSize[4] || chunkIndex[4] || chunkCount[4] || totalPlaintextSize[8] || isFinal[1]
  const aad = new Uint8Array(25);
  aad.set([0x47, 0x4E, 0x43, 0x32], 0);
  const view = new DataView(aad.buffer);
  view.setUint32(4, chunkSize >>> 0, false);
  view.setUint32(8, chunkIndex >>> 0, false);
  view.setUint32(12, chunkCount >>> 0, false);
  view.setBigUint64(16, BigInt(totalPlaintextSize), false);
  aad[24] = chunkIndex === chunkCount - 1 ? 1 : 0;
  return aad;
}

/**
 * Production Chunked Encryption for Big Data Genomics (.vcf, .fastq, .bam).
 * Follows GA4GH Crypt4GH chunking principles:
 * Encrypts data in discrete blocks (default 64KB per chunk) with individual IVs.
 * Supports streaming processing with an onProgress callback so large files (>100MB / 1GB)
 * never lock up the browser UI thread!
 * 
 * @param {Uint8Array|string|ArrayBuffer} data Input data
 * @param {Object} [options]
 * @param {number} [options.chunkSize=65536] Chunk size in bytes (default 64KB)
 * @param {Function} [options.onProgress] Progress callback (fraction, processedBytes, totalBytes)
 * @param {CryptoKey} [options.key] Optional symmetric key
 * @returns {Promise<{ payload: Uint8Array, rawDataHash: string, keyHex: string, activeKey: CryptoKey, chunkCount: number, totalPlaintextSize: number }>}
 */
const MAX_ALLOWED_PLAIN_BYTES = 500 * 1024 * 1024; // 500MB safety ceiling
const MAX_CHUNK_SIZE_BYTES = 16 * 1024 * 1024; // 16MB per-chunk ceiling
const MAX_CHUNK_COUNT = 500000; // Symmetric encrypt/decrypt chunk count ceiling (L-11)

export async function encryptGenomicDataChunked(data, options = {}) {
  const safeOptions = options || {};
  const chunkSize = safeOptions.chunkSize === undefined ? 64 * 1024 : safeOptions.chunkSize; // 64KB default chunks
  if (!Number.isInteger(chunkSize) || chunkSize <= 0 || chunkSize > MAX_CHUNK_SIZE_BYTES) {
    throw new Error(`Invalid chunkSize: expected integer between 1 and ${MAX_CHUNK_SIZE_BYTES} bytes`);
  }
  const onProgress = safeOptions.onProgress || (() => {});
  const activeKey =
    typeof safeOptions.key === "string"
      ? await importKeyFromHex(safeOptions.key)
      : safeOptions.key || (await generateSymmetricKey());

  const isBlobOrFile =
    data &&
    typeof data.slice === "function" &&
    typeof data.size === "number" &&
    typeof data.arrayBuffer === "function";

  let rawBytes = null;
  let totalBytes = 0;

  if (isBlobOrFile) {
    totalBytes = data.size;
  } else if (typeof data === "string") {
    rawBytes = new TextEncoder().encode(data);
    totalBytes = rawBytes.length;
  } else if (data instanceof Uint8Array) {
    rawBytes = data;
    totalBytes = rawBytes.length;
  } else if (data instanceof ArrayBuffer) {
    rawBytes = new Uint8Array(data);
    totalBytes = rawBytes.length;
  } else if (data && typeof data.arrayBuffer === "function") {
    rawBytes = new Uint8Array(await data.arrayBuffer());
    totalBytes = rawBytes.length;
  } else if (data && (typeof data.length === "number" || typeof data.byteLength === "number")) {
    rawBytes = new Uint8Array(data);
    totalBytes = rawBytes.length;
  } else {
    rawBytes = new Uint8Array(0);
    totalBytes = 0;
  }

  if (totalBytes > MAX_ALLOWED_PLAIN_BYTES) {
    throw new Error("Plaintext size exceeds maximum allowed safe limit");
  }

  const chunkCount = Math.ceil(totalBytes / chunkSize) || 1;
  if (chunkCount > MAX_CHUNK_COUNT) {
    throw new Error(`Chunk count (${chunkCount}) exceeds maximum allowed safe limit (${MAX_CHUNK_COUNT})`);
  }
  const {
    invocationSequence,
    nonceBudgetRemaining,
    keyHex,
  } = await consumeKeyInvocationBudget(activeKey, chunkCount);

  // Header: MAGIC (4) "GNC2" + ChunkSize (4) + ChunkCount (4) + TotalPlaintextSize (8) = 20 bytes
  const headerSize = 20;
  const totalCiphertextSize = totalBytes + chunkCount * 32;
  const fullPayload = new Uint8Array(headerSize + totalCiphertextSize);
  const view = new DataView(fullPayload.buffer, fullPayload.byteOffset, fullPayload.byteLength);

  // 'GNC2' = 0x47, 0x4E, 0x43, 0x32 (binds magic, chunkSize, chunkIndex, chunkCount, totalBytes, isFinal in AAD)
  fullPayload.set([0x47, 0x4E, 0x43, 0x32], 0);
  view.setUint32(4, chunkSize, false);
  view.setUint32(8, chunkCount, false);
  view.setBigUint64(12, BigInt(totalBytes), false);

  let offset = headerSize;
  for (let i = 0; i < chunkCount; i++) {
    const start = i * chunkSize;
    const end = Math.min(start + chunkSize, totalBytes);
    let slice;
    if (isBlobOrFile) {
      const sliceBlob = data.slice(start, end);
      const sliceBuf = await sliceBlob.arrayBuffer();
      slice = new Uint8Array(sliceBuf);
    } else {
      slice = rawBytes.subarray(start, end);
    }

    const chunkIv = cryptoObj.getRandomValues(new Uint8Array(12));
    const additionalData = buildChunkAadV2(chunkSize, i, chunkCount, totalBytes);
    const encBuf = await cryptoObj.subtle.encrypt(
      { name: "AES-GCM", iv: chunkIv, additionalData },
      activeKey,
      slice
    );
    const chunkCipher = new Uint8Array(encBuf);
    const packedChunkLen = 12 + chunkCipher.length;

    view.setUint32(offset, packedChunkLen, false);
    offset += 4;
    fullPayload.set(chunkIv, offset);
    offset += 12;
    fullPayload.set(chunkCipher, offset);
    offset += chunkCipher.length;

    onProgress((i + 1) / chunkCount, end, totalBytes);
  }

  const rawDataHash = await computeDataHash(fullPayload);

  return {
    payload: fullPayload,
    rawDataHash,
    keyHex,
    activeKey,
    chunkCount,
    totalPlaintextSize: totalBytes,
    invocationSequence,
    nonceBudgetRemaining,
  };
}

/**
 * Decrypt a Chunked Genomic Package (GA4GH Crypt4GH style).
 * Safely parses chunks, decrypts each block, and reassembles the complete plaintext.
 * @param {Uint8Array} payloadBytes
 * @param {CryptoKey|string} key
 * @param {Object} [options]
 * @param {Function} [options.onProgress]
 * @param {boolean} [options.asString=true]
 * @returns {Promise<string|Uint8Array>}
 */
export async function decryptGenomicDataChunked(payloadBytes, key, options = {}) {
  const safeOptions = options || {};
  const onProgress = safeOptions.onProgress || (() => {});
  const asString = safeOptions.asString !== false;

  let activeKey = key;
  if (typeof key === "string") {
    activeKey = await importKeyFromHex(key);
  }

  if (!payloadBytes) {
    throw new Error("Invalid payload: payloadBytes is null or undefined");
  }
  const bytes = payloadBytes instanceof Uint8Array
    ? payloadBytes
    : new Uint8Array(payloadBytes);

  // Check MAGIC 'GNC2' (current) or 'GNC1' (legacy backward-compatible)
  const isGncPrefix =
    bytes.length >= 20 &&
    bytes[0] === 0x47 &&
    bytes[1] === 0x4E &&
    bytes[2] === 0x43;
  const isGnc2 = isGncPrefix && bytes[3] === 0x32;
  const isGnc1 = isGncPrefix && bytes[3] === 0x31;
  const isChunked = isGnc2 || isGnc1;

  if (!isChunked) {
    // Fallback to standard single-payload decryption for backward compatibility
    return await decryptGenomicPayload(bytes, activeKey, asString);
  }

  if (bytes.length < 20) {
    throw new Error("Corrupted chunked payload: header size is smaller than 20 bytes");
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const chunkSize = view.getUint32(4, false);
  const chunkCount = view.getUint32(8, false);
  const totalPlaintextSizeRaw = view.getBigUint64(12, false);
  const totalPlaintextSize = Number(totalPlaintextSizeRaw);

  if (!Number.isInteger(chunkSize) || chunkSize <= 0 || chunkSize > MAX_CHUNK_SIZE_BYTES) {
    throw new Error(`Corrupted chunked payload: invalid chunkSize (${chunkSize})`);
  }
  if (!Number.isFinite(totalPlaintextSize) || totalPlaintextSize < 0) {
    throw new Error("Corrupted chunked payload: invalid totalPlaintextSize in header");
  }
  if (totalPlaintextSize > MAX_ALLOWED_PLAIN_BYTES) {
    throw new Error("Plaintext size exceeds maximum allowed safe limit");
  }
  if (chunkCount < 1 || chunkCount > MAX_CHUNK_COUNT) {
    throw new Error(`Corrupted chunked payload: unreasonable chunkCount (${chunkCount})`);
  }
  if (totalPlaintextSize > Math.max(0, bytes.length - 20)) {
    throw new Error("Corrupted chunked payload: declared plaintext size exceeds physical ciphertext length");
  }

  const resultBytes = new Uint8Array(totalPlaintextSize);
  let readOffset = 20;
  let writeOffset = 0;

  for (let i = 0; i < chunkCount; i++) {
    if (readOffset + 4 > bytes.length) {
      throw new Error("Corrupted chunked payload: unexpected end of buffer reading chunk length");
    }
    const chunkLen = view.getUint32(readOffset, false);
    if (chunkLen < 28 || readOffset + 4 + chunkLen > bytes.length) {
      throw new Error("Corrupted chunked payload: unexpected end of buffer or invalid chunk length");
    }
    readOffset += 4;
    const chunkIv = bytes.subarray(readOffset, readOffset + 12);
    const chunkCiphertext = bytes.subarray(readOffset + 12, readOffset + chunkLen);
    readOffset += chunkLen;

    const additionalData = isGnc2
      ? buildChunkAadV2(chunkSize, i, chunkCount, totalPlaintextSize)
      : buildChunkAadV1(i, chunkCount, totalPlaintextSize);
    const decBuf = await cryptoObj.subtle.decrypt(
      { name: "AES-GCM", iv: chunkIv, additionalData },
      activeKey,
      chunkCiphertext
    );
    const plainChunk = new Uint8Array(decBuf);
    if (writeOffset + plainChunk.length > resultBytes.length) {
      throw new Error(
        `Corrupted chunked payload: decrypted chunk exceeds declared plaintextSize (${writeOffset + plainChunk.length} > ${resultBytes.length})`
      );
    }
    resultBytes.set(plainChunk, writeOffset);
    writeOffset += plainChunk.length;

    onProgress((i + 1) / chunkCount, writeOffset, totalPlaintextSize);
  }

  if (readOffset !== bytes.length) {
    throw new Error(
      `Corrupted chunked payload: unexpected trailing bytes (${bytes.length - readOffset} unauthenticated bytes)`
    );
  }

  if (writeOffset !== totalPlaintextSize) {
    throw new Error(
      `Corrupted chunked payload: decrypted size (${writeOffset}) does not match header plaintextSize (${totalPlaintextSize})`
    );
  }

  if (asString) {
    return new TextDecoder("utf-8", { fatal: true }).decode(resultBytes);
  }
  return resultBytes;
}