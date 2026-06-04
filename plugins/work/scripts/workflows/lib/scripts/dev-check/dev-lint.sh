#!/bin/bash
# Lint only changed JS/TS files
# Auto-detects: oxlint, eslint, biome
# Works with monorepos and single-repo projects

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/common.sh"

CHANGED_FILES=$(get_changed_files '\.(js|jsx|ts|tsx)$')

if [ -z "$CHANGED_FILES" ]; then
  echo "No JS/TS files to lint"
  exit 0
fi

# Detect linter
LINTER=$(detect_tool "$ROOT_DIR/package.json" "oxlint" "eslint" "biome")

if [ -z "$LINTER" ]; then
  echo -e "${YELLOW}No linter found in package.json (checked: oxlint, eslint, biome)${NC}"
  exit 0
fi

echo -e "${CYAN}Linting changed files with ${LINTER}...${NC}"

# Convert relative paths to absolute for the linter
ABS_FILES=$(echo "$CHANGED_FILES" | sed "s|^|$ROOT_DIR/|")

case "$LINTER" in
  oxlint)
    # oxlint accepts file paths directly; check if --type-aware is available
    if grep -q "type-aware" "$ROOT_DIR/package.json" 2>/dev/null; then
      echo "$ABS_FILES" | xargs npx oxlint --type-aware
    else
      echo "$ABS_FILES" | xargs npx oxlint
    fi
    ;;
  eslint)
    ESLINT_CONFIG_ARGS=()
    if [ -f "$ROOT_DIR/eslint.config.js" ] || [ -f "$ROOT_DIR/eslint.config.mjs" ] || [ -f "$ROOT_DIR/eslint.config.cjs" ] || [ -f "$ROOT_DIR/eslint.config.ts" ] || [ -f "$ROOT_DIR/eslint.config.mts" ] || [ -f "$ROOT_DIR/eslint.config.cts" ]; then
      :
    elif [ -f "$SCRIPT_DIR/../quality/configs/quality-lint-rules.js" ]; then
      ESLINT_CONFIG_ARGS=(--config "$SCRIPT_DIR/../quality/configs/quality-lint-rules.js")
    else
      printf '\033[33m%s\033[0m\n' "dev-lint: no eslint flat config found — skipping lint" >&2
      exit 0
    fi
    echo "$CHANGED_FILES" | (cd "$ROOT_DIR" && xargs npx eslint "${ESLINT_CONFIG_ARGS[@]}")
    ;;
  biome)
    echo "$ABS_FILES" | xargs npx biome lint
    ;;
esac

echo -e "${GREEN}Lint passed${NC}"
