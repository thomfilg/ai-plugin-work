---
name: code-review
description: Review code changes against target branch using code-checker agent
user-invocable: true
allowed-tools: Task, Bash, Read, Grep, Glob, AskUserQuestion
---

# /code-review — Code Review Against Target Branch

Review all changes on the current branch compared to the target branch using the code-checker agent.

## Instructions

### Step 1: Detect target branch and verify changes

```bash
# Reuse the centralized getBaseBranch() from the plugin (returns "origin/<branch>")
PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-}"
if [ -n "$PLUGIN_ROOT" ] && [ -f "$PLUGIN_ROOT/scripts/workflows/lib/config.js" ]; then
  TARGET_REF=$(node -e "const c = require('$PLUGIN_ROOT/scripts/workflows/lib/config.js'); console.log(c.getBaseBranch())")
else
  # Fallback: manual detection
  TARGET_REF=""
  if [ -n "$BASE_BRANCH" ]; then
    SANITIZED=$(echo "$BASE_BRANCH" | sed 's|^refs/remotes/||; s|^origin/||')
    if git rev-parse --verify "origin/$SANITIZED" >/dev/null 2>&1; then
      TARGET_REF="origin/$SANITIZED"
    fi
  fi
  if [ -z "$TARGET_REF" ]; then
    HEAD_REF=$(git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's|refs/remotes/||')
    if [ -n "$HEAD_REF" ]; then
      TARGET_REF="$HEAD_REF"
    fi
  fi
  if [ -z "$TARGET_REF" ]; then
    for branch in main dev master; do
      if git rev-parse --verify "origin/$branch" >/dev/null 2>&1; then
        TARGET_REF="origin/$branch"
        break
      fi
    done
  fi
fi

if [ -z "$TARGET_REF" ]; then
  echo "ERROR: Could not detect target branch."
  echo "Set BASE_BRANCH in your environment or .envrc, or specify manually."
  exit 1
fi

echo "Target branch: $TARGET_REF"

# Fetch latest to avoid stale comparisons
git fetch origin "${TARGET_REF#origin/}" --quiet 2>/dev/null || true

# Exclude deleted files (--diff-filter=d) so the reviewer doesn't try to read removed files
CHANGED_FILES=$(git diff "$TARGET_REF...HEAD" --name-only --diff-filter=d)

if [ -z "$CHANGED_FILES" ]; then
  echo "No changes found compared to $TARGET_REF."
  exit 0
fi

echo "$CHANGED_FILES"
```

If `CHANGED_FILES` is empty, inform the user there are no changes to review and stop.

If the target branch could not be detected (exit 1), use AskUserQuestion to ask the user which branch to compare against.

### Step 2: Launch code-checker

Launch a **code-checker** agent (`Task(code-checker)`) with this prompt:

```
Review all changes on the current branch compared to ${TARGET_REF}.

To get the full diff:
  git diff ${TARGET_REF}...HEAD

To get the list of changed files:
  git diff ${TARGET_REF}...HEAD --name-only --diff-filter=d

Changed files:
${CHANGED_FILES}

Follow your full pre-review workflow:
1. Read task documents (brief.md, spec.md, tasks.md) if they exist
2. Review all changed implementation files
3. Review all changed test files
4. Verify file coverage
5. Classify the change type
6. Evaluate against all engineering standards
7. Produce the report using your standard Report Structure

Output the review directly — do NOT save to a file.
```

### Step 3: Present results

Show the code-checker's review output to the user.
