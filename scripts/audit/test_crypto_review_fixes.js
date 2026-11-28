/**
 * @file test_crypto_review_fixes.mjs
 * @description Regression tests for the crypto-module review fixes. Plain Node (no Hardhat needed):
 *   node scripts/audit/test_crypto_review_fixes.mjs
 *
 * Covers: key_vault scope handling, symmetric.verifyDataIntegrity guard, streaming input handling,
 * pdf_generator wrapping / no hard-coded interpretation, groth16_prover bountyId + proof-coordinate validation.
 */
import assert from "node:assert/strict";
import {
  clearVaultMemoryCache,
  setActiveVaultAccount,
  saveOwnerCapsulePersistent,
  loadOwnerCapsulePersistent,
  saveBuyerCapsulePersistent,
  loadBuyerCapsulePersistent,
  getAllOwnerCapsulesPersistent,
  getAllBuyerCapsulesPersistent,
  savePersistentKeyPair,
  loadPersistentKeyPair,
  generateAsymmetricKeyPair,
  verifyDataIntegrity,
  computeDataHash,
  encryptGenomicDataChunked,
  decryptGenomicDataChunked,
  generateClinicalPdfReport,
  wrapPdfText,
} from "../../crypto/client_crypto.js";

let failures = 0;
let passes = 0;
async function test(name, fn) {
  try {
    await fn();
    passes++;
    console.log(`  [PASS] ${name}`);
  } catch (e) {
    failures++;
    console.error(`  [FAIL] ${name}\n         ${e?.message || e}`);
  }
}

const SELLER = "0xAAAA000000000000000000000000000000000001";
const BUYER = "0xBBBB000000000000000000000000000000000002";
const CID_A = "QmCidOwnerA";
const CID_B = "QmCidBuyerB";
const capOwner = JSON.stringify({ version: "GENO-ASYM-RSA-OAEP-v2", owner: SELLER, keyCipher: "ab".repeat(256) });
const capBuyer = JSON.stringify({ version: "GENO-ASYM-RSA-OAEP-v2", recipient: BUYER, keyCipher: "cd".repeat(256) });

console.log("=== key_vault ===");
await test("loadPersistentKeyPair is a read path: it never switches the active vault account", async () => {
  clearVaultMemoryCache();
  await saveOwnerCapsulePersistent(CID_A, capOwner, SELLER); // write path: active = SELLER
  assert.equal(await loadOwnerCapsulePersistent(CID_A), capOwner);
  assert.equal(await loadPersistentKeyPair(BUYER), null); // "check another wallet"
  assert.equal(await loadOwnerCapsulePersistent(CID_A), capOwner, "default scope must still be SELLER");
  const kp = await generateAsymmetricKeyPair(false);
  await savePersistentKeyPair(BUYER, kp); // write path: active = BUYER
  setActiveVaultAccount(SELLER);
  const loaded = await loadPersistentKeyPair(BUYER);
  assert.ok(loaded && loaded.privateKey, "BUYER key pair must be readable");
  assert.equal(await loadOwnerCapsulePersistent(CID_A), capOwner, "reading BUYER's key pair must not move the scope");
});

await test("invalid account: load* fail closed, savePersistentKeyPair throws a controlled TypeError", async () => {
  for (const bad of [undefined, null, "", "   ", 123, {}, []]) {
    assert.equal(await loadPersistentKeyPair(bad), null, `load(${JSON.stringify(bad)})`);
    await assert.rejects(() => savePersistentKeyPair(bad, {}), TypeError, `save(${JSON.stringify(bad)})`);
  }
  await assert.rejects(() => savePersistentKeyPair(SELLER, null), TypeError);
  await assert.rejects(() => savePersistentKeyPair(SELLER, { publicKey: {} }), TypeError, "missing privateKey");
});

await test("setActiveVaultAccount selects (trimmed, lower-cased) and clears the session scope", async () => {
  clearVaultMemoryCache();
  await saveBuyerCapsulePersistent(CID_B, capBuyer, BUYER);
  assert.equal(setActiveVaultAccount(`  ${BUYER.toUpperCase().replace("0X", "0x")} `), BUYER.toLowerCase());
  assert.equal(await loadBuyerCapsulePersistent(CID_B), capBuyer);
  assert.equal(setActiveVaultAccount(null), "");
  assert.equal(await loadBuyerCapsulePersistent(CID_B), null, "cleared scope must fail closed");
  assert.equal(setActiveVaultAccount(42), "");
});

await test("pinned behaviour (RemediationRegression R18-06k) is unchanged", async () => {
  clearVaultMemoryCache();
  await saveOwnerCapsulePersistent(CID_A, capOwner, SELLER);
  await saveBuyerCapsulePersistent(CID_B, capBuyer, BUYER);
  assert.equal(await loadOwnerCapsulePersistent(CID_A, ""), null);
  assert.equal(await loadBuyerCapsulePersistent(CID_B, ""), null);
  assert.deepEqual(await getAllOwnerCapsulesPersistent(""), []);
  assert.deepEqual(await getAllBuyerCapsulesPersistent(""), []);
  await saveOwnerCapsulePersistent(CID_A, capOwner, SELLER);
  assert.equal(await loadOwnerCapsulePersistent(CID_A, BUYER), null);
  assert.equal(await loadOwnerCapsulePersistent(CID_A), capOwner);
  assert.equal(await loadBuyerCapsulePersistent(CID_B, SELLER), null);
  assert.deepEqual(await getAllOwnerCapsulesPersistent(BUYER), []);
  assert.deepEqual(await getAllBuyerCapsulesPersistent(SELLER), []);
  assert.equal(await loadOwnerCapsulePersistent(CID_A, SELLER), capOwner);
  assert.equal(await loadBuyerCapsulePersistent(CID_B, BUYER), capBuyer);
  clearVaultMemoryCache();
  assert.equal(await loadBuyerCapsulePersistent(CID_B, null), null);
  assert.deepEqual(await getAllBuyerCapsulesPersistent(null), []);
});

await test("pinned behaviour (WorldClass): account-less save/load/getAll still works in the shared scope", async () => {
  clearVaultMemoryCache();
  await saveOwnerCapsulePersistent("QmNoAccount", "opaque-capsule-without-owner");
  assert.equal(await loadOwnerCapsulePersistent("QmNoAccount"), "opaque-capsule-without-owner");
  const all = await getAllOwnerCapsulesPersistent();
  assert.ok(all.some((x) => x.rawCid === "QmNoAccount"));
});

await test("load and getAll agree on a legacy 'global:' record (owner + buyer), without leaking to other accounts", async () => {
  clearVaultMemoryCache();
  await saveOwnerCapsulePersistent("QmLegacyOwner", capOwner, "global");
  await saveBuyerCapsulePersistent("QmLegacyBuyer", capBuyer, "global");
  const listedOwner = await getAllOwnerCapsulesPersistent(SELLER);
  assert.ok(listedOwner.some((x) => x.rawCid === "QmLegacyOwner"), "getAll lists it (existing behaviour)");
  assert.equal(await loadOwnerCapsulePersistent("QmLegacyOwner", SELLER), capOwner, "load must now agree with getAll");
  assert.equal(await loadOwnerCapsulePersistent("QmLegacyOwner", BUYER), null, "other account must not see it");
  const listedBuyer = await getAllBuyerCapsulesPersistent(BUYER);
  assert.ok(listedBuyer.some((x) => x.rawCid === "QmLegacyBuyer"));
  assert.equal(await loadBuyerCapsulePersistent("QmLegacyBuyer", BUYER), capBuyer);
  assert.equal(await loadBuyerCapsulePersistent("QmLegacyBuyer", SELLER), null);
});

console.log("=== symmetric.verifyDataIntegrity ===");
await test("valid hash -> true, wrong hash -> false (0x prefix optional)", async () => {
  const data = new TextEncoder().encode("genome");
  const h = await computeDataHash(data);
  assert.equal(await verifyDataIntegrity(data, h), true);
  assert.equal(await verifyDataIntegrity(data, h.replace(/^0x/, "")), true);
  assert.equal(await verifyDataIntegrity(data, "0x" + "00".repeat(32)), false);
});
await test("null / undefined / empty / non-string expectedHash throw an explicit TypeError", async () => {
  for (const bad of [null, undefined, "", "   ", 123, {}]) {
    await assert.rejects(() => verifyDataIntegrity(new Uint8Array([1]), bad), /expectedHash must be a non-empty hex string/);
  }
});

console.log("=== streaming.encryptGenomicDataChunked ===");
await test("unsupported input types throw instead of silently encrypting an empty file", async () => {
  for (const bad of [null, undefined, 12345, { foo: "bar" }, true]) {
    await assert.rejects(() => encryptGenomicDataChunked(bad), /unsupported data type/);
  }
});
await test("empty Uint8Array / empty string are still valid inputs", async () => {
  for (const empty of [new Uint8Array(0), ""]) {
    const enc = await encryptGenomicDataChunked(empty);
    const dec = await decryptGenomicDataChunked(enc.payload, enc.keyHex, { asString: false });
    assert.equal(dec.length, 0);
  }
});
await test("non-Uint8 views are encrypted by their underlying bytes (no element-value truncation)", async () => {
  const u16 = new Uint16Array([0x0102, 0x0304, 0xff00]);
  const enc = await encryptGenomicDataChunked(u16);
  const dec = await decryptGenomicDataChunked(enc.payload, enc.keyHex, { asString: false });
  assert.deepEqual(Array.from(dec), Array.from(new Uint8Array(u16.buffer)));
  const dv = new DataView(new Uint8Array([9, 8, 7, 6]).buffer);
  const enc2 = await encryptGenomicDataChunked(dv);
  const dec2 = await decryptGenomicDataChunked(enc2.payload, enc2.keyHex, { asString: false });
  assert.deepEqual(Array.from(dec2), [9, 8, 7, 6]);
});
await test("string and Uint8Array round-trips keep working", async () => {
  const s = "##fileformat=VCFv4.2\nchr1\t100\trs1\tA\tG";
  const enc = await encryptGenomicDataChunked(s, { chunkSize: 7 });
  assert.equal(await decryptGenomicDataChunked(enc.payload, enc.keyHex), s);
  const bytes = crypto.getRandomValues(new Uint8Array(1000));
  const enc2 = await encryptGenomicDataChunked(bytes, { chunkSize: 128 });
  assert.deepEqual(await decryptGenomicDataChunked(enc2.payload, enc2.keyHex, { asString: false }), bytes);
});

console.log("=== pdf_generator ===");
const pdfText = (u8) => new TextDecoder("latin1").decode(u8);
await test("PDF structure is valid and unchanged (header, xref, EOF)", async () => {
  const t = pdfText(generateClinicalPdfReport({ subjectId: "S", disease: "d", gene: "g", variant: "v" }));
  assert.ok(t.startsWith("%PDF-1.4"));
  assert.ok(t.includes("xref") && t.includes("%%EOF"));
});
await test("interpretation is no longer hard-coded to a metabolic/ALDH2 narrative", async () => {
  for (const gene of ["HERC2", "BRCA1"]) {
    const t = pdfText(generateClinicalPdfReport({ subjectId: "S", disease: "d", gene, variant: "x" }));
    assert.ok(!/metabolic polymorphism/i.test(t));
    assert.ok(!/1000 Genomes Project & dbSNP/.test(t));
    assert.ok(t.includes(gene));
  }
});
await test("calling without arguments does not silently produce an ALDH2/rs671 report", async () => {
  const t = pdfText(generateClinicalPdfReport());
  assert.ok(!/ALDH2|rs671|1000G_KHV_01/.test(t));
  assert.ok(t.includes("Not specified"));
});
await test("caller-supplied annotations and integrity anchor are rendered", async () => {
  const t = pdfText(
    generateClinicalPdfReport({
      subjectId: "S", disease: "d", gene: "HERC2", variant: "rs12913832",
      annotations: ["Regulatory variant associated with iris pigmentation."],
      integrity: { rawDataHash: "0x" + "ab".repeat(32), rawCid: "QmExample", chainId: 31337 },
    })
  );
  assert.ok(t.includes("iris pigmentation"));
  assert.ok(t.includes("0x" + "ab".repeat(32)) && t.includes("QmExample") && t.includes("31337"));
});
await test("long values are wrapped inside the page, never emitted as a single overflowing line", async () => {
  const long = "word ".repeat(60).trim();
  const t = pdfText(generateClinicalPdfReport({ subjectId: "S", disease: long, gene: "g", variant: "v" }));
  const lines = [...t.matchAll(/\(([^)]*)\) Tj/g)].map((m) => m[1]);
  assert.ok(lines.length > 8, "multi-line output expected");
  // every text line must fit the usable width (512pt) at its font size; Helvetica avg char ~ 0.55em at 11pt = ~6pt
  assert.ok(lines.every((l) => l.length <= 120), "no line may exceed ~120 chars");
});
await test("wrapPdfText: wrap / hard-split / truncate / empty", async () => {
  const m = (s) => s.length * 10;
  assert.deepEqual(wrapPdfText("aaa bbb ccc ddd", m, 75, 5), ["aaa bbb", "ccc ddd"]);
  assert.deepEqual(wrapPdfText("x".repeat(25), m, 100, 5), ["x".repeat(10), "x".repeat(10), "x".repeat(5)]);
  assert.deepEqual(wrapPdfText("aaaa bbbb cccc dddd eeee", m, 90, 2), ["aaaa bbbb", "cccc d..."]);
  assert.deepEqual(wrapPdfText("", m, 100, 2), [""]);
});
await test("special characters are escaped in the content stream", async () => {
  const t = pdfText(generateClinicalPdfReport({ subjectId: "a(b)c\\d", disease: "d", gene: "g", variant: "v" }));
  assert.ok(t.includes("a\\(b\\)c\\\\d"));
});

console.log("=== groth16_prover (needs `ethers`) ===");
let zk = null;
try {
  zk = await import("../../crypto/zk/groth16_prover.js");
} catch (e) {
  console.log(`  [SKIP] zk module could not be imported (${e?.code || e?.message}); install dependencies and re-run.`);
}
if (zk) {
  const base = {
    donorAddress: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
    targetTraitId: "0x" + "11".repeat(32),
    witnessSecret: "unit-test-secret",
    verifierAddress: "0x5FbDB2315678afecb367f032d93F642f64180aa3",
    chainId: 31337,
    vkEpoch: 1,
  };
  await test("parseBountyId accepts valid ids (number, bigint, decimal/hex string)", async () => {
    assert.equal(zk.parseBountyId(7), 7n);
    assert.equal(zk.parseBountyId(7n), 7n);
    assert.equal(zk.parseBountyId("7"), 7n);
    assert.equal(zk.parseBountyId(" 0x10 "), 16n);
    assert.equal(zk.parseBountyId((1n << 200n).toString()), 1n << 200n);
  });
  await test("parseBountyId rejects NaN-like / fractional / zero / negative / unsafe values", async () => {
    for (const bad of ["abc", "1.5", "", "  ", 0, "0", -3, 1.5, NaN, Infinity, 2 ** 60, null, undefined, {}, [], 1n << 256n]) {
      assert.throws(() => zk.parseBountyId(bad), /Valid bountyId \(>= 1\) is required\./, String(bad));
    }
  });
  await test("buildGenomicWitnessBinary: 'abc' / '1.5' no longer slip past the guard (clear error, not a BigInt SyntaxError)", async () => {
    for (const bad of ["abc", "1.5", "0", 0, -1, undefined, null]) {
      assert.throws(
        () => zk.buildGenomicWitnessBinary({ ...base, bountyId: bad }),
        /Valid bountyId \(>= 1\) is required\./,
        String(bad)
      );
    }
  });
  await test("buildGenomicWitnessBinary still builds (and self-verifies the R1CS) for valid bountyId forms", async () => {
    const a = zk.buildGenomicWitnessBinary({ ...base, bountyId: 5 });
    const b = zk.buildGenomicWitnessBinary({ ...base, bountyId: "5" });
    const c = zk.buildGenomicWitnessBinary({ ...base, bountyId: 5n });
    assert.equal(a.wtns.length, b.wtns.length);
    assert.deepEqual(Array.from(a.wtns), Array.from(b.wtns));
    assert.deepEqual(Array.from(a.wtns), Array.from(c.wtns));
    assert.equal(a.publicSignals.length, 3);
  });
  await test("computeDomainHash validates numeric inputs with readable errors", async () => {
    const args = { targetTraitId: base.targetTraitId, donorAddress: base.donorAddress, verifierAddress: base.verifierAddress, chainId: 31337, vkEpoch: 1 };
    assert.equal(typeof zk.computeDomainHash({ ...args, bountyId: 1 }), "bigint");
    assert.throws(() => zk.computeDomainHash({ ...args, bountyId: "abc" }), /Invalid bountyId/);
    assert.throws(() => zk.computeDomainHash({ ...args, bountyId: 1, chainId: "x" }), /Invalid chainId/);
  });

  const goodProof = { a: ["1", "2"], b: [["3", "4"], ["5", "6"]], c: ["7", "8"] };
  await test("parseExternalGroth16Proof: valid proofs (Solidity order and raw snarkjs order) parse as before", async () => {
    const sol = zk.parseExternalGroth16Proof({ proof: goodProof });
    assert.deepEqual(sol.proof, { a: ["1", "2"], b: [["3", "4"], ["5", "6"]], c: ["7", "8"] });
    const raw = zk.parseExternalGroth16Proof({ pi_a: ["1", "2", "1"], pi_b: [["3", "4"], ["5", "6"], ["1", "0"]], pi_c: ["7", "8", "1"] });
    assert.deepEqual(raw.proof.b, [["4", "3"], ["6", "5"]], "snarkjs G2 limbs are swapped to EIP-197 order");
    assert.deepEqual(raw.proof.a, ["1", "2"]);
  });
  await test("parseExternalGroth16Proof: hex coordinates are normalised to decimal strings", async () => {
    const p = zk.parseExternalGroth16Proof({ proof: { ...goodProof, a: ["0x1f", "2"] } });
    assert.deepEqual(p.proof.a, ["31", "2"]);
  });
  await test("parseExternalGroth16Proof: malformed / out-of-field coordinates fail early with a readable error", async () => {
    const P = zk.P_MOD;
    const bads = ["abc", "1.5", "", "-1", P.toString(), (P + 1n).toString(), null, undefined, {}, 1.5];
    for (const bad of bads) {
      for (const where of ["a", "b", "c"]) {
        const proof = JSON.parse(JSON.stringify(goodProof));
        if (where === "b") proof.b[1][0] = bad; else proof[where][1] = bad;
        assert.throws(() => zk.parseExternalGroth16Proof({ proof: { ...proof, b: proof.b } }), /Invalid Groth16 proof: .* must be an integer in \[0, p\)/, `${where}=${String(bad)}`);
      }
    }
    // p - 1 is the largest valid coordinate
    assert.doesNotThrow(() => zk.parseExternalGroth16Proof({ proof: { ...goodProof, a: [(P - 1n).toString(), "0"] } }));
  });
  await test("parseExternalGroth16Proof: bountyId / vkEpoch are validated, never NaN", async () => {
    assert.equal(zk.parseExternalGroth16Proof({ proof: goodProof, bountyId: "12", vkEpoch: 0 }).bountyId, 12);
    assert.equal(zk.parseExternalGroth16Proof({ proof: goodProof }).bountyId, null);
    assert.equal(zk.parseExternalGroth16Proof({ proof: goodProof, vkEpoch: 0 }).vkEpoch, 0);
    for (const bad of ["abc", "1.5", 0, -2]) {
      assert.throws(() => zk.parseExternalGroth16Proof({ proof: goodProof, bountyId: bad }), /bountyId must be an integer >= 1/, String(bad));
    }
    assert.throws(() => zk.parseExternalGroth16Proof({ proof: goodProof, vkEpoch: "x" }), /vkEpoch must be an integer >= 0/);
  });
}

console.log(`\nRESULT: ${passes} passed, ${failures} failed.`);
process.exit(failures === 0 ? 0 : 1);
