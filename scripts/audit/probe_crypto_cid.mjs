// Agent4 read-only cryptographic & CID probe (no project files modified)
import { computeIpfsCidV0 } from "../../ipfs/pinata_uploader.js";
import { generateAsymmetricKeyPair, exportPublicKey, packageKeyCapsule } from "../../crypto/client_crypto.js";

const log = (...a) => console.log(...a);

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
if (cidMismatchCount > 0) {
  console.error(`[FAIL] ${cidMismatchCount} IPFS CIDv0 reference vector(s) mismatched!`);
  process.exit(1);
}
// raw multihash dump for empty node
const emptyCid = await computeIpfsCidV0(new Uint8Array(0));
log("  empty-file cid:", emptyCid, "len:", emptyCid.length, "starts Qm:", emptyCid.startsWith("Qm"));

log("\n== PART B: WebCrypto RSA-OAEP extractability semantics (INV-09 vs exportPublicKey) ==");
const kp = await generateAsymmetricKeyPair(false);
log("  privateKey.extractable =", kp.privateKey.extractable);
log("  publicKey.extractable  =", kp.publicKey.extractable, "   <-- W3C generateKey applies the flag to BOTH keys");
let exportErr = null;
let pubJwk = null;
try {
  pubJwk = await exportPublicKey(kp.publicKey);
} catch (e) {
  exportErr = e;
}
log("  exportPublicKey(nonExtractablePub) threw =", exportErr ? `${exportErr.name}: ${exportErr.message}` : "NO (succeeded)");

log("\n== PART C: does the publish path persist an owner capsule? (simulates datasetService.js:111-119) ==");
let ownerCapsuleSaved = false;
try {
  const ownerPubJwk = await exportPublicKey(kp.publicKey);
  const capsule = await packageKeyCapsule("aa".repeat(32), ownerPubJwk, "0xabc", "0xabc");
  ownerCapsuleSaved = typeof capsule === "string" && capsule.length > 0;
} catch (e) {
  log("  caught (silently console.warn'ed in prod):", e.name, "->", e.message);
}
log("  ownerCapsuleSaved =", ownerCapsuleSaved, "(false => key permanently lost after page reload)");

log("\n== PART D: extractable=true control path works ==");
const kp2 = await generateAsymmetricKeyPair(true);
const pub2 = await exportPublicKey(kp2.publicKey);
const cap2 = await packageKeyCapsule("bb".repeat(32), pub2, "0x1", "0x1");
const parsed = JSON.parse(cap2);
log("  capsule keys:", Object.keys(parsed).join(","), " keyCipher len:", parsed.keyCipher.length);
log("  capsule contains plaintext session key? ", cap2.includes("bbbbbbbb"));

log("\n== PART E: same AES key encrypts 2 artifacts (datasetService.js:82-85) - IV collision check ==");
const { encryptGenomicData, encryptGenomicDataChunked } = await import("../../crypto/client_crypto.js");
const enc = await encryptGenomicData("raw-genomic-payload");
const enc2b = await encryptGenomicData(new Uint8Array([1,2,3]), enc.activeKey);
log("  raw iv:", enc.ivHex, " summary iv:", enc2b.ivHex, " sameKey:", true, " ivDiffer:", enc.ivHex !== enc2b.ivHex);
const chunked = await encryptGenomicDataChunked("x".repeat(65536 * 3));
log("  chunked chunkCount:", chunked.chunkCount, "-> 3 random IVs + 1 summary IV under the SAME key (no counter/mutex).");
log("  key exported to JS memory as hex by both APIs:", /^[0-9a-f]{64}$/.test(enc.keyHex));
