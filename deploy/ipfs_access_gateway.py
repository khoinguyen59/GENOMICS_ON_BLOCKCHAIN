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
     bounded payload (<= 500 MiB) in 64 KiB chunks while verifying SHA-256,
     and pins directly to private Kubo /api/v0/add?pin=true&cid-version=1.
4. Persistent SQLite Replay & GDPR State (--state-db, WAL mode):
   - DEFAULT_NONCE_TTL_SEC = 2 * MAX_AUTH_SKEW_SEC + 60 (660s) with strict '<'
     expiry comparison (eliminating 1-second boundary replays).
   - Verifies cryptographic signature AND on-chain authorization BEFORE recording
     a nonce in NonceStore (eliminating pre-auth eviction DoS).
   - Ref-counted GDPR Art. 17 erasure reconciler with 5-block reorg lookback on
     every monotonic cycle: never unpins a CID still referenced by another
     non-revoked (Active/Paused) dataset.
5. True 64 KiB Chunked Streaming (up to 500 MiB) & Bounded Thread Concurrency:
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
MAX_STREAM_BYTES = 524_288_000  # 500 MiB (matches crypto/core/streaming.js ceiling)
MAX_UPLOAD_BYTES = 524_288_000  # 500 MiB bounded streaming upload cap
STREAM_CHUNK_BYTES = 65_536     # 64 KiB streaming chunk size
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
    uploads (up to 500 MiB) never spill into RAM-backed /tmp tmpfs and trigger container OOM kills.
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
    ):
        self._max_uploads = max(1, int(max_uploads_per_hour))
        self._max_bytes = max(1024, int(max_bytes_per_hour))
        self._max_global_bytes = max(1024, int(max_global_bytes_per_hour))
        self._max_total_pinned = max(1024, int(max_total_pinned_bytes))
        self._window = max(60, int(window_sec))
        self._max_addrs = max(100, int(max_tracked_addresses))
        self._db_path = str(db_path or ":memory:")
        self._kubo_adapter = kubo_adapter
        self._repo_stat_bytes_cache: int | None = None
        self._repo_stat_mono: float = 0.0
        self._lock = threading.Lock()
        self._conn = _open_sqlite_db(self._db_path)
        self._inflight: dict[str, dict] = {}
        self._res_seq = 0
        with self._lock, _sqlite_write_tx(self._conn):
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
                    uploaded_at INTEGER NOT NULL
                )
                """
            )
            self._conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_pending_uploads_at ON pending_uploads(uploaded_at)"
            )
            self._conn.execute(
                """
                CREATE TABLE IF NOT EXISTS tracked_pins (
                    cid TEXT PRIMARY KEY,
                    multihash TEXT NOT NULL,
                    size_bytes INTEGER NOT NULL,
                    pinned_at INTEGER NOT NULL
                )
                """
            )
            self._conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_tracked_pins_mh ON tracked_pins(multihash)"
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
            token = f"res_{self._res_seq}"
            self._inflight[token] = {"address": addr_key, "bytes": est}
            return True, "ok", token

    def add_streamed_bytes(self, token: str, delta_bytes: int, now_ts: int) -> tuple[bool, str]:
        """Atomically expand an in-flight chunked upload reservation before spooling the next chunk."""
        delta = max(0, int(delta_bytes))
        if delta == 0:
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
            return True, "ok"

    def commit(
        self,
        token: str,
        actual_bytes: int,
        now_ts: int,
        *,
        cid: str | None = None,
        multihash: str | None = None,
    ) -> None:
        """Finalize an in-flight reservation into persistent SQLite quota history, tracked_pins & pending_uploads."""
        now = int(now_ts)
        actual = max(0, int(actual_bytes))
        cutoff = now - self._window
        with self._lock:
            info = self._inflight.get(token)
            addr_key = info["address"] if info is not None else "unknown"
            with _sqlite_write_tx(self._conn):
                self._prune_locked(cutoff)
                self._conn.execute(
                    "INSERT INTO upload_quota_events(address, size_bytes, ts) VALUES(?, ?, ?)",
                    (addr_key, actual, now),
                )
                if cid:
                    mh = multihash or _try_canonical_multihash(cid) or ""
                    self._conn.execute(
                        """
                        INSERT INTO pending_uploads(cid, multihash, uploader, size_bytes, uploaded_at)
                        VALUES(?, ?, ?, ?, ?)
                        ON CONFLICT(cid) DO UPDATE SET
                            multihash = excluded.multihash,
                            size_bytes = excluded.size_bytes,
                            uploaded_at = excluded.uploaded_at
                        """,
                        (cid, mh, addr_key, actual, now),
                    )
                    self._conn.execute(
                        """
                        INSERT INTO tracked_pins(cid, multihash, size_bytes, pinned_at)
                        VALUES(?, ?, ?, ?)
                        ON CONFLICT(cid) DO UPDATE SET
                            multihash = excluded.multihash,
                            size_bytes = excluded.size_bytes,
                            pinned_at = excluded.pinned_at
                        """,
                        (cid, mh, actual, now),
                    )
            self._inflight.pop(token, None)
            self._repo_stat_mono = 0.0

    def release(self, token: str | None) -> None:
        """Release an uncommitted in-flight reservation on error or abort."""
        if not token:
            return
        with self._lock:
            self._inflight.pop(token, None)

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

    def record_pending_upload(self, cid: str, uploader: str, size_bytes: int, uploaded_at: int) -> None:
        mh = _try_canonical_multihash(cid) or ""
        sz = max(0, int(size_bytes))
        ts = int(uploaded_at)
        with self._lock, _sqlite_write_tx(self._conn):
            self._conn.execute(
                """
                INSERT INTO pending_uploads(cid, multihash, uploader, size_bytes, uploaded_at)
                VALUES(?, ?, ?, ?, ?)
                ON CONFLICT(cid) DO UPDATE SET
                    multihash = excluded.multihash,
                    size_bytes = excluded.size_bytes,
                    uploaded_at = excluded.uploaded_at
                """,
                (cid, mh, str(uploader).lower(), sz, ts),
            )
            self._conn.execute(
                """
                INSERT INTO tracked_pins(cid, multihash, size_bytes, pinned_at)
                VALUES(?, ?, ?, ?)
                ON CONFLICT(cid) DO UPDATE SET
                    multihash = excluded.multihash,
                    size_bytes = excluded.size_bytes,
                    pinned_at = excluded.pinned_at
                """,
                (cid, mh, sz, ts),
            )

    def list_pending_uploads(self) -> list[dict]:
        with self._lock:
            rows = self._conn.execute(
                "SELECT cid, multihash, uploader, size_bytes, uploaded_at FROM pending_uploads ORDER BY uploaded_at ASC"
            ).fetchall()
        return [
            {
                "cid": str(r[0]),
                "multihash": str(r[1]),
                "uploader": str(r[2]),
                "sizeBytes": int(r[3]),
                "uploadedAt": int(r[4]),
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
    Saturated 'upload' buckets fail closed with 'saturated' (HTTP 429) instead of evicting.
    """

    def __init__(
        self,
        ttl_sec: int = DEFAULT_NONCE_TTL_SEC,
        max_entries: int = 100000,
        db_path: str = ":memory:",
        upload_max_entries: int | None = None,
    ):
        self._ttl = max(60, int(ttl_sec))
        self._max_entries = max(100, int(max_entries))
        self._upload_max_entries = (
            max(1, int(upload_max_entries))
            if upload_max_entries is not None
            else max(100, self._max_entries // 2)
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
        Returns 'ok', 'replay', or 'saturated' (upload bucket full without evicting unexpired entries).
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
            if ns == "upload":
                if ns_count >= self._upload_max_entries:
                    return "saturated"
            elif ns_count >= self._max_entries:
                evict_n = max(1, self._max_entries // 10)
                self._conn.execute(
                    """
                    DELETE FROM nonces
                    WHERE key IN (
                        SELECT key FROM nonces WHERE namespace = ? ORDER BY expires_at ASC LIMIT ?
                    )
                    """,
                    (ns, evict_n),
                )
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
        if not nonce_store.consume(recovered, nonce, now_ts=now, namespace="download"):
            return False, "Nonce already used (replay rejected).", None
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

    def is_connected(self) -> bool:
        try:
            return bool(self.w3.is_connected())
        except Exception:
            return False

    def get_block_number(self) -> int:
        return int(self.w3.eth.block_number)

    def get_genomic_data(self, data_id: int) -> dict:
        raw = self.registry.functions.getGenomicData(int(data_id)).call()
        return _unpack_genomic_data_tuple(raw)

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
                    items.append(_unpack_genomic_data_tuple(raw))
                offset += len(page_items)
            return items
        if hasattr(self.registry.functions, "getAllDataItems"):
            for raw in self.registry.functions.getAllDataItems().call():
                items.append(_unpack_genomic_data_tuple(raw))
        return items

    def has_active_access(self, data_id: int, buyer: str) -> bool:
        return bool(self.registry.functions.hasActiveAccess(int(data_id), Web3.to_checksum_address(buyer)).call())

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
    ):
        self._registry = registry_adapter
        self._refresh_ttl = max(1.0, float(refresh_ttl_sec))
        self._min_forced_refresh = max(0.25, float(min_forced_refresh_sec))
        self._lock = threading.Lock()
        self._public_metadata_mhs: set[str] = set()
        self._private_mhs: set[str] = set()
        self._first_registrant_by_mh: dict[str, tuple[int, str]] = {}
        self._known_owners: set[str] = set()
        self._last_refresh_mono: float = 0.0
        self._last_forced_refresh_mono: float = 0.0
        self._last_failed_refresh_mono: float = 0.0
        self._refresh_in_progress: bool = False
        self._refresh_event: threading.Event = threading.Event()
        self._refresh_event.set()
        self.rpc_refresh_count: int = 0

    def _run_refresh_if_needed(
        self,
        *,
        force_unseen: bool = False,
        force_authoritative: bool = False,
    ) -> None:
        getter = getattr(self._registry, "get_all_datasets", None)
        if not callable(getter):
            with self._lock:
                self._public_metadata_mhs = set()
                self._private_mhs = set()
                self._first_registrant_by_mh = {}
                self._known_owners = set()
                self._last_refresh_mono = time.monotonic()
            return

        while True:
            now_mono = time.monotonic()
            with self._lock:
                in_failure_backoff = (
                    not force_authoritative
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

        # Execute RPC scan strictly OUTSIDE self._lock so cached readers & workers are never blocked
        datasets = None
        rpc_ok = False
        try:
            datasets = getter() or []
            rpc_ok = True
        except Exception:
            rpc_ok = False
        finally:
            finish_mono = time.monotonic()
            with self._lock:
                self.rpc_refresh_count += 1
                if rpc_ok and datasets is not None:
                    sorted_ds = sorted(
                        [ds for ds in datasets if isinstance(ds, dict)],
                        key=lambda d: int(d.get("dataId", 0)),
                    )
                    private_mhs: set[str] = set()
                    active_meta_mhs: set[str] = set()
                    first_reg: dict[str, tuple[int, str]] = {}
                    known_owners: set[str] = set()
                    for ds in sorted_ds:
                        d_id = int(ds.get("dataId", 0))
                        owner_l = str(ds.get("currentOwner") or "").strip().lower()
                        if owner_l:
                            known_owners.add(owner_l)
                        raw_mh = _try_canonical_multihash(ds.get("rawCid"))
                        sum_mh = _try_canonical_multihash(ds.get("summaryCid"))
                        meta_mh = _try_canonical_multihash(ds.get("metadataCid"))
                        if raw_mh:
                            private_mhs.add(raw_mh)
                            if raw_mh not in first_reg:
                                first_reg[raw_mh] = (d_id, owner_l)
                        if sum_mh:
                            private_mhs.add(sum_mh)
                            if sum_mh not in first_reg:
                                first_reg[sum_mh] = (d_id, owner_l)
                        if meta_mh:
                            if meta_mh not in first_reg:
                                first_reg[meta_mh] = (d_id, owner_l)
                            if int(ds.get("status", -1)) == 0:
                                active_meta_mhs.add(meta_mh)
                    self._private_mhs = private_mhs
                    self._public_metadata_mhs = active_meta_mhs - private_mhs
                    self._first_registrant_by_mh = first_reg
                    self._known_owners = known_owners
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
        self._run_refresh_if_needed(force_unseen=False)
        with self._lock:
            entry = self._first_registrant_by_mh.get(multihash)
        if entry is None:
            if allow_authoritative_refresh:
                self._run_refresh_if_needed(force_authoritative=True)
            else:
                self._run_refresh_if_needed(force_unseen=True)
            with self._lock:
                entry = self._first_registrant_by_mh.get(multihash)
        return entry

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
        timeout_sec: float = 300.0,
    ) -> dict:
        """
        Stream-upload a bounded file object to private Kubo /api/v0/add?pin=true&cid-version=1
        in 64 KiB chunks (never buffering the entire file in RAM).
        """
        safe_name = sanitize_upload_filename(filename)
        if content_length < 0 or content_length > MAX_UPLOAD_BYTES:
            raise ValueError(f"Upload size {content_length} exceeds MAX_UPLOAD_BYTES ({MAX_UPLOAD_BYTES}).")
        parsed = urllib.parse.urlparse(self.rpc_url)
        if parsed.scheme not in ("http", "https") or not parsed.hostname:
            raise ValueError(f"Invalid Kubo RPC URL: {self.rpc_url}")

        boundary = f"----GenoChainBoundary{int(time.time() * 1000000)}"
        prefix = (
            f"--{boundary}\r\n"
            f'Content-Disposition: form-data; name="file"; filename="{safe_name}"\r\n'
            f"Content-Type: application/octet-stream\r\n\r\n"
        ).encode("utf-8")
        suffix = f"\r\n--{boundary}--\r\n".encode("utf-8")
        total_body_len = len(prefix) + int(content_length) + len(suffix)

        base_path = parsed.path.rstrip("/")
        q = urllib.parse.urlencode({"pin": "true", "cid-version": str(int(cid_version))})
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
        """List all recursively pinned CIDs on private Kubo so multihash aliases can be unpinned together."""
        try:
            raw = self._post("/api/v0/pin/ls?type=recursive", timeout_sec=min(self.timeout_sec, 15.0))
            payload = json.loads(raw.decode("utf-8", errors="replace")) if raw else {}
            keys = payload.get("Keys")
            if isinstance(keys, dict):
                return [str(k) for k in keys.keys()]
        except Exception:
            pass
        return []

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


def authorize_cid_access(
    registry_adapter,
    data_id: int,
    cid: str,
    signer_address: str,
    catalog_index: PublicMetadataCatalogIndex | None = None,
) -> tuple[bool, int, str]:
    """
    Enforce on-chain authorization for (dataId, cid, signer_address) with canonical multihash
    matching and First-Claimant Ownership protection against cross-owner CID aliasing/spoofing.
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

    # First-Claimant Ownership Rule: block owner-spoof CID reuse even across CIDv0 <-> CIDv1 aliases.
    # Because SIWE signature + live get_genomic_data(data_id) ALREADY succeeded, an authoritative
    # catalog refresh bypasses unauthenticated cooldowns AND fails closed (502) if unverifiable on dataId > 1.
    has_catalog_getter = callable(getattr(registry_adapter, "get_all_datasets", None))
    first_claim = None
    catalog_lookup_failed = False
    if catalog_index is not None:
        first_claim = catalog_index.get_first_registrant(req_mh, allow_authoritative_refresh=True)
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
                    first_claim = (int(ds.get("dataId", 0)), str(ds.get("currentOwner") or "").strip().lower())
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
        earliest_id, earliest_owner = first_claim
        if int(data_id) != earliest_id and earliest_owner and owner != earliest_owner:
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
    ):
        self.registry_adapter = registry_adapter
        self.kubo_adapter = kubo_adapter
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
                        uploaded_at INTEGER NOT NULL
                    )
                    """
                )
                self._conn.execute(
                    """
                    CREATE TABLE IF NOT EXISTS tracked_pins (
                        cid TEXT PRIMARY KEY,
                        multihash TEXT NOT NULL,
                        size_bytes INTEGER NOT NULL,
                        pinned_at INTEGER NOT NULL
                    )
                    """
                )
            meta = dict(self._conn.execute("SELECT k, v FROM gdpr_meta").fetchall())
            if "last_block" in meta:
                self.last_block = max(self.deployed_block, int(meta["last_block"]))
            if "gc_pending" in meta:
                self._gc_pending = meta["gc_pending"] == "1"
            if "erasures_total" in meta:
                self.erasures_total = int(meta["erasures_total"])
            if "unpinned_cids_total" in meta:
                self.unpinned_cids_total = int(meta["unpinned_cids_total"])
            if "orphan_unpinned_total" in meta:
                self.orphan_unpinned_total = int(meta["orphan_unpinned_total"])
            rows = self._conn.execute("SELECT data_id FROM gdpr_erased_datasets").fetchall()
            self.erased_data_ids = {int(r[0]) for r in rows}

    def _persist_state(self, newly_erased_id: int | None = None) -> None:
        with self._lock, _sqlite_write_tx(self._conn):
            if newly_erased_id is not None:
                self._conn.execute(
                    "INSERT OR IGNORE INTO gdpr_erased_datasets(data_id, erased_at) VALUES(?, ?)",
                    (int(newly_erased_id), int(self._now_fn())),
                )
            pairs = [
                ("last_block", str(int(self.last_block))),
                ("gc_pending", "1" if self._gc_pending else "0"),
                ("erasures_total", str(int(self.erasures_total))),
                ("unpinned_cids_total", str(int(self.unpinned_cids_total))),
                ("orphan_unpinned_total", str(int(self.orphan_unpinned_total))),
            ]
            self._conn.executemany(
                "INSERT INTO gdpr_meta(k, v) VALUES(?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v",
                pairs,
            )

    def _remove_tracked_pins(self, cids: list[str], multihashes: set[str] | None = None) -> None:
        if not cids and not multihashes:
            return
        with self._lock, _sqlite_write_tx(self._conn):
            if cids:
                self._conn.executemany("DELETE FROM tracked_pins WHERE cid = ?", [(c,) for c in cids])
            if multihashes:
                self._conn.executemany("DELETE FROM tracked_pins WHERE multihash = ?", [(m,) for m in multihashes])

    def _collect_owner_scoped_referenced_mhs(
        self,
        excluding_data_id: int,
        revoked_owner_lower: str,
    ) -> set[str]:
        """
        Collect canonical multihashes referenced by other non-revoked (status != 2) datasets
        scoped to the SAME dataset owner (or an earlier dataId). A third-party attacker minting
        a later dummy dataset referencing a victim's CID can NEVER pin-lock the victim's GDPR erasure.
        """
        getter = getattr(self.registry_adapter, "get_all_datasets", None)
        if not callable(getter):
            return set()
        datasets = getter() or []
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
            is_same_owner = other_owner == revoked_owner_lower
            is_earlier_dataset = ds_id > 0 and ds_id < excluding_data_id
            if not (is_same_owner or is_earlier_dataset):
                continue
            for field in ("rawCid", "summaryCid", "metadataCid"):
                mh = _try_canonical_multihash(ds.get(field))
                if mh:
                    referenced_mhs.add(mh)
        return referenced_mhs

    def _collect_all_onchain_mhs(self) -> set[str]:
        getter = getattr(self.registry_adapter, "get_all_datasets", None)
        if not callable(getter):
            return set()
        datasets = getter() or []
        anchored: set[str] = set()
        for ds in datasets:
            if not isinstance(ds, dict):
                continue
            for field in ("rawCid", "summaryCid", "metadataCid"):
                mh = _try_canonical_multihash(ds.get(field))
                if mh:
                    anchored.add(mh)
        return anchored

    def reconcile_orphan_uploads(self, now_ts: int | None = None) -> list[str]:
        """Unpin expired pending_uploads not anchored on-chain within orphan_pin_ttl_sec."""
        if self._orphan_ttl <= 0:
            return []
        if not callable(getattr(self.registry_adapter, "get_all_datasets", None)):
            return []
        now = int(self._now_fn() if now_ts is None else now_ts)
        cutoff = now - self._orphan_ttl
        with self._lock:
            rows = self._conn.execute(
                "SELECT cid, multihash, uploaded_at FROM pending_uploads ORDER BY uploaded_at ASC"
            ).fetchall()
        if not rows:
            return []
        anchored_mhs = self._collect_all_onchain_mhs()
        done_pending_cids: list[str] = []
        orphan_unpinned: list[str] = []
        removed_pin_cids: list[str] = []
        for cid, mh, uploaded_at in rows:
            cid_s = str(cid)
            mh_s = str(mh) or (_try_canonical_multihash(cid_s) or "")
            if mh_s and mh_s in anchored_mhs:
                # Anchored on-chain: remove from orphan-GC queue, KEEP in tracked_pins for pinned storage cap!
                done_pending_cids.append(cid_s)
                continue
            if int(uploaded_at) <= cutoff:
                try:
                    validate_cid(cid_s)
                    if self.kubo_adapter.unpin_cid(cid_s):
                        orphan_unpinned.append(cid_s)
                        self.orphan_unpinned_total += 1
                        self._gc_pending = True
                    else:
                        self._gc_pending = True
                    done_pending_cids.append(cid_s)
                    removed_pin_cids.append(cid_s)
                except Exception:
                    continue
        if done_pending_cids or removed_pin_cids:
            with self._lock, _sqlite_write_tx(self._conn):
                if done_pending_cids:
                    self._conn.executemany(
                        "DELETE FROM pending_uploads WHERE cid = ?",
                        [(c,) for c in done_pending_cids],
                    )
                if removed_pin_cids:
                    self._conn.executemany(
                        "DELETE FROM tracked_pins WHERE cid = ?",
                        [(c,) for c in removed_pin_cids],
                    )
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
        list_pins_fn = getattr(self.kubo_adapter, "list_recursive_pins", None)
        for data_id in revoked_ids:
            if data_id in self.erased_data_ids:
                continue
            item = self.registry_adapter.get_genomic_data(data_id)
            if int(item.get("status", -1)) != 2:
                continue
            revoked_owner_l = str(item.get("currentOwner") or "").strip().lower()
            cids = []
            for field in ("rawCid", "summaryCid", "metadataCid"):
                c = str(item.get(field) or "").strip()
                if c and c not in cids:
                    cids.append(c)
            shared_mhs = self._collect_owner_scoped_referenced_mhs(data_id, revoked_owner_l)
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
                target_mhs.add(mh)
                if c not in cids_to_unpin:
                    cids_to_unpin.append(c)

            # Also unpin ANY pinned CIDv0/CIDv1 alias in Kubo sharing the exact canonical multihash
            if target_mhs and callable(list_pins_fn):
                try:
                    for pinned_c in list_pins_fn() or []:
                        p_mh = _try_canonical_multihash(pinned_c)
                        if p_mh and p_mh in target_mhs and pinned_c not in cids_to_unpin:
                            cids_to_unpin.append(pinned_c)
                except Exception:
                    pass

            valid_unshared_cids = len(cids_to_unpin)
            for c in cids_to_unpin:
                if self.kubo_adapter.unpin_cid(c):
                    unpinned_now.append(c)
                    self.unpinned_cids_total += 1
                    self._gc_pending = True
            if cids_to_unpin or target_mhs:
                self._remove_tracked_pins(cids_to_unpin, target_mhs)
            if valid_unshared_cids > 0:
                # Guarantee at least one repo/gc pass even if CIDs were already unpinned before a restart/crash
                self._gc_pending = True
            self.erased_data_ids.add(data_id)
            self.erasures_total += 1
            # Persist erased dataset & gc_pending BEFORE run_gc() so crashes preserve retry state
            self._persist_state(newly_erased_id=data_id)

        orphan_unpinned = self.reconcile_orphan_uploads()

        gc_ran = False
        if unpinned_now or orphan_unpinned or self._gc_pending:
            gc_ran = bool(self.kubo_adapter.run_gc())
            if gc_ran:
                self._gc_pending = False
        self.last_block = tip
        self._persist_state()
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
    catalog_index = PublicMetadataCatalogIndex(
        registry_adapter,
        refresh_ttl_sec=catalog_refresh_sec,
        min_forced_refresh_sec=min_forced_refresh_sec,
    )
    upload_limiter = UploadRateLimiter(
        max_uploads_per_hour=max_uploads_per_hour,
        max_bytes_per_hour=max_upload_bytes_per_hour,
        max_global_bytes_per_hour=max_global_upload_bytes_per_hour,
        max_total_pinned_bytes=max_total_pinned_bytes,
        db_path=effective_db,
        kubo_adapter=kubo_adapter,
    )
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

                # Consume isolated 'upload' nonce ONLY AFTER eligibility, quota & SHA-256 checks succeed
                consume_status = nonces.consume_checked(
                    recovered_addr, nonce, now_ts=now_val, namespace="upload"
                )
                if consume_status == "saturated":
                    with metrics_lock:
                        metrics["requestsDenied"] += 1
                    self._send_json(429, {"error": "Upload nonce bucket saturated; retry shortly."})
                    return
                if consume_status != "ok":
                    with metrics_lock:
                        metrics["requestsDenied"] += 1
                    self._send_json(401, {"error": "Nonce already used (replay rejected)."})
                    return

                spool.seek(0)
                add_fn = getattr(kubo_adapter, "add_stream", None)
                if not callable(add_fn):
                    self._send_json(501, {"error": "Configured Kubo adapter does not support streaming uploads."})
                    return
                try:
                    pin_res = add_fn(spool, filename, content_length, cid_version=1)
                except Exception as exc:
                    self._send_json(502, {"error": f"Private Kubo upload failed: {exc}"})
                    return

                upload_limiter.commit(
                    res_token,
                    content_length,
                    now_val,
                    cid=pin_res["cid"],
                    multihash=_try_canonical_multihash(pin_res["cid"]),
                )
                committed = True
            finally:
                if not committed:
                    upload_limiter.release(res_token)
                try:
                    spool.close()
                except Exception:
                    pass

            catalog_index.invalidate()
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

            # 2. Enforce on-chain dataset Active status, canonical multihash membership, First-Claimant Ownership, and owner/license BEFORE touching NonceStore
            allowed, status_code, auth_reason = authorize_cid_access(
                registry_adapter, data_id, cid, recovered_addr, catalog_index=catalog_index
            )
            if not allowed:
                with metrics_lock:
                    metrics["requestsDenied"] += 1
                self._send_json(status_code, {"error": auth_reason})
                return

            # 3. Atomically record 'download' nonce ONLY for verified + authorized requests (prevents pre-auth eviction DoS)
            if not nonces.consume(recovered_addr, nonce, now_ts=now_val, namespace="download"):
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
    reconciler = GdprErasureReconciler(
        reg_adapter,
        kubo_adapter,
        start_block=start_block,
        db_path=state_db_path,
        orphan_pin_ttl_sec=args.orphan_pin_ttl_sec,
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