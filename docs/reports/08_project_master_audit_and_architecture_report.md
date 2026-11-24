# GenoChain Protocol — Master Architecture & Empirical Verification Report

> **Document ID:** `RPT-GENOCHAIN-MASTER-08`  
> **Course:** IS355 — Blockchain Technology (Faculty of Information Systems, UIT — VNU-HCM)  
> **Instructor:** MSc. Ha Le Hoai Trung (`ThS. Hà Lê Hoài Trung`)  
> **Student:** Nguyen Trong Khoi (`Nguyễn Trọng Khôi`, Student ID: `23520783`)  
> **Verification Date:** 2026-11-24  
> **Integrity Standard:** 100% live empirical measurements on current workspace state (zero mockups, zero fabricated artifacts)

---

## 1. Transparent Incident & Recovery Disclosure (Academic Integrity)

On **2026-11-23 at 07:29 AM**, a local user-profile wipe incident caused irreversible loss of:
1. Unpushed local git commits between `cf07788` and `f7fb398c` (leaving the workspace in a mixed state requiring systematic reconstruction).
2. Uncommitted/gitignored historical reports (`docs/research/01..07`, `docs/reports/03..06`, `docs/reports/Rubik.xlsx`).
3. Legacy binary recordings (`recordings/*.mp4`, `recordings/raw_sessions/*.webp`) and the prior 72-image screenshot archive under `docs/evidence/`.

No lost file has been fabricated or linked as if it still existed. Instead, all missing source interfaces, runtime hooks, ZK ceremony helpers, Groth16 proving artifacts, regression tests, documentation, and fresh live screenshots were reconstructed cleanly from source and empirically re-verified end-to-end across all **18 verification gates**.

---

## 2. Production Smart Contract Architecture & Size Verification (EIP-170 / EIP-3860)

All 7 production Solidity contracts compile under `solc 0.8.24` (`evmVersion: "cancun"`, `viaIR: true`, `optimizer.runs: 200`) with **0 Solhint errors/warnings** (`--max-warnings 0`) and **0 High / 0 Medium Slither findings** (`docs/reports/slither_latest.json`):

| Production Contract | Runtime Bytecode (EIP-170 <= 24,576 B) | Runtime Headroom | Initcode (EIP-3860 <= 49,152 B) | Status |
| :--- | :---: | :---: | :---: | :---: |
| `contracts/GenomicsRegistry.sol` | `21,543 B` | `3,033 B` | `42,627 B` | PASS |
| `contracts/registry/GenomicsMetadataStore.sol` | `10,800 B` | `13,776 B` | `11,119 B` | PASS |
| `contracts/registry/GenomicsEscrowEngine.sol` | `8,735 B` | `15,841 B` | `8,965 B` | PASS |
| `contracts/GenomicZkVerifier.sol` | `17,412 B` | `7,164 B` | `18,614 B` | PASS |
| `contracts/GenomicNFT.sol` | `15,667 B` | `8,909 B` | `16,865 B` | PASS |
| `contracts/GenomicToken.sol` | `5,371 B` | `19,205 B` | `6,468 B` | PASS |
| `contracts/GenomicTimelock.sol` | `5,279 B` | `19,297 B` | `6,533 B` | PASS |

Reconstructed Solidity interfaces compiled cleanly and verified against all callers:
- `contracts/interfaces/IGenomicsRegistryWorkerSync.sol` (`resetAuthorizedWorkersForToken`)
- `contracts/interfaces/IGenomicsMetadataErrors.sol` (27 disjoint 0-arg custom errors)
- `contracts/interfaces/IGenomicZkVerifier.sol` (5 view bridge methods)

All 5 frontend ABI artifacts (`GenomicTokenABI.json`, `GenomicNFTABI.json`, `GenomicsRegistryABI.json`, `GenomicZkVerifierABI.json`, `GenomicTimelockABI.json`) are synchronized via `scripts/deploy/sync_abis.py` and `scripts/update_abi.js`.

---

## 3. Cryptographic & Zero-Knowledge Architecture

- **Symmetric Authenticated Encryption (`INV-01`, `INV-04`):** W3C Web Crypto `AES-256-GCM` monolithic and `GNC2` 64 KiB chunked streaming (`20 B` header + `25 B` AAD, backward-compatible `GNC1` decode), independent 256-bit `summaryKeyHex` for ISO 32000 PDF-1.4 summary reports, mandatory pre-decryption SHA-256 integrity check against on-chain anchors (`INV-05`).
- **Non-Extractable Key Custody (`INV-09`):** `RSA-OAEP 2048-bit` (`SHA-256`) researcher keypairs created with `extractable: false`, persisted in `IndexedDB v2` (`GenomicsKeyStoreDB`), backed up exclusively via `GENOCHAIN-ENCRYPTED-KEY-VAULT-v2` (PBKDF2 600,000 iterations) or `GENO-WALLET-BACKUP-v2` (EIP-191 wallet signature).
- **Trapdoor-Free Groth16 BN254 ZK (`INV-12`):** Rebuilt via `scripts/zk/build_groth16_artifacts.mjs` with `snarkjs` + `ffjavascript`:
  - `circuits/build/genomic_variant.r1cs`: `66,720 B` (366 constraints, 370 wires, 3 public inputs, 91-round MiMC-7 Miyaguchi-Preneel, zero slack variables)
  - `frontend/public/zk/genomic_variant.zkey`: `209,343 B`
  - `frontend/public/zk/verification_key.json`: `3,548 B` (`IC.length == 4`)
  - Verified live both on CLI and inside Chromium WebAssembly during Gate 18 E2E (Flow 2) with EIP-191 Certified Lab Attestation and `vkEpoch` isolation.

---

## 4. Private IPFS Isolation, Non-Pathological Genomic Data & Frontend Security

- **Private Kubo `0.32.1` PNET (`INV-08`):** Verified live with `LIBP2P_FORCE_PNET=1`, `Routing.Type=none`, `Bootstrap=[]`, `Peers: 0`, byte-exact CIDv0 and CIDv1 parity against Kubo `0.32.1` (`11 B`, `256 KiB`, `600 KiB`), and `REQUIRE_IPFS=1` seeding (`13` cohorts / `39` live recursive Kubo pins).
- **SIWE IPFS Access Gateway & Watch Dispatcher (`deploy/ipfs_access_gateway.py`, `scripts/demo/capsule_dispatcher.py`):** Verified live on `:8090` and `:8091` (`/healthz` `200`, `/metrics` `200`, public active metadata `200`, unauthenticated private raw `401`, EIP-191 SIWE licensed buyer `200`, replay `401`, unlicensed `403`, automatic on-chain RSA-OAEP capsule delivery `1,268 chars` with `hasActiveAccess=True`, plus live fresh-SQLite-DB & cross-codec `dag-pb`/`raw-leaves` SHA-256 `REV-01` + post-GDPR Art. 17 re-upload `403` defense against Kubo `0.32.1`), with persistent SQLite `upload_provenance` (`mh` + `sha256` with backward-compatible `ALTER TABLE` migration) post-anchor on-chain backfill & `403` hijack defense (`REV-01`), ownership-gated `private_mhs` anti-censorship (`REV-02`), owner-scoped non-revoked orphan-pin & cross-codec SHA-256 alias GC with TOCTOU timestamp guards (`REV-03`/`L3-L2`), durable `_gc_pending` + monotonic `gc_generation` & post-GC `pending_provenance_purges` (`L3-L1`/`L3-02`), `256 KiB` epoch-batched chunked upload quota checks (`L3-01`), `525 MiB` `GNC2`-framed (`500 MiB` plaintext) streaming cap, cryptographically random `secrets.token_hex(16)` multipart boundaries, and hybrid KMS+local summary vault loading.
- **Non-Pathological GA4GH Phenopackets v2 (`INV-11`):** Replaced 3 pathological fixtures (`ABCA4`, `ADA`, `FBN1` containing `"PATHOGENIC"`/`"CAUSATIVE"`) with 3 schema-validated benign molecular polymorphism Phenopacket v2 files (`ALDH2_rs671_KHV`, `ACTN3_rs1815739_Sprint`, `TAS2R38_rs713598_Taste`), fixed `data/sample_phenopacket.json`, clamped `buildPhenopacket()` against emitting `PATHOGENIC`/`CAUSATIVE`/`NCIT:C16355`, removed legacy `data/sample_brca1_patient.vcf`, and verified `14/14` in `test_diverse_datasets_e2e.mjs`.
- **Frontend Security, CSP, Key Vault & WCAG 2.2 AA (`INV-09`, `INV-13`, `INV-14`):**
  - Hardened `crypto/storage/key_vault.js` (`LOW-01`) to fail closed (`[]`/`null`) on empty/null account scope and eliminate cross-account fallback scans across `memCapsuleStore`.
  - Removed external Google Fonts `@import` from `frontend/src/styles/tokens.css` so strict CSP (`style-src 'self' 'unsafe-inline'; font-src 'self' data:`) triggers **0** browser console violations.
  - Verified `VITE_CHAIN_ID=11155111` production build strips **100%** of loopback origins from BOTH `frontend/dist/index.html` (`0` `127.0.0.1`/`localhost` strings) AND all first-party `frontend/dist/assets/*.js` chunks (`0` `http(s)://`/`ws(s)://` loopback URLs; upstream `vendor-ethers-*.js` excluded because `ethers` embeds default `JsonRpcProvider` localhost constant).
  - Restored `frontend/src/hooks/useModalFocusTrap.js` (with parent-modal LIFO focus restoration verified across all `8/8` ARIA dialogs in `4` JSX components), defined `--accent-primary`, `--bg-elevated`, and `--focus-ring-color` (`#005fcc` light / `#38bdf8` dark) for WCAG 2.2 SC 2.4.7 `:focus-visible` keyboard focus rings & `.os2-top-search-box:focus-within`, darkened light-mode `--text-muted` to `#526074` (`>= 5.59:1`), aligned `LiveTransmissionAudit.jsx` / `.btn-clear-all-filters` / `.admin-bounty-badge.is-closed` / `.os2-search-input::placeholder` / `.os2-brand-btn` / `.os2-featured-strip-card` to `>= 4.5:1` AA contrast, forwarded `royaltyBps` through `PipelineProgressMonitor.jsx`, reset `LicensedDatasetsView.jsx` local state on wallet switch, moved modal-safe & editable-input-safe global `/` shortcut into `Navbar.jsx` focusing `#nav-search-input` across Researcher, Donor, and Admin portals, added `aria-label={t("ariaClearSearch")}` to `.os2-search-clear`, added amber `"warning"` variant in `Toast.jsx`/`modals.css`, persisted non-blocking `partialWarning` across `useDatasetDecryption.js`, `useGenomicCatalog.js` refreshes, & `LicensedDatasetsView.jsx`, moved RAM buffer `.fill(0)` out of pure React state updaters (`REV-I06`), enforced SC 3.1.1 dynamic `<html lang>` sync (`LanguageContext.jsx` + `theme-init.js`), SC 2.5.8 `>= 24x24px` hit targets, localized all 17 hardcoded English `aria-label`/`title` attributes (`702/702` EN/VI leaf keys, `0` missing static `t()` keys), and fixed dynamic L-03 royalty i18n keys.
  - Achieved **0 blocking violations**, **0px overflow**, and live computed `brandFontSize: "19px"` across **33 offline** and **38 online** `axe-core` WCAG 2.2 AA scenarios (`docs/reports/ui_ux_axe_report.json` with `scenarios_count: 38`, blocking serialization of custom contrast & target-size checks, expanded telemetry/filter-chip Light & Dark scenarios, gradient-stop verification, and live interactive `:focus-visible`, `<html lang>`, `.os2-search-clear` `24x24px` + `aria-label`, and global `/` hotkey checks across Researcher/Donor/Admin + `modalBlocked: true`).
- **Gateway Pre-Hash, Cross-Codec SHA-256 Provenance, Fail-Closed Routing, Rollback Atomicity, Dispatcher & CI Hardening (Phases 6–7):**
  - Added `only_hash=True` (`only-hash=true&pin=false`) pre-check in `KuboHttpAdapter.add_stream` & `do_POST /api/v0/upload` so rejected `403`/`502` uploads write **0** unpinned blocks to Kubo (`F-03`) and `403` probes on GDPR-revoked CIDs write **0** `upload_provenance` rows; extended `PublicMetadataCatalogIndex`, `UploadRateLimiter`, and `GdprErasureReconciler` to enforce content-SHA-256 provenance across `dag-pb` CIDv0 and `raw-leaves` CIDv1 aliases (including `>256 KiB` multi-chunk payloads) and purge cross-codec alias pins on GDPR Art. 17 revocation (`R18-06n`).
  - Hardened `ipfs/pinata_uploader.js` & `ipfs/kubo_client.js` so Private IPFS Gateway routing takes exclusive precedence over Pinata Cloud and fails closed on gateway error/timeout without falling back to unauthenticated Kubo RPC even when `VITE_KUBO_RPC` + Pinata JWT are both configured (`R18-06o`).
  - Eliminated rollback TOCTOU and SQLite `None`-fault unpin hazards in `deploy/ipfs_access_gateway.py` via lock-atomic rollback guards and strict `is False` checks; raised exceptions in `KuboHttpAdapter.list_recursive_pins()` so GDPR erasure retries cleanly on Kubo outage; added monotonic `gc_generation` against concurrent `run_gc()` clobbering; made download `NonceStore` fail closed (`HTTP 429`) on saturation; preserved caller upload nonce & byte quota on transient `502` catalog outages; and restored `originalCreator` access on cold-SQLite fallback via 3-tuple `get_first_registrant_info` (`R18-06p`).
  - Extended `scripts/demo/capsule_dispatcher.py` to exclude already-fulfilled sovereign-donor escrow/direct-grant orders from `pendingOrders` and prune stale `dispatched_keys`/`quarantined` entries even when `data_id not in seed_keys` (`R18-06m`).
  - Modernized `scripts/audit/round3_adversarial_agent_{1,5}.mjs`, `scripts/demo/live_execution_e2e.mjs`, `scripts/audit/academic_hygiene_toolkit.py`, `scripts/audit/e2e_fullstack_playwright.py`, `scripts/audit/verify_evidence_stream_b.py` (now asserting `slither_latest.json` `0` High / `0` Medium on production `contracts/`), and aligned `deploy/Dockerfile.{gateway,dispatcher}` to `python:3.12-slim` (`23/23` `scripts/audit/*.mjs` verified PASS).

---

## 5. Complete 18-Gate Empirical Verification Ledger

| Gate | Verification Scope | Observed Live Result | Status |
| :---: | :--- | :--- | :---: |
| 01 | `npx hardhat test` (33 test files incl. `RemediationRegression.test.js` `R18-01..06p` & `FIX-70c..f`) | `499 passing, 0 failing` | PASS |
| 02 | `independent_stress_suite.mjs`, `test_diverse_datasets_e2e.mjs`, `test_chunked_fuzz.mjs` & all `23/23` `scripts/audit/*.mjs` | `24/24 PASS`, `14/14 PASS`, `4/4 PASS` & `23/23 PASS` | PASS |
| 03 | `scripts/audit/check_eip170.py` (all 7 production contracts) | `7/7 PASS` (EIP-170 & EIP-3860) | PASS |
| 04 | `npm run lint:sol` (`solhint --max-warnings 0`) | `0 errors, 0 warnings` | PASS |
| 05 | `slither . --exclude-dependencies` + `parse_slither.py` | `0 High, 0 Medium` | PASS |
| 06 | `i18n_parity.mjs` & `verify_frontend_dictionaries.mjs` | `702/702 EN/VI`, `0` missing static `t()`, `70` SVG icons | PASS |
| 07 | `npm ci` + `npm audit --omit=dev` (root & `frontend/`) | `0` vulnerabilities (root `0`, frontend `0`) | PASS |
| 08 | Hygiene selftest, UI/UX adversarial (`8/8` modals), `py_compile`, `bash -n`, `swarm_baseline_gate.sh` | `3/3`, `15/15`, `18/18 Python`, `2/2 Shell`, `13/13 Swarm Gate` | PASS |
| 09 | Vite build (`231 modules`) & Sepolia CSP + first-party JS loopback-strip probe | `0` errors, `0` loopback leaks in `index.html` & first-party JS | PASS |
| 10 | Axe-core WCAG 2.2 AA Offline (`:4173` preview, no EVM, temp `--output`) | `33/33 PASS`, `0` blocking violations, `0px` overflow, `brandFontSize: 19px` | PASS |
| 11 | Axe-core WCAG 2.2 AA Online (`:4173` + live `:8545` + `:5001`) | `38/38 PASS`, `0` blocking violations, `0px` overflow, `brandFontSize: 19px` | PASS |
| 12 | Private Kubo `0.32.1` PNET (`LIBP2P_FORCE_PNET=1`, `Routing.Type=none`) | `Peers: 0` | PASS |
| 13 | CIDv0 & CIDv1 exact parity vs live Kubo `0.32.1` (`11 B`, `256 KiB`, `600 KiB`) | `100% byte-exact match` | PASS |
| 14 | `REQUIRE_IPFS=1` live deploy + 13 cohorts + V2 ZK VK | `13` cohorts seeded, `39` live Kubo pins | PASS |
| 15 | `live_chain_audit.py`, `web3_demo.py` & `live_execution_e2e.mjs` on live `:8545` + `:5001` | All exited `0` (`100% PASS`) | PASS |
| 16 | Live SIWE Gateway (`:8090`) + Watch Dispatcher (`:8091`) + Live Cross-Codec SHA-256 `REV-01` & GDPR Probe | `/healthz`/`/metrics` `200`, unauth `401`, SIWE `200`, replay `401`, unlicensed `403`, auto-dispatch capsule, active & post-GDPR cross-codec re-upload `403` (`0` Kubo writes) | PASS |
| 17 | Live Timelock deploy (`ENABLE_TIMELOCK=1 SKIP_SEEDING=1 DISABLE_FAUCET=1`) + handoff | `4/4` contracts owned by `GenomicTimelock`, `admin=0x0`, `pendingOwner=0x0`, `capsuleDispatcher=0x0`, `faucetEnabled=false` | PASS |
| 18 | Full-stack Playwright Chromium E2E (`e2e_fullstack_playwright.py`) + teardown | `4/4` flows PASS, `0` console/page errors, `OPEN_PORTS == []` | PASS |

---

## 6. Cross-References (Zero Dead Links)

- Academic Rubric (Scale A /40): [`docs/specs/01_project_rubric.md`](../specs/01_project_rubric.md)
- Enterprise Production Readiness Rubric (Scale B /40): [`docs/specs/06_production_readiness_rubric.md`](../specs/06_production_readiness_rubric.md)
- Evaluation Checklist (26 items + OWASP 2026 + STLC): [`docs/specs/03_evaluation_checklist.md`](../specs/03_evaluation_checklist.md)
- Verified Live Evidence Inventory: [`docs/evidence/README.md`](../evidence/README.md)
- Production VPS & Timelock Runbook: [`deploy/DEPLOYMENT_RUNBOOK.md`](../../deploy/DEPLOYMENT_RUNBOOK.md)
- Machine-Readable Static & Accessibility Reports: [`slither_latest.json`](slither_latest.json), [`ui_ux_axe_report.json`](ui_ux_axe_report.json)
