# Graph Report - BLOCKCHAIN (Synchronized 2026-11-24)

## Graph Freshness
- **Built from code/docs commit:** `40fdd81` (`40fdd81685114c8a3aafbef50bca6c7c76c00dbd`) — committed in `HEAD` immediately following `40fdd81` (`git rev-parse --short HEAD~1` == `40fdd81`).
- **Generation method:** Deterministic live source-tree AST/corpus synchronization on git-tracked files (the `graphify` CLI binary is not installed in this local environment; `graph.json` was not regenerated via graphify CLI).

## Corpus Check
- **Tracked repository files:** 322 total (279 UTF-8 text/code/config/docs/genomic files, ~591,305 words, including canonical `docs/` and `graphify-out/GRAPH_REPORT.md`)
- **Extracted top-level code symbols (Solidity contracts/interfaces/libraries, exported JS/JSX declarations, module-level Python classes/defs):** 423
- **Solidity source files:** 16 (7 production contracts + 4 interfaces + 2 storage bases + 3 test mocks; `contracts/` 100% untouched across Phases 5–7, `git diff 402d779..HEAD -- contracts/` empty)
- **Automated Mocha test suites:** 33 files (499 passing, 0 failing; `RemediationRegression.test.js` 27 passing covering `R18-01..06p` & `FIX-70c..f`)
- **Standalone/Hardhat Audit Scripts (`scripts/audit/*.mjs`):** 23 files (23/23 verified PASS: 21 offline + 2 live Kubo `0.32.1`)
- **Frontend JS/JSX modules:** 43 files (`frontend/src/`)
- **Client Cryptography & ZK modules:** 8 files (`crypto/`)
- **IPFS & Phenopackets v2 modules:** 5 files (`ipfs/`)
- **Python runtime/audit/gateway scripts:** 18 files
- **VPS Private IPFS deployment stack:** 11 files (`deploy/`)
- **Canonical Documentation & Evidence files:** 35 files (`docs/`, incl. 22 fresh live WCAG PNGs + `slither_latest.json` + `ui_ux_axe_report.json`)

## Architecture Module Topology (Verified Live)

### 1. On-Chain EVM Protocol (`contracts/`, Solidity `0.8.24` Cancun + `viaIR`)
- **Core Registry & Storage:** `GenomicsRegistry.sol` (`21,543 B`), `registry/GenomicsRegistryStorage.sol`, `registry/GenomicsMetadataStore.sol` (`10,800 B`), `registry/GenomicsEscrowEngine.sol` (`8,735 B`)
- **Tokenomics & Governance:** `GenomicToken.sol` (`5,371 B`, `INITIAL_SUPPLY = 10M $GENO`, `MAX_TOTAL_SUPPLY = 100M $GENO`, `MAX_FAUCET_SUPPLY = 50M $GENO`, `MAX_FAUCET_PER_EPOCH = 50K $GENO`), `GenomicNFT.sol` (`15,667 B`, EIP-2981), `GenomicTimelock.sol` (`5,279 B`, OpenZeppelin `TimelockController`, `admin = 0x0`)
- **Zero-Knowledge Verifier:** `GenomicZkVerifier.sol` (`17,412 B`), `zk/GenomicZkBountyStorage.sol`
- **Interfaces:** `IGenomicsRegistryWorkerSync.sol`, `IGenomicsMetadataErrors.sol` (27 custom errors), `IGenomicZkVerifier.sol`, `IGenomicTokenFaucet.sol`

### 2. Zero-Knowledge Circuit & Artifacts (`circuits/`, `crypto/zk/`, `scripts/zk/`, `frontend/public/zk/`)
- `circuits/genomic_variant_proof.circom` -> `circuits/build/genomic_variant.r1cs` (`66,720 B`, 366 constraints, 3 public inputs, 91-round BN254 MiMC-7)
- `frontend/public/zk/genomic_variant.zkey` (`209,343 B`) & `verification_key.json` (`3,548 B`, `IC=4`)
- `crypto/zk/groth16_prover.js`, `scripts/zk/build_groth16_artifacts.mjs`, `scripts/demo/zk_ceremony_helper.mjs`, `scripts/demo/zk_prover_cli.mjs`

### 3. Client Cryptography, Storage & Phenopackets (`crypto/`, `ipfs/`)
- `crypto/core/symmetric.js` (AES-256-GCM, strict 12B IV validation, fatal UTF-8 decode), `crypto/core/streaming.js` (`GNC2`/`GNC1` 64 KiB, fatal UTF-8 decode), `crypto/core/asymmetric.js` (RSA-OAEP-2048), `crypto/storage/key_vault.js` (IndexedDB v2 + PBKDF2-600k / EIP-191 backup v2, fail-closed account-scoped lookup & zero cross-account fallback scans), `crypto/reporting/pdf_generator.js` (ISO 32000 PDF-1.4)
- `ipfs/multihash.js` (byte-exact Kubo 0.32.1 CIDv0 & CIDv1), `ipfs/kubo_client.js` (fail-closed `uploadToPrivateGateway` that throws rather than falling back to unauthenticated Kubo RPC even when `VITE_KUBO_RPC` is set, URL-parsed local Kubo guards + compile-time `__GENOCHAIN_NON_LOCAL_CHAIN__` stripping), `ipfs/pinata_client.js`, `ipfs/pinata_uploader.js` (Private IPFS Gateway exclusive routing precedence before Pinata Cloud when configured, verified in `R18-06o`), `ipfs/phenopacket_builder.js` (GA4GH Phenopackets v2, strict INV-11 benign clamp)

### 4. Private IPFS VPS, SIWE Gateway & Dispatcher (`deploy/`, `scripts/demo/`)
- `deploy/ipfs_access_gateway.py`:
  - SIWE EIP-191 auth & dual-namespace SQLite WAL `NonceStore` failing closed (`HTTP 429`) on BOTH upload and download saturation (zero 10% eviction).
  - Cross-codec (`dag-pb` CIDv0 vs `raw-leaves` CIDv1, `<= 256 KiB` & `> 256 KiB` multi-chunk) SHA-256 provenance enforcement across `PublicMetadataCatalogIndex` (`rawDataHash`/`summaryHash`/`metadataHash`), `UploadRateLimiter`, SQLite `upload_provenance`/`tracked_pins`/`pending_uploads` (`sha256` column + backward-compatible `ALTER TABLE` migration), and `GdprErasureReconciler` cross-codec alias pin unpinning (`R18-06n`).
  - `KuboHttpAdapter.add_stream(..., only_hash=True)` zero-block-write pre-hashing on `403`/`502` (`F-03`), zero `upload_provenance` mutation on GDPR-revoked `403` probes, and upload nonce/quota preservation on transient `502` catalog outages.
  - Atomic lock-held rollback eligibility (`acquire_rollback_eligibility` / `release_rollback_guard` keeping per-`mh`/`sha256` guards active during `_rollback_kubo_block`) + strictly fail-closed `has_persisted_provenance_or_pin(...) is False` on SQLite faults (`R18-06p`).
  - `KuboHttpAdapter.list_recursive_pins()` raises on transient Kubo outages so `GdprErasureReconciler.reconcile_once()` retries rather than marking `data_id` erased; monotonic `gc_generation` prevents concurrent `run_gc()` completion from clobbering newly arrived `mark_gc_pending()` flags; cold-SQLite download fallback uses 3-tuple `get_first_registrant_info` preserving `originalCreator` access after ERC-721 transfer (`R18-06p`).
  - `256 KiB` epoch-batched chunked upload quota checks (`L3-01`), `525 MiB` `GNC2`-framed (`500 MiB` plaintext) streaming cap, cryptographically random `secrets.token_hex(16)` multipart boundaries, `/healthz`, `/metrics`.
- `scripts/demo/capsule_dispatcher.py` (watch-mode RSA-OAEP capsule delivery, persistent active authorized `missing_seed_key` order queueing across >5 blocks for vault hot-reload, excluding already-fulfilled sovereign-donor escrow/direct-grant orders via `mk_deliv`/`buyerCapsules` and pruning stale `dispatched_keys`/`quarantined` entries even when `data_id not in seed_keys` (`R18-06m`), full `LOCAL_VAULT_DIR` defaults & hybrid KMS+local summary envelope support, `/healthz`, `/metrics`)
- `deploy/kubo-private-init.sh`, `deploy/generate_swarm_key.py`, `deploy/docker-compose.vps.yml` (`4/4` services `cap_drop: [ALL]` + `no-new-privileges:true`, `kubo` non-root `user: "1000:100"`, `caddy` `METRICS_SCRAPER_CIDR` passthrough), `deploy/Caddyfile.example` (loopback `/metrics` guard, `525MiB` body cap), `deploy/Dockerfile.gateway` (`python:3.12-slim`), `deploy/Dockerfile.dispatcher` (`python:3.12-slim`), `deploy/DEPLOYMENT_RUNBOOK.md`

### 5. React 18 + Vite 8 Multi-Role Web3 Frontend (`frontend/src/`)
- **Context & Hooks:** `Web3Context.jsx`, `DatasetContext.jsx`, `LanguageContext.jsx` (dynamic `<html lang>` sync), `useGenomicCatalog.js` (preserves `partialWarning` across background catalog refreshes), `useGenomicFilters.js`, `useDatasetDecryption.js` (pure React state updater with ref-tracked RAM zero-fill `Uint8Array.fill(0)` on clear, tamper error, and unmount, plus non-blocking `partialWarning` reporting on optional PDF/Phenopacket fetch failures), `useModalFocusTrap.js` (LIFO stacked-modal + parent-trap focus restoration across all `8/8` ARIA dialogs in `4` JSX files)
- **Key Features Hardened in Phase 7:** `PipelineProgressMonitor.jsx` forwards `royaltyBps` to `LiveTransmissionAudit.jsx`; `LicensedDatasetsView.jsx` resets local UI state (`activePreviewTab`, `reuseInputs`, `busyReuseId`, `busyEscrowId`) on wallet account switch; `DragDropMintingStudio.jsx` exposes `#btn-toggle-privacy-telemetry` for deterministic Light/Dark contrast verification.
- **Synced ABIs (5/5):** `GenomicTokenABI.json`, `GenomicNFTABI.json`, `GenomicsRegistryABI.json`, `GenomicZkVerifierABI.json`, `GenomicTimelockABI.json`
- **Bilingual i18n & Modular Icons:** `en.js` / `vi.js` (702/702 leaf keys, 0 missing static `t()` keys, all 17 interactive `aria-label`/`title` attributes localized incl. `.os2-search-clear`), 70 modular SVG icons (`bio=22, crypto=14, market=34`)
- **WCAG 2.2 AA & CSP:** 33/33 offline & 38/38 online `axe-core` scenarios (`docs/reports/ui_ux_axe_report.json`) with 0 blocking violations (including serialized custom contrast & target-size checks and expanded Light/Dark telemetry + filter-chip states), 0px overflow, light-mode `--text-muted: #526074` (`>= 5.59:1`), AA-compliant `LiveTransmissionAudit.jsx` (`--accent-emerald-text`/`--accent-amber-text`), `.btn-clear-all-filters` (`--accent-rose-text`), `[data-theme="light"] .admin-bounty-badge.is-closed`, `.os2-search-input::placeholder`, `.os2-brand-btn`, and `.os2-featured-strip-card`; Sepolia production build (`VITE_CHAIN_ID=11155111`) strips 100% of loopback origin URLs from `index.html` and all first-party `assets/*.js` chunks (`231` Vite modules).

### 6. CI, Deployment & Adversarial Audit Tooling (`.github/workflows/`, `scripts/`)
- `scripts/deploy/deploy.js` (`parseEnvFlag("ENABLE_TIMELOCK")`, resolved output path logging) & `scripts/deploy/timelock_accept_ownership.js` (`delay = max(handoffDelay, minDelay)`)
- Hardened and live-verified all `23/23` `scripts/audit/*.mjs` adversarial/audit scripts (21 offline + 2 live Kubo `0.32.1`, including modernized `round3_adversarial_agent_{1,5}.mjs` and `ui_ux_adversarial_suite.mjs` scanning all `8/8` ARIA modal dialogs across `4` JSX components), `scripts/demo/live_execution_e2e.mjs` (RFC CIDv0 computation + current struct fields), `scripts/audit/academic_hygiene_toolkit.py` (`.venv`/`.local` exclusions + dict-subscript `.hex()` check), `scripts/audit/e2e_fullstack_playwright.py` (temp checkpoint, idempotent grant, dead noop removed), `swarm_baseline_gate.sh` (`13/13` PASS), `parse_slither.py`, `audit_ui_ux_axe.py` (`38/38` online, `33/33` offline), `verify_evidence_stream_b.py` (verifying 30/30 artifacts + `slither_latest.json` `0` High/Medium on production `contracts/` + `ui_ux_axe_report.json` `38/38` blocking=0) integrated in `.github/workflows/{ci,security_ci}.yml`.

## Verification Status Snapshot (Code Commit `40fdd81`)
- **18/18 Empirical Verification Gates:** PASS
- **Hardhat Mocha Suite:** 499 passing / 0 failing (33 files, incl. 27 tests in `RemediationRegression.test.js` covering `R18-01..06p` & `FIX-70c..f`)
- **All `scripts/audit/*.mjs` Suites:** 23/23 PASS (incl. `independent_stress_suite.mjs` 24/24, `test_diverse_datasets_e2e.mjs` 14/14, `round3_adversarial_agent_1.mjs` 6/6, `ui_ux_adversarial_suite.mjs` 15/15)
- **Solhint / Slither / npm audit:** 0/0 warnings/errors, 0 High/Medium on production `contracts/`, 0/0 prod vulnerabilities (`npm ci` verified on root & `frontend/`)
- **Evidence & Checksum Audit (`verify_evidence_stream_b.py`):** 30/30 cataloged artifacts + `slither_latest.json` (`0` prod High/Medium) + 38-scenario `ui_ux_axe_report.json` (`0` blocking, `0px` overflow) verified (`0` dead Markdown links)
- **Live SIWE Gateway + Kubo `0.32.1` Cross-Codec `REV-01` & GDPR Art. 17 Probe:** PASS against real Kubo `0.32.1` (`Peers: 0`, `only-hash=true` 0-block write, active & post-GDPR cross-codec SHA-256 re-upload `403` blocked)
- **Playwright Full-Stack Chromium E2E:** 4/4 live E2E flows PASS, 0 console/page errors
- **Port Hygiene:** `OPEN_PORTS == []`
