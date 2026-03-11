#!/bin/bash
# Typecheck only changed TS/TSX files
# Auto-detects: tsgo, tsc-files, tsc
# Monorepo: typechecks per-package; Single-repo: typechecks at root

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/common.sh"

CHANGED_FILES=$(get_changed_files '\.(ts|tsx)$')

if [ -z "$CHANGED_FILES" ]; then
  echo "No TypeScript files changed"
  exit 0
fi

# Detect typechecker
CHECKER=$(detect_tool "$ROOT_DIR/package.json" "tsgo" "tsc-files" "typescript")

if [ -z "$CHECKER" ]; then
  echo -e "${YELLOW}No TypeScript checker found in package.json${NC}"
  exit 0
fi

echo -e "${CYAN}Typechecking changed files...${NC}"

typecheck_files() {
  local dir="$1"
  local files="$2"

  case "$CHECKER" in
    tsgo)
      # tsgo doesn't support file-level checking yet — run full check from dir
      (cd "$dir" && npx tsgo --noEmit)
      ;;
    tsc-files)
      local output
      output=$(cd "$dir" && echo "$files" | xargs npx tsc-files --noEmit 2>&1) || {
        # TS6307 = composite project reference error, fall back to full tsc
        if echo "$output" | grep -q "TS6307"; then
          (cd "$dir" && npx tsc --noEmit)
        else
          echo "$output" >&2
          return 1
        fi
      }
      ;;
    typescript)
      # tsc doesn't accept individual files with project config — run full check
      (cd "$dir" && npx tsc --noEmit)
      ;;
  esac
}

if is_monorepo; then
  PACKAGES=$(extract_packages "$CHANGED_FILES")

  if [ -z "$PACKAGES" ]; then
    # Changed files are at root level (not in any workspace package)
    echo "Typechecking root..."
    typecheck_files "$ROOT_DIR" "$CHANGED_FILES"
  else
    for pkg in $PACKAGES; do
      if [ -d "$ROOT_DIR/$pkg" ]; then
        echo -e "${CYAN}Typechecking $pkg...${NC}"
        # Get files relative to the package dir
        # Count segments in pkg path to know how many to strip (e.g., "apps/my-app" = 2 segments)
        local_segments=$(echo "$pkg" | tr '/' '\n' | wc -l)
        PKG_FILES=$(echo "$CHANGED_FILES" | grep "^$pkg/" | cut -d'/' -f$((local_segments + 1))-)
        typecheck_files "$ROOT_DIR/$pkg" "$PKG_FILES"
      fi
    done
  fi
else
  typecheck_files "$ROOT_DIR" "$CHANGED_FILES"
fi

echo -e "${GREEN}Typecheck passed${NC}"
