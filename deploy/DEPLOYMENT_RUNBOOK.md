# GenoChain Protocol - Real-World Deployment Runbook

This runbook covers production-grade deployment of GenoChain Protocol across:
1. **EVM Testnet / L2**: Base Sepolia (`chainId=84532`, recommended for low gas + fast blocks) or Ethereum Sepolia (`chainId=11155111`).
2. **Oracle Cloud Always-Free VPS Topology**:
   - **VPS #1 (4 OCPU / 24 GB RAM / ARM64 or x86_64)**: Strictly isolated Private Kubo `v0.32.1` (`LIBP2P_FORCE_PNET=1`, `genochain_private` with `internal: true`, `kubo-private-init.sh`) + immutable non-root `deploy/Dockerfile.gateway` (`ipfs_access_gateway.py` with SQLite persistence, public Active `metadataCid` reads, SIWE-gated private downloads & `/api/v0/upload`, ref-counted GDPR Art. 17 erasure) + Caddy HTTPS TLS reverse proxy (`80/443`) + optional `--profile custodial-dispatcher` (`deploy/Dockerfile.dispatcher`) + Prometheus/Grafana scraping loopback `/metrics` (`127.0.0.1:8090` & `127.0.0.1:8091`).
   - **VPS #2 (2 OCPU / 12 GB RAM, optional HA & observability node)**: Private Kubo IPFS replica sharing the same `swarm.key` over a WireGuard tunnel + Uptime Kuma monitoring `/healthz` + `k6` synthetic load testing (or isolated `capsule-dispatcher` signing worker if separating storage and signing blast radii).
3. **Frontend Static Hosting**: Cloudflare Pages (or Vercel / Nginx) serving the Vite SPA built with target `VITE_CHAIN_ID`, `VITE_RPC_URL`, and `VITE_KUBO_GATEWAY`, paired with `frontend/public/_headers` clickjacking/MIME HTTP headers.
4. **Optional 7-Day AWS Experiment**: AWS KMS envelope encryption for custodial dispatcher vault keys + S3 encrypted ciphertext replication + Nitro Enclave evaluation, with strict cost guardrails and full teardown steps.

---

## 1. Prerequisites & Credential Checklist

Before running live deployment commands, collect:
- **RPC Endpoint**: Alchemy / Infura / QuickNode / public Base Sepolia (`https://sepolia.base.org`) or Sepolia RPC URL.
- **Deployer EOA**: Fresh key funded with testnet ETH (0.05-0.1 ETH on Base Sepolia or Sepolia). Never reuse Hardhat default test keys.
- **Multisig / Safe Addresses**: At least 1 Safe address for `TIMELOCK_PROPOSERS` and `TIMELOCK_EXECUTORS`.
- **Optional Custodial Worker EOA**: Only needed if running `--profile custodial-dispatcher` for institutionally custodied datasets; funded with ~0.02 ETH for `storeTransformedCapsule` gas and configured via `DISPATCHER_PRIVATE_KEY` + `CAPSULE_DISPATCHER_ADDRESS`.
- **Optional Certified Sequencing Lab Signer**: Set via `INITIAL_LAB_ATTESTOR` if pre-approving a lab signer at deploy time (under `SKIP_SEEDING=1`, the deployer is NEVER auto-approved as a lab attestor or capsule dispatcher).
- **DNS Record**: An `A` record pointing `ipfs.<your-domain>` to Oracle VPS #1 public IPv4 (TCP ports `80` and `443` open in Oracle Security List + `ufw`; keep `5001`, `8080`, `8090`, `8091` CLOSED on the public firewall).

---

## 2. Smart Contract Deployment & Ownable2Step Timelock Handoff

### 2.1 Configure Environment
```bash
cp deploy/.env.production.example deploy/.env.production
# Edit deploy/.env.production and set:
#   BASE_SEPOLIA_RPC_URL, DEPLOYER_PRIVATE_KEY,
#   SKIP_SEEDING=1, DISABLE_FAUCET=1, ENABLE_TIMELOCK=1,
#   TIMELOCK_DELAY_SEC=300 (staging) or 172800 (mainnet),
#   TIMELOCK_PROPOSERS=0xYourSafe, TIMELOCK_EXECUTORS=0xYourSafe
# Optional least-privilege roles (leave blank for pure sovereign mode):
#   CAPSULE_DISPATCHER_ADDRESS=0xYourDedicatedWorker
#   INITIAL_LAB_ATTESTOR=0xYourCertifiedLabSigner
```

### 2.2 Deploy Contracts (Zero Demo Seeds, Least-Privilege, Faucet Disabled, Timelock Enabled)
```bash
set -a && source deploy/.env.production && set +a
npx hardhat compile
python scripts/audit/check_eip170.py
npx hardhat run scripts/deploy/deploy.js --network baseSepolia
```

Verify output:
- `frontend/src/contracts/contractAddresses.json` now records:
  - `network: "baseSepolia"`, `chainId: 84532`
  - `deployedBlock`: captured **before** deploying `GenomicToken` (ensuring `queryFilterChunked` never scans from block `0` and never misses genesis events)
  - All 5 deployed addresses: `GenomicToken`, `GenomicNFT`, `GenomicsRegistry`, `GenomicZkVerifier`, `GenomicTimelock`
- Under `SKIP_SEEDING=1`, `deploy.js` explicitly invokes `GenomicsRegistry.disableCapsuleDispatcher()` and verifies on-chain that `GenomicsRegistry.capsuleDispatcher()` equals `0x0000...0000` unless `CAPSULE_DISPATCHER_ADDRESS` was explicitly set, and `GenomicZkVerifier.approvedLabAttestors(deployer)` stays `false` unless `INITIAL_LAB_ATTESTOR` was explicitly set (`requireLabAttestation` is always enforced `true`).
- `.local/timelock_handoff.json` contains exact `scheduleBatch` and `executeBatch` calldata for `acceptOwnership()` on all 4 `Ownable2Step` contracts.

### 2.3 Complete 2-Step Ownership Transfer to `GenomicTimelock`
1. Submit `scheduleBatch` (either via Gnosis Safe Transaction Builder using `.local/timelock_handoff.json` or via CLI when deployer is initial proposer):
   ```bash
   npx hardhat run scripts/deploy/timelock_accept_ownership.js --network baseSepolia
   ```
2. Wait `TIMELOCK_DELAY_SEC` seconds.
3. Re-run `timelock_accept_ownership.js` (or execute `executeBatch` from Safe) to finalize `acceptOwnership()`:
   ```bash
   npx hardhat run scripts/deploy/timelock_accept_ownership.js --network baseSepolia
   ```
4. Confirm output prints `[SUCCESS] All 4 protocol contracts are now owned by GenomicTimelock.`

---

## 3. Oracle VPS Deployment (True Private Kubo + Immutable Gateway + Caddy)

### 3.1 Firewall Hardening (Oracle Cloud Security List + Host UFW)
- **ALLOW inbound**: TCP `22` (SSH from operator IP only), TCP `80` (ACME HTTP-01), TCP `443` (HTTPS).
- **DENY inbound**: TCP `5001` (Kubo RPC), TCP `8080` (raw Kubo Gateway), TCP `8090` (gateway internal), TCP `8091` (dispatcher metrics).

### 3.2 Generate Private Kubo Swarm Key (`LIBP2P_FORCE_PNET=1`)
Private Kubo refuses to boot without a 256-bit pre-shared key (`swarm.key`). Generate a fresh key strictly on the VPS (never commit `deploy/secrets/` to Git) and assign ownership to Kubo's container UID (`1000:100`) so the `:ro` bind mount is readable after Kubo drops root privileges:
```bash
python deploy/generate_swarm_key.py
sudo chown 1000:100 deploy/secrets/swarm.key
sudo chmod 0400 deploy/secrets/swarm.key
```
`deploy/kubo-private-init.sh` is mounted read-only at `/container-init.d/001-private-network.sh` and strips all public bootstrap peers, disables DHT routing (`Routing.Type=none`), mDNS, Circuit Relay, and AutoNAT before Kubo starts. Combined with `genochain_private` (`internal: true`), Kubo is physically incapable of dialing the public IPFS network.

### 3.3 Launch Core Sovereign Stack (Private Kubo + Gateway + Caddy)
Under `SKIP_SEEDING=1`, donors mint directly from the browser via SIWE-authenticated `POST /api/v0/upload` (spooled safely onto disk under `/var/lib/genochain/spool` rather than RAM-backed `/tmp` `tmpfs`) and deliver RSA-OAEP capsules directly from their Sovereign Vault (`PatientSovereignVault`), so no custodial dispatcher container is required by default:
```bash
cp deploy/Caddyfile.example deploy/Caddyfile
docker compose -f deploy/docker-compose.vps.yml --env-file deploy/.env.production config --quiet
docker compose -f deploy/docker-compose.vps.yml --env-file deploy/.env.production up -d --build
docker compose -f deploy/docker-compose.vps.yml ps
```

### 3.4 Optional Custodial Capsule Dispatcher (`--profile custodial-dispatcher`)
Enable `capsule-dispatcher` ONLY when operating an institutional biobank vault whose AES dataset keys are stored as encrypted envelopes (PBKDF2 v2 or AWS KMS) in a dedicated directory `deploy/secrets/vault/dispatcher_seed_vault.json` (mounted as a directory rather than a single-file bind mount so atomic `mv` updates hot-reload cleanly across Linux inodes without exposing `swarm.key`):
1. Create `deploy/secrets/vault/dispatcher_seed_vault.json` with `genochain` non-root UID (`10001:10001`) ownership and `0400` permissions (`mkdir -p deploy/secrets/vault && sudo chown -R 10001:10001 deploy/secrets/vault && sudo chmod 0400 deploy/secrets/vault/dispatcher_seed_vault.json`); the daemon hot-reloads automatically whenever `mtime`/`size` changes (zero restart needed).
2. Set `DISPATCHER_PRIVATE_KEY` (dedicated low-privilege worker EOA) and ensure that worker address is authorized on-chain (`setCapsuleDispatcher` via `GenomicTimelock` or per-dataset `setAuthorizedCapsuleWorker`).
3. Start the optional profile:
   ```bash
   docker compose -f deploy/docker-compose.vps.yml --env-file deploy/.env.production --profile custodial-dispatcher up -d --build
   ```

### 3.5 Recommended Two-VPS Production Split (VPS #1 Primary + VPS #2 Replica & Monitoring)
- On **VPS #1 (4 OCPU)**: run `docker compose -f deploy/docker-compose.vps.yml --env-file deploy/.env.production up -d --build` plus local Prometheus/Grafana scraping `127.0.0.1:8090/metrics` (and `127.0.0.1:8091/metrics` if custodial profile is enabled).
- On **VPS #2 (2 OCPU)**: run a secondary Kubo IPFS replica sharing `swarm.key` over private WireGuard, Uptime Kuma monitoring `https://ipfs.<your-domain>/healthz`, and `k6` load tests against staging; alternatively, run `--profile custodial-dispatcher` exclusively on VPS #2 so `DISPATCHER_PRIVATE_KEY` never co-resides with IPFS storage.

---

## 4. Frontend Build & Cloudflare Pages Deployment

Build a clean production bundle targeted at Base Sepolia (or Sepolia):
```bash
cd frontend
VITE_RPC_URL="https://sepolia.base.org" \
VITE_CHAIN_ID="84532" \
VITE_CHAIN_NAME="Base Sepolia" \
VITE_KUBO_GATEWAY="https://ipfs.genochain.example.com" \
VITE_KUBO_RPC="" \
npm run build
```

Verify zero local-dev artifacts:
- Hardhat Quick Account Switcher is automatically hidden (`CONFIGURED_CHAIN_ID !== 31337`).
- Zero `"Hardhat"` or `"31337"` strings appear in Researcher, Donor, or Admin views (EN & VI), and zero `127.0.0.1:8545` / `127.0.0.1:5001` background probes occur.
- `frontend/public/_headers` is copied automatically into `frontend/dist/_headers` for Cloudflare Pages HTTP clickjacking/MIME protection (`X-Frame-Options: DENY`, `Content-Security-Policy: frame-ancestors 'none'`).
- Deploy `frontend/dist/` via Cloudflare Pages (`wrangler pages deploy frontend/dist --project-name genochain`).

---

## 5. Post-Deploy Verification Checklist

1. **Private Kubo Network Isolation**:
   ```bash
   docker exec genochain-kubo ipfs bootstrap list
   docker exec genochain-kubo ipfs swarm peers
   ```
   Expect empty output (zero public DHT bootstrap peers, zero public swarm peers).
2. **Gateway Liveness**:
   ```bash
   curl -fsS https://ipfs.genochain.example.com/healthz
   ```
   Expect HTTP `200` with `"status":"ok"`, `"rpcConnected":true`, `"kuboConnected":true`.
3. **Metrics Privacy**:
   ```bash
   curl -I https://ipfs.genochain.example.com/metrics
   curl -fsS http://127.0.0.1:8090/metrics
   ```
   Expect HTTP `403` from external internet (`https://...`); HTTP `200` with Prometheus `genochain_ipfs_gateway_*` counters from localhost inside VPS (`127.0.0.1:8090`).
4. **Access Control & Upload Enforcement**:
   - Public Active Phenopacket `GET /ipfs/<metadataCid>` -> HTTP `200` (enables Marketplace browsing without signing).
   - Unauthenticated `GET /ipfs/<rawCid>` or `GET /ipfs/<summaryCid>` -> HTTP `401`.
   - Path traversal `GET /ipfs/..%2Fetc%2Fpasswd` -> HTTP `400`.
   - Valid SIWE signature from non-buyer -> HTTP `403` (without polluting `NonceStore`).
   - Valid SIWE signature from active licensed buyer -> HTTP `200` streamed ciphertext; replaying the exact same headers -> HTTP `401` (`Nonce already used`), persisted in SQLite across gateway restarts.
   - SIWE-authenticated `POST /api/v0/upload` with matching `X-GenoChain-Content-Sha256` -> HTTP `200` JSON `{"cid":"bafk...","size":...}`.
5. **GDPR Art. 17 Physical Erasure (Ref-Counted & Reorg-Safe)**:
   - Donor calls `updateDataStatus(dataId, Revoked)`.
   - Within `GDPR_POLL_SEC` seconds, `ipfs_access_gateway.py` unpins unshared dataset CIDs (`pin/rm`, preserving any CID still referenced by another Active/Paused dataset) and runs `repo/gc`; subsequent requests return HTTP `403` and `genochain_ipfs_gateway_gdpr_erasures_total` increments.
6. **Optional Custodial Dispatcher Health**:
   ```bash
   curl -fsS http://127.0.0.1:8091/healthz
   ```

---

## 6. Optional 7-Day AWS KMS / S3 / Nitro Enclave Experiment & Teardown

Use this optional profile ONLY if you want hardware-backed HSM envelope encryption via AWS KMS during a time-boxed cloud experiment.

### 6.1 Least-Privilege IAM Policy for Dispatcher Worker
Attach this minimal inline policy to the dispatcher IAM user/role (replace `<ACCOUNT_ID>`, `<REGION>`, `<KEY_ID>`, `<BUCKET>`):
```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "GenoChainKmsEnvelopeOnly",
      "Effect": "Allow",
      "Action": ["kms:GenerateDataKey", "kms:Decrypt"],
      "Resource": "arn:aws:kms:<REGION>:<ACCOUNT_ID>:key/<KEY_ID>",
      "Condition": {
        "StringEquals": {
          "kms:EncryptionContext:app": "genochain-dispatcher"
        }
      }
    },
    {
      "Sid": "GenoChainCiphertextBackupOptional",
      "Effect": "Allow",
      "Action": ["s3:PutObject", "s3:GetObject", "s3:DeleteObject"],
      "Resource": "arn:aws:s3:::<BUCKET>/ciphertext/*"
    }
  ]
}
```

### 6.2 Enable KMS Provider
1. Set `AWS_REGION`, `AWS_KMS_KEY_ID`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, and `INSTALL_BOTO3_FLAG=boto3==1.35.99` in `deploy/.env.production`.
2. Wrap custodial dataset keys via `kms_encrypt_seed_key()` in `scripts/demo/capsule_dispatcher.py` into `kmsKeyEnvelope` entries in `deploy/secrets/vault/dispatcher_seed_vault.json`.
3. Rebuild and start `--profile custodial-dispatcher`; `boto3` is baked at image build time and unwraps data keys strictly in memory using `kms:Decrypt` with the `EncryptionContext`.

### 6.3 Cost Cap & Mandatory 7-Day Teardown Checklist
- Set an AWS Budgets alert at **$5 USD/month** BEFORE provisioning any AWS resource.
- To return to **$0/month** after the 7-day experiment:
  1. Schedule AWS KMS Customer Managed Key deletion (`aws kms schedule-key-deletion --key-id <KEY_ID> --pending-window-in-days 7` — stops the $1/month prorated charge once pending deletion).
  2. Empty and delete the S3 bucket (`aws s3 rb s3://<BUCKET> --force`).
  3. Terminate any EC2 Nitro Enclave instance and delete attached EBS volumes + Elastic IPs.
  4. Delete the temporary IAM access key / role and clear `AWS_*` + `INSTALL_BOTO3_FLAG` from `deploy/.env.production`.
  5. Verify AWS Billing & Cost Explorer shows zero active billable resources.