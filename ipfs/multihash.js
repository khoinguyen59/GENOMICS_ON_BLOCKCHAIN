/**
 * @file multihash.js
 * @description RFC Multihash & IPFS UnixFS DAG-PB CIDv0 calculation engine.
 */
const cryptoObj = typeof window !== "undefined" && window.crypto ? window.crypto : globalThis.crypto;
export const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

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

export function encodeVarint(val) {
  const bytes = [];
  let n = val;
  while (n >= 0x80) {
    bytes.push((n & 0x7f) | 0x80);
    n >>>= 7;
  }
  bytes.push(n);
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

async function sha256Multihash(blockBytes) {
  const hashBuffer = await cryptoObj.subtle.digest("SHA-256", blockBytes);
  const multihash = new Uint8Array(34);
  multihash[0] = 0x12;
  multihash[1] = 0x20;
  multihash.set(new Uint8Array(hashBuffer), 2);
  return multihash;
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

/** Compute authentic, RFC-compliant IPFS UnixFS CIDv0 (DAG-PB + Multihash 0x12 0x20 + SHA-256) */
export async function computeIpfsCidV0(data) {
  let bytes;
  if (typeof data === "string") bytes = new TextEncoder().encode(data);
  else if (data instanceof ArrayBuffer) bytes = new Uint8Array(data);
  else if (data?.buffer instanceof ArrayBuffer && typeof data.byteOffset === "number" && typeof data.byteLength === "number") {
    bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  } else if (data instanceof Uint8Array) bytes = data;
  else if (data) bytes = new Uint8Array(data);
  else bytes = new Uint8Array(0);

  if (bytes.length <= UNIXFS_CHUNK_SIZE) {
    const dagPbBlock = encodeUnixFsFileNode(bytes);
    const multihash = await sha256Multihash(dagPbBlock);
    return base58Encode(multihash);
  }

  // Multi-block UnixFS DAG-PB tree for files > 256 KB
  const pbLinks = [];
  const blockSizesParts = [];
  for (let offset = 0; offset < bytes.length; offset += UNIXFS_CHUNK_SIZE) {
    const chunk = bytes.subarray(offset, Math.min(offset + UNIXFS_CHUNK_SIZE, bytes.length));
    const leafBlock = encodeUnixFsFileNode(chunk);
    const leafMultihash = await sha256Multihash(leafBlock);
    pbLinks.push(encodePbLink(leafMultihash, leafBlock.length));
    blockSizesParts.push(new Uint8Array([0x20]), encodeVarint(chunk.length));
  }

  const unixFsParent = concatBuffers([
    new Uint8Array([0x08, 0x02, 0x18]),
    encodeVarint(bytes.length),
    ...blockSizesParts,
  ]);
  const dataField = concatBuffers([new Uint8Array([0x0a]), encodeVarint(unixFsParent.length), unixFsParent]);
  const rootDagPb = concatBuffers([...pbLinks, dataField]);
  const rootMultihash = await sha256Multihash(rootDagPb);
  return base58Encode(rootMultihash);
}

export const calculateFileCID = computeIpfsCidV0;

