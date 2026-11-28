/**
 * @file index.js
 * @description Master barrel export for the modular Genomics Cryptographic Suite.
 * @module crypto
 */

export * from "./core/symmetric.js";
export * from "./core/asymmetric.js";
export * from "./core/streaming.js";
export * from "./storage/key_vault.js";
export * from "./reporting/pdf_generator.js";

// NOTE: ./zk/groth16_prover.js is intentionally NOT re-exported here. It depends on `ethers` (and `snarkjs` at proving time),
// while every module above only needs the Web Crypto API; keeping it out of this barrel avoids pulling those libraries into
// bundles that do not use zk proofs. Import it explicitly: import { ... } from "<path>/crypto/zk/groth16_prover.js".
