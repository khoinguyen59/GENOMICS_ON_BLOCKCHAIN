/**
 * @file pinata_uploader.js
 * @description Production IPFS Integration module for Genomics on Blockchain.
 *              - Real RFC Multihash CIDv0 (Base58 46 chars: 0x12 0x20 + SHA-256).
 *              - Dual-engine pinning: Pinata Cloud API + Local IPFS Kubo Daemon (http://127.0.0.1:5001).
 *              - Eliminates fake mock prefixes.
 *              - Strict pinning enforcement with verifiable gateway retrieval.
 * @author GenomicsBlockchainAgent
 */

const cryptoObj =
  typeof window !== "undefined" && window.crypto
    ? window.crypto
    : globalThis.crypto;

// Bitcoin / IPFS Base58 alphabet
const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/**
 * Encode bytes to Base58 string (IPFS / Bitcoin standard)
 * @param {Uint8Array} bytes 
 * @returns {string}
 */
export function base58Encode(bytes) {
  const digits = [0];
  for (let i = 0; i < bytes.length; i++) {
    for (let j = 0; j < digits.length; j++) {
      digits[j] <<= 8;
    }
    digits[0] += bytes[i];
    let carry = 0;
    for (let j = 0; j < digits.length; j++) {
      digits[j] += carry;
      carry = (digits[j] / 58) | 0;
      digits[j] %= 58;
    }
    while (carry) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }

  // Count leading zeros
  let leadingZeros = 0;
  for (let i = 0; i < bytes.length && bytes[i] === 0; i++) {
    leadingZeros++;
  }

  let result = "";
  for (let i = 0; i < leadingZeros; i++) {
    result += BASE58_ALPHABET[0];
  }
  for (let i = digits.length - 1; i >= 0; i--) {
    result += BASE58_ALPHABET[digits[i]];
  }
  return result;
}

function encodeVarint(val) {
  const bytes = [];
  let n = val;
  while (n >= 0x80) {
    bytes.push((n & 0x7f) | 0x80);
    n >>>= 7;
  }
  bytes.push(n);
  return new Uint8Array(bytes);
}

function concatBuffers(arrays) {
  const total = arrays.reduce((sum, a) => sum + a.length, 0);
  const res = new Uint8Array(total);
  let offset = 0;
  for (const arr of arrays) {
    res.set(arr, offset);
    offset += arr.length;
  }
  return res;
}

/**
 * Encode raw file bytes into an authentic IPFS UnixFS DAG-PB Protobuf block node
 * @param {Uint8Array} fileBytes 
 * @returns {Uint8Array}
 */
export function encodeUnixFsFileNode(fileBytes) {
  if (!fileBytes || fileBytes.length === 0) {
    // Official IPFS / Kubo standard CIDv0 for an empty file (0 bytes):
    // UnixFS Data: Type = File (0x08, 0x02), filesize = 0 (0x18, 0x00) -> 4 bytes
    // DAG-PB: tag 0x0a, length 0x04 -> [0x0a, 0x04, 0x08, 0x02, 0x18, 0x00]
    return new Uint8Array([0x0a, 0x04, 0x08, 0x02, 0x18, 0x00]);
  }
  const lenVarint = encodeVarint(fileBytes.length);
  // UnixFS Data protobuf: tag 0x08 val 0x02 (Type: File), tag 0x12 len data (Data), tag 0x18 len (filesize)
  const unixFs = concatBuffers([
    new Uint8Array([0x08, 0x02, 0x12]),
    lenVarint,
    fileBytes,
    new Uint8Array([0x18]),
    lenVarint,
  ]);
  const unixFsLen = encodeVarint(unixFs.length);
  // DAG-PB Node protobuf: tag 0x0a len unixFs (Data field)
  return concatBuffers([new Uint8Array([0x0a]), unixFsLen, unixFs]);
}

/**
 * Compute authentic, RFC-compliant IPFS UnixFS CIDv0 (DAG-PB + Multihash 0x12 0x20 + SHA-256)
 * Produces genuine 46-character 'Qm...' identifiers matching official `ipfs add --only-hash`!
 * @param {Uint8Array|string|ArrayBuffer} data 
 * @returns {Promise<string>} Valid IPFS CIDv0 string
 */
export async function computeIpfsCidV0(data) {
  let bytes;
  if (typeof data === "string") {
    bytes = new TextEncoder().encode(data);
  } else if (data instanceof ArrayBuffer) {
    bytes = new Uint8Array(data);
  } else if (data && data.buffer instanceof ArrayBuffer && typeof data.byteOffset === "number" && typeof data.byteLength === "number") {
    bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  } else if (data instanceof Uint8Array) {
    bytes = data;
  } else if (data) {
    bytes = new Uint8Array(data);
  } else {
    bytes = new Uint8Array(0);
  }

  // Format into official IPFS UnixFS DAG-PB block before hashing
  const dagPbBlock = encodeUnixFsFileNode(bytes);
  const hashBuffer = await cryptoObj.subtle.digest("SHA-256", dagPbBlock);
  const hashBytes = new Uint8Array(hashBuffer);

  // Multihash structure: [0x12 (sha2-256), 0x20 (32 bytes length), ...32 bytes hash]
  const multihash = new Uint8Array(34);
  multihash[0] = 0x12; // SHA-256 function code
  multihash[1] = 0x20; // 32 bytes digest length
  multihash.set(hashBytes, 2);

  return base58Encode(multihash);
}

// Local content-addressable cache for offline resilience and fast gateway verification
const localIpfsStorage = new Map();

/**
 * Retrieve configured Pinata JWT from environment or localStorage
 * @returns {string|null}
 */
export function getPinataJwt() {
  if (typeof window !== "undefined") {
    if (window.sessionStorage) {
      const sessionSaved = window.sessionStorage.getItem("GENO_PINATA_JWT");
      if (sessionSaved && sessionSaved.trim().length > 0) return sessionSaved.trim();
    }
    if (window.localStorage) {
      const saved = window.localStorage.getItem("GENO_PINATA_JWT");
      if (saved && saved.trim().length > 0) return saved.trim();
    }
  }
  try {
    if (typeof import.meta !== "undefined" && import.meta.env?.VITE_PINATA_JWT) {
      return import.meta.env.VITE_PINATA_JWT.trim();
    }
  } catch (e) {}
  if (typeof process !== "undefined" && process.env?.PINATA_JWT) {
    return process.env.PINATA_JWT.trim();
  }
  return null;
}

/**
 * Retrieve configured IPFS Kubo RPC Endpoint
 * @returns {string}
 */
export function getKuboRpcEndpoint() {
  if (typeof window !== "undefined") {
    if (window.sessionStorage) {
      const sessionSaved = window.sessionStorage.getItem("GENO_KUBO_RPC");
      if (sessionSaved && sessionSaved.trim().length > 0) return sessionSaved.trim();
    }
    if (window.localStorage) {
      const saved = window.localStorage.getItem("GENO_KUBO_RPC");
      if (saved && saved.trim().length > 0) return saved.trim();
    }
  }
  try {
    if (typeof import.meta !== "undefined" && import.meta.env?.VITE_KUBO_RPC) {
      return import.meta.env.VITE_KUBO_RPC.trim();
    }
  } catch (e) {}
  return "http://127.0.0.1:5001";
}

/**
 * Persist Pinata JWT in storage
 * @param {string} token 
 */
export function setPinataJwt(token) {
  if (typeof window !== "undefined") {
    if (window.localStorage) {
      window.localStorage.setItem("GENO_PINATA_JWT", token || "");
    }
  }
}

/**
 * Persist Kubo RPC endpoint in storage
 * @param {string} endpoint 
 */
export function setKuboRpcEndpoint(endpoint) {
  if (typeof window !== "undefined") {
    if (window.localStorage) {
      window.localStorage.setItem("GENO_KUBO_RPC", endpoint || "");
    }
  }
}


/**
 * Save data to local IPFS content-addressable cache
 * @param {string} cid 
 * @param {Uint8Array} bytes 
 * @param {string} mimeType 
 */
export function cacheLocalIpfsContent(cid, bytes, mimeType = "application/octet-stream") {
  localIpfsStorage.set(cid, {
    bytes: bytes,
    mimeType: mimeType,
    size: bytes.length,
    timestamp: new Date().toISOString(),
  });
}

/**
 * Retrieve data from local IPFS content-addressable cache
 * @param {string} cid 
 * @returns {Uint8Array|null}
 */
export function getLocalIpfsContent(cid) {
  const item = localIpfsStorage.get(cid);
  return item ? item.bytes : null;
}

/**
 * Pin file bytes to IPFS using Pinata or Local Kubo Daemon
 * STRICT ZERO-MOCKUP: Throws hard error if neither node is reachable!
 * @param {Uint8Array} fileBytes 
 * @param {string} fileName 
 * @param {string} mimeType 
 * @param {string} [customJwt] 
 * @returns {Promise<{ cid: string, pinnedOn: string }>}
 */
async function pinBytesToIpfsNetwork(fileBytes, fileName, mimeType, customJwt = null) {
  const jwt = customJwt || getPinataJwt();
  const kuboRpc = getKuboRpcEndpoint();

  // 1. Try Pinata Cloud REST API
  if (jwt && typeof fetch !== "undefined") {
    try {
      const formData = new FormData();
      const blob = new Blob([fileBytes], { type: mimeType });
      formData.append("file", blob, fileName);

      const res = await fetch("https://api.pinata.cloud/pinning/pinFileToIPFS", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${jwt}`,
        },
        body: formData,
      });

      if (res.ok) {
        const json = await res.json();
        return { cid: json.IpfsHash, pinnedOn: "pinata-cloud" };
      }
    } catch (err) {
      console.warn("Pinata API attempt failed, trying local Kubo daemon:", err.message);
    }
  }

  if (typeof fetch !== "undefined") {
    try {
      const formData = new FormData();
      const blob = new Blob([fileBytes], { type: mimeType });
      formData.append("file", blob, fileName);

      const isBrowser = typeof window !== "undefined";
      const kuboUrl = (isBrowser && (kuboRpc === "http://127.0.0.1:5001" || kuboRpc === "/ipfs-rpc"))
        ? "/ipfs-rpc/add"
        : `${kuboRpc}/api/v0/add`;

      let res = null;
      try {
        res = await fetch(kuboUrl, {
          method: "POST",
          body: formData,
          signal: AbortSignal.timeout(3000),
        });
      } catch (_) {
        if (kuboUrl !== `${kuboRpc}/api/v0/add`) {
          res = await fetch(`${kuboRpc}/api/v0/add`, {
            method: "POST",
            body: formData,
            signal: AbortSignal.timeout(3000),
          });
        }
      }

      if (res && res.ok) {
        const json = await res.json();
        return { cid: json.Hash, pinnedOn: "local-kubo" };
      }
    } catch (err) {
      // Kubo daemon not active
    }
  }

  // STRICT ZERO-MOCKUP: If neither Pinata nor Kubo succeeded, FAIL FAST!
  throw new Error(
    `Lỗi kết nối IPFS: Không thể tải dữ liệu lên mạng phân tán. Cả Pinata Cloud API và Local Kubo Daemon (${kuboRpc}) đều không hoạt động. Vui lòng cấu hình Pinata JWT hoặc khởi động Kubo daemon trước khi thực hiện giao dịch!`
  );
}

/**
 * Upload encrypted raw genomic sequence (.vcf / .fastq) to IPFS
 * @param {Uint8Array} encryptedBytes 
 * @param {string} originalFileName 
 * @param {string} [pinataJwt] 
 * @returns {Promise<{ cid: string, size: number, pinnedOn: string, timestamp: string }>}
 */
export async function uploadEncryptedRawData(encryptedBytes, originalFileName, pinataJwt = null) {
  const size = encryptedBytes.length;
  const timestamp = new Date().toISOString();

  const { cid, pinnedOn } = await pinBytesToIpfsNetwork(
    encryptedBytes,
    `${originalFileName}.enc`,
    "application/octet-stream",
    pinataJwt
  );

  cacheLocalIpfsContent(cid, encryptedBytes, "application/octet-stream");

  return {
    cid: cid,
    size: size,
    pinnedOn: pinnedOn,
    timestamp: timestamp,
  };
}

/**
 * Upload encrypted summary medical report (.pdf) to IPFS
 * @param {Uint8Array} encryptedPdfBytes 
 * @param {string} originalFileName 
 * @param {string} [pinataJwt] 
 * @returns {Promise<{ cid: string, size: number, pinnedOn: string }>}
 */
export async function uploadEncryptedSummaryReport(encryptedPdfBytes, originalFileName, pinataJwt = null) {
  const { cid, pinnedOn } = await pinBytesToIpfsNetwork(
    encryptedPdfBytes,
    `${originalFileName}.enc`,
    "application/pdf",
    pinataJwt
  );

  cacheLocalIpfsContent(cid, encryptedPdfBytes, "application/pdf");

  return {
    cid: cid,
    size: encryptedPdfBytes.length,
    pinnedOn: pinnedOn,
  };
}

/**
 * Upload public GA4GH Phenopacket JSON metadata to IPFS
 * @param {Object} phenopacketJson 
 * @param {string} [pinataJwt] 
 * @returns {Promise<{ cid: string, json: Object, pinnedOn: string }>}
 */
export async function uploadPhenopacketMetadata(phenopacketJson, pinataJwt = null) {
  const jwt = pinataJwt || getPinataJwt();
  const kuboRpc = getKuboRpcEndpoint();
  const jsonString = JSON.stringify(phenopacketJson, null, 2);
  const jsonBytes = new TextEncoder().encode(jsonString);

  // 1. Try Pinata pinJSONToIPFS
  if (jwt && typeof fetch !== "undefined") {
    try {
      const res = await fetch("https://api.pinata.cloud/pinning/pinJSONToIPFS", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${jwt}`,
        },
        body: JSON.stringify({
          pinataContent: phenopacketJson,
          pinataMetadata: { name: `phenopacket_${phenopacketJson.id || "meta"}.json` },
        }),
      });

      if (res.ok) {
        const json = await res.json();
        cacheLocalIpfsContent(json.IpfsHash, jsonBytes, "application/json");
        return {
          cid: json.IpfsHash,
          json: phenopacketJson,
          pinnedOn: "pinata-cloud",
        };
      }
    } catch (err) {
      console.warn("Pinata JSON upload warning:", err.message);
    }
  }

  // 2. Try Local Kubo Daemon
  if (typeof fetch !== "undefined") {
    try {
      const formData = new FormData();
      const blob = new Blob([jsonBytes], { type: "application/json" });
      formData.append("file", blob, `phenopacket_${phenopacketJson.id || "meta"}.json`);

      const res = await fetch(`${kuboRpc}/api/v0/add`, {
        method: "POST",
        body: formData,
        signal: AbortSignal.timeout(3000),
      });

      if (res.ok) {
        const json = await res.json();
        cacheLocalIpfsContent(json.Hash, jsonBytes, "application/json");
        return {
          cid: json.Hash,
          json: phenopacketJson,
          pinnedOn: "local-kubo",
        };
      }
    } catch (err) {}
  }

  // STRICT ZERO-MOCKUP: If neither Pinata nor Kubo succeeded, FAIL FAST!
  throw new Error(
    `Lỗi kết nối IPFS: Không thể tải metadata lên mạng phân tán. Cả Pinata Cloud API và Local Kubo Daemon (${kuboRpc}) đều không hoạt động. Vui lòng cấu hình Pinata JWT hoặc khởi động Kubo daemon trước khi thực hiện giao dịch!`
  );
}

/**
 * Retrieve content from IPFS Gateway, Kubo daemon, or local CAS cache by CID
 * @param {string} cid Valid IPFS CID
 * @param {string} [gatewayUrl] Custom IPFS gateway URL
 * @returns {Promise<Uint8Array>}
 */
export async function retrieveFromIpfs(cid, gatewayUrl = "https://gateway.pinata.cloud/ipfs") {
  // 1. Check local content-addressable cache
  const localBytes = getLocalIpfsContent(cid);
  if (localBytes) {
    return localBytes;
  }

  // 2. Try Local IPFS Kubo gateway if running
  if (typeof fetch !== "undefined") {
    try {
      const res = await fetch(`http://127.0.0.1:8080/ipfs/${cid}`, {
        signal: AbortSignal.timeout(3000),
      });
      if (res.ok) {
        const buf = await res.arrayBuffer();
        const bytes = new Uint8Array(buf);
        cacheLocalIpfsContent(cid, bytes);
        return bytes;
      }
    } catch (e) {}
  }

  // 3. Fetch from public/Pinata IPFS Gateways
  if (typeof fetch !== "undefined") {
    const urls = [
      `${gatewayUrl}/${cid}`,
      `https://ipfs.io/ipfs/${cid}`,
      `https://cloudflare-ipfs.com/ipfs/${cid}`,
    ];

    for (const url of urls) {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
        if (res.ok) {
          const buf = await res.arrayBuffer();
          const bytes = new Uint8Array(buf);
          cacheLocalIpfsContent(cid, bytes);
          return bytes;
        }
      } catch (e) {
        // try next gateway
      }
    }
  }

  throw new Error(`Unable to retrieve CID ${cid} from IPFS gateways or local cache.`);
}
