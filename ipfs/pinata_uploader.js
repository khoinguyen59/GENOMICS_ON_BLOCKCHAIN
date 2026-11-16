/**
 * @file pinata_uploader.js
 * @description Master Dual-Engine IPFS Facade (Pinata Cloud API + Local Kubo Daemon).
 *              Re-exports multihash calculation, Pinata, and Kubo client operations.
 */

import { base58Encode, encodeUnixFsFileNode, computeIpfsCidV0, calculateFileCID, BASE58_ALPHABET } from "./multihash.js";
import { getPinataJwt, setPinataJwt, pinFileToPinata, pinJsonToPinata } from "./pinata_client.js";
import {
  getKuboRpcEndpoint,
  setKuboRpcEndpoint,
  getKuboGatewayEndpoint,
  setKuboGatewayEndpoint,
  pinFileToKubo,
  pinJsonToKubo,
  fetchFromKuboGateway
} from "./kubo_client.js";

export {
  base58Encode, encodeUnixFsFileNode, computeIpfsCidV0, calculateFileCID, BASE58_ALPHABET,
  getPinataJwt, setPinataJwt, pinFileToPinata, pinJsonToPinata,
  getKuboRpcEndpoint, setKuboRpcEndpoint, getKuboGatewayEndpoint, setKuboGatewayEndpoint,
  pinFileToKubo, pinJsonToKubo, fetchFromKuboGateway
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

async function pinBytesToIpfsNetwork(fileBytes, fileName, mimeType, customJwt = null) {
  const pinataRes = await pinFileToPinata(fileBytes, fileName, mimeType, customJwt);
  if (pinataRes) return pinataRes;

  const kuboRes = await pinFileToKubo(fileBytes, fileName, mimeType);
  if (kuboRes) return kuboRes;

  const kuboRpc = getKuboRpcEndpoint();
  throw new Error(
    `Lỗi kết nối IPFS: Không thể tải dữ liệu lên mạng phân tán. Cả Pinata Cloud API và Local Kubo Daemon (${kuboRpc}) đều không hoạt động. Vui lòng cấu hình Pinata JWT hoặc khởi động Kubo daemon trước khi thực hiện giao dịch!`
  );
}

export async function uploadEncryptedRawData(encryptedBytes, originalFileName, pinataJwt = null) {
  const { cid, pinnedOn } = await pinBytesToIpfsNetwork(encryptedBytes, `${originalFileName}.enc`, "application/octet-stream", pinataJwt);
  cacheLocalIpfsContent(cid, encryptedBytes, "application/octet-stream");
  return { cid, size: encryptedBytes.length, pinnedOn, timestamp: new Date().toISOString() };
}

export async function uploadEncryptedSummaryReport(encryptedPdfBytes, originalFileName, pinataJwt = null) {
  const { cid, pinnedOn } = await pinBytesToIpfsNetwork(encryptedPdfBytes, `${originalFileName}.enc`, "application/pdf", pinataJwt);
  cacheLocalIpfsContent(cid, encryptedPdfBytes, "application/pdf");
  return { cid, size: encryptedPdfBytes.length, pinnedOn };
}

export async function uploadPhenopacketMetadata(phenopacketJson, pinataJwt = null) {
  const name = `phenopacket_${phenopacketJson.id || "meta"}.json`;
  const jsonBytes = new TextEncoder().encode(JSON.stringify(phenopacketJson, null, 2));

  let res = await pinJsonToPinata(phenopacketJson, name, pinataJwt);
  if (!res) res = await pinJsonToKubo(phenopacketJson, name);

  if (res) {
    cacheLocalIpfsContent(res.cid, jsonBytes, "application/json");
    return { cid: res.cid, json: phenopacketJson, pinnedOn: res.pinnedOn };
  }

  const kuboRpc = getKuboRpcEndpoint();
  throw new Error(
    `Lỗi kết nối IPFS: Không thể tải metadata lên mạng phân tán. Cả Pinata Cloud API và Local Kubo Daemon (${kuboRpc}) đều không hoạt động. Vui lòng cấu hình Pinata JWT hoặc khởi động Kubo daemon trước khi thực hiện giao dịch!`
  );
}

export async function retrieveFromIpfs(cid, gatewayUrl = "https://gateway.pinata.cloud/ipfs") {
  const localBytes = getLocalIpfsContent(cid);
  if (localBytes) return localBytes;

  const kuboBytes = await fetchFromKuboGateway(cid);
  if (kuboBytes) {
    cacheLocalIpfsContent(cid, kuboBytes);
    return kuboBytes;
  }

  if (typeof fetch !== "undefined") {
    const urls = [`${gatewayUrl}/${cid}`, `https://ipfs.io/ipfs/${cid}`, `https://cloudflare-ipfs.com/ipfs/${cid}`];
    for (const url of urls) {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
        if (res.ok) {
          const bytes = new Uint8Array(await res.arrayBuffer());
          cacheLocalIpfsContent(cid, bytes);
          return bytes;
        }
      } catch (_) {}
    }
  }

  throw new Error(`Unable to retrieve CID ${cid} from IPFS gateways or local cache.`);
}

export const uploadEncryptedPackageToIPFS = uploadEncryptedRawData;
export const fetchFromIPFS = retrieveFromIpfs;
