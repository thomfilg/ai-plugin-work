'use strict';

/**
 * Task-prompt detection (fail-closed): a Task prompt that references a
 * protected path is blocked unless it is clearly read-only.
 */

const TASK_READONLY_PATTERNS = [
  /\b(?:read|cat|head|tail|less|more|view|inspect|examine|list|ls|find|grep|search|check|verify|summarize|review|analyze|parse|count|show|display|print|look\s+at|open\s+and\s+read)\b/i,
];

const TASK_WRITE_SIGNALS = [
  /\b(?:writeFileSync|appendFileSync|writeFile|createWriteStream|unlinkSync|rmSync)\b/i,
  /\b(?:write|overwrite|replace|delete|remove|append|modify|update|change|edit|fix|patch|rewrite|create|add|insert)\b/i,
  />\s*["']?/,
  /\b(?:sed\s+-i|cp\s|mv\s|rm\s|touch|mkdir|chmod|ln\s|tee\s)\b/i,
  /\b(?:echo|cat|printf)\s+.*>/i,
];

const TASK_CONJUNCTION_PATTERNS = [/\b(?:then|and then|after that|finally|next|afterward)\b/i];

function isReadOnlyTaskPrompt(text) {
  for (const pattern of TASK_WRITE_SIGNALS) if (pattern.test(text)) return false;
  if (!TASK_READONLY_PATTERNS.some((p) => p.test(text))) return false;
  for (const pattern of TASK_CONJUNCTION_PATTERNS) if (pattern.test(text)) return false;
  return true;
}

module.exports = { isReadOnlyTaskPrompt };
