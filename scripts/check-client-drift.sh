#!/usr/bin/env bash
# check-client-drift.sh — CI drift check for the generated OpenAPI TypeScript client.
#
# Regenerates types/api.ts from the committed openapi.json snapshot and
# fails if the result differs from what is committed.
# Run: bash scripts/check-client-drift.sh
set -euo pipefail

GENERATED_FILE="types/api.ts"
OPENAPI_SNAPSHOT="openapi.json"

# Stage 1 — snapshot vs SOURCE.
#
# This repo keeps its OWN copy of openapi.json; the authority is the one the
# api publishes. Stage 2 below only proves the client matches that copy, so on
# its own a green run says "we regenerated from our snapshot", not "our types
# match the API". The two silently diverged once already — 198KB against
# 120KB, identical path sets, different schema detail, so nothing looked wrong
# while the client was describing an API that no longer existed.
#
# Only possible in a wrapper checkout. In a standalone clone of this repo the
# api snapshot is not on disk, and this stage reports that rather than passing
# quietly, so an incomplete check never reads as a complete one.
API_SNAPSHOT="${API_OPENAPI_SNAPSHOT:-../api/openapi.json}"

if [[ -f "$API_SNAPSHOT" ]]; then
  echo "[drift-check] Comparing $OPENAPI_SNAPSHOT against $API_SNAPSHOT..."
  if ! diff -q "$API_SNAPSHOT" "$OPENAPI_SNAPSHOT" > /dev/null 2>&1; then
    echo "[drift-check] SNAPSHOT DRIFT — $OPENAPI_SNAPSHOT no longer matches the api."
    echo "Run: cp $API_SNAPSHOT $OPENAPI_SNAPSHOT && bunx openapi-typescript $OPENAPI_SNAPSHOT -o $GENERATED_FILE"
    echo "Then commit both."
    exit 1
  fi
  echo "[drift-check] OK — snapshot matches the api."
else
  echo "[drift-check] SKIPPED snapshot-vs-api check: $API_SNAPSHOT not found."
  echo "               (standalone checkout — set API_OPENAPI_SNAPSHOT to enable it)"
fi

echo "[drift-check] Regenerating $GENERATED_FILE from $OPENAPI_SNAPSHOT..."
bunx openapi-typescript "$OPENAPI_SNAPSHOT" -o "$GENERATED_FILE.tmp"

if diff -q "$GENERATED_FILE" "$GENERATED_FILE.tmp" > /dev/null 2>&1; then
  echo "[drift-check] OK — generated client matches committed snapshot."
  rm "$GENERATED_FILE.tmp"
  exit 0
else
  echo "[drift-check] DRIFT DETECTED — $GENERATED_FILE is stale."
  echo "Run: bunx openapi-typescript openapi.json -o types/api.ts"
  echo "Then commit the updated types/api.ts."
  diff "$GENERATED_FILE" "$GENERATED_FILE.tmp" || true
  rm "$GENERATED_FILE.tmp"
  exit 1
fi
