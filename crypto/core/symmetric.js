/**
 * @file symmetric.js
 * @description NIST SP 800-38D AES-256-GCM authenticated symmetric encryption & on-chain data integrity.
 * @module crypto/core/symmetric
 */

const cryptoObj =
  typeof window !== "undefined" && window.crypto
    ? window.crypto
    : globalThis.crypto;

if (!cryptoObj || !cryptoObj.subtle) {
  throw new Error("Web Crypto API (crypto.subtle) is required but not available in this environment.");
}

/**
 * Generate a cryptographically secure 256-bit AES-GCM symmetric key
 * @returns {Promise<CryptoKey>}
 */
export async function generateSymmetricKey() {
  return await cryptoObj.subtle.generateKey(
    {
      name: "AES-GCM",
      length: 256,
    },
    true, // extractable for encryption session
    ["encrypt", "decrypt"]
  );
}

/**
 * Export a symmetric CryptoKey to a hexadecimal string
 * @param {CryptoKey} key 
 * @returns {Promise<string>}
 */
export async function exportKeyToHex(key) {
  const rawKey = await cryptoObj.subtle.exportKey("raw", key);
  return Array.from(new Uint8Array(rawKey))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Import a symmetric CryptoKey from a hexadecimal string
 * @param {string} hexKey 
 * @returns {Promise<CryptoKey>}
 */
export async function importKeyFromHex(hexKey) {
  if (!hexKey || typeof hexKey !== "string") {
    throw new Error("Invalid hex key: input must be a non-empty string.");
  }
  const cleanHex = hexKey.startsWith("0x") ? hexKey.slice(2) : hexKey;
  if (cleanHex.length !== 64 || !/^[0-9a-fA-F]{64}$/.test(cleanHex)) {
    throw new Error("Invalid AES-256 key hex string: must be exactly 64 hex characters (32 bytes)");
  }
  const matches = cleanHex.match(/.{1,2}/g);
  if (!matches) {
    throw new Error("Invalid hex key format.");
  }
  const bytes = new Uint8Array(
    matches.map((byte) => parseInt(byte, 16))
  );
  return await cryptoObj.subtle.importKey(
    "raw",
    bytes,
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt", "decrypt"]
  );
}

/**
 * Pack IV (12 bytes) and ciphertext into a single binary payload
 * @param {Uint8Array|string} iv 
 * @param {Uint8Array} ciphertext 
 * @returns {Uint8Array}
 */
export function packCiphertextPayload(iv, ciphertext) {
  const ivBytes = typeof iv === "string"
    ? new Uint8Array(iv.replace(/^0x/, "").match(/.{1,2}/g).map((b) => parseInt(b, 16)))
    : iv;
  const payload = new Uint8Array(ivBytes.length + ciphertext.length);
  payload.set(ivBytes, 0);
  payload.set(ciphertext, ivBytes.length);
  return payload;
}

/**
 * Unpack a binary payload into IV (first 12 bytes) and ciphertext
 * @param {Uint8Array} payloadBytes 
 * @returns {{ iv: Uint8Array, ivHex: string, ciphertext: Uint8Array }}
 */
export function unpackCiphertextPayload(payloadBytes) {
  if (!payloadBytes) {
    throw new Error("Invalid ciphertext payload: input is null or undefined");
  }
  const bytes = payloadBytes instanceof Uint8Array
    ? payloadBytes
    : new Uint8Array(payloadBytes);
  if (bytes.length < 28) {
    throw new Error("Invalid ciphertext payload: minimum length is 28 bytes (12 IV + 16 GMAC tag)");
  }
  const iv = bytes.slice(0, 12);
  const ciphertext = bytes.slice(12);
  const ivHex = Array.from(iv).map((b) => b.toString(16).padStart(2, "0")).join("");
  return { iv, ivHex, ciphertext };
}

/**
 * Compute the SHA-256 digest of data as an Ethereum-compatible bytes32 hex string (0x...)
 * @param {Uint8Array|string} data 
 * @returns {Promise<string>} 0x-prefixed 64-hex character string
 */
export async function computeDataHash(data) {
  let bytes;
  if (typeof data === "string") {
    bytes = new TextEncoder().encode(data);
  } else {
    bytes = data;
  }
  const digestBuffer = await cryptoObj.subtle.digest("SHA-256", bytes);
  const hashHex = Array.from(new Uint8Array(digestBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `0x${hashHex}`;
}

/**
 * Verify data integrity against an expected SHA-256 hash (bytes32 hex)
 * @param {Uint8Array|string} data 
 * @param {string} expectedHash 
 * @returns {Promise<boolean>}
 */
export async function verifyDataIntegrity(data, expectedHash) {
  const actualHash = await computeDataHash(data);
  const normExpected = expectedHash.toLowerCase().startsWith("0x")
    ? expectedHash.toLowerCase()
    : `0x${expectedHash.toLowerCase()}`;
  return actualHash.toLowerCase() === normExpected;
}

/**
 * Encrypt a buffer or plaintext string using AES-256-GCM.
 * Computes rawDataHash on the actual CIPHERTEXT PACKAGE (IV || Ciphertext)
 * so downloaded IPFS blobs can be verified BEFORE decryption!
 * @param {Uint8Array|string} data Plaintext genomic data (VCF/FASTQ/PDF bytes)
 * @param {CryptoKey} [key] Optional existing key, otherwise a new one is generated
 * @returns {Promise<{ payload: Uint8Array, ciphertext: Uint8Array, iv: Uint8Array, ivHex: string, keyHex: string, rawDataHash: string, activeKey: CryptoKey }>}
 */
export async function encryptGenomicData(data, key = null) {
  let activeKey = key;
  if (typeof key === "string") {
    activeKey = await importKeyFromHex(key);
  } else if (!activeKey) {
    activeKey = await generateSymmetricKey();
  }
  const iv = cryptoObj.getRandomValues(new Uint8Array(12)); // 96-bit IV for AES-GCM

  let encodedData;
  if (typeof data === "string") {
    encodedData = new TextEncoder().encode(data);
  } else {
    encodedData = data;
  }

  const encryptedBuffer = await cryptoObj.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: iv,
    },
    activeKey,
    encodedData
  );

  const ciphertext = new Uint8Array(encryptedBuffer);
  // Assemble authenticated ciphertext payload: IV (12) || Ciphertext
  const payload = packCiphertextPayload(iv, ciphertext);

  // Compute on-chain integrity hash on the actual ciphertext package (IV || Ciphertext)
  const rawDataHash = await computeDataHash(payload);
  const keyHex = await exportKeyToHex(activeKey);

  return {
    payload: payload,
    ciphertext: ciphertext,
    iv: iv,
    ivHex: Array.from(iv).map((b) => b.toString(16).padStart(2, "0")).join(""),
    keyHex: keyHex,
    rawDataHash: rawDataHash,
    activeKey: activeKey,
  };
}

/**
 * Decrypt ciphertext using AES-256-GCM
 * @param {Uint8Array} ciphertext 
 * @param {Uint8Array|string} iv 
 * @param {CryptoKey|string} key 
 * @param {boolean} [asString=true] Whether to return string or Uint8Array
 * @returns {Promise<string|Uint8Array>}
 */
export async function decryptGenomicData(ciphertext, iv, key, asString = true) {
  let activeKey = key;
  if (typeof key === "string") {
    activeKey = await importKeyFromHex(key);
  }

  let activeIv = iv;
  if (typeof iv === "string") {
    const cleanIv = iv.startsWith("0x") ? iv.slice(2) : iv;
    activeIv = new Uint8Array(
      cleanIv.match(/.{1,2}/g).map((byte) => parseInt(byte, 16))
    );
  }

  const decryptedBuffer = await cryptoObj.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: activeIv,
    },
    activeKey,
    ciphertext
  );

  const decryptedBytes = new Uint8Array(decryptedBuffer);
  if (asString) {
    return new TextDecoder().decode(decryptedBytes);
  }
  return decryptedBytes;
}

/**
 * Decrypt a full ciphertext package (IV || Ciphertext) using AES-256-GCM
 * @param {Uint8Array} payloadBytes 
 * @param {CryptoKey|string} key 
 * @param {boolean} [asString=true] 
 * @returns {Promise<string|Uint8Array>}
 */
export async function decryptGenomicPayload(payloadBytes, key, asString = true) {
  const { iv, ciphertext } = unpackCiphertextPayload(payloadBytes);
  return await decryptGenomicData(ciphertext, iv, key, asString);
}
