import { generateAsymmetricKeyPair, createWalletKeyBackup } from "../../crypto/client_crypto.js";

async function run() {
  console.log("=== ADVERSARIAL TEST 1: NON-EXTRACTABLE KEY BACKUP ===");
  try {
    const kp = await generateAsymmetricKeyPair(false); // non-extractable!
    if (kp.privateKey.extractable !== false) {
      console.error("[FAIL] Keypair privateKey must have extractable === false!");
      process.exit(1);
    }
    console.log("Generated kp with extractable=false. PrivateKey extractable:", kp.privateKey.extractable);
    
    // Fake signer
    const fakeSigner = {
      signMessage: async () =>
        "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1b"
    };
    
    let threw = false;
    try {
      await createWalletKeyBackup(fakeSigner, "0x1111111111111111111111111111111111111111", kp);
    } catch (e) {
      threw = true;
      const errorMsg = String(e.message || e);
      if (!errorMsg.includes("not extractable") && !errorMsg.includes("INVARIANT-09")) {
        console.error(`[FAIL] Unexpected error message: ${errorMsg}`);
        process.exit(1);
      }
      console.log("[PASS] Correctly rejected backup on non-extractable private key with message:", errorMsg);
    }

    if (!threw) {
      console.error("[FAIL] Expected createWalletKeyBackup to throw because privateKey is non-extractable, but it succeeded!");
      process.exit(1);
    }

    console.log("=== ADVERSARIAL TEST 1: PASSED (Non-extractable key security enforced) ===");
  } catch (err) {
    console.error("[FATAL] Test error:", err);
    process.exit(1);
  }
}

run();
