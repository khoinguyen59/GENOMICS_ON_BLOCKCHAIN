#!/usr/bin/env python3
"""
GenoChain Protocol - Private IPFS Swarm Key Generator (go-ipfs PSK v1)

Generates a cryptographically random 256-bit pre-shared key (swarm.key) required when
running Kubo with LIBP2P_FORCE_PNET=1. Keep the generated file strictly confidential
and NEVER commit it to version control (deploy/secrets/ is git-ignored).
"""

import argparse
import os
import secrets
import sys
from pathlib import Path


def format_swarm_key(raw_key: bytes) -> str:
    """Format 32 random bytes into canonical go-ipfs /key/swarm/psk/1.0.0/ LF-delimited text."""
    if len(raw_key) != 32:
        raise ValueError(f"Expected 32-byte key, got {len(raw_key)} bytes.")
    return f"/key/swarm/psk/1.0.0/\n/base16/\n{raw_key.hex()}\n"


def generate_swarm_key_file(output_path: str | os.PathLike, *, force: bool = False) -> Path:
    """Create a 256-bit PSK swarm.key file with restrictive permissions (0600 on POSIX)."""
    dest = Path(output_path)
    if dest.exists() and not force:
        raise FileExistsError(
            f"Swarm key already exists at {dest}. Pass --force to overwrite."
        )
    dest.parent.mkdir(parents=True, exist_ok=True)
    try:
        os.chmod(dest.parent, 0o700)
    except OSError:
        pass

    content = format_swarm_key(secrets.token_bytes(32))
    # Write with explicit LF endings so Linux Kubo containers parse the PSK cleanly even if generated on Windows.
    with open(dest, "w", encoding="ascii", newline="\n") as fh:
        fh.write(content)
    try:
        os.chmod(dest, 0o600)
    except OSError:
        pass
    return dest


def main() -> int:
    default_out = Path(__file__).resolve().parent / "secrets" / "swarm.key"
    parser = argparse.ArgumentParser(
        description="Generate a 256-bit private IPFS Kubo PSK (LIBP2P_FORCE_PNET=1)."
    )
    parser.add_argument(
        "--output",
        "-o",
        default=str(default_out),
        help=f"Output swarm.key path (default: {default_out})",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="Overwrite existing swarm.key if already present.",
    )
    args = parser.parse_args()
    try:
        path = generate_swarm_key_file(args.output, force=args.force)
    except FileExistsError as exc:
        print(f"[ERROR] {exc}", file=sys.stderr)
        return 1
    print(f"[OK] Generated 256-bit private IPFS swarm key at: {path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())