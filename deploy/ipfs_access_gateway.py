"""
===========================================================================
GenoChain Protocol - Private IPFS Access-Control & GDPR Art. 17 Gateway
===========================================================================
Sits in front of a strictly isolated private Kubo IPFS daemon (internal Docker
network, LIBP2P_FORCE_PNET=1, Routing.Type=none) and enforces cryptographic +
on-chain authorization with zero full-payload RAM buffering:

1. Strict CIDv0 / CIDv1 format validation (blocks path traversal & SSRF).
2. Public Active Metadata vs Private Ciphertext Separation:
   - Unauthenticated GET /ipfs/<metadataCid> returns 200 ONLY when <metadataCid>
     belongs to an Active (status == 0) dataset and is NOT a rawCid/summaryCid
     of any dataset (enabling public Marketplace catalog browsing).
   - Private rawCid, summaryCid, and all other CIDs require valid EIP-191 SIWE
     headers + live on-chain owner or hasActiveAccess(dataId, signer) proof.
3. SIWE-Authenticated Donor Upload Route (POST /api/v0/upload):
   - Verifies EIP-191 GENOCHAIN_IPFS_GATEWAY_UPLOAD_V1 signature bound to
     (chainId, registry, contentSha256, address, timestamp, nonce), streams the
     bounded payload (<= 525 MiB GNC2-framed / 500 MiB plaintext) in 64 KiB
     chunks while verifying SHA-256, and pins directly to private Kubo
     /api/v0/add?pin=true&cid-version=1.
4. Persistent SQLite Replay & GDPR State (--state-db, WAL mode):
   - DEFAULT_NONCE_TTL_SEC = 2 * MAX_AUTH_SKEW_SEC + 60 (660s) with strict '<'
     expiry comparison (eliminating 1-second boundary replays).
   - Verifies cryptographic signature AND on-chain authorization BEFORE recording
     a nonce in NonceStore (eliminating pre-auth eviction DoS).
   - Ref-counted GDPR Art. 17 erasure reconciler with 5-block reorg lookback on
     every monotonic cycle: never unpins a CID still referenced by another
     non-revoked (Active/Paused) dataset.
5. True 64 KiB Chunked Streaming (up to 525 MiB GNC2-framed / 500 MiB plaintext) & Bounded Thread Concurrency:
   - BoundedThreadingHTTPServer enforces a hard worker semaphore ceiling.
6. Production Observability & Fail-Closed CORS:
   - /healthz (JSON) and /metrics (Prometheus 0.0.4).
   - Standalone CLI --cors-origin defaults to "" (never emits wildcard '*').
===========================================================================
"""

import os
import re
import sys
import json
import time
import base64
import secrets
import signal
import hashlib
import sqlite3
import tempfile
import threading
import http.client
import urllib.request
import urllib.parse
import urllib.error
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from web3 import Web3
from eth_account import Account
from eth_account.messages import encode_defunct

CID_V0_RE = re.compile(r"^Qm[1-9A-HJ-NP-Za-km-z]{44}\Z")
CID_V1_RE = re.compile(r"^(?:b[a-z2-7]{32,128}|B[A-Z2-7]{32,128})\Z")
NONCE_RE = re.compile(r"^[A-Za-z0-9._:-]{16,128}\Z")
SHA256_HEX_RE = re.compile(r"^[0-9a-f]{64}\Z")
SAFE_FILENAME_RE = re.compile(r"^[A-Za-z0-9._-]{1,128}\Z")
CHUNK_HEX_RE = re.compile(r"^[0-9A-Fa-f]{1,16}\Z")

_BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
_BASE58_MAP = {ch: idx for idx, ch in enumerate(_BASE58_ALPHABET)}

MAX_UINT256 = (1 << 256) - 1
MAX_DATA_ID_DIGITS = 78
MAX_TS_DIGITS = 15
MAX_AUTH_SKEW_SEC = 300
DEFAULT_NONCE_TTL_SEC = 2 * MAX_AUTH_SKEW_SEC + 60  # 660s (strictly > 2 * 300s skew window)
DEFAULT_LOG_CHUNK_SIZE = 5000
MAX_STREAM_BYTES = 525 * 1024 * 1024  # 525 MiB (550,502,400 B; accommodates 500 MiB plaintext + GNC2 framing overhead)
MAX_UPLOAD_BYTES = 525 * 1024 * 1024  # 525 MiB bounded streaming upload cap matching Caddyfile max_size
STREAM_CHUNK_BYTES = 65_536     # 64 KiB streaming chunk size
CHUNK_QUOTA_BATCH_BYTES = 256 * 1024  # 256 KiB batched SQLite quota re-check interval for chunked uploads
DEFAULT_MAX_WORKERS = 64
REORG_LOOKBACK_BLOCKS = 5
DEFAULT_MAX_UPLOADS_PER_HOUR = 60
DEFAULT_MAX_UPLOAD_BYTES_PER_HOUR = 2 * 1024 * 1024 * 1024          # 2 GiB/hour per EOA
DEFAULT_MAX_GLOBAL_UPLOAD_BYTES_PER_HOUR = 10 * 1024 * 1024 * 1024  # 10 GiB/hour global budget
DEFAULT_MAX_TOTAL_PINNED_BYTES = 50 * 1024 * 1024 * 1024            # 50 GiB global pinned storage cap
DEFAULT_MIN_UPLOAD_WEI = 10**15                                     # 0.001 ETH minimum balance for onchain-eligible
DEFAULT_MIN_UPLOAD_GENO = 10**18                                    # 1 GENO minimum balance for onchain-eligible
DEFAULT_ORPHAN_PIN_TTL_SEC = 3600                                   # 1 hour orphan-pin TTL before GC
VALID_UPLOAD_POLICIES = ("onchain-eligible", "allowlist", "open-dev")
DEFAULT_UPLOAD_POLICY = "onchain-eligible"

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
    """Return True ONLY for genuine RPC block-range / log-result-size errors (never 429/rate-limit)."""
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


def _decode_base58btc(text: str) -> bytes:
    """Strictly decode a Base58btc string into raw bytes."""
    n = 0
    for ch in text:
        val = _BASE58_MAP.get(ch)
        if val is None:
            raise ValueError(f"Invalid Base58btc character: {ch!r}")
        n = n * 58 + val
    raw = n.to_bytes((n.bit_length() + 7) // 8, "big") if n else b""
    leading_zeros = len(text) - len(text.lstrip("1"))
    return (b"\x00" * leading_zeros) + raw


def _read_uvarint(buf: bytes, pos: int) -> tuple[int, int]:
    """Decode a canonical unsigned LEB128 varint (rejecting non-minimal/overflow encodings)."""
    val = 0
    shift = 0
    start = pos
    while pos < len(buf):
        b = buf[pos]
        pos += 1
        if pos - start > 1 and b == 0:
            raise ValueError("Non-canonical overlong uvarint encoding in CID.")
        val |= (b & 0x7F) << shift
        if (b & 0x80) == 0:
            return val, pos
        shift += 7
        if shift > 63:
            raise ValueError("uvarint overflow in CID.")
    raise ValueError("Truncated uvarint in CID.")


def extract_canonical_multihash(cid: str) -> str:
    """
    Strictly decode CIDv0 (Base58btc 0x12 0x20 || 32B digest) OR CIDv1 (RFC 4648 Base32
    multibase 'b'/'B' + version + IPLD codec uvarint + multihash) down to canonical
    'mh:<hash_func_code_hex>:<digest_len>:<digest_hex>'.
    Immune to CIDv0 <-> CIDv1 and IPLD codec (raw/dag-pb/dag-cbor) or case aliasing.
    """
    clean = str(cid or "").strip()
    if not clean or "/" in clean or "\\" in clean or ".." in clean:
        raise ValueError("Invalid CID: path separators or traversal sequences forbidden.")
    if CID_V0_RE.match(clean):
        raw = _decode_base58btc(clean)
        if len(raw) != 34 or raw[0] != 0x12 or raw[1] != 0x20:
            raise ValueError(f"Invalid CIDv0 multihash payload: '{clean[:64]}'")
        return f"mh:12:32:{raw[2:].hex()}"
    if CID_V1_RE.match(clean):
        b32_body = clean[1:].upper()
        rem = len(b32_body) % 8
        if rem in (1, 3, 6):
            raise ValueError(f"Invalid CIDv1 Base32 length: '{clean[:64]}'")
        padded = b32_body + ("=" * ((8 - rem) % 8))
        try:
            raw = base64.b32decode(padded, casefold=False)
        except Exception as err:
            raise ValueError(f"Invalid CIDv1 Base32 encoding: '{clean[:64]}'") from err
        # Reject non-canonical trailing padding bits in Base32 encoding
        if base64.b32encode(raw).decode("ascii").rstrip("=") != b32_body:
            raise ValueError(f"Non-canonical CIDv1 Base32 trailing bits: '{clean[:64]}'")
        version, pos = _read_uvarint(raw, 0)
        if version != 1:
            raise ValueError(f"Unsupported CIDv1 version {version}: '{clean[:64]}'")
        codec, pos = _read_uvarint(raw, pos)
        if codec <= 0 or codec > 0xFFFFFFF:
            raise ValueError(f"Unsupported CIDv1 codec 0x{codec:x}: '{clean[:64]}'")
        mh_code, pos = _read_uvarint(raw, pos)
        if mh_code <= 0:
            raise ValueError(f"Invalid CIDv1 multihash function code: '{clean[:64]}'")
        mh_len, pos = _read_uvarint(raw, pos)
        digest = raw[pos:]
        if mh_len < 16 or mh_len > 128 or len(digest) != mh_len:
            raise ValueError(f"Invalid CIDv1 multihash digest length ({len(digest)} != {mh_len}): '{clean[:64]}'")
        return f"mh:{mh_code:x}:{mh_len}:{digest.hex()}"
    raise ValueError(f"Invalid IPFS CID format: '{clean[:64]}'")


def _try_canonical_multihash(cid: str | None) -> str | None:
    clean = str(cid or "").strip()
    if not clean:
        return None
    try:
        return extract_canonical_multihash(clean)
    except ValueError:
        return None


ZERO_SHA256_HEX = "0" * 64


def _normalize_sha256_hex(val) -> str:
    """Normalize a 32-byte SHA-256 hex digest (0x-prefixed str or bytes) to lowercase 64-hex, or '' if empty/zero/invalid."""
    if val is None:
        return ""
    if isinstance(val, (bytes, bytearray)):
        s = val.hex().lower()
    else:
        s = str(val).strip().lower()
        if s.startswith("0x"):
            s = s[2:]
    if len(s) == 64 and s != ZERO_SHA256_HEX and all(c in "0123456789abcdef" for c in s):
        return s
    return ""


def _ensure_column(conn: sqlite3.Connection, table: str, column: str, col_def: str) -> None:
    """Backward-compatible SQLite ALTER TABLE migration helper for upgraded persistent state DBs."""
    cols = {r[1] for r in conn.execute(f"PRAGMA table_info({table})").fetchall()}
    if column not in cols:
        conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {col_def}")


def validate_cid(cid: str) -> str:
    """Strictly validate IPFS CIDv0/CIDv1 multihash string, rejecting path traversal or malformed encodings."""
    clean = str(cid or "").strip()
    extract_canonical_multihash(clean)
    return clean


def sanitize_upload_filename(raw_name: str | None) -> str:
    """Sanitize optional upload filename header into a safe single basename."""
    base = os.path.basename(str(raw_name or "").strip()).replace("\r", "").replace("\n", "")
    if base and SAFE_FILENAME_RE.match(base) and base not in (".", ".."):
        return base
    return "payload.enc"


def prepare_upload_spool_dir(state_db_path: str | None) -> str | None:
    """
    Create and sanitize a disk-backed upload spool directory alongside --state-db so large
    uploads (up to 525 MiB GNC2-framed / 500 MiB plaintext) never spill into RAM-backed /tmp tmpfs and trigger container OOM kills.
    Returns None for :memory: test instances.
    """
    target = str(state_db_path or "").strip()
    if not target or target == ":memory:":
        return None
    parent = os.path.dirname(os.path.abspath(target))
    if not parent:
        return None
    spool_dir = os.path.join(parent, "spool")
    os.makedirs(spool_dir, mode=0o700, exist_ok=True)
    try:
        for entry in os.scandir(spool_dir):
            if entry.is_file(follow_symlinks=False):
                try:
                    os.unlink(entry.path)
                except OSError:
                    pass
    except OSError:
        pass
    return spool_dir


def _read_chunked_upload_body(
    rfile,
    spool,
    hasher,
    max_bytes: int,
    on_chunk_quota=None,
) -> tuple[int, int | None, str | None]:
    """
    Decode bounded HTTP/1.1 Transfer-Encoding: chunked request body directly into spool+hasher.
    Validates strict hex chunk size (`^[0-9A-Fa-f]{1,16}$`), enforces max_bytes AND optional
    incremental quota callback BEFORE reading each chunk so oversized/over-quota streams abort
    immediately without spooling hundreds of MiB to disk.
    Returns (total_bytes, error_status_or_None, error_message_or_None).
    """
    total = 0
    while True:
        size_line = rfile.readline(256)
        if not size_line:
            return total, 400, "Incomplete chunked upload body (missing chunk size line)."
        if not size_line.endswith(b"\n"):
            return total, 400, "Malformed chunked upload header line (too long)."
        raw_size_tok = size_line.split(b";", 1)[0].strip()
        if not raw_size_tok or not raw_size_tok.isascii():
            return total, 400, "Malformed chunked transfer-encoding chunk size."
        size_str = raw_size_tok.decode("ascii")
        if not CHUNK_HEX_RE.match(size_str):
            return total, 400, "Malformed chunked transfer-encoding chunk size (strict hex required)."
        chunk_size = int(size_str, 16)
        if chunk_size == 0:
            # Consume optional trailers up to terminating CRLF (strictly bounded)
            for _ in range(32):
                trailer = rfile.readline(4096)
                if not trailer or trailer in (b"\r\n", b"\n"):
                    break
            break
        if total + chunk_size > max_bytes:
            return total, 413, f"Upload exceeds maximum allowed size ({max_bytes} bytes)."
        if callable(on_chunk_quota):
            ok_q, q_msg = on_chunk_quota(chunk_size)
            if not ok_q:
                return total, 429, q_msg
        remaining = chunk_size
        while remaining > 0:
            piece = rfile.read(min(STREAM_CHUNK_BYTES, remaining))
            if not piece:
                return total, 400, "Incomplete chunked upload body (client disconnected early)."
            hasher.update(piece)
            spool.write(piece)
            remaining -= len(piece)
            total += len(piece)
        crlf = rfile.read(2)
        if crlf != b"\r\n":
            return total, 400, "Malformed chunked upload (missing trailing CRLF after chunk data)."
    if total <= 0:
        return 0, 400, "Upload payload must be non-empty."
    return total, None, None


class UploadRateLimiter:
    """
    Thread-safe SQLite-persisted atomic upload quota, pinned-storage cap & orphan-pin tracker.
    - Tracks in-flight reservations atomically (reserve / add_streamed_bytes / commit / release)
      so concurrent uploads from the same EOA strictly stay <= 1x configured limits.
    - Enforces per-signer hourly count & byte caps, global hourly byte budget, and global pinned byte cap
      across BOTH pending AND anchored pins (using persistent tracked_pins + optional live Kubo repo/stat).
    - Persists pending_uploads(cid, multihash, uploader, size_bytes, uploaded_at) for Orphan-Pin TTL GC.
    """

    def __init__(
        self,
        max_uploads_per_hour: int = DEFAULT_MAX_UPLOADS_PER_HOUR,
        max_bytes_per_hour: int = DEFAULT_MAX_UPLOAD_BYTES_PER_HOUR,
        max_global_bytes_per_hour: int = DEFAULT_MAX_GLOBAL_UPLOAD_BYTES_PER_HOUR,
        max_total_pinned_bytes: int = DEFAULT_MAX_TOTAL_PINNED_BYTES,
        window_sec: int = 3600,
        max_tracked_addresses: int = 10000,
        db_path: str = ":memory:",
        kubo_adapter=None,
        first_registrant_lookup=None,
    ):
        self._max_uploads = max(1, int(max_uploads_per_hour))
        self._max_bytes = max(1024, int(max_bytes_per_hour))
        self._max_global_bytes = max(1024, int(max_global_bytes_per_hour))
        self._max_total_pinned = max(1024, int(max_total_pinned_bytes))
        self._window = max(60, int(window_sec))
        self._max_addrs = max(100, int(max_tracked_addresses))
        self._db_path = str(db_path or ":memory:")
        self._kubo_adapter = kubo_adapter
        self._first_registrant_lookup = first_registrant_lookup
        self._repo_stat_bytes_cache: int | None = None
        self._repo_stat_mono: float = 0.0
        self._lock = threading.Lock()
        self._conn = _open_sqlite_db(self._db_path)
        self._inflight: dict[str, dict] = {}
        self._inflight_mh_claims: dict[str, tuple[str, set[str]]] = {}
        self._inflight_sha_claims: dict[str, tuple[str, set[str]]] = {}
        self._rollback_guards: dict[str, tuple[str, str]] = {}
        self._commit_rollback_verdict: dict[str, bool] = {}
        self._res_seq = 0
        self._quota_epoch = 0
        with self._lock, _sqlite_write_tx(self._conn):
            self._conn.execute(
                """
                CREATE TABLE IF NOT EXISTS gdpr_meta (
                    k TEXT PRIMARY KEY,
                    v TEXT NOT NULL
                )
                """
            )
            self._conn.execute(
                """
                CREATE TABLE IF NOT EXISTS upload_quota_events (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    address TEXT NOT NULL,
                    size_bytes INTEGER NOT NULL,
                    ts INTEGER NOT NULL
                )
                """
            )
            self._conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_upload_quota_ts ON upload_quota_events(ts)"
            )
            self._conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_upload_quota_addr_ts ON upload_quota_events(address, ts)"
            )
            self._conn.execute(
                """
                CREATE TABLE IF NOT EXISTS pending_uploads (
                    cid TEXT PRIMARY KEY,
                    multihash TEXT NOT NULL,
                    uploader TEXT NOT NULL,
                    size_bytes INTEGER NOT NULL,
                    uploaded_at INTEGER NOT NULL,
                    sha256 TEXT NOT NULL DEFAULT ''
                )
                """
            )
            _ensure_column(self._conn, "pending_uploads", "sha256", "TEXT NOT NULL DEFAULT ''")
            self._conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_pending_uploads_at ON pending_uploads(uploaded_at)"
            )
            self._conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_pending_uploads_sha256 ON pending_uploads(sha256)"
            )
            self._conn.execute(
                """
                CREATE TABLE IF NOT EXISTS tracked_pins (
                    cid TEXT PRIMARY KEY,
                    multihash TEXT NOT NULL,
                    size_bytes INTEGER NOT NULL,
                    pinned_at INTEGER NOT NULL,
                    sha256 TEXT NOT NULL DEFAULT ''
                )
                """
            )
            _ensure_column(self._conn, "tracked_pins", "sha256", "TEXT NOT NULL DEFAULT ''")
            self._conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_tracked_pins_mh ON tracked_pins(multihash)"
            )
            self._conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_tracked_pins_sha256 ON tracked_pins(sha256)"
            )
            self._conn.execute(
                """
                CREATE TABLE IF NOT EXISTS upload_provenance (
                    multihash TEXT PRIMARY KEY,
                    uploader TEXT NOT NULL,
                    created_at REAL NOT NULL,
                    sha256 TEXT NOT NULL DEFAULT ''
                )
                """
            )
            _ensure_column(self._conn, "upload_provenance", "sha256", "TEXT NOT NULL DEFAULT ''")
            self._conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_upload_provenance_sha256 ON upload_provenance(sha256)"
            )
            self._conn.execute(
                """
                CREATE TABLE IF NOT EXISTS pending_provenance_purges (
                    multihash TEXT PRIMARY KEY,
                    queued_at REAL NOT NULL
                )
                """
            )

    def _prune_locked(self, cutoff: int) -> None:
        self._conn.execute("DELETE FROM upload_quota_events WHERE ts < ?", (int(cutoff),))

    def _get_kubo_repo_bytes(self) -> int:
        stat_fn = getattr(self._kubo_adapter, "repo_stat_bytes", None)
        if not callable(stat_fn):
            return 0
        now_m = time.monotonic()
        with self._lock:
            if self._repo_stat_bytes_cache is not None and (now_m - self._repo_stat_mono) < 5.0:
                return self._repo_stat_bytes_cache
        try:
            val = stat_fn()
            if val is not None and int(val) >= 0:
                parsed = int(val)
                with self._lock:
                    self._repo_stat_bytes_cache = parsed
                    self._repo_stat_mono = time.monotonic()
                return parsed
        except Exception:
            pass
        with self._lock:
            return self._repo_stat_bytes_cache or 0

    def invalidate_repo_stat_cache(self) -> None:
        with self._lock:
            self._repo_stat_mono = 0.0

    def _usage_locked(self, addr_key: str, cutoff: int, kubo_repo_bytes: int = 0) -> tuple[int, int, int, int]:
        # Pure read-only SELECTs here (NEVER execute DELETE in read/reserve path so we never
        # hold an open SQLite write transaction across network I/O and block NonceStore).
        row_addr = self._conn.execute(
            "SELECT COUNT(*), COALESCE(SUM(size_bytes), 0) FROM upload_quota_events WHERE address = ? AND ts >= ?",
            (addr_key, int(cutoff)),
        ).fetchone()
        addr_count = int(row_addr[0])
        addr_bytes = int(row_addr[1])
        global_bytes = int(
            self._conn.execute(
                "SELECT COALESCE(SUM(size_bytes), 0) FROM upload_quota_events WHERE ts >= ?",
                (int(cutoff),),
            ).fetchone()[0]
        )
        tracked_pinned_bytes = int(
            self._conn.execute("SELECT COALESCE(SUM(size_bytes), 0) FROM tracked_pins").fetchone()[0]
        )
        pending_pinned_bytes = int(
            self._conn.execute("SELECT COALESCE(SUM(size_bytes), 0) FROM pending_uploads").fetchone()[0]
        )
        pinned_bytes = max(tracked_pinned_bytes, pending_pinned_bytes, int(kubo_repo_bytes or 0))
        for info in self._inflight.values():
            r_bytes = int(info["bytes"])
            global_bytes += r_bytes
            pinned_bytes += r_bytes
            if info["address"] == addr_key:
                addr_count += 1
                addr_bytes += r_bytes
        return addr_count, addr_bytes, global_bytes, pinned_bytes

    def set_first_registrant_lookup(self, lookup_fn) -> None:
        with self._lock:
            self._first_registrant_lookup = lookup_fn

    def _resolve_onchain_provenance_for_mh(self, mh: str, addr_key: str) -> tuple[bool, str | None, set[str]]:
        """
        Query on-chain First-Registrant Ownership (outside self._lock) before mutating upload_provenance.
        Returns (caller_allowed, canonical_provenance_owner_or_None, allowed_owner_set).
        """
        if not mh:
            return True, None, set()
        with self._lock:
            lookup = self._first_registrant_lookup
        if not callable(lookup):
            return True, None, set()
        try:
            first_reg = lookup(mh, allow_authoritative_refresh=True)
        except TypeError:
            try:
                first_reg = lookup(mh)
            except Exception:
                return False, None, set()
        except Exception:
            return False, None, set()
        if not first_reg:
            owner_obj = getattr(lookup, "__self__", None)
            last_ok_fn = getattr(owner_obj, "last_refresh_succeeded", None)
            if callable(last_ok_fn):
                try:
                    if not last_ok_fn():
                        return False, None, set()
                except Exception:
                    return False, None, set()
            return True, None, set()
        if len(first_reg) >= 3:
            _, earliest_owner, earliest_creator = first_reg[0], str(first_reg[1] or "").strip().lower(), str(first_reg[2] or "").strip().lower()
        else:
            _, earliest_owner = first_reg[0], str(first_reg[1] or "").strip().lower()
            earliest_creator = ""
        canonical_prov = earliest_creator or earliest_owner or None
        allowed = {a for a in (earliest_owner, earliest_creator) if a}
        caller_ok = (not allowed) or (addr_key in allowed)
        return caller_ok, canonical_prov, allowed

    def reserve(self, address: str, estimated_bytes: int, now_ts: int) -> tuple[bool, str, str | None]:
        """Atomically check and reserve upload slot + estimated bytes for an in-flight upload."""
        addr_key = str(address).lower()
        est = max(0, int(estimated_bytes))
        cutoff = int(now_ts) - self._window
        kubo_repo_bytes = self._get_kubo_repo_bytes()
        with self._lock:
            addr_count, addr_bytes, global_bytes, pinned_bytes = self._usage_locked(
                addr_key, cutoff, kubo_repo_bytes=kubo_repo_bytes
            )
            if addr_count + 1 > self._max_uploads:
                return False, f"Upload rate limit exceeded ({self._max_uploads} uploads/hour per signer).", None
            if addr_bytes + est > self._max_bytes:
                return False, f"Hourly upload byte quota exceeded ({self._max_bytes} bytes/hour per signer).", None
            if global_bytes + est > self._max_global_bytes:
                return False, f"Global hourly upload byte budget exceeded ({self._max_global_bytes} bytes/hour).", None
            if pinned_bytes + est > self._max_total_pinned:
                return False, f"Global pinned storage byte cap exceeded ({self._max_total_pinned} bytes).", None
            self._res_seq += 1
            self._quota_epoch += 1
            token = f"res_{self._res_seq}"
            remaining_headroom = min(
                self._max_bytes - (addr_bytes + est),
                self._max_global_bytes - (global_bytes + est),
                self._max_total_pinned - (pinned_bytes + est),
            )
            self._inflight[token] = {
                "address": addr_key,
                "bytes": est,
                "db_checked_epoch": self._quota_epoch,
                "db_batch_remaining": min(CHUNK_QUOTA_BATCH_BYTES, max(0, remaining_headroom)),
                "unverified_batch_bytes": 0,
            }
            return True, "ok", token

    def add_streamed_bytes(
        self,
        token: str,
        delta_bytes: int,
        now_ts: int,
        *,
        force_check: bool = False,
    ) -> tuple[bool, str]:
        """
        Atomically expand an in-flight chunked upload reservation before spooling the next chunk.
        Uses epoch-invalidated in-memory headroom batching (every >= 256 KiB) to avoid firing
        4 SQLite SELECT queries on every tiny HTTP chunk while preserving exact atomic caps.
        """
        delta = max(0, int(delta_bytes))
        if delta == 0 and not force_check:
            return True, "ok"
        with self._lock:
            info = self._inflight.get(token)
            if info is None:
                return False, "Upload reservation expired or invalid."
            if (
                not force_check
                and delta > 0
                and info.get("db_checked_epoch") == self._quota_epoch
                and info.get("db_batch_remaining", 0) >= delta
                and (info.get("unverified_batch_bytes", 0) + delta) < CHUNK_QUOTA_BATCH_BYTES
            ):
                info["bytes"] += delta
                info["db_batch_remaining"] -= delta
                info["unverified_batch_bytes"] += delta
                return True, "ok"

        cutoff = int(now_ts) - self._window
        kubo_repo_bytes = self._get_kubo_repo_bytes()
        with self._lock:
            info = self._inflight.get(token)
            if info is None:
                return False, "Upload reservation expired or invalid."
            addr_key = info["address"]
            _, addr_bytes, global_bytes, pinned_bytes = self._usage_locked(
                addr_key, cutoff, kubo_repo_bytes=kubo_repo_bytes
            )
            if addr_bytes + delta > self._max_bytes:
                return False, f"Hourly upload byte quota exceeded ({self._max_bytes} bytes/hour per signer)."
            if global_bytes + delta > self._max_global_bytes:
                return False, f"Global hourly upload byte budget exceeded ({self._max_global_bytes} bytes/hour)."
            if pinned_bytes + delta > self._max_total_pinned:
                return False, f"Global pinned storage byte cap exceeded ({self._max_total_pinned} bytes)."
            info["bytes"] += delta
            if len(self._inflight) > 1:
                self._quota_epoch += 1
            remaining_headroom = min(
                self._max_bytes - (addr_bytes + delta),
                self._max_global_bytes - (global_bytes + delta),
                self._max_total_pinned - (pinned_bytes + delta),
            )
            info["db_batch_remaining"] = min(CHUNK_QUOTA_BATCH_BYTES, max(0, remaining_headroom))
            info["unverified_batch_bytes"] = 0
            info["db_checked_epoch"] = self._quota_epoch
            return True, "ok"

    def verify_streamed_quota(self, token: str, now_ts: int) -> tuple[bool, str]:
        """Run an authoritative final SQLite + Kubo quota verification before committing a chunked upload."""
        return self.add_streamed_bytes(token, 0, now_ts, force_check=True)

    def _release_mh_claim_locked(self, token: str | None) -> None:
        if not token:
            return
        empty_mhs = []
        for mh_key, (owner_l, tokens) in self._inflight_mh_claims.items():
            if token in tokens:
                tokens.discard(token)
                if not tokens:
                    empty_mhs.append(mh_key)
        for mh_key in empty_mhs:
            self._inflight_mh_claims.pop(mh_key, None)
        empty_shas = []
        for sha_key, (owner_l, tokens) in self._inflight_sha_claims.items():
            if token in tokens:
                tokens.discard(token)
                if not tokens:
                    empty_shas.append(sha_key)
        for sha_key in empty_shas:
            self._inflight_sha_claims.pop(sha_key, None)

    def _is_new_unshared_claim_locked(self, token: str, multihash: str | None) -> bool:
        mh = str(multihash or "").strip()
        info = self._inflight.get(token)
        if info is None or not bool(info.get("is_new_pin_claim", False)):
            return False
        if mh:
            claim = self._inflight_mh_claims.get(mh)
            if claim is not None and len(claim[1] - {token}) > 0:
                return False
        return True

    def mark_gc_pending(self) -> None:
        """Persist gc_pending='1' and increment monotonic gc_generation in shared SQLite gdpr_meta."""
        with self._lock, _sqlite_write_tx(self._conn):
            row = self._conn.execute(
                "SELECT v FROM gdpr_meta WHERE k = 'gc_generation'"
            ).fetchone()
            cur_gen = int(row[0]) if row and str(row[0]).lstrip("-").isdigit() else 0
            new_gen = cur_gen + 1
            self._conn.executemany(
                "INSERT INTO gdpr_meta(k, v) VALUES(?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v",
                [("gc_pending", "1"), ("gc_generation", str(new_gen))],
            )

    def is_new_unshared_claim(self, token: str, multihash: str | None) -> bool:
        """
        Return True ONLY if `token` acquired a brand-new, unanchored, untracked, non-concurrent
        claim for `multihash` (so a post-pin commit fault may safely roll back its own new pin
        without ever unpinning an active on-chain dataset, previously committed upload, or
        same-owner concurrent upload).
        """
        with self._lock:
            return self._is_new_unshared_claim_locked(token, multihash)

    def acquire_rollback_eligibility(self, token: str, multihash: str | None) -> bool:
        """
        Atomically resolve whether `token` is permitted to roll back a Kubo pin after a commit()
        fault, while keeping the per-multihash rollback guard active until release_rollback_guard().
        Eliminates both the pre-commit snapshot TOCTOU race and premature claim release before unpin.
        """
        mh = str(multihash or "").strip()
        with self._lock:
            if token in self._commit_rollback_verdict:
                return bool(self._commit_rollback_verdict.pop(token))
            can_rb = self._is_new_unshared_claim_locked(token, mh)
            info = self._inflight.pop(token, None)
            sha = str(info.get("content_sha256") or "") if isinstance(info, dict) else ""
            if can_rb and (mh or sha):
                self._rollback_guards[token] = (mh, sha)
            else:
                self._release_mh_claim_locked(token)
            self._quota_epoch += 1
            return can_rb

    def release_rollback_guard(self, token: str | None) -> None:
        """Release any active rollback guard and in-flight multihash/sha claims after unpin finishes."""
        if not token:
            return
        with self._lock:
            self._commit_rollback_verdict.pop(token, None)
            if token in self._rollback_guards:
                self._rollback_guards.pop(token, None)
                self._release_mh_claim_locked(token)
                self._quota_epoch += 1

    def has_persisted_provenance_or_pin(self, multihash: str | None) -> bool | None:
        """
        Check whether `multihash` already has a persisted row in upload_provenance or tracked_pins.
        Returns True if persisted, False if absent, or None if SQLite could not be queried.
        """
        mh = str(multihash or "").strip()
        if not mh:
            return False
        try:
            with self._lock:
                p_row = self._conn.execute(
                    "SELECT 1 FROM upload_provenance WHERE multihash = ? LIMIT 1",
                    (mh,),
                ).fetchone()
                if p_row is not None:
                    return True
                t_row = self._conn.execute(
                    "SELECT 1 FROM tracked_pins WHERE multihash = ? LIMIT 1",
                    (mh,),
                ).fetchone()
                return t_row is not None
        except Exception:
            return None

    def try_claim_upload_provenance(
        self,
        token: str,
        multihash: str,
        caller_address: str,
        *,
        first_info: tuple[int, str, str] | None = None,
        content_sha256: str | None = None,
        first_sha_info: tuple[int, str, str, int] | None = None,
        sha_revoked: bool = False,
        now_ts: int,
    ) -> tuple[bool, int, str, str | None, set[str]]:
        """
        Atomically verify on-chain + SQLite upload provenance against BOTH canonical multihash AND
        codec-independent content SHA-256, and acquire in-flight claims BEFORE writing any block to
        Kubo. Prevents dual-200 concurrent duplicate races, cross-codec (dag-pb CIDv0 vs raw-leaves
        CIDv1) provenance hijacks, and GDPR Art. 17 pin-retention bypasses.
        Returns (allowed, http_status, reason, canonical_prov, allowed_owners).
        """
        mh = str(multihash or "").strip()
        sha = _normalize_sha256_hex(content_sha256)
        caller_l = str(caller_address or "").strip().lower()
        if not mh and not sha:
            return True, 200, "ok", None, set()

        if sha and sha_revoked:
            return (
                False,
                403,
                "Content SHA-256 matches a GDPR-revoked dataset; cross-codec re-upload rejected.",
                None,
                set(),
            )

        canonical_prov: str | None = None
        allowed_owners: set[str] = set()
        if first_info is not None:
            if len(first_info) >= 3:
                earliest_owner = str(first_info[1] or "").strip().lower()
                earliest_creator = str(first_info[2] or "").strip().lower()
            else:
                earliest_owner = str(first_info[1] or "").strip().lower()
                earliest_creator = ""
            canonical_prov = earliest_creator or earliest_owner or None
            allowed_owners = {a for a in (earliest_owner, earliest_creator) if a}

        sha_canonical_prov: str | None = None
        sha_allowed_owners: set[str] = set()
        if first_sha_info is not None:
            s_owner = str(first_sha_info[1] or "").strip().lower()
            s_creator = str(first_sha_info[2] or "").strip().lower() if len(first_sha_info) >= 3 else ""
            sha_canonical_prov = s_creator or s_owner or None
            sha_allowed_owners = {a for a in (s_owner, s_creator) if a}

        with self._lock:
            # Guard against racing with an active Kubo unpin rollback on the same multihash or sha256
            if mh:
                ex_mh_claim = self._inflight_mh_claims.get(mh)
                if ex_mh_claim is not None and any(t in self._rollback_guards for t in ex_mh_claim[1]):
                    return (
                        False,
                        503,
                        "CID rollback in progress; retry upload shortly.",
                        ex_mh_claim[0],
                        {ex_mh_claim[0]},
                    )
            if sha:
                ex_sha_claim = self._inflight_sha_claims.get(sha)
                if ex_sha_claim is not None and any(t in self._rollback_guards for t in ex_sha_claim[1]):
                    return (
                        False,
                        503,
                        "Content rollback in progress; retry upload shortly.",
                        ex_sha_claim[0],
                        {ex_sha_claim[0]},
                    )

            # 1. Cross-codec content SHA-256 provenance enforcement (blocks dag-pb CIDv0 <-> raw-leaves CIDv1 bypass)
            existing_sha_owners: set[str] = set()
            if sha:
                sha_rows = self._conn.execute(
                    "SELECT uploader FROM upload_provenance WHERE sha256 = ?",
                    (sha,),
                ).fetchall()
                existing_sha_owners = {str(r[0]).strip().lower() for r in sha_rows if r and r[0]}
                if first_sha_info is not None:
                    eff_sha_allowed = {a for a in (*existing_sha_owners, sha_canonical_prov, *sha_allowed_owners) if a}
                    if eff_sha_allowed and caller_l not in eff_sha_allowed:
                        return (
                            False,
                            403,
                            "Content SHA-256 is already anchored on-chain by another dataset owner (cross-codec provenance hijack rejected).",
                            sha_canonical_prov,
                            eff_sha_allowed,
                        )
                elif existing_sha_owners and caller_l not in existing_sha_owners:
                    owner_hit = sorted(existing_sha_owners)[0]
                    return (
                        False,
                        403,
                        "Content SHA-256 upload provenance already belongs to another authenticated uploader (cross-codec hijack rejected).",
                        owner_hit,
                        existing_sha_owners,
                    )
                existing_sha_claim = self._inflight_sha_claims.get(sha)
                if existing_sha_claim is not None and existing_sha_claim[0] != caller_l:
                    return (
                        False,
                        403,
                        "Content SHA-256 upload provenance is currently claimed by another concurrent uploader.",
                        existing_sha_claim[0],
                        {existing_sha_claim[0]},
                    )

            # 2. Canonical multihash provenance enforcement
            existing_prov = None
            already_tracked = False
            if mh:
                row = self._conn.execute(
                    "SELECT uploader FROM upload_provenance WHERE multihash = ?",
                    (mh,),
                ).fetchone()
                existing_prov = str(row[0]).strip().lower() if row and row[0] else None

                if first_info is not None:
                    eff_allowed = {a for a in (existing_prov, canonical_prov, *allowed_owners) if a}
                    if eff_allowed and caller_l not in eff_allowed:
                        return (
                            False,
                            403,
                            "CID multihash is already anchored on-chain by another dataset owner (post-anchor provenance hijack rejected).",
                            canonical_prov,
                            eff_allowed,
                        )
                elif existing_prov and caller_l != existing_prov:
                    return (
                        False,
                        403,
                        "CID multihash upload provenance already belongs to another authenticated uploader.",
                        existing_prov,
                        {existing_prov},
                    )

                already_tracked = (
                    self._conn.execute(
                        "SELECT 1 FROM tracked_pins WHERE multihash = ? LIMIT 1",
                        (mh,),
                    ).fetchone()
                    is not None
                )

                existing_claim = self._inflight_mh_claims.get(mh)
                if existing_claim is not None:
                    claim_owner, claim_tokens = existing_claim
                    if claim_owner != caller_l:
                        return (
                            False,
                            403,
                            "CID multihash upload provenance is currently claimed by another concurrent uploader.",
                            claim_owner,
                            {claim_owner},
                        )
                    claim_tokens.add(token)
                    # Shared concurrent same-owner upload: neither token may roll back the shared pin
                    for tok in claim_tokens:
                        tok_info = self._inflight.get(tok)
                        if tok_info is not None:
                            tok_info["is_new_pin_claim"] = False
                    is_new_pin_claim = False
                else:
                    self._inflight_mh_claims[mh] = (caller_l, {token})
                    is_new_pin_claim = (
                        first_info is None
                        and existing_prov is None
                        and not already_tracked
                    )
            else:
                is_new_pin_claim = True

            if sha:
                existing_sha_claim = self._inflight_sha_claims.get(sha)
                if existing_sha_claim is not None:
                    existing_sha_claim[1].add(token)
                else:
                    self._inflight_sha_claims[sha] = (caller_l, {token})

            eff_canonical_prov = canonical_prov or sha_canonical_prov
            eff_allowed_owners = allowed_owners | sha_allowed_owners

            cur_info = self._inflight.get(token)
            if cur_info is not None:
                cur_info["is_new_pin_claim"] = is_new_pin_claim
                cur_info["content_sha256"] = sha

            return True, 200, "ok", eff_canonical_prov, eff_allowed_owners

    def commit(
        self,
        token: str,
        actual_bytes: int,
        now_ts: int,
        *,
        cid: str | None = None,
        multihash: str | None = None,
        content_sha256: str | None = None,
        verified_onchain_provenance: tuple[bool, str | None, set[str]] | None = None,
    ) -> bool:
        """
        Finalize an in-flight reservation into persistent SQLite quota history, tracked_pins &
        pending_uploads. Returns True when committed (including quota-only cid=None commits),
        or False when cid provenance was rejected under SQLite BEGIN IMMEDIATE isolation.
        On SQLite/write exceptions, computes rollback eligibility atomically under self._lock
        and retains the per-multihash rollback guard until release_rollback_guard() completes.
        """
        now = int(now_ts)
        actual = max(0, int(actual_bytes))
        cutoff = now - self._window
        with self._lock:
            info = self._inflight.get(token)
            addr_key = info["address"] if info is not None else "unknown"
            sha = _normalize_sha256_hex(
                content_sha256 if content_sha256 is not None else (info.get("content_sha256") if info else "")
            )
        mh = (multihash or (_try_canonical_multihash(cid) if cid else "") or "").strip()
        can_claim_cid = True
        canonical_prov: str | None = None
        allowed_owners: set[str] = set()
        if cid and mh:
            if verified_onchain_provenance is not None:
                can_claim_cid, canonical_prov, allowed_owners = verified_onchain_provenance
            else:
                can_claim_cid, canonical_prov, allowed_owners = self._resolve_onchain_provenance_for_mh(mh, addr_key)

        cid_committed = True
        with self._lock:
            try:
                with _sqlite_write_tx(self._conn):
                    self._prune_locked(cutoff)
                    self._conn.execute(
                        "INSERT INTO upload_quota_events(address, size_bytes, ts) VALUES(?, ?, ?)",
                        (addr_key, actual, now),
                    )
                    if cid:
                        if mh and canonical_prov:
                            self._conn.execute(
                                """
                                INSERT INTO upload_provenance(multihash, uploader, created_at, sha256)
                                VALUES(?, ?, ?, ?)
                                ON CONFLICT(multihash) DO UPDATE SET
                                    sha256 = CASE
                                        WHEN upload_provenance.sha256 = '' AND excluded.sha256 != '' THEN excluded.sha256
                                        ELSE upload_provenance.sha256
                                    END
                                """,
                                (mh, canonical_prov, float(now), sha),
                            )
                        existing_prov = None
                        if mh:
                            row = self._conn.execute(
                                "SELECT uploader FROM upload_provenance WHERE multihash = ?",
                                (mh,),
                            ).fetchone()
                            if row and row[0]:
                                existing_prov = str(row[0]).strip().lower()
                        existing_sha_owners: set[str] = set()
                        if sha:
                            s_rows = self._conn.execute(
                                "SELECT uploader FROM upload_provenance WHERE sha256 = ?",
                                (sha,),
                            ).fetchall()
                            existing_sha_owners = {str(r[0]).strip().lower() for r in s_rows if r and r[0]}
                        sha_allows_caller = (
                            (not existing_sha_owners)
                            or (addr_key in existing_sha_owners)
                            or (bool(allowed_owners) and addr_key in allowed_owners)
                        )
                        prov_allows_caller = (
                            can_claim_cid
                            and sha_allows_caller
                            and (
                                existing_prov is None
                                or existing_prov == addr_key
                                or (bool(allowed_owners) and addr_key in allowed_owners)
                            )
                        )
                        if prov_allows_caller:
                            self._conn.execute(
                                """
                                INSERT INTO pending_uploads(cid, multihash, uploader, size_bytes, uploaded_at, sha256)
                                VALUES(?, ?, ?, ?, ?, ?)
                                ON CONFLICT(cid) DO UPDATE SET
                                    multihash = excluded.multihash,
                                    size_bytes = excluded.size_bytes,
                                    uploaded_at = excluded.uploaded_at,
                                    sha256 = CASE
                                        WHEN excluded.sha256 != '' THEN excluded.sha256
                                        ELSE pending_uploads.sha256
                                    END
                                """,
                                (cid, mh, addr_key, actual, now, sha),
                            )
                            self._conn.execute(
                                """
                                INSERT INTO tracked_pins(cid, multihash, size_bytes, pinned_at, sha256)
                                VALUES(?, ?, ?, ?, ?)
                                ON CONFLICT(cid) DO UPDATE SET
                                    multihash = excluded.multihash,
                                    size_bytes = excluded.size_bytes,
                                    pinned_at = excluded.pinned_at,
                                    sha256 = CASE
                                        WHEN excluded.sha256 != '' THEN excluded.sha256
                                        ELSE tracked_pins.sha256
                                    END
                                """,
                                (cid, mh, actual, now, sha),
                            )
                            if mh and addr_key and addr_key != "unknown":
                                self._conn.execute(
                                    """
                                    INSERT INTO upload_provenance(multihash, uploader, created_at, sha256)
                                    VALUES(?, ?, ?, ?)
                                    ON CONFLICT(multihash) DO UPDATE SET
                                        created_at = MAX(upload_provenance.created_at, excluded.created_at),
                                        sha256 = CASE
                                            WHEN upload_provenance.sha256 = '' AND excluded.sha256 != '' THEN excluded.sha256
                                            ELSE upload_provenance.sha256
                                        END
                                    """,
                                    (mh, addr_key, float(now), sha),
                                )
                            if mh:
                                self._conn.execute(
                                    "DELETE FROM pending_provenance_purges WHERE multihash = ?",
                                    (mh,),
                                )
                        else:
                            cid_committed = False
            except Exception:
                can_rb = self._is_new_unshared_claim_locked(token, mh)
                self._commit_rollback_verdict[token] = can_rb
                self._inflight.pop(token, None)
                if can_rb and (mh or sha):
                    self._rollback_guards[token] = (mh, sha)
                else:
                    self._release_mh_claim_locked(token)
                self._quota_epoch += 1
                self._repo_stat_mono = 0.0
                raise
            else:
                self._inflight.pop(token, None)
                self._release_mh_claim_locked(token)
                self._quota_epoch += 1
                self._repo_stat_mono = 0.0
        return cid_committed

    def release(self, token: str | None) -> None:
        """Release an uncommitted in-flight reservation and any per-multihash/sha claim on error or abort."""
        if not token:
            return
        with self._lock:
            self._commit_rollback_verdict.pop(token, None)
            self._rollback_guards.pop(token, None)
            self._inflight.pop(token, None)
            self._release_mh_claim_locked(token)
            self._quota_epoch += 1

    def check_allowed(self, address: str, pending_bytes: int, now_ts: int) -> tuple[bool, str]:
        addr_key = str(address).lower()
        est = max(0, int(pending_bytes))
        cutoff = int(now_ts) - self._window
        kubo_repo_bytes = self._get_kubo_repo_bytes()
        with self._lock:
            addr_count, addr_bytes, global_bytes, pinned_bytes = self._usage_locked(
                addr_key, cutoff, kubo_repo_bytes=kubo_repo_bytes
            )
            if addr_count >= self._max_uploads:
                return False, f"Upload rate limit exceeded ({self._max_uploads} uploads/hour per signer)."
            if addr_bytes + est > self._max_bytes:
                return False, f"Hourly upload byte quota exceeded ({self._max_bytes} bytes/hour per signer)."
            if global_bytes + est > self._max_global_bytes:
                return False, f"Global hourly upload byte budget exceeded ({self._max_global_bytes} bytes/hour)."
            if pinned_bytes + est > self._max_total_pinned:
                return False, f"Global pinned storage byte cap exceeded ({self._max_total_pinned} bytes)."
            return True, "ok"

    def record(self, address: str, actual_bytes: int, now_ts: int) -> None:
        addr_key = str(address).lower()
        now = int(now_ts)
        cutoff = now - self._window
        with self._lock, _sqlite_write_tx(self._conn):
            self._prune_locked(cutoff)
            self._conn.execute(
                "INSERT INTO upload_quota_events(address, size_bytes, ts) VALUES(?, ?, ?)",
                (addr_key, max(0, int(actual_bytes)), now),
            )
            self._quota_epoch += 1

    def record_pending_upload(
        self,
        cid: str,
        uploader: str,
        size_bytes: int,
        uploaded_at: int,
        *,
        content_sha256: str | None = None,
    ) -> bool:
        mh = _try_canonical_multihash(cid) or ""
        up_l = str(uploader or "").strip().lower()
        sz = max(0, int(size_bytes))
        ts = int(uploaded_at)
        sha = _normalize_sha256_hex(content_sha256)
        can_claim_cid, canonical_prov, allowed_owners = self._resolve_onchain_provenance_for_mh(mh, up_l)
        with self._lock, _sqlite_write_tx(self._conn):
            if mh and canonical_prov:
                self._conn.execute(
                    """
                    INSERT INTO upload_provenance(multihash, uploader, created_at, sha256)
                    VALUES(?, ?, ?, ?)
                    ON CONFLICT(multihash) DO UPDATE SET
                        sha256 = CASE
                            WHEN upload_provenance.sha256 = '' AND excluded.sha256 != '' THEN excluded.sha256
                            ELSE upload_provenance.sha256
                        END
                    """,
                    (mh, canonical_prov, float(ts), sha),
                )
            existing_prov = None
            if mh:
                row = self._conn.execute(
                    "SELECT uploader FROM upload_provenance WHERE multihash = ?",
                    (mh,),
                ).fetchone()
                if row and row[0]:
                    existing_prov = str(row[0]).strip().lower()
            existing_sha_owners: set[str] = set()
            if sha:
                s_rows = self._conn.execute(
                    "SELECT uploader FROM upload_provenance WHERE sha256 = ?",
                    (sha,),
                ).fetchall()
                existing_sha_owners = {str(r[0]).strip().lower() for r in s_rows if r and r[0]}
            sha_allows = (
                (not existing_sha_owners)
                or (up_l in existing_sha_owners)
                or (bool(allowed_owners) and up_l in allowed_owners)
            )
            prov_allows_caller = (
                can_claim_cid
                and sha_allows
                and (
                    existing_prov is None
                    or existing_prov == up_l
                    or (bool(allowed_owners) and up_l in allowed_owners)
                )
            )
            if not prov_allows_caller:
                return False
            self._conn.execute(
                """
                INSERT INTO pending_uploads(cid, multihash, uploader, size_bytes, uploaded_at, sha256)
                VALUES(?, ?, ?, ?, ?, ?)
                ON CONFLICT(cid) DO UPDATE SET
                    multihash = excluded.multihash,
                    size_bytes = excluded.size_bytes,
                    uploaded_at = excluded.uploaded_at,
                    sha256 = CASE
                        WHEN excluded.sha256 != '' THEN excluded.sha256
                        ELSE pending_uploads.sha256
                    END
                """,
                (cid, mh, up_l, sz, ts, sha),
            )
            self._conn.execute(
                """
                INSERT INTO tracked_pins(cid, multihash, size_bytes, pinned_at, sha256)
                VALUES(?, ?, ?, ?, ?)
                ON CONFLICT(cid) DO UPDATE SET
                    multihash = excluded.multihash,
                    size_bytes = excluded.size_bytes,
                    pinned_at = excluded.pinned_at,
                    sha256 = CASE
                        WHEN excluded.sha256 != '' THEN excluded.sha256
                        ELSE tracked_pins.sha256
                    END
                """,
                (cid, mh, sz, ts, sha),
            )
            if mh and up_l:
                self._conn.execute(
                    """
                    INSERT INTO upload_provenance(multihash, uploader, created_at, sha256)
                    VALUES(?, ?, ?, ?)
                    ON CONFLICT(multihash) DO UPDATE SET
                        created_at = MAX(upload_provenance.created_at, excluded.created_at),
                        sha256 = CASE
                            WHEN upload_provenance.sha256 = '' AND excluded.sha256 != '' THEN excluded.sha256
                            ELSE upload_provenance.sha256
                        END
                    """,
                    (mh, up_l, float(ts), sha),
                )
            if mh:
                self._conn.execute(
                    "DELETE FROM pending_provenance_purges WHERE multihash = ?",
                    (mh,),
                )
            self._quota_epoch += 1
        return True

    def backfill_upload_provenance(self, entries: list[tuple], created_at: float | None = None) -> None:
        if not entries:
            return
        ts = float(time.time() if created_at is None else created_at)
        rows = []
        seen: dict[str, tuple[str, str]] = {}
        for item in entries:
            mh_s = str(item[0] or "").strip() if len(item) >= 1 else ""
            up_s = str(item[1] or "").strip().lower() if len(item) >= 2 else ""
            sha_s = _normalize_sha256_hex(item[2]) if len(item) >= 3 else ""
            if mh_s and up_s:
                if mh_s not in seen:
                    seen[mh_s] = (up_s, sha_s)
                elif not seen[mh_s][1] and sha_s:
                    seen[mh_s] = (seen[mh_s][0], sha_s)
        for mh_s, (up_s, sha_s) in seen.items():
            rows.append((mh_s, up_s, ts, sha_s))
        if not rows:
            return
        with self._lock, _sqlite_write_tx(self._conn):
            self._conn.executemany(
                """
                INSERT INTO upload_provenance(multihash, uploader, created_at, sha256)
                VALUES(?, ?, ?, ?)
                ON CONFLICT(multihash) DO UPDATE SET
                    sha256 = CASE
                        WHEN upload_provenance.sha256 = '' AND excluded.sha256 != '' THEN excluded.sha256
                        ELSE upload_provenance.sha256
                    END
                """,
                rows,
            )

    def record_upload_provenance(
        self,
        multihash: str,
        uploader: str,
        created_at: float | None = None,
        *,
        content_sha256: str | None = None,
    ) -> None:
        mh = str(multihash or "").strip()
        up = str(uploader or "").strip().lower()
        sha = _normalize_sha256_hex(content_sha256)
        if not mh or not up:
            return
        ts = float(time.time() if created_at is None else created_at)
        with self._lock, _sqlite_write_tx(self._conn):
            self._conn.execute(
                """
                INSERT INTO upload_provenance(multihash, uploader, created_at, sha256)
                VALUES(?, ?, ?, ?)
                ON CONFLICT(multihash) DO UPDATE SET
                    sha256 = CASE
                        WHEN upload_provenance.sha256 = '' AND excluded.sha256 != '' THEN excluded.sha256
                        ELSE upload_provenance.sha256
                    END
                """,
                (mh, up, ts, sha),
            )

    def get_upload_provenance(self, multihash: str) -> str | None:
        mh = str(multihash or "").strip()
        if not mh:
            return None
        with self._lock:
            row = self._conn.execute(
                "SELECT uploader FROM upload_provenance WHERE multihash = ?",
                (mh,),
            ).fetchone()
        if row and row[0]:
            return str(row[0]).strip().lower()
        return None

    def get_upload_provenance_by_sha(self, sha256_hex: str) -> str | None:
        sha = _normalize_sha256_hex(sha256_hex)
        if not sha:
            return None
        with self._lock:
            row = self._conn.execute(
                "SELECT uploader FROM upload_provenance WHERE sha256 = ? ORDER BY created_at ASC LIMIT 1",
                (sha,),
            ).fetchone()
        if row and row[0]:
            return str(row[0]).strip().lower()
        return None

    def list_pending_uploads(self) -> list[dict]:
        with self._lock:
            rows = self._conn.execute(
                "SELECT cid, multihash, uploader, size_bytes, uploaded_at, sha256 FROM pending_uploads ORDER BY uploaded_at ASC"
            ).fetchall()
        return [
            {
                "cid": str(r[0]),
                "multihash": str(r[1]),
                "uploader": str(r[2]),
                "sizeBytes": int(r[3]),
                "uploadedAt": int(r[4]),
                "sha256": str(r[5] or ""),
            }
            for r in rows
        ]

    def close(self) -> None:
        with self._lock:
            try:
                self._conn.close()
            except Exception:
                pass


def _open_sqlite_db(db_path: str) -> sqlite3.Connection:
    """Open a thread-safe SQLite connection in WAL autocommit mode so explicit BEGIN IMMEDIATE honors busy_timeout."""
    target = str(db_path or ":memory:").strip() or ":memory:"
    if target != ":memory:":
        parent = os.path.dirname(os.path.abspath(target))
        if parent:
            os.makedirs(parent, exist_ok=True)
    conn = sqlite3.connect(target, check_same_thread=False, timeout=10.0, isolation_level=None)
    if target != ":memory:":
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA synchronous=NORMAL")
    conn.execute("PRAGMA busy_timeout=5000")
    return conn


@contextmanager
def _sqlite_write_tx(conn: sqlite3.Connection):
    """Execute SQLite mutations inside BEGIN IMMEDIATE so multi-connection WAL writes honor busy_timeout."""
    conn.execute("BEGIN IMMEDIATE")
    try:
        yield
        conn.execute("COMMIT")
    except Exception:
        try:
            conn.execute("ROLLBACK")
        except Exception:
            pass
        raise


def build_siwe_auth_message(
    chain_id: int,
    registry_address: str,
    data_id: int,
    cid: str,
    address: str,
    timestamp: int,
    nonce: str,
) -> str:
    """Build canonical domain-bound EIP-191 authorization message for private IPFS ciphertext fetch."""
    return "\n".join(
        [
            "GENOCHAIN_IPFS_GATEWAY_AUTH_V1",
            f"chainId:{int(chain_id)}",
            f"registry:{str(registry_address).lower()}",
            f"dataId:{int(data_id)}",
            f"cid:{str(cid)}",
            f"address:{str(address).lower()}",
            f"timestamp:{int(timestamp)}",
            f"nonce:{str(nonce)}",
        ]
    )


def build_siwe_upload_message(
    chain_id: int,
    registry_address: str,
    content_sha256: str,
    address: str,
    timestamp: int,
    nonce: str,
) -> str:
    """Build canonical domain-bound EIP-191 authorization message for authenticated IPFS upload."""
    clean_sha = str(content_sha256 or "").strip().lower()
    if clean_sha.startswith("0x"):
        clean_sha = clean_sha[2:]
    return "\n".join(
        [
            "GENOCHAIN_IPFS_GATEWAY_UPLOAD_V1",
            f"chainId:{int(chain_id)}",
            f"registry:{str(registry_address).lower()}",
            f"contentSha256:{clean_sha}",
            f"address:{str(address).lower()}",
            f"timestamp:{int(timestamp)}",
            f"nonce:{str(nonce)}",
        ]
    )


class NonceStore:
    """
    Thread-safe SQLite-persisted bounded TTL single-use nonce store with isolated namespaces
    ('download' vs 'upload') so upload traffic can NEVER evict unexpired download nonces.
    BOTH saturated 'download' and 'upload' buckets fail closed with 'saturated' (HTTP 429)
    instead of evicting unexpired entries (zero replay-window erosion under burst load).
    """

    def __init__(
        self,
        ttl_sec: int = DEFAULT_NONCE_TTL_SEC,
        max_entries: int = 100000,
        db_path: str = ":memory:",
        upload_max_entries: int | None = None,
    ):
        self._ttl = max(60, int(ttl_sec))
        self._max_entries = max(1, int(max_entries))
        self._upload_max_entries = (
            max(1, int(upload_max_entries))
            if upload_max_entries is not None
            else max(1, self._max_entries // 2)
        )
        self._db_path = str(db_path or ":memory:")
        self._lock = threading.Lock()
        self._conn = _open_sqlite_db(self._db_path)
        with self._lock, _sqlite_write_tx(self._conn):
            self._conn.execute(
                """
                CREATE TABLE IF NOT EXISTS nonces (
                    key TEXT PRIMARY KEY,
                    namespace TEXT NOT NULL DEFAULT 'download',
                    expires_at INTEGER NOT NULL
                )
                """
            )
            cols = {r[1] for r in self._conn.execute("PRAGMA table_info(nonces)").fetchall()}
            if "namespace" not in cols:
                self._conn.execute("ALTER TABLE nonces ADD COLUMN namespace TEXT NOT NULL DEFAULT 'download'")
            self._conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_nonces_expires_at ON nonces(expires_at)"
            )
            self._conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_nonces_ns_exp ON nonces(namespace, expires_at)"
            )

    def _prune_expired_locked(self, now: int) -> None:
        # Strictly '< now' (never '<= now') so boundary timestamp T + TTL is still protected.
        self._conn.execute("DELETE FROM nonces WHERE expires_at < ?", (now,))

    @staticmethod
    def _make_key(address: str, nonce: str, namespace: str) -> str:
        ns = str(namespace or "download").strip().lower() or "download"
        return f"{ns}:{str(address).lower()}:{nonce}"

    def is_used(
        self,
        address: str,
        nonce: str,
        now_ts: int | None = None,
        *,
        namespace: str = "download",
    ) -> bool:
        """Check whether (namespace, address, nonce) is currently recorded and unexpired without mutating state."""
        now = int(time.time() if now_ts is None else now_ts)
        key = self._make_key(address, nonce, namespace)
        with self._lock:
            row = self._conn.execute(
                "SELECT expires_at FROM nonces WHERE key = ?",
                (key,),
            ).fetchone()
            if row is None:
                return False
            return int(row[0]) >= now

    def consume_checked(
        self,
        address: str,
        nonce: str,
        now_ts: int | None = None,
        *,
        namespace: str = "download",
    ) -> str:
        """
        Atomically record (namespace, address, nonce).
        Returns 'ok', 'replay', or 'saturated' (bucket full without evicting unexpired entries).
        """
        now = int(time.time() if now_ts is None else now_ts)
        ns = str(namespace or "download").strip().lower() or "download"
        key = self._make_key(address, nonce, ns)
        expires_at = now + self._ttl
        with self._lock, _sqlite_write_tx(self._conn):
            self._prune_expired_locked(now)
            existing = self._conn.execute(
                "SELECT 1 FROM nonces WHERE key = ?",
                (key,),
            ).fetchone()
            if existing is not None:
                return "replay"
            ns_count = int(
                self._conn.execute(
                    "SELECT COUNT(*) FROM nonces WHERE namespace = ?",
                    (ns,),
                ).fetchone()[0]
            )
            bucket_cap = self._upload_max_entries if ns == "upload" else self._max_entries
            if ns_count >= bucket_cap:
                return "saturated"
            self._conn.execute(
                "INSERT INTO nonces(key, namespace, expires_at) VALUES(?, ?, ?)",
                (key, ns, expires_at),
            )
            return "ok"

    def consume(
        self,
        address: str,
        nonce: str,
        now_ts: int | None = None,
        *,
        namespace: str = "download",
    ) -> bool:
        """Atomically record (namespace, address, nonce). Returns True if fresh, False if replayed/saturated."""
        return self.consume_checked(address, nonce, now_ts=now_ts, namespace=namespace) == "ok"

    def count(self, namespace: str | None = None) -> int:
        with self._lock:
            if namespace is not None:
                ns = str(namespace).strip().lower()
                return int(
                    self._conn.execute(
                        "SELECT COUNT(*) FROM nonces WHERE namespace = ?",
                        (ns,),
                    ).fetchone()[0]
                )
            return int(self._conn.execute("SELECT COUNT(*) FROM nonces").fetchone()[0])

    def close(self) -> None:
        with self._lock:
            try:
                self._conn.close()
            except Exception:
                pass


def verify_siwe_request(
    *,
    chain_id: int,
    registry_address: str,
    data_id: int,
    cid: str,
    claimed_address: str,
    timestamp: int,
    nonce: str,
    signature: str,
    nonce_store: NonceStore,
    now_ts: int | None = None,
    max_skew_sec: int = MAX_AUTH_SKEW_SEC,
    consume_nonce: bool = True,
) -> tuple[bool, str, str | None]:
    """
    Verify EIP-191 SIWE fetch auth headers.
    Returns (ok, error_or_ok_reason, recovered_checksum_address).
    When consume_nonce=False, checks replay status without inserting into NonceStore so
    callers can authorize on-chain BEFORE consuming the nonce (preventing eviction DoS).
    """
    try:
        validate_cid(cid)
    except ValueError as err:
        return False, str(err), None

    if isinstance(data_id, str) and len(data_id.strip()) > MAX_DATA_ID_DIGITS:
        return False, "Invalid dataId (exceeds uint256 range).", None
    try:
        parsed_data_id = int(data_id)
    except (TypeError, ValueError):
        return False, "Invalid dataId (must be positive integer).", None
    if parsed_data_id <= 0 or parsed_data_id > MAX_UINT256:
        return False, "Invalid dataId (must be positive uint256).", None

    if not claimed_address or not Web3.is_address(claimed_address):
        return False, "Invalid or missing X-GenoChain-Address.", None

    if not nonce or not NONCE_RE.match(str(nonce)):
        return False, "Invalid X-GenoChain-Nonce (must be 16-128 safe chars).", None

    now = int(time.time() if now_ts is None else now_ts)
    if isinstance(timestamp, str) and len(timestamp.strip()) > MAX_TS_DIGITS:
        return False, "Invalid X-GenoChain-Timestamp (out of range).", None
    try:
        ts = int(timestamp)
    except (TypeError, ValueError):
        return False, "Invalid X-GenoChain-Timestamp (must be integer UNIX seconds).", None
    if abs(now - ts) > int(max_skew_sec):
        return False, f"Timestamp outside allowed +/-{max_skew_sec}s window (skew={abs(now - ts)}s).", None

    if not signature or not isinstance(signature, str):
        return False, "Missing X-GenoChain-Signature.", None

    canonical_msg = build_siwe_auth_message(
        chain_id=chain_id,
        registry_address=registry_address,
        data_id=parsed_data_id,
        cid=cid,
        address=claimed_address,
        timestamp=ts,
        nonce=nonce,
    )
    try:
        recovered = Account.recover_message(encode_defunct(text=canonical_msg), signature=signature)
    except Exception as exc:
        return False, f"Invalid EIP-191 signature: {exc}", None

    if recovered.lower() != claimed_address.lower():
        return False, "Recovered signer does not match X-GenoChain-Address.", None

    if consume_nonce:
        status_c = nonce_store.consume_checked(recovered, nonce, now_ts=now, namespace="download")
        if status_c != "ok":
            err_msg = (
                "Download nonce bucket saturated; retry shortly."
                if status_c == "saturated"
                else "Nonce already used (replay rejected)."
            )
            return False, err_msg, None
    elif nonce_store.is_used(recovered, nonce, now_ts=now, namespace="download"):
        return False, "Nonce already used (replay rejected).", None

    return True, "ok", Web3.to_checksum_address(recovered)


def verify_siwe_upload_request(
    *,
    chain_id: int,
    registry_address: str,
    content_sha256: str,
    claimed_address: str,
    timestamp: int,
    nonce: str,
    signature: str,
    nonce_store: NonceStore,
    now_ts: int | None = None,
    max_skew_sec: int = MAX_AUTH_SKEW_SEC,
    consume_nonce: bool = False,
) -> tuple[bool, str, str | None, str | None]:
    """
    Verify EIP-191 SIWE upload auth headers bound to contentSha256.
    Returns (ok, reason, recovered_checksum_address, normalized_sha256_hex).
    """
    clean_sha = str(content_sha256 or "").strip().lower()
    if clean_sha.startswith("0x"):
        clean_sha = clean_sha[2:]
    if not SHA256_HEX_RE.match(clean_sha):
        return False, "Invalid or missing X-GenoChain-Content-Sha256 (expected 64 hex chars).", None, None

    if not claimed_address or not Web3.is_address(claimed_address):
        return False, "Invalid or missing X-GenoChain-Address.", None, None

    if not nonce or not NONCE_RE.match(str(nonce)):
        return False, "Invalid X-GenoChain-Nonce (must be 16-128 safe chars).", None, None

    now = int(time.time() if now_ts is None else now_ts)
    if isinstance(timestamp, str) and len(timestamp.strip()) > MAX_TS_DIGITS:
        return False, "Invalid X-GenoChain-Timestamp (out of range).", None, None
    try:
        ts = int(timestamp)
    except (TypeError, ValueError):
        return False, "Invalid X-GenoChain-Timestamp (must be integer UNIX seconds).", None, None
    if abs(now - ts) > int(max_skew_sec):
        return False, f"Timestamp outside allowed +/-{max_skew_sec}s window (skew={abs(now - ts)}s).", None, None

    if not signature or not isinstance(signature, str):
        return False, "Missing X-GenoChain-Signature.", None, None

    canonical_msg = build_siwe_upload_message(
        chain_id=chain_id,
        registry_address=registry_address,
        content_sha256=clean_sha,
        address=claimed_address,
        timestamp=ts,
        nonce=nonce,
    )
    try:
        recovered = Account.recover_message(encode_defunct(text=canonical_msg), signature=signature)
    except Exception as exc:
        return False, f"Invalid EIP-191 upload signature: {exc}", None, None

    if recovered.lower() != claimed_address.lower():
        return False, "Recovered signer does not match X-GenoChain-Address.", None, None

    if consume_nonce:
        status_c = nonce_store.consume_checked(recovered, nonce, now_ts=now, namespace="upload")
        if status_c != "ok":
            err_msg = "Upload nonce bucket saturated; retry shortly." if status_c == "saturated" else "Nonce already used (replay rejected)."
            return False, err_msg, None, None
    elif nonce_store.is_used(recovered, nonce, now_ts=now, namespace="upload"):
        return False, "Nonce already used (replay rejected).", None, None

    return True, "ok", Web3.to_checksum_address(recovered), clean_sha


def _unpack_genomic_data_tuple(raw) -> dict:
    """Unpack 12-field GenomicsRegistryStorage.GenomicData tuple with 0x-prefixed rawDataHash."""
    # [0]=dataId, [1]=tokenId, [2]=currentOwner, [3]=rawDataHash,
    # [4]=rawCiphertextCid, [5]=summaryCiphertextCid, [6]=metadataCid,
    # [7]=price, [8]=accessDuration, [9]=status, [10]=accessCount, [11]=registeredAt
    raw_hash = Web3.to_hex(raw[3]) if isinstance(raw[3], (bytes, bytearray)) else str(raw[3])
    return {
        "dataId": int(raw[0]),
        "tokenId": int(raw[1]),
        "currentOwner": str(raw[2]),
        "rawDataHash": raw_hash,
        "rawCid": str(raw[4]),
        "summaryCid": str(raw[5]),
        "metadataCid": str(raw[6]),
        "status": int(raw[9]),
    }


class Web3RegistryAdapter:
    """Production on-chain adapter querying GenomicsRegistry via Web3.py."""

    def __init__(self, w3: Web3, registry_address: str, registry_abi: list):
        self.w3 = w3
        self.registry_address = Web3.to_checksum_address(registry_address)
        self.registry = w3.eth.contract(address=self.registry_address, abi=registry_abi)
        self._abi = registry_abi
        self._cached_payment_token: str | None = None
        self._cached_genomic_nft: str | None = None
        self._artifact_hash_cache: dict[int, tuple[str, str]] = {}

    def is_connected(self) -> bool:
        try:
            return bool(self.w3.is_connected())
        except Exception:
            return False

    def get_block_number(self) -> int:
        return int(self.w3.eth.block_number)

    def get_artifact_hashes(self, data_id: int) -> tuple[str, str, str] | None:
        """Query on-chain getArtifactHashes(dataId) -> normalized (rawDataHash, summaryHash, metadataHash)."""
        d_id = int(data_id)
        if d_id <= 0 or not hasattr(self.registry.functions, "getArtifactHashes"):
            return None
        raw_h, sum_h, meta_h = self.registry.functions.getArtifactHashes(d_id).call()
        return (
            _normalize_sha256_hex(raw_h),
            _normalize_sha256_hex(sum_h),
            _normalize_sha256_hex(meta_h),
        )

    def _attach_artifact_hashes(self, item: dict) -> dict:
        d_id = int(item.get("dataId", 0))
        if d_id <= 0 or not hasattr(self.registry.functions, "getArtifactHashes"):
            return item
        cached = self._artifact_hash_cache.get(d_id)
        if cached is not None:
            item["summaryHash"] = cached[0]
            item["metadataHash"] = cached[1]
            return item
        hashes = self.get_artifact_hashes(d_id)
        if hashes is not None:
            _, sum_h, meta_h = hashes
            item["summaryHash"] = sum_h
            item["metadataHash"] = meta_h
            if sum_h and meta_h:
                self._artifact_hash_cache[d_id] = (sum_h, meta_h)
        return item

    def get_genomic_data(self, data_id: int) -> dict:
        raw = self.registry.functions.getGenomicData(int(data_id)).call()
        return self._attach_artifact_hashes(_unpack_genomic_data_tuple(raw))

    def get_all_datasets(self, page_size: int = 100) -> list[dict]:
        """Paginate all on-chain GenomicData structs (getDataItemsPaginated-first, getAllDataItems fallback)."""
        items: list[dict] = []
        if hasattr(self.registry.functions, "getDataItemsPaginated"):
            safe_page = max(1, int(page_size))
            offset = 0
            total = None
            while total is None or offset < total:
                page_items, total_raw = self.registry.functions.getDataItemsPaginated(offset, safe_page).call()
                total = int(total_raw)
                if not page_items:
                    break
                for raw in page_items:
                    items.append(self._attach_artifact_hashes(_unpack_genomic_data_tuple(raw)))
                offset += len(page_items)
            return items
        if hasattr(self.registry.functions, "getAllDataItems"):
            for raw in self.registry.functions.getAllDataItems().call():
                items.append(self._attach_artifact_hashes(_unpack_genomic_data_tuple(raw)))
        return items

    def has_active_access(self, data_id: int, buyer: str) -> bool:
        return bool(self.registry.functions.hasActiveAccess(int(data_id), Web3.to_checksum_address(buyer)).call())

    def get_original_creator(self, token_id: int) -> str | None:
        """Query immutable GenomicNFT.originalCreatorOf(tokenId) to support provenance across NFT transfers."""
        if int(token_id) <= 0 or not hasattr(self.registry.functions, "genomicNFT"):
            return None
        try:
            nft_addr = self._cached_genomic_nft
            if not nft_addr:
                nft_addr = self.registry.functions.genomicNFT().call()
                if nft_addr and int(nft_addr, 16) != 0:
                    self._cached_genomic_nft = Web3.to_checksum_address(nft_addr)
                    nft_addr = self._cached_genomic_nft
            if nft_addr and int(nft_addr, 16) != 0:
                nft = self.w3.eth.contract(
                    address=Web3.to_checksum_address(nft_addr),
                    abi=[
                        {
                            "inputs": [{"name": "tokenId", "type": "uint256"}],
                            "name": "originalCreatorOf",
                            "outputs": [{"name": "creator", "type": "address"}],
                            "stateMutability": "view",
                            "type": "function",
                        }
                    ],
                )
                creator = str(nft.functions.originalCreatorOf(int(token_id)).call() or "").strip()
                if creator and int(creator, 16) != 0:
                    return creator.lower()
        except Exception:
            pass
        return None

    def check_uploader_eligibility(
        self,
        address: str,
        *,
        min_wei: int = DEFAULT_MIN_UPLOAD_WEI,
        min_geno: int = DEFAULT_MIN_UPLOAD_GENO,
    ) -> tuple[bool, str]:
        """
        Check on-chain anti-Sybil upload eligibility for `address`:
        eligible if signer holds >= min_wei native gas balance, >= min_geno $GENO balance,
        owns >= 1 GenomicNFT, OR is an approved sequencing lab attestor on GenomicZkVerifier.
        """
        cs_addr = Web3.to_checksum_address(address)
        if int(min_wei) > 0:
            try:
                if int(self.w3.eth.get_balance(cs_addr)) >= int(min_wei):
                    return True, "native_balance"
            except Exception:
                pass
        if int(min_geno) > 0 and hasattr(self.registry.functions, "paymentToken"):
            try:
                tok_addr = self._cached_payment_token
                if not tok_addr:
                    tok_addr = self.registry.functions.paymentToken().call()
                    if tok_addr and int(tok_addr, 16) != 0:
                        self._cached_payment_token = Web3.to_checksum_address(tok_addr)
                        tok_addr = self._cached_payment_token
                if tok_addr and int(tok_addr, 16) != 0:
                    tok = self.w3.eth.contract(
                        address=Web3.to_checksum_address(tok_addr),
                        abi=[{"inputs": [{"name": "a", "type": "address"}], "name": "balanceOf", "outputs": [{"name": "", "type": "uint256"}], "stateMutability": "view", "type": "function"}],
                    )
                    if int(tok.functions.balanceOf(cs_addr).call()) >= int(min_geno):
                        return True, "geno_balance"
            except Exception:
                pass
        if hasattr(self.registry.functions, "genomicNFT"):
            try:
                nft_addr = self._cached_genomic_nft
                if not nft_addr:
                    nft_addr = self.registry.functions.genomicNFT().call()
                    if nft_addr and int(nft_addr, 16) != 0:
                        self._cached_genomic_nft = Web3.to_checksum_address(nft_addr)
                        nft_addr = self._cached_genomic_nft
                if nft_addr and int(nft_addr, 16) != 0:
                    nft = self.w3.eth.contract(
                        address=Web3.to_checksum_address(nft_addr),
                        abi=[{"inputs": [{"name": "a", "type": "address"}], "name": "balanceOf", "outputs": [{"name": "", "type": "uint256"}], "stateMutability": "view", "type": "function"}],
                    )
                    if int(nft.functions.balanceOf(cs_addr).call()) > 0:
                        return True, "nft_owner"
            except Exception:
                pass
        if hasattr(self.registry.functions, "zkVerifier"):
            try:
                zk_addr = self.registry.functions.zkVerifier().call()
                if zk_addr and int(zk_addr, 16) != 0:
                    zk = self.w3.eth.contract(
                        address=Web3.to_checksum_address(zk_addr),
                        abi=[{"inputs": [{"name": "a", "type": "address"}], "name": "approvedLabAttestors", "outputs": [{"name": "", "type": "bool"}], "stateMutability": "view", "type": "function"}],
                    )
                    if bool(zk.functions.approvedLabAttestors(cs_addr).call()):
                        return True, "approved_lab_attestor"
            except Exception:
                pass
        return False, "Signer does not satisfy on-chain upload eligibility (existing dataset/NFT owner, approved lab attestor, allowlist, or minimum ETH/$GENO balance)."

    def _fetch_status_logs_window(self, start_blk: int, end_blk: int) -> list:
        try:
            return list(self.registry.events.DataStatusUpdated().get_logs(from_block=start_blk, to_block=end_blk))
        except Exception as err:
            if is_block_range_limit_error(err) and end_blk > start_blk:
                mid = (start_blk + end_blk) // 2
                return self._fetch_status_logs_window(start_blk, mid) + self._fetch_status_logs_window(mid + 1, end_blk)
            raise

    def get_status_updated_events(self, from_block: int, to_block: int) -> list[dict]:
        if from_block > to_block or not hasattr(self.registry.events, "DataStatusUpdated"):
            return []
        events = []
        cur = int(from_block)
        while cur <= int(to_block):
            end = min(cur + DEFAULT_LOG_CHUNK_SIZE - 1, int(to_block))
            logs = self._fetch_status_logs_window(cur, end)
            for ev in logs:
                events.append(
                    {
                        "dataId": int(ev.args.dataId),
                        "newStatus": int(ev.args.newStatus),
                        "blockNumber": int(ev.blockNumber),
                    }
                )
            cur = end + 1
        return events


class PublicMetadataCatalogIndex:
    """
    Thread-safe lock-free-RPC catalog index keyed by canonical multihash digest (NOT raw CID string).
    Security & DoS guarantees:
    1. Permanent Private-Dominance Rule: ANY canonical multihash registered as rawCid or summaryCid on
       ANY dataset (Active, Paused, OR Revoked) is permanently excluded from public metadataCid access,
       blocking CIDv0 <-> CIDv1 / codec-aliasing SIWE bypasses.
    2. First-Claimant Ownership Map: tracks (earliest_data_id, owner_lower) sorted by ascending dataId
       so later cross-owner dummy datasets reusing a victim's multihash cannot spoof ownership.
    3. Global Forced-Refresh Cooldown + Single-Flight Lock-Free RPC Scan: RPC get_all_datasets() runs
       strictly OUTSIDE self._lock with single-flight Event coalescing and a global minimum cooldown
       across ALL unseen CIDs (blocking random-CID RPC amplification & lock starvation).
    """

    def __init__(
        self,
        registry_adapter,
        refresh_ttl_sec: float = 10.0,
        min_forced_refresh_sec: float = 2.0,
        provenance_lookup=None,
        provenance_backfill=None,
        sha_provenance_lookup=None,
    ):
        self._registry = registry_adapter
        self._refresh_ttl = max(1.0, float(refresh_ttl_sec))
        self._min_forced_refresh = max(0.25, float(min_forced_refresh_sec))
        self._provenance_lookup = provenance_lookup
        self._provenance_backfill = provenance_backfill
        self._sha_provenance_lookup = sha_provenance_lookup
        self._lock = threading.Lock()
        self._public_metadata_mhs: set[str] = set()
        self._private_mhs: set[str] = set()
        self._first_registrant_by_mh: dict[str, tuple[int, str]] = {}
        self._first_registrant_details_by_mh: dict[str, tuple[int, str, str]] = {}
        self._first_registrant_details_by_sha: dict[str, tuple[int, str, str, int]] = {}
        self._datasets_by_sha: dict[str, list[dict]] = {}
        self._revoked_shas: set[str] = set()
        self._known_owners: set[str] = set()
        self._last_refresh_mono: float = 0.0
        self._last_forced_refresh_mono: float = 0.0
        self._last_failed_refresh_mono: float = 0.0
        self._last_refresh_ok: bool = False
        self._refresh_in_progress: bool = False
        self._refresh_event: threading.Event = threading.Event()
        self._refresh_event.set()
        self.rpc_refresh_count: int = 0

    def _run_refresh_if_needed(
        self,
        *,
        force_unseen: bool = False,
        force_authoritative: bool = False,
        bypass_failure_backoff: bool = False,
    ) -> None:
        getter = getattr(self._registry, "get_all_datasets", None)
        if not callable(getter):
            with self._lock:
                self._public_metadata_mhs = set()
                self._private_mhs = set()
                self._first_registrant_by_mh = {}
                self._first_registrant_details_by_mh = {}
                self._first_registrant_details_by_sha = {}
                self._datasets_by_sha = {}
                self._revoked_shas = set()
                self._known_owners = set()
                self._last_refresh_mono = time.monotonic()
                self._last_refresh_ok = True
            return

        while True:
            now_mono = time.monotonic()
            with self._lock:
                in_failure_backoff = (
                    not bypass_failure_backoff
                    and self._last_failed_refresh_mono > 0.0
                    and (now_mono - self._last_failed_refresh_mono) < self._min_forced_refresh
                )
                if in_failure_backoff:
                    return
                stale = self._last_refresh_mono == 0.0 or (now_mono - self._last_refresh_mono) >= self._refresh_ttl
                can_force = force_authoritative or (
                    force_unseen
                    and (
                        self._last_forced_refresh_mono == 0.0
                        or (now_mono - self._last_forced_refresh_mono) >= self._min_forced_refresh
                    )
                )
                if not stale and not can_force:
                    return
                if self._refresh_in_progress:
                    wait_ev = self._refresh_event
                else:
                    self._refresh_in_progress = True
                    wait_ev = threading.Event()
                    self._refresh_event = wait_ev
                    if not stale and force_unseen and not force_authoritative:
                        self._last_forced_refresh_mono = now_mono
                    break
            # Coalesce onto the single in-flight RPC refresh OUTSIDE self._lock
            wait_ev.wait(timeout=15.0)
            return

        # Execute RPC scan & provenance checks strictly OUTSIDE self._lock so cached readers & workers are never blocked
        computed_snapshot = None
        rpc_ok = False
        try:
            datasets = getter() or []
            sorted_ds = sorted(
                [ds for ds in datasets if isinstance(ds, dict)],
                key=lambda d: int(d.get("dataId", 0)),
            )
            private_mhs: set[str] = set()
            active_meta_mhs: set[str] = set()
            first_reg: dict[str, tuple[int, str]] = {}
            first_reg_details: dict[str, tuple[int, str, str]] = {}
            first_reg_details_by_sha: dict[str, tuple[int, str, str, int]] = {}
            datasets_by_sha: dict[str, list[dict]] = {}
            revoked_shas: set[str] = set()
            known_owners: set[str] = set()
            backfill_pairs: list[tuple[str, str, str]] = []
            prov_cache: dict[str, str | None] = {}
            sha_prov_cache: dict[str, str | None] = {}
            orig_creator_cache: dict[int, str] = {}
            artifact_hash_getter = getattr(self._registry, "get_artifact_hashes", None)

            def _lookup_prov(mh: str) -> str | None:
                if mh in prov_cache:
                    return prov_cache[mh]
                val: str | None = None
                if callable(self._provenance_lookup):
                    try:
                        raw_p = self._provenance_lookup(mh)
                        if raw_p:
                            val = str(raw_p).strip().lower()
                    except Exception:
                        val = None
                prov_cache[mh] = val
                return val

            def _lookup_sha_prov(sha_hex: str) -> str | None:
                if sha_hex in sha_prov_cache:
                    return sha_prov_cache[sha_hex]
                val: str | None = None
                if callable(self._sha_provenance_lookup):
                    try:
                        raw_p = self._sha_provenance_lookup(sha_hex)
                        if raw_p:
                            val = str(raw_p).strip().lower()
                    except Exception:
                        val = None
                sha_prov_cache[sha_hex] = val
                return val

            def _get_orig_creator(ds_obj: dict, ds_id: int) -> str:
                if ds_id in orig_creator_cache:
                    return orig_creator_cache[ds_id]
                resolved = _resolve_item_original_creator(self._registry, ds_obj)
                orig_creator_cache[ds_id] = resolved
                return resolved

            def _is_ds_authorized_for_mh(ds_obj: dict, ds_id: int, owner_lower: str, mh: str) -> bool:
                prov_l = _lookup_prov(mh)
                if prov_l:
                    if owner_lower == prov_l:
                        return True
                    orig_c = _get_orig_creator(ds_obj, ds_id)
                    return bool(orig_c) and orig_c == prov_l
                existing = first_reg_details.get(mh)
                if existing is not None:
                    _, earliest_owner, earliest_creator = existing
                    allowed_owners = {a for a in (earliest_owner, earliest_creator) if a}
                    if allowed_owners:
                        if owner_lower in allowed_owners:
                            return True
                        orig_c = _get_orig_creator(ds_obj, ds_id)
                        return bool(orig_c) and orig_c in allowed_owners
                return True

            for ds in sorted_ds:
                d_id = int(ds.get("dataId", 0))
                status = int(ds.get("status", -1))
                owner_l = str(ds.get("currentOwner") or "").strip().lower()
                if owner_l:
                    known_owners.add(owner_l)
                raw_mh = _try_canonical_multihash(ds.get("rawCid"))
                sum_mh = _try_canonical_multihash(ds.get("summaryCid"))
                meta_mh = _try_canonical_multihash(ds.get("metadataCid"))

                raw_sha = _normalize_sha256_hex(ds.get("rawDataHash"))
                sum_sha = _normalize_sha256_hex(ds.get("summaryHash") or ds.get("summaryDataHash"))
                meta_sha = _normalize_sha256_hex(ds.get("metadataHash"))
                if (
                    d_id > 0
                    and "summaryHash" not in ds
                    and "summaryDataHash" not in ds
                    and callable(artifact_hash_getter)
                ):
                    ah_res = artifact_hash_getter(d_id)
                    if ah_res and len(ah_res) >= 3:
                        raw_sha = raw_sha or _normalize_sha256_hex(ah_res[0])
                        sum_sha = sum_sha or _normalize_sha256_hex(ah_res[1])
                        meta_sha = meta_sha or _normalize_sha256_hex(ah_res[2])

                # REV-02 defense: only provenance/first-registrant-authorized datasets can classify
                # rawCid/summaryCid into private_mhs or claim first_reg (blocks cross-owner metadata censorship).
                for priv_mh, priv_sha in ((raw_mh, raw_sha), (sum_mh, sum_sha)):
                    if not priv_mh:
                        continue
                    if not _is_ds_authorized_for_mh(ds, d_id, owner_l, priv_mh):
                        continue
                    private_mhs.add(priv_mh)
                    if priv_mh not in first_reg_details:
                        orig_c = _get_orig_creator(ds, d_id)
                        first_reg_details[priv_mh] = (d_id, owner_l, orig_c)
                        first_reg[priv_mh] = (d_id, owner_l)
                        if status != 2:
                            canon_p = orig_c or owner_l
                            if canon_p and (_lookup_prov(priv_mh) is None or priv_sha):
                                backfill_pairs.append((priv_mh, canon_p, priv_sha))

                if meta_mh and _is_ds_authorized_for_mh(ds, d_id, owner_l, meta_mh):
                    if meta_mh not in first_reg_details:
                        orig_c = _get_orig_creator(ds, d_id)
                        first_reg_details[meta_mh] = (d_id, owner_l, orig_c)
                        first_reg[meta_mh] = (d_id, owner_l)
                        if status != 2:
                            canon_p = orig_c or owner_l
                            if canon_p and (_lookup_prov(meta_mh) is None or meta_sha):
                                backfill_pairs.append((meta_mh, canon_p, meta_sha))
                    if status == 0:
                        active_meta_mhs.add(meta_mh)

                # Cross-codec SHA-256 content-hash provenance & GDPR revocation index
                for field_kind, sha_val, field_cid in (
                    ("raw", raw_sha, ds.get("rawCid")),
                    ("summary", sum_sha, ds.get("summaryCid")),
                    ("metadata", meta_sha, ds.get("metadataCid")),
                ):
                    if not sha_val:
                        continue
                    orig_c = _get_orig_creator(ds, d_id)
                    datasets_by_sha.setdefault(sha_val, []).append(
                        {
                            "dataId": d_id,
                            "owner": owner_l,
                            "originalCreator": orig_c,
                            "status": status,
                            "cid": str(field_cid or "").strip(),
                            "kind": field_kind,
                        }
                    )
                    if sha_val not in first_reg_details_by_sha:
                        sha_prov_l = _lookup_sha_prov(sha_val)
                        if not sha_prov_l or owner_l == sha_prov_l or (bool(orig_c) and orig_c == sha_prov_l):
                            first_reg_details_by_sha[sha_val] = (d_id, owner_l, orig_c, status)

            for sha_val, ds_entries in datasets_by_sha.items():
                first_s = first_reg_details_by_sha.get(sha_val)
                auth_owners = (
                    {a for a in (first_s[1], first_s[2]) if a}
                    if first_s is not None
                    else set()
                )
                has_revoked_auth = False
                has_active_auth = False
                for ent in ds_entries:
                    ent_owners = {a for a in (ent["owner"], ent["originalCreator"]) if a}
                    is_auth = (not auth_owners) or bool(ent_owners & auth_owners)
                    if not is_auth:
                        continue
                    if ent["status"] == 2:
                        has_revoked_auth = True
                    else:
                        has_active_auth = True
                if has_revoked_auth and not has_active_auth:
                    revoked_shas.add(sha_val)

            # REV-01 defense: backfill missing upload_provenance rows for already-anchored active/paused
            # datasets so upgraded / replica / fresh SQLite gateways immediately reject post-anchor hijacks.
            if backfill_pairs and callable(self._provenance_backfill):
                try:
                    self._provenance_backfill(backfill_pairs)
                except Exception:
                    pass

            computed_snapshot = (
                private_mhs,
                active_meta_mhs - private_mhs,
                first_reg,
                first_reg_details,
                first_reg_details_by_sha,
                datasets_by_sha,
                revoked_shas,
                known_owners,
            )
            rpc_ok = True
        except Exception:
            rpc_ok = False
        finally:
            finish_mono = time.monotonic()
            with self._lock:
                self.rpc_refresh_count += 1
                self._last_refresh_ok = rpc_ok
                if rpc_ok and computed_snapshot is not None:
                    (
                        self._private_mhs,
                        self._public_metadata_mhs,
                        self._first_registrant_by_mh,
                        self._first_registrant_details_by_mh,
                        self._first_registrant_details_by_sha,
                        self._datasets_by_sha,
                        self._revoked_shas,
                        self._known_owners,
                    ) = computed_snapshot
                    self._last_refresh_mono = finish_mono
                    self._last_failed_refresh_mono = 0.0
                else:
                    self._last_failed_refresh_mono = finish_mono
                    # Fail closed on prolonged RPC outage so revoked datasets cannot stay cached indefinitely
                    if self._last_refresh_mono > 0.0 and (finish_mono - self._last_refresh_mono) >= 3.0 * self._refresh_ttl:
                        self._public_metadata_mhs = set()
                self._refresh_in_progress = False
                wait_ev.set()

    def is_public_active_metadata_cid(self, cid: str) -> bool:
        mh = _try_canonical_multihash(cid)
        if not mh:
            return False
        # Non-blocking fast path for already-known CIDs while a routine TTL refresh is in flight
        now_mono = time.monotonic()
        with self._lock:
            if (
                self._refresh_in_progress
                and self._last_refresh_mono > 0.0
                and (now_mono - self._last_refresh_mono) < 3.0 * self._refresh_ttl
            ):
                if mh in self._private_mhs:
                    return False
                if mh in self._public_metadata_mhs:
                    return True
        self._run_refresh_if_needed(force_unseen=False)
        with self._lock:
            if mh in self._private_mhs:
                return False
            if mh in self._public_metadata_mhs:
                return True
        # Unseen multihash: subject to strict global forced-refresh cooldown (max 1 RPC per min_forced_refresh_sec)
        self._run_refresh_if_needed(force_unseen=True)
        with self._lock:
            return mh in self._public_metadata_mhs and mh not in self._private_mhs

    def get_first_registrant(
        self,
        multihash: str,
        *,
        allow_authoritative_refresh: bool = False,
    ) -> tuple[int, str] | None:
        if not multihash:
            return None
        with self._lock:
            prev_count = self.rpc_refresh_count
        self._run_refresh_if_needed(force_unseen=False)
        with self._lock:
            entry = self._first_registrant_by_mh.get(multihash)
            just_attempted_refresh = self.rpc_refresh_count > prev_count
            in_recent_failure = (
                not self._last_refresh_ok
                and self._last_failed_refresh_mono > 0.0
                and (time.monotonic() - self._last_failed_refresh_mono) < self._min_forced_refresh
            )
        if entry is None and not just_attempted_refresh and not in_recent_failure:
            if allow_authoritative_refresh:
                self._run_refresh_if_needed(force_authoritative=True)
            else:
                self._run_refresh_if_needed(force_unseen=True)
            with self._lock:
                entry = self._first_registrant_by_mh.get(multihash)
        return entry

    def get_first_registrant_info(
        self,
        multihash: str,
        *,
        allow_authoritative_refresh: bool = False,
    ) -> tuple[int, str, str] | None:
        if not multihash:
            return None
        with self._lock:
            prev_count = self.rpc_refresh_count
        self._run_refresh_if_needed(force_unseen=False)
        with self._lock:
            entry = (
                self._first_registrant_details_by_mh.get(multihash)
                if multihash in self._first_registrant_by_mh
                else None
            )
            just_attempted_refresh = self.rpc_refresh_count > prev_count
            in_recent_failure = (
                not self._last_refresh_ok
                and self._last_failed_refresh_mono > 0.0
                and (time.monotonic() - self._last_failed_refresh_mono) < self._min_forced_refresh
            )
        if entry is None and not just_attempted_refresh and not in_recent_failure:
            if allow_authoritative_refresh:
                self._run_refresh_if_needed(force_authoritative=True)
            else:
                self._run_refresh_if_needed(force_unseen=True)
            with self._lock:
                entry = (
                    self._first_registrant_details_by_mh.get(multihash)
                    if multihash in self._first_registrant_by_mh
                    else None
                )
        return entry

    def get_first_registrant_by_sha(
        self,
        sha256_hex: str,
        *,
        allow_authoritative_refresh: bool = False,
    ) -> tuple[int, str, str, int] | None:
        sha_key = _normalize_sha256_hex(sha256_hex)
        if not sha_key:
            return None
        with self._lock:
            prev_count = self.rpc_refresh_count
        self._run_refresh_if_needed(force_unseen=False)
        with self._lock:
            entry = self._first_registrant_details_by_sha.get(sha_key)
            just_attempted_refresh = self.rpc_refresh_count > prev_count
            in_recent_failure = (
                not self._last_refresh_ok
                and self._last_failed_refresh_mono > 0.0
                and (time.monotonic() - self._last_failed_refresh_mono) < self._min_forced_refresh
            )
        if entry is None and not just_attempted_refresh and not in_recent_failure:
            if allow_authoritative_refresh:
                self._run_refresh_if_needed(force_authoritative=True)
            else:
                self._run_refresh_if_needed(force_unseen=True)
            with self._lock:
                entry = self._first_registrant_details_by_sha.get(sha_key)
        return entry

    def get_upload_provenance_info(
        self,
        multihash: str | None,
        sha256_hex: str | None,
        *,
        allow_authoritative_refresh: bool = False,
    ) -> tuple[tuple[int, str, str] | None, tuple[int, str, str, int] | None, bool]:
        """Single-RPC atomic catalog lookup returning (first_info_by_mh, first_info_by_sha, is_sha_revoked)."""
        mh_key = str(multihash or "").strip()
        sha_key = _normalize_sha256_hex(sha256_hex)
        with self._lock:
            prev_count = self.rpc_refresh_count
        self._run_refresh_if_needed(force_unseen=False)
        with self._lock:
            mh_entry = self._first_registrant_details_by_mh.get(mh_key) if mh_key else None
            sha_entry = self._first_registrant_details_by_sha.get(sha_key) if sha_key else None
            sha_revoked = bool(sha_key and sha_key in self._revoked_shas)
            just_attempted_refresh = self.rpc_refresh_count > prev_count
            in_recent_failure = (
                not self._last_refresh_ok
                and self._last_failed_refresh_mono > 0.0
                and (time.monotonic() - self._last_failed_refresh_mono) < self._min_forced_refresh
            )
        need_force = (
            (bool(mh_key) and mh_entry is None)
            or (bool(sha_key) and sha_entry is None and not sha_revoked)
        )
        if need_force and not just_attempted_refresh and not in_recent_failure:
            if allow_authoritative_refresh:
                self._run_refresh_if_needed(force_authoritative=True)
            else:
                self._run_refresh_if_needed(force_unseen=True)
            with self._lock:
                mh_entry = self._first_registrant_details_by_mh.get(mh_key) if mh_key else None
                sha_entry = self._first_registrant_details_by_sha.get(sha_key) if sha_key else None
                sha_revoked = bool(sha_key and sha_key in self._revoked_shas)
        return mh_entry, sha_entry, sha_revoked

    def is_revoked_sha(self, sha256_hex: str) -> bool:
        sha_key = _normalize_sha256_hex(sha256_hex)
        if not sha_key:
            return False
        with self._lock:
            return sha_key in self._revoked_shas

    def get_datasets_by_sha(self, sha256_hex: str) -> list[dict]:
        sha_key = _normalize_sha256_hex(sha256_hex)
        if not sha_key:
            return []
        with self._lock:
            return list(self._datasets_by_sha.get(sha_key, []))

    def last_refresh_succeeded(self) -> bool:
        with self._lock:
            return bool(self._last_refresh_ok)

    def refresh_now(self) -> bool:
        self._run_refresh_if_needed(force_authoritative=True, bypass_failure_backoff=True)
        return self.last_refresh_succeeded()

    def is_known_dataset_owner(self, address: str) -> bool:
        addr_l = str(address or "").strip().lower()
        if not addr_l:
            return False
        self._run_refresh_if_needed(force_unseen=False)
        with self._lock:
            if addr_l in self._known_owners:
                return True
        self._run_refresh_if_needed(force_unseen=True)
        with self._lock:
            return addr_l in self._known_owners

    def invalidate(self) -> None:
        with self._lock:
            self._last_refresh_mono = 0.0
            self._last_forced_refresh_mono = 0.0
            self._last_failed_refresh_mono = 0.0


class KuboHttpAdapter:
    """Private internal Kubo RPC adapter with true 64 KiB streaming read & upload (zero full-RAM buffer)."""

    def __init__(
        self,
        rpc_url: str = "http://127.0.0.1:5001",
        timeout_sec: float = 30.0,
        gc_timeout_sec: float = 180.0,
        offline: bool = True,
    ):
        self.rpc_url = rpc_url.rstrip("/")
        self.timeout_sec = float(timeout_sec)
        self.gc_timeout_sec = max(float(timeout_sec), float(gc_timeout_sec))
        self.offline = bool(offline)

    def _open_post(self, path_and_query: str, *, timeout_sec: float | None = None):
        req = urllib.request.Request(f"{self.rpc_url}{path_and_query}", data=b"", method="POST")
        eff_timeout = self.timeout_sec if timeout_sec is None else float(timeout_sec)
        return urllib.request.urlopen(req, timeout=eff_timeout)

    def _post(
        self,
        path_and_query: str,
        *,
        timeout_sec: float | None = None,
        discard_body: bool = False,
    ) -> bytes:
        with self._open_post(path_and_query, timeout_sec=timeout_sec) as resp:
            if discard_body:
                while resp.read(STREAM_CHUNK_BYTES):
                    pass
                return b""
            chunks = []
            total = 0
            while True:
                chunk = resp.read(STREAM_CHUNK_BYTES)
                if not chunk:
                    break
                total += len(chunk)
                if total > MAX_STREAM_BYTES:
                    raise ValueError(f"IPFS object exceeds maximum allowed stream size ({MAX_STREAM_BYTES} bytes).")
                chunks.append(chunk)
            return b"".join(chunks)

    @staticmethod
    def _read_http_error(err: urllib.error.HTTPError) -> str:
        try:
            return err.read().decode("utf-8", errors="ignore").lower()
        finally:
            try:
                err.close()
            except Exception:
                pass

    def health_check(self) -> bool:
        try:
            self._post("/api/v0/version", timeout_sec=min(self.timeout_sec, 5.0))
            return True
        except Exception:
            return False

    def open_cid_stream(self, cid: str):
        """
        Open a live HTTP response stream to private Kubo for `cid` (/api/v0/cat?offline=true,
        falling back to /api/v0/block/get?offline=true for non-UnixFS codecs like DAG-CBOR).
        Caller is responsible for closing the returned response object.
        """
        clean = validate_cid(cid)
        params = {"arg": clean}
        if self.offline:
            params["offline"] = "true"
        q = urllib.parse.urlencode(params)
        try:
            return self._open_post(f"/api/v0/cat?{q}")
        except urllib.error.HTTPError as err:
            body = self._read_http_error(err)
            if err.code == 404 or "not found" in body or "could not find" in body:
                raise FileNotFoundError(f"CID {clean} is not present in local private Kubo blockstore.") from err
            if (
                "unknown node type" in body
                or "unrecognized node type" in body
                or "expected protobuf" in body
                or "proto:" in body
                or "not a file" in body
                or "dag node is a directory" in body
                or "operation not supported" in body
            ):
                try:
                    return self._open_post(f"/api/v0/block/get?{q}")
                except urllib.error.HTTPError as blk_err:
                    blk_body = self._read_http_error(blk_err)
                    if blk_err.code == 404 or "not found" in blk_body or "could not find" in blk_body:
                        raise FileNotFoundError(
                            f"CID {clean} is not present in local private Kubo blockstore."
                        ) from blk_err
                    raise
            raise

    def cat_cid(self, cid: str) -> bytes:
        resp = self.open_cid_stream(cid)
        try:
            chunks = []
            total = 0
            while True:
                chunk = resp.read(STREAM_CHUNK_BYTES)
                if not chunk:
                    break
                total += len(chunk)
                if total > MAX_STREAM_BYTES:
                    raise ValueError(f"IPFS object exceeds maximum allowed stream size ({MAX_STREAM_BYTES} bytes).")
                chunks.append(chunk)
            return b"".join(chunks)
        finally:
            try:
                resp.close()
            except Exception:
                pass

    def add_stream(
        self,
        stream,
        filename: str,
        content_length: int,
        *,
        cid_version: int = 1,
        pin: bool = True,
        only_hash: bool = False,
        timeout_sec: float = 300.0,
    ) -> dict:
        """
        Stream-upload a bounded file object to private Kubo /api/v0/add?pin=<bool>&cid-version=1
        (or only-hash=true for zero-block-write CID precomputation) in 64 KiB chunks.
        """
        safe_name = sanitize_upload_filename(filename)
        if content_length < 0 or content_length > MAX_UPLOAD_BYTES:
            raise ValueError(f"Upload size {content_length} exceeds MAX_UPLOAD_BYTES ({MAX_UPLOAD_BYTES}).")
        parsed = urllib.parse.urlparse(self.rpc_url)
        if parsed.scheme not in ("http", "https") or not parsed.hostname:
            raise ValueError(f"Invalid Kubo RPC URL: {self.rpc_url}")

        boundary = f"----GenoChainBoundary{secrets.token_hex(16)}"
        prefix = (
            f"--{boundary}\r\n"
            f'Content-Disposition: form-data; name="file"; filename="{safe_name}"\r\n'
            f"Content-Type: application/octet-stream\r\n\r\n"
        ).encode("utf-8")
        suffix = f"\r\n--{boundary}--\r\n".encode("utf-8")
        total_body_len = len(prefix) + int(content_length) + len(suffix)

        base_path = parsed.path.rstrip("/")
        params = {
            "pin": "true" if (pin and not only_hash) else "false",
            "cid-version": str(int(cid_version)),
        }
        if only_hash:
            params["only-hash"] = "true"
        q = urllib.parse.urlencode(params)
        target_path = f"{base_path}/api/v0/add?{q}"

        conn_cls = http.client.HTTPSConnection if parsed.scheme == "https" else http.client.HTTPConnection
        port = parsed.port or (443 if parsed.scheme == "https" else 80)
        conn = conn_cls(parsed.hostname, port, timeout=max(self.timeout_sec, float(timeout_sec)))
        try:
            conn.putrequest("POST", target_path)
            conn.putheader("Content-Type", f"multipart/form-data; boundary={boundary}")
            conn.putheader("Content-Length", str(total_body_len))
            conn.endheaders()
            conn.send(prefix)
            remaining = int(content_length)
            while remaining > 0:
                chunk = stream.read(min(STREAM_CHUNK_BYTES, remaining))
                if not chunk:
                    raise IOError("Unexpected EOF while streaming upload payload to Kubo.")
                conn.send(chunk)
                remaining -= len(chunk)
            conn.send(suffix)
            resp = conn.getresponse()
            raw_body = resp.read(65536).decode("utf-8", errors="replace")
            if resp.status != 200:
                raise RuntimeError(f"Kubo /api/v0/add failed (HTTP {resp.status}): {raw_body[:240]}")
            # Kubo may emit newline-delimited JSON objects; parse the last non-empty JSON line
            lines = [ln.strip() for ln in raw_body.splitlines() if ln.strip()]
            payload = json.loads(lines[-1]) if lines else {}
            cid = validate_cid(str(payload.get("Hash") or ""))
            size_val = int(payload.get("Size") or content_length)
            return {"cid": cid, "size": size_val}
        finally:
            try:
                conn.close()
            except Exception:
                pass

    def pin_cid(self, cid: str) -> bool:
        """Recursively pin an already-added CID in private Kubo strictly after provenance authorization."""
        clean = validate_cid(cid)
        q = urllib.parse.urlencode({"arg": clean, "recursive": "true"})
        self._post(f"/api/v0/pin/add?{q}")
        return True

    def unpin_cid(self, cid: str) -> bool:
        clean = validate_cid(cid)
        q = urllib.parse.urlencode({"arg": clean})
        try:
            self._post(f"/api/v0/pin/rm?{q}")
            return True
        except urllib.error.HTTPError as err:
            body = self._read_http_error(err)
            if "not pinned" in body:
                return False
            raise

    def list_recursive_pins(self) -> list[str]:
        """List all recursively pinned CIDs on private Kubo so multihash aliases can be unpinned together.
        Raises on transient Kubo HTTP/socket/JSON faults so GDPR erasure retries cleanly instead of marking erased."""
        raw = self._post("/api/v0/pin/ls?type=recursive", timeout_sec=min(self.timeout_sec, 15.0))
        payload = json.loads(raw.decode("utf-8", errors="replace")) if raw else {}
        if not isinstance(payload, dict):
            raise RuntimeError("Unexpected non-object JSON payload from Kubo /api/v0/pin/ls.")
        keys = payload.get("Keys")
        if keys is None:
            return []
        if not isinstance(keys, dict):
            raise RuntimeError("Unexpected Keys field in Kubo /api/v0/pin/ls response.")
        return [str(k) for k in keys.keys()]

    def repo_stat_bytes(self) -> int | None:
        """Query live private Kubo repository disk size in bytes for global pinned cap enforcement."""
        try:
            raw = self._post("/api/v0/repo/stat?size-only=true", timeout_sec=min(self.timeout_sec, 5.0))
            payload = json.loads(raw.decode("utf-8", errors="replace")) if raw else {}
            if "RepoSize" in payload:
                return max(0, int(payload["RepoSize"]))
        except Exception:
            pass
        return None

    def run_gc(self) -> bool:
        self._post("/api/v0/repo/gc?quiet=true", timeout_sec=self.gc_timeout_sec, discard_body=True)
        return True


def _resolve_item_original_creator(registry_adapter, item: dict) -> str:
    explicit = str(item.get("originalCreator") or "").strip().lower()
    if explicit:
        return explicit
    token_id = int(item.get("tokenId") or item.get("dataId") or 0)
    getter = getattr(registry_adapter, "get_original_creator", None)
    if token_id > 0 and callable(getter):
        try:
            resolved = getter(token_id)
            if resolved:
                return str(resolved).strip().lower()
        except Exception:
            pass
    return ""


def authorize_cid_access(
    registry_adapter,
    data_id: int,
    cid: str,
    signer_address: str,
    catalog_index: PublicMetadataCatalogIndex | None = None,
    provenance_lookup=None,
) -> tuple[bool, int, str]:
    """
    Enforce on-chain authorization for (dataId, cid, signer_address) with canonical multihash
    matching, upload_provenance front-run protection, and First-Claimant Ownership protection
    against cross-owner CID aliasing/spoofing.
    Returns (allowed, http_status, reason).
    """
    try:
        clean_cid = validate_cid(cid)
        req_mh = extract_canonical_multihash(clean_cid)
    except ValueError as err:
        return False, 400, str(err)

    try:
        item = registry_adapter.get_genomic_data(int(data_id))
    except Exception as err:
        err_l = str(err).lower()
        is_not_found = (
            "datanotfound" in err_l
            or "not found" in err_l
            or "execution reverted" in err_l
            or isinstance(err, KeyError)
        )
        return False, (404 if is_not_found else 502), f"Dataset lookup failed: {err}"

    status = int(item.get("status", -1))
    if status != 0:
        status_label = {1: "Paused", 2: "Revoked"}.get(status, f"status={status}")
        return False, 403, f"Dataset #{data_id} is not Active ({status_label})."

    allowed_mhs = {
        mh
        for mh in (
            _try_canonical_multihash(item.get("rawCid")),
            _try_canonical_multihash(item.get("summaryCid")),
            _try_canonical_multihash(item.get("metadataCid")),
        )
        if mh
    }
    if req_mh not in allowed_mhs:
        return False, 403, f"Requested CID does not belong to dataset #{data_id}."

    owner = str(item.get("currentOwner") or "").strip().lower()
    original_creator = _resolve_item_original_creator(registry_adapter, item)

    # Persistent Upload-Provenance First-Claimant Rule (L3-M1 front-run defense):
    # When this gateway authenticated the initial SIWE /api/v0/upload for `req_mh`, the recorded
    # uploader is the canonical First-Claimant owner even if a mempool front-runner registered
    # a dummy dataset at an earlier dataId=N before the victim's dataId=N+1 confirmed on-chain.
    provenance_uploader = None
    if callable(provenance_lookup):
        try:
            raw_prov = provenance_lookup(req_mh)
            if raw_prov:
                provenance_uploader = str(raw_prov).strip().lower()
        except Exception:
            provenance_uploader = None

    if provenance_uploader:
        is_provenance_backed = (owner == provenance_uploader) or (
            bool(original_creator) and original_creator == provenance_uploader
        )
        if not is_provenance_backed:
            return (
                False,
                403,
                "CID multihash upload provenance belongs to another authenticated uploader (front-run / cross-owner CID aliasing rejected).",
            )
    else:
        # On-chain First-Claimant fallback (for CIDs pinned directly to Kubo outside /api/v0/upload).
        # Because SIWE signature + live get_genomic_data(data_id) ALREADY succeeded, an authoritative
        # catalog refresh bypasses unauthenticated cooldowns AND fails closed (502) if unverifiable on dataId > 1.
        has_catalog_getter = callable(getattr(registry_adapter, "get_all_datasets", None))
        first_claim = None
        catalog_lookup_failed = False
        if catalog_index is not None:
            first_claim = catalog_index.get_first_registrant_info(req_mh, allow_authoritative_refresh=True)
        elif has_catalog_getter:
            try:
                all_ds = sorted(
                    [ds for ds in (registry_adapter.get_all_datasets() or []) if isinstance(ds, dict)],
                    key=lambda d: int(d.get("dataId", 0)),
                )
                for ds in all_ds:
                    ds_mhs = {
                        _try_canonical_multihash(ds.get("rawCid")),
                        _try_canonical_multihash(ds.get("summaryCid")),
                        _try_canonical_multihash(ds.get("metadataCid")),
                    }
                    if req_mh in ds_mhs:
                        first_claim = (
                            int(ds.get("dataId", 0)),
                            str(ds.get("currentOwner") or "").strip().lower(),
                            _resolve_item_original_creator(registry_adapter, ds),
                        )
                        break
            except Exception:
                catalog_lookup_failed = True
                first_claim = None

        if first_claim is None and has_catalog_getter and (catalog_lookup_failed or int(data_id) > 1):
            return (
                False,
                502,
                f"Unable to verify canonical First-Claimant Ownership for dataset #{data_id} (on-chain catalog unavailable).",
            )

        if first_claim is not None:
            if len(first_claim) >= 3:
                earliest_id, earliest_owner, earliest_creator = first_claim[0], first_claim[1], first_claim[2]
            else:
                earliest_id, earliest_owner = first_claim[0], first_claim[1]
                earliest_creator = ""
            allowed_first = {a for a in (earliest_owner, earliest_creator) if a}
            item_identities = {a for a in (owner, original_creator) if a}
            if int(data_id) != earliest_id and allowed_first and not (item_identities & allowed_first):
                return (
                    False,
                    403,
                    f"CID multihash is canonically owned by earlier dataset #{earliest_id} (cross-owner CID aliasing rejected).",
                )

    if signer_address.lower() == owner:
        return True, 200, "owner"

    try:
        has_access = bool(registry_adapter.has_active_access(int(data_id), signer_address))
    except Exception as err:
        return False, 502, f"On-chain hasActiveAccess lookup failed: {err}"

    if not has_access:
        return False, 403, f"Signer {signer_address} does not hold an active license for dataset #{data_id}."

    return True, 200, "licensed_buyer"


class GdprErasureReconciler:
    """
    Watches DataStatusUpdated(..., Revoked=2) events with a 5-block reorg lookback on every
    cycle, enforces owner-scoped canonical multihash ref-counting (blocking cross-owner
    pin-lock griefing while preserving same-owner shared references), unpins all CIDv0/CIDv1
    multihash aliases, runs automatic Orphan-Pin TTL GC for unanchored uploads, persists
    state in SQLite, and physically purges revoked/orphan blocks via repo/gc.
    """

    def __init__(
        self,
        registry_adapter,
        kubo_adapter,
        start_block: int = 0,
        db_path: str = ":memory:",
        orphan_pin_ttl_sec: int = DEFAULT_ORPHAN_PIN_TTL_SEC,
        now_fn=None,
        catalog_index: PublicMetadataCatalogIndex | None = None,
    ):
        self.registry_adapter = registry_adapter
        self.kubo_adapter = kubo_adapter
        self.catalog_index = catalog_index
        self.deployed_block = max(0, int(start_block))
        self._db_path = str(db_path or ":memory:")
        self._orphan_ttl = max(0, int(orphan_pin_ttl_sec))
        self._now_fn = now_fn or time.time
        self._lock = threading.Lock()
        self._conn = _open_sqlite_db(self._db_path)
        self.last_block = self.deployed_block
        self.erased_data_ids: set[int] = set()
        self.unpinned_cids_total = 0
        self.erasures_total = 0
        self.orphan_unpinned_total = 0
        self._gc_pending = False
        self._gc_generation = 0
        self._init_and_load_state()

    def _init_and_load_state(self) -> None:
        with self._lock:
            with _sqlite_write_tx(self._conn):
                self._conn.execute(
                    """
                    CREATE TABLE IF NOT EXISTS gdpr_meta (
                        k TEXT PRIMARY KEY,
                        v TEXT NOT NULL
                    )
                    """
                )
                self._conn.execute(
                    """
                    CREATE TABLE IF NOT EXISTS gdpr_erased_datasets (
                        data_id INTEGER PRIMARY KEY,
                        erased_at INTEGER NOT NULL
                    )
                    """
                )
                self._conn.execute(
                    """
                    CREATE TABLE IF NOT EXISTS pending_uploads (
                        cid TEXT PRIMARY KEY,
                        multihash TEXT NOT NULL,
                        uploader TEXT NOT NULL,
                        size_bytes INTEGER NOT NULL,
                        uploaded_at INTEGER NOT NULL,
                        sha256 TEXT NOT NULL DEFAULT ''
                    )
                    """
                )
                _ensure_column(self._conn, "pending_uploads", "sha256", "TEXT NOT NULL DEFAULT ''")
                self._conn.execute(
                    "CREATE INDEX IF NOT EXISTS idx_pending_uploads_sha256 ON pending_uploads(sha256)"
                )
                self._conn.execute(
                    """
                    CREATE TABLE IF NOT EXISTS tracked_pins (
                        cid TEXT PRIMARY KEY,
                        multihash TEXT NOT NULL,
                        size_bytes INTEGER NOT NULL,
                        pinned_at INTEGER NOT NULL,
                        sha256 TEXT NOT NULL DEFAULT ''
                    )
                    """
                )
                _ensure_column(self._conn, "tracked_pins", "sha256", "TEXT NOT NULL DEFAULT ''")
                self._conn.execute(
                    "CREATE INDEX IF NOT EXISTS idx_tracked_pins_sha256 ON tracked_pins(sha256)"
                )
                self._conn.execute(
                    """
                    CREATE TABLE IF NOT EXISTS upload_provenance (
                        multihash TEXT PRIMARY KEY,
                        uploader TEXT NOT NULL,
                        created_at REAL NOT NULL,
                        sha256 TEXT NOT NULL DEFAULT ''
                    )
                    """
                )
                _ensure_column(self._conn, "upload_provenance", "sha256", "TEXT NOT NULL DEFAULT ''")
                self._conn.execute(
                    "CREATE INDEX IF NOT EXISTS idx_upload_provenance_sha256 ON upload_provenance(sha256)"
                )
                self._conn.execute(
                    """
                    CREATE TABLE IF NOT EXISTS pending_provenance_purges (
                        multihash TEXT PRIMARY KEY,
                        queued_at REAL NOT NULL
                    )
                    """
                )
            meta = dict(self._conn.execute("SELECT k, v FROM gdpr_meta").fetchall())
            if "last_block" in meta:
                self.last_block = max(self.deployed_block, int(meta["last_block"]))
            if "gc_pending" in meta:
                self._gc_pending = meta["gc_pending"] == "1"
            if "gc_generation" in meta and str(meta["gc_generation"]).lstrip("-").isdigit():
                self._gc_generation = int(meta["gc_generation"])
            if "erasures_total" in meta:
                self.erasures_total = int(meta["erasures_total"])
            if "unpinned_cids_total" in meta:
                self.unpinned_cids_total = int(meta["unpinned_cids_total"])
            if "orphan_unpinned_total" in meta:
                self.orphan_unpinned_total = int(meta["orphan_unpinned_total"])
            rows = self._conn.execute("SELECT data_id FROM gdpr_erased_datasets").fetchall()
            self.erased_data_ids = {int(r[0]) for r in rows}

    def mark_gc_pending(self) -> int:
        """Atomically mark gc_pending='1' with monotonic gc_generation so in-flight run_gc() never clobbers it."""
        with self._lock, _sqlite_write_tx(self._conn):
            row = self._conn.execute(
                "SELECT v FROM gdpr_meta WHERE k = 'gc_generation'"
            ).fetchone()
            db_gen = int(row[0]) if row and str(row[0]).lstrip("-").isdigit() else 0
            new_gen = max(self._gc_generation, db_gen) + 1
            self._gc_generation = new_gen
            self._gc_pending = True
            self._conn.executemany(
                "INSERT INTO gdpr_meta(k, v) VALUES(?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v",
                [("gc_pending", "1"), ("gc_generation", str(new_gen))],
            )
            return new_gen

    def _read_gc_generation_locked(self) -> tuple[bool, int]:
        rows = dict(
            self._conn.execute(
                "SELECT k, v FROM gdpr_meta WHERE k IN ('gc_pending', 'gc_generation')"
            ).fetchall()
        )
        db_pending = rows.get("gc_pending") == "1"
        raw_gen = rows.get("gc_generation", "0")
        db_gen = int(raw_gen) if str(raw_gen).lstrip("-").isdigit() else 0
        return db_pending, db_gen

    def _persist_state(
        self,
        newly_erased_id: int | None = None,
        *,
        cleared_at_gc_generation: int | None = None,
    ) -> None:
        with self._lock, _sqlite_write_tx(self._conn):
            if newly_erased_id is not None:
                self._conn.execute(
                    "INSERT OR IGNORE INTO gdpr_erased_datasets(data_id, erased_at) VALUES(?, ?)",
                    (int(newly_erased_id), int(self._now_fn())),
                )
            db_pending, db_gen = self._read_gc_generation_locked()
            if cleared_at_gc_generation is not None:
                # Clear gc_pending ONLY if no newer mark_gc_pending() bumped generation during run_gc()
                if db_gen > cleared_at_gc_generation or self._gc_generation > cleared_at_gc_generation:
                    self._gc_pending = True
                else:
                    self._gc_pending = False
                self._gc_generation = max(self._gc_generation, db_gen)
            elif self._gc_pending:
                self._gc_generation = max(self._gc_generation, db_gen)
            else:
                if db_gen > self._gc_generation or (db_pending and db_gen >= self._gc_generation):
                    self._gc_pending = True
                    self._gc_generation = max(self._gc_generation, db_gen)
            pairs = [
                ("last_block", str(int(self.last_block))),
                ("gc_pending", "1" if self._gc_pending else "0"),
                ("gc_generation", str(int(self._gc_generation))),
                ("erasures_total", str(int(self.erasures_total))),
                ("unpinned_cids_total", str(int(self.unpinned_cids_total))),
                ("orphan_unpinned_total", str(int(self.orphan_unpinned_total))),
            ]
            self._conn.executemany(
                "INSERT INTO gdpr_meta(k, v) VALUES(?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v",
                pairs,
            )

    def _remove_tracked_pins(
        self,
        cids: list[str],
        multihashes: set[str] | None = None,
        *,
        shas: set[str] | None = None,
        purge_provenance: bool = False,
    ) -> None:
        if not cids and not multihashes and not shas:
            return
        with self._lock, _sqlite_write_tx(self._conn):
            if cids:
                self._conn.executemany("DELETE FROM tracked_pins WHERE cid = ?", [(c,) for c in cids])
                self._conn.executemany("DELETE FROM pending_uploads WHERE cid = ?", [(c,) for c in cids])
            if multihashes:
                self._conn.executemany("DELETE FROM tracked_pins WHERE multihash = ?", [(m,) for m in multihashes])
                self._conn.executemany("DELETE FROM pending_uploads WHERE multihash = ?", [(m,) for m in multihashes])
                if purge_provenance:
                    self._conn.executemany(
                        "DELETE FROM upload_provenance WHERE multihash = ?",
                        [(m,) for m in multihashes],
                    )
            if shas:
                self._conn.executemany("DELETE FROM tracked_pins WHERE sha256 = ?", [(s,) for s in shas])
                self._conn.executemany("DELETE FROM pending_uploads WHERE sha256 = ?", [(s,) for s in shas])
                if purge_provenance:
                    self._conn.executemany(
                        "DELETE FROM upload_provenance WHERE sha256 = ?",
                        [(s,) for s in shas],
                    )

    def _get_upload_provenance_map(self, multihashes: set[str]) -> dict[str, str]:
        if not multihashes:
            return {}
        out: dict[str, str] = {}
        with self._lock:
            for mh in multihashes:
                row = self._conn.execute(
                    "SELECT uploader FROM upload_provenance WHERE multihash = ?",
                    (mh,),
                ).fetchone()
                if row and row[0]:
                    out[mh] = str(row[0]).strip().lower()
        return out

    def _collect_owner_scoped_referenced_mhs(
        self,
        excluding_data_id: int,
        revoked_owner_lower: str,
    ) -> set[str]:
        """
        Collect canonical multihashes referenced by other non-revoked (status != 2) datasets
        scoped to the SAME dataset owner, an earlier dataId, OR the recorded upload_provenance
        uploader (protecting legitimate owners from front-runner GDPR erasure attacks while
        still preventing third-party pin-lock griefing).
        """
        getter = getattr(self.registry_adapter, "get_all_datasets", None)
        if not callable(getter):
            return set()
        datasets = getter() or []
        all_other_mhs: set[str] = set()
        for ds in datasets:
            if not isinstance(ds, dict):
                continue
            if int(ds.get("dataId", 0)) == excluding_data_id or int(ds.get("status", -1)) == 2:
                continue
            for field in ("rawCid", "summaryCid", "metadataCid"):
                mh = _try_canonical_multihash(ds.get(field))
                if mh:
                    all_other_mhs.add(mh)
        prov_map = self._get_upload_provenance_map(all_other_mhs)

        referenced_mhs: set[str] = set()
        for ds in datasets:
            if not isinstance(ds, dict):
                continue
            ds_id = int(ds.get("dataId", 0))
            if ds_id == excluding_data_id:
                continue
            if int(ds.get("status", -1)) == 2:
                continue
            other_owner = str(ds.get("currentOwner") or "").strip().lower()
            other_creator = _resolve_item_original_creator(self.registry_adapter, ds)
            is_same_owner = other_owner == revoked_owner_lower
            is_earlier_dataset = ds_id > 0 and ds_id < excluding_data_id
            for field in ("rawCid", "summaryCid", "metadataCid"):
                mh = _try_canonical_multihash(ds.get(field))
                if not mh:
                    continue
                prov_uploader = prov_map.get(mh)
                if prov_uploader:
                    # Provenance-authoritative refcount: only active datasets owned or originally
                    # created by the authenticated uploader keep `mh` referenced. An earlier
                    # front-runner dataset (ds_id < excluding_data_id) can NEVER pin-lock GDPR erasure.
                    is_provenance_owner = (
                        other_owner == prov_uploader or (bool(other_creator) and other_creator == prov_uploader)
                    )
                    if is_provenance_owner:
                        referenced_mhs.add(mh)
                elif is_same_owner or is_earlier_dataset:
                    referenced_mhs.add(mh)
        return referenced_mhs

    def _collect_owner_scoped_referenced_shas(
        self,
        excluding_data_id: int,
        revoked_owner_lower: str,
        revoked_creator_lower: str = "",
    ) -> tuple[set[str], list[dict]]:
        """
        Collect content SHA-256 digests legitimately shared by other non-revoked (status != 2)
        datasets owned or originally created by the revoked dataset's owner/creator (preventing
        third-party pin-lock griefing while preserving legitimate same-owner shared artifacts).
        Returns (shared_shas, all_datasets).
        """
        getter = getattr(self.registry_adapter, "get_all_datasets", None)
        if not callable(getter):
            return set(), []
        datasets = [ds for ds in (getter() or []) if isinstance(ds, dict)]
        revoked_identities = {a for a in (revoked_owner_lower, revoked_creator_lower) if a}
        shared_shas: set[str] = set()
        artifact_hash_getter = getattr(self.registry_adapter, "get_artifact_hashes", None)
        for ds in datasets:
            ds_id = int(ds.get("dataId", 0))
            if ds_id == excluding_data_id or int(ds.get("status", -1)) == 2:
                continue
            other_owner = str(ds.get("currentOwner") or "").strip().lower()
            other_creator = _resolve_item_original_creator(self.registry_adapter, ds)
            other_identities = {a for a in (other_owner, other_creator) if a}
            if not (other_identities & revoked_identities):
                continue
            shas = [
                _normalize_sha256_hex(ds.get("rawDataHash")),
                _normalize_sha256_hex(ds.get("summaryHash") or ds.get("summaryDataHash")),
                _normalize_sha256_hex(ds.get("metadataHash")),
            ]
            if (
                ds_id > 0
                and "summaryHash" not in ds
                and "summaryDataHash" not in ds
                and callable(artifact_hash_getter)
            ):
                ah_res = artifact_hash_getter(ds_id)
                if ah_res and len(ah_res) >= 3:
                    shas.extend(_normalize_sha256_hex(h) for h in ah_res)
            for h in shas:
                if h:
                    shared_shas.add(h)
        return shared_shas, datasets

    def _collect_cross_codec_pins_for_shas(self, shas: set[str]) -> tuple[list[str], set[str]]:
        """Lookup tracked_pins, pending_uploads, and upload_provenance rows matching any target content SHA-256."""
        if not shas:
            return [], set()
        found_cids: list[str] = []
        found_mhs: set[str] = set()
        with self._lock:
            for sha in shas:
                for tbl in ("tracked_pins", "pending_uploads"):
                    for cid_val, mh_val in self._conn.execute(
                        f"SELECT cid, multihash FROM {tbl} WHERE sha256 = ?",
                        (sha,),
                    ).fetchall():
                        c_s = str(cid_val or "").strip()
                        m_s = str(mh_val or "").strip() or (_try_canonical_multihash(c_s) or "")
                        if c_s and c_s not in found_cids:
                            found_cids.append(c_s)
                        if m_s:
                            found_mhs.add(m_s)
                for (mh_val,) in self._conn.execute(
                    "SELECT multihash FROM upload_provenance WHERE sha256 = ?",
                    (sha,),
                ).fetchall():
                    m_s = str(mh_val or "").strip()
                    if m_s:
                        found_mhs.add(m_s)
        return found_cids, found_mhs

    def _queue_provenance_purges(
        self,
        multihashes: set[str] | dict[str, float],
        default_max_ts: float | None = None,
    ) -> None:
        """
        Persist upload_provenance rows slated for deletion strictly AFTER Kubo repo/gc succeeds
        (L3-L1 defense: prevents pre-GC provenance purge from reopening front-runner access).
        """
        if not multihashes:
            return
        now_f = float(self._now_fn() if default_max_ts is None else default_max_ts)
        with self._lock, _sqlite_write_tx(self._conn):
            items = multihashes.items() if isinstance(multihashes, dict) else ((m, None) for m in multihashes)
            for mh, explicit_ts in items:
                mh_s = str(mh or "").strip()
                if not mh_s:
                    continue
                if explicit_ts is not None:
                    cap_ts = float(explicit_ts)
                else:
                    row = self._conn.execute(
                        "SELECT created_at FROM upload_provenance WHERE multihash = ?",
                        (mh_s,),
                    ).fetchone()
                    existing_ts = float(row[0]) if row and row[0] is not None else 0.0
                    cap_ts = max(now_f, existing_ts)
                self._conn.execute(
                    """
                    INSERT INTO pending_provenance_purges(multihash, queued_at)
                    VALUES(?, ?)
                    ON CONFLICT(multihash) DO UPDATE SET
                        queued_at = MAX(pending_provenance_purges.queued_at, excluded.queued_at)
                    """,
                    (mh_s, cap_ts),
                )

    def _flush_pending_provenance_purges(self) -> int:
        """
        Delete queued upload_provenance rows ONLY AFTER Kubo repo/gc physically purged blocks,
        while preserving provenance for any multihash concurrently re-pinned, pending, or
        referenced by an active non-revoked on-chain dataset owned/created by that uploader.
        """
        with self._lock:
            pending_rows = self._conn.execute(
                "SELECT multihash, queued_at FROM pending_provenance_purges"
            ).fetchall()
        if not pending_rows:
            return 0
        anchored_owners_by_mh: dict[str, set[str]] = {}
        if callable(getattr(self.registry_adapter, "get_all_datasets", None)):
            try:
                anchored_owners_by_mh = self._collect_anchored_owners_by_mh()
            except Exception:
                # Fail closed on RPC outage: retain provenance & pending queue until verified
                return 0

        flushed = 0
        with self._lock, _sqlite_write_tx(self._conn):
            rows = self._conn.execute(
                "SELECT multihash, queued_at FROM pending_provenance_purges"
            ).fetchall()
            if not rows:
                return 0
            for mh, queued_at in rows:
                mh_s = str(mh)
                q_ts = float(queued_at)
                still_pinned = self._conn.execute(
                    "SELECT 1 FROM tracked_pins WHERE multihash = ? LIMIT 1",
                    (mh_s,),
                ).fetchone()
                still_pending = self._conn.execute(
                    "SELECT 1 FROM pending_uploads WHERE multihash = ? LIMIT 1",
                    (mh_s,),
                ).fetchone()
                prov_row = self._conn.execute(
                    "SELECT uploader FROM upload_provenance WHERE multihash = ?",
                    (mh_s,),
                ).fetchone()
                prov_up = str(prov_row[0]).strip().lower() if prov_row and prov_row[0] else ""
                has_authorized_active_anchor = bool(
                    prov_up and prov_up in anchored_owners_by_mh.get(mh_s, set())
                )
                if still_pinned is None and still_pending is None and not has_authorized_active_anchor:
                    self._conn.execute(
                        "DELETE FROM upload_provenance WHERE multihash = ? AND created_at <= ?",
                        (mh_s, q_ts),
                    )
                    flushed += 1
                self._conn.execute(
                    "DELETE FROM pending_provenance_purges WHERE multihash = ? AND queued_at <= ?",
                    (mh_s, q_ts),
                )
            return flushed

    def _collect_anchored_owners_by_mh(self) -> dict[str, set[str]]:
        """
        Collect non-revoked (status != 2) on-chain dataset owners/creators keyed by canonical multihash.
        REV-03 defense: third-party or revoked dummy datasets can NEVER lock another uploader's orphan pin.
        """
        getter = getattr(self.registry_adapter, "get_all_datasets", None)
        if not callable(getter):
            return {}
        datasets = getter() or []
        anchored: dict[str, set[str]] = {}
        for ds in datasets:
            if not isinstance(ds, dict):
                continue
            if int(ds.get("status", -1)) == 2:
                continue
            owner_l = str(ds.get("currentOwner") or "").strip().lower()
            creator_l = _resolve_item_original_creator(self.registry_adapter, ds)
            owners = {a for a in (owner_l, creator_l) if a}
            if not owners:
                continue
            for field in ("rawCid", "summaryCid", "metadataCid"):
                mh = _try_canonical_multihash(ds.get(field))
                if mh:
                    anchored.setdefault(mh, set()).update(owners)
        return anchored

    def reconcile_orphan_uploads(self, now_ts: int | None = None) -> list[str]:
        """Unpin expired pending_uploads not anchored on-chain by their uploader within orphan_pin_ttl_sec."""
        if self._orphan_ttl <= 0:
            return []
        if not callable(getattr(self.registry_adapter, "get_all_datasets", None)):
            return []
        now = int(self._now_fn() if now_ts is None else now_ts)
        cutoff = now - self._orphan_ttl
        with self._lock:
            rows = self._conn.execute(
                "SELECT cid, multihash, uploader, uploaded_at FROM pending_uploads ORDER BY uploaded_at ASC"
            ).fetchall()
        if not rows:
            return []
        anchored_owners_by_mh = self._collect_anchored_owners_by_mh()
        row_mhs = {
            str(mh) or (_try_canonical_multihash(str(cid)) or "")
            for cid, mh, _, _ in rows
        }
        row_mhs.discard("")
        prov_map = self._get_upload_provenance_map(row_mhs)
        list_pins_fn = getattr(self.kubo_adapter, "list_recursive_pins", None)
        recursive_pins_cache: list[str] | None = None

        done_anchored_rows: list[tuple[str, int]] = []
        done_orphan_rows: list[tuple[str, int]] = []
        orphan_unpinned: list[str] = []
        removed_pin_rows: list[tuple[str, int]] = []
        queued_orphan_prov_purges: dict[str, float] = {}

        for cid, mh, uploader, uploaded_at in rows:
            cid_s = str(cid)
            mh_s = str(mh) or (_try_canonical_multihash(cid_s) or "")
            up_l = str(uploader or "").strip().lower()
            obs_ts = int(uploaded_at)
            expected_uploaders = {a for a in (up_l, prov_map.get(mh_s)) if a and a != "unknown"}
            anchored_owners = anchored_owners_by_mh.get(mh_s, set()) if mh_s else set()
            if mh_s and expected_uploaders and (anchored_owners & expected_uploaders):
                # Anchored on-chain by the uploader (non-revoked): dequeue from orphan-GC, KEEP pin & provenance!
                done_anchored_rows.append((cid_s, obs_ts))
                continue
            if obs_ts <= cutoff:
                # L3-L2 TOCTOU re-check: verify row was not concurrently refreshed by an identical-CID re-upload
                with self._lock:
                    cur_row = self._conn.execute(
                        "SELECT uploaded_at FROM pending_uploads WHERE cid = ?",
                        (cid_s,),
                    ).fetchone()
                if cur_row is None or int(cur_row[0]) > cutoff:
                    continue
                try:
                    validate_cid(cid_s)
                    cids_to_unpin = [cid_s]
                    if mh_s and callable(list_pins_fn):
                        if recursive_pins_cache is None:
                            recursive_pins_cache = list(list_pins_fn() or [])
                        for p_cid in recursive_pins_cache:
                            if p_cid not in cids_to_unpin and _try_canonical_multihash(p_cid) == mh_s:
                                cids_to_unpin.append(p_cid)
                    unpinned_here: list[str] = []
                    for target_c in cids_to_unpin:
                        if self.kubo_adapter.unpin_cid(target_c):
                            unpinned_here.append(target_c)
                    # L3-L2 post-unpin TOCTOU recovery: if an identical-CID re-upload raced during the
                    # Kubo unpin HTTP call and refreshed pending_uploads/tracked_pins (> cutoff), restore
                    # the pin immediately and skip SQLite deletion / provenance purge!
                    with self._lock:
                        post_pending = self._conn.execute(
                            "SELECT uploaded_at FROM pending_uploads WHERE cid = ?",
                            (cid_s,),
                        ).fetchone()
                        post_tracked = self._conn.execute(
                            "SELECT pinned_at FROM tracked_pins WHERE cid = ?",
                            (cid_s,),
                        ).fetchone()
                    concurrently_refreshed = (
                        (post_pending is not None and int(post_pending[0]) > cutoff)
                        or (post_tracked is not None and int(post_tracked[0]) > cutoff)
                    )
                    if concurrently_refreshed:
                        pin_fn = getattr(self.kubo_adapter, "pin_cid", None)
                        if callable(pin_fn):
                            try:
                                pin_fn(cid_s)
                            except Exception:
                                pass
                        continue
                    for target_c in unpinned_here:
                        orphan_unpinned.append(target_c)
                        self.orphan_unpinned_total += 1
                    self._gc_pending = True
                    done_orphan_rows.append((cid_s, cutoff))
                    for target_c in cids_to_unpin:
                        removed_pin_rows.append((target_c, cutoff))
                    if mh_s:
                        queued_orphan_prov_purges[mh_s] = float(cutoff)
                except Exception:
                    continue

        if done_anchored_rows or done_orphan_rows or removed_pin_rows:
            with self._lock, _sqlite_write_tx(self._conn):
                if done_anchored_rows:
                    self._conn.executemany(
                        "DELETE FROM pending_uploads WHERE cid = ? AND uploaded_at <= ?",
                        done_anchored_rows,
                    )
                if done_orphan_rows:
                    self._conn.executemany(
                        "DELETE FROM pending_uploads WHERE cid = ? AND uploaded_at <= ?",
                        done_orphan_rows,
                    )
                if removed_pin_rows:
                    self._conn.executemany(
                        "DELETE FROM tracked_pins WHERE cid = ? AND pinned_at <= ?",
                        removed_pin_rows,
                    )
        if queued_orphan_prov_purges:
            # L3-L1: defer upload_provenance purge until AFTER Kubo repo/gc succeeds
            self._queue_provenance_purges(queued_orphan_prov_purges)
        if self._gc_pending and (done_orphan_rows or orphan_unpinned):
            # L3-02: persist gc_pending durability BEFORE run_gc() so crashes preserve retry state
            self._persist_state()
        return orphan_unpinned

    def reconcile_once(self) -> dict:
        tip = int(self.registry_adapter.get_block_number())
        if tip < self.last_block:
            # Shallow reorg clamp
            self.last_block = max(self.deployed_block, tip - REORG_LOOKBACK_BLOCKS)
        # Always include a 5-block reorg lookback window on monotonic cycles so same-height reorgs are never missed
        scan_from = max(self.deployed_block, self.last_block - REORG_LOOKBACK_BLOCKS)
        events = self.registry_adapter.get_status_updated_events(scan_from, tip)
        revoked_ids = sorted(
            {int(ev["dataId"]) for ev in events if int(ev.get("newStatus", -1)) == 2}
        )
        unpinned_now = []
        skipped_shared = []
        reconcile_incomplete = False
        list_pins_fn = getattr(self.kubo_adapter, "list_recursive_pins", None)
        artifact_hash_getter = getattr(self.registry_adapter, "get_artifact_hashes", None)
        for data_id in revoked_ids:
            if data_id in self.erased_data_ids:
                continue
            item = self.registry_adapter.get_genomic_data(data_id)
            if int(item.get("status", -1)) != 2:
                continue
            revoked_owner_l = str(item.get("currentOwner") or "").strip().lower()
            revoked_creator_l = _resolve_item_original_creator(self.registry_adapter, item)
            cids = []
            for field in ("rawCid", "summaryCid", "metadataCid"):
                c = str(item.get(field) or "").strip()
                if c and c not in cids:
                    cids.append(c)
            shared_mhs = self._collect_owner_scoped_referenced_mhs(data_id, revoked_owner_l)
            shared_shas, all_ds = self._collect_owner_scoped_referenced_shas(
                data_id, revoked_owner_l, revoked_creator_l
            )
            candidate_mhs: set[str] = set()
            for c in cids:
                mh_c = _try_canonical_multihash(c)
                if mh_c:
                    candidate_mhs.add(mh_c)
            prov_map = self._get_upload_provenance_map(candidate_mhs)
            target_mhs: set[str] = set()
            cids_to_unpin: list[str] = []
            for c in cids:
                try:
                    validate_cid(c)
                    mh = extract_canonical_multihash(c)
                except ValueError:
                    continue
                if mh in shared_mhs:
                    skipped_shared.append(c)
                    continue
                # L3-M1 front-run erasure defense: a non-uploader front-runner revoking a dummy
                # dataset can NEVER trigger unpin/repo-gc of another uploader's provenanced ciphertext.
                prov_uploader = prov_map.get(mh)
                if prov_uploader and revoked_owner_l != prov_uploader and revoked_creator_l != prov_uploader:
                    skipped_shared.append(c)
                    continue
                target_mhs.add(mh)
                if c not in cids_to_unpin:
                    cids_to_unpin.append(c)

            # Cross-codec GDPR Art. 17 erasure: find any tracked/cataloged alias pins matching this
            # dataset's rawDataHash / summaryHash / metadataHash (when not shared by active same-owner datasets)
            item_shas: list[str] = [
                _normalize_sha256_hex(item.get("rawDataHash")),
                _normalize_sha256_hex(item.get("summaryHash") or item.get("summaryDataHash")),
                _normalize_sha256_hex(item.get("metadataHash")),
            ]
            if (
                "summaryHash" not in item
                and "summaryDataHash" not in item
                and callable(artifact_hash_getter)
            ):
                ah_item = artifact_hash_getter(data_id)
                if ah_item and len(ah_item) >= 3:
                    item_shas.extend(_normalize_sha256_hex(h) for h in ah_item)
            target_shas = {h for h in item_shas if h and h not in shared_shas}
            if target_shas:
                sha_cids, sha_mhs = self._collect_cross_codec_pins_for_shas(target_shas)
                for sc in sha_cids:
                    try:
                        validate_cid(sc)
                        smh = extract_canonical_multihash(sc)
                    except ValueError:
                        continue
                    if smh in shared_mhs:
                        continue
                    target_mhs.add(smh)
                    if sc not in cids_to_unpin:
                        cids_to_unpin.append(sc)
                for smh in sha_mhs:
                    if smh and smh not in shared_mhs:
                        target_mhs.add(smh)
                if self.catalog_index is not None:
                    for t_sha in target_shas:
                        for ent in self.catalog_index.get_datasets_by_sha(t_sha):
                            ec = str(ent.get("cid") or "").strip()
                            if not ec:
                                continue
                            try:
                                validate_cid(ec)
                                emh = extract_canonical_multihash(ec)
                            except ValueError:
                                continue
                            if emh not in shared_mhs:
                                target_mhs.add(emh)
                                if ec not in cids_to_unpin:
                                    cids_to_unpin.append(ec)
                for other_ds in all_ds:
                    if int(other_ds.get("dataId", 0)) == data_id:
                        continue
                    for h_field, c_field in (
                        ("rawDataHash", "rawCid"),
                        ("summaryHash", "summaryCid"),
                        ("summaryDataHash", "summaryCid"),
                        ("metadataHash", "metadataCid"),
                    ):
                        oh = _normalize_sha256_hex(other_ds.get(h_field))
                        if oh and oh in target_shas:
                            oc = str(other_ds.get(c_field) or "").strip()
                            if oc:
                                try:
                                    validate_cid(oc)
                                    omh = extract_canonical_multihash(oc)
                                except ValueError:
                                    continue
                                if omh not in shared_mhs:
                                    target_mhs.add(omh)
                                    if oc not in cids_to_unpin:
                                        cids_to_unpin.append(oc)

            # Also unpin ANY pinned CIDv0/CIDv1 alias in Kubo sharing the exact canonical multihash.
            # NEVER silently swallow transient /api/v0/pin/ls errors: retry on next cycle instead of marking erased!
            if target_mhs and callable(list_pins_fn):
                try:
                    recursive_pins = list(list_pins_fn() or [])
                except Exception:
                    reconcile_incomplete = True
                    continue
                for pinned_c in recursive_pins:
                    p_mh = _try_canonical_multihash(pinned_c)
                    if p_mh and p_mh in target_mhs and pinned_c not in cids_to_unpin:
                        cids_to_unpin.append(pinned_c)

            valid_unshared_cids = len(cids_to_unpin)
            unpin_failed = False
            for c in cids_to_unpin:
                try:
                    if self.kubo_adapter.unpin_cid(c):
                        unpinned_now.append(c)
                        self.unpinned_cids_total += 1
                        self._gc_pending = True
                except Exception:
                    unpin_failed = True
            if unpin_failed:
                reconcile_incomplete = True
                continue
            if cids_to_unpin or target_mhs or target_shas:
                # L3-L1: keep upload_provenance intact until AFTER Kubo repo/gc physically purges unpinned blocks!
                self._remove_tracked_pins(cids_to_unpin, target_mhs, shas=target_shas, purge_provenance=False)
                if target_mhs:
                    self._queue_provenance_purges(target_mhs)
            if valid_unshared_cids > 0:
                # Guarantee at least one repo/gc pass even if CIDs were already unpinned before a restart/crash
                self._gc_pending = True
            self.erased_data_ids.add(data_id)
            self.erasures_total += 1
            # Persist erased dataset & gc_pending BEFORE run_gc() so crashes preserve retry state
            self._persist_state(newly_erased_id=data_id)

        orphan_unpinned = self.reconcile_orphan_uploads()

        with self._lock:
            db_gc_pending, db_gc_gen = self._read_gc_generation_locked()
            if db_gc_pending or db_gc_gen > self._gc_generation:
                self._gc_pending = True
            pre_gc_gen = max(self._gc_generation, db_gc_gen)
            self._gc_generation = pre_gc_gen

        gc_ran = False
        cleared_gen: int | None = None
        if unpinned_now or orphan_unpinned or self._gc_pending:
            try:
                gc_ran = bool(self.kubo_adapter.run_gc())
            except Exception:
                gc_ran = False
            if gc_ran:
                cleared_gen = pre_gc_gen

        if not reconcile_incomplete:
            self.last_block = tip
        self._persist_state(cleared_at_gc_generation=cleared_gen)

        # L3-03: Always flush queued provenance purges when GC is NOT pending so a transient RPC
        # failure after run_gc() retries automatically on subsequent healthy cycles (while still
        # preserving L3-L1 by never flushing while self._gc_pending is True).
        flushed_provenance = 0
        if not self._gc_pending:
            flushed_provenance = self._flush_pending_provenance_purges()

        return {
            "scannedFromBlock": scan_from,
            "scannedToBlock": tip,
            "statusEventsCount": len(events),
            "revokedProcessed": len(revoked_ids),
            "unpinnedCids": unpinned_now,
            "orphanUnpinnedCids": orphan_unpinned,
            "skippedSharedCids": skipped_shared,
            "gcRan": gc_ran,
            "gcPending": self._gc_pending,
            "flushedProvenancePurges": flushed_provenance,
            "reconcileIncomplete": reconcile_incomplete,
        }

    def close(self) -> None:
        with self._lock:
            try:
                self._conn.close()
            except Exception:
                pass


def render_gateway_metrics(metrics: dict) -> str:
    """Render Prometheus text exposition 0.0.4 metrics for the Private IPFS Access Gateway."""
    lines = [
        "# HELP genochain_ipfs_gateway_up 1 when RPC and Kubo are healthy, 0 otherwise.",
        "# TYPE genochain_ipfs_gateway_up gauge",
        f"genochain_ipfs_gateway_up {1 if (metrics.get('rpcConnected') and metrics.get('kuboConnected')) else 0}",
        "# HELP genochain_ipfs_gateway_requests_allowed_total Total authorized IPFS fetches served.",
        "# TYPE genochain_ipfs_gateway_requests_allowed_total counter",
        f"genochain_ipfs_gateway_requests_allowed_total {int(metrics.get('requestsAllowed', 0))}",
        "# HELP genochain_ipfs_gateway_requests_denied_total Total unauthorized/invalid requests rejected.",
        "# TYPE genochain_ipfs_gateway_requests_denied_total counter",
        f"genochain_ipfs_gateway_requests_denied_total {int(metrics.get('requestsDenied', 0))}",
        "# HELP genochain_ipfs_gateway_uploads_allowed_total Total SIWE-authenticated ciphertext/metadata uploads pinned.",
        "# TYPE genochain_ipfs_gateway_uploads_allowed_total counter",
        f"genochain_ipfs_gateway_uploads_allowed_total {int(metrics.get('uploadsAllowed', 0))}",
        "# HELP genochain_ipfs_gateway_gdpr_erasures_total Total GDPR Art. 17 dataset revocations processed.",
        "# TYPE genochain_ipfs_gateway_gdpr_erasures_total counter",
        f"genochain_ipfs_gateway_gdpr_erasures_total {int(metrics.get('gdprErasuresTotal', 0))}",
        "# HELP genochain_ipfs_gateway_gdpr_unpinned_cids_total Total revoked CIDs physically unpinned from Kubo.",
        "# TYPE genochain_ipfs_gateway_gdpr_unpinned_cids_total counter",
        f"genochain_ipfs_gateway_gdpr_unpinned_cids_total {int(metrics.get('gdprUnpinnedCidsTotal', 0))}",
    ]
    return "\n".join(lines) + "\n"


class BoundedThreadingHTTPServer(ThreadingHTTPServer):
    """ThreadingHTTPServer bounded by a worker semaphore to prevent thread-exhaustion DoS."""

    daemon_threads = True
    allow_reuse_address = True
    request_queue_size = 64

    def __init__(self, server_address, RequestHandlerClass, max_workers: int = DEFAULT_MAX_WORKERS):
        self._max_workers = max(4, int(max_workers))
        self._worker_sem = threading.BoundedSemaphore(self._max_workers)
        super().__init__(server_address, RequestHandlerClass)

    def process_request(self, request, client_address):
        if not self._worker_sem.acquire(timeout=5.0):
            try:
                request.sendall(
                    b"HTTP/1.1 503 Service Unavailable\r\n"
                    b"Content-Type: application/json\r\n"
                    b"Content-Length: 42\r\n"
                    b"Connection: close\r\n\r\n"
                    b'{"error":"Gateway concurrency saturated."}'
                )
            except Exception:
                pass
            self.shutdown_request(request)
            return
        try:
            request.settimeout(30.0)
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

    def server_close(self):
        try:
            limiter = getattr(self, "gateway_upload_limiter", None)
            if limiter is not None:
                limiter.close()
        except Exception:
            pass
        try:
            if getattr(self, "_owns_nonce_store", False):
                ns = getattr(self, "gateway_nonce_store", None)
                if ns is not None:
                    ns.close()
        except Exception:
            pass
        super().server_close()


def create_gateway_server(
    *,
    host: str,
    port: int,
    chain_id: int,
    registry_address: str,
    registry_adapter,
    kubo_adapter,
    nonce_store: NonceStore | None = None,
    cors_origin: str = "",
    now_fn=None,
    max_workers: int = DEFAULT_MAX_WORKERS,
    catalog_refresh_sec: float = 10.0,
    min_forced_refresh_sec: float = 2.0,
    spool_dir: str | None = None,
    state_db_path: str = ":memory:",
    max_uploads_per_hour: int = DEFAULT_MAX_UPLOADS_PER_HOUR,
    max_upload_bytes_per_hour: int = DEFAULT_MAX_UPLOAD_BYTES_PER_HOUR,
    max_global_upload_bytes_per_hour: int = DEFAULT_MAX_GLOBAL_UPLOAD_BYTES_PER_HOUR,
    max_total_pinned_bytes: int = DEFAULT_MAX_TOTAL_PINNED_BYTES,
    upload_policy: str = DEFAULT_UPLOAD_POLICY,
    upload_allowlist: list[str] | set[str] | str | None = None,
    min_upload_wei: int = DEFAULT_MIN_UPLOAD_WEI,
    min_upload_geno: int = DEFAULT_MIN_UPLOAD_GENO,
):
    """Create a BoundedThreadingHTTPServer serving /ipfs/<cid>, /api/v0/upload, /healthz, and /metrics."""
    eff_policy = str(upload_policy or DEFAULT_UPLOAD_POLICY).strip().lower()
    if eff_policy not in VALID_UPLOAD_POLICIES:
        raise ValueError(f"Invalid upload_policy '{upload_policy}': expected one of {VALID_UPLOAD_POLICIES}")
    if isinstance(upload_allowlist, str):
        allowlist_set = {a.strip().lower() for a in upload_allowlist.split(",") if a.strip()}
    elif upload_allowlist:
        allowlist_set = {str(a).strip().lower() for a in upload_allowlist if str(a).strip()}
    else:
        allowlist_set = set()

    effective_db = state_db_path if state_db_path != ":memory:" else (
        getattr(nonce_store, "_db_path", ":memory:") if nonce_store is not None else ":memory:"
    )
    owns_nonce_store = nonce_store is None
    nonces = nonce_store or NonceStore(db_path=effective_db)
    clock = now_fn or time.time
    allowed_cors_origins = [o.strip() for o in str(cors_origin or "").split(",") if o.strip()]
    upload_limiter = UploadRateLimiter(
        max_uploads_per_hour=max_uploads_per_hour,
        max_bytes_per_hour=max_upload_bytes_per_hour,
        max_global_bytes_per_hour=max_global_upload_bytes_per_hour,
        max_total_pinned_bytes=max_total_pinned_bytes,
        db_path=effective_db,
        kubo_adapter=kubo_adapter,
    )
    catalog_index = PublicMetadataCatalogIndex(
        registry_adapter,
        refresh_ttl_sec=catalog_refresh_sec,
        min_forced_refresh_sec=min_forced_refresh_sec,
        provenance_lookup=upload_limiter.get_upload_provenance,
        provenance_backfill=upload_limiter.backfill_upload_provenance,
        sha_provenance_lookup=upload_limiter.get_upload_provenance_by_sha,
    )
    upload_limiter.set_first_registrant_lookup(catalog_index.get_first_registrant_info)
    metrics_lock = threading.Lock()
    metrics = {
        "rpcConnected": True,
        "kuboConnected": True,
        "chainId": int(chain_id),
        "registryAddress": registry_address,
        "requestsAllowed": 0,
        "requestsDenied": 0,
        "uploadsAllowed": 0,
        "gdprErasuresTotal": 0,
        "gdprUnpinnedCidsTotal": 0,
        "lastErasureBlock": 0,
    }

    def _check_upload_eligibility(signer_addr: str) -> tuple[bool, str]:
        if eff_policy == "open-dev":
            return True, "open_dev"
        addr_l = str(signer_addr).strip().lower()
        if addr_l in allowlist_set:
            return True, "allowlist"
        if eff_policy == "allowlist":
            return False, "Signer address is not in gateway upload allowlist."
        # onchain-eligible: allowlist (above), existing dataset owner, or on-chain eligibility check
        if catalog_index.is_known_dataset_owner(addr_l):
            return True, "dataset_owner"
        checker = getattr(registry_adapter, "check_uploader_eligibility", None)
        if callable(checker):
            return checker(signer_addr, min_wei=min_upload_wei, min_geno=min_upload_geno)
        return False, "Signer does not satisfy on-chain upload eligibility (existing dataset owner, allowlist, approved lab, or minimum balance required)."

    class _GatewayHandler(BaseHTTPRequestHandler):
        def log_message(self, format, *args):
            return

        def _resolve_cors_origin(self) -> str:
            if not allowed_cors_origins:
                return ""
            if "*" in allowed_cors_origins:
                return "*"
            req_origin = self.headers.get("Origin", "").strip()
            if req_origin:
                return req_origin if req_origin in allowed_cors_origins else ""
            return allowed_cors_origins[0] if len(allowed_cors_origins) == 1 else ""

        def _send_common_headers(self):
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Cache-Control", "no-store")
            resolved_origin = self._resolve_cors_origin()
            if resolved_origin:
                self.send_header("Access-Control-Allow-Origin", resolved_origin)
                if resolved_origin != "*":
                    self.send_header("Vary", "Origin")
                self.send_header(
                    "Access-Control-Allow-Headers",
                    "Content-Type, X-GenoChain-Data-Id, X-GenoChain-Address, X-GenoChain-Timestamp, X-GenoChain-Nonce, X-GenoChain-Signature, X-GenoChain-Content-Sha256, X-GenoChain-Filename",
                )
                self.send_header(
                    "Access-Control-Expose-Headers",
                    "X-GenoChain-Verified-DataId, X-GenoChain-Access-Role",
                )
                self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")

        def _send_json(self, status: int, payload: dict, *, send_body: bool = True):
            body = json.dumps(payload).encode("utf-8")
            self.send_response(status)
            self._send_common_headers()
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            if send_body:
                self.wfile.write(body)

        def _handle_healthz(self, *, send_body: bool):
            rpc_ok = bool(registry_adapter.is_connected())
            kubo_ok = bool(kubo_adapter.health_check())
            with metrics_lock:
                metrics["rpcConnected"] = rpc_ok
                metrics["kuboConnected"] = kubo_ok
                snap = dict(metrics)
            healthy = rpc_ok and kubo_ok
            self._send_json(200 if healthy else 503, {"status": "ok" if healthy else "degraded", **snap}, send_body=send_body)

        def _handle_metrics(self, *, send_body: bool):
            with metrics_lock:
                snap = dict(metrics)
            body = render_gateway_metrics(snap).encode("utf-8")
            self.send_response(200)
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            if send_body:
                self.wfile.write(body)

        def _stream_cid_response(self, cid: str, *, content_type: str, verified_data_id: int | None, access_role: str):
            """Stream Kubo block directly to HTTP client in 64 KiB chunks up to MAX_STREAM_BYTES."""
            open_stream_fn = getattr(kubo_adapter, "open_cid_stream", None)
            if callable(open_stream_fn):
                try:
                    kubo_resp = open_stream_fn(cid)
                except FileNotFoundError as exc:
                    self._send_json(404, {"error": str(exc)})
                    return
                except Exception as exc:
                    self._send_json(502, {"error": f"Private Kubo fetch failed: {exc}"})
                    return

                try:
                    raw_cl = kubo_resp.headers.get("Content-Length") if hasattr(kubo_resp, "headers") else None
                    parsed_cl = None
                    if raw_cl and str(raw_cl).strip().isdigit():
                        parsed_cl = int(str(raw_cl).strip())
                        if parsed_cl > MAX_STREAM_BYTES:
                            self._send_json(
                                413,
                                {"error": f"IPFS object exceeds maximum allowed stream size ({MAX_STREAM_BYTES} bytes)."},
                            )
                            return

                    first_chunk = kubo_resp.read(STREAM_CHUNK_BYTES)
                    if len(first_chunk) > MAX_STREAM_BYTES:
                        self._send_json(
                            413,
                            {"error": f"IPFS object exceeds maximum allowed stream size ({MAX_STREAM_BYTES} bytes)."},
                        )
                        return

                    with metrics_lock:
                        metrics["requestsAllowed"] += 1
                    self.send_response(200)
                    self._send_common_headers()
                    self.send_header("Content-Type", content_type)
                    if parsed_cl is not None:
                        self.send_header("Content-Length", str(parsed_cl))
                    if verified_data_id is not None:
                        self.send_header("X-GenoChain-Verified-DataId", str(verified_data_id))
                    self.send_header("X-GenoChain-Access-Role", access_role)
                    self.end_headers()

                    sent = 0
                    if first_chunk:
                        self.wfile.write(first_chunk)
                        sent += len(first_chunk)
                    while True:
                        chunk = kubo_resp.read(STREAM_CHUNK_BYTES)
                        if not chunk:
                            break
                        if sent + len(chunk) > MAX_STREAM_BYTES:
                            # Abort connection cleanly on stream cap breach
                            self.close_connection = True
                            break
                        self.wfile.write(chunk)
                        sent += len(chunk)
                finally:
                    try:
                        kubo_resp.close()
                    except Exception:
                        pass
                return

            # Fallback for simple in-memory test doubles that only implement cat_cid()
            try:
                content = kubo_adapter.cat_cid(cid)
            except FileNotFoundError as exc:
                self._send_json(404, {"error": str(exc)})
                return
            except Exception as exc:
                self._send_json(502, {"error": f"Private Kubo fetch failed: {exc}"})
                return

            if len(content) > MAX_STREAM_BYTES:
                self._send_json(
                    413,
                    {"error": f"IPFS object exceeds maximum allowed stream size ({MAX_STREAM_BYTES} bytes)."},
                )
                return

            with metrics_lock:
                metrics["requestsAllowed"] += 1
            self.send_response(200)
            self._send_common_headers()
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(content)))
            if verified_data_id is not None:
                self.send_header("X-GenoChain-Verified-DataId", str(verified_data_id))
            self.send_header("X-GenoChain-Access-Role", access_role)
            self.end_headers()
            view = memoryview(content)
            for off in range(0, len(content), STREAM_CHUNK_BYTES):
                self.wfile.write(view[off : off + STREAM_CHUNK_BYTES])

        def do_OPTIONS(self):
            self.send_response(204)
            self._send_common_headers()
            if self._resolve_cors_origin():
                self.send_header("Access-Control-Max-Age", "600")
            self.end_headers()

        def do_HEAD(self):
            path_only = self.path.split("?", 1)[0]
            if path_only == "/healthz":
                self._handle_healthz(send_body=False)
                return
            if path_only == "/metrics":
                self._handle_metrics(send_body=False)
                return
            if path_only.startswith("/ipfs/") or path_only.startswith("/v1/ipfs/"):
                self.send_response(405)
                self._send_common_headers()
                self.send_header("Allow", "GET, OPTIONS")
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            self._send_json(404, {"error": "Not found"}, send_body=False)

        def do_POST(self):
            path_only = self.path.split("?", 1)[0]
            if path_only != "/api/v0/upload":
                self._send_json(404, {"error": "Not found"})
                return

            claimed_addr = self.headers.get("X-GenoChain-Address", "").strip()
            raw_ts = self.headers.get("X-GenoChain-Timestamp", "").strip()
            nonce = self.headers.get("X-GenoChain-Nonce", "").strip()
            sig = self.headers.get("X-GenoChain-Signature", "").strip()
            claimed_sha = self.headers.get("X-GenoChain-Content-Sha256", "").strip()
            filename = sanitize_upload_filename(self.headers.get("X-GenoChain-Filename", "payload.enc"))

            if not (raw_ts.isascii() and raw_ts.isdigit() and len(raw_ts) <= MAX_TS_DIGITS):
                with metrics_lock:
                    metrics["requestsDenied"] += 1
                self._send_json(401, {"error": "Missing or non-numeric X-GenoChain-Timestamp."})
                return

            now_val = int(clock())
            ok_sig, sig_reason, recovered_addr, norm_sha = verify_siwe_upload_request(
                chain_id=chain_id,
                registry_address=registry_address,
                content_sha256=claimed_sha,
                claimed_address=claimed_addr,
                timestamp=int(raw_ts),
                nonce=nonce,
                signature=sig,
                nonce_store=nonces,
                now_ts=now_val,
                consume_nonce=False,
            )
            if not ok_sig or not recovered_addr or not norm_sha:
                with metrics_lock:
                    metrics["requestsDenied"] += 1
                self._send_json(401, {"error": sig_reason})
                return

            # Anti-Sybil eligibility check BEFORE touching quota, disk spool, or NonceStore
            eligible_ok, eligible_reason = _check_upload_eligibility(recovered_addr)
            if not eligible_ok:
                with metrics_lock:
                    metrics["requestsDenied"] += 1
                self._send_json(403, {"error": eligible_reason})
                return

            cl_headers = self.headers.get_all("Content-Length") or []
            if len(cl_headers) > 1:
                with metrics_lock:
                    metrics["requestsDenied"] += 1
                self._send_json(400, {"error": "Duplicate Content-Length headers rejected."})
                return
            raw_cl = cl_headers[0].strip() if cl_headers else ""
            te_headers = self.headers.get_all("Transfer-Encoding") or []
            te_tokens = [
                tok.strip().lower()
                for hdr in te_headers
                for tok in str(hdr).split(",")
                if tok.strip()
            ]
            if te_tokens and te_tokens != ["chunked"]:
                with metrics_lock:
                    metrics["requestsDenied"] += 1
                self._send_json(501, {"error": "Unsupported Transfer-Encoding (only 'chunked' is supported)."})
                return
            is_chunked = te_tokens == ["chunked"]

            content_length: int | None = None
            if is_chunked:
                if cl_headers:
                    with metrics_lock:
                        metrics["requestsDenied"] += 1
                    self._send_json(400, {"error": "Conflicting Transfer-Encoding and Content-Length headers."})
                    return
            else:
                if not (raw_cl.isascii() and raw_cl.isdigit() and len(raw_cl) <= 12):
                    with metrics_lock:
                        metrics["requestsDenied"] += 1
                    self._send_json(411, {"error": "Valid Content-Length or Transfer-Encoding: chunked required for upload."})
                    return
                content_length = int(raw_cl)
                if content_length <= 0:
                    with metrics_lock:
                        metrics["requestsDenied"] += 1
                    self._send_json(400, {"error": "Upload payload must be non-empty."})
                    return
                if content_length > MAX_UPLOAD_BYTES:
                    with metrics_lock:
                        metrics["requestsDenied"] += 1
                    self._send_json(413, {"error": f"Upload exceeds maximum allowed size ({MAX_UPLOAD_BYTES} bytes)."})
                    return

            # Atomically reserve upload slot + estimated bytes BEFORE spooling or consuming nonce
            allowed_quota, quota_reason, res_token = upload_limiter.reserve(
                recovered_addr, content_length or 0, now_val
            )
            if not allowed_quota or not res_token:
                with metrics_lock:
                    metrics["requestsDenied"] += 1
                self._send_json(429, {"error": quota_reason})
                return

            hasher = hashlib.sha256()
            spool = tempfile.SpooledTemporaryFile(max_size=1024 * 1024, dir=spool_dir)
            committed = False
            try:
                if is_chunked:
                    actual_len, chunk_err_status, chunk_err_msg = _read_chunked_upload_body(
                        self.rfile,
                        spool,
                        hasher,
                        MAX_UPLOAD_BYTES,
                        on_chunk_quota=lambda chunk_sz: upload_limiter.add_streamed_bytes(
                            res_token, chunk_sz, now_val
                        ),
                    )
                    if chunk_err_status is not None:
                        with metrics_lock:
                            metrics["requestsDenied"] += 1
                        self._send_json(chunk_err_status, {"error": chunk_err_msg})
                        return
                    ok_final_q, final_q_msg = upload_limiter.verify_streamed_quota(res_token, now_val)
                    if not ok_final_q:
                        with metrics_lock:
                            metrics["requestsDenied"] += 1
                        self._send_json(429, {"error": final_q_msg})
                        return
                    content_length = actual_len
                else:
                    assert content_length is not None
                    remaining = content_length
                    while remaining > 0:
                        chunk = self.rfile.read(min(STREAM_CHUNK_BYTES, remaining))
                        if not chunk:
                            with metrics_lock:
                                metrics["requestsDenied"] += 1
                            self._send_json(400, {"error": "Incomplete upload body (client disconnected early)."})
                            return
                        hasher.update(chunk)
                        spool.write(chunk)
                        remaining -= len(chunk)

                actual_sha = hasher.hexdigest()
                if actual_sha != norm_sha:
                    with metrics_lock:
                        metrics["requestsDenied"] += 1
                    self._send_json(400, {"error": "Uploaded body SHA-256 does not match signed X-GenoChain-Content-Sha256."})
                    return

                spool.seek(0)
                add_fn = getattr(kubo_adapter, "add_stream", None)
                pin_fn = getattr(kubo_adapter, "pin_cid", None)
                unpin_fn = getattr(kubo_adapter, "unpin_cid", None)
                if not callable(add_fn):
                    self._send_json(501, {"error": "Configured Kubo adapter does not support streaming uploads."})
                    return

                # F-03 / L3-01: Pre-compute CIDv1 via only-hash=true FIRST so rejected 403/502 uploads
                # write ZERO unpinned blocks to Kubo's blockstore (with safe fallbacks for test doubles).
                only_hash_mode = False
                staged_unpinned = False
                already_pinned = False
                try:
                    try:
                        pre_res = add_fn(
                            spool, filename, content_length, cid_version=1, pin=False, only_hash=True
                        )
                        only_hash_mode = True
                    except TypeError:
                        spool.seek(0)
                        if callable(pin_fn):
                            try:
                                pre_res = add_fn(spool, filename, content_length, cid_version=1, pin=False)
                                staged_unpinned = True
                            except TypeError:
                                spool.seek(0)
                                pre_res = add_fn(spool, filename, content_length, cid_version=1)
                                already_pinned = True
                        else:
                            pre_res = add_fn(spool, filename, content_length, cid_version=1)
                            already_pinned = True
                except Exception as exc:
                    with metrics_lock:
                        metrics["requestsDenied"] += 1
                    self._send_json(502, {"error": f"Private Kubo upload failed: {exc}"})
                    return

                def _rollback_kubo_block(cid_to_undo: str | None) -> None:
                    if not cid_to_undo:
                        return
                    if callable(unpin_fn):
                        try:
                            unpin_fn(cid_to_undo)
                        except Exception:
                            pass
                    try:
                        upload_limiter.mark_gc_pending()
                    except Exception:
                        pass

                pin_res = pre_res
                pin_mh = _try_canonical_multihash(pre_res["cid"])
                canonical_prov: str | None = None
                allowed_owners: set[str] = set()
                if pin_mh or actual_sha:
                    # F-01 + Cross-Codec SHA-256: Single-RPC on-chain provenance check (no 2nd RPC inside commit()).
                    # Transient 502 catalog RPC outages return 502 BEFORE burning upload nonce or byte quota!
                    has_catalog_getter = callable(getattr(registry_adapter, "get_all_datasets", None))
                    onchain_ok = True
                    first_info = None
                    first_sha_info = None
                    sha_revoked = False
                    try:
                        first_info, first_sha_info, sha_revoked = catalog_index.get_upload_provenance_info(
                            pin_mh, actual_sha, allow_authoritative_refresh=True
                        )
                    except Exception:
                        onchain_ok = False
                    if (
                        not onchain_ok
                        or (
                            first_info is None
                            and first_sha_info is None
                            and not sha_revoked
                            and has_catalog_getter
                            and not catalog_index.last_refresh_succeeded()
                        )
                    ):
                        if already_pinned and upload_limiter.has_persisted_provenance_or_pin(pin_mh) is False:
                            _rollback_kubo_block(pre_res["cid"])
                        elif staged_unpinned:
                            try:
                                upload_limiter.mark_gc_pending()
                            except Exception:
                                pass
                        # Preserve caller's SIWE nonce AND byte quota on transient 502 catalog outage
                        # (finally block releases reservation without committing quota).
                        with metrics_lock:
                            metrics["requestsDenied"] += 1
                        self._send_json(
                            502,
                            {"error": "Unable to verify on-chain upload provenance (catalog RPC unavailable)."},
                        )
                        return

                    # F-01 + Cross-Codec: Atomic per-multihash & per-SHA-256 claim under UploadRateLimiter._lock BEFORE Kubo write!
                    try:
                        claim_ok, claim_status, claim_err, canonical_prov, allowed_owners = (
                            upload_limiter.try_claim_upload_provenance(
                                res_token,
                                pin_mh or "",
                                recovered_addr,
                                first_info=first_info,
                                content_sha256=actual_sha,
                                first_sha_info=first_sha_info,
                                sha_revoked=sha_revoked,
                                now_ts=now_val,
                            )
                        )
                    except Exception as exc:
                        if staged_unpinned:
                            try:
                                upload_limiter.mark_gc_pending()
                            except Exception:
                                pass
                        with metrics_lock:
                            metrics["requestsDenied"] += 1
                        self._send_json(502, {"error": f"Gateway provenance claim failed: {exc}"})
                        return
                    if not claim_ok:
                        if staged_unpinned:
                            try:
                                upload_limiter.mark_gc_pending()
                            except Exception:
                                pass
                        if claim_status == 403:
                            try:
                                upload_limiter.commit(res_token, content_length, now_val, cid=None, multihash=None)
                                committed = True
                            except Exception:
                                pass
                        with metrics_lock:
                            metrics["requestsDenied"] += 1
                        self._send_json(claim_status, {"error": claim_err})
                        return

                # Consume isolated 'upload' nonce strictly AFTER eligibility, quota, SHA-256, catalog RPC
                # & provenance claim succeed (so 502 outages NEVER burn the caller's upload nonce!)
                consume_status = nonces.consume_checked(
                    recovered_addr, nonce, now_ts=now_val, namespace="upload"
                )
                if consume_status == "saturated":
                    if (
                        already_pinned
                        and upload_limiter.is_new_unshared_claim(res_token, pin_mh)
                        and upload_limiter.has_persisted_provenance_or_pin(pin_mh) is False
                    ):
                        _rollback_kubo_block(pre_res["cid"])
                    with metrics_lock:
                        metrics["requestsDenied"] += 1
                    self._send_json(429, {"error": "Upload nonce bucket saturated; retry shortly."})
                    return
                if consume_status != "ok":
                    if (
                        already_pinned
                        and upload_limiter.is_new_unshared_claim(res_token, pin_mh)
                        and upload_limiter.has_persisted_provenance_or_pin(pin_mh) is False
                    ):
                        _rollback_kubo_block(pre_res["cid"])
                    with metrics_lock:
                        metrics["requestsDenied"] += 1
                    self._send_json(401, {"error": "Nonce already used (replay rejected)."})
                    return

                # Write & pin to Kubo strictly AFTER on-chain provenance, atomic claim & nonce consumption succeed!
                wrote_or_pinned = already_pinned or staged_unpinned
                if only_hash_mode:
                    try:
                        spool.seek(0)
                        pin_res = add_fn(spool, filename, content_length, cid_version=1, pin=True)
                        wrote_or_pinned = True
                    except Exception as exc:
                        self._send_json(502, {"error": f"Private Kubo pin failed: {exc}"})
                        return
                    if pin_mh and _try_canonical_multihash(pin_res.get("cid")) != pin_mh:
                        actual_mh = _try_canonical_multihash(pin_res.get("cid"))
                        if upload_limiter.has_persisted_provenance_or_pin(actual_mh) is False:
                            _rollback_kubo_block(pin_res.get("cid"))
                        with metrics_lock:
                            metrics["requestsDenied"] += 1
                        self._send_json(502, {"error": "Kubo CID mismatch between only-hash precheck and pin."})
                        return
                elif staged_unpinned and callable(pin_fn):
                    try:
                        pin_fn(pre_res["cid"])
                    except Exception:
                        try:
                            spool.seek(0)
                            pin_res = add_fn(spool, filename, content_length, cid_version=1, pin=True)
                        except Exception as exc:
                            try:
                                if (not pin_mh) or upload_limiter.acquire_rollback_eligibility(res_token, pin_mh):
                                    if (not pin_mh) or upload_limiter.has_persisted_provenance_or_pin(pin_mh) is False:
                                        _rollback_kubo_block(pre_res["cid"])
                                else:
                                    try:
                                        upload_limiter.mark_gc_pending()
                                    except Exception:
                                        pass
                            finally:
                                upload_limiter.release_rollback_guard(res_token)
                            self._send_json(502, {"error": f"Private Kubo pin failed: {exc}"})
                            return

                # Atomic SQLite commit reusing verified on-chain provenance (0 extra RPC calls).
                # Rollback eligibility is resolved atomically inside commit()/acquire_rollback_eligibility()
                # under UploadRateLimiter._lock with per-mh rollback guard held until unpin completes,
                # and strictly fail-closed (`is False`) on has_persisted_provenance_or_pin().
                try:
                    commit_ok = upload_limiter.commit(
                        res_token,
                        content_length,
                        now_val,
                        cid=pin_res["cid"],
                        multihash=pin_mh,
                        content_sha256=actual_sha,
                        verified_onchain_provenance=(True, canonical_prov, allowed_owners),
                    )
                    committed = True
                except Exception as exc:
                    try:
                        safe_to_rollback = upload_limiter.acquire_rollback_eligibility(res_token, pin_mh)
                        if wrote_or_pinned and safe_to_rollback:
                            if (not pin_mh) or upload_limiter.has_persisted_provenance_or_pin(pin_mh) is False:
                                _rollback_kubo_block(pin_res["cid"])
                    finally:
                        upload_limiter.release_rollback_guard(res_token)
                    with metrics_lock:
                        metrics["requestsDenied"] += 1
                    self._send_json(502, {"error": f"Gateway provenance commit failed: {exc}"})
                    return

                if not commit_ok:
                    # Provenance belongs to another uploader (e.g. cross-process race): do NOT unpin their pin,
                    # simply fail closed 403 and never return 200 without tracking.
                    with metrics_lock:
                        metrics["requestsDenied"] += 1
                    self._send_json(
                        403,
                        {
                            "error": "CID multihash upload provenance conflict during commit (rejected)."
                        },
                    )
                    return
            finally:
                upload_limiter.release_rollback_guard(res_token)
                if not committed:
                    upload_limiter.release(res_token)
                try:
                    spool.close()
                except Exception:
                    pass

            with metrics_lock:
                metrics["uploadsAllowed"] += 1
            self._send_json(
                200,
                {
                    "cid": pin_res["cid"],
                    "size": int(pin_res["size"]),
                    "sha256": actual_sha,
                    "uploader": recovered_addr,
                },
            )

        def do_GET(self):
            path_only = self.path.split("?", 1)[0]
            if path_only == "/healthz":
                self._handle_healthz(send_body=True)
                return

            if path_only == "/metrics":
                self._handle_metrics(send_body=True)
                return

            prefix = "/ipfs/"
            if path_only.startswith("/v1/ipfs/"):
                prefix = "/v1/ipfs/"
            if not path_only.startswith(prefix):
                self._send_json(404, {"error": "Not found"})
                return

            raw_cid = urllib.parse.unquote(path_only[len(prefix) :])
            try:
                cid = validate_cid(raw_cid)
            except ValueError as err:
                with metrics_lock:
                    metrics["requestsDenied"] += 1
                self._send_json(400, {"error": str(err)})
                return

            raw_data_id = self.headers.get("X-GenoChain-Data-Id", "").strip()
            claimed_addr = self.headers.get("X-GenoChain-Address", "").strip()
            raw_ts = self.headers.get("X-GenoChain-Timestamp", "").strip()
            nonce = self.headers.get("X-GenoChain-Nonce", "").strip()
            sig = self.headers.get("X-GenoChain-Signature", "").strip()

            has_any_auth_header = bool(raw_data_id or claimed_addr or raw_ts or nonce or sig)
            if not has_any_auth_header and catalog_index.is_public_active_metadata_cid(cid):
                self._stream_cid_response(
                    cid,
                    content_type="application/json",
                    verified_data_id=None,
                    access_role="public_metadata",
                )
                return

            if (
                not (raw_data_id.isascii() and raw_data_id.isdigit() and len(raw_data_id) <= MAX_DATA_ID_DIGITS)
                or not (raw_ts.isascii() and raw_ts.isdigit() and len(raw_ts) <= MAX_TS_DIGITS)
            ):
                with metrics_lock:
                    metrics["requestsDenied"] += 1
                self._send_json(401, {"error": "Missing or non-numeric X-GenoChain-Data-Id / X-GenoChain-Timestamp."})
                return

            data_id = int(raw_data_id)
            if data_id <= 0 or data_id > MAX_UINT256:
                with metrics_lock:
                    metrics["requestsDenied"] += 1
                self._send_json(401, {"error": "Invalid X-GenoChain-Data-Id (must be positive uint256)."})
                return

            now_val = int(clock())
            # 1. Verify cryptographic SIWE signature & check replay WITHOUT consuming nonce yet
            ok_sig, sig_reason, recovered_addr = verify_siwe_request(
                chain_id=chain_id,
                registry_address=registry_address,
                data_id=data_id,
                cid=cid,
                claimed_address=claimed_addr,
                timestamp=int(raw_ts),
                nonce=nonce,
                signature=sig,
                nonce_store=nonces,
                now_ts=now_val,
                consume_nonce=False,
            )
            if not ok_sig or not recovered_addr:
                with metrics_lock:
                    metrics["requestsDenied"] += 1
                self._send_json(401, {"error": sig_reason})
                return

            # 2. Enforce on-chain dataset Active status, canonical multihash membership, Upload Provenance / First-Claimant Ownership, and owner/license BEFORE touching NonceStore
            allowed, status_code, auth_reason = authorize_cid_access(
                registry_adapter,
                data_id,
                cid,
                recovered_addr,
                catalog_index=catalog_index,
                provenance_lookup=upload_limiter.get_upload_provenance,
            )
            if not allowed:
                with metrics_lock:
                    metrics["requestsDenied"] += 1
                self._send_json(status_code, {"error": auth_reason})
                return

            # 3. Atomically record 'download' nonce ONLY for verified + authorized requests (fail-closed 429 on saturation)
            dl_consume_status = nonces.consume_checked(recovered_addr, nonce, now_ts=now_val, namespace="download")
            if dl_consume_status == "saturated":
                with metrics_lock:
                    metrics["requestsDenied"] += 1
                self._send_json(429, {"error": "Download nonce bucket saturated; retry shortly."})
                return
            if dl_consume_status != "ok":
                with metrics_lock:
                    metrics["requestsDenied"] += 1
                self._send_json(401, {"error": "Nonce already used (replay rejected)."})
                return

            self._stream_cid_response(
                cid,
                content_type="application/octet-stream",
                verified_data_id=data_id,
                access_role=auth_reason,
            )

    server = BoundedThreadingHTTPServer((host, int(port)), _GatewayHandler, max_workers=max_workers)
    server._owns_nonce_store = owns_nonce_store  # type: ignore[attr-defined]
    server.gateway_metrics = metrics  # type: ignore[attr-defined]
    server.gateway_metrics_lock = metrics_lock  # type: ignore[attr-defined]
    server.gateway_catalog_index = catalog_index  # type: ignore[attr-defined]
    server.gateway_nonce_store = nonces  # type: ignore[attr-defined]
    server.gateway_upload_limiter = upload_limiter  # type: ignore[attr-defined]
    return server


def main():
    import argparse

    parser = argparse.ArgumentParser(description="GenoChain Private IPFS Access-Control & GDPR Gateway")
    parser.add_argument("--host", default=os.getenv("GATEWAY_BIND_HOST", "127.0.0.1"))
    parser.add_argument("--port", type=int, default=int(os.getenv("GATEWAY_PORT", "8090")))
    parser.add_argument("--rpc-url", default=os.getenv("RPC_URL", "http://127.0.0.1:8545"))
    parser.add_argument("--kubo-rpc", default=os.getenv("KUBO_RPC_URL", "http://127.0.0.1:5001"))
    # Fail-closed CORS default: empty string never emits wildcard Access-Control-Allow-Origin: *
    parser.add_argument("--cors-origin", default=os.getenv("CORS_ALLOWED_ORIGIN", ""))
    parser.add_argument("--gdpr-poll-sec", type=float, default=float(os.getenv("GDPR_POLL_SEC", "30")))
    parser.add_argument("--gc-timeout", type=float, default=float(os.getenv("KUBO_GC_TIMEOUT_SEC", "180")))
    parser.add_argument(
        "--state-db",
        default=os.getenv("GATEWAY_STATE_DB", os.path.join(".local", "gateway_state.sqlite")),
        help="Path to persistent SQLite state database for SIWE nonces, upload quotas & GDPR reconciler (default: .local/gateway_state.sqlite)",
    )
    parser.add_argument(
        "--max-workers",
        type=int,
        default=int(os.getenv("GATEWAY_MAX_WORKERS", str(DEFAULT_MAX_WORKERS))),
        help=f"Maximum concurrent HTTP worker threads (default: {DEFAULT_MAX_WORKERS})",
    )
    parser.add_argument(
        "--max-uploads-per-hour",
        type=int,
        default=int(os.getenv("GATEWAY_MAX_UPLOADS_PER_HOUR", str(DEFAULT_MAX_UPLOADS_PER_HOUR))),
        help=f"Per-signer hourly upload count cap (default: {DEFAULT_MAX_UPLOADS_PER_HOUR})",
    )
    parser.add_argument(
        "--max-upload-bytes-per-hour",
        type=int,
        default=int(os.getenv("GATEWAY_MAX_UPLOAD_BYTES_PER_HOUR", str(DEFAULT_MAX_UPLOAD_BYTES_PER_HOUR))),
        help=f"Per-signer hourly upload byte cap (default: {DEFAULT_MAX_UPLOAD_BYTES_PER_HOUR})",
    )
    parser.add_argument(
        "--max-global-upload-bytes-per-hour",
        type=int,
        default=int(os.getenv("GATEWAY_MAX_GLOBAL_UPLOAD_BYTES_PER_HOUR", str(DEFAULT_MAX_GLOBAL_UPLOAD_BYTES_PER_HOUR))),
        help=f"Global hourly upload byte budget across all signers (default: {DEFAULT_MAX_GLOBAL_UPLOAD_BYTES_PER_HOUR})",
    )
    parser.add_argument(
        "--max-total-pinned-bytes",
        type=int,
        default=int(os.getenv("GATEWAY_MAX_TOTAL_PINNED_BYTES", str(DEFAULT_MAX_TOTAL_PINNED_BYTES))),
        help=f"Global pinned storage byte cap for tracked uploads (default: {DEFAULT_MAX_TOTAL_PINNED_BYTES})",
    )
    parser.add_argument(
        "--upload-policy",
        choices=VALID_UPLOAD_POLICIES,
        default=os.getenv("GATEWAY_UPLOAD_POLICY", DEFAULT_UPLOAD_POLICY),
        help="Upload eligibility policy: onchain-eligible (default), allowlist, or open-dev",
    )
    parser.add_argument(
        "--upload-allowlist",
        default=os.getenv("GATEWAY_UPLOAD_ALLOWLIST", ""),
        help="Optional comma-separated EVM addresses explicitly permitted to upload",
    )
    parser.add_argument(
        "--min-upload-wei",
        type=int,
        default=int(os.getenv("GATEWAY_MIN_UPLOAD_WEI", str(DEFAULT_MIN_UPLOAD_WEI))),
        help=f"Minimum native gas balance (wei) for onchain-eligible uploaders (default: {DEFAULT_MIN_UPLOAD_WEI})",
    )
    parser.add_argument(
        "--min-upload-geno",
        type=int,
        default=int(os.getenv("GATEWAY_MIN_UPLOAD_GENO", str(DEFAULT_MIN_UPLOAD_GENO))),
        help=f"Minimum $GENO balance (wei) for onchain-eligible uploaders (default: {DEFAULT_MIN_UPLOAD_GENO})",
    )
    parser.add_argument(
        "--orphan-pin-ttl-sec",
        type=int,
        default=int(os.getenv("GATEWAY_ORPHAN_PIN_TTL_SEC", str(DEFAULT_ORPHAN_PIN_TTL_SEC))),
        help=f"TTL (seconds) before unanchored uploaded CIDs are automatically unpinned and GC'd (default: {DEFAULT_ORPHAN_PIN_TTL_SEC})",
    )
    parser.add_argument(
        "--registry-address",
        default=os.getenv("REGISTRY_ADDRESS", ""),
        help="Optional runtime override for GenomicsRegistry address (defaults to contractAddresses.json)",
    )
    parser.add_argument(
        "--deployed-block",
        default=os.getenv("DEPLOYED_BLOCK", ""),
        help="Optional runtime override for GenomicsRegistry deployedBlock (defaults to contractAddresses.json)",
    )
    args = parser.parse_args()

    base_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    contracts_dir = os.path.join(base_dir, "frontend", "src", "contracts")
    addr_file = os.path.join(contracts_dir, "contractAddresses.json")
    abi_file = os.path.join(contracts_dir, "GenomicsRegistryABI.json")

    with open(addr_file, "r", encoding="utf-8") as f:
        addresses = json.load(f)
    with open(abi_file, "r", encoding="utf-8") as f:
        registry_abi = json.load(f)

    w3 = Web3(Web3.HTTPProvider(args.rpc_url))
    if not w3.is_connected():
        print(f"[!] Cannot connect to EVM RPC at {args.rpc_url}")
        sys.exit(1)

    chain_id = int(w3.eth.chain_id)
    raw_reg_override = str(args.registry_address or "").strip()
    if raw_reg_override:
        if not Web3.is_address(raw_reg_override):
            print(f"[!] Invalid --registry-address / REGISTRY_ADDRESS: {raw_reg_override}")
            sys.exit(1)
        registry_address = Web3.to_checksum_address(raw_reg_override)
    else:
        registry_address = addresses["GenomicsRegistry"]
    raw_dep_override = str(args.deployed_block or "").strip()
    start_block = max(
        0,
        int(raw_dep_override) if raw_dep_override.isdigit() else int(addresses.get("deployedBlock", 0) or 0),
    )
    reg_adapter = Web3RegistryAdapter(w3, registry_address, registry_abi)
    kubo_adapter = KuboHttpAdapter(args.kubo_rpc, gc_timeout_sec=args.gc_timeout)

    state_db_path = args.state_db
    spool_dir = prepare_upload_spool_dir(state_db_path)
    nonce_store = NonceStore(db_path=state_db_path)
    server = create_gateway_server(
        host=args.host,
        port=args.port,
        chain_id=chain_id,
        registry_address=registry_address,
        registry_adapter=reg_adapter,
        kubo_adapter=kubo_adapter,
        nonce_store=nonce_store,
        cors_origin=args.cors_origin,
        max_workers=args.max_workers,
        spool_dir=spool_dir,
        state_db_path=state_db_path,
        max_uploads_per_hour=args.max_uploads_per_hour,
        max_upload_bytes_per_hour=args.max_upload_bytes_per_hour,
        max_global_upload_bytes_per_hour=args.max_global_upload_bytes_per_hour,
        max_total_pinned_bytes=args.max_total_pinned_bytes,
        upload_policy=args.upload_policy,
        upload_allowlist=args.upload_allowlist,
        min_upload_wei=args.min_upload_wei,
        min_upload_geno=args.min_upload_geno,
    )
    # REV-01 startup backfill: seed upload_provenance from already-anchored on-chain datasets
    try:
        server.gateway_catalog_index.refresh_now()
    except Exception:
        pass
    reconciler = GdprErasureReconciler(
        reg_adapter,
        kubo_adapter,
        start_block=start_block,
        db_path=state_db_path,
        orphan_pin_ttl_sec=args.orphan_pin_ttl_sec,
        catalog_index=server.gateway_catalog_index,
    )
    stop_event = threading.Event()
    shutdown_requested = False

    def _gdpr_loop():
        while not stop_event.is_set():
            try:
                rpc_ok = bool(reg_adapter.is_connected())
                kubo_ok = bool(kubo_adapter.health_check())
                res = reconciler.reconcile_once()
                if res.get("revokedProcessed") or res.get("statusEventsCount"):
                    server.gateway_catalog_index.invalidate()
                if res.get("unpinnedCids") or res.get("orphanUnpinnedCids") or res.get("gcRan"):
                    server.gateway_upload_limiter.invalidate_repo_stat_cache()
                with server.gateway_metrics_lock:
                    server.gateway_metrics["rpcConnected"] = rpc_ok
                    server.gateway_metrics["kuboConnected"] = kubo_ok
                    server.gateway_metrics["gdprErasuresTotal"] = reconciler.erasures_total
                    server.gateway_metrics["gdprUnpinnedCidsTotal"] = reconciler.unpinned_cids_total
                    server.gateway_metrics["lastErasureBlock"] = res["scannedToBlock"]
            except Exception as exc:
                with server.gateway_metrics_lock:
                    server.gateway_metrics["rpcConnected"] = bool(reg_adapter.is_connected())
                    server.gateway_metrics["kuboConnected"] = bool(kubo_adapter.health_check())
                print(f"[WARN] GDPR erasure reconciler error: {exc}")
            stop_event.wait(max(5.0, float(args.gdpr_poll_sec)))

    gdpr_thread = threading.Thread(target=_gdpr_loop, daemon=True)
    gdpr_thread.start()

    # Strictly async-signal-safe shutdown: signal handler ONLY flips a flag; watcher thread calls server.shutdown()
    def _handle_shutdown(_signum, _frame):
        nonlocal shutdown_requested
        shutdown_requested = True

    def _shutdown_watcher():
        while not stop_event.is_set():
            if shutdown_requested:
                stop_event.set()
                server.shutdown()
                return
            time.sleep(0.05)

    watcher_thread = threading.Thread(target=_shutdown_watcher, daemon=True)
    watcher_thread.start()

    for sig_name in ("SIGTERM", "SIGINT"):
        sig_val = getattr(signal, sig_name, None)
        if sig_val is not None:
            try:
                signal.signal(sig_val, _handle_shutdown)
            except (ValueError, OSError, AttributeError):
                pass

    print(
        f"[OK] GenoChain Private IPFS Gateway listening on http://{args.host}:{args.port} "
        f"(chainId={chain_id}, registry={registry_address}, kubo={args.kubo_rpc}, stateDb={state_db_path}, uploadPolicy={args.upload_policy})"
    )
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[*] Shutting down GenoChain Private IPFS Gateway...")
    finally:
        stop_event.set()
        server.shutdown()
        server.server_close()
        reconciler.close()
        server.gateway_upload_limiter.close()
        nonce_store.close()


if __name__ == "__main__":
    main()