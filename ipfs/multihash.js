/**
 * @file multihash.js
 * @description RFC Multihash & IPFS UnixFS DAG-PB CIDv0/CIDv1 calculation engine
 *              supporting SHA2-256 (0x12), SHA2-512 (0x13), and RFC 7693 BLAKE2b-256 (0xb220)
 *              identically in Node.js and browser environments.
 */
const cryptoObj = typeof window !== "undefined" && window.crypto ? window.crypto : globalThis.crypto;
export const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const BASE32_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

export const MULTIHASH_SHA2_256 = 0x12;
export const MULTIHASH_SHA2_512 = 0x13;
export const MULTIHASH_BLAKE2B_256 = 0xb220;

/** Encode bytes to Base58 string (IPFS / Bitcoin standard) */
export function base58Encode(bytes) {
  const digits = [0];
  for (let i = 0; i < bytes.length; i++) {
    for (let j = 0; j < digits.length; j++) digits[j] <<= 8;
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
  let leadingZeros = 0;
  for (let i = 0; i < bytes.length && bytes[i] === 0; i++) leadingZeros++;
  let result = "";
  for (let i = 0; i < leadingZeros; i++) result += BASE58_ALPHABET[0];
  for (let i = digits.length - 1; i >= 0; i--) result += BASE58_ALPHABET[digits[i]];
  return result;
}

/** Encode bytes to RFC 4648 lowercase unpadded Base32 (IPFS CIDv1 `b...` multibase) */
export function base32Encode(bytes) {
  let bits = 0;
  let value = 0;
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    value = (value << 8) | bytes[i];
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += BASE32_ALPHABET[(value >>> bits) & 31];
    }
  }
  if (bits > 0) {
    out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return out;
}

// ── RFC 7693 BLAKE2b-256 (Pure JS 32-bit word arithmetic, Node + Browser safe) ──
const BLAKE2B_IV_LO = new Uint32Array([
  0xf3bcc908, 0x84caa73b, 0xfe94f82b, 0x5f1d36f1,
  0xade682d1, 0x2b3e6c1f, 0xfb41bd6b, 0x137e2179,
]);
const BLAKE2B_IV_HI = new Uint32Array([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
  0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
]);
const BLAKE2B_SIGMA = new Uint8Array([
  0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
  14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3,
  11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4,
  7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8,
  9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13,
  2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9,
  12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11,
  13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10,
  6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5,
  10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0,
]);

function blake2bG(vLo, vHi, a, b, c, d, xLo, xHi, yLo, yHi) {
  let aLo = (vLo[a] + vLo[b]) >>> 0;
  let aHi = (vHi[a] + vHi[b] + (aLo < vLo[a] ? 1 : 0)) >>> 0;
  const aLo2 = (aLo + xLo) >>> 0;
  aHi = (aHi + xHi + (aLo2 < aLo ? 1 : 0)) >>> 0;
  aLo = aLo2;

  // d = ROR64(d ^ a, 32)
  let dHi = (vLo[d] ^ aLo) >>> 0;
  let dLo = (vHi[d] ^ aHi) >>> 0;

  let cLo = (vLo[c] + dLo) >>> 0;
  let cHi = (vHi[c] + dHi + (cLo < vLo[c] ? 1 : 0)) >>> 0;

  // b = ROR64(b ^ c, 24)
  let tLo = (vLo[b] ^ cLo) >>> 0;
  let tHi = (vHi[b] ^ cHi) >>> 0;
  let bLo = ((tLo >>> 24) | (tHi << 8)) >>> 0;
  let bHi = ((tHi >>> 24) | (tLo << 8)) >>> 0;

  const aLo3 = (aLo + bLo) >>> 0;
  aHi = (aHi + bHi + (aLo3 < aLo ? 1 : 0)) >>> 0;
  aLo = aLo3;
  const aLo4 = (aLo + yLo) >>> 0;
  aHi = (aHi + yHi + (aLo4 < aLo ? 1 : 0)) >>> 0;
  aLo = aLo4;

  // d = ROR64(d ^ a, 16)
  tLo = (dLo ^ aLo) >>> 0;
  tHi = (dHi ^ aHi) >>> 0;
  dLo = ((tLo >>> 16) | (tHi << 16)) >>> 0;
  dHi = ((tHi >>> 16) | (tLo << 16)) >>> 0;

  const cLo2 = (cLo + dLo) >>> 0;
  cHi = (cHi + dHi + (cLo2 < cLo ? 1 : 0)) >>> 0;
  cLo = cLo2;

  // b = ROR64(b ^ c, 63) == ROL64(b ^ c, 1)
  tLo = (bLo ^ cLo) >>> 0;
  tHi = (bHi ^ cHi) >>> 0;
  bLo = ((tLo << 1) | (tHi >>> 31)) >>> 0;
  bHi = ((tHi << 1) | (tLo >>> 31)) >>> 0;

  vLo[a] = aLo; vHi[a] = aHi;
  vLo[b] = bLo; vHi[b] = bHi;
  vLo[c] = cLo; vHi[c] = cHi;
  vLo[d] = dLo; vHi[d] = dHi;
}

function blake2bCompress(hLo, hHi, mLo, mHi, tLo, tHi, isLast) {
  const vLo = new Uint32Array(16);
  const vHi = new Uint32Array(16);
  for (let i = 0; i < 8; i++) {
    vLo[i] = hLo[i];
    vHi[i] = hHi[i];
    vLo[i + 8] = BLAKE2B_IV_LO[i];
    vHi[i + 8] = BLAKE2B_IV_HI[i];
  }
  vLo[12] = (vLo[12] ^ tLo) >>> 0;
  vHi[12] = (vHi[12] ^ tHi) >>> 0;
  if (isLast) {
    vLo[14] = (~vLo[14]) >>> 0;
    vHi[14] = (~vHi[14]) >>> 0;
  }
  for (let r = 0; r < 12; r++) {
    const s = (r % 10) * 16;
    blake2bG(vLo, vHi, 0, 4, 8, 12, mLo[BLAKE2B_SIGMA[s]], mHi[BLAKE2B_SIGMA[s]], mLo[BLAKE2B_SIGMA[s + 1]], mHi[BLAKE2B_SIGMA[s + 1]]);
    blake2bG(vLo, vHi, 1, 5, 9, 13, mLo[BLAKE2B_SIGMA[s + 2]], mHi[BLAKE2B_SIGMA[s + 2]], mLo[BLAKE2B_SIGMA[s + 3]], mHi[BLAKE2B_SIGMA[s + 3]]);
    blake2bG(vLo, vHi, 2, 6, 10, 14, mLo[BLAKE2B_SIGMA[s + 4]], mHi[BLAKE2B_SIGMA[s + 4]], mLo[BLAKE2B_SIGMA[s + 5]], mHi[BLAKE2B_SIGMA[s + 5]]);
    blake2bG(vLo, vHi, 3, 7, 11, 15, mLo[BLAKE2B_SIGMA[s + 6]], mHi[BLAKE2B_SIGMA[s + 6]], mLo[BLAKE2B_SIGMA[s + 7]], mHi[BLAKE2B_SIGMA[s + 7]]);
    blake2bG(vLo, vHi, 0, 5, 10, 15, mLo[BLAKE2B_SIGMA[s + 8]], mHi[BLAKE2B_SIGMA[s + 8]], mLo[BLAKE2B_SIGMA[s + 9]], mHi[BLAKE2B_SIGMA[s + 9]]);
    blake2bG(vLo, vHi, 1, 6, 11, 12, mLo[BLAKE2B_SIGMA[s + 10]], mHi[BLAKE2B_SIGMA[s + 10]], mLo[BLAKE2B_SIGMA[s + 11]], mHi[BLAKE2B_SIGMA[s + 11]]);
    blake2bG(vLo, vHi, 2, 7, 8, 13, mLo[BLAKE2B_SIGMA[s + 12]], mHi[BLAKE2B_SIGMA[s + 12]], mLo[BLAKE2B_SIGMA[s + 13]], mHi[BLAKE2B_SIGMA[s + 13]]);
    blake2bG(vLo, vHi, 3, 4, 9, 14, mLo[BLAKE2B_SIGMA[s + 14]], mHi[BLAKE2B_SIGMA[s + 14]], mLo[BLAKE2B_SIGMA[s + 15]], mHi[BLAKE2B_SIGMA[s + 15]]);
  }
  for (let i = 0; i < 8; i++) {
    hLo[i] = (hLo[i] ^ vLo[i] ^ vLo[i + 8]) >>> 0;
    hHi[i] = (hHi[i] ^ vHi[i] ^ vHi[i + 8]) >>> 0;
  }
}

/**
 * Pure-JS RFC 7693 BLAKE2b digest (unkeyed, default 32 bytes = BLAKE2b-256).
 * @param {Uint8Array|ArrayBuffer|string} data
 * @param {number} [outLen=32]
 * @returns {Uint8Array}
 */
export function blake2bDigest(data, outLen = 32) {
  if (!Number.isInteger(outLen) || outLen < 1 || outLen > 64) {
    throw new Error("BLAKE2b output length must be an integer between 1 and 64 bytes.");
  }
  const bytes = normalizeInputBytes(data);
  const hLo = new Uint32Array(BLAKE2B_IV_LO);
  const hHi = new Uint32Array(BLAKE2B_IV_HI);
  hLo[0] = (hLo[0] ^ (0x01010000 | outLen)) >>> 0;

  const block = new Uint8Array(128);
  const mLo = new Uint32Array(16);
  const mHi = new Uint32Array(16);
  let tLo = 0;
  let tHi = 0;

  const loadWords = (src, base) => {
    for (let i = 0; i < 16; i++) {
      const o = base + i * 8;
      mLo[i] = (src[o] | (src[o + 1] << 8) | (src[o + 2] << 16) | (src[o + 3] << 24)) >>> 0;
      mHi[i] = (src[o + 4] | (src[o + 5] << 8) | (src[o + 6] << 16) | (src[o + 7] << 24)) >>> 0;
    }
  };

  let offset = 0;
  while (bytes.length - offset > 128) {
    const nextLo = (tLo + 128) >>> 0;
    if (nextLo < tLo) tHi = (tHi + 1) >>> 0;
    tLo = nextLo;
    loadWords(bytes, offset);
    blake2bCompress(hLo, hHi, mLo, mHi, tLo, tHi, false);
    offset += 128;
  }

  const rem = bytes.length - offset;
  block.fill(0);
  if (rem > 0) block.set(bytes.subarray(offset), 0);
  const finalLo = (tLo + rem) >>> 0;
  if (finalLo < tLo) tHi = (tHi + 1) >>> 0;
  tLo = finalLo;
  loadWords(block, 0);
  blake2bCompress(hLo, hHi, mLo, mHi, tLo, tHi, true);

  const out = new Uint8Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const wordIdx = i >>> 3;
    const byteInWord = i & 7;
    const word = byteInWord < 4 ? hLo[wordIdx] : hHi[wordIdx];
    out[i] = (word >>> ((byteInWord & 3) * 8)) & 0xff;
  }
  return out;
}

export function encodeVarint(val) {
  const bytes = [];
  let n = BigInt(val);
  while (n >= 0x80n) {
    bytes.push(Number((n & 0x7fn) | 0x80n));
    n >>= 7n;
  }
  bytes.push(Number(n));
  return new Uint8Array(bytes);
}

export function concatBuffers(arrays) {
  const total = arrays.reduce((sum, a) => sum + a.length, 0);
  const res = new Uint8Array(total);
  let offset = 0;
  for (const arr of arrays) {
    res.set(arr, offset);
    offset += arr.length;
  }
  return res;
}

/** Encode raw file bytes into an authentic IPFS UnixFS DAG-PB Protobuf block node */
export function encodeUnixFsFileNode(fileBytes) {
  if (!fileBytes || fileBytes.length === 0) {
    return new Uint8Array([0x0a, 0x04, 0x08, 0x02, 0x18, 0x00]);
  }
  const lenVarint = encodeVarint(fileBytes.length);
  const unixFs = concatBuffers([
    new Uint8Array([0x08, 0x02, 0x12]),
    lenVarint,
    fileBytes,
    new Uint8Array([0x18]),
    lenVarint,
  ]);
  return concatBuffers([new Uint8Array([0x0a]), encodeVarint(unixFs.length), unixFs]);
}

const UNIXFS_CHUNK_SIZE = 262144; // 256 KB standard IPFS chunk size
const UNIXFS_MAX_LINKS = 174; // Standard Kubo balanced DAG-PB max links per internal node

/**
 * Compute a raw digest for any contract-supported multihash code.
 * Supported: SHA2-256 (0x12, 32B), SHA2-512 (0x13, 64B), BLAKE2b-256 (0xb220, 32B).
 */
export async function computeRawDigestByMultihash(data, mhCode = MULTIHASH_SHA2_256) {
  const bytes = normalizeInputBytes(data);
  if (mhCode === MULTIHASH_SHA2_256) {
    const hashBuffer = await cryptoObj.subtle.digest("SHA-256", bytes);
    return new Uint8Array(hashBuffer);
  }
  if (mhCode === MULTIHASH_SHA2_512) {
    const hashBuffer = await cryptoObj.subtle.digest("SHA-512", bytes);
    return new Uint8Array(hashBuffer);
  }
  if (mhCode === MULTIHASH_BLAKE2B_256) {
    return blake2bDigest(bytes, 32);
  }
  throw new Error(`Unsupported multihash code: 0x${Number(mhCode).toString(16)}`);
}

/** Compute an encoded multihash byte sequence (`<code-varint><len-varint><digest>`). */
export async function computeMultihashBytes(blockBytes, mhCode = MULTIHASH_SHA2_256) {
  const digest = await computeRawDigestByMultihash(blockBytes, mhCode);
  return concatBuffers([encodeVarint(mhCode), encodeVarint(digest.length), digest]);
}

async function sha256Multihash(blockBytes) {
  return computeMultihashBytes(blockBytes, MULTIHASH_SHA2_256);
}

function encodePbLink(multihashBytes, tsize) {
  const body = concatBuffers([
    new Uint8Array([0x0a]),
    encodeVarint(multihashBytes.length),
    multihashBytes,
    new Uint8Array([0x12, 0x00, 0x18]),
    encodeVarint(tsize),
  ]);
  return concatBuffers([new Uint8Array([0x12]), encodeVarint(body.length), body]);
}

async function buildUnixFsInternalNode(children, mhCode = MULTIHASH_SHA2_256) {
  const pbLinks = [];
  const blockSizesParts = [];
  let totalFileSize = 0;
  let childrenTsizeSum = 0;
  for (const child of children) {
    pbLinks.push(encodePbLink(child.multihash, child.tsize));
    blockSizesParts.push(new Uint8Array([0x20]), encodeVarint(child.fileSize));
    totalFileSize += child.fileSize;
    childrenTsizeSum += child.tsize;
  }
  const unixFsParent = concatBuffers([
    new Uint8Array([0x08, 0x02, 0x18]),
    encodeVarint(totalFileSize),
    ...blockSizesParts,
  ]);
  const dataField = concatBuffers([
    new Uint8Array([0x0a]),
    encodeVarint(unixFsParent.length),
    unixFsParent,
  ]);
  const dagPb = concatBuffers([...pbLinks, dataField]);
  const digest = await computeRawDigestByMultihash(dagPb, mhCode);
  const multihash = concatBuffers([encodeVarint(mhCode), encodeVarint(digest.length), digest]);
  return {
    digest,
    multihash,
    tsize: dagPb.length + childrenTsizeSum,
    fileSize: totalFileSize,
  };
}

function normalizeInputBytes(data) {
  if (typeof data === "string") return new TextEncoder().encode(data);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (data?.buffer instanceof ArrayBuffer && typeof data.byteOffset === "number" && typeof data.byteLength === "number") {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  if (data instanceof Uint8Array) return data;
  if (data) return new Uint8Array(data);
  return new Uint8Array(0);
}

function bytesToHex(bytes) {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function buildUnixFsInternalNodeCidV1(children, mhCode = MULTIHASH_SHA2_256) {
  const pbLinks = [];
  const blockSizesParts = [];
  let totalFileSize = 0;
  let childrenTsizeSum = 0;
  for (const child of children) {
    pbLinks.push(encodePbLink(child.cidBytes, child.tsize));
    blockSizesParts.push(new Uint8Array([0x20]), encodeVarint(child.fileSize));
    totalFileSize += child.fileSize;
    childrenTsizeSum += child.tsize;
  }
  const unixFsParent = concatBuffers([
    new Uint8Array([0x08, 0x02, 0x18]),
    encodeVarint(totalFileSize),
    ...blockSizesParts,
  ]);
  const dataField = concatBuffers([
    new Uint8Array([0x0a]),
    encodeVarint(unixFsParent.length),
    unixFsParent,
  ]);
  const dagPb = concatBuffers([...pbLinks, dataField]);
  const digest = await computeRawDigestByMultihash(dagPb, mhCode);
  const multihash = concatBuffers([encodeVarint(mhCode), encodeVarint(digest.length), digest]);
  const cidBytes = concatBuffers([new Uint8Array([0x01, 0x70]), multihash]);
  return {
    digest,
    multihash,
    cidBytes,
    tsize: dagPb.length + childrenTsizeSum,
    fileSize: totalFileSize,
  };
}

/**
 * Compute authentic, RFC-compliant IPFS UnixFS CIDv0 (DAG-PB + Multihash 0x12 0x20 + SHA-256)
 * using Kubo's balanced 174-link multi-level DAG-PB tree layout.
 */
export async function computeIpfsCidV0(data) {
  const bytes = normalizeInputBytes(data);

  if (bytes.length <= UNIXFS_CHUNK_SIZE) {
    const dagPbBlock = encodeUnixFsFileNode(bytes);
    const multihash = await sha256Multihash(dagPbBlock);
    return base58Encode(multihash);
  }

  // Build leaf nodes (256 KiB chunks)
  let level = [];
  for (let offset = 0; offset < bytes.length; offset += UNIXFS_CHUNK_SIZE) {
    const chunk = bytes.subarray(offset, Math.min(offset + UNIXFS_CHUNK_SIZE, bytes.length));
    const leafBlock = encodeUnixFsFileNode(chunk);
    const leafMultihash = await sha256Multihash(leafBlock);
    level.push({
      multihash: leafMultihash,
      tsize: leafBlock.length,
      fileSize: chunk.length,
    });
  }

  // Fold levels upward in balanced groups of up to UNIXFS_MAX_LINKS (174), matching Kubo balanced.Layout
  while (level.length > 1) {
    const nextLevel = [];
    for (let i = 0; i < level.length; i += UNIXFS_MAX_LINKS) {
      const group = level.slice(i, i + UNIXFS_MAX_LINKS);
      nextLevel.push(await buildUnixFsInternalNode(group, MULTIHASH_SHA2_256));
    }
    level = nextLevel;
  }

  return base58Encode(level[0].multihash);
}

/**
 * Compute the root digest hex of a Kubo `--cid-version=1` (`--raw-leaves=true`)
 * balanced 174-link UnixFS DAG-PB (`0x70`) tree whose leaf blocks are raw (`0x55`) CIDv1 nodes,
 * parameterized by multihash code (`0x12` SHA2-256, `0x13` SHA2-512, `0xb220` BLAKE2b-256).
 */
export async function computeIpfsCidV1DagPbRawLeavesDigestHex(data, mhCode = MULTIHASH_SHA2_256) {
  const bytes = normalizeInputBytes(data);

  if (bytes.length <= UNIXFS_CHUNK_SIZE) {
    const dagPbBlock = encodeUnixFsFileNode(bytes);
    const digest = await computeRawDigestByMultihash(dagPbBlock, mhCode);
    return bytesToHex(digest);
  }

  // Build raw-leaf CIDv1 nodes (256 KiB chunks, codec=0x55)
  let level = [];
  for (let offset = 0; offset < bytes.length; offset += UNIXFS_CHUNK_SIZE) {
    const chunk = bytes.subarray(offset, Math.min(offset + UNIXFS_CHUNK_SIZE, bytes.length));
    const leafDigest = await computeRawDigestByMultihash(chunk, mhCode);
    const leafMultihash = concatBuffers([encodeVarint(mhCode), encodeVarint(leafDigest.length), leafDigest]);
    const leafCidBytes = concatBuffers([new Uint8Array([0x01, 0x55]), leafMultihash]);
    level.push({
      digest: leafDigest,
      multihash: leafMultihash,
      cidBytes: leafCidBytes,
      tsize: chunk.length,
      fileSize: chunk.length,
    });
  }

  // Fold levels upward in balanced groups of up to UNIXFS_MAX_LINKS (174), matching Kubo balanced.Layout
  while (level.length > 1) {
    const nextLevel = [];
    for (let i = 0; i < level.length; i += UNIXFS_MAX_LINKS) {
      const group = level.slice(i, i + UNIXFS_MAX_LINKS);
      nextLevel.push(await buildUnixFsInternalNodeCidV1(group, mhCode));
    }
    level = nextLevel;
  }

  return bytesToHex(level[0].digest);
}

/**
 * Compute the root digest hex of a Kubo `--cid-version=1 --raw-leaves=false`
 * balanced 174-link UnixFS DAG-PB (`0x70`) tree whose leaf blocks are UnixFS `dag-pb` (`0x70`) CIDv1 nodes,
 * parameterized by multihash code (`0x12` SHA2-256, `0x13` SHA2-512, `0xb220` BLAKE2b-256).
 */
export async function computeIpfsCidV1DagPbUnixFsLeavesDigestHex(data, mhCode = MULTIHASH_SHA2_256) {
  const bytes = normalizeInputBytes(data);

  if (bytes.length <= UNIXFS_CHUNK_SIZE) {
    const dagPbBlock = encodeUnixFsFileNode(bytes);
    const digest = await computeRawDigestByMultihash(dagPbBlock, mhCode);
    return bytesToHex(digest);
  }

  let level = [];
  for (let offset = 0; offset < bytes.length; offset += UNIXFS_CHUNK_SIZE) {
    const chunk = bytes.subarray(offset, Math.min(offset + UNIXFS_CHUNK_SIZE, bytes.length));
    const leafBlock = encodeUnixFsFileNode(chunk);
    const leafDigest = await computeRawDigestByMultihash(leafBlock, mhCode);
    const leafMultihash = concatBuffers([encodeVarint(mhCode), encodeVarint(leafDigest.length), leafDigest]);
    const leafCidBytes = concatBuffers([new Uint8Array([0x01, 0x70]), leafMultihash]);
    level.push({
      digest: leafDigest,
      multihash: leafMultihash,
      cidBytes: leafCidBytes,
      tsize: leafBlock.length,
      fileSize: chunk.length,
    });
  }

  while (level.length > 1) {
    const nextLevel = [];
    for (let i = 0; i < level.length; i += UNIXFS_MAX_LINKS) {
      const group = level.slice(i, i + UNIXFS_MAX_LINKS);
      nextLevel.push(await buildUnixFsInternalNodeCidV1(group, mhCode));
    }
    level = nextLevel;
  }

  return bytesToHex(level[0].digest);
}

/**
 * Compute an authentic RFC 4648 lowercase Base32 CIDv1 (`b...`) for any contract-accepted
 * codec (`0x55` raw, `0x70` dag-pb, `0x71` dag-cbor) and multihash (`0x12`, `0x13`, `0xb220`).
 */
export async function computeIpfsCidV1(data, { codec = 0x55, mhCode = MULTIHASH_SHA2_256, rawLeaves = true } = {}) {
  let digestHex;
  if (codec === 0x55 || codec === 0x71) {
    const digest = await computeRawDigestByMultihash(data, mhCode);
    digestHex = bytesToHex(digest);
  } else if (codec === 0x70) {
    digestHex = rawLeaves
      ? await computeIpfsCidV1DagPbRawLeavesDigestHex(data, mhCode)
      : await computeIpfsCidV1DagPbUnixFsLeavesDigestHex(data, mhCode);
  } else {
    throw new Error(`Unsupported CIDv1 codec: 0x${Number(codec).toString(16)}`);
  }
  const digestBytes = new Uint8Array(digestHex.length / 2);
  for (let i = 0; i < digestBytes.length; i++) {
    digestBytes[i] = parseInt(digestHex.slice(i * 2, i * 2 + 2), 16);
  }
  const cidBytes = concatBuffers([
    new Uint8Array([0x01]),
    encodeVarint(codec),
    encodeVarint(mhCode),
    encodeVarint(digestBytes.length),
    digestBytes,
  ]);
  return `b${base32Encode(cidBytes)}`;
}

export const calculateFileCID = computeIpfsCidV0;
