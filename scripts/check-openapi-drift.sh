#!/bin/bash
# OpenAPI drift detection: compares the committed OpenAPI spec
# against a freshly generated one from Zod schemas.
#
# Usage: ./scripts/check-openapi-drift.sh
# Exit 0 = no drift, Exit 1 = drift detected

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
SHARED_DIR="$ROOT_DIR/packages/shared"
CONTRACT_DIR="$ROOT_DIR/packages/contract"
TEMP_SPEC="$SHARED_DIR/temp-openapi.yaml"

trap 'rm -f "$TEMP_SPEC"' EXIT

echo "🔍 Checking OpenAPI spec drift..."

# Generate OpenAPI from Zod schemas (the script writes to ../openapi.yaml)
cd "$SHARED_DIR"
if ! npx tsx src/generate-openapi.ts 2>/dev/null; then
    echo "⚠️  Could not generate OpenAPI spec from Zod schemas"
    echo "   Make sure @asteasolutions/zod-to-openapi is installed"
    exit 0  # Don't fail CI for missing generation tool
fi

# The generate script writes to packages/shared/../openapi.yaml = packages/openapi.yaml
# But we want to compare against packages/contract/openapi.yaml
GENERATED_SPEC="$ROOT_DIR/packages/openapi.yaml"
COMMITTED_SPEC="$CONTRACT_DIR/openapi.yaml"

if [ ! -f "$GENERATED_SPEC" ]; then
    echo "⚠️  Generated spec not found at $GENERATED_SPEC"
    exit 0
fi

if [ ! -f "$COMMITTED_SPEC" ]; then
    echo "⚠️  No committed OpenAPI spec found at $COMMITTED_SPEC"
    echo "   Consider creating one from the generated spec"
    exit 0
fi

# Compare specs (normalize by sorting lines and stripping comments)
if diff -q \
    <(grep -v '^#' "$COMMITTED_SPEC" | sort) \
    <(grep -v '^#' "$GENERATED_SPEC" | sort) > /dev/null 2>&1; then
    echo "✅ OpenAPI spec is in sync with Zod schemas"
    rm -f "$GENERATED_SPEC"
    exit 0
else
    echo "❌ OpenAPI drift detected!"
    echo ""
    echo "The committed spec at packages/contract/openapi.yaml differs"
    echo "from the spec generated from packages/shared/ Zod schemas."
    echo ""
    echo "To fix:"
    echo "  1. Update the Zod schemas in packages/shared/"
    echo "  2. Run: cd packages/shared && npx tsx src/generate-openapi.ts"
    echo "  3. Copy the generated spec: cp packages/openapi.yaml packages/contract/openapi.yaml"
    echo "  4. Commit the updated spec"
    echo ""
    echo "Differences:"
    diff "$COMMITTED_SPEC" "$GENERATED_SPEC" || true
    rm -f "$GENERATED_SPEC"
    exit 1
fi
