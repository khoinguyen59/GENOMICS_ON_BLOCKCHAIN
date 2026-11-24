/**
 * @file pinata_uploader.js
 * @description Master Dual-Engine IPFS Facade (Pinata Cloud API + Local Kubo Daemon).
 *              Re-exports multihash calculation, Pinata, and Kubo client operations.
 */

import {
  base58Encode,
  base32Encode,
  blake2bDigest,
  encodeUnixFsFileNode,
  computeRawDigestByMultihash,
  computeMultihashBytes,
  computeIpfsCidV0,
  computeIpfsCidV1,
  computeIpfsCidV1DagPbRawLeavesDigestHex,
  computeIpfsCidV1DagPbUnixFsLeavesDigestHex,
  calculateFileCID,
  BASE58_ALPHABET,
  MULTIHASH_SHA2_256,
  MULTIHASH_SHA2_512,
  MULTIHASH_BLAKE2B_256,
} from "./multihash.js";
import { getPinataJwt, setPinataJwt, pinFileToPinata, pinJsonToPinata } from "./pinata_client.js";
import {
  normalizeKuboEndpoint,
  parseCidV1Components,
  extractSha256MultihashHex,
  getExplicitKuboRpcEndpoint,
  getExplicitKuboGatewayEndpoint,
  getKuboRpcEndpoint,
  setKuboRpcEndpoint,
  getKuboGatewayEndpoint,
  setKuboGatewayEndpoint,
  buildSiweGatewayHeaders,
  uploadToPrivateGateway,
  pinFileToKubo,
  pinJsonToKubo,
  fetchFromKuboGateway,
  isPrivateIpfsGatewayConfigured,
  isNonLocalConfiguredChain,
} from "./kubo_client.js";

export {
  base58Encode,
  base32Encode,
  blake2bDigest,
  encodeUnixFsFileNode,
  computeRawDigestByMultihash,
  computeMultihashBytes,
  computeIpfsCidV0,
  computeIpfsCidV1,
  computeIpfsCidV1DagPbRawLeavesDigestHex,
  computeIpfsCidV1DagPbUnixFsLeavesDigestHex,
  calculateFileCID,
  BASE58_ALPHABET,
  MULTIHASH_SHA2_256,
  MULTIHASH_SHA2_512,
  MULTIHASH_BLAKE2B_256,
  getPinataJwt, setPinataJwt, pinFileToPinata, pinJsonToPinata,
  normalizeKuboEndpoint, parseCidV1Components, extractSha256MultihashHex,
  getExplicitKuboRpcEndpoint, getExplicitKuboGatewayEndpoint,
  getKuboRpcEndpoint, setKuboRpcEndpoint, getKuboGatewayEndpoint, setKuboGatewayEndpoint,
  buildSiweGatewayHeaders, uploadToPrivateGateway,
  pinFileToKubo, pinJsonToKubo, fetchFromKuboGateway, isPrivateIpfsGatewayConfigured, isNonLocalConfiguredChain
};

// Strictly bounded in-memory LRU storage cache (max 50 entries)
const MAX_LOCAL_IPFS_CACHE_ENTRIES = 50;
const localIpfsStorage = new Map();

/**
 * Cache IPFS content locally with strict LRU eviction policy to prevent memory exhaustion
 * @param {string} cid 
 * @param {Uint8Array} bytes 
 * @param {string} [mimeType="application/octet-stream"] 
 */
export function cacheLocalIpfsContent(cid, bytes, mimeType = "application/octet-stream") {
  if (!cid) return;
  // If already present, remove first so re-insertion places it at MRU position
  if (localIpfsStorage.has(cid)) {
    localIpfsStorage.delete(cid);
  } else if (localIpfsStorage.size >= MAX_LOCAL_IPFS_CACHE_ENTRIES) {
    // Evict oldest LRU entry (first key in Map iterator)
    const oldestKey = localIpfsStorage.keys().next().value;
    if (oldestKey !== undefined) {
      localIpfsStorage.delete(oldestKey);
    }
  }
  localIpfsStorage.set(cid, {
    bytes,
    mimeType,
    size: bytes ? (bytes.length || bytes.byteLength || 0) : 0,
    timestamp: new Date().toISOString()
  });
}

/**
 * Retrieve cached IPFS content and refresh its LRU position
 * @param {string} cid 
 * @returns {Uint8Array|null}
 */
export function getLocalIpfsContent(cid) {
  if (!cid || !localIpfsStorage.has(cid)) return null;
  const item = localIpfsStorage.get(cid);
  // Refresh LRU order on access
  localIpfsStorage.delete(cid);
  localIpfsStorage.set(cid, item);
  return item ? item.bytes : null;
}

/**
 * Evict a single CID from the in-memory catalog LRU cache (e.g. on SHA-256 tamper detection)
 * @param {string} cid
 */
export function evictLocalIpfsContent(cid) {
  if (cid) localIpfsStorage.delete(cid);
}

/**
 * Clear local IPFS cache (for testing and memory cleanup)
 */
export function clearLocalIpfsCache() {
  localIpfsStorage.clear();
}

/**
 * Get current count of cached items
 * @returns {number}
 */
export function getLocalIpfsCacheSize() {
  return localIpfsStorage.size;
}

async function pinBytesToIpfsNetwork(fileBytes, fileName, mimeType, customJwt = null, uploadOptions = null) {
  // Strictly fail-closed routing precedence: when a Private IPFS Gateway is configured,
  // route FIRST and EXCLUSIVELY through the SIWE-authenticated Private IPFS Gateway
  // (NEVER leak encrypted payloads to Pinata Cloud or fall back to unauthenticated Kubo RPC).
  if (isPrivateIpfsGatewayConfigured(uploadOptions?.customGateway || null)) {
    const gatewayRes = await uploadToPrivateGateway(fileBytes, fileName, mimeType, uploadOptions || {});
    if (gatewayRes) return gatewayRes;
    const privateErr = new Error(
      "Private IPFS Gateway upload failed; Pinata Cloud and unauthenticated Kubo RPC fallbacks are strictly disabled."
    );
    privateErr.privateGatewayFailClosed = true;
    throw privateErr;
  }

  const pinataRes = await pinFileToPinata(fileBytes, fileName, mimeType, customJwt);
  if (pinataRes) return pinataRes;

  const gatewayRes = await uploadToPrivateGateway(fileBytes, fileName, mimeType, uploadOptions || {});
  if (gatewayRes) return gatewayRes;

  const kuboRes = await pinFileToKubo(fileBytes, fileName, mimeType);
  if (kuboRes) return kuboRes;

  const kuboRpc = getKuboRpcEndpoint() || getKuboGatewayEndpoint();
  throw new Error(
    `IPFS connection error (Lỗi kết nối IPFS): Unable to upload encrypted payload to decentralized storage. Pinata Cloud API, Private IPFS Gateway, and Local Kubo Daemon (${kuboRpc}) are unavailable. Configure a Private IPFS Gateway, Pinata JWT, or start a local Kubo daemon before submitting a transaction.`
  );
}

export async function uploadEncryptedRawData(encryptedBytes, originalFileName, pinataJwt = null, uploadOptions = null) {
  const baseName = String(originalFileName || "payload").trim() || "payload";
  const safeName = baseName.endsWith(".enc") ? baseName : `${baseName}.enc`;
  const { cid, pinnedOn } = await pinBytesToIpfsNetwork(encryptedBytes, safeName, "application/octet-stream", pinataJwt, uploadOptions);
  return { cid, size: encryptedBytes.length, pinnedOn, timestamp: new Date().toISOString() };
}

export async function uploadEncryptedSummaryReport(encryptedPdfBytes, originalFileName, pinataJwt = null, uploadOptions = null) {
  const baseName = String(originalFileName || "report").trim() || "report";
  const safeName = baseName.endsWith(".enc") ? baseName : `${baseName}.enc`;
  const { cid, pinnedOn } = await pinBytesToIpfsNetwork(encryptedPdfBytes, safeName, "application/pdf", pinataJwt, uploadOptions);
  return { cid, size: encryptedPdfBytes.length, pinnedOn };
}

export async function uploadPhenopacketMetadata(phenopacketJson, pinataJwt = null, uploadOptions = null) {
  const name = `phenopacket_${phenopacketJson.id || "meta"}.json`;
  const jsonString = typeof phenopacketJson === "string" ? phenopacketJson : JSON.stringify(phenopacketJson, null, 2);

  // Strictly fail-closed routing precedence: when a Private IPFS Gateway is configured,
  // route FIRST and EXCLUSIVELY to Private IPFS Gateway (zero Pinata Cloud / raw Kubo leak).
  if (isPrivateIpfsGatewayConfigured(uploadOptions?.customGateway || null)) {
    const jsonBytes = new TextEncoder().encode(jsonString);
    const gwRes = await uploadToPrivateGateway(jsonBytes, name, "application/json", uploadOptions || {});
    if (gwRes) {
      return { cid: gwRes.cid, json: phenopacketJson, pinnedOn: gwRes.pinnedOn };
    }
    const privateErr = new Error(
      "Private IPFS Gateway Phenopacket metadata upload failed; Pinata Cloud and unauthenticated Kubo RPC fallbacks are strictly disabled."
    );
    privateErr.privateGatewayFailClosed = true;
    throw privateErr;
  }

  let res = await pinJsonToPinata(phenopacketJson, name, pinataJwt);
  if (!res) {
    const jsonBytes = new TextEncoder().encode(jsonString);
    res = await uploadToPrivateGateway(jsonBytes, name, "application/json", uploadOptions || {});
  }
  if (!res) res = await pinJsonToKubo(phenopacketJson, name);

  if (res) {
    return { cid: res.cid, json: phenopacketJson, pinnedOn: res.pinnedOn };
  }

  const kuboRpc = getKuboRpcEndpoint() || getKuboGatewayEndpoint();
  throw new Error(
    `IPFS connection error (Lỗi kết nối IPFS): Unable to upload Phenopacket metadata to decentralized storage. Pinata Cloud API, Private IPFS Gateway, and Local Kubo Daemon (${kuboRpc}) are unavailable. Configure a Private IPFS Gateway, Pinata JWT, or start a local Kubo daemon before submitting a transaction.`
  );
}

function isHtmlGatewayResponse(res, bytes = null) {
  const ct = (res?.headers?.get?.("content-type") || "").toLowerCase();
  if (ct.includes("text/html")) return true;
  if (bytes && bytes.length > 0) {
    const head = new TextDecoder("utf-8", { fatal: false })
      .decode(bytes.subarray(0, 64))
      .trimStart()
      .toLowerCase();
    if (head.startsWith("<!doctype html") || head.startsWith("<html")) return true;
  }
  return false;
}

export async function retrieveFromIpfs(cid, gatewayUrl = "https://gateway.pinata.cloud/ipfs", options = {}) {
  const fastCatalog = Boolean(options?.fastCatalog);
  const bypassCache = Boolean(options?.bypassCache);
  const fastTimeoutMs = Number(options?.timeoutMs) > 0 ? Number(options.timeoutMs) : 3500;
  const payloadTimeoutMs = Number(options?.timeoutMs) > 0 ? Number(options.timeoutMs) : 60_000;

  // Only allow short-circuiting to bounded RAM LRU cache for fast catalog metadata renders
  // after content was already verified from a live IPFS backend; decryption & verification
  // paths always hit Kubo / IPFS gateways so missing/unpinned CIDs are never masked.
  if (fastCatalog && !bypassCache) {
    const localBytes = getLocalIpfsContent(cid);
    if (localBytes) return localBytes;
  }

  const kuboBytes = await fetchFromKuboGateway(cid, options?.customGateway || null, {
    fastOffline: fastCatalog,
    timeoutMs: fastCatalog ? fastTimeoutMs : payloadTimeoutMs,
    signer: options?.signer,
    account: options?.account,
    address: options?.address,
    dataId: options?.dataId,
    chainId: options?.chainId,
    registryAddress: options?.registryAddress,
    headers: options?.headers,
  });
  if (kuboBytes) {
    if (fastCatalog) cacheLocalIpfsContent(cid, kuboBytes);
    return kuboBytes;
  }

  // Strictly fail-closed when a Private IPFS Gateway is explicitly configured: NEVER leak
  // private or revoked CIDs (or client IPs) to public third-party gateways (Pinata/dweb/ipfs.io/w3s).
  if (isPrivateIpfsGatewayConfigured(options?.customGateway || null)) {
    const privateErr = new Error(
      `Private IPFS Gateway did not return CID ${cid}; public-gateway fallback is strictly disabled.`
    );
    privateErr.privateGatewayFailClosed = true;
    throw privateErr;
  }

  // Teamwork L3-F3: On non-local builds (__GENOCHAIN_NON_LOCAL_CHAIN__ or VITE_CHAIN_ID != 31337)
  // when VITE_KUBO_GATEWAY is omitted, fail closed on private/ciphertext fetches (and non-opted-in
  // fetches) so private CIDs NEVER leak to public third-party gateways (pinata.cloud/dweb.link/ipfs.io/w3s.link).
  if (isNonLocalConfiguredChain()) {
    const isPublicMetadataOptIn =
      Boolean(options?.allowPublicGatewayFallback) &&
      Boolean(fastCatalog) &&
      !options?.privatePayload &&
      (options?.dataId === undefined || options?.dataId === null) &&
      !options?.signer;
    if (!isPublicMetadataOptIn) {
      const nonLocalErr = new Error(
        `Non-local build requires a configured Private IPFS Gateway (VITE_KUBO_GATEWAY) for CID ${cid}; public-gateway fallback is strictly disabled.`
      );
      nonLocalErr.privateGatewayFailClosed = true;
      throw nonLocalErr;
    }
  }

  const encodedCid = encodeURIComponent(cid);

  if (fastCatalog) {
    if (typeof fetch !== "undefined") {
      try {
        const res = await fetch(`${gatewayUrl}/${encodedCid}`, { signal: AbortSignal.timeout(fastTimeoutMs) });
        if (res.ok && !isHtmlGatewayResponse(res)) {
          const bytes = new Uint8Array(await res.arrayBuffer());
          if (!isHtmlGatewayResponse(res, bytes)) {
            cacheLocalIpfsContent(cid, bytes);
            return bytes;
          }
        }
      } catch (_) {}
    }
    throw new Error(`Metadata CID ${cid} not available on IPFS Kubo/Pinata gateway.`);
  }

  if (typeof fetch !== "undefined") {
    const urls = [
      `${gatewayUrl}/${encodedCid}`,
      `https://dweb.link/ipfs/${encodedCid}`,
      `https://ipfs.io/ipfs/${encodedCid}`,
      `https://w3s.link/ipfs/${encodedCid}`,
    ];
    for (const url of urls) {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(payloadTimeoutMs) });
        if (res.ok && !isHtmlGatewayResponse(res)) {
          const bytes = new Uint8Array(await res.arrayBuffer());
          if (!isHtmlGatewayResponse(res, bytes)) {
            return bytes;
          }
        }
      } catch (_) {}
    }
  }

  throw new Error(`Unable to retrieve CID ${cid} from live IPFS Kubo node or public gateways.`);
}

async function computeDigestHex(data, algorithm = "SHA-256") {
  const bytes =
    data instanceof Uint8Array
      ? data
      : data instanceof ArrayBuffer
        ? new Uint8Array(data)
        : typeof data === "string"
          ? new TextEncoder().encode(data)
          : new Uint8Array(data);
  const digestBuf = await globalThis.crypto.subtle.digest(algorithm, bytes);
  return Array.from(new Uint8Array(digestBuf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function isSupportedCidV1Multihash(mhCode, mhLen) {
  return (
    (mhCode === MULTIHASH_SHA2_256 && mhLen === 32) ||
    (mhCode === MULTIHASH_SHA2_512 && mhLen === 64) ||
    (mhCode === MULTIHASH_BLAKE2B_256 && mhLen === 32)
  );
}

function toBlobBytes(data) {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (typeof data === "string") return new TextEncoder().encode(data);
  return new Uint8Array(data || 0);
}

/**
 * Validate strict canonical IPLD DAG-CBOR (RFC 8949 deterministic subset + IPLD strictness) integrity:
 * - Exactly one complete top-level CBOR item consuming 100% of `bytes`, no indefinite lengths, no trailing garbage.
 * - Minimal-length integer encoding for all argument lengths/values.
 * - Only CBOR tag 42 (CID link) permitted, strictly wrapping a major type 2 byte string.
 * - Reject float16 (ai=25), float32 (ai=26), NaN, +Infinity, -Infinity, and undefined/unassigned simple values.
 * - Strict UTF-8 validation on text strings and canonical IPLD map key ordering (byte-length first, then bytewise
 *   lexicographical) with zero duplicate keys.
 */
export function isValidDagCborBlock(data) {
  const bytes = toBlobBytes(data);
  if (bytes.length === 0) return false;
  const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

  const readArg = (pos, ai, allowBigInt = false) => {
    if (ai < 24) return { val: ai, next: pos };
    if (ai === 24) {
      if (pos + 1 > bytes.length) return null;
      const val = bytes[pos];
      if (val < 24) return null;
      return { val, next: pos + 1 };
    }
    if (ai === 25) {
      if (pos + 2 > bytes.length) return null;
      const val = (bytes[pos] << 8) | bytes[pos + 1];
      if (val < 0x100) return null;
      return { val, next: pos + 2 };
    }
    if (ai === 26) {
      if (pos + 4 > bytes.length) return null;
      const val =
        bytes[pos] * 0x1000000 + ((bytes[pos + 1] << 16) | (bytes[pos + 2] << 8) | bytes[pos + 3]);
      if (val < 0x10000) return null;
      return { val, next: pos + 4 };
    }
    if (ai === 27) {
      if (pos + 8 > bytes.length) return null;
      const hi = BigInt(
        bytes[pos] * 0x1000000 + ((bytes[pos + 1] << 16) | (bytes[pos + 2] << 8) | bytes[pos + 3])
      );
      const lo = BigInt(
        bytes[pos + 4] * 0x1000000 + ((bytes[pos + 5] << 16) | (bytes[pos + 6] << 8) | bytes[pos + 7])
      );
      const bigVal = (hi << 32n) | lo;
      if (bigVal < 0x100000000n) return null;
      if (allowBigInt) {
        return { val: bigVal, next: pos + 8 };
      }
      const val = Number(bigVal);
      if (!Number.isSafeInteger(val)) return null;
      return { val, next: pos + 8 };
    }
    return null;
  };

  const compareCanonicalKeys = (prev, curr) => {
    if (prev.length !== curr.length) return curr.length - prev.length;
    for (let i = 0; i < prev.length; i++) {
      if (prev[i] !== curr[i]) return curr[i] - prev[i];
    }
    return 0;
  };

  const readMinimalUvarint = (buf, offset) => {
    let val = 0;
    let shift = 0;
    let pos = offset;
    while (pos < buf.length && shift <= 49) {
      const b = buf[pos++];
      if (b === 0 && shift > 0) return null; // Non-minimal overlong varint
      val += (b & 0x7f) * (2 ** shift);
      if ((b & 0x80) === 0) {
        return Number.isSafeInteger(val) ? { val, next: pos } : null;
      }
      shift += 7;
    }
    return null;
  };

  const isValidTag42CidLink = (linkBytes) => {
    // IPLD DAG-CBOR Tag 42 requires leading 0x00 identity multibase prefix followed by a valid binary CID
    if (linkBytes.length < 2 || linkBytes[0] !== 0x00) return false;
    const cid = linkBytes.subarray(1);
    // CIDv0: raw SHA2-256 multihash (0x12 0x20 || 32-byte digest)
    if (cid.length === 34 && cid[0] === 0x12 && cid[1] === 0x20) return true;
    // CIDv1: version 0x01 || uvarint(codec) || uvarint(mhCode) || uvarint(mhLen) || digest[mhLen]
    if (cid[0] !== 0x01) return false;
    const codec = readMinimalUvarint(cid, 1);
    if (!codec) return false;
    const mhCode = readMinimalUvarint(cid, codec.next);
    if (!mhCode) return false;
    const mhLen = readMinimalUvarint(cid, mhCode.next);
    if (!mhLen) return false;
    if (mhLen.val === 0 && mhCode.val !== 0x00) return false;
    return mhLen.next + mhLen.val === cid.length;
  };

  const parseItem = (pos, depth) => {
    if (depth > 64 || pos >= bytes.length) return -1;
    const initial = bytes[pos++];
    const major = initial >>> 5;
    const ai = initial & 0x1f;

    if (major === 0 || major === 1) {
      const arg = readArg(pos, ai, true);
      return arg ? arg.next : -1;
    }
    if (major === 2) {
      const arg = readArg(pos, ai);
      if (!arg || arg.next + arg.val > bytes.length) return -1;
      return arg.next + arg.val;
    }
    if (major === 3) {
      const arg = readArg(pos, ai);
      if (!arg || arg.next + arg.val > bytes.length) return -1;
      try {
        utf8Decoder.decode(bytes.subarray(arg.next, arg.next + arg.val));
      } catch {
        return -1;
      }
      return arg.next + arg.val;
    }
    if (major === 4) {
      const arg = readArg(pos, ai);
      if (!arg || arg.val > bytes.length) return -1;
      let cur = arg.next;
      for (let i = 0; i < arg.val; i++) {
        cur = parseItem(cur, depth + 1);
        if (cur < 0) return -1;
      }
      return cur;
    }
    if (major === 5) {
      const arg = readArg(pos, ai);
      if (!arg || arg.val > bytes.length) return -1;
      let cur = arg.next;
      let prevKeyBytes = null;
      for (let i = 0; i < arg.val; i++) {
        if (cur >= bytes.length || (bytes[cur] >>> 5) !== 3) return -1; // DAG-CBOR map keys must be text strings
        const keyAi = bytes[cur] & 0x1f;
        const keyArg = readArg(cur + 1, keyAi);
        if (!keyArg || keyArg.next + keyArg.val > bytes.length) return -1;
        const keyBytes = bytes.subarray(keyArg.next, keyArg.next + keyArg.val);
        try {
          utf8Decoder.decode(keyBytes);
        } catch {
          return -1;
        }
        if (prevKeyBytes !== null && compareCanonicalKeys(prevKeyBytes, keyBytes) <= 0) {
          return -1; // Duplicate or non-canonical IPLD map key ordering
        }
        prevKeyBytes = keyBytes;
        cur = keyArg.next + keyArg.val;
        cur = parseItem(cur, depth + 1);
        if (cur < 0) return -1;
      }
      return cur;
    }
    if (major === 6) {
      const arg = readArg(pos, ai);
      if (!arg || arg.val !== 42) return -1; // IPLD DAG-CBOR allows ONLY tag 42 (CID link)
      if (arg.next >= bytes.length || (bytes[arg.next] >>> 5) !== 2) return -1; // Tag 42 must wrap major 2 byte string
      const linkAi = bytes[arg.next] & 0x1f;
      const linkArg = readArg(arg.next + 1, linkAi);
      if (!linkArg || linkArg.next + linkArg.val > bytes.length) return -1;
      const linkBytes = bytes.subarray(linkArg.next, linkArg.next + linkArg.val);
      if (!isValidTag42CidLink(linkBytes)) return -1; // Enforce 0x00 multibase prefix + valid binary CIDv0/CIDv1
      return linkArg.next + linkArg.val;
    }
    if (major === 7) {
      if (ai === 20 || ai === 21 || ai === 22) return pos; // false, true, null
      if (ai === 27 && pos + 8 <= bytes.length) {
        const view = new DataView(bytes.buffer, bytes.byteOffset + pos, 8);
        const f64 = view.getFloat64(0, false);
        if (!Number.isFinite(f64)) return -1; // Reject NaN, +Infinity, -Infinity
        return pos + 8;
      }
      return -1; // Reject float16 (ai=25), float32 (ai=26), undefined/unassigned simple values
    }
    return -1;
  };

  return parseItem(0, 0) === bytes.length;
}

async function computeDigestHexByMhCode(data, mhCode) {
  const digest = await computeRawDigestByMultihash(data, mhCode);
  return Array.from(digest)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Verify CID integrity for CIDv0 (Qm...) and Base32 CIDv1 across 100% of contract-accepted
 * codecs (`raw` 0x55, `dag-pb` 0x70, `dag-cbor` 0x71) and multihashes (`SHA2-256` 0x12,
 * `SHA2-512` 0x13, `BLAKE2b-256` 0xb220). Fails closed on any mismatch or unsupported format.
 * @param {string} summaryCid
 * @param {Uint8Array|ArrayBuffer|string} downloadedBlob
 * @param {string|null} [computedHashHex=null]
 * @returns {Promise<boolean>}
 */
export async function verifySummaryCidIntegrity(summaryCid, downloadedBlob, computedHashHex = null) {
  const cid = typeof summaryCid === "string" ? summaryCid.trim() : "";
  if (!cid) {
    throw new Error("Cryptographic tamper detected: Missing or empty summary CID!");
  }
  const actualSha256Hex = await computeDigestHex(downloadedBlob, "SHA-256");
  if (computedHashHex !== null && computedHashHex !== undefined && String(computedHashHex).trim() !== "") {
    const providedHex = String(computedHashHex).trim().replace(/^0x/i, "").toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(providedHex) || providedHex !== actualSha256Hex) {
      throw new Error("Cryptographic tamper detected: Provided summary hash does not match downloaded payload!");
    }
  }
  if (cid.startsWith("Qm")) {
    const computedCid = await computeIpfsCidV0(downloadedBlob);
    if (computedCid !== cid) {
      throw new Error("Cryptographic tamper detected: Downloaded summary CID does not match On-Chain Anchor CID!");
    }
    return true;
  }
  if (cid[0] === "b" || cid[0] === "B") {
    const parts = parseCidV1Components(cid);
    if (!parts || !isSupportedCidV1Multihash(parts.mhCode, parts.mhLen)) {
      throw new Error("Cryptographic tamper detected: Unsupported or malformed CIDv1 summary multihash!");
    }
    if (parts.codec === 0x55 || parts.codec === 0x71) {
      if (parts.codec === 0x71 && !isValidDagCborBlock(downloadedBlob)) {
        throw new Error("Cryptographic tamper detected: Payload is not a valid IPLD DAG-CBOR block for codec 0x71!");
      }
      const actualHex =
        parts.mhCode === MULTIHASH_SHA2_256
          ? actualSha256Hex
          : await computeDigestHexByMhCode(downloadedBlob, parts.mhCode);
      if (parts.digestHex !== actualHex) {
        throw new Error("Cryptographic tamper detected: Downloaded summary CIDv1 multihash does not match On-Chain Anchor CID!");
      }
      return true;
    }
    if (parts.codec === 0x70) {
      if (parts.mhCode === MULTIHASH_SHA2_256) {
        const dagPbCidV0 = await computeIpfsCidV0(downloadedBlob);
        const dagPbDigestHex = extractSha256MultihashHex(dagPbCidV0);
        if (parts.digestHex === dagPbDigestHex) {
          return true;
        }
      }
      const rawLeavesDigestHex = await computeIpfsCidV1DagPbRawLeavesDigestHex(downloadedBlob, parts.mhCode);
      if (parts.digestHex === rawLeavesDigestHex) {
        return true;
      }
      const unixFsCidV1DigestHex = await computeIpfsCidV1DagPbUnixFsLeavesDigestHex(downloadedBlob, parts.mhCode);
      if (parts.digestHex === unixFsCidV1DigestHex) {
        return true;
      }
      throw new Error("Cryptographic tamper detected: Downloaded summary CIDv1 multihash does not match On-Chain Anchor CID!");
    }
    throw new Error("Cryptographic tamper detected: Unsupported or malformed CIDv1 summary codec!");
  }
  throw new Error("Cryptographic tamper detected: Unsupported or malformed summary CID format!");
}

export const uploadEncryptedPackageToIPFS = uploadEncryptedRawData;
export const fetchFromIPFS = retrieveFromIpfs;