---
name: create-jira-wiki
description: Wiki publishing for Jira task design documents
user-invocable: true
allowed-tools: Bash, Read, Write, Grep, Glob
---
# Create Jira - Wiki Publishing

Referenced by: [create-jira.md](create-jira.md) Step 14.5
Also used by: [create-design-doc.md](create-design-doc.md)

## Prerequisites

**Only run this step if:**
- User selected "Create Jira task" (not "Skip wiki")
- A design doc was generated

## Clone Wiki Repository

```bash
# Clone wiki repository (if not already cloned)
WIKI_DIR="../$(basename $(pwd)).wiki"
if [ ! -d "$WIKI_DIR" ]; then
  gh repo clone $(gh repo view --json nameWithOwner -q .nameWithOwner).wiki "$WIKI_DIR" 2>/dev/null || {
    echo "⚠️ Wiki not enabled or empty. Initializing..."
    mkdir -p "$WIKI_DIR"
    cd "$WIKI_DIR"
    git init
    git remote add origin "https://github.com/$(gh repo view --json nameWithOwner -q .nameWithOwner).wiki.git"
    echo "# Wiki Home" > Home.md
    git add Home.md
    git commit -m "Initialize wiki"
    git push -u origin master || git push -u origin main
    cd -
  }
fi
```

## Copy Design Doc to Wiki

```bash
# Copy design doc to wiki
WIKI_FILE="${WIKI_DIR}/Design-Docs/${SLUG}.md"
mkdir -p "${WIKI_DIR}/Design-Docs"
cp "tasks/design-docs/${SLUG}-design-doc.md" "${WIKI_FILE}"
```

## Update Design-Docs Index Page

```bash
# Update Design-Docs index page
INDEX_FILE="${WIKI_DIR}/Design-Docs.md"
if [ ! -f "$INDEX_FILE" ]; then
  echo "# Design Documents" > "$INDEX_FILE"
  echo "" >> "$INDEX_FILE"
  echo "Index of design documents for this project." >> "$INDEX_FILE"
  echo "" >> "$INDEX_FILE"
  echo "## Documents" >> "$INDEX_FILE"
  echo "" >> "$INDEX_FILE"
fi

# Add link to index if not already present
if ! grep -q "${SLUG}" "$INDEX_FILE" 2>/dev/null; then
  echo "- [${SLUG}](Design-Docs/${SLUG})" >> "$INDEX_FILE"
fi
```

## Commit and Push to Wiki

```bash
# Commit and push to wiki
cd "$WIKI_DIR"
git add .
git commit -m "docs: add design doc for ${SLUG}"
git push origin master || git push origin main
cd -

WIKI_URL="https://github.com/$(gh repo view --json nameWithOwner -q .nameWithOwner)/wiki/Design-Docs/${SLUG}"
echo "📚 Wiki published: ${WIKI_URL}"
```

## Wiki Structure

```
repo.wiki/
├── Home.md                      # Wiki home page
├── Design-Docs.md               # Index of all design documents
└── Design-Docs/
    ├── ${slug-1}.md             # Design doc 1
    ├── ${slug-2}.md             # Design doc 2
    └── ...
```

## Full Script (Combined)

For convenience, here's the complete wiki publishing script:

```bash
#!/bin/bash
# Usage: publish-to-wiki.sh <slug> <source-file>

SLUG="$1"
SOURCE_FILE="$2"

if [ -z "$SLUG" ] || [ -z "$SOURCE_FILE" ]; then
  echo "Usage: publish-to-wiki.sh <slug> <source-file>"
  exit 1
fi

if [ ! -f "$SOURCE_FILE" ]; then
  echo "❌ Source file not found: $SOURCE_FILE"
  exit 1
fi

# Clone wiki repository (if not already cloned)
WIKI_DIR="../$(basename $(pwd)).wiki"
if [ ! -d "$WIKI_DIR" ]; then
  gh repo clone $(gh repo view --json nameWithOwner -q .nameWithOwner).wiki "$WIKI_DIR" 2>/dev/null || {
    echo "⚠️ Wiki not enabled or empty. Initializing..."
    mkdir -p "$WIKI_DIR"
    cd "$WIKI_DIR"
    git init
    git remote add origin "https://github.com/$(gh repo view --json nameWithOwner -q .nameWithOwner).wiki.git"
    echo "# Wiki Home" > Home.md
    git add Home.md
    git commit -m "Initialize wiki"
    git push -u origin master || git push -u origin main
    cd -
  }
fi

# Copy design doc to wiki
WIKI_FILE="${WIKI_DIR}/Design-Docs/${SLUG}.md"
mkdir -p "${WIKI_DIR}/Design-Docs"
cp "$SOURCE_FILE" "${WIKI_FILE}"

# Update Design-Docs index page
INDEX_FILE="${WIKI_DIR}/Design-Docs.md"
if [ ! -f "$INDEX_FILE" ]; then
  cat > "$INDEX_FILE" << 'EOF'
# Design Documents

Index of design documents for this project.

## Documents

EOF
fi

# Add link to index if not already present
if ! grep -q "${SLUG}" "$INDEX_FILE" 2>/dev/null; then
  echo "- [${SLUG}](Design-Docs/${SLUG})" >> "$INDEX_FILE"
fi

# Commit and push to wiki
cd "$WIKI_DIR"
git add .
git commit -m "docs: add/update design doc for ${SLUG}"
git push origin master || git push origin main
cd -

WIKI_URL="https://github.com/$(gh repo view --json nameWithOwner -q .nameWithOwner)/wiki/Design-Docs/${SLUG}"
echo "📚 Wiki published: ${WIKI_URL}"
echo "$WIKI_URL"
```

## Notes

- Wiki clone is cached in `../<repo-name>.wiki/` to avoid re-cloning
- Index page is auto-maintained with links to all design docs
- If wiki doesn't exist, it's initialized automatically
- Supports both `master` and `main` branch conventions
