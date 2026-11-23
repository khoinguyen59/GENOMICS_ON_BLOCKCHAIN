"""
===========================================================================
Genomics on Blockchain - Automated Capsule Dispatcher Service
===========================================================================
Scans on-chain 'AccessGranted', 'EscrowDeposited', 'DirectAccessGranted',
and 'ResearcherKeyRegistered' events in bounded 5,000-block chunks and
automatically wraps & delivers RSA-OAEP (>= 2048-bit) Key Capsules via
storeTransformedCapsule().

Resilience & Safety Guarantees:
1. Strict RSA >= 2048-bit public key validation (both JWK and SPKI PEM)
   plus read-only GenomicNFT.validateCapsule() and estimate_gas() preflight
   BEFORE signing/sending any transaction (0 reverting-tx gas burn).
2. Persistent JSON checkpoint (.local/dispatcher_checkpoint.json) tracking
   lastBlock, pendingOrders (late public key registration), dispatchedKeys
   (key-rotation redelivery), and quarantined poison-pill orders (auto-
   unquarantined if the buyer registers a new on-chain public key).
3. Respects per-dataset global dispatcher opt-out (dispatcherDisabled) and
   delegated worker authorization (isAuthorizedWorker).
4. Pending-nonce transaction sequencing and fail-fast --private-key check.
===========================================================================
"""

import os
import re
import sys
import json
import base64
import time
import signal
import atexit
import hashlib
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from web3 import Web3
try:
    from web3.exceptions import ContractCustomError, ContractLogicError
except Exception:
    ContractCustomError = tuple()
    ContractLogicError = tuple()
from cryptography.hazmat.primitives.asymmetric import padding
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric.rsa import RSAPublicKey, RSAPublicNumbers
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

# Fix Windows console encoding
if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass

MIN_RSA_KEY_BITS = 2048
DEFAULT_LOG_CHUNK_SIZE = 5000
SHALLOW_REORG_THRESHOLD = 128
VAULT_KDF_DOMAIN = "GENOCHAIN_SEED_VAULT_KDF_V2"
VAULT_KDF_MIN_ITERATIONS = 210000
DEFAULT_MAX_ROTATIONS_PER_HOUR = 20

_NON_RANGE_RPC_PATTERNS = (
    re.compile(r"\b429\b"),
    re.compile(r"rate\s*limit", re.I),
    re.compile(r"too many requests", re.I),
    re.compile(r"requests?\s+per\s+second", re.I),
    re.compile(r"compute\s+units", re.I),
    re.compile(r"quota\s+exceeded", re.I),
    re.compile(r"max(?:imum)?\s+connections?", re.I),
    re.compile(r"\bblock\s+not\s+found\b", re.I),
    re.compile(r"\bheader\s+not\s+found\b", re.I),
    re.compile(r"\bmissing\s+trie\s+node\b", re.I),
    re.compile(r"\bpruned\b", re.I),
)

_BLOCK_RANGE_ERROR_PATTERNS = (
    re.compile(r"query returned more than", re.I),
    re.compile(r"log response size exceeded", re.I),
    re.compile(r"more than \d+ results", re.I),
    re.compile(r"exceed(?:s|ed)?\s+(?:max(?:imum)?\s+)?(?:block|log|query|result|response)\s+(?:range|size|limit|span)", re.I),
    re.compile(r"(?:block|eth_getlogs)\s+range\s+(?:is\s+too\s+large|too\s+wide|limit|exceed)", re.I),
    re.compile(r"max(?:imum)?\s+block\s+range", re.I),
    re.compile(r"limited\s+to\s+a\s+\d+\s+(?:block|range)", re.I),
    re.compile(r"up\s+to\s+a\s+\d+\s+block\s+range", re.I),
    re.compile(r"too many (?:logs|results|events)", re.I),
    re.compile(r"eth_getlogs.*(?:range|limit|exceed)", re.I),
    re.compile(r"response\s+size.*exceed", re.I),
    re.compile(r"suggested\s+block\s+range", re.I),
)


def is_block_range_limit_error(err) -> bool:
    """Return True ONLY for genuine RPC block-range / log-result-size errors (never 429/rate-limit/block-not-found)."""
    msg = str(err or "")
    if not msg:
        return False
    for pat in _NON_RANGE_RPC_PATTERNS:
        if pat.search(msg):
            return False
    for pat in _BLOCK_RANGE_ERROR_PATTERNS:
        if pat.search(msg):
            return True
    return False


def derive_vault_key_pbkdf2(secret: str, salt_hex: str, iterations: int = VAULT_KDF_MIN_ITERATIONS, domain: str = VAULT_KDF_DOMAIN) -> bytes:
    """Derive 256-bit vault key via salted domain-separated PBKDF2-HMAC-SHA256 (matching deploy.js v2)."""
    if not secret:
        raise ValueError("GENOCHAIN_SEED_VAULT_SECRET must be non-empty.")
    salt = bytes.fromhex(str(salt_hex or "").strip())
    if len(salt) < 16:
        raise ValueError(f"Vault KDF salt too short ({len(salt)} bytes < 16 bytes).")
    iters = int(iterations)
    if iters < VAULT_KDF_MIN_ITERATIONS:
        raise ValueError(f"Vault KDF iterations too low ({iters} < {VAULT_KDF_MIN_ITERATIONS}).")
    dom = str(domain or "").strip()
    if not dom:
        raise ValueError("Vault KDF domain is required.")
    return hashlib.pbkdf2_hmac("sha256", f"{dom}:{secret}".encode("utf-8"), salt, iters, dklen=32)


def load_dispatcher_vault_key(base_dir: str, vault_data: dict | None = None) -> bytes:
    """Load 256-bit vault key from salted PBKDF2-HMAC-SHA256 (v2), legacy v1 secret, or .local/dispatcher_vault.key."""
    env_secret = os.environ.get("GENOCHAIN_SEED_VAULT_SECRET")
    if env_secret:
        kdf_meta = vault_data.get("vaultKdf") if isinstance(vault_data, dict) else None
        vault_ver = int(vault_data.get("vaultVersion", 1) or 1) if isinstance(vault_data, dict) else 1
        if isinstance(kdf_meta, dict) and (
            kdf_meta.get("algorithm") == "PBKDF2-HMAC-SHA256" or kdf_meta.get("mode") == "env-pbkdf2"
        ):
            return derive_vault_key_pbkdf2(
                env_secret,
                kdf_meta.get("saltHex", ""),
                int(kdf_meta.get("iterations", 0) or 0),
                kdf_meta.get("domain", VAULT_KDF_DOMAIN),
            )
        if vault_ver >= 2 and isinstance(kdf_meta, dict) and kdf_meta.get("mode") not in (None, "", "keyfile", "none"):
            raise ValueError(f"Unsupported or incomplete vault v2 KDF metadata: {kdf_meta}")
        # Legacy v1 unversioned vault compatibility fallback
        return hashlib.sha256(env_secret.encode("utf-8")).digest()
    key_path = os.path.join(base_dir, ".local", "dispatcher_vault.key")
    if os.path.exists(key_path):
        with open(key_path, "r", encoding="utf-8") as kf:
            key_hex = kf.read().strip()
        key_bytes = bytes.fromhex(key_hex)
        if len(key_bytes) != 32:
            raise ValueError(".local/dispatcher_vault.key must contain exactly 32 bytes (64 hex chars).")
        return key_bytes
    raise FileNotFoundError(
        "Missing dispatcher vault key (.local/dispatcher_vault.key or GENOCHAIN_SEED_VAULT_SECRET). "
        "Refusing predictable key derivation."
    )


def _get_kms_client(kms_client=None):
    """Lazily initialize boto3 KMS client ONLY when AWS KMS envelope encryption is explicitly enabled."""
    if kms_client is not None:
        return kms_client
    try:
        import boto3  # type: ignore
    except ImportError as exc:
        raise RuntimeError(
            "AWS_KMS_KEY_ID is configured, but 'boto3' is not installed. Install boto3 or unset AWS_KMS_KEY_ID."
        ) from exc
    region = os.environ.get("AWS_REGION") or os.environ.get("AWS_DEFAULT_REGION")
    return boto3.client("kms", region_name=region) if region else boto3.client("kms")


def kms_encrypt_seed_key(
    aes_key_hex: str,
    kms_key_id: str | None = None,
    kms_client=None,
    encryption_context: dict[str, str] | None = None,
) -> dict:
    """Wrap a 32-byte AES seed key using AWS KMS GenerateDataKey envelope encryption (AES-256-GCM)."""
    key_id = (kms_key_id or os.environ.get("AWS_KMS_KEY_ID") or "").strip()
    if not key_id:
        raise ValueError("AWS_KMS_KEY_ID is required for KMS envelope encryption.")
    clean_hex = str(aes_key_hex or "").strip().removeprefix("0x").removeprefix("0X")
    raw_key = bytes.fromhex(clean_hex)
    if len(raw_key) != 32:
        raise ValueError(f"Expected 32-byte AES key hex, got {len(raw_key)} bytes.")
    ctx = {str(k): str(v) for k, v in (encryption_context or {"app": "genochain-dispatcher"}).items()}
    client = _get_kms_client(kms_client)
    resp = client.generate_data_key(KeyId=key_id, KeySpec="AES_256", EncryptionContext=ctx)
    plaintext_dek = bytes(resp["Plaintext"])
    encrypted_dek = bytes(resp["CiphertextBlob"])
    if len(plaintext_dek) != 32:
        raise ValueError("KMS returned invalid data key length.")
    nonce = os.urandom(12)
    ciphertext = AESGCM(plaintext_dek).encrypt(nonce, raw_key, None)
    return {
        "mode": "aws-kms-envelope-v1",
        "kmsKeyId": key_id,
        "encryptedDataKeyB64": base64.b64encode(encrypted_dek).decode("ascii"),
        "nonceHex": nonce.hex(),
        "ciphertextHex": ciphertext.hex(),
        "encryptionContext": ctx,
    }


def kms_decrypt_seed_key(envelope: dict, kms_client=None) -> str:
    """Unwrap an AWS KMS envelope-encrypted 32-byte AES seed key into lowercase 64-char hex."""
    if not isinstance(envelope, dict) or envelope.get("mode") != "aws-kms-envelope-v1":
        raise ValueError("Invalid AWS KMS envelope format (expected mode='aws-kms-envelope-v1').")
    encrypted_dek = base64.b64decode(str(envelope["encryptedDataKeyB64"]).encode("ascii"))
    nonce = bytes.fromhex(str(envelope["nonceHex"]))
    ciphertext = bytes.fromhex(str(envelope["ciphertextHex"]))
    if len(nonce) != 12 or len(ciphertext) < 16:
        raise ValueError("Malformed KMS AES-GCM nonce or ciphertext.")
    ctx = envelope.get("encryptionContext") if isinstance(envelope.get("encryptionContext"), dict) else {}
    kms_key_id = str(envelope.get("kmsKeyId") or os.environ.get("AWS_KMS_KEY_ID") or "").strip()
    client = _get_kms_client(kms_client)
    decrypt_kwargs = {"CiphertextBlob": encrypted_dek}
    if ctx:
        decrypt_kwargs["EncryptionContext"] = {str(k): str(v) for k, v in ctx.items()}
    if kms_key_id:
        decrypt_kwargs["KeyId"] = kms_key_id
    resp = client.decrypt(**decrypt_kwargs)
    plaintext_dek = bytes(resp["Plaintext"])
    if len(plaintext_dek) != 32:
        raise ValueError("KMS decrypt returned invalid data key length.")
    raw_key = AESGCM(plaintext_dek).decrypt(nonce, ciphertext, None)
    if len(raw_key) != 32:
        raise ValueError("Decrypted seed key length mismatch (expected 32 bytes).")
    return raw_key.hex()


def check_and_record_rotation_rate_limit(
    rotation_history: dict,
    buyer_addr: str,
    max_per_hour: int = DEFAULT_MAX_ROTATIONS_PER_HOUR,
    now_ts: int | None = None,
    record: bool = False,
) -> tuple[bool, int]:
    """Enforce per-buyer rolling 1-hour key-rotation rate limit to prevent worker ETH gas drain."""
    now = int(time.time() if now_ts is None else now_ts)
    cutoff = now - 3600
    key = str(buyer_addr or "").lower()
    raw_list = rotation_history.get(key)
    recent = [int(ts) for ts in (raw_list if isinstance(raw_list, list) else []) if int(ts) > cutoff]
    limit = max(1, int(max_per_hour))
    if len(recent) >= limit:
        rotation_history[key] = recent
        return False, len(recent)
    if record:
        recent.append(now)
    if recent:
        rotation_history[key] = recent
    else:
        rotation_history.pop(key, None)
    return True, len(recent)


def emit_log(json_mode: bool, level: str, event: str, message: str, **fields) -> None:
    """Emit structured JSON log line when --json-logs is active, otherwise concise plaintext."""
    if json_mode:
        record = {
            "ts": int(time.time()),
            "level": level,
            "event": event,
            "message": message,
            **fields,
        }
        print(json.dumps(record, ensure_ascii=False, separators=(",", ":")))
    else:
        print(message)


def render_prometheus_metrics(state: dict) -> str:
    """Format dispatcher runtime metrics in Prometheus text exposition format 0.0.4."""
    lines = [
        "# HELP genochain_dispatcher_up 1 when last RPC poll succeeded, 0 when degraded.",
        "# TYPE genochain_dispatcher_up gauge",
        f"genochain_dispatcher_up {1 if state.get('rpcConnected') else 0}",
        "# HELP genochain_dispatcher_cycles_total Total poll cycles executed.",
        "# TYPE genochain_dispatcher_cycles_total counter",
        f"genochain_dispatcher_cycles_total {int(state.get('cyclesTotal', 0))}",
        "# HELP genochain_dispatcher_dispatched_total Total RSA-OAEP key capsules delivered on-chain.",
        "# TYPE genochain_dispatcher_dispatched_total counter",
        f"genochain_dispatcher_dispatched_total {int(state.get('dispatchedTotal', 0))}",
        "# HELP genochain_dispatcher_quarantined_total Total poison-pill orders quarantined at 0 gas.",
        "# TYPE genochain_dispatcher_quarantined_total counter",
        f"genochain_dispatcher_quarantined_total {int(state.get('quarantinedTotal', 0))}",
        "# HELP genochain_dispatcher_skipped_total Total order evaluations skipped.",
        "# TYPE genochain_dispatcher_skipped_total counter",
        f"genochain_dispatcher_skipped_total {int(state.get('skippedTotal', 0))}",
        "# HELP genochain_dispatcher_rotation_rate_limited_total Total key-rotation re-deliveries throttled.",
        "# TYPE genochain_dispatcher_rotation_rate_limited_total counter",
        f"genochain_dispatcher_rotation_rate_limited_total {int(state.get('rotationRateLimitedTotal', 0))}",
        "# HELP genochain_dispatcher_rpc_errors_total Total RPC poll cycle errors.",
        "# TYPE genochain_dispatcher_rpc_errors_total counter",
        f"genochain_dispatcher_rpc_errors_total {int(state.get('rpcErrorsTotal', 0))}",
        "# HELP genochain_dispatcher_pending_orders Current pending orders in checkpoint.",
        "# TYPE genochain_dispatcher_pending_orders gauge",
        f"genochain_dispatcher_pending_orders {int(state.get('pendingOrders', 0))}",
        "# HELP genochain_dispatcher_active_dispatched Current active dispatched keys in checkpoint.",
        "# TYPE genochain_dispatcher_active_dispatched gauge",
        f"genochain_dispatcher_active_dispatched {int(state.get('activeDispatched', 0))}",
        "# HELP genochain_dispatcher_last_block Latest processed EVM block height.",
        "# TYPE genochain_dispatcher_last_block gauge",
        f"genochain_dispatcher_last_block {int(state.get('lastBlock', 0))}",
        "# HELP genochain_dispatcher_seed_keys Number of custodial dataset keys currently loaded from vault.",
        "# TYPE genochain_dispatcher_seed_keys gauge",
        f"genochain_dispatcher_seed_keys {int(state.get('seedKeyCount', 0))}",
    ]
    return "\n".join(lines) + "\n"


def load_vault_keys(vault_file: str, base_dir: str) -> tuple[dict[int, str], dict[int, str]]:
    """
    Load custodial dataset AES key envelopes (and optional summary key envelopes) from vault_file.
    Returns (seed_keys, seed_summary_keys). Blocks any plaintext aesKeyHex per INVARIANT-01.
    """
    seed_keys: dict[int, str] = {}
    seed_summary_keys: dict[int, str] = {}
    if not vault_file or not os.path.exists(vault_file):
        return seed_keys, seed_summary_keys
    with open(vault_file, "r", encoding="utf-8") as f:
        data = json.load(f)
    seed_items = data.get("seeds", [])
    needs_local_vault_key = any(
        isinstance(item, dict)
        and ("encryptedKeyEnvelopeHex" in item or "encryptedSummaryKeyEnvelopeHex" in item)
        and "kmsKeyEnvelope" not in item
        for item in seed_items
    )
    vault_key = load_dispatcher_vault_key(base_dir, vault_data=data) if needs_local_vault_key else None
    for item in seed_items:
        if not isinstance(item, dict):
            continue
        d_id = int(item["dataId"])
        if "kmsKeyEnvelope" in item:
            seed_keys[d_id] = kms_decrypt_seed_key(item["kmsKeyEnvelope"])
        elif "encryptedKeyEnvelopeHex" in item:
            seed_keys[d_id] = unwrap_seed_key_envelope(item["encryptedKeyEnvelopeHex"], vault_key)
        elif "aesKeyHex" in item:
            raise ValueError(
                f"Plaintext aesKeyHex detected for dataId={item.get('dataId')} - blocked by INVARIANT-01."
            )
        if "kmsSummaryKeyEnvelope" in item:
            seed_summary_keys[d_id] = kms_decrypt_seed_key(item["kmsSummaryKeyEnvelope"])
        elif "encryptedSummaryKeyEnvelopeHex" in item:
            seed_summary_keys[d_id] = unwrap_seed_key_envelope(
                item["encryptedSummaryKeyEnvelopeHex"], vault_key
            )
    return seed_keys, seed_summary_keys


def get_vault_file_stat_sig(vault_file: str) -> tuple[int, int] | None:
    """Return (st_mtime_ns, st_size) signature for vault hot-reload detection, or None if absent."""
    try:
        st = os.stat(vault_file)
        return (int(st.st_mtime_ns), int(st.st_size))
    except OSError:
        return None


class _BoundedHealthServer(ThreadingHTTPServer):
    """ThreadingHTTPServer bounded by a concurrency semaphore and socket timeout for /healthz & /metrics."""

    daemon_threads = True
    allow_reuse_address = True
    request_queue_size = 32

    def __init__(self, server_address, RequestHandlerClass, max_workers: int = 16, socket_timeout_sec: float = 5.0):
        self._max_workers = max(2, int(max_workers))
        self._socket_timeout = max(1.0, float(socket_timeout_sec))
        self._worker_sem = threading.BoundedSemaphore(self._max_workers)
        super().__init__(server_address, RequestHandlerClass)

    def process_request(self, request, client_address):
        if not self._worker_sem.acquire(timeout=2.0):
            try:
                request.sendall(
                    b"HTTP/1.1 503 Service Unavailable\r\n"
                    b"Content-Type: application/json\r\n"
                    b"Content-Length: 43\r\n"
                    b"Connection: close\r\n\r\n"
                    b'{"error":"Health server concurrency cap."}'
                )
            except Exception:
                pass
            self.shutdown_request(request)
            return
        try:
            request.settimeout(self._socket_timeout)
            t = threading.Thread(
                target=self._bounded_process_request_thread,
                args=(request, client_address),
                daemon=True,
            )
            t.start()
        except Exception:
            self._worker_sem.release()
            self.shutdown_request(request)

    def _bounded_process_request_thread(self, request, client_address):
        try:
            self.process_request_thread(request, client_address)
        finally:
            self._worker_sem.release()


def resolve_genomic_nft_address(registry, addresses: dict, registry_address: str) -> str | None:
    """
    Dynamically resolve GenomicNFT address from the active registry via registry.genomicNFT().
    Falls back to baked contractAddresses.json ONLY if the RPC call fails AND registry_address
    matches the baked GenomicsRegistry address (preventing stale NFT binding on REGISTRY_ADDRESS overrides).
    """
    try:
        resolved = registry.functions.genomicNFT().call()
        if resolved and Web3.is_address(resolved) and int(resolved, 16) != 0:
            return Web3.to_checksum_address(resolved)
    except Exception:
        pass
    baked_reg = str((addresses or {}).get("GenomicsRegistry") or "").strip().lower()
    if baked_reg and baked_reg == str(registry_address or "").strip().lower():
        baked_nft = (addresses or {}).get("GenomicNFT")
        if baked_nft and Web3.is_address(baked_nft) and int(baked_nft, 16) != 0:
            return Web3.to_checksum_address(baked_nft)
    return None


def start_health_server(
    host: str,
    port: int,
    state: dict,
    state_lock: threading.Lock,
    max_workers: int = 16,
    socket_timeout_sec: float = 5.0,
):
    """Start bounded lightweight /healthz and /metrics HTTP server in a daemon thread."""

    class _HealthHandler(BaseHTTPRequestHandler):
        def log_message(self, format, *args):
            return

        def _serve(self, *, send_body: bool):
            path_only = self.path.split("?", 1)[0]
            with state_lock:
                snap = dict(state)
            if path_only == "/healthz":
                healthy = bool(snap.get("rpcConnected", False))
                body = json.dumps(
                    {
                        "status": "ok" if healthy else "degraded",
                        "chainId": snap.get("chainId"),
                        "lastBlock": int(snap.get("lastBlock", 0)),
                        "cyclesTotal": int(snap.get("cyclesTotal", 0)),
                        "seedKeyCount": int(snap.get("seedKeyCount", 0)),
                        "pendingOrders": int(snap.get("pendingOrders", 0)),
                        "activeDispatched": int(snap.get("activeDispatched", 0)),
                        "quarantined": int(snap.get("quarantined", 0)),
                        "updatedAt": int(snap.get("updatedAt", 0)),
                    }
                ).encode("utf-8")
                self.send_response(200 if healthy else 503)
                self.send_header("X-Content-Type-Options", "nosniff")
                self.send_header("Cache-Control", "no-store")
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                if send_body:
                    self.wfile.write(body)
                return
            if path_only == "/metrics":
                body = render_prometheus_metrics(snap).encode("utf-8")
                self.send_response(200)
                self.send_header("X-Content-Type-Options", "nosniff")
                self.send_header("Cache-Control", "no-store")
                self.send_header("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                if send_body:
                    self.wfile.write(body)
                return
            self.send_response(404)
            self.send_header("Content-Length", "0")
            self.end_headers()

        def do_GET(self):
            self._serve(send_body=True)

        def do_HEAD(self):
            self._serve(send_body=False)

    server = _BoundedHealthServer(
        (host, int(port)),
        _HealthHandler,
        max_workers=max_workers,
        socket_timeout_sec=socket_timeout_sec,
    )
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server, thread


def unwrap_seed_key_envelope(envelope_hex: str, vault_key: bytes) -> str:
    """Unwrap AES-256-GCM vault envelope into ephemeral session key hex in memory."""
    blob = bytes.fromhex(envelope_hex.replace("0x", ""))
    nonce, ct_and_tag = blob[:12], blob[12:]
    raw_key = AESGCM(vault_key).decrypt(nonce, ct_and_tag, None)
    return raw_key.hex()


def b64url_decode(b64_str: str) -> bytes:
    """Decode base64url string with padding."""
    rem = len(b64_str) % 4
    if rem > 0:
        b64_str += "=" * (4 - rem)
    return base64.urlsafe_b64decode(b64_str.encode("utf-8"))


def _validate_rsa_pubkey(pub_key):
    """Ensure imported public key is RSA with modulus >= 2048 bits."""
    if not isinstance(pub_key, RSAPublicKey):
        raise ValueError(f"Unsupported public key type: expected RSA public key, got {type(pub_key).__name__}")
    if pub_key.key_size < MIN_RSA_KEY_BITS:
        raise ValueError(
            f"Weak RSA public key rejected: key_size={pub_key.key_size} bits < minimum {MIN_RSA_KEY_BITS} bits."
        )
    return pub_key


def import_jwk_rsa_pubkey(jwk_str: str):
    """Import and strictly validate an RSA (>= 2048-bit) public key from JWK JSON string or SPKI PEM."""
    if not jwk_str:
        raise ValueError("Empty public key string.")
    if isinstance(jwk_str, str) and jwk_str.strip().startswith("-----BEGIN"):
        trimmed = jwk_str.strip()
        if trimmed.count("-----BEGIN PUBLIC KEY-----") != 1 or not trimmed.endswith("-----END PUBLIC KEY-----"):
            raise ValueError("Malformed or concatenated SPKI PEM public key block.")
        pub_key = serialization.load_pem_public_key(trimmed.encode("utf-8"))
        return _validate_rsa_pubkey(pub_key)

    jwk = json.loads(jwk_str) if isinstance(jwk_str, str) else jwk_str
    if not isinstance(jwk, dict):
        raise ValueError("Invalid JWK public key: expected JSON object.")
    kty = jwk.get("kty")
    if kty is not None and str(kty).upper() != "RSA":
        raise ValueError(f"Unsupported JWK kty '{kty}': expected 'RSA'.")
    if "n" not in jwk or "e" not in jwk:
        raise ValueError("Invalid RSA JWK: missing required 'n' or 'e' component.")
    n_bytes = b64url_decode(jwk["n"])
    e_bytes = b64url_decode(jwk["e"])
    n_int = int.from_bytes(n_bytes, byteorder="big")
    e_int = int.from_bytes(e_bytes, byteorder="big")
    if e_int < 3 or (e_int & 1) == 0:
        raise ValueError(f"Invalid RSA public exponent e={e_int}.")
    pub_key = RSAPublicNumbers(e_int, n_int).public_key()
    return _validate_rsa_pubkey(pub_key)


def package_rsa_capsule(
    aes_key_hex: str,
    buyer_pubkey_jwk_str: str,
    buyer_addr: str,
    owner_addr: str,
    summary_key_hex: str | None = None,
) -> str:
    """Wrap raw AES key (and optional independent summary PDF AES key) with buyer's RSA-OAEP (>= 2048-bit) public key."""
    pubkey = import_jwk_rsa_pubkey(buyer_pubkey_jwk_str)
    oaep_padding = padding.OAEP(
        mgf=padding.MGF1(algorithm=hashes.SHA256()),
        algorithm=hashes.SHA256(),
        label=None,
    )
    clean_aes_hex = aes_key_hex.strip()
    if clean_aes_hex.lower().startswith("0x"):
        clean_aes_hex = clean_aes_hex[2:]
    raw_key_bytes = bytes.fromhex(clean_aes_hex)
    if len(raw_key_bytes) != 32:
        raise ValueError(f"Invalid AES-256 key length: expected 32 bytes, got {len(raw_key_bytes)}.")

    ciphertext = pubkey.encrypt(raw_key_bytes, oaep_padding)
    key_cipher_hex = ciphertext.hex()
    if len(key_cipher_hex) < 512 or len(key_cipher_hex) % 2 != 0 or set(key_cipher_hex) == {"0"}:
        raise ValueError(
            f"Generated keyCipher failed RFC 8017 length/non-zero check (len={len(key_cipher_hex)} < 512)."
        )

    capsule = {
        "version": "GENO-ASYM-RSA-OAEP-v2",
        "algorithm": f"RSA-OAEP-{pubkey.key_size}/SHA-256",
        "owner": owner_addr,
        "recipient": buyer_addr,
        "keyCipher": key_cipher_hex,
        "timestamp": int(time.time() * 1000),
    }
    if summary_key_hex:
        clean_sum_hex = summary_key_hex.strip()
        if clean_sum_hex.lower().startswith("0x"):
            clean_sum_hex = clean_sum_hex[2:]
        if len(clean_sum_hex) == 64:
            sum_ciphertext = pubkey.encrypt(bytes.fromhex(clean_sum_hex), oaep_padding)
            capsule["summaryKeyCipher"] = sum_ciphertext.hex()
    return json.dumps(capsule, separators=(",", ":"))


def compute_pubkey_hash(pubkey_str: str) -> str:
    """Compute canonical keccak256 hex digest matching Solidity keccak256(bytes(researcherPublicKeys[buyer]))."""
    return Web3.to_hex(Web3.keccak(text=pubkey_str or ""))


def get_logs_chunked(event_obj, from_block: int, to_block: int, chunk_size: int = DEFAULT_LOG_CHUNK_SIZE):
    """Fetch event logs in bounded block ranges with adaptive bisection on RPC range-limit errors."""
    if from_block > to_block:
        return []
    logs = []
    cur = from_block
    while cur <= to_block:
        end = min(cur + chunk_size - 1, to_block)
        logs.extend(_fetch_log_window(event_obj, cur, end))
        cur = end + 1
    return logs


def _fetch_log_window(event_obj, start_blk: int, end_blk: int):
    try:
        return list(event_obj().get_logs(from_block=start_blk, to_block=end_blk))
    except Exception as err:
        if is_block_range_limit_error(err) and end_blk > start_blk:
            mid = (start_blk + end_blk) // 2
            return _fetch_log_window(event_obj, start_blk, mid) + _fetch_log_window(event_obj, mid + 1, end_blk)
        raise


def load_checkpoint(
    checkpoint_file: str,
    chain_id: int | None = None,
    registry_address: str | None = None,
    genesis_hash: str | None = None,
    latest_block: int | None = None,
    shallow_reorg_threshold: int = SHALLOW_REORG_THRESHOLD,
    json_logs: bool = False,
) -> dict:
    """Load persistent dispatcher checkpoint safely; preserve state on shallow reorgs/lagging RPCs."""
    default_cp = {
        "chainId": chain_id,
        "registryAddress": (registry_address or "").lower(),
        "genesisHash": (genesis_hash or "").lower(),
        "lastBlock": 0,
        "updatedAt": 0,
        "pendingOrders": {},
        "dispatchedKeys": {},
        "quarantined": {},
        "rotationHistory": {},
    }
    if not os.path.exists(checkpoint_file):
        return default_cp
    try:
        with open(checkpoint_file, "r", encoding="utf-8") as cf:
            raw = json.load(cf)
        if not isinstance(raw, dict):
            return default_cp
        saved_last = int(raw.get("lastBlock", 0) or 0)
        saved_chain_id = raw.get("chainId")
        saved_registry = str(raw.get("registryAddress") or "").lower()
        saved_genesis = str(raw.get("genesisHash") or "").lower()
        hard_mismatch = (
            (chain_id is not None and saved_chain_id is not None and int(saved_chain_id) != int(chain_id))
            or (registry_address and saved_registry and saved_registry != registry_address.lower())
            or (genesis_hash and saved_genesis and saved_genesis != genesis_hash.lower())
        )
        if hard_mismatch:
            emit_log(
                json_logs,
                "warn",
                "checkpoint_reset",
                f"[!] Phat hien thay doi chain/hop dong (checkpoint chainId={saved_chain_id}, "
                f"registry={saved_registry}) -> tu dong dat lai checkpoint sach!",
                savedChainId=saved_chain_id,
                savedRegistry=saved_registry,
            )
            return default_cp

        effective_last = saved_last
        if latest_block is not None and saved_last > int(latest_block):
            delta = saved_last - int(latest_block)
            if delta <= max(0, int(shallow_reorg_threshold)):
                effective_last = max(0, int(latest_block) - 5)
                emit_log(
                    json_logs,
                    "warn",
                    "shallow_reorg_clamped",
                    f"[!] Phat hien shallow reorg / RPC tre (saved={saved_last}, tip={latest_block}, "
                    f"delta={delta} <= {shallow_reorg_threshold}) -> giu nguyen state, lui lastBlock={effective_last}.",
                    savedLastBlock=saved_last,
                    tipBlock=int(latest_block),
                    effectiveLastBlock=effective_last,
                )
            else:
                emit_log(
                    json_logs,
                    "warn",
                    "deep_reorg_reset",
                    f"[!] Phat hien deep chain reset (checkpoint lastBlock={saved_last}, "
                    f"tip={latest_block}, delta={delta}) -> tu dong dat lai checkpoint sach!",
                    savedLastBlock=saved_last,
                    tipBlock=int(latest_block),
                    delta=delta,
                )
                return default_cp

        return {
            "chainId": chain_id if chain_id is not None else saved_chain_id,
            "registryAddress": (registry_address or saved_registry).lower(),
            "genesisHash": (genesis_hash or saved_genesis).lower(),
            "lastBlock": effective_last,
            "updatedAt": int(raw.get("updatedAt", 0) or 0),
            "pendingOrders": raw.get("pendingOrders") if isinstance(raw.get("pendingOrders"), dict) else {},
            "dispatchedKeys": raw.get("dispatchedKeys") if isinstance(raw.get("dispatchedKeys"), dict) else {},
            "quarantined": raw.get("quarantined") if isinstance(raw.get("quarantined"), dict) else {},
            "rotationHistory": raw.get("rotationHistory") if isinstance(raw.get("rotationHistory"), dict) else {},
        }
    except Exception:
        return default_cp


def prune_rotation_history(rotation_history: dict, now_ts: int | None = None) -> dict:
    """Prune expired (>3600s old) buyer rotation timestamps in place to keep checkpoint O(active)."""
    if not isinstance(rotation_history, dict):
        return {}
    now = int(time.time() if now_ts is None else now_ts)
    cutoff = now - 3600
    stale_keys = []
    for buyer_k, ts_list in list(rotation_history.items()):
        if not isinstance(ts_list, list):
            stale_keys.append(buyer_k)
            continue
        recent = [int(ts) for ts in ts_list if int(ts) > cutoff]
        if recent:
            rotation_history[buyer_k] = recent
        else:
            stale_keys.append(buyer_k)
    for k in stale_keys:
        rotation_history.pop(k, None)
    return rotation_history


def save_checkpoint(checkpoint_file: str, checkpoint: dict, latest_block: int) -> None:
    """Atomically persist dispatcher checkpoint."""
    abs_path = os.path.abspath(checkpoint_file)
    os.makedirs(os.path.dirname(abs_path), exist_ok=True)
    payload = {
        "chainId": checkpoint.get("chainId"),
        "registryAddress": checkpoint.get("registryAddress", ""),
        "genesisHash": checkpoint.get("genesisHash", ""),
        "lastBlock": int(latest_block),
        "updatedAt": int(time.time()),
        "pendingOrders": checkpoint.get("pendingOrders", {}),
        "dispatchedKeys": checkpoint.get("dispatchedKeys", {}),
        "quarantined": checkpoint.get("quarantined", {}),
        "rotationHistory": checkpoint.get("rotationHistory", {}),
    }
    tmp_path = f"{abs_path}.tmp"
    with open(tmp_path, "w", encoding="utf-8") as cf:
        json.dump(payload, cf, indent=2)
    os.replace(tmp_path, abs_path)


def build_error_selector_map(*abis) -> dict[str, str]:
    """Build 4-byte lowercase selector ('0x........') -> custom error name map from contract ABIs."""
    selector_map: dict[str, str] = {}
    for abi in abis:
        if not isinstance(abi, list):
            continue
        for entry in abi:
            if not isinstance(entry, dict) or entry.get("type") != "error":
                continue
            name = entry.get("name")
            if not name:
                continue
            sig_types = ",".join(str(inp.get("type", "")) for inp in entry.get("inputs", []))
            selector = Web3.to_hex(Web3.keccak(text=f"{name}({sig_types})")[:4]).lower()
            selector_map[selector] = name
    return selector_map


def decode_custom_error(err: Exception, selector_map: dict[str, str]) -> str | None:
    """Decode Solidity custom error name from exception message, args, or 4-byte selector."""
    candidates = [str(err)]
    for attr in ("data", "message"):
        val = getattr(err, attr, None)
        if val is not None:
            candidates.append(str(val))
    for arg in getattr(err, "args", ()):
        candidates.append(str(arg))

    combined = " ".join(candidates)
    for err_name in set(selector_map.values()):
        if err_name in combined:
            return err_name
    for match in re.findall(r"0x[0-9a-fA-F]{8}", combined):
        sel = match.lower()
        if sel in selector_map:
            return selector_map[sel]
    return None


def _is_contract_revert_error(err: Exception, selector_map: dict[str, str] | None = None) -> bool:
    """Distinguish deterministic EVM contract reverts from transient network/RPC errors."""
    if ContractCustomError and isinstance(err, ContractCustomError):
        return True
    if ContractLogicError and isinstance(err, ContractLogicError):
        return True
    if selector_map and decode_custom_error(err, selector_map) is not None:
        return True
    msg = str(err).lower()
    revert_tokens = (
        "execution reverted",
        "reverted with",
        "vm exception",
        "revert:",
        "custom error",
        "enforcedpause",
        "reentrancyguardreentrantcall",
        "invalidcapsuleformat",
        "accessnotgranted",
        "accessexpired",
        "disputewindowexpired",
        "escrownotactive",
        "escrowdisputederror",
        "datanotactive",
        "notdataowner",
        "emptycapsule",
        "invalidaddress",
        "capsulealreadydelivered",
    )
    return any(tok in msg for tok in revert_tokens)


TRANSIENT_REVERT_ERRORS = frozenset(
    {"NotDataOwner", "DataNotActive", "EscrowDisputedError", "EnforcedPause", "ReentrancyGuardReentrantCall"}
)
TERMINAL_ORDER_ERRORS = frozenset(
    {"AccessExpired", "DisputeWindowExpired", "EscrowNotActive", "AccessNotGranted", "DataNotFound"}
)
QUARANTINE_REVERT_ERRORS = frozenset({"InvalidCapsuleFormat", "EmptyCapsule", "InvalidAddress"})


def _receipt_field(receipt, field: str, default=None):
    if isinstance(receipt, dict):
        return receipt.get(field, default)
    return getattr(receipt, field, default)


def classify_store_capsule_error(
    err: Exception,
    selector_map: dict[str, str] | None = None,
    quarantine_unknown_revert: bool = False,
) -> tuple[str, str | None]:
    """Classify storeTransformedCapsule preflight/re-simulation failure into already_delivered, prune, transient, or quarantine."""
    smap = selector_map or {}
    err_str = str(err)
    decoded_err = decode_custom_error(err, smap)

    if decoded_err == "CapsuleAlreadyDelivered" or "CapsuleAlreadyDelivered" in err_str:
        return "already_delivered", "CapsuleAlreadyDelivered"

    for name in TERMINAL_ORDER_ERRORS:
        if decoded_err == name or name in err_str:
            return "prune", decoded_err or name

    for name in TRANSIENT_REVERT_ERRORS:
        if decoded_err == name or name in err_str:
            return "transient", decoded_err or name

    if not _is_contract_revert_error(err, smap):
        return "transient", decoded_err

    for name in QUARANTINE_REVERT_ERRORS:
        if decoded_err == name or name in err_str:
            return "quarantine", decoded_err or name

    if quarantine_unknown_revert:
        return "quarantine", decoded_err or "revert"
    return "transient", decoded_err or "unclassified_revert"


def classify_mined_revert(
    tx_fn,
    worker_account: str,
    receipt,
    gas_limit: int,
    selector_map: dict[str, str] | None = None,
) -> tuple[str, str | None]:
    """Classify a mined reverted storeTransformedCapsule tx without blindly quarantining transient races."""
    gas_used = int(_receipt_field(receipt, "gasUsed", 0) or 0)
    if gas_limit > 0 and gas_used >= int(gas_limit * 0.98):
        return "transient", "out_of_gas"

    block_num = _receipt_field(receipt, "blockNumber", None)
    call_targets = [block_num, "latest"] if block_num is not None else ["latest"]
    for idx, blk_id in enumerate(call_targets):
        try:
            tx_fn.call({"from": worker_account}, block_identifier=blk_id)
            return "transient", "intra_block_race"
        except Exception as sim_err:
            if _is_contract_revert_error(sim_err, selector_map):
                return classify_store_capsule_error(sim_err, selector_map, quarantine_unknown_revert=False)
            if idx == 0 and len(call_targets) > 1:
                continue
            return "transient", "resim_rpc_error"
    return "transient", "unknown_revert"


def mark_pending_order(
    cp_pending: dict,
    key: str,
    data_id: int,
    buyer_addr: str,
    is_escrow_flag: bool,
    reason: str,
) -> None:
    """Persist transiently skipped order into checkpoint pendingOrders so it survives >5 blocks."""
    now_ts = int(time.time())
    existing = cp_pending.get(key)
    cp_pending[key] = {
        "dataId": int(data_id),
        "buyer": buyer_addr,
        "isEscrow": bool(is_escrow_flag or (existing.get("isEscrow") if isinstance(existing, dict) else False)),
        "reason": str(reason)[:240],
        "addedAt": int(existing.get("addedAt")) if isinstance(existing, dict) and existing.get("addedAt") else now_ts,
        "updatedAt": now_ts,
    }


def unpack_abi_outputs(abi: list, fn_name: str, values) -> dict:
    """Map positional return tuple from web3.py call() to ABI output parameter names."""
    for entry in abi:
        if entry.get("type") == "function" and entry.get("name") == fn_name:
            outputs = entry.get("outputs", [])
            if len(outputs) == 1 and outputs[0].get("type") == "tuple" and isinstance(values, (list, tuple)):
                comps = outputs[0].get("components", [])
                return {comp.get("name", str(idx)): values[idx] for idx, comp in enumerate(comps) if idx < len(values)}
            return {out.get("name", str(idx)): values[idx] for idx, out in enumerate(outputs) if idx < len(values)}
    return {}


def build_fee_params(w3: Web3, bump_factor: float = 1.0) -> dict:
    """Construct EIP-1559 fee parameters (with optional fee bump) or legacy gasPrice fallback."""
    try:
        latest_blk = w3.eth.get_block("latest")
        base_fee = latest_blk.get("baseFeePerGas")
    except Exception:
        base_fee = None

    if base_fee is not None:
        try:
            prio_fee = int(w3.eth.max_priority_fee)
        except Exception:
            prio_fee = int(w3.to_wei(1, "gwei"))
        prio_fee = max(int(prio_fee * bump_factor), int(w3.to_wei(1, "gwei")))
        max_fee = max(int(int(base_fee) * 2 * bump_factor) + prio_fee, prio_fee)
        return {
            "maxPriorityFeePerGas": prio_fee,
            "maxFeePerGas": max_fee,
        }
    try:
        return {"gasPrice": max(int(w3.eth.gas_price * bump_factor), 1)}
    except Exception:
        return {}


def main():
    import argparse

    parser = argparse.ArgumentParser(
        description="Genomics on Blockchain - Automated Capsule Dispatcher Service"
    )
    parser.add_argument(
        "--from-block",
        type=int,
        default=None,
        help="Block bat dau quet su kien (neu bo trong se dung checkpoint hoac block_window gan nhat)",
    )
    parser.add_argument(
        "--block-window",
        type=int,
        default=2000,
        help="So luong block toi da quet nguoc ve truoc khi khong co checkpoint (mac dinh: 2000)",
    )
    parser.add_argument(
        "--chunk-size",
        type=int,
        default=DEFAULT_LOG_CHUNK_SIZE,
        help=f"Kich thuoc cua so block cho get_logs (mac dinh: {DEFAULT_LOG_CHUNK_SIZE})",
    )
    parser.add_argument(
        "--rpc-url",
        default=os.getenv("RPC_URL", "http://127.0.0.1:8545"),
        help="EVM RPC endpoint URL (mac dinh: http://127.0.0.1:8545)",
    )
    parser.add_argument(
        "--private-key",
        default=os.getenv("DISPATCHER_PRIVATE_KEY") or os.getenv("WORKER_PRIVATE_KEY"),
        help="Private key cua worker de ky giao dich offline (bat buoc tru khi truyen --unlocked-local-signer)",
    )
    parser.add_argument(
        "--unlocked-local-signer",
        action="store_true",
        help="Chi dung cho moi truong Hardhat localhost dev: cho phep dung unlocked Deployer signer tu node cuc bo",
    )
    parser.add_argument(
        "--vault-file",
        default=os.getenv("DISPATCHER_VAULT_FILE"),
        help="Duong dan tep JSON seed/custodial vault (ho tro tu dong hot-reload khi mtime thay doi)",
    )
    parser.add_argument(
        "--registry-address",
        default=os.getenv("REGISTRY_ADDRESS", ""),
        help="Ghi de dia chi GenomicsRegistry tai runtime (mac dinh doc tu contractAddresses.json)",
    )
    parser.add_argument(
        "--deployed-block",
        default=os.getenv("DEPLOYED_BLOCK", ""),
        help="Ghi de deployedBlock tai runtime (mac dinh doc tu contractAddresses.json)",
    )
    parser.add_argument(
        "--watch",
        action="store_true",
        help="Chay che do daemon poll lien tuc voi exponential backoff khi loi RPC tam thoi",
    )
    parser.add_argument(
        "--interval",
        type=float,
        default=5.0,
        help="Thoi gian nghi (giay) giua cac chu ky poll o che do --watch (mac dinh: 5.0)",
    )
    parser.add_argument(
        "--max-cycles",
        type=int,
        default=None,
        help="So chu ky toi da (mac dinh: 1 khi chay don le, 0 = vo han khi bat --watch)",
    )
    parser.add_argument(
        "--checkpoint",
        default=None,
        help="Duong dan tep JSON checkpoint tuy chinh (mac dinh: .local/dispatcher_checkpoint.json)",
    )
    parser.add_argument(
        "--max-rotations-per-hour",
        type=int,
        default=DEFAULT_MAX_ROTATIONS_PER_HOUR,
        help=f"Gioi han xoay khoa RSA toi da moi gio cho moi nguoi mua (mac dinh: {DEFAULT_MAX_ROTATIONS_PER_HOUR})",
    )
    parser.add_argument(
        "--json-logs",
        action="store_true",
        help="Xuat nhat ky dang JSON cau truc cho he thong thu thap log production",
    )
    parser.add_argument(
        "--health-port",
        type=int,
        default=0,
        help="Cong HTTP cho /healthz va /metrics Prometheus (0 = tat, mac dinh: 0)",
    )
    parser.add_argument(
        "--health-host",
        default="127.0.0.1",
        help="Dia chi bind cua HTTP health/metrics server (mac dinh: 127.0.0.1)",
    )
    args, _unknown = parser.parse_known_args()
    json_logs = bool(args.json_logs)
    max_rotations_per_hour = max(1, int(args.max_rotations_per_hour))

    emit_log(json_logs, "info", "startup", "=" * 75)
    emit_log(json_logs, "info", "startup", "[DAEMON] AUTOMATED GENOMICS CAPSULE DISPATCHER - GENOCHAIN PROTOCOL")
    emit_log(json_logs, "info", "startup", "=" * 75)

    rpc_url = args.rpc_url
    w3 = Web3(Web3.HTTPProvider(rpc_url))

    base_dir = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    contracts_dir = os.path.join(base_dir, "frontend", "src", "contracts")

    addresses_file = os.path.join(contracts_dir, "contractAddresses.json")
    registry_abi_file = os.path.join(contracts_dir, "GenomicsRegistryABI.json")
    nft_abi_file = os.path.join(contracts_dir, "GenomicNFTABI.json")
    seed_vault_file = (
        os.path.abspath(args.vault_file)
        if args.vault_file
        else os.path.join(base_dir, ".local", "dispatcher_seed_vault.json")
    )

    if not os.path.exists(addresses_file) or not os.path.exists(registry_abi_file):
        emit_log(json_logs, "error", "config_missing", "[!] Thieu contractAddresses.json hoac GenomicsRegistryABI.json. Hay deploy contract truoc!")
        sys.exit(1)

    with open(addresses_file, "r", encoding="utf-8") as f:
        addresses = json.load(f)
    with open(registry_abi_file, "r", encoding="utf-8") as f:
        registry_abi = json.load(f)
    nft_abi = None
    if os.path.exists(nft_abi_file):
        with open(nft_abi_file, "r", encoding="utf-8") as f:
            nft_abi = json.load(f)

    raw_dep_override = str(args.deployed_block or "").strip()
    deployed_block = max(
        0,
        int(raw_dep_override) if raw_dep_override.isdigit() else int(addresses.get("deployedBlock", 0) or 0),
    )

    vault_stat_sig = get_vault_file_stat_sig(seed_vault_file)
    seed_keys, seed_summary_keys = load_vault_keys(seed_vault_file, base_dir)

    raw_reg_override = str(args.registry_address or "").strip()
    if raw_reg_override:
        if not Web3.is_address(raw_reg_override):
            emit_log(json_logs, "error", "invalid_registry_address", f"[!] Dia chi --registry-address khong hop le: {raw_reg_override}")
            sys.exit(1)
        registry_address = Web3.to_checksum_address(raw_reg_override)
    else:
        registry_address = addresses.get("GenomicsRegistry")
    emit_log(
        json_logs,
        "info",
        "config_loaded",
        f"[+] Dia chi GenomicsRegistry : {registry_address} (deployedBlock={deployed_block})",
        registryAddress=registry_address,
        deployedBlock=deployed_block,
        vaultFile=seed_vault_file,
        seedKeyCount=len(seed_keys),
    )
    if not json_logs:
        print(f"[+] So luong seed keys nap   : {len(seed_keys)} datasets ({seed_vault_file})")
    if len(seed_keys) == 0:
        emit_log(
            json_logs,
            "warn",
            "vault_empty_waiting",
            "[WARN] Vault custodial hien tai rong (0 dataset keys). Sovereign donor giao khoa truc tiep tu trinh duyet; daemon se tu dong hot-reload ngay khi tep vault duoc cap nhat.",
            vaultFile=seed_vault_file,
        )

    # Fail fast on missing or malformed --private-key BEFORE touching chain state (zero silent Deployer fallback)
    worker_account = None
    if args.private_key:
        try:
            worker_account = w3.eth.account.from_key(args.private_key).address
        except Exception as pk_err:
            emit_log(json_logs, "error", "invalid_private_key", f"[!] Loi --private-key khong hop le (tu choi fallback ve Deployer): {pk_err}")
            sys.exit(1)
    elif args.unlocked_local_signer:
        worker_account = addresses.get("Deployer")
        if not worker_account:
            emit_log(json_logs, "error", "missing_local_deployer", "[!] --unlocked-local-signer duoc bat nhung contractAddresses.json khong co truong Deployer.")
            sys.exit(1)
        emit_log(
            json_logs,
            "warn",
            "unlocked_local_signer_enabled",
            f"[WARN] Dang dung --unlocked-local-signer ({worker_account}) cho moi truong dev Hardhat cuc bo.",
            worker=worker_account,
        )
    else:
        emit_log(
            json_logs,
            "error",
            "missing_private_key",
            "[!] Thieu DISPATCHER_PRIVATE_KEY / WORKER_PRIVATE_KEY / --private-key. Tu choi tu dong fallback sang tai khoan Deployer (chi dung --unlocked-local-signer cho dev cuc bo).",
        )
        sys.exit(1)

    if not w3.is_connected():
        emit_log(json_logs, "error", "rpc_unreachable", f"[!] Node RPC tai {rpc_url} khong the ket noi.", rpcUrl=rpc_url)
        if not json_logs:
            print("[*] De khoi chay daemon:")
            print("    1. cmd /c npx hardhat node")
            print("    2. cmd /c npx hardhat run scripts/deploy/deploy.js --network localhost")
            print("    3. cmd /c python scripts/demo/capsule_dispatcher.py --unlocked-local-signer")
        sys.exit(1)

    emit_log(json_logs, "info", "rpc_connected", "[OK] Da ket noi thanh cong voi EVM RPC Node!", rpcUrl=rpc_url)
    live_chain_id = int(w3.eth.chain_id)
    if args.unlocked_local_signer:
        if live_chain_id not in (31337, 1337):
            emit_log(
                json_logs,
                "error",
                "unlocked_signer_non_local_chain",
                f"[!] Tu choi --unlocked-local-signer tren mang khong phai local dev (chainId={live_chain_id}). Hay dung DISPATCHER_PRIVATE_KEY.",
                chainId=live_chain_id,
            )
            sys.exit(1)
    registry = w3.eth.contract(address=registry_address, abi=registry_abi)
    error_selector_map = build_error_selector_map(registry_abi, nft_abi)

    nft = None
    nft_address = resolve_genomic_nft_address(registry, addresses, registry_address)
    if nft_address and nft_abi:
        nft = w3.eth.contract(address=nft_address, abi=nft_abi)

    checkpoint_file = (
        os.path.abspath(args.checkpoint)
        if args.checkpoint
        else os.path.join(base_dir, ".local", "dispatcher_checkpoint.json")
    )
    chunk_size = max(1, int(args.chunk_size))
    max_cycles = args.max_cycles if args.max_cycles is not None else (0 if args.watch else 1)
    poll_interval = max(0.2, float(args.interval))
    cycle_num = 0
    consecutive_rpc_errors = 0

    metrics_lock = threading.Lock()
    metrics_state = {
        "rpcConnected": True,
        "chainId": live_chain_id,
        "lastBlock": deployed_block,
        "cyclesTotal": 0,
        "seedKeyCount": len(seed_keys),
        "dispatchedTotal": 0,
        "quarantinedTotal": 0,
        "skippedTotal": 0,
        "rotationRateLimitedTotal": 0,
        "rpcErrorsTotal": 0,
        "pendingOrders": 0,
        "activeDispatched": 0,
        "quarantined": 0,
        "updatedAt": int(time.time()),
    }
    health_server = None
    if int(args.health_port) > 0:
        health_server, _health_thread = start_health_server(
            args.health_host, int(args.health_port), metrics_state, metrics_lock
        )
        emit_log(
            json_logs,
            "info",
            "health_server_started",
            f"[+] Health/Metrics server listening on http://{args.health_host}:{int(args.health_port)} (/healthz, /metrics)",
            host=args.health_host,
            port=int(args.health_port),
        )

    def is_already_delivered_same_key(cp_dispatched: dict, key: str, buyer_addr: str) -> bool:
        prev = cp_dispatched.get(key)
        if not isinstance(prev, dict) or not prev.get("pubkeyHash"):
            return False
        try:
            cur_pk = registry.functions.researcherPublicKeys(buyer_addr).call()
            return bool(cur_pk and compute_pubkey_hash(cur_pk) == prev.get("pubkeyHash"))
        except Exception:
            return False

    def prune_order_state(cp_pending: dict, cp_dispatched: dict, cp_quarantined: dict, key: str) -> None:
        cp_pending.pop(key, None)
        cp_dispatched.pop(key, None)
        cp_quarantined.pop(key, None)

    def _shutdown_health_server():
        nonlocal health_server
        srv = health_server
        health_server = None
        if srv is not None:
            try:
                srv.shutdown()
                srv.server_close()
            except Exception:
                pass

    atexit.register(_shutdown_health_server)

    stop_event = threading.Event()
    received_signal = []

    def _handle_shutdown_signal(signum, _frame):
        # Strictly async-signal-safe: avoid print/stdout locks inside signal handler
        sig_label = "SIGTERM" if signum == getattr(signal, "SIGTERM", None) else "SIGINT"
        received_signal.append(sig_label)
        stop_event.set()

    for sig_name in ("SIGTERM", "SIGINT"):
        sig_val = getattr(signal, sig_name, None)
        if sig_val is not None:
            try:
                signal.signal(sig_val, _handle_shutdown_signal)
            except (ValueError, OSError, AttributeError):
                pass

    while not stop_event.is_set() and (max_cycles == 0 or cycle_num < max_cycles):
        cycle_num += 1
        try:
            # Dynamic custodial vault hot-reload when --vault-file mtime/size changes
            cur_vault_sig = get_vault_file_stat_sig(seed_vault_file)
            if cur_vault_sig != vault_stat_sig:
                try:
                    new_keys, new_sum_keys = load_vault_keys(seed_vault_file, base_dir)
                    seed_keys = new_keys
                    seed_summary_keys = new_sum_keys
                    vault_stat_sig = cur_vault_sig
                    with metrics_lock:
                        metrics_state["seedKeyCount"] = len(seed_keys)
                    emit_log(
                        json_logs,
                        "info",
                        "vault_reloaded",
                        f"[+] Da hot-reload custodial vault: {len(seed_keys)} dataset keys ({seed_vault_file})",
                        vaultFile=seed_vault_file,
                        seedKeyCount=len(seed_keys),
                    )
                except Exception as vault_err:
                    emit_log(
                        json_logs,
                        "warn",
                        "vault_reload_error",
                        f"[!] Khong the hot-reload vault (giu nguyen bo khoa hien tai): {vault_err}",
                        error=str(vault_err)[:240],
                    )

            if not w3.is_connected():
                raise ConnectionError(f"Lost RPC connectivity to {rpc_url}")

            latest_block = w3.eth.block_number
            try:
                chain_id = int(w3.eth.chain_id)
            except Exception:
                chain_id = None
            try:
                genesis_blk = w3.eth.get_block(0)
                genesis_hash = Web3.to_hex(genesis_blk["hash"]) if genesis_blk and genesis_blk.get("hash") else ""
            except Exception:
                genesis_hash = ""
            try:
                global_dispatcher = Web3.to_checksum_address(registry.functions.capsuleDispatcher().call())
            except Exception:
                global_dispatcher = ""

            checkpoint = load_checkpoint(
                checkpoint_file,
                chain_id=chain_id,
                registry_address=registry_address,
                genesis_hash=genesis_hash,
                latest_block=latest_block,
                json_logs=json_logs,
            )
            saved_block = checkpoint["lastBlock"]
            pending_orders = checkpoint["pendingOrders"]
            dispatched_keys = checkpoint["dispatchedKeys"]
            quarantined = checkpoint["quarantined"]
            rotation_history = checkpoint["rotationHistory"]

            if args.from_block is not None and cycle_num == 1:
                start_block = max(0, args.from_block)
            elif 0 < saved_block <= latest_block:
                start_block = max(deployed_block, saved_block - 5)  # Recheck 5 blocks for chain safety
            elif deployed_block > 0:
                start_block = min(latest_block, deployed_block)
            else:
                start_block = max(0, latest_block - args.block_window)

            emit_log(
                json_logs,
                "info",
                "cycle_start",
                f"[+] Chu ky #{cycle_num} | Pham vi block quet su kien: #{start_block} -> #{latest_block} (chunk={chunk_size})",
                cycle=cycle_num,
                startBlock=start_block,
                latestBlock=latest_block,
                chunkSize=chunk_size,
            )

            # Build deduplicated candidate orders: map (dataId, buyer_lower) -> task metadata
            candidate_map = {}

            def add_candidate(data_id: int, buyer_addr: str, is_escrow: bool = False, confirmed_order: bool = True):
                if not buyer_addr:
                    return
                d_id = int(data_id)
                key = f"{d_id}:{buyer_addr.lower()}"
                existing_entry = candidate_map.get(key)
                if existing_entry:
                    existing_entry["isEscrow"] = existing_entry["isEscrow"] or is_escrow
                    existing_entry["confirmedOrder"] = existing_entry["confirmedOrder"] or confirmed_order
                else:
                    candidate_map[key] = {
                        "orderKey": key,
                        "dataId": d_id,
                        "buyer": Web3.to_checksum_address(buyer_addr),
                        "isEscrow": bool(is_escrow),
                        "confirmedOrder": bool(confirmed_order),
                    }

            # 1. Re-queue persisted active orders for late pubkey registration, key rotation, and pruning
            for _k, entry in list(pending_orders.items()):
                if isinstance(entry, dict) and entry.get("dataId") and entry.get("buyer"):
                    add_candidate(entry["dataId"], entry["buyer"], bool(entry.get("isEscrow", False)), confirmed_order=True)
            for _k, entry in list(dispatched_keys.items()):
                if isinstance(entry, dict) and entry.get("dataId") and entry.get("buyer"):
                    add_candidate(entry["dataId"], entry["buyer"], bool(entry.get("isEscrow", False)), confirmed_order=True)
            for _k, entry in list(quarantined.items()):
                if isinstance(entry, dict) and entry.get("dataId") and entry.get("buyer"):
                    add_candidate(entry["dataId"], entry["buyer"], False, confirmed_order=True)

            # 2. Scan AccessGranted, EscrowDeposited, DirectAccessGranted, CapsuleDelivered, ResearcherKeyRegistered
            if hasattr(registry.events, "AccessGranted"):
                for ev in get_logs_chunked(registry.events.AccessGranted, start_block, latest_block, chunk_size):
                    add_candidate(ev.args.dataId, ev.args.researcher, is_escrow=False, confirmed_order=True)

            if hasattr(registry.events, "EscrowDeposited"):
                for ev in get_logs_chunked(registry.events.EscrowDeposited, start_block, latest_block, chunk_size):
                    add_candidate(ev.args.dataId, ev.args.buyer, is_escrow=True, confirmed_order=True)

            if hasattr(registry.events, "DirectAccessGranted"):
                for ev in get_logs_chunked(registry.events.DirectAccessGranted, start_block, latest_block, chunk_size):
                    add_candidate(ev.args.dataId, ev.args.recipient, is_escrow=False, confirmed_order=True)

            latest_delivered_pos: dict[str, tuple[int, int]] = {}
            if hasattr(registry.events, "CapsuleDelivered"):
                for ev in get_logs_chunked(registry.events.CapsuleDelivered, start_block, latest_block, chunk_size):
                    key = f"{int(ev.args.dataId)}:{ev.args.researcher.lower()}"
                    pos = (int(ev.blockNumber), int(ev.logIndex))
                    if key not in latest_delivered_pos or pos > latest_delivered_pos[key]:
                        latest_delivered_pos[key] = pos

            latest_key_reg_pos: dict[str, tuple[int, int]] = {}
            if hasattr(registry.events, "ResearcherKeyRegistered"):
                for ev in get_logs_chunked(registry.events.ResearcherKeyRegistered, start_block, latest_block, chunk_size):
                    r_checksum = Web3.to_checksum_address(ev.args.researcher)
                    r_lower = r_checksum.lower()
                    pos = (int(ev.blockNumber), int(ev.logIndex))
                    if r_lower not in latest_key_reg_pos or pos > latest_key_reg_pos[r_lower]:
                        latest_key_reg_pos[r_lower] = pos
                    for d_id in seed_keys.keys():
                        add_candidate(d_id, r_checksum, is_escrow=False, confirmed_order=False)

            tasks_to_process = list(candidate_map.values())
            emit_log(
                json_logs,
                "info",
                "candidates_collected",
                f"[+] Tim thay {len(tasks_to_process)} don hang/cap khoa can kiem tra tren Blockchain.",
                candidateCount=len(tasks_to_process),
            )

            dispatched_count = 0
            quarantined_count = 0
            skipped_count = 0
            rotation_rate_limited_count = 0
            next_nonce = w3.eth.get_transaction_count(worker_account, "pending")

            for task in tasks_to_process:
                order_key = task["orderKey"]
                data_id = task["dataId"]
                buyer = task["buyer"]

                if data_id not in seed_keys:
                    continue

                try:
                    # Inspect dataset status & current NFT owner
                    try:
                        data_item = registry.functions.getGenomicData(data_id).call()
                        data_fields = unpack_abi_outputs(registry_abi, "getGenomicData", data_item)
                        dataset_owner = Web3.to_checksum_address(data_fields.get("currentOwner", data_item[2]))
                        data_status = int(data_fields.get("status", data_item[9]))
                    except Exception as gd_err:
                        if decode_custom_error(gd_err, error_selector_map) == "DataNotFound":
                            prune_order_state(pending_orders, dispatched_keys, quarantined, order_key)
                        elif task["confirmedOrder"]:
                            mark_pending_order(
                                pending_orders,
                                order_key,
                                data_id,
                                buyer,
                                task["isEscrow"],
                                f"getGenomicData_rpc_error: {gd_err}",
                            )
                        skipped_count += 1
                        continue

                    if data_status != 0:
                        emit_log(
                            json_logs,
                            "info",
                            "dataset_inactive",
                            f"    [-] Bo qua dataId={data_id}, buyer={buyer[:10]}... (Dataset khong Active: status={data_status})",
                            dataId=data_id,
                            buyer=buyer,
                            status=data_status,
                        )
                        if data_status == 2:
                            prune_order_state(pending_orders, dispatched_keys, quarantined, order_key)
                        else:
                            # Paused (status == 1): persist genuine pending/active orders into pendingOrders
                            # so they are NEVER silently dropped once >5 blocks elapse before unpause!
                            keep_paused_order = False
                            paused_is_escrow = bool(task["isEscrow"])
                            try:
                                latest_ts_paused = int(w3.eth.get_block("latest")["timestamp"])
                                dep_p_raw = registry.functions.escrowDeposits(data_id, buyer).call()
                                dep_p = unpack_abi_outputs(registry_abi, "escrowDeposits", dep_p_raw)
                                p_amt = int(dep_p["amount"])
                                p_rel = bool(dep_p["released"])
                                p_ref = bool(dep_p["refunded"])
                                p_deliv = bool(dep_p["capsuleDelivered"])
                                p_pending = p_amt > 0 and (not p_rel) and (not p_ref)
                                if p_pending:
                                    paused_is_escrow = True
                                    if not p_deliv and latest_ts_paused >= int(dep_p["depositTime"]) + int(dep_p["disputeWindow"]):
                                        keep_paused_order = False
                                    else:
                                        keep_paused_order = True
                                else:
                                    grant_raw = registry.functions.accessGrants(data_id, buyer).call()
                                    grant_f = unpack_abi_outputs(registry_abi, "accessGrants", grant_raw)
                                    g_granted = bool(grant_f.get("isGranted", grant_raw[0] if len(grant_raw) > 0 else False))
                                    g_exp = int(grant_f.get("expiresAt", grant_raw[2] if len(grant_raw) > 2 else 0))
                                    keep_paused_order = g_granted and g_exp > latest_ts_paused
                            except Exception:
                                keep_paused_order = bool(task["confirmedOrder"])

                            if keep_paused_order:
                                if not is_already_delivered_same_key(dispatched_keys, order_key, buyer):
                                    mark_pending_order(
                                        pending_orders,
                                        order_key,
                                        data_id,
                                        buyer,
                                        paused_is_escrow,
                                        f"dataset_paused_status_{data_status}",
                                    )
                            else:
                                prune_order_state(pending_orders, dispatched_keys, quarantined, order_key)
                        skipped_count += 1
                        continue

                    latest_chain_ts = w3.eth.get_block("latest")["timestamp"]

                    # Inspect authoritative on-chain escrow & access grant state (ABI field-name unpacked)
                    dep_raw = registry.functions.escrowDeposits(data_id, buyer).call()
                    dep_fields = unpack_abi_outputs(registry_abi, "escrowDeposits", dep_raw)
                    escrow_amount = int(dep_fields["amount"])
                    escrow_deposit_time = int(dep_fields["depositTime"])
                    escrow_dispute_window = int(dep_fields["disputeWindow"])
                    escrow_released = bool(dep_fields["released"])
                    escrow_refunded = bool(dep_fields["refunded"])
                    escrow_delivered = bool(dep_fields["capsuleDelivered"])
                    is_pending_escrow = escrow_amount > 0 and (not escrow_released) and (not escrow_refunded)

                    has_active_grant = bool(registry.functions.hasActiveAccess(data_id, buyer).call())

                    if is_pending_escrow:
                        if registry.functions.escrowDisputed(data_id, buyer).call():
                            emit_log(
                                json_logs,
                                "info",
                                "escrow_disputed",
                                f"    [-] Bo qua dataId={data_id}, buyer={buyer[:10]}... (Escrow dang tranh chap -> luu pendingOrders)",
                                dataId=data_id,
                                buyer=buyer,
                            )
                            mark_pending_order(
                                pending_orders,
                                order_key,
                                data_id,
                                buyer,
                                True,
                                "escrow_disputed",
                            )
                            skipped_count += 1
                            continue
                        if not escrow_delivered:
                            if latest_chain_ts >= escrow_deposit_time + escrow_dispute_window:
                                emit_log(
                                    json_logs,
                                    "info",
                                    "escrow_expired",
                                    f"    [-] Bo qua dataId={data_id}, buyer={buyer[:10]}... (Escrow da qua han disputeWindow)",
                                    dataId=data_id,
                                    buyer=buyer,
                                )
                                prune_order_state(pending_orders, dispatched_keys, quarantined, order_key)
                                skipped_count += 1
                                continue
                        else:
                            lock_dl = int(registry.functions.getEscrowLockDeadline(data_id, buyer).call())
                            if lock_dl > 0 and latest_chain_ts >= lock_dl:
                                if not has_active_grant:
                                    prune_order_state(pending_orders, dispatched_keys, quarantined, order_key)
                                elif not is_already_delivered_same_key(dispatched_keys, order_key, buyer):
                                    mark_pending_order(
                                        pending_orders,
                                        order_key,
                                        data_id,
                                        buyer,
                                        True,
                                        "awaiting_escrow_release_for_rotation",
                                    )
                                skipped_count += 1
                                continue
                    else:
                        if not has_active_grant:
                            prune_order_state(pending_orders, dispatched_keys, quarantined, order_key)
                            skipped_count += 1
                            continue

                    # Promote cold-start key-rotation candidates to confirmedOrder once active escrow/grant
                    # is verified on-chain so any subsequent transient RPC error persists to pendingOrders.
                    task["confirmedOrder"] = True
                    task["isEscrow"] = bool(task["isEscrow"] or is_pending_escrow)

                    # Respect per-dataset global dispatcher opt-out (C-04) & verify worker authority cleanly (0 gas)
                    if worker_account.lower() != dataset_owner.lower():
                        explicit_worker = bool(registry.functions.isAuthorizedWorker(data_id, worker_account).call())
                        if not explicit_worker:
                            opted_out = bool(registry.functions.dispatcherDisabled(data_id).call())
                            is_global_dispatcher = bool(
                                global_dispatcher and worker_account.lower() == global_dispatcher.lower()
                            )
                            if opted_out or not is_global_dispatcher:
                                reason_msg = (
                                    "Chu so huu da tat quyen global dispatcher - 0 gas"
                                    if opted_out
                                    else "Worker chua duoc uy quyen cho bo du lieu nay - 0 gas"
                                )
                                emit_log(
                                    json_logs,
                                    "info",
                                    "worker_unauthorized",
                                    f"    [-] Bo qua dataId={data_id}, buyer={buyer[:10]}... ({reason_msg})",
                                    dataId=data_id,
                                    buyer=buyer,
                                    optedOut=opted_out,
                                )
                                if not is_already_delivered_same_key(dispatched_keys, order_key, buyer):
                                    mark_pending_order(
                                        pending_orders,
                                        order_key,
                                        data_id,
                                        buyer,
                                        is_pending_escrow,
                                        "opted_out" if opted_out else "worker_not_authorized",
                                    )
                                skipped_count += 1
                                continue

                    # Fetch buyer public key & compute hash
                    buyer_pubkey = registry.functions.researcherPublicKeys(buyer).call()
                    if not buyer_pubkey or len(buyer_pubkey.strip()) == 0:
                        emit_log(
                            json_logs,
                            "info",
                            "missing_pubkey",
                            f"    [!] Buyer {buyer} chua dang ky Public Key tren chain -> luu vao pendingOrders.",
                            dataId=data_id,
                            buyer=buyer,
                        )
                        mark_pending_order(
                            pending_orders,
                            order_key,
                            data_id,
                            buyer,
                            is_pending_escrow,
                            "missing_pubkey",
                        )
                        skipped_count += 1
                        continue

                    pubkey_hash = compute_pubkey_hash(buyer_pubkey)

                    # Quarantine check: skip if same poison-pill pubkey; auto-unquarantine if buyer updated their key
                    q_entry = quarantined.get(order_key)
                    if q_entry:
                        if q_entry.get("pubkeyHash") == pubkey_hash:
                            emit_log(
                                json_logs,
                                "info",
                                "quarantined_skipped",
                                f"    [-] Bo qua don cach ly (quarantined) dataId={data_id}, buyer={buyer[:10]}... "
                                f"(reason={q_entry.get('reason', 'invalid key/capsule')})",
                                dataId=data_id,
                                buyer=buyer,
                                reason=q_entry.get("reason", "invalid key/capsule"),
                            )
                            skipped_count += 1
                            continue
                        emit_log(
                            json_logs,
                            "info",
                            "unquarantined_new_pubkey",
                            f"    [+] Buyer {buyer[:10]}... da cap nhat Public Key moi -> go cach ly va thu lai!",
                            dataId=data_id,
                            buyer=buyer,
                        )
                        quarantined.pop(order_key, None)

                    # Check whether capsule already exists for this exact public key (prevent false cold-start rotation)
                    existing_capsule = ""
                    try:
                        existing_capsule = registry.functions.buyerCapsules(data_id, buyer).call({"from": worker_account})
                    except Exception:
                        existing_capsule = ""

                    prev_disp = dispatched_keys.get(order_key)
                    is_key_rotation = False
                    if existing_capsule and len(existing_capsule) > 0:
                        if prev_disp and prev_disp.get("pubkeyHash") == pubkey_hash:
                            pending_orders.pop(order_key, None)
                            skipped_count += 1
                            continue
                        if not prev_disp:
                            reg_pos = latest_key_reg_pos.get(buyer.lower())
                            deliv_pos = latest_delivered_pos.get(order_key)
                            # If ResearcherKeyRegistered occurred in this window and no CapsuleDelivered followed
                            # (either deliv_pos is None from an earlier block < start_block, or reg_pos > deliv_pos),
                            # treat as candidate key rotation; if buyer re-registered identical key, estimate_gas
                            # catches CapsuleAlreadyDelivered at 0 gas and persists dispatched_keys.
                            rotated_after_delivery = bool(reg_pos and (deliv_pos is None or reg_pos > deliv_pos))
                            if not rotated_after_delivery:
                                dispatched_keys[order_key] = {
                                    "dataId": data_id,
                                    "buyer": buyer,
                                    "isEscrow": is_pending_escrow,
                                    "pubkeyHash": pubkey_hash,
                                    "dispatchedAt": int(time.time()),
                                }
                                pending_orders.pop(order_key, None)
                                skipped_count += 1
                                continue
                        is_key_rotation = True
                        rot_allowed, rot_count = check_and_record_rotation_rate_limit(
                            rotation_history, buyer, max_rotations_per_hour, record=False
                        )
                        if not rot_allowed:
                            rotation_rate_limited_count += 1
                            skipped_count += 1
                            mark_pending_order(
                                pending_orders,
                                order_key,
                                data_id,
                                buyer,
                                is_pending_escrow,
                                f"rotation_rate_limited ({rot_count}/{max_rotations_per_hour} per hour)",
                            )
                            emit_log(
                                json_logs,
                                "warn",
                                "rotation_rate_limited",
                                f"    [THROTTLE] Buyer {buyer[:10]}... vuot gioi han xoay khoa ({rot_count}/{max_rotations_per_hour}/h) -> tam giu pendingOrders (0 gas).",
                                dataId=data_id,
                                buyer=buyer,
                                count=rot_count,
                                limit=max_rotations_per_hour,
                            )
                            continue
                        emit_log(
                            json_logs,
                            "info",
                            "key_rotation_detected",
                            f"    [+] Phat hien xoay khoa RSA cho dataId={data_id}, buyer={buyer[:10]}... -> dong goi lai capsule!",
                            dataId=data_id,
                            buyer=buyer,
                        )

                    # Wrap AES session key(s) with strict RSA >= 2048-bit validation
                    try:
                        capsule_json = package_rsa_capsule(
                            seed_keys[data_id],
                            buyer_pubkey,
                            buyer,
                            dataset_owner,
                            summary_key_hex=seed_summary_keys.get(data_id),
                        )
                    except Exception as wrap_err:
                        quarantined[order_key] = {
                            "dataId": data_id,
                            "buyer": buyer,
                            "pubkeyHash": pubkey_hash,
                            "reason": str(wrap_err)[:240],
                            "timestamp": int(time.time()),
                        }
                        pending_orders.pop(order_key, None)
                        quarantined_count += 1
                        emit_log(
                            json_logs,
                            "warn",
                            "capsule_wrap_quarantined",
                            f"    [QUARANTINE] Tu choi dong goi dataId={data_id}, buyer={buyer[:10]}... (0 gas): {wrap_err}",
                            dataId=data_id,
                            buyer=buyer,
                            error=str(wrap_err)[:240],
                        )
                        continue

                    # Read-only on-chain capsule format check BEFORE estimate_gas / sending
                    if nft is not None and hasattr(nft.functions, "validateCapsule"):
                        try:
                            is_valid_cap = bool(nft.functions.validateCapsule(capsule_json).call())
                        except Exception as val_err:
                            if _is_contract_revert_error(val_err, error_selector_map):
                                is_valid_cap = False
                                emit_log(
                                    json_logs,
                                    "warn",
                                    "validate_capsule_reverted",
                                    f"    [!] validateCapsule bi revert cho dataId={data_id}: {val_err}",
                                    dataId=data_id,
                                    buyer=buyer,
                                    error=str(val_err)[:240],
                                )
                            else:
                                mark_pending_order(
                                    pending_orders,
                                    order_key,
                                    data_id,
                                    buyer,
                                    is_pending_escrow,
                                    f"validateCapsule_rpc_error: {val_err}",
                                )
                                skipped_count += 1
                                emit_log(
                                    json_logs,
                                    "warn",
                                    "validate_capsule_rpc_error",
                                    f"    [!] Loi RPC tam thoi khi goi validateCapsule cho dataId={data_id}, "
                                    f"buyer={buyer[:10]}... -> luu pendingOrders (KHONG cach ly): {val_err}",
                                    dataId=data_id,
                                    buyer=buyer,
                                    error=str(val_err)[:240],
                                )
                                continue
                        if not is_valid_cap:
                            quarantined[order_key] = {
                                "dataId": data_id,
                                "buyer": buyer,
                                "pubkeyHash": pubkey_hash,
                                "reason": "GenomicNFT.validateCapsule() returned false",
                                "timestamp": int(time.time()),
                            }
                            pending_orders.pop(order_key, None)
                            quarantined_count += 1
                            emit_log(
                                json_logs,
                                "warn",
                                "validate_capsule_quarantined",
                                f"    [QUARANTINE] Capsule khong dat validateCapsule() cho dataId={data_id}, "
                                f"buyer={buyer[:10]}... (0 gas).",
                                dataId=data_id,
                                buyer=buyer,
                            )
                            continue

                    # Mandatory dry-run estimate_gas preflight: decode 4-byte custom error selectors!
                    tx_fn = registry.functions.storeTransformedCapsule(data_id, buyer, capsule_json)
                    try:
                        estimated_gas = tx_fn.estimate_gas({"from": worker_account})
                        gas_limit = max(int(estimated_gas * 1.25), 500_000)
                    except Exception as est_err:
                        err_str = str(est_err)
                        est_action, decoded_err = classify_store_capsule_error(
                            est_err, error_selector_map, quarantine_unknown_revert=False
                        )
                        if est_action == "already_delivered":
                            dispatched_keys[order_key] = {
                                "dataId": data_id,
                                "buyer": buyer,
                                "isEscrow": is_pending_escrow,
                                "pubkeyHash": pubkey_hash,
                                "dispatchedAt": int(time.time()),
                            }
                            pending_orders.pop(order_key, None)
                            quarantined.pop(order_key, None)
                            skipped_count += 1
                            emit_log(
                                json_logs,
                                "info",
                                "already_delivered",
                                f"    [-] Bo qua dataId={data_id}, buyer={buyer[:10]}... "
                                "(CapsuleAlreadyDelivered cho cung Public Key - 0 gas)",
                                dataId=data_id,
                                buyer=buyer,
                            )
                            continue
                        if est_action == "prune":
                            prune_order_state(pending_orders, dispatched_keys, quarantined, order_key)
                            skipped_count += 1
                            emit_log(
                                json_logs,
                                "info",
                                "order_pruned",
                                f"    [-] Don hang da het han/khong con hieu luc ({decoded_err or 'expired'}) cho "
                                f"dataId={data_id}, buyer={buyer[:10]}... -> don sach checkpoint (0 gas)",
                                dataId=data_id,
                                buyer=buyer,
                                reason=decoded_err or "expired",
                            )
                            continue
                        if est_action == "transient":
                            mark_pending_order(
                                pending_orders,
                                order_key,
                                data_id,
                                buyer,
                                is_pending_escrow,
                                f"estimate_gas_transient ({decoded_err or 'rpc_error'}): {err_str[:160]}",
                            )
                            skipped_count += 1
                            emit_log(
                                json_logs,
                                "warn",
                                "estimate_gas_transient",
                                f"    [!] Tam bo qua dataId={data_id}, buyer={buyer[:10]}... "
                                f"(luu pendingOrders, khong cach ly - {decoded_err or 'loi tam thoi/quyen worker'}): {err_str[:160]}",
                                dataId=data_id,
                                buyer=buyer,
                                reason=decoded_err or "rpc_error",
                                error=err_str[:160],
                            )
                            continue
                        quarantined[order_key] = {
                            "dataId": data_id,
                            "buyer": buyer,
                            "pubkeyHash": pubkey_hash,
                            "reason": f"estimate_gas reverted ({decoded_err or 'unknown'}): {err_str[:180]}",
                            "timestamp": int(time.time()),
                        }
                        pending_orders.pop(order_key, None)
                        quarantined_count += 1
                        emit_log(
                            json_logs,
                            "warn",
                            "estimate_gas_quarantined",
                            f"    [QUARANTINE] Preflight estimate_gas bi revert ({decoded_err or 'revert'}) cho "
                            f"dataId={data_id}, buyer={buyer[:10]}... -> KHONG gui giao dich (0 gas): {err_str[:160]}",
                            dataId=data_id,
                            buyer=buyer,
                            reason=decoded_err or "revert",
                            error=err_str[:160],
                        )
                        continue

                    # Bidirectional nonce reconciliation against pending pool before signing/sending
                    next_nonce = w3.eth.get_transaction_count(worker_account, "pending")

                    emit_log(
                        json_logs,
                        "info",
                        "sending_capsule_tx",
                        f"    [+] Worker {worker_account[:10]}... dang ghi RSA-OAEP capsule cho dataId={data_id}, "
                        f"buyer={buyer[:10]}... (nonce={next_nonce}, gasLimit={gas_limit})",
                        dataId=data_id,
                        buyer=buyer,
                        worker=worker_account,
                        nonce=int(next_nonce),
                        gasLimit=int(gas_limit),
                    )

                    tx_params = {
                        "from": worker_account,
                        "nonce": next_nonce,
                        "gas": gas_limit,
                        **build_fee_params(w3, bump_factor=1.0),
                    }
                    tx_dict = tx_fn.build_transaction(tx_params)

                    try:
                        if args.private_key:
                            signed_tx = w3.eth.account.sign_transaction(tx_dict, private_key=args.private_key)
                            raw_bytes = getattr(signed_tx, "rawTransaction", None) or getattr(
                                signed_tx, "raw_transaction", None
                            )
                            tx_hash = w3.eth.send_raw_transaction(raw_bytes)
                        else:
                            tx_hash = w3.eth.send_transaction(tx_dict)
                    except Exception as send_err:
                        if "underpriced" in str(send_err).lower() or "fee" in str(send_err).lower():
                            bumped_params = {
                                "from": worker_account,
                                "nonce": next_nonce,
                                "gas": gas_limit,
                                **build_fee_params(w3, bump_factor=1.25),
                            }
                            tx_dict = tx_fn.build_transaction(bumped_params)
                            if args.private_key:
                                signed_tx = w3.eth.account.sign_transaction(tx_dict, private_key=args.private_key)
                                raw_bytes = getattr(signed_tx, "rawTransaction", None) or getattr(
                                    signed_tx, "raw_transaction", None
                                )
                                tx_hash = w3.eth.send_raw_transaction(raw_bytes)
                            else:
                                tx_hash = w3.eth.send_transaction(tx_dict)
                        else:
                            try:
                                next_nonce = w3.eth.get_transaction_count(worker_account, "pending")
                            except Exception:
                                pass
                            raise

                    next_nonce += 1
                    try:
                        receipt = w3.eth.wait_for_transaction_receipt(tx_hash, timeout=120)
                    except Exception:
                        try:
                            next_nonce = w3.eth.get_transaction_count(worker_account, "pending")
                        except Exception:
                            pass
                        raise
                    if receipt.status != 1:
                        try:
                            next_nonce = w3.eth.get_transaction_count(worker_account, "pending")
                        except Exception:
                            pass
                        rev_action, rev_reason = classify_mined_revert(
                            tx_fn, worker_account, receipt, gas_limit, error_selector_map
                        )
                        tx_hex = w3.to_hex(receipt.transactionHash)
                        if rev_action == "already_delivered":
                            dispatched_keys[order_key] = {
                                "dataId": data_id,
                                "buyer": buyer,
                                "isEscrow": is_pending_escrow,
                                "pubkeyHash": pubkey_hash,
                                "dispatchedAt": int(time.time()),
                            }
                            pending_orders.pop(order_key, None)
                            quarantined.pop(order_key, None)
                            skipped_count += 1
                        elif rev_action == "prune":
                            prune_order_state(pending_orders, dispatched_keys, quarantined, order_key)
                            skipped_count += 1
                        elif rev_action == "quarantine":
                            quarantined[order_key] = {
                                "dataId": data_id,
                                "buyer": buyer,
                                "pubkeyHash": pubkey_hash,
                                "reason": f"On-chain tx reverted ({rev_reason or 'invalid_capsule'}, tx={tx_hex})",
                                "timestamp": int(time.time()),
                            }
                            pending_orders.pop(order_key, None)
                            quarantined_count += 1
                        else:
                            mark_pending_order(
                                pending_orders,
                                order_key,
                                data_id,
                                buyer,
                                is_pending_escrow,
                                f"mined_revert_transient ({rev_reason or 'race'}): tx={tx_hex}",
                            )
                            skipped_count += 1
                        emit_log(
                            json_logs,
                            "warn",
                            "capsule_tx_reverted",
                            f"    [!] Giao dich storeTransformedCapsule bi REVERT (status={receipt.status}, "
                            f"action={rev_action}, reason={rev_reason}, gasUsed={receipt.gasUsed}, TxHash={tx_hex})",
                            dataId=data_id,
                            buyer=buyer,
                            action=rev_action,
                            reason=rev_reason,
                            gasUsed=int(receipt.gasUsed),
                            txHash=tx_hex,
                        )
                        continue

                    dispatched_count += 1
                    if is_key_rotation:
                        check_and_record_rotation_rate_limit(
                            rotation_history, buyer, max_rotations_per_hour, record=True
                        )
                    pending_orders.pop(order_key, None)
                    quarantined.pop(order_key, None)
                    dispatched_keys[order_key] = {
                        "dataId": data_id,
                        "buyer": buyer,
                        "isEscrow": is_pending_escrow,
                        "pubkeyHash": pubkey_hash,
                        "dispatchedAt": int(time.time()),
                    }
                    emit_log(
                        json_logs,
                        "info",
                        "capsule_dispatched",
                        f"    [+] Da luu Capsule thanh cong! TxHash: {w3.to_hex(receipt.transactionHash)} (gasUsed={receipt.gasUsed})",
                        dataId=data_id,
                        buyer=buyer,
                        txHash=w3.to_hex(receipt.transactionHash),
                        gasUsed=int(receipt.gasUsed),
                        isKeyRotation=is_key_rotation,
                    )
                    if is_pending_escrow and not json_logs:
                        print(
                            "        -> Da giao khoa tren chuoi; cho nguoi mua xac nhan (Confirm Release) "
                            "hoac het han tranh chap."
                        )
                except Exception as item_err:
                    try:
                        next_nonce = w3.eth.get_transaction_count(worker_account, "pending")
                    except Exception:
                        pass
                    emit_log(
                        json_logs,
                        "warn",
                        "task_error",
                        f"    [!] Loi xu ly task dataId={data_id}, buyer={buyer}: {item_err}",
                        dataId=data_id,
                        buyer=buyer,
                        error=str(item_err)[:240],
                    )
                    if task.get("confirmedOrder"):
                        mark_pending_order(
                            pending_orders,
                            order_key,
                            data_id,
                            buyer,
                            bool(task.get("isEscrow", False)),
                            f"task_exception: {item_err}",
                        )
                    skipped_count += 1

            emit_log(
                json_logs,
                "info",
                "cycle_summary",
                f"[+] Tong ket chu ky #{cycle_num}: dispatched={dispatched_count}, quarantined={quarantined_count}, "
                f"pending={len(pending_orders)}, activeDispatched={len(dispatched_keys)}, skipped={skipped_count}, "
                f"rateLimited={rotation_rate_limited_count}.",
                cycle=cycle_num,
                dispatched=dispatched_count,
                quarantined=quarantined_count,
                pending=len(pending_orders),
                activeDispatched=len(dispatched_keys),
                skipped=skipped_count,
                rotationRateLimited=rotation_rate_limited_count,
                lastBlock=latest_block,
            )

            with metrics_lock:
                metrics_state["rpcConnected"] = True
                metrics_state["chainId"] = chain_id
                metrics_state["lastBlock"] = int(latest_block)
                metrics_state["cyclesTotal"] += 1
                metrics_state["dispatchedTotal"] += dispatched_count
                metrics_state["quarantinedTotal"] += quarantined_count
                metrics_state["skippedTotal"] += skipped_count
                metrics_state["rotationRateLimitedTotal"] += rotation_rate_limited_count
                metrics_state["pendingOrders"] = len(pending_orders)
                metrics_state["activeDispatched"] = len(dispatched_keys)
                metrics_state["quarantined"] = len(quarantined)
                metrics_state["updatedAt"] = int(time.time())

            try:
                prune_rotation_history(rotation_history)
                save_checkpoint(checkpoint_file, checkpoint, latest_block)
            except Exception as cp_err:
                emit_log(json_logs, "warn", "checkpoint_save_error", f"    [!] Khong the luu checkpoint: {cp_err}", error=str(cp_err))

            consecutive_rpc_errors = 0
            if args.watch and not stop_event.is_set() and (max_cycles == 0 or cycle_num < max_cycles):
                stop_event.wait(poll_interval)

        except KeyboardInterrupt:
            emit_log(json_logs, "info", "shutdown", "\n[*] Nhan tin hieu dung (SIGINT) -> dong Automated Capsule Dispatcher sach.")
            break
        except Exception as e:
            consecutive_rpc_errors += 1
            with metrics_lock:
                metrics_state["rpcConnected"] = False
                metrics_state["rpcErrorsTotal"] += 1
                metrics_state["updatedAt"] = int(time.time())
            emit_log(json_logs, "error", "cycle_error", f"[!] Loi chu ky #{cycle_num}: {e}", cycle=cycle_num, error=str(e)[:240])
            if not args.watch:
                _shutdown_health_server()
                sys.exit(1)
            backoff_s = min(60.0, poll_interval * (2 ** min(consecutive_rpc_errors - 1, 5)))
            emit_log(json_logs, "info", "backoff", f"[*] Che do --watch: cho {backoff_s:.1f}s (exponential backoff) truoc khi thu lai...", backoffSeconds=backoff_s)
            if max_cycles != 0 and cycle_num >= max_cycles:
                _shutdown_health_server()
                sys.exit(1)
            stop_event.wait(backoff_s)

    if received_signal:
        sig_label = received_signal[-1]
        emit_log(
            json_logs,
            "info",
            "shutdown_signal",
            f"\n[*] Nhan tin hieu dung ({sig_label}) -> dong Automated Capsule Dispatcher sach.",
            signal=sig_label,
        )
    _shutdown_health_server()
    emit_log(json_logs, "info", "complete", "\n[+] Hoan tat chu trinh kiem tra Automated Capsule Dispatcher.")


if __name__ == "__main__":
    main()