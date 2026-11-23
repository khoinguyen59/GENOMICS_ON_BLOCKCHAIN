# Graph Report - BLOCKCHAIN (Synchronized 2026-11-24)

## Graph Freshness
- **Built from code/docs commit:** `5805a41` (`5805a41e7ece45fb4e3d5a76ed6850659bdebd1b`) — committed in `HEAD` immediately following `5805a41` (`git rev-parse --short HEAD~1` == `5805a41`).
- **Generation method:** Deterministic live source-tree AST/corpus synchronization on git-tracked files (the `graphify` CLI binary is not installed in this local environment; `graph.json` was not regenerated via graphify CLI).

## Corpus Check
- **Tracked repository files:** 322 total (270 text/code/config/docs/genomic files, ~576,766 words, including canonical `docs/` and `graphify-out/GRAPH_REPORT.md`)
- **Extracted top-level code symbols (Solidity contracts/interfaces/libraries, exported JS/JSX declarations, module-level Python classes/defs):** 412
- **Solidity source files:** 16 (7 production contracts + 4 interfaces + 2 storage bases + 3 test mocks; `contracts/` untouched in Phase 5)
- **Automated Mocha test suites:** 33 files (494 passing, 0 failing)
- **Frontend JS/JSX modules:** 43 files (`frontend/src/`)
- **Client Cryptography & ZK modules:** 8 files (`crypto/`)
- **IPFS & Phenopackets v2 modules:** 5 files (`ipfs/`)
- **Python runtime/audit/gateway scripts:** 18 files
- **VPS Private IPFS deployment stack:** 11 files (`deploy/`)
- **Canonical Documentation & Evidence files:** 35 files (`docs/`, incl. 22 fresh live WCAG PNGs + `slither_latest.json` + `ui_ux_axe_report.json`)

## Architecture Module Topology (Verified Live)

### 1. On-Chain EVM Protocol (`contracts/`, Solidity `0.8.24` Cancun + `viaIR`)
- **Core Registry & Storage:** `GenomicsRegistry.sol` (`21,543 B`), `registry/GenomicsRegistryStorage.sol`, `registry/GenomicsMetadataStore.sol` (`10,800 B`), `registry/GenomicsEscrowEngine.sol` (`8,735 B`)
- **Tokenomics & Governance:** `GenomicToken.sol` (`5,371 B`), `GenomicNFT.sol` (`15,667 B`, EIP-2981), `GenomicTimelock.sol` (`5,279 B`, OpenZeppelin `TimelockController`, `admin = 0x0`)
- **Zero-Knowledge Verifier:** `GenomicZkVerifier.sol` (`17,412 B`), `zk/GenomicZkBountyStorage.sol`
- **Interfaces:** `IGenomicsRegistryWorkerSync.sol`, `IGenomicsMetadataErrors.sol` (27 custom errors), `IGenomicZkVerifier.sol`, `IGenomicTokenFaucet.sol`

### 2. Zero-Knowledge Circuit & Artifacts (`circuits/`, `crypto/zk/`, `scripts/zk/`, `frontend/public/zk/`)
- `circuits/genomic_variant_proof.circom` -> `circuits/build/genomic_variant.r1cs` (`66,720 B`, 366 constraints, 3 public inputs, 91-round BN254 MiMC-7)
- `frontend/public/zk/genomic_variant.zkey` (`209,343 B`) & `verification_key.json` (`3,548 B`, `IC=4`)
- `crypto/zk/groth16_prover.js`, `scripts/zk/build_groth16_artifacts.mjs`, `scripts/demo/zk_ceremony_helper.mjs`, `scripts/demo/zk_prover_cli.mjs`

### 3. Client Cryptography, Storage & Phenopackets (`crypto/`, `ipfs/`)
- `crypto/core/symmetric.js` (AES-256-GCM, strict 12B IV validation, fatal UTF-8 decode), `crypto/core/streaming.js` (`GNC2`/`GNC1` 64 KiB, fatal UTF-8 decode), `crypto/core/asymmetric.js` (RSA-OAEP-2048), `crypto/storage/key_vault.js` (IndexedDB v2 + PBKDF2-600k / EIP-191 backup v2, fail-closed account-scoped lookup & zero cross-account fallback scans), `crypto/reporting/pdf_generator.js` (ISO 32000 PDF-1.4)
- `ipfs/multihash.js` (byte-exact Kubo 0.32.1 CIDv0 & CIDv1), `ipfs/kubo_client.js` (URL-parsed local Kubo guards + compile-time `__GENOCHAIN_NON_LOCAL_CHAIN__` stripping), `ipfs/pinata_client.js`, `ipfs/pinata_uploader.js`, `ipfs/phenopacket_builder.js` (GA4GH Phenopackets v2, strict INV-11 benign clamp)

### 4. Private IPFS VPS, SIWE Gateway & Dispatcher (`deploy/`, `scripts/demo/`)
- `deploy/ipfs_access_gateway.py` (SIWE EIP-191 auth, persistent SQLite WAL `NonceStore`, `UploadRateLimiter` with 256 KiB epoch-batched chunked quota checks, post-anchor on-chain `first_registrant` provenance backfill & `403` cross-owner re-upload rejection (`REV-01`), provenance/ownership-gated `private_mhs` anti-censorship (`REV-02`), owner-scoped non-revoked orphan-pin GC with TOCTOU timestamp guards (`REV-03`/`L3-L2`), durable `_gc_pending` & post-GC `pending_provenance_purges` (`L3-L1`/`L3-02`), `525 MiB` `GNC2`-framed / `500 MiB` plaintext streaming cap, `secrets.token_hex(16)` multipart boundaries, `/healthz`, `/metrics`)
- `scripts/demo/capsule_dispatcher.py` (watch-mode RSA-OAEP capsule delivery, full `LOCAL_VAULT_DIR` defaults & hybrid KMS+local summary envelope support, `/healthz`, `/metrics`)
- `deploy/kubo-private-init.sh`, `deploy/generate_swarm_key.py`, `deploy/docker-compose.vps.yml` (`4/4` services `cap_drop: [ALL]` + `no-new-privileges:true`, `kubo` non-root `user: "1000:100"`, `caddy` `METRICS_SCRAPER_CIDR` passthrough), `deploy/Caddyfile.example` (loopback `/metrics` guard, `525MiB` body cap), `deploy/Dockerfile.gateway`, `deploy/Dockerfile.dispatcher`, `deploy/DEPLOYMENT_RUNBOOK.md`

### 5. React 18 + Vite 8 Multi-Role Web3 Frontend (`frontend/src/`)
- **Context & Hooks:** `Web3Context.jsx`, `DatasetContext.jsx`, `LanguageContext.jsx` (dynamic `<html lang>` sync), `useGenomicCatalog.js`, `useGenomicFilters.js`, `useDatasetDecryption.js` (pure React state updater with ref-tracked RAM zero-fill `decryptedPdfBytes.fill(0)` on clear), `useModalFocusTrap.js` (LIFO stacked-modal + parent-trap focus restoration)
- **Synced ABIs (5/5):** `GenomicTokenABI.json`, `GenomicNFTABI.json`, `GenomicsRegistryABI.json`, `GenomicZkVerifierABI.json`, `GenomicTimelockABI.json`
- **Bilingual i18n & Modular Icons:** `en.js` / `vi.js` (702/702 leaf keys, 0 missing static `t()` keys, all 17 interactive `aria-label`/`title` attributes localized), 70 modular SVG icons (`bio=22, crypto=14, market=34`)
- **WCAG 2.2 AA & CSP:** 29/29 offline & 34/34 online `axe-core` scenarios (`docs/reports/ui_ux_axe_report.json`) with 0 blocking violations, 0px overflow, `--focus-ring-color` (`#005fcc` light / `#38bdf8` dark) `:focus-visible` rings, `/` modal-overlay hotkey guard, dynamic `<html lang>`, live `brandFontSize: "19px"`, and `.os2-search-clear >= 24x24px`; Sepolia production build (`VITE_CHAIN_ID=11155111`) strips 100% of loopback origins from `index.html` and all first-party `assets/*.js` chunks (`231` Vite modules).

### 6. CI, Deployment & Adversarial Audit Tooling (`.github/workflows/`, `scripts/`)
- `scripts/deploy/deploy.js` (`parseEnvFlag("ENABLE_TIMELOCK")`, resolved output path logging) & `scripts/deploy/timelock_accept_ownership.js` (`delay = max(handoffDelay, minDelay)`)
- Hardened 13 legacy `scripts/audit/*.mjs` adversarial scripts (strict non-zero exits, zero fake assertions), `swarm_baseline_gate.sh` (`13/13` PASS), `ui_ux_adversarial_suite.mjs` (`15/15` PASS incl. `new Function` & explicit label checks), `parse_slither.py` (POSIX path normalization), `audit_ui_ux_axe.py` (`.os2-brand-wordmark`), `.github/workflows/{ci,security_ci}.yml`.

## Verification Status Snapshot (Code Commit `5805a41`)
- **18/18 Empirical Verification Gates:** PASS
- **Hardhat Mocha Suite:** 494 passing / 0 failing (33 files, incl. 22 tests in `RemediationRegression.test.js` covering `R18-01..06k` & `FIX-70c..f`)
- **Independent Stress, Diverse Datasets & Chunked Fuzz:** 24/24 PASS, 14/14 PASS & 4/4 PASS
- **Solhint / Slither / npm audit:** 0/0 warnings/errors, 0 High/Medium, 0/0 prod vulnerabilities
- **Evidence & Checksum Audit (`verify_evidence_stream_b.py`):** 30/30 cataloged artifacts + `slither_latest.json` + 34-scenario `ui_ux_axe_report.json` verified (`0` dead Markdown links)
- **Live SIWE Gateway + Fresh-DB `REV-01` Probe:** PASS against real Kubo `0.32.1` (`403` cross-owner post-anchor hijack blocked)
- **Playwright Full-Stack Chromium E2E:** 4/4 live E2E flows PASS, 0 console/page errors
- **Port Hygiene:** `OPEN_PORTS == []`
