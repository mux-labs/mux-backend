#!/usr/bin/env bash
# Key Management Consolidation Verification Script
#
# Thin, fail-closed wrapper around the typed verifier
# (scripts/verify-key-management-consolidation.ts). All verification logic and
# exit-code semantics live in the TypeScript module so that they are unit
# tested and deterministic; this wrapper only locates the repo root and refuses
# to run when a bypass override is present (deny-by-default for the gate itself).
#
# See docs/key-management-consolidation.md and docs/custody-security-model.md
# for the invariant definitions.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Deny-by-default: never allow an environment override to disable this gate.
if [[ -n "${KEY_CONSOLIDATION_VERIFY_SKIP:-}" || -n "${SKIP_KEY_CONSOLIDATION_VERIFY:-}" ]]; then
  echo "Refusing to run: KEY_CONSOLIDATION_VERIFY_SKIP / SKIP_KEY_CONSOLIDATION_VERIFY is set." >&2
  echo "This gate cannot be bypassed with an environment variable." >&2
  exit 3
fi

cd "$REPO_ROOT"
exec pnpm exec ts-node "$SCRIPT_DIR/verify-key-management-consolidation.ts" "$@"