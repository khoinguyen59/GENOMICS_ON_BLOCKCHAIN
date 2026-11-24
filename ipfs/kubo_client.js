/**
 * @file kubo_client.js
 * @description Local IPFS Kubo Daemon RPC Client (http://127.0.0.1:5001).
 */

const COMPILE_TIME_NON_LOCAL =
  typeof __GENOCHAIN_NON_LOCAL_CHAIN__ !== "undefined" && __GENOCHAIN_NON_LOCAL_CHAIN__;
const DEFAULT_KUBO_RPC = COMPILE_TIME_NON_LOCAL ? "" : "http://127.0.0.1:5001";
const DEFAULT_KUBO_GATEWAY = COMPILE_TIME_NON_LOCAL ? "" : "http://127.0.0.1:8080";
const FORBIDDEN_URI_SCHEME_RE = /^(?:javascript|data|vbscript|file|blob|about):/i;

/**
 * Normalize and validate a Kubo RPC or Gateway endpoint URL.
 * - Trims whitespace and strips trailing slashes
 * - Allows internal Vite relative proxy paths ("/ipfs-rpc", "/ipfs-gw")
 * - Prepends "http://" when no scheme is provided (e.g. "localhost:5009" -> "http://localhost:5009")
 * - Rejects non-http(s) schemes (e.g. "javascript:alert(1)", "file://", "ftp://") and malformed URLs
 * @param {string} raw
 * @param {string|null} [fallback=null]
 * @returns {string|null}
 */
export function normalizeKuboEndpoint(raw, fallback = null) {
  if (typeof raw !== "string") return fallback;
  const trimmed = raw.trim();
  if (!trimmed || /\s/.test(trimmed)) return fallback;

  const stripped = trimmed.replace(/\/+$/, "");
  if (stripped === "/ipfs-rpc" || stripped === "/ipfs-gw") {
    return stripped;
  }
  if (stripped.startsWith("/") || stripped.startsWith("\\")) {
    return fallback;
  }

  if (FORBIDDEN_URI_SCHEME_RE.test(stripped)) {
    return fallback;
  }

  let candidate;
  if (/^https?:\/\//i.test(stripped)) {
    candidate = stripped;
  } else if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(stripped)) {
    // Reject non-http(s) schemes such as ftp://, ws://, custom://
    return fallback;
  } else if (/^[a-zA-Z][a-zA-Z0-9+.-]*:(?!\d+(?:\/|$))/.test(stripped)) {
    // Reject scheme:opaque payloads that are not host:port
    return fallback;
  } else {
    candidate = `http://${stripped}`;
  }

  try {
    const parsed = new URL(candidate);
    if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || !parsed.hostname) {
      return fallback;
    }
    const cleanPath = parsed.pathname === "/" ? "" : parsed.pathname.replace(/\/+$/, "");
    return `${parsed.origin}${cleanPath}`;
  } catch {
    return fallback;
  }
}

/**
 * Detect whether the Vite build explicitly targets a non-localhost EVM chain (chainId !== 31337).
 * @returns {boolean}
 */
export function isNonLocalConfiguredChain() {
  try {
    if (typeof import.meta !== "undefined" && import.meta.env?.VITE_CHAIN_ID !== undefined) {
      const raw = String(import.meta.env.VITE_CHAIN_ID).trim();
      if (raw !== "") {
        const parsed = Number(raw);
        if (Number.isInteger(parsed) && parsed > 0 && parsed !== 31337) {
          return true;
        }
      }
    }
  } catch (_) {}
  return false;
}

function isLoopbackHostname(hostname) {
  const h = String(hostname || "").trim().toLowerCase();
  return h === "127.0.0.1" || h === "localhost" || h === "[::1]" || h === "::1";
}

function isLocalRawKuboGateway(url) {
  if (url === "/ipfs-gw") return true;
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === "http:" &&
      isLoopbackHostname(parsed.hostname) &&
      parsed.port === "8080" &&
      (parsed.pathname === "/" || parsed.pathname === "")
    );
  } catch {
    return false;
  }
}

function isLocalRawKuboRpc(url) {
  if (url === "/ipfs-rpc") return true;
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === "http:" &&
      isLoopbackHostname(parsed.hostname) &&
      parsed.port === "5001" &&
      (parsed.pathname === "/" || parsed.pathname === "")
    );
  } catch {
    return false;
  }
}

/**
 * Return true when an explicit Private IPFS Gateway (distinct from raw local Kubo :8080 / /ipfs-gw)
 * is configured via customGateway, sessionStorage, VITE_KUBO_GATEWAY, or env vars.
 * @param {string|null} [customGateway=null]
 * @returns {boolean}
 */
export function isPrivateIpfsGatewayConfigured(customGateway = null) {
  const explicitGw =
    customGateway && String(customGateway).trim().length > 0
      ? normalizeKuboEndpoint(String(customGateway).trim(), null)
      : getExplicitKuboGatewayEndpoint();
  return Boolean(explicitGw && !isLocalRawKuboGateway(explicitGw));
}

/**
 * Return explicitly configured Kubo RPC endpoint (without defaulting to 127.0.0.1:5001).
 * @returns {string|null}
 */
export function getExplicitKuboRpcEndpoint() {
  if (typeof window !== "undefined" && window.sessionStorage) {
    const sessionSaved = window.sessionStorage.getItem("GENO_KUBO_RPC");
    const norm = normalizeKuboEndpoint(sessionSaved, null);
    if (norm) return norm;
  }
  try {
    if (typeof import.meta !== "undefined" && import.meta.env?.VITE_KUBO_RPC) {
      const norm = normalizeKuboEndpoint(import.meta.env.VITE_KUBO_RPC, null);
      if (norm) return norm;
    }
  } catch (_) {}
  if (typeof process !== "undefined" && process.env) {
    const envRpc = process.env.IPFS_RPC || process.env.KUBO_RPC;
    const norm = normalizeKuboEndpoint(envRpc, null);
    if (norm) return norm;
  }
  return null;
}

/**
 * Return explicitly configured Kubo / Private IPFS Gateway endpoint (without defaulting to 127.0.0.1:8080).
 * @returns {string|null}
 */
export function getExplicitKuboGatewayEndpoint() {
  if (typeof window !== "undefined" && window.sessionStorage) {
    const sessionSaved = window.sessionStorage.getItem("GENO_KUBO_GATEWAY");
    const norm = normalizeKuboEndpoint(sessionSaved, null);
    if (norm) return norm;
  }
  try {
    if (typeof import.meta !== "undefined" && import.meta.env?.VITE_KUBO_GATEWAY) {
      const norm = normalizeKuboEndpoint(import.meta.env.VITE_KUBO_GATEWAY, null);
      if (norm) return norm;
    }
  } catch (_) {}
  if (typeof process !== "undefined" && process.env) {
    const envGw = process.env.IPFS_GATEWAY || process.env.KUBO_GATEWAY;
    const norm = normalizeKuboEndpoint(envGw, null);
    if (norm) return norm;
  }
  return null;
}

/**
 * Retrieve configured IPFS Kubo RPC Endpoint.
 * Returns "" (never probes 127.0.0.1:5001) on non-31337 chains or when a non-local Private IPFS
 * Gateway is configured without an explicit Kubo RPC override.
 * @returns {string}
 */
export function getKuboRpcEndpoint() {
  const explicitRpc = getExplicitKuboRpcEndpoint();
  if (explicitRpc) return explicitRpc;
  if (isNonLocalConfiguredChain()) return "";
  const explicitGw = getExplicitKuboGatewayEndpoint();
  if (explicitGw && !isLocalRawKuboGateway(explicitGw)) return "";
  return DEFAULT_KUBO_RPC;
}

/**
 * Retrieve configured IPFS Kubo Gateway Endpoint
 * Reads from sessionStorage, import.meta.env, process.env with fallback to default port 8080
 * @returns {string}
 */
export function getKuboGatewayEndpoint() {
  const explicitGw = getExplicitKuboGatewayEndpoint();
  if (explicitGw) return explicitGw;
  if (isNonLocalConfiguredChain()) return "";
  return DEFAULT_KUBO_GATEWAY;
}

/**
 * Persist Kubo Gateway endpoint in storage
 * @param {string} endpoint 
 * @returns {string}
 */
export function setKuboGatewayEndpoint(endpoint) {
  const raw = typeof endpoint === "string" ? endpoint.trim() : "";
  if (!raw) {
    if (typeof window !== "undefined") {
      window.sessionStorage?.removeItem("GENO_KUBO_GATEWAY");
      window.localStorage?.removeItem("GENO_KUBO_GATEWAY");
    }
    return "";
  }
  const normalized = normalizeKuboEndpoint(raw, null);
  if (!normalized) {
    throw new Error("Invalid Kubo Gateway URL: expected an http:// or https:// endpoint.");
  }
  if (typeof window !== "undefined") {
    if (window.sessionStorage) {
      window.sessionStorage.setItem("GENO_KUBO_GATEWAY", normalized);
    }
    if (window.localStorage) {
      window.localStorage.removeItem("GENO_KUBO_GATEWAY");
    }
  }
  return normalized;
}

/**
 * Persist Kubo RPC endpoint in storage
 * @param {string} endpoint 
 * @returns {string}
 */
export function setKuboRpcEndpoint(endpoint) {
  const raw = typeof endpoint === "string" ? endpoint.trim() : "";
  if (!raw) {
    if (typeof window !== "undefined") {
      window.sessionStorage?.removeItem("GENO_KUBO_RPC");
      window.localStorage?.removeItem("GENO_KUBO_RPC");
    }
    return "";
  }
  const normalized = normalizeKuboEndpoint(raw, null);
  if (!normalized) {
    throw new Error("Invalid Kubo RPC URL: expected an http:// or https:// endpoint.");
  }
  if (typeof window !== "undefined") {
    if (window.sessionStorage) {
      window.sessionStorage.setItem("GENO_KUBO_RPC", normalized);
    }
    if (window.localStorage) {
      window.localStorage.removeItem("GENO_KUBO_RPC");
    }
  }
  return normalized;
}

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const BASE58_MAP = new Int16Array(128).fill(-1);
for (let i = 0; i < BASE58_ALPHABET.length; i++) {
  BASE58_MAP[BASE58_ALPHABET.charCodeAt(i)] = i;
}

function decodeBase58btc(str) {
  if (!str || typeof str !== "string") return null;
  let leadingZeros = 0;
  while (leadingZeros < str.length && str[leadingZeros] === "1") {
    leadingZeros++;
  }
  const size = Math.ceil((str.length * 733) / 1000) + 1;
  const b256 = new Uint8Array(size);
  let length = 0;
  for (let i = leadingZeros; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (code >= 128) return null;
    let carry = BASE58_MAP[code];
    if (carry < 0) return null;
    let j = 0;
    for (let k = size - 1; (carry !== 0 || j < length) && k >= 0; k--, j++) {
      carry += 58 * b256[k];
      b256[k] = carry & 0xff;
      carry >>= 8;
    }
    length = j;
  }
  let it = size - length;
  while (it < size && b256[it] === 0) it++;
  const out = new Uint8Array(leadingZeros + (size - it));
  out.set(b256.subarray(it), leadingZeros);
  return out;
}

function decodeBase32Rfc4648(str, uppercase = false) {
  if (!str || typeof str !== "string") return null;
  const outLen = Math.floor((str.length * 5) / 8);
  const out = new Uint8Array(outLen);
  let bits = 0;
  let value = 0;
  let idx = 0;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    let v = -1;
    if (!uppercase && ch >= 97 && ch <= 122) v = ch - 97;
    else if (uppercase && ch >= 65 && ch <= 90) v = ch - 65;
    else if (ch >= 50 && ch <= 55) v = ch - 24;
    else return null;
    value = (value << 5) | v;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out[idx++] = (value >>> bits) & 0xff;
      value &= (1 << bits) - 1;
    }
  }
  if (bits >= 5 || (bits > 0 && (value & ((1 << bits) - 1)) !== 0)) return null;
  return out;
}

function readUnsignedVarint(bytes, offset) {
  let val = 0;
  let mult = 1;
  let pos = offset;
  while (pos < bytes.length) {
    const b = bytes[pos++];
    if (b === 0 && pos > offset + 1) return null;
    val += (b & 0x7f) * mult;
    if ((b & 0x80) === 0) {
      return { value: val, next: pos };
    }
    mult *= 128;
    if (mult > 2 ** 49) return null;
  }
  return null;
}

function bytesToHex(bytes) {
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, "0");
  }
  return hex;
}

/**
 * Parse an RFC 4648 Base32 CIDv1 (b.../B...) into its canonical version, IPLD codec,
 * multihash code, digest length, and lowercase hex digest.
 * Returns null for malformed, non-canonical, or non-CIDv1 strings.
 * @param {string} cid
 * @returns {{ version: number, codec: number, mhCode: number, mhLen: number, digestHex: string }|null}
 */
export function parseCidV1Components(cid) {
  if (!cid || typeof cid !== "string") return null;
  const trimmed = cid.trim();
  if (trimmed.length < 10 || (trimmed[0] !== "b" && trimmed[0] !== "B")) return null;
  const raw = decodeBase32Rfc4648(trimmed.slice(1), trimmed[0] === "B");
  if (!raw || raw.length < 4) return null;
  const ver = readUnsignedVarint(raw, 0);
  if (!ver || ver.value !== 1) return null;
  const codec = readUnsignedVarint(raw, ver.next);
  if (!codec) return null;
  const mhCode = readUnsignedVarint(raw, codec.next);
  if (!mhCode) return null;
  const mhLen = readUnsignedVarint(raw, mhCode.next);
  if (!mhLen || mhLen.value <= 0) return null;
  if (mhLen.next + mhLen.value !== raw.length) return null;
  return {
    version: 1,
    codec: codec.value,
    mhCode: mhCode.value,
    mhLen: mhLen.value,
    digestHex: bytesToHex(raw.subarray(mhLen.next, mhLen.next + mhLen.value)),
  };
}

/**
 * Extract the canonical 32-byte SHA2-256 multihash digest hex from a CIDv0 (Qm...)
 * or RFC 4648 Base32 CIDv1 (b.../B...) so CIDv0 <-> CIDv1 references to the exact same
 * Kubo block match regardless of IPLD codec (dag-pb 0x70 vs raw 0x55).
 * Returns null for non-SHA2-256, non-canonical, or unsupported multibase CIDs.
 * @param {string} cid
 * @returns {string|null}
 */
export function extractSha256MultihashHex(cid) {
  if (!cid || typeof cid !== "string") return null;
  const trimmed = cid.trim();
  if (trimmed.length === 46 && trimmed.startsWith("Qm")) {
    const raw = decodeBase58btc(trimmed);
    if (!raw || raw.length !== 34 || raw[0] !== 0x12 || raw[1] !== 0x20) return null;
    return bytesToHex(raw.subarray(2, 34));
  }
  const v1 = parseCidV1Components(trimmed);
  if (!v1 || v1.mhCode !== 0x12 || v1.mhLen !== 0x20) return null;
  return v1.digestHex;
}

const KUBO_LOCAL_REFS_TTL_MS = 10000;
let kuboLocalRefsCache = {
  rpcKey: "",
  supported: false,
  online: false,
  cids: null,
  expiresAt: 0,
};
const kuboLocalRefsInFlight = new Map();

export function clearKuboLocalRefsCache() {
  kuboLocalRefsCache = {
    rpcKey: "",
    supported: false,
    online: false,
    cids: null,
    expiresAt: 0,
  };
  kuboLocalRefsInFlight.clear();
}

export async function queryKuboLocalRefs(kuboRpc, isBrowser, isLocalRpc) {
  const now = Date.now();
  if (
    kuboLocalRefsCache.rpcKey === kuboRpc &&
    kuboLocalRefsCache.expiresAt > now
  ) {
    return kuboLocalRefsCache;
  }

  const existingInFlight = kuboLocalRefsInFlight.get(kuboRpc);
  if (existingInFlight) {
    return existingInFlight;
  }

  const fetchPromise = (async () => {
    const refsUrls = isBrowser && isLocalRpc
      ? (DEFAULT_KUBO_RPC ? ["/ipfs-rpc/refs/local", `${DEFAULT_KUBO_RPC}/api/v0/refs/local`] : ["/ipfs-rpc/refs/local"])
      : [`${kuboRpc}/api/v0/refs/local`];

    for (const url of refsUrls) {
      try {
        const res = await fetch(url, {
          method: "POST",
          signal: AbortSignal.timeout(2500),
        });
        if (res.ok) {
          const ct = (res.headers?.get?.("content-type") || "").toLowerCase();
          if (url.startsWith("/ipfs-rpc/") && ct.includes("text/html")) {
            continue;
          }
          const text = await res.text();
          const cids = new Set();
          for (const line of text.split(/\r?\n/)) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            try {
              const parsed = JSON.parse(trimmed);
              if (parsed && parsed.Ref) {
                cids.add(parsed.Ref);
                const digestHex = extractSha256MultihashHex(parsed.Ref);
                if (digestHex) {
                  cids.add(`sha256:${digestHex}`);
                }
              }
            } catch (_) {}
          }
          const doneAt = Date.now();
          kuboLocalRefsCache = {
            rpcKey: kuboRpc,
            supported: true,
            online: true,
            cids,
            expiresAt: doneAt + KUBO_LOCAL_REFS_TTL_MS,
          };
          return kuboLocalRefsCache;
        }
        if (res.status === 404 || res.status === 405 || res.status === 501) {
          if (url.startsWith("/ipfs-rpc/")) {
            continue;
          }
          const doneAt = Date.now();
          kuboLocalRefsCache = {
            rpcKey: kuboRpc,
            supported: false,
            online: true,
            cids: null,
            expiresAt: doneAt + KUBO_LOCAL_REFS_TTL_MS,
          };
          return kuboLocalRefsCache;
        }
      } catch (_) {}
    }

    const doneAt = Date.now();
    kuboLocalRefsCache = {
      rpcKey: kuboRpc,
      supported: false,
      online: false,
      cids: null,
      expiresAt: doneAt + 5000,
    };
    return kuboLocalRefsCache;
  })();

  kuboLocalRefsInFlight.set(kuboRpc, fetchPromise);
  try {
    return await fetchPromise;
  } finally {
    if (kuboLocalRefsInFlight.get(kuboRpc) === fetchPromise) {
      kuboLocalRefsInFlight.delete(kuboRpc);
    }
  }
}

function generateRandomSiweNonce() {
  const buf = new Uint8Array(16);
  const cryptoApi =
    typeof window !== "undefined" && window.crypto
      ? window.crypto
      : globalThis.crypto;
  cryptoApi.getRandomValues(buf);
  return bytesToHex(buf);
}

/**
 * Build canonical EIP-191 SIWE authorization headers matching deploy/ipfs_access_gateway.py.
 * - action="fetch": signs GENOCHAIN_IPFS_GATEWAY_AUTH_V1 for GET /ipfs/<cid>
 * - action="upload": signs GENOCHAIN_IPFS_GATEWAY_UPLOAD_V1 for POST /api/v0/upload
 * @param {object} params
 * @returns {Promise<Record<string, string>>}
 */
export async function buildSiweGatewayHeaders({
  signer,
  address = "",
  cid = "",
  dataId = null,
  chainId,
  registryAddress,
  action = "fetch",
  contentSha256 = "",
  filename = "",
  nowSec = null,
  nonce = null,
}) {
  if (!signer || typeof signer.signMessage !== "function") {
    throw new Error("SIWE gateway auth requires an active EVM signer with signMessage().");
  }
  const resolvedAddress = String(address || (await signer.getAddress()) || "").trim();
  if (!resolvedAddress) {
    throw new Error("SIWE gateway auth requires a valid EVM signer address.");
  }
  const resolvedRegistry = String(registryAddress || "").trim().toLowerCase();
  if (!resolvedRegistry) {
    throw new Error("SIWE gateway auth requires a GenomicsRegistry contract address.");
  }
  let resolvedChainId = Number(chainId);
  if (!Number.isInteger(resolvedChainId) || resolvedChainId <= 0) {
    const net = await signer.provider?.getNetwork?.().catch(() => null);
    resolvedChainId = Number(net?.chainId || 31337);
  }
  const ts =
    nowSec !== null && nowSec !== undefined && Number.isFinite(Number(nowSec))
      ? Math.floor(Number(nowSec))
      : Math.floor(Date.now() / 1000);
  const resolvedNonce = nonce ? String(nonce).trim() : generateRandomSiweNonce();

  if (action === "upload") {
    const cleanSha = String(contentSha256 || "").trim().replace(/^0x/i, "").toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(cleanSha)) {
      throw new Error("SIWE upload auth requires a 64-char hex SHA-256 content digest.");
    }
    const canonicalMsg = [
      "GENOCHAIN_IPFS_GATEWAY_UPLOAD_V1",
      `chainId:${resolvedChainId}`,
      `registry:${resolvedRegistry}`,
      `contentSha256:${cleanSha}`,
      `address:${resolvedAddress.toLowerCase()}`,
      `timestamp:${ts}`,
      `nonce:${resolvedNonce}`,
    ].join("\n");
    const signature = await signer.signMessage(canonicalMsg);
    const headers = {
      "X-GenoChain-Address": resolvedAddress,
      "X-GenoChain-Timestamp": String(ts),
      "X-GenoChain-Nonce": resolvedNonce,
      "X-GenoChain-Signature": signature,
      "X-GenoChain-Content-Sha256": cleanSha,
    };
    if (filename) {
      headers["X-GenoChain-Filename"] = String(filename).replace(/[^\w.-]/g, "_").slice(0, 128);
    }
    return headers;
  }

  const parsedDataId = Number(dataId);
  if (!Number.isInteger(parsedDataId) || parsedDataId <= 0) {
    throw new Error("SIWE fetch auth requires a positive integer dataId.");
  }
  const cleanCid = String(cid || "").trim();
  if (!cleanCid) {
    throw new Error("SIWE fetch auth requires a target IPFS CID.");
  }
  const canonicalMsg = [
    "GENOCHAIN_IPFS_GATEWAY_AUTH_V1",
    `chainId:${resolvedChainId}`,
    `registry:${resolvedRegistry}`,
    `dataId:${parsedDataId}`,
    `cid:${cleanCid}`,
    `address:${resolvedAddress.toLowerCase()}`,
    `timestamp:${ts}`,
    `nonce:${resolvedNonce}`,
  ].join("\n");
  const signature = await signer.signMessage(canonicalMsg);
  return {
    "X-GenoChain-Data-Id": String(parsedDataId),
    "X-GenoChain-Address": resolvedAddress,
    "X-GenoChain-Timestamp": String(ts),
    "X-GenoChain-Nonce": resolvedNonce,
    "X-GenoChain-Signature": signature,
  };
}

/**
 * Upload binary payload to the SIWE-authenticated Private IPFS Gateway (POST /api/v0/upload).
 * Returns null if no non-local private gateway or signer is configured.
 * @param {Uint8Array|ArrayBuffer|string} fileBytes
 * @param {string} [fileName="payload.enc"]
 * @param {string} [mimeType="application/octet-stream"]
 * @param {object} [options={}]
 * @returns {Promise<{ cid: string, size: number, pinnedOn: string }|null>}
 */
export async function uploadToPrivateGateway(
  fileBytes,
  fileName = "payload.enc",
  mimeType = "application/octet-stream",
  options = {}
) {
  if (typeof fetch === "undefined") return null;
  const rawGw = options?.customGateway || getExplicitKuboGatewayEndpoint();
  const gateway = normalizeKuboEndpoint(rawGw, null);
  if (!gateway) return null;
  const isPrivateGw = !isLocalRawKuboGateway(gateway);
  if (!isPrivateGw && !options?.forceGatewayUpload) return null;

  const signer = options?.signer;
  if (!signer || typeof signer.signMessage !== "function" || !options?.registryAddress) {
    const authErr = new Error(
      "Private IPFS Gateway upload requires an authenticated SIWE signer and registryAddress; unauthenticated Kubo RPC / Pinata fallback is strictly disabled."
    );
    authErr.privateGatewayFailClosed = true;
    authErr.nonRetryable = true;
    throw authErr;
  }

  const bytes =
    fileBytes instanceof Uint8Array
      ? fileBytes
      : fileBytes instanceof ArrayBuffer
        ? new Uint8Array(fileBytes)
        : typeof fileBytes === "string"
          ? new TextEncoder().encode(fileBytes)
          : new Uint8Array(fileBytes || 0);

  const cryptoApi =
    typeof window !== "undefined" && window.crypto
      ? window.crypto
      : globalThis.crypto;
  const digestBuf = await cryptoApi.subtle.digest("SHA-256", bytes);
  const contentSha256 = bytesToHex(new Uint8Array(digestBuf));

  const siweHeaders = await buildSiweGatewayHeaders({
    signer,
    address: options.account || options.address,
    chainId: options.chainId,
    registryAddress: options.registryAddress,
    action: "upload",
    contentSha256,
    filename: fileName,
  });

  const payloadSize = bytes.byteLength;
  const uploadTimeoutMs = Math.max(
    30_000,
    Math.min(300_000, 15_000 + Math.ceil((payloadSize || 0) / 65536) * 500)
  );
  let res;
  try {
    res = await fetch(`${gateway}/api/v0/upload`, {
      method: "POST",
      headers: {
        "Content-Type": mimeType || "application/octet-stream",
        ...siweHeaders,
      },
      body: bytes,
      signal: AbortSignal.timeout(uploadTimeoutMs),
    });
  } catch (netErr) {
    const failErr = new Error(
      `Private IPFS Gateway upload network error (${netErr?.message || String(netErr)}); fallback to unauthenticated Kubo RPC or Pinata is strictly disabled.`
    );
    failErr.privateGatewayFailClosed = true;
    failErr.cause = netErr;
    throw failErr;
  }
  if (res.ok) {
    let json = null;
    try {
      json = await res.json();
    } catch (parseErr) {
      const parseFail = new Error(
        `Private IPFS Gateway returned malformed JSON on HTTP ${res.status} (${parseErr?.message || String(parseErr)}); fallback to unauthenticated Kubo RPC or Pinata is strictly disabled.`
      );
      parseFail.status = res.status;
      parseFail.privateGatewayFailClosed = true;
      parseFail.cause = parseErr;
      throw parseFail;
    }
    if (json && typeof json.cid === "string" && json.cid.length > 0) {
      clearKuboLocalRefsCache();
      return {
        cid: json.cid,
        size: Number(json.size ?? payloadSize),
        pinnedOn: "private-gateway",
      };
    }
    const missingCidErr = new Error(
      `Private IPFS Gateway returned HTTP ${res.status} without a valid CID; fallback to unauthenticated Kubo RPC or Pinata is strictly disabled.`
    );
    missingCidErr.status = res.status;
    missingCidErr.privateGatewayFailClosed = true;
    throw missingCidErr;
  }
  let errDetail = `HTTP ${res.status}`;
  try {
    const errJson = await res.json();
    if (errJson?.error) errDetail = `${errDetail}: ${errJson.error}`;
  } catch (_) {}
  // Strictly fail closed whenever Private IPFS Gateway is configured (even if VITE_KUBO_RPC is also set):
  // NEVER return null to silently fall back to unauthenticated pinFileToKubo / Pinata Cloud!
  const upErr = new Error(
    `Private IPFS Gateway upload failed (${errDetail}); fallback to unauthenticated Kubo RPC or Pinata is strictly disabled.`
  );
  upErr.status = res.status;
  upErr.privateGatewayFailClosed = true;
  if (res.status === 400 || res.status === 401 || res.status === 403 || res.status === 413 || res.status === 429) {
    upErr.nonRetryable = true;
  }
  throw upErr;
}

/**
 * Upload binary file bytes to Local IPFS Kubo Daemon (/api/v0/add)
 * @param {Uint8Array} fileBytes 
 * @param {string} fileName 
 * @param {string} mimeType 
 * @param {string|null} [customRpc] 
 * @returns {Promise<{ cid: string, pinnedOn: string }|null>}
 */
export async function pinFileToKubo(fileBytes, fileName, mimeType, customRpc = null) {
  if (typeof fetch === "undefined") return null;
  const rawRpc = customRpc !== null && customRpc !== undefined ? customRpc : getKuboRpcEndpoint();
  const kuboRpc = normalizeKuboEndpoint(rawRpc, null);
  if (!kuboRpc) return null;
  try {
    const buildFormData = () => {
      const fd = new FormData();
      const blob = new Blob([fileBytes], { type: mimeType });
      fd.append("file", blob, fileName);
      return fd;
    };

    const isBrowser = typeof window !== "undefined";
    const isLocalDefault = isLocalRawKuboRpc(kuboRpc);
    const kuboUrl = (isBrowser && isLocalDefault)
      ? "/ipfs-rpc/add"
      : `${kuboRpc}/api/v0/add`;

    const directUrl = kuboRpc === "/ipfs-rpc"
      ? (DEFAULT_KUBO_RPC ? `${DEFAULT_KUBO_RPC}/api/v0/add` : "/ipfs-rpc/add")
      : `${kuboRpc}/api/v0/add`;
    const payloadSize = fileBytes?.byteLength ?? fileBytes?.length ?? 0;
    const uploadTimeoutMs = Math.max(
      30_000,
      Math.min(300_000, 15_000 + Math.ceil((payloadSize || 0) / 65536) * 500)
    );
    let res = null;
    try {
      res = await fetch(kuboUrl, {
        method: "POST",
        body: buildFormData(),
        signal: AbortSignal.timeout(uploadTimeoutMs),
      });
    } catch (_) {
      res = null;
    }
    const isHtmlFallback =
      Boolean(res?.ok) &&
      kuboUrl.startsWith("/ipfs-rpc/") &&
      (res.headers?.get?.("content-type") || "").toLowerCase().includes("text/html");
    if ((!res || res.status === 404 || res.status === 405 || res.status === 501 || isHtmlFallback) && kuboUrl !== directUrl) {
      res = await fetch(directUrl, {
        method: "POST",
        body: buildFormData(),
        signal: AbortSignal.timeout(uploadTimeoutMs),
      });
    }

    if (res && res.ok) {
      const json = await res.json();
      if (json && typeof json.Hash === "string" && json.Hash.length > 0) {
        clearKuboLocalRefsCache();
        return { cid: json.Hash, pinnedOn: "local-kubo" };
      }
    }
  } catch (err) {}
  return null;
}

/**
 * Upload JSON to Local IPFS Kubo Daemon
 * @param {Object|string} jsonData 
 * @param {string} [fileName] 
 * @param {string|null} [customRpc] 
 * @returns {Promise<{ cid: string, pinnedOn: string }|null>}
 */
export async function pinJsonToKubo(jsonData, fileName = "metadata.json", customRpc = null) {
  if (typeof fetch === "undefined") return null;
  const rawRpc = customRpc !== null && customRpc !== undefined ? customRpc : getKuboRpcEndpoint();
  const kuboRpc = normalizeKuboEndpoint(rawRpc, null);
  if (!kuboRpc) return null;
  try {
    const jsonString = typeof jsonData === "string" ? jsonData : JSON.stringify(jsonData, null, 2);
    const jsonBytes = new TextEncoder().encode(jsonString);
    const buildFormData = () => {
      const fd = new FormData();
      const blob = new Blob([jsonBytes], { type: "application/json" });
      fd.append("file", blob, fileName);
      return fd;
    };

    const isBrowser = typeof window !== "undefined";
    const isLocalDefault = isLocalRawKuboRpc(kuboRpc);
    const kuboUrl = (isBrowser && isLocalDefault)
      ? "/ipfs-rpc/add"
      : `${kuboRpc}/api/v0/add`;

    const directUrl = kuboRpc === "/ipfs-rpc"
      ? (DEFAULT_KUBO_RPC ? `${DEFAULT_KUBO_RPC}/api/v0/add` : "/ipfs-rpc/add")
      : `${kuboRpc}/api/v0/add`;
    let res = null;
    try {
      res = await fetch(kuboUrl, {
        method: "POST",
        body: buildFormData(),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (_) {
      res = null;
    }
    const isHtmlFallback =
      Boolean(res?.ok) &&
      kuboUrl.startsWith("/ipfs-rpc/") &&
      (res.headers?.get?.("content-type") || "").toLowerCase().includes("text/html");
    if ((!res || res.status === 404 || res.status === 405 || res.status === 501 || isHtmlFallback) && kuboUrl !== directUrl) {
      res = await fetch(directUrl, {
        method: "POST",
        body: buildFormData(),
        signal: AbortSignal.timeout(15_000),
      });
    }

    if (res && res.ok) {
      const json = await res.json();
      if (json && typeof json.Hash === "string" && json.Hash.length > 0) {
        clearKuboLocalRefsCache();
        return { cid: json.Hash, pinnedOn: "local-kubo" };
      }
    }
  } catch (err) {}
  return null;
}

/**
 * Fetch raw bytes from local Kubo IPFS node or configured Private IPFS SIWE Gateway.
 * Dynamically resolves gateway URL from environment/session configuration with Vite proxy support.
 * Never probes 127.0.0.1:5001 when VITE_KUBO_GATEWAY is configured without VITE_KUBO_RPC or on non-31337 chains.
 * @param {string} cid 
 * @param {string|null} [customGateway] 
 * @param {object} [options={}]
 * @returns {Promise<Uint8Array|null>}
 */
export async function fetchFromKuboGateway(cid, customGateway = null, options = {}) {
  const cleanCid = typeof cid === "string" ? cid.trim() : "";
  if (typeof fetch === "undefined" || !cleanCid) return null;
  const fastOffline = Boolean(options?.fastOffline);
  const payloadTimeoutMs =
    Number(options?.timeoutMs) > 0 ? Number(options.timeoutMs) : 60_000;

  const explicitRpc = getExplicitKuboRpcEndpoint();
  const kuboRpc = normalizeKuboEndpoint(getKuboRpcEndpoint(), null);
  const explicitGw =
    customGateway && customGateway.trim().length > 0
      ? normalizeKuboEndpoint(customGateway.trim(), null)
      : getExplicitKuboGatewayEndpoint();
  const isPrivateGatewayConfigured = Boolean(explicitGw && !isLocalRawKuboGateway(explicitGw));
  const isBrowser = typeof window !== "undefined";

  // Step 1: Local Kubo RPC fast path (skipped when targeting a remote Private IPFS Gateway without explicit RPC)
  const shouldProbeKuboRpc = Boolean(kuboRpc && (explicitRpc || !isPrivateGatewayConfigured));
  if (shouldProbeKuboRpc) {
    const isLocalRpc = isLocalRawKuboRpc(kuboRpc);

    let skipRpcCat = false;
    if (fastOffline) {
      const refsState = await queryKuboLocalRefs(kuboRpc, isBrowser, isLocalRpc);
      if (!refsState.online) {
        if (!isPrivateGatewayConfigured) return null;
        skipRpcCat = true;
      } else if (refsState.supported && refsState.cids) {
        const hasDirect = refsState.cids.has(cleanCid);
        const digestHex = hasDirect ? null : extractSha256MultihashHex(cleanCid);
        const hasCanonical = digestHex !== null && refsState.cids.has(`sha256:${digestHex}`);
        if (!hasDirect && !hasCanonical && digestHex !== null) {
          if (!isPrivateGatewayConfigured) return null;
          skipRpcCat = true;
        }
      }
    }

    if (!skipRpcCat) {
      const rpcCandidates =
        isBrowser && isLocalRpc
          ? (DEFAULT_KUBO_RPC
              ? [
                  `/ipfs-rpc/cat?arg=${encodeURIComponent(cleanCid)}&offline=true`,
                  `${DEFAULT_KUBO_RPC}/api/v0/cat?arg=${encodeURIComponent(cleanCid)}&offline=true`,
                ]
              : [`/ipfs-rpc/cat?arg=${encodeURIComponent(cleanCid)}&offline=true`])
          : [`${kuboRpc}/api/v0/cat?arg=${encodeURIComponent(cleanCid)}&offline=true`];

      for (const rpcUrl of rpcCandidates) {
        try {
          const rpcRes = await fetch(rpcUrl, {
            method: "POST",
            signal: AbortSignal.timeout(fastOffline ? 1500 : payloadTimeoutMs),
          });
          if (rpcRes.ok) {
            const ct = (rpcRes.headers?.get?.("content-type") || "").toLowerCase();
            if (ct.includes("text/html")) {
              continue;
            }
            const bytes = new Uint8Array(await rpcRes.arrayBuffer());
            const head = new TextDecoder("utf-8", { fatal: false })
              .decode(bytes.subarray(0, 64))
              .trimStart()
              .toLowerCase();
            if (head.startsWith("<!doctype html") || head.startsWith("<html")) {
              continue;
            }
            return bytes;
          }
          if (rpcRes.status === 500 && fastOffline && !isPrivateGatewayConfigured) {
            return null;
          }
        } catch (_) {}
      }
    }
  }

  if (fastOffline && !isPrivateGatewayConfigured) return null;

  // Step 2: Configured Private IPFS SIWE Gateway (or local Kubo HTTP gateway)
  const gateway = explicitGw || (isNonLocalConfiguredChain() ? null : normalizeKuboEndpoint(getKuboGatewayEndpoint(), DEFAULT_KUBO_GATEWAY));
  if (!gateway) return null;
  const isLocalDefault = isLocalRawKuboGateway(gateway);

  const candidateUrls =
    isBrowser && isLocalDefault
      ? (DEFAULT_KUBO_GATEWAY
          ? [`/ipfs-gw/ipfs/${encodeURIComponent(cleanCid)}`, `${DEFAULT_KUBO_GATEWAY}/ipfs/${encodeURIComponent(cleanCid)}`]
          : [`/ipfs-gw/ipfs/${encodeURIComponent(cleanCid)}`])
      : [`${gateway}/ipfs/${encodeURIComponent(cleanCid)}`];

  let reqHeaders = options?.headers ? { ...options.headers } : {};
  const canSignSiwe =
    !isLocalDefault &&
    options?.signer &&
    typeof options.signer.signMessage === "function" &&
    Number(options?.dataId) > 0 &&
    Boolean(options?.registryAddress);
  if (canSignSiwe) {
    const siweHdrs = await buildSiweGatewayHeaders({
      signer: options.signer,
      address: options.account || options.address,
      cid: cleanCid,
      dataId: options.dataId,
      chainId: options.chainId,
      registryAddress: options.registryAddress,
      action: "fetch",
    });
    reqHeaders = { ...siweHdrs, ...reqHeaders };
  }

  for (const url of candidateUrls) {
    let res = null;
    try {
      const fetchInit = {
        signal: AbortSignal.timeout(payloadTimeoutMs),
      };
      if (Object.keys(reqHeaders).length > 0) {
        fetchInit.headers = reqHeaders;
      }
      res = await fetch(url, fetchInit);
    } catch (fetchErr) {
      if (!isLocalDefault) {
        const netErr = new Error(
          `Private IPFS Gateway fetch failed (${fetchErr?.message || "network or timeout error"}).`
        );
        netErr.status = 0;
        netErr.privateGatewayFailClosed = true;
        throw netErr;
      }
      continue;
    }
    if (res.ok) {
      const contentType = (res.headers?.get?.("content-type") || "").toLowerCase();
      if (contentType.includes("text/html")) {
        if (!isLocalDefault) {
          const htmlErr = new Error("Private IPFS Gateway returned unexpected HTML response.");
          htmlErr.status = 502;
          htmlErr.nonRetryable = true;
          htmlErr.privateGatewayFailClosed = true;
          throw htmlErr;
        }
        continue;
      }
      const bytes = new Uint8Array(await res.arrayBuffer());
      const head = new TextDecoder("utf-8", { fatal: false })
        .decode(bytes.subarray(0, 64))
        .trimStart()
        .toLowerCase();
      if (head.startsWith("<!doctype html") || head.startsWith("<html")) {
        if (!isLocalDefault) {
          const htmlErr = new Error("Private IPFS Gateway returned unexpected HTML document.");
          htmlErr.status = 502;
          htmlErr.nonRetryable = true;
          htmlErr.privateGatewayFailClosed = true;
          throw htmlErr;
        }
        continue;
      }
      return bytes;
    }
    // Strictly fail-closed on ALL non-2xx responses from a configured Private IPFS Gateway
    // (401, 403, 404, 429, 5xx — authenticated OR unauthenticated) so we NEVER leak private/revoked
    // genomic CIDs or client IPs to public third-party IPFS gateways or hang for 240s.
    if (!isLocalDefault) {
      let errDetail = `HTTP ${res.status}`;
      try {
        const errJson = await res.json();
        if (errJson?.error) errDetail = `${errDetail}: ${errJson.error}`;
      } catch (_) {}
      const gwErr = new Error(
        res.status === 401 || res.status === 403
          ? `Private IPFS Gateway denied access (${errDetail}).`
          : `Private IPFS Gateway request failed (${errDetail}).`
      );
      gwErr.status = res.status;
      gwErr.privateGatewayFailClosed = true;
      if (res.status === 400 || res.status === 401 || res.status === 403 || res.status === 404 || res.status === 413) {
        gwErr.nonRetryable = true;
      }
      throw gwErr;
    }
  }
  return null;
}