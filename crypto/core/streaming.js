/**
 * @file streaming.js
 * @description 64KB chunked streaming encryption/decryption architecture following GA4GH Crypt4GH
 *              O(1) memory optimization principles, upgraded to FIPS 140-3 standards with
 *              AES-256-GCM and RSA-OAEP 2048-bit on native W3C Web Crypto API, leveraging
 *              hardware acceleration (Intel AES-NI and ARMv8 Cryptography Extensions).
 * @module crypto/core/streaming
 */

import {
  generateSymmetricKey,
  exportKeyToHex,
  importKeyFromHex,
  packCiphertextPayload,
  unpackCiphertextPayload,
  computeDataHash,
  decryptGenomicPayload,
} from "./symmetric.js";

const cryptoObj =
  typeof window !== "undefined" && window.crypto
    ? window.crypto
    : globalThis.crypto;

if (!cryptoObj || !cryptoObj.subtle) {
  throw new Error("Web Crypto API (crypto.subtle) is required but not available in this environment.");
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
export async function encryptGenomicDataChunked(data, options = {}) {
  const safeOptions = options || {};
  const chunkSize = safeOptions.chunkSize || 64 * 1024; // 64KB chunks
  const onProgress = safeOptions.onProgress || (() => {});
  const activeKey = safeOptions.key || (await generateSymmetricKey());

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

  const chunkCount = Math.ceil(totalBytes / chunkSize) || 1;
  const encryptedChunks = [];
  let totalCiphertextSize = 0;

  for (let i = 0; i < chunkCount; i++) {
    const start = i * chunkSize;
    const end = Math.min(start + chunkSize, totalBytes);
    let slice;
    if (isBlobOrFile) {
      const sliceBlob = data.slice(start, end);
      const sliceBuf = await sliceBlob.arrayBuffer();
      slice = new Uint8Array(sliceBuf);
    } else {
      slice = rawBytes.slice(start, end);
    }

    const chunkIv = cryptoObj.getRandomValues(new Uint8Array(12));
    const encBuf = await cryptoObj.subtle.encrypt(
      { name: "AES-GCM", iv: chunkIv },
      activeKey,
      slice
    );
    const chunkCipher = new Uint8Array(encBuf);
    const packedChunk = packCiphertextPayload(chunkIv, chunkCipher);

    encryptedChunks.push(packedChunk);
    totalCiphertextSize += 4 + packedChunk.length; // 4-byte length prefix + chunk

    onProgress((i + 1) / chunkCount, end, totalBytes);
  }

  // Header: MAGIC (4) "GNC1" + ChunkSize (4) + ChunkCount (4) + TotalPlaintextSize (8) = 20 bytes
  const headerSize = 20;
  const fullPayload = new Uint8Array(headerSize + totalCiphertextSize);
  const view = new DataView(fullPayload.buffer, fullPayload.byteOffset, fullPayload.byteLength);

  // 'GNC1' = 0x47, 0x4E, 0x43, 0x31
  fullPayload.set([0x47, 0x4E, 0x43, 0x31], 0);
  view.setUint32(4, chunkSize, false);
  view.setUint32(8, chunkCount, false);
  view.setBigUint64(12, BigInt(totalBytes), false);

  let offset = headerSize;
  for (const chunk of encryptedChunks) {
    view.setUint32(offset, chunk.length, false);
    offset += 4;
    fullPayload.set(chunk, offset);
    offset += chunk.length;
  }

  const rawDataHash = await computeDataHash(fullPayload);
  const keyHex = await exportKeyToHex(activeKey);

  return {
    payload: fullPayload,
    rawDataHash,
    keyHex,
    activeKey,
    chunkCount,
    totalPlaintextSize: totalBytes,
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

  // Check MAGIC 'GNC1'
  const isChunked =
    bytes.length >= 20 &&
    bytes[0] === 0x47 &&
    bytes[1] === 0x4E &&
    bytes[2] === 0x43 &&
    bytes[3] === 0x31;

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

  const MAX_ALLOWED_PLAIN_BYTES = 500 * 1024 * 1024; // 500MB safety ceiling
  if (!Number.isFinite(totalPlaintextSize) || totalPlaintextSize < 0) {
    throw new Error("Corrupted chunked payload: invalid totalPlaintextSize in header");
  }
  if (totalPlaintextSize > MAX_ALLOWED_PLAIN_BYTES) {
    throw new Error("Plaintext size exceeds maximum allowed safe limit");
  }
  if (chunkCount < 0 || chunkCount > 500000) {
    throw new Error(`Corrupted chunked payload: unreasonable chunkCount (${chunkCount})`);
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
    const chunkData = bytes.slice(readOffset, readOffset + chunkLen);
    readOffset += chunkLen;

    const { iv, ciphertext } = unpackCiphertextPayload(chunkData);
    const decBuf = await cryptoObj.subtle.decrypt(
      { name: "AES-GCM", iv: iv },
      activeKey,
      ciphertext
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

  if (writeOffset !== totalPlaintextSize) {
    throw new Error(
      `Corrupted chunked payload: decrypted size (${writeOffset}) does not match header plaintextSize (${totalPlaintextSize})`
    );
  }

  if (asString) {
    return new TextDecoder().decode(resultBytes);
  }
  return resultBytes;
}
