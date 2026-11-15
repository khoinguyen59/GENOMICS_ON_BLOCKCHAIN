import { computeIpfsCidV0, encodeUnixFsFileNode, base58Encode } from "../../ipfs/pinata_uploader.js";

async function run() {
  console.log("=== ADVERSARIAL TEST 5: IPFS MULTIHASH CIDv0 EXACTNESS ===");
  // Test empty file in IPFS:
  // Standard IPFS CIDv0 for empty file: "QmbFMke1KXqnYyBBWxB74N4c5SBnJMVAiMNRcGu6x1AwQH"
  const emptyCid = await computeIpfsCidV0(new Uint8Array(0));
  console.log("Computed CIDv0 for empty file:", emptyCid);
  console.log("Standard CIDv0 for empty file:", "QmbFMke1KXqnYyBBWxB74N4c5SBnJMVAiMNRcGu6x1AwQH");
  const isMatchEmpty = emptyCid === "QmbFMke1KXqnYyBBWxB74N4c5SBnJMVAiMNRcGu6x1AwQH";
  console.log("Empty file CID exact match:", isMatchEmpty ? "PASS" : "FAIL");

  // Test "hello world\n"
  // Canonical IPFS CIDv0 for "echo 'hello world' | ipfs add": "QmT78zSuBmuS4z925WZfrqQ1qHaJ56DQaTfyMUF7F8ff5o"
  const helloCid = await computeIpfsCidV0("hello world\n");
  console.log("Computed CIDv0 for 'hello world\\n':", helloCid);
  console.log("Standard CIDv0 for 'hello world\\n':", "QmT78zSuBmuS4z925WZfrqQ1qHaJ56DQaTfyMUF7F8ff5o");
  const isMatchHello = helloCid === "QmT78zSuBmuS4z925WZfrqQ1qHaJ56DQaTfyMUF7F8ff5o";
  console.log("Hello world (with newline) CID exact match:", isMatchHello ? "PASS" : "FAIL");

  // Test "hello world" (no newline)
  // Canonical IPFS CIDv0 for "echo -n 'hello world' | ipfs add": "Qmf412jQZiuVUtdgnB36FXFX7xg5V6KEbSJ4dpQuhkLyfD"
  const helloNoNewlineCid = await computeIpfsCidV0("hello world");
  console.log("Computed CIDv0 for 'hello world':", helloNoNewlineCid);
  console.log("Standard CIDv0 for 'hello world':", "Qmf412jQZiuVUtdgnB36FXFX7xg5V6KEbSJ4dpQuhkLyfD");
  const isMatchHelloNoNewline = helloNoNewlineCid === "Qmf412jQZiuVUtdgnB36FXFX7xg5V6KEbSJ4dpQuhkLyfD";
  console.log("Hello world (no newline) CID exact match:", isMatchHelloNoNewline ? "PASS" : "FAIL");

  if (!isMatchEmpty || !isMatchHello || !isMatchHelloNoNewline) {
    throw new Error("IPFS CID exactness test failed!");
  }
  console.log("ALL IPFS CANONICAL CIDs PASSED 100%!");
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
