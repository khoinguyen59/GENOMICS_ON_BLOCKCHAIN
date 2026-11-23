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

function decodeBase64ToBytes(b64) {
  const clean = b64.replace(/\s+/g, "");
  if (!clean || !/^[A-Za-z0-9+/]+={0,2}$/.test(clean) || clean.length % 4 !== 0) {
    throw new Error("Invalid public key: malformed Base64 SPKI PEM payload.");
  }
  if (typeof atob === "function") {
    const bin = atob(clean);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) {
      out[i] = bin.charCodeAt(i);
    }
    return out;
  }
  if (typeof Buffer !== "undefined") {
    return new Uint8Array(Buffer.from(clean, "base64"));
  }
  throw new Error("Base64 decoding is unavailable in this runtime.");
}

const MIN_RSA_MODULUS_BITS = 2048;

function assertStrongRsaKey(key, role = "public") {
  const bits = Number(key?.algorithm?.modulusLength || 0);
  if (!Number.isFinite(bits) || bits < MIN_RSA_MODULUS_BITS) {
    throw new Error(
      `Weak RSA ${role} key rejected: modulusLength=${bits || "unknown"} bits is below the minimum ${MIN_RSA_MODULUS_BITS}-bit requirement.`
    );
  }
  return key;
}

export function assertStrongRsaPublicKey(pubKey) {
  return assertStrongRsaKey(pubKey, "public");
}

export function assertStrongRsaPrivateKey(privKey) {
  return assertStrongRsaKey(privKey, "private");
}

/**
 * Import an RSA-OAEP (>= 2048-bit) public key from a JWK JSON string/object OR an SPKI PEM string
 * (-----BEGIN PUBLIC KEY-----...-----END PUBLIC KEY-----).
 * @param {string|Object} keyData
 * @returns {Promise<CryptoKey>}
 */
export async function importPublicKey(keyData) {
  if (!keyData) {
    throw new Error("Invalid public key: empty key data.");
  }
  if (typeof keyData === "string") {
    const trimmed = keyData.trim();
    if (trimmed.includes("-----BEGIN PUBLIC KEY-----")) {
      const match = trimmed.match(/^-----BEGIN PUBLIC KEY-----([\s\S]*?)-----END PUBLIC KEY-----$/);
      if (!match || !match[1] || match[1].includes("-----")) {
        throw new Error("Invalid public key: malformed or incomplete SPKI PEM block.");
      }
      const derBytes = decodeBase64ToBytes(match[1]);
      const imported = await cryptoObj.subtle.importKey(
        "spki",
        derBytes,
        {
          name: "RSA-OAEP",
          hash: "SHA-256",
        },
        true,
        ["encrypt"]
      );
      return assertStrongRsaPublicKey(imported);
    }
    let jwk;
    try {
      jwk = JSON.parse(trimmed);
    } catch {
      throw new Error("Invalid public key: expected JWK JSON or SPKI PEM (-----BEGIN PUBLIC KEY-----).");
    }
    if (!jwk || typeof jwk !== "object" || Array.isArray(jwk)) {
      throw new Error("Invalid public key: JWK payload must be a JSON object.");
    }
    const imported = await cryptoObj.subtle.importKey(
      "jwk",
      jwk,
      {
        name: "RSA-OAEP",
        hash: "SHA-256",
      },
      true,
      ["encrypt"]
    );
    return assertStrongRsaPublicKey(imported);
  }
  if (typeof keyData !== "object" || Array.isArray(keyData)) {
    throw new Error("Invalid public key: expected JWK object/JSON string or SPKI PEM string.");
  }
  const imported = await cryptoObj.subtle.importKey(
    "jwk",
    keyData,
    {
      name: "RSA-OAEP",
      hash: "SHA-256",
    },
    true,
    ["encrypt"]
  );
  return assertStrongRsaPublicKey(imported);
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
 * Import an RSA (>= 2048-bit) private key from a JWK JSON string or object
 * @param {string|Object} jwkData
 * @returns {Promise<CryptoKey>}
 */
export async function importPrivateKey(jwkData) {
  if (!jwkData) {
    throw new Error("Invalid private key: empty key data.");
  }
  let jwk = jwkData;
  if (typeof jwkData === "string") {
    try {
      jwk = JSON.parse(jwkData);
    } catch {
      throw new Error("Invalid private key: malformed JWK JSON payload.");
    }
  }
  if (!jwk || typeof jwk !== "object" || Array.isArray(jwk)) {
    throw new Error("Invalid private key: JWK payload must be a JSON object.");
  }
  const imported = await cryptoObj.subtle.importKey(
    "jwk",
    jwk,
    {
      name: "RSA-OAEP",
      hash: "SHA-256",
    },
    false, // import as non-extractable
    ["decrypt"]
  );
  return assertStrongRsaPrivateKey(imported);
}

/**
 * Package an Ephemeral Key Capsule by ACTUALLY encrypting the AES key with the recipient's public key!
 * @param {string|CryptoKey} aesKey Symmetric AES key (hex string or CryptoKey)
 * @param {CryptoKey|string} recipientPublicKey Researcher's RSA-OAEP public key
 * @param {string} recipientAddress Recipient Ethereum wallet address
 * @param {string} dataOwnerAddress Data Owner Ethereum wallet address
 * @param {Object|null} [extraOptions=null] Optional extra keys to encapsulate (e.g., { summaryKeyHex })
 * @returns {Promise<string>} Serialized JSON Capsule containing real asymmetric ciphertext
 */
export async function packageKeyCapsule(
  aesKey,
  recipientPublicKey,
  recipientAddress,
  dataOwnerAddress,
  extraOptions = null
) {
  let pubKey = recipientPublicKey;
  if (
    typeof pubKey === "string" ||
    (pubKey && typeof pubKey === "object" && !pubKey.algorithm && ("kty" in pubKey || "n" in pubKey))
  ) {
    pubKey = await importPublicKey(pubKey);
  } else {
    pubKey = assertStrongRsaPublicKey(pubKey);
  }

  let rawKeyBytes;
  if (typeof aesKey === "string") {
    const cleanHex = aesKey.trim().replace(/^0x/i, "");
    if (!/^[0-9a-fA-F]{64}$/.test(cleanHex)) {
      throw new Error("Invalid AES-256 key hex: raw key length must be exactly 32 bytes (64 hexadecimal characters).");
    }
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

  const modulusBits = Number(pubKey?.algorithm?.modulusLength || MIN_RSA_MODULUS_BITS);
  const payload = {
    version: "GENO-ASYM-RSA-OAEP-v2",
    algorithm: `RSA-OAEP-${modulusBits}/SHA-256`,
    owner: dataOwnerAddress,
    recipient: recipientAddress,
    keyCipher: keyCipherHex, // Real ciphertext, NOT plaintext key!
    timestamp: Date.now(),
  };

  if (extraOptions && typeof extraOptions.summaryKeyHex === "string" && extraOptions.summaryKeyHex.trim().length > 0) {
    const cleanSummaryHex = extraOptions.summaryKeyHex.trim().replace(/^0x/i, "");
    if (!/^[0-9a-fA-F]{64}$/.test(cleanSummaryHex)) {
      throw new Error("Invalid summary AES key: summaryKeyHex must be exactly 64 hex characters (256 bits).");
    }
    const summaryKeyBytes = new Uint8Array(
      cleanSummaryHex.match(/.{1,2}/g).map((byte) => parseInt(byte, 16))
    );
    const encSummaryBuf = await cryptoObj.subtle.encrypt(
      { name: "RSA-OAEP" },
      pubKey,
      summaryKeyBytes
    );
    payload.summaryKeyCipher = Array.from(new Uint8Array(encSummaryBuf))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }

  return JSON.stringify(payload);
}

/**
 * Decrypt an Ephemeral Key Capsule using the recipient's RSA-OAEP private key
 * (Works seamlessly with non-extractable private CryptoKey!)
 * @param {string|Object} capsuleJson Capsule JSON string or object
 * @param {CryptoKey|string} recipientPrivateKey Researcher's private key
 * @returns {Promise<{ keyHex: string, activeKey: CryptoKey, summaryKeyHex: string|null }>}
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
  if (
    typeof privKey === "string" ||
    (privKey && typeof privKey === "object" && !privKey.algorithm && ("kty" in privKey || "d" in privKey || "n" in privKey))
  ) {
    privKey = await importPrivateKey(privKey);
  } else {
    privKey = assertStrongRsaPrivateKey(privKey);
  }

  const cleanHex = capsule.keyCipher.trim().replace(/^0x/i, "");
  if (
    cleanHex.length < 512 ||
    cleanHex.length % 2 !== 0 ||
    !/^[0-9a-fA-F]+$/.test(cleanHex) ||
    /^0+$/.test(cleanHex)
  ) {
    throw new Error("Invalid key capsule: keyCipher must be exactly 512 hex characters for RSA-2048 modulus (or >= 512 non-zero even hex chars per RFC 8017 PKCS #1 v2.2).");
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

  let summaryKeyHex = null;
  if (
    capsule.summaryKeyCipher !== undefined &&
    capsule.summaryKeyCipher !== null &&
    capsule.summaryKeyCipher !== ""
  ) {
    if (typeof capsule.summaryKeyCipher !== "string") {
      throw new Error("Invalid key capsule: summaryKeyCipher must be a valid hex string.");
    }
    const cleanSumHex = capsule.summaryKeyCipher.trim().replace(/^0x/i, "");
    if (
      cleanSumHex.length < 512 ||
      cleanSumHex.length % 2 !== 0 ||
      !/^[0-9a-fA-F]+$/.test(cleanSumHex) ||
      /^0+$/.test(cleanSumHex)
    ) {
      throw new Error(
        "Invalid key capsule: summaryKeyCipher must be valid non-zero RSA-OAEP hex ciphertext (>= 512 hex chars)."
      );
    }
    const sumMatches = cleanSumHex.match(/.{1,2}/g);
    const sumCipherBytes = new Uint8Array(sumMatches.map((byte) => parseInt(byte, 16)));
    const decryptedSummaryBuf = await cryptoObj.subtle.decrypt(
      { name: "RSA-OAEP" },
      privKey,
      sumCipherBytes
    );
    summaryKeyHex = Array.from(new Uint8Array(decryptedSummaryBuf))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    if (!/^[0-9a-fA-F]{64}$/.test(summaryKeyHex)) {
      throw new Error(
        `Invalid key capsule: decrypted summaryKeyCipher must be 32 bytes (64 hex chars), got ${summaryKeyHex.length / 2} bytes.`
      );
    }
  }

  const activeKey = await importKeyFromHex(keyHex);
  return { keyHex, activeKey, summaryKeyHex };
}