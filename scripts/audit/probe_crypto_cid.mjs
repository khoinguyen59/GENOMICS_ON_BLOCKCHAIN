// Read-only cryptographic & IPFS CID invariant probe (assertive — fails closed with exit(1))
import { computeIpfsCidV0 } from "../../ipfs/pinata_uploader.js";
import {
  generateAsymmetricKeyPair,
  exportPublicKey,
  packageKeyCapsule,
  encryptGenomicData,
  encryptGenomicDataChunked,
} from "../../crypto/client_crypto.js";

const log = (...a) => console.log(...a);
const assert = (cond, msg) => {
  if (!cond) {
    console.error(`[FAIL] ${msg}`);
    process.exit(1);
  }
};

log("== PART A: IPFS CIDv0 known-vector probe ==");
const vectors = [
  { input: "hello world\n", expected: "QmT78zSuBmuS4z925WZfrqQ1qHaJ56DQaTfyMUF7F8ff5o" },
  { input: "hello world", expected: "Qmf412jQZiuVUtdgnB36FXFX7xg5V6KEbSJ4dpQuhkLyfD" },
  { input: "", expected: "QmbFMke1KXqnYyBBWxB74N4c5SBnJMVAiMNRcGu6x1AwQH" },
];
let cidMismatchCount = 0;
for (const v of vectors) {
  const got = await computeIpfsCidV0(v.input);
  const matched = got === v.expected;
  if (!matched) cidMismatchCount++;
  log(`  input=${JSON.stringify(v.input)} got=${got} knownIPFS=${v.expected} MATCH=${matched}`);
}
assert(cidMismatchCount === 0, `${cidMismatchCount} IPFS CIDv0 reference vector(s) mismatched!`);

const emptyCid = await computeIpfsCidV0(new Uint8Array(0));
assert(
  emptyCid === "QmbFMke1KXqnYyBBWxB74N4c5SBnJMVAiMNRcGu6x1AwQH" && emptyCid.length === 46 && emptyCid.startsWith("Qm"),
  `Unexpected empty-file CIDv0: ${emptyCid}`
);
log("  empty-file cid:", emptyCid, "len:", emptyCid.length, "starts Qm:", emptyCid.startsWith("Qm"));

log("\n== PART B: WebCrypto RSA-OAEP extractability semantics (INV-09) ==");
const kp = await generateAsymmetricKeyPair(false);
assert(kp.privateKey.extractable === false, "INV-09 violation: RSA-OAEP privateKey must be non-extractable!");
assert(kp.publicKey.extractable === true, "Expected RSA-OAEP publicKey to remain exportable per W3C WebCrypto spec!");
const pubJwk = await exportPublicKey(kp.publicKey);
assert(typeof pubJwk === "string" && pubJwk.includes('"kty":"RSA"'), "exportPublicKey(nonExtractableKeyPair.publicKey) must return valid RSA JWK!");
log("  privateKey.extractable =", kp.privateKey.extractable, "| publicKey.extractable =", kp.publicKey.extractable, "| exportPublicKey = PASS");

log("\n== PART C: Owner key capsule packaging with INV-09 non-extractable private key ==");
const sessionHex = "aa".repeat(32);
const ownerCapsule = await packageKeyCapsule(sessionHex, pubJwk, "0xabc", "0xabc");
assert(typeof ownerCapsule === "string" && ownerCapsule.length > 0, "Owner capsule packaging failed!");
assert(!ownerCapsule.includes(sessionHex), "Owner capsule leaked plaintext session key!");
log("  ownerCapsuleSaved = true (len=" + ownerCapsule.length + ")");

log("\n== PART D: Extractable control path & capsule structure ==");
const kp2 = await generateAsymmetricKeyPair(true);
const pub2 = await exportPublicKey(kp2.publicKey);
const cap2 = await packageKeyCapsule("bb".repeat(32), pub2, "0x1", "0x1");
const parsed = JSON.parse(cap2);
const expectedKeys = ["version", "algorithm", "owner", "recipient", "keyCipher", "timestamp"];
for (const k of expectedKeys) {
  assert(Object.prototype.hasOwnProperty.call(parsed, k), `Capsule missing required field '${k}'`);
}
assert(typeof parsed.keyCipher === "string" && parsed.keyCipher.length >= 256, `Unexpected keyCipher len: ${parsed.keyCipher?.length}`);
assert(!cap2.includes("bbbbbbbb"), "Capsule leaked plaintext session key!");
log("  capsule keys:", Object.keys(parsed).join(","), " keyCipher len:", parsed.keyCipher.length, " plaintextLeak: false");

log("\n== PART E: AES-256-GCM unique IV generation across monolithic & GNC2 chunked streaming ==");
const enc = await encryptGenomicData("raw-genomic-payload");
const enc2b = await encryptGenomicData(new Uint8Array([1, 2, 3]), enc.activeKey);
assert(/^[0-9a-f]{24}$/.test(enc.ivHex) && /^[0-9a-f]{24}$/.test(enc2b.ivHex), "Expected 12-byte (24-hex) AES-GCM IVs!");
assert(enc.ivHex !== enc2b.ivHex, "CRITICAL IV collision detected under reused AES-GCM key!");
assert(/^[0-9a-f]{64}$/.test(enc.keyHex), "Expected 256-bit (64-hex) AES session key export!");
const chunked = await encryptGenomicDataChunked("x".repeat(65536 * 3));
assert(chunked.chunkCount === 3, `Expected chunkCount=3 for 192 KiB payload, got ${chunked.chunkCount}`);
assert(/^[0-9a-f]{64}$/.test(chunked.keyHex), "Expected 256-bit (64-hex) chunked AES session key!");
log("  raw iv:", enc.ivHex, " summary iv:", enc2b.ivHex, " ivDiffer: true | chunked chunkCount:", chunked.chunkCount);
log("\n[PASS] probe_crypto_cid.mjs — all cryptographic & IPFS CIDv0 invariants verified.");
