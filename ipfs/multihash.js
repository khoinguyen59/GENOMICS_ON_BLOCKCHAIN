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

  const dagPbBlock = encodeUnixFsFileNode(bytes);
  const hashBuffer = await cryptoObj.subtle.digest("SHA-256", dagPbBlock);
  const multihash = new Uint8Array(34);
  multihash[0] = 0x12;
  multihash[1] = 0x20;
  multihash.set(new Uint8Array(hashBuffer), 2);
  return base58Encode(multihash);
}

export const calculateFileCID = computeIpfsCidV0;
