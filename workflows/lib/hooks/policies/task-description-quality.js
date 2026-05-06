/**
 * policies/task-description-quality.js
 *
 * Pure policy function that validates tasks.md content for vague or
 * placeholder task descriptions. Returns a structured result indicating
 * whether any tasks contain blocked patterns.
 *
 * Design constraints:
 *   - CommonJS, zero dependencies
 *   - Pure functions, no I/O or side effects
 *   - Object.create(null) for any internal maps
 *   - Case-insensitive matching (R5)
 *   - No false positives for qualified descriptions (R8)
 *   - Only scans within ## Task N sections (R12)
 *   - TDD phase prefixes (**RED:**) exempt from "Add tests" pattern (R13)
 */

/** Minimum chars of qualifying detail after a trigger phrase (R8). */
const QUALIFY_THRESHOLD = 20;

/**
 * Patterns that are always blocked (no qualification possible).
 * @type {Array<{pattern: RegExp, label: string, hint: string, qualifiable: boolean}>}
 */
const BLOCKED_PATTERNS = Object.freeze([
  {
    pattern: /\btbd\b/i,
    label: 'TBD',
    hint: 'Replace the TBD placeholder with a concrete description of what this task delivers.',
    qualifiable: false,
  },
  {
    pattern: /\btodo\b/i,
    label: 'TODO',
    hint: 'Replace the TODO placeholder with specific implementation details.',
    qualifiable: false,
  },
  {
    pattern: /\bimplement later\b/i,
    label: 'implement later',
    hint: 'Remove the deferral phrase and describe what should be implemented now, or move to a separate task.',
    qualifiable: true,
  },
  {
    pattern: /\bto be determined\b/i,
    label: 'to be determined',
    hint: 'Replace with a concrete decision or escalate to the spec phase.',
    qualifiable: false,
  },
  {
    pattern: /\bhandle\s+(?:the\s+)?edge\s+cases?\b/i,
    label: 'Handle edge cases',
    hint: 'Specify which edge cases to handle (e.g. null input, empty array, overflow).',
    qualifiable: true,
  },
  {
    pattern: /\badd\s+(?:appropriate\s+)?error\s+handling\b/i,
    label: 'Add appropriate error handling',
    hint: 'Specify which error types to handle and the handling strategy (retry, fallback, abort).',
    qualifiable: true,
  },
  {
    pattern: /\badd\s+tests?\b/i,
    label: 'Add tests',
    hint: 'List specific test scenarios (e.g. "test that invalid input returns 400").',
    qualifiable: true,
  },
  {
    pattern: /\b(?:similar|same)\s+(?:as|to)\s+task\s+\d+/i,
    label: 'Similar/Same as Task N',
    hint: 'Repeat the actual steps instead of cross-referencing another task.',
    qualifiable: false,
  },
]);

/**
 * Check whether a line has enough qualifying detail after the trigger phrase.
 * @param {string} line
 * @param {RegExp} pattern
 * @returns {boolean} true if the line is sufficiently qualified
 */
function isQualified(line, pattern) {
  const match = pattern.exec(line);
  if (!match) return false;
  const afterMatch = line.slice(match.index + match[0].length);
  return afterMatch.length >= QUALIFY_THRESHOLD;
}

/**
 * Check whether a line starts with a TDD phase prefix like **RED:** or **GREEN:**.
 * @param {string} line — trimmed line
 * @returns {boolean}
 */
function hasTddPrefix(line) {
  return /\*\*(?:RED|GREEN|REFACTOR):\*\*/i.test(line);
}

/**
 * Extract task sections from tasks.md content.
 * Only returns content within ## Task N sections; stops at
 * ## Requirement Coverage or similar trailing sections.
 *
 * @param {string} content
 * @returns {Array<{taskId: string, body: string}>}
 */
function extractTaskSections(content) {
  const sections = [];
  const lines = content.split('\n');
  let currentTask = null;
  let bodyLines = [];

  for (const line of lines) {
    // Stop scanning at trailing non-task sections
    if (/^##\s+Requirement\s+Coverage\b/i.test(line)) {
      // Flush current task
      if (currentTask) {
        sections.push({ taskId: currentTask, body: bodyLines.join('\n') });
        currentTask = null;
        bodyLines = [];
      }
      break;
    }

    const taskMatch = line.match(/^##\s+Task\s+(\d+)\b/);
    if (taskMatch) {
      // Flush previous task
      if (currentTask) {
        sections.push({ taskId: currentTask, body: bodyLines.join('\n') });
      }
      currentTask = `Task ${taskMatch[1]}`;
      bodyLines = [line]; // include the header line itself for patterns in title
      continue;
    }

    if (currentTask) {
      bodyLines.push(line);
    }
  }

  // Flush last task
  if (currentTask) {
    sections.push({ taskId: currentTask, body: bodyLines.join('\n') });
  }

  return sections;
}

/**
 * Validate tasks.md content for vague or placeholder descriptions.
 *
 * @param {string} content — full text of tasks.md
 * @returns {{ blocked: boolean, message?: string, violations?: Array<{task: string, pattern: string, hint: string}> }}
 */
function validateTaskDescriptions(content) {
  if (!content || typeof content !== 'string') {
    return { blocked: false };
  }

  const sections = extractTaskSections(content);
  const violations = [];

  for (const section of sections) {
    const sectionLines = section.body.split('\n');

    for (const rawLine of sectionLines) {
      const line = rawLine.trim();
      if (!line) continue;

      for (const entry of BLOCKED_PATTERNS) {
        if (!entry.pattern.test(line)) continue;

        // TDD prefix exemption (R13): lines like "**RED:** Add tests for ..."
        // Only applies to qualifiable patterns — non-qualifiable patterns like
        // TBD/TODO must still be blocked even on TDD-prefixed lines.
        if (entry.qualifiable && hasTddPrefix(line)) continue;

        // Qualification check (R8): if the pattern is qualifiable and the
        // line has enough detail after the trigger phrase, skip it.
        if (entry.qualifiable && isQualified(line, entry.pattern)) {
          continue;
        }

        violations.push({
          task: section.taskId,
          pattern: entry.label,
          hint: entry.hint,
        });

        // One violation per pattern per line is enough
        break;
      }
    }
  }

  // Deduplicate by (task, pattern) key — a pattern appearing on multiple
  // lines within the same task section should only emit one violation.
  const seen = Object.create(null);
  const deduped = [];
  for (const v of violations) {
    const key = `${v.task}\0${v.pattern}`;
    if (!seen[key]) {
      seen[key] = true;
      deduped.push(v);
    }
  }

  if (deduped.length === 0) {
    return { blocked: false };
  }

  const summary = deduped.map((v) => `  - ${v.task}: "${v.pattern}" — ${v.hint}`).join('\n');

  return {
    blocked: true,
    message: `Vague task descriptions detected:\n${summary}`,
    violations: deduped,
  };
}

/**
 * Returns the canonical list of blocked patterns.
 *
 * @returns {Array<{pattern: RegExp, label: string, hint: string}>}
 */
function getBlockedPatterns() {
  return BLOCKED_PATTERNS.map((p) => ({
    pattern: p.pattern,
    label: p.label,
    hint: p.hint,
  }));
}

module.exports = {
  validateTaskDescriptions,
  getBlockedPatterns,
};
