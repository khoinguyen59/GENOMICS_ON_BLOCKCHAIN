#!/usr/bin/env bash
# Baseline gate for the multi-agent verification harness.
# Resolves portable Node v22.x (nvm) and project Python .venv cleanly with zero machine-hardcoded paths.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO_ROOT" || exit 1

if [ -n "${NVM_NODE22_BIN:-}" ] && [ -d "$NVM_NODE22_BIN" ]; then
  export PATH="$NVM_NODE22_BIN:$PATH"
elif [ -d "${LOCALAPPDATA:-}/nvm/v22.15.0" ]; then
  export PATH="${LOCALAPPDATA}/nvm/v22.15.0:$PATH"
elif [ -d "${HOME:-}/AppData/Local/nvm/v22.15.0" ]; then
  export PATH="${HOME}/AppData/Local/nvm/v22.15.0:$PATH"
fi

if [ -x "$REPO_ROOT/.venv/Scripts/python.exe" ]; then
  PYTHON_BIN="$REPO_ROOT/.venv/Scripts/python.exe"
elif [ -x "$REPO_ROOT/.venv/bin/python" ]; then
  PYTHON_BIN="$REPO_ROOT/.venv/bin/python"
else
  PYTHON_BIN="$(command -v python3 || command -v python)"
fi

LOG_DIR=docs/reports/swarm_audit
mkdir -p "$LOG_DIR"
OUT="$LOG_DIR/00_baseline_gate.log"
rm -f "$LOG_DIR/00_baseline_gate.DONE"
: > "$OUT"
: > "$LOG_DIR/00_baseline_summary.txt"

FAILED_COUNT=0

run() {
  local label="$1"; shift
  {
    echo ""
    echo "########## $label ##########"
    echo "\$ $*"
  } >> "$OUT" 2>&1
  local t0
  t0=$(date +%s)
  local code=0
  if "$@" >> "$OUT" 2>&1; then
    code=0
  else
    code=$?
    FAILED_COUNT=$((FAILED_COUNT + 1))
  fi
  local t1
  t1=$(date +%s)
  {
    echo "---- exit=$code  elapsed=$((t1-t0))s  ----"
  } >> "$OUT" 2>&1
  echo "$label exit=$code elapsed=$((t1-t0))s" >> "$LOG_DIR/00_baseline_summary.txt"
}

run "T0-toolchain"      bash -c "node -v; npm -v; npx hardhat --version; \"$PYTHON_BIN\" --version"
run "T1-npm-test"       npx hardhat test
run "T2-stress"         npx hardhat run scripts/audit/independent_stress_suite.mjs
run "T3-frontend-build" npm --prefix frontend run build
run "T4-audit-root"     npm audit --omit=dev
run "T4-audit-frontend" npm --prefix frontend audit --omit=dev
run "T5-solhint"        npm run lint:sol
run "T6-eip170"         "$PYTHON_BIN" scripts/audit/check_eip170.py
run "T7-gitgrep"        bash -c "git grep -i 'QmGeno' -- frontend/ crypto/ ipfs/ || echo NO_QMGENO_HIT"
run "T7-gitgrep2"       bash -c "git grep -nE 'rawContent|capsuleKey' -- frontend/src/ || echo NO_PLAINTEXT_HIT"
run "T7-gitgrep3"       bash -c "git grep -nE 'datasets\.length[[:space:]]*\+[[:space:]]*1' -- frontend/src/ || echo NO_STATE_FAKE_HIT"
run "T8-web3-demo"      "$PYTHON_BIN" scripts/demo/web3_demo.py --offline-demo
run "T9-hygiene"        "$PYTHON_BIN" scripts/audit/academic_hygiene_toolkit.py --selftest

echo "" >> "$OUT"
echo "########## BASELINE COMPLETE (failed=$FAILED_COUNT) ##########" >> "$OUT"
touch "$LOG_DIR/00_baseline_gate.DONE"
if [ "$FAILED_COUNT" -ne 0 ]; then
  echo "[FAIL] Baseline gate finished with $FAILED_COUNT failing step(s). See $LOG_DIR/00_baseline_summary.txt" >&2
  exit 1
fi
