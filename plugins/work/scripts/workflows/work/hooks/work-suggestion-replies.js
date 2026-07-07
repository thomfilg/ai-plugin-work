#!/usr/bin/env node

/**
 * Stop hook to verify all issues (CRITICAL, IMPORTANT, SUGGESTIONS) in
 * code-review.md have responses in code-review-reply.md.
 *
 * This hook runs at the end of turns and checks:
 * 1. Extracts all issues from code-review.md (CRITICAL, IMPORTANT, NICE-TO-HAVE)
 * 2. Checks if code-review-reply.md exists and has a response for each
 * 3. Blocks if any issue is missing a reply
 */

const fs = require('fs');
const path = require('path');
const { logHookError } = require(path.join(__dirname, '..', '..', 'lib', 'hook-error-log'));
// Namespace import (unlike work-code-review-status.js's destructuring) — the
// two hooks' heads are otherwise near-identical and would trip the
// duplicate-blocks gate.
const stopHookUtils = require(path.join(__dirname, '..', 'lib', 'stop-hook-utils'));

const blockState = stopHookUtils.createBlockState(__filename);

const config = stopHookUtils.loadStopHookConfig();
if (!config) process.exit(0);

// Extract issues from a specific section of code-review.md
function extractIssuesFromSection(content, sectionPattern, stopPattern) {
  const issues = [];

  // Find the section
  const sectionMatch = content.match(
    new RegExp(sectionPattern + '[^\\n]*\\n([\\s\\S]*?)(?=' + stopPattern + '|$)', 'i')
  );

  if (!sectionMatch) return issues;

  const sectionContent = sectionMatch[1];

  // Check for "none found" or similar
  if (
    /none\s*found|no\s*(critical|important|issues?)|0\s*issues/i.test(
      sectionContent.substring(0, 200)
    )
  ) {
    return [];
  }

  // Extract individual issue titles
  // Match patterns like:
  // **🔴 Security: Hardcoded Admin Email Fallback**
  // **🟡 Error Handling: Silent Failure**
  // - **Title**: description
  // 1. **Title**: description
  const patterns = [
    /\*\*(?:🔴|🟡|🟢)?\s*([^*\n]+)\*\*/g, // **Title** or **🔴 Title**
    /[-*]\s*\*\*([^*:]+)\*\*\s*:/g, // - **Title**:
    /\d+\.\s*\*\*([^*:]+)\*\*\s*:/g, // 1. **Title**:
  ];

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(sectionContent)) !== null) {
      const title = match[1].trim();
      // Filter out non-issue items and headers
      if (
        title.length > 3 &&
        !title.match(/^(none|n\/a|no\s+|issues?\s*found|CRITICAL|IMPORTANT|NICE-TO-HAVE)/i) &&
        !title.match(/^(File|Description|Impact|Recommendation):/i)
      ) {
        issues.push(title);
      }
    }
  }

  return [...new Set(issues)]; // Remove duplicates
}

// Extract all issues from code-review.md (CRITICAL, IMPORTANT, NICE-TO-HAVE/SUGGESTIONS)
function extractAllIssues(content) {
  return {
    // Extract CRITICAL issues
    // Pattern: ### 🔴 CRITICAL ISSUES or ### CRITICAL
    critical: extractIssuesFromSection(
      content,
      '###?\\s*(?:🔴\\s*)?CRITICAL\\s*ISSUES?',
      '###?\\s*(?:🟡|IMPORTANT|🟢|NICE-TO-HAVE|SUGGESTIONS?|---)'
    ),
    // Extract IMPORTANT issues
    // Pattern: ### 🟡 IMPORTANT ISSUES or ### IMPORTANT
    important: extractIssuesFromSection(
      content,
      '###?\\s*(?:🟡\\s*)?IMPORTANT\\s*ISSUES?',
      '###?\\s*(?:🟢|NICE-TO-HAVE|SUGGESTIONS?|---)'
    ),
    // Extract NICE-TO-HAVE / SUGGESTIONS
    // Pattern: ### 🟢 NICE-TO-HAVE IMPROVEMENTS or ### SUGGESTIONS
    suggestions: extractIssuesFromSection(
      content,
      '###?\\s*(?:🟢\\s*)?(?:NICE-TO-HAVE|SUGGESTIONS?)\\s*(?:IMPROVEMENTS?)?',
      '###?\\s*(?:Test|Security|Performance|Next|Conclusion|---)'
    ),
  };
}

// Check if a suggestion has a reply
function findReplyForSuggestion(replyContent, suggestionTitle) {
  // Normalize the title for comparison
  const normalizedTitle = suggestionTitle
    .toLowerCase()
    .replace(/[^\w\s]/g, '')
    .trim();

  // Look for "## Suggestion: [title]" or similar patterns
  const patterns = [
    new RegExp(`##\\s*Suggestion:\\s*${escapeRegex(suggestionTitle)}`, 'i'),
    new RegExp(`##\\s*${escapeRegex(suggestionTitle)}`, 'i'),
    new RegExp(`\\*\\*Suggestion:\\*\\*\\s*${escapeRegex(suggestionTitle)}`, 'i'),
    new RegExp(`[-*]\\s*\\*\\*${escapeRegex(suggestionTitle)}\\*\\*`, 'i'),
  ];

  for (const pattern of patterns) {
    if (pattern.test(replyContent)) {
      return true;
    }
  }

  // Fuzzy match - check if similar words appear
  const titleWords = normalizedTitle.split(/\s+/).filter((w) => w.length > 3);
  const contentNormalized = replyContent.toLowerCase().replace(/[^\w\s]/g, '');

  // If most words from the title appear near each other in the reply
  let matchCount = 0;
  for (const word of titleWords) {
    if (contentNormalized.includes(word)) {
      matchCount++;
    }
  }

  // If 70%+ of significant words match, consider it a match
  if (titleWords.length > 0 && matchCount / titleWords.length >= 0.7) {
    return true;
  }

  return false;
}

function escapeRegex(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractChangesHash(content) {
  const hashMatch = content.match(/\*\*Changes Hash:\*\*\s*([a-f0-9]+)/i);
  return hashMatch ? hashMatch[1] : null;
}

/** Append "LABEL (n):" plus up to `showMax` truncated titles and a "... and N more". */
function pushIssueGroup(list, label, items, showMax) {
  if (items.length === 0) return;
  list.push(`${label} (${items.length}):`);
  items.slice(0, showMax).forEach((s) => {
    list.push(`  - ${s.substring(0, 55)}${s.length > 55 ? '...' : ''}`);
  });
  if (items.length > showMax) list.push(`  ... and ${items.length - showMax} more`);
}

/** Append "LABEL (missing n):" plus ALL truncated titles. */
function pushMissingGroup(list, label, items) {
  if (items.length === 0) return;
  list.push(`${label} (missing ${items.length}):`);
  items.forEach((s) => {
    list.push(`  - ${s.substring(0, 55)}${s.length > 55 ? '...' : ''}`);
  });
}

/** No reply file at all → list the issues found and block. */
function blockMissingReplyFile(currentTaskId, allIssues, totalIssues) {
  // Build issue list for display
  const issuesList = [];
  pushIssueGroup(issuesList, 'CRITICAL', allIssues.critical, 3);
  pushIssueGroup(issuesList, 'IMPORTANT', allIssues.important, 3);
  pushIssueGroup(issuesList, 'SUGGESTIONS', allIssues.suggestions, 2);

  process.stderr.write(
    `MISSING CODE REVIEW REPLY\n\n` +
      `Task: ${currentTaskId}\n` +
      `Found ${totalIssues} issue(s) in code-review.check.md:\n` +
      `  ${allIssues.critical.length} CRITICAL | ${allIssues.important.length} IMPORTANT | ${allIssues.suggestions.length} suggestions\n\n` +
      `code-review-reply.check.md does not exist\n\n` +
      `${issuesList.join('\n')}\n\n` +
      `You MUST create code-review-reply.check.md with responses.\n` +
      `Each issue needs:\n` +
      `  ## Issue: [title]\n` +
      `  **Decision:** FIXED | DEFERRED | NOT_APPLICABLE\n` +
      `  **Reason:** [specific justification]\n`
  );
  blockState.didBlock = true;
  process.exit(2);
}

/**
 * Validate SHA/Changes Hash matches between code-review.check.md and
 * code-review-reply.check.md — a stale or missing hash blocks the stop.
 */
function validateChangesHash(currentTaskId, reviewHash, replyHash) {
  if (reviewHash && replyHash && reviewHash !== replyHash) {
    process.stderr.write(
      `CODE REVIEW REPLY SHA MISMATCH\n\n` +
        `Task: ${currentTaskId}\n\n` +
        `The Changes Hash in code-review-reply.check.md does not match\n` +
        `the Changes Hash in code-review.check.md:\n\n` +
        `  code-review.check.md:       ${reviewHash}\n` +
        `  code-review-reply.check.md: ${replyHash}\n\n` +
        `This means the reply is outdated and needs to be regenerated.\n\n` +
        `ACTION: Re-run the developer agent to generate a new reply\n` +
        `        based on the current code-review.check.md\n`
    );
    blockState.didBlock = true;
    process.exit(2);
  }

  if (reviewHash && !replyHash) {
    process.stderr.write(
      `CODE REVIEW REPLY MISSING CHANGES HASH\n\n` +
        `Task: ${currentTaskId}\n\n` +
        `code-review-reply.check.md is missing **Changes Hash:** header.\n\n` +
        `Expected hash: ${reviewHash}\n\n` +
        `ACTION: Add the following line at top of code-review-reply.check.md:\n\n` +
        `  **Changes Hash:** ${reviewHash}\n`
    );
    blockState.didBlock = true;
    process.exit(2);
  }
}

/** Every extracted issue must have a matching reply — block listing the gaps. */
function blockIfRepliesMissing(currentTaskId, allIssues, replyContent, totalIssues) {
  const missingIssues = {
    critical: allIssues.critical.filter((s) => !findReplyForSuggestion(replyContent, s)),
    important: allIssues.important.filter((s) => !findReplyForSuggestion(replyContent, s)),
    suggestions: allIssues.suggestions.filter((s) => !findReplyForSuggestion(replyContent, s)),
  };

  const totalMissing =
    missingIssues.critical.length +
    missingIssues.important.length +
    missingIssues.suggestions.length;

  if (totalMissing === 0) return;

  // Build missing issues list for display
  const missingList = [];
  pushMissingGroup(missingList, 'CRITICAL', missingIssues.critical);
  pushMissingGroup(missingList, 'IMPORTANT', missingIssues.important);
  pushMissingGroup(missingList, 'SUGGESTIONS', missingIssues.suggestions);

  process.stderr.write(
    `INCOMPLETE CODE REVIEW REPLY\n\n` +
      `Task: ${currentTaskId}\n` +
      `Missing replies for ${totalMissing}/${totalIssues} issue(s)\n\n` +
      `${missingList.join('\n')}\n\n` +
      `Add to code-review-reply.check.md:\n` +
      `  ## Issue: [exact title from above]\n` +
      `  **Decision:** FIXED | DEFERRED | NOT_APPLICABLE\n` +
      `  **Reason:** [specific justification]\n`
  );
  blockState.didBlock = true;
  process.exit(2);
}

/** Check one directory's code-review + reply pair; may exit(0) or exit(2). */
function checkDirectory(dir, currentTaskId) {
  const taskFolder = path.join(dir, 'tasks', currentTaskId);
  const codeReviewPath = path.join(taskFolder, 'code-review.check.md');
  const replyPath = path.join(taskFolder, 'code-review-reply.check.md');

  if (!fs.existsSync(codeReviewPath)) return;
  if (!stopHookUtils.isRecentlyModified(codeReviewPath)) return;

  // Read code-review.check.md and extract all issues (CRITICAL, IMPORTANT, SUGGESTIONS)
  const codeReviewContent = fs.readFileSync(codeReviewPath, 'utf8');

  // Extract Changes Hash from code-review.check.md
  const reviewHash = extractChangesHash(codeReviewContent);

  const allIssues = extractAllIssues(codeReviewContent);
  const totalIssues =
    allIssues.critical.length + allIssues.important.length + allIssues.suggestions.length;

  // If no issues found, approve
  if (totalIssues === 0) {
    process.exit(0);
  }

  // Check if reply file exists
  if (!fs.existsSync(replyPath)) {
    blockMissingReplyFile(currentTaskId, allIssues, totalIssues);
  }

  // Read reply file and check for missing responses
  const replyContent = fs.readFileSync(replyPath, 'utf8');

  validateChangesHash(currentTaskId, reviewHash, extractChangesHash(replyContent));
  blockIfRepliesMissing(currentTaskId, allIssues, replyContent, totalIssues);
}

async function main() {
  const input = await stopHookUtils.readStdin();

  let hookData = {};
  try {
    hookData = JSON.parse(input);
  } catch {
    /* empty/invalid — use default */
  }

  if (stopHookUtils.shouldSkipCodexStop(hookData)) {
    process.exit(0);
  }

  const cwd = process.cwd();
  const currentTaskId = stopHookUtils.getCurrentTaskId(config, cwd);

  if (!currentTaskId) {
    process.exit(0);
  }

  for (const dir of stopHookUtils.reviewDirsToCheck(config, cwd)) {
    checkDirectory(dir, currentTaskId);
  }

  process.exit(0);
}

main().catch((err) => {
  logHookError(__filename, err);
  process.exit(blockState.didBlock ? 2 : 0);
});
