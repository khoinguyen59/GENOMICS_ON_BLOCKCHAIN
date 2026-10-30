/**
 * @file asymmetric.js
 * @description RFC 8017 / RSA-OAEP 2048-bit asymmetric keypair generation, JWK serialization, and key encapsulation.
 * @module crypto/core/asymmetric
 */

import { importKeyFromHex } from "./symmetric.js";

const cryptoObj =
  typeof window !== "undefined" && window.crypto
    ? window.crypto
    : globalThis.crypto;

if (!cryptoObj || !cryptoObj.subtle) {
  throw new Error("Web Crypto API (crypto.subtle) is required but not available in this environment.");
}

/**
 * Generate an RSA-OAEP 2048-bit asymmetric keypair for Researcher access control
 * By default, private key is NON-EXTRACTABLE for maximum browser security!
 * @param {boolean} [isExtractable=false] Whether private key can be exported
 * @returns {Promise<CryptoKeyPair>}
 */
export async function generateAsymmetricKeyPair(isExtractable = false) {
  return await cryptoObj.subtle.generateKey(
    {
      name: "RSA-OAEP",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]), // 65537
      hash: "SHA-256",
    },
    isExtractable, // privateKey extractability: false by default!
    ["encrypt", "decrypt"]
  );
}

/**
 * Export an RSA public key to JSON Web Key (JWK) string
 * Note: publicKey is always extractable per W3C specification!
 * @param {CryptoKey} publicKey 
 * @returns {Promise<string>} JSON string representation of JWK
 */
export async function exportPublicKey(publicKey) {
  const jwk = await cryptoObj.subtle.exportKey("jwk", publicKey);
  return JSON.stringify(jwk);
}

/**
 * Import an RSA public key from a JWK JSON string
 * @param {string|Object} jwkData 
 * @returns {Promise<CryptoKey>}
 */
export async function importPublicKey(jwkData) {
  const jwk = typeof jwkData === "string" ? JSON.parse(jwkData) : jwkData;
  return await cryptoObj.subtle.importKey(
    "jwk",
    jwk,
    {
      name: "RSA-OAEP",
      hash: "SHA-256",
    },
    true,
    ["encrypt"]
  );
}

/**
 * Export an RSA private key to JSON Web Key (JWK) string (only works if key is extractable)
 * @param {CryptoKey} privateKey 
 * @returns {Promise<string>}
 */
export async function exportPrivateKey(privateKey) {
  const jwk = await cryptoObj.subtle.exportKey("jwk", privateKey);
  return JSON.stringify(jwk);
}

/**
 * Import an RSA private key from a JWK JSON string
 * @param {string|Object} jwkData 
 * @returns {Promise<CryptoKey>}
 */
export async function importPrivateKey(jwkData) {
  const jwk = typeof jwkData === "string" ? JSON.parse(jwkData) : jwkData;
  return await cryptoObj.subtle.importKey(
    "jwk",
    jwk,
    {
      name: "RSA-OAEP",
      hash: "SHA-256",
    },
    false, // import as non-extractable
    ["decrypt"]
  );
}

/**
 * Package an Ephemeral Key Capsule by ACTUALLY encrypting the AES key with the recipient's public key!
 * @param {string|CryptoKey} aesKey Symmetric AES key (hex string or CryptoKey)
 * @param {CryptoKey|string} recipientPublicKey Researcher's RSA-OAEP public key
 * @param {string} recipientAddress Recipient Ethereum wallet address
 * @param {string} dataOwnerAddress Data Owner Ethereum wallet address
 * @returns {Promise<string>} Serialized JSON Capsule containing real asymmetric ciphertext
 */
export async function packageKeyCapsule(aesKey, recipientPublicKey, recipientAddress, dataOwnerAddress) {
  let pubKey = recipientPublicKey;
  if (typeof pubKey === "string") {
    pubKey = await importPublicKey(pubKey);
  }

  let rawKeyBytes;
  if (typeof aesKey === "string") {
    const cleanHex = aesKey.startsWith("0x") ? aesKey.slice(2) : aesKey;
    rawKeyBytes = new Uint8Array(
      cleanHex.match(/.{1,2}/g).map((byte) => parseInt(byte, 16))
    );
  } else if (aesKey instanceof Uint8Array || (aesKey && aesKey.buffer instanceof ArrayBuffer && typeof aesKey.byteLength === "number")) {
    rawKeyBytes = new Uint8Array(aesKey.buffer, aesKey.byteOffset, aesKey.byteLength);
  } else if (aesKey instanceof ArrayBuffer) {
    rawKeyBytes = new Uint8Array(aesKey);
  } else if (aesKey && typeof aesKey === "object" && aesKey.type === "secret") {
    const rawBuffer = await cryptoObj.subtle.exportKey("raw", aesKey);
    rawKeyBytes = new Uint8Array(rawBuffer);
  } else {
    try {
      const rawBuffer = await cryptoObj.subtle.exportKey("raw", aesKey);
      rawKeyBytes = new Uint8Array(rawBuffer);
    } catch {
      rawKeyBytes = new Uint8Array(aesKey);
    }
  }

  if (rawKeyBytes.length !== 32) {
    throw new Error(`Invalid AES key: raw key length must be exactly 32 bytes (256 bits), got ${rawKeyBytes.length}`);
  }

  // Real Asymmetric Encryption of the 32-byte AES key using RSA-OAEP
  const encryptedKeyBuffer = await cryptoObj.subtle.encrypt(
    { name: "RSA-OAEP" },
    pubKey,
    rawKeyBytes
  );

  const keyCipherHex = Array.from(new Uint8Array(encryptedKeyBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  const payload = {
    version: "GENO-ASYM-RSA-OAEP-v2",
    algorithm: "RSA-OAEP-2048/SHA-256",
    owner: dataOwnerAddress,
    recipient: recipientAddress,
    keyCipher: keyCipherHex, // Real ciphertext, NOT plaintext key!
    timestamp: Date.now(),
  };

  return JSON.stringify(payload);
}

/**
 * Decrypt an Ephemeral Key Capsule using the recipient's RSA-OAEP private key
 * (Works seamlessly with non-extractable private CryptoKey!)
 * @param {string|Object} capsuleJson Capsule JSON string or object
 * @param {CryptoKey|string} recipientPrivateKey Researcher's private key
 * @returns {Promise<{ keyHex: string, activeKey: CryptoKey }>}
 */
export async function decryptKeyCapsule(capsuleJson, recipientPrivateKey) {
  if (!capsuleJson) {
    throw new Error("Invalid key capsule: empty capsule payload.");
  }
  let capsule;
  try {
    capsule = typeof capsuleJson === "string" ? JSON.parse(capsuleJson) : capsuleJson;
  } catch {
    throw new Error("Invalid key capsule: malformed JSON format.");
  }

  if (!capsule || !capsule.keyCipher || typeof capsule.keyCipher !== "string") {
    throw new Error("Invalid key capsule: missing or invalid keyCipher field.");
  }

  let privKey = recipientPrivateKey;
  if (typeof privKey === "string") {
    privKey = await importPrivateKey(privKey);
  }

  const cleanHex = capsule.keyCipher.startsWith("0x") ? capsule.keyCipher.slice(2) : capsule.keyCipher;
  if (cleanHex.length !== 512 || !/^[0-9a-fA-F]{512}$/.test(cleanHex)) {
    throw new Error("Invalid key capsule: keyCipher must be exactly 512 hex characters (256 bytes) for RSA-2048 modulus (RFC 8017 PKCS #1 v2.2).");
  }

  const matches = cleanHex.match(/.{1,2}/g);
  if (!matches) {
    throw new Error("Invalid key capsule: keyCipher is empty or not valid hex.");
  }

  const cipherBytes = new Uint8Array(
    matches.map((byte) => parseInt(byte, 16))
  );

  // Decrypt ciphertext using recipient's private key
  const decryptedRawBuffer = await cryptoObj.subtle.decrypt(
    { name: "RSA-OAEP" },
    privKey,
    cipherBytes
  );

  const keyHex = Array.from(new Uint8Array(decryptedRawBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  const activeKey = await importKeyFromHex(keyHex);
  return { keyHex, activeKey };
}
