#!/usr/bin/env bash
# Baseline gate for the 6-agent isomorphic swarm audit.
# Lead Agent runs this ONCE so the swarm shares one ground-truth log
# and does not race on hardhat artifacts/cache.
set -u
# ENV FIX (measured 2026-11-05): the broken Roaming/npm shim and Anaconda's node.exe
# shadow the real toolchain, which made every node/npm/npx call die with MODULE_NOT_FOUND
# in ~0s. A previous run of this script produced 11 bogus exit=1 rows. Do not trust that log.
export PATH="/c/nvm4w1/nodejs:$PATH"
cd "$(dirname "$0")/../.." || exit 1
LOG_DIR=docs/reports/swarm_audit
mkdir -p "$LOG_DIR"
OUT="$LOG_DIR/00_baseline_gate.log"
rm -f "$LOG_DIR/00_baseline_gate.DONE"
: > "$OUT"

run() {
  local label="$1"; shift
  {
    echo ""
    echo "########## $label ##########"
    echo "\$ $*"
  } >> "$OUT" 2>&1
  local t0=$(date +%s)
  "$@" >> "$OUT" 2>&1
  local code=$?
  local t1=$(date +%s)
  {
    echo "---- exit=$code  elapsed=$((t1-t0))s  ----"
  } >> "$OUT" 2>&1
  echo "$label exit=$code elapsed=$((t1-t0))s" >> "$LOG_DIR/00_baseline_summary.txt"
}

: > "$LOG_DIR/00_baseline_summary.txt"

run "T0-toolchain" bash -c "node -v; npm -v; npx hardhat --version"
run "T1-npm-test"   npx hardhat test
run "T2-stress"     npx hardhat run scripts/audit/independent_stress_suite.mjs
run "T3-frontend-build" npm --prefix frontend run build
run "T4-audit-root" npm audit --omit=dev
run "T4-audit-frontend" npm --prefix frontend audit --omit=dev
run "T5-solhint"    npx --yes solhint "contracts/**/*.sol"
run "T6-gitgrep"    bash -c "git grep -i 'QmGeno' -- frontend/ crypto/ ipfs/ || echo NO_QMGENO_HIT"
run "T6-gitgrep2"   bash -c "git grep -nE 'rawContent|capsuleKey' -- frontend/src/ || echo NO_PLAINTEXT_HIT"
run "T6-gitgrep3"   bash -c "git grep -nE 'datasets\.length[[:space:]]*\+[[:space:]]*1' -- frontend/src/ || echo NO_STATE_FAKE_HIT"
run "T7-web3-demo"  python scripts/demo/web3_demo.py
run "T8-hygiene"    python scripts/audit/academic_hygiene_toolkit.py --selftest

echo "" >> "$OUT"
echo "########## BASELINE COMPLETE ##########" >> "$OUT"
touch "$LOG_DIR/00_baseline_gate.DONE"
