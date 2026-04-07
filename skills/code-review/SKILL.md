---
name: code-review
description: Review code changes against main using code-checker agent
user-invocable: true
allowed-tools: Agent, Bash, Read, Grep, Glob
---

# /code-review — Code Review Against Main

Review all changes on the current branch compared to main using the code-checker agent.

## Instructions

### Step 1: Detect target branch and verify changes

```bash
# Use repo-defined BASE_BRANCH if available, otherwise detect
if [ -n "$BASE_BRANCH" ]; then
  TARGET_BRANCH="$BASE_BRANCH"
elif TARGET_BRANCH=$(git remote show origin 2>/dev/null | grep 'HEAD branch' | awk '{print $NF}') && [ -n "$TARGET_BRANCH" ]; then
  :
else
  for branch in main master dev develop; do
    if git rev-parse --verify "origin/$branch" >/dev/null 2>&1; then
      TARGET_BRANCH="$branch"
      break
    fi
  done
fi

if [ -z "$TARGET_BRANCH" ]; then
  echo "ERROR: Could not detect target branch."
  echo "Set BASE_BRANCH in your environment or .envrc, or specify manually."
  exit 1
fi

echo "Target branch: origin/$TARGET_BRANCH"

CHANGED_FILES=$(git diff "origin/$TARGET_BRANCH...HEAD" --name-only)
echo "$CHANGED_FILES"
```

If `CHANGED_FILES` is empty, inform the user there are no changes to review and stop.

If the target branch could not be detected, ask the user which branch to compare against.

### Step 2: Launch code-checker

Launch a **code-checker** agent with this prompt:

```
Review all changes on the current branch compared to origin/${TARGET_BRANCH}.

To get the full diff:
  git diff origin/${TARGET_BRANCH}...HEAD

To get the list of changed files:
  git diff origin/${TARGET_BRANCH}...HEAD --name-only

Changed files:
${CHANGED_FILES}

Follow your full pre-review workflow:
1. Read task documents (brief.md, spec.md) if they exist
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
