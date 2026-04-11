/**
 * workflows/work/lib/open-questions.js
 *
 * Pure-logic parser/classifier for the `## Open Questions` section of a
 * brief.md document. No I/O, no side effects, no external dependencies.
 *
 * Public API:
 *   - parse(markdown): Question[]
 *   - findBlocking(questions): Question[]
 *   - classify(scope): 'local' | 'cross-ticket' | 'architectural' | 'unknown'
 *   - applyResolutions(markdown, resolutions): string  — idempotent rewriter
 *   - escapeResolution(answer): string                 — injection-safe escape
 *   - SCOPES: readonly frozen allowlist of valid scope strings
 *
 * A Question is:
 *   {
 *     questionText: string,
 *     scope: 'local' | 'cross-ticket' | 'architectural',
 *     rationale: string,
 *     resolved: boolean,
 *     resolution?: string,
 *     startLine: number,   // 0-indexed, inclusive — the `- **Question:**` line
 *     endLine: number      // 0-indexed, inclusive — the LAST non-blank
 *                          //   content line of the block (never a trailing
 *                          //   blank separator). Consumers can safely use
 *                          //   `lines.slice(startLine, endLine + 1)` to
 *                          //   extract the block without picking up a
 *                          //   trailing blank or `split('\n')` artifact.
 *   }
 *
 * Fallback behavior (fail-open):
 *   - Legacy free-text bullets (no `scope:` subfield) coerce to
 *     { scope: 'local', resolved: true } so pre-existing briefs do not
 *     retroactively block the workflow.
 *   - Malformed structured blocks that look structured (indented subfields)
 *     but are missing `scope:` also coerce to { scope: 'local', resolved: true }.
 *   - Any parse failure returns [] rather than throwing.
 */

'use strict';

// ─── Constants ──────────────────────────────────────────────────────────────

/**
 * Allowlist of valid scope classifications. Frozen so downstream modules can
 * safely import and reference without fear of mutation.
 */
const SCOPES = Object.freeze(['local', 'cross-ticket', 'architectural']);

const OPEN_QUESTIONS_HEADING = /^##\s+Open Questions\s*$/;
// Match any ATX heading (h1..h6). A heading at any level after the
// `## Open Questions` line terminates the section — without this, an h1
// (e.g. a second top-level title later in a multi-document markdown) or
// an h3+ subheading would let the parser bleed into unrelated content.
const ANY_HEADING = /^#{1,6}\s+/;
const TOP_LEVEL_BULLET = /^-\s+/;
const QUESTION_BULLET = /^-\s+\*\*Question:\*\*\s*(.*)$/;
const LEGACY_BULLET = /^-\s+(.*)$/;
const SUBFIELD_LINE = /^\s{2,}-\s+`([^:`]+):\s*([^`]*)`\s*$/;
const RESOLUTION_LINE = /^\s{2,}-\s+\*\*Resolution:\*\*\s*(.*)$/;

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Locate the line range (inclusive start, exclusive end) of the
 * `## Open Questions` section. Returns null if there is no such section.
 */
function findSectionRange(lines) {
  const startIdx = lines.findIndex((line) => OPEN_QUESTIONS_HEADING.test(line));
  if (startIdx === -1) return null;

  // Scan from the line after the heading for the next `## ` heading.
  let endIdx = lines.length;
  for (let i = startIdx + 1; i < lines.length; i++) {
    if (ANY_HEADING.test(lines[i])) {
      endIdx = i;
      break;
    }
  }
  return { start: startIdx + 1, end: endIdx };
}

/**
 * Scan forward from `startIdx` inside a section and return the exclusive end
 * index of the current block. A block ends at:
 *   - the next top-level bullet (`- ` at column 0),
 *   - the section end, or
 *   - a blank line followed by anything that isn't a continuation indent.
 * For simplicity and robustness, we stop at the next top-level bullet or
 * section end; blank lines within a block are tolerated but contribute
 * nothing.
 */
function findBlockEnd(lines, startIdx, sectionEnd) {
  for (let i = startIdx + 1; i < sectionEnd; i++) {
    if (TOP_LEVEL_BULLET.test(lines[i])) return i; // next top-level bullet
  }
  return sectionEnd;
}

/**
 * Given the exclusive end of a block, walk backward to find the index of the
 * last non-blank line that actually belongs to this block. Returns a value
 * `>= blockStart` so the block is always at least one line wide (the header).
 * This tightens the `endLine` contract: consumers (e.g. Task 2's rewriter)
 * can slice `lines.slice(startLine, endLine + 1)` without picking up the
 * blank separator between blocks or the trailing empty element produced by
 * `split('\n')` on a trailing-newline string.
 */
function findLastContentLine(lines, blockStart, blockEnd) {
  let last = blockEnd - 1;
  while (last > blockStart && (lines[last] === undefined || lines[last].trim() === '')) {
    last -= 1;
  }
  return last;
}

/**
 * Extract key/value subfields and an optional resolution from a block's
 * interior lines. Returns `{ fields: Map, resolution?: string }`.
 * Keys are lowercased; values are trimmed.
 */
function readSubfields(blockLines) {
  const fields = new Map();
  let resolution;
  for (const line of blockLines) {
    const resMatch = line.match(RESOLUTION_LINE);
    if (resMatch) {
      resolution = resMatch[1].trim();
      continue;
    }
    const subMatch = line.match(SUBFIELD_LINE);
    if (subMatch) {
      fields.set(subMatch[1].trim().toLowerCase(), subMatch[2].trim());
    }
  }
  return { fields, resolution };
}

/**
 * Build a Question object from a range of lines. Applies fallback coercion
 * for legacy / malformed blocks.
 */
function buildQuestion(lines, blockStart, blockEnd) {
  const header = lines[blockStart];
  const questionMatch = header.match(QUESTION_BULLET);

  let questionText;
  if (questionMatch) {
    questionText = questionMatch[1].trim();
  } else {
    // Legacy-style bullet: `- <free text>` or `- **Label:** text`.
    // We still scan interior subfields — if the author supplied structured
    // metadata under a non-canonical header, we should honor it.
    const legacyMatch = header.match(LEGACY_BULLET);
    if (!legacyMatch) return null;
    questionText = legacyMatch[1].trim();
  }
  const interiorLines = lines.slice(blockStart + 1, blockEnd);

  const { fields, resolution } = readSubfields(interiorLines);
  const rawScope = fields.get('scope');
  const scopeClass = classify(rawScope);
  const endLine = findLastContentLine(lines, blockStart, blockEnd);

  // Fallback: missing or invalid scope → legacy/malformed coercion.
  if (!fields.has('scope') || scopeClass === 'unknown') {
    return {
      questionText,
      scope: 'local',
      rationale: fields.get('rationale') || '',
      resolved: true,
      startLine: blockStart,
      endLine,
    };
  }

  const rawResolved = (fields.get('resolved') || '').toLowerCase();
  const resolved = rawResolved === 'true';

  const question = {
    questionText,
    scope: scopeClass,
    rationale: fields.get('rationale') || '',
    resolved,
    startLine: blockStart,
    endLine,
  };

  if (resolution !== undefined) {
    question.resolution = resolution;
  }
  return question;
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Parse the `## Open Questions` section of a brief markdown document into
 * an array of Question objects. Never throws: malformed input produces
 * fallback entries or an empty array.
 */
function parse(markdown) {
  if (typeof markdown !== 'string' || markdown.length === 0) return [];

  const lines = markdown.split('\n');
  const range = findSectionRange(lines);
  if (!range) return [];

  const questions = [];
  let i = range.start;
  while (i < range.end) {
    if (TOP_LEVEL_BULLET.test(lines[i])) {
      const blockEnd = findBlockEnd(lines, i, range.end);
      const q = buildQuestion(lines, i, blockEnd);
      if (q) questions.push(q);
      i = blockEnd;
    } else {
      i += 1;
    }
  }
  return questions;
}

/**
 * Return the subset of questions that block the workflow: unresolved
 * `cross-ticket` or `architectural` scope.
 */
function findBlocking(questions) {
  if (!Array.isArray(questions)) return [];
  return questions.filter(
    (q) => q && !q.resolved && (q.scope === 'cross-ticket' || q.scope === 'architectural')
  );
}

/**
 * Normalize and validate a scope string. Unknown / empty / non-string input
 * maps to 'unknown'. All other valid scopes are returned in their canonical
 * lowercase form.
 */
function classify(scope) {
  if (typeof scope !== 'string') return 'unknown';
  const normalized = scope.trim().toLowerCase();
  if (!normalized) return 'unknown';
  return SCOPES.includes(normalized) ? normalized : 'unknown';
}

/**
 * (P1 extension point — Task 11)
 *
 * Downgrade a specific open question's scope to `'local'`, with a required
 * human-authored justification. This is the escape hatch referenced in
 * spec.md §Open Questions & Decisions and tasks.md R21: a way for authors
 * to acknowledge a cross-ticket or architectural question that would
 * otherwise block the workflow, and explicitly accept the risk of treating
 * it as local scope.
 *
 * P0 scope (this file): this stub exists as the designated anchor point so
 * Task 11's P1 implementation has an explicit contract to extend. It is
 * exported (throwing) so that any accidental caller fails loudly rather
 * than silently coercing behavior.
 *
 * P1 plan (Task 11):
 *   1. Accept `(questionText, justification)` where both are non-empty
 *      strings; reject empty justifications with a validation error.
 *   2. Return a mutation descriptor `{ questionText, newScope: 'local',
 *      justification, timestamp }` that Task 2's `applyResolutions`
 *      rewriter can consume to rewrite the block in-place, appending a
 *      `- \`downgrade-justification: <text>\`` subfield and setting the
 *      scope to `local`.
 *   3. The gate (Task 3) will then treat the downgraded question as
 *      non-blocking, preserving the author's decision in the brief file
 *      for audit.
 *
 * @param {string} _questionText  The exact text of the question to downgrade.
 * @param {string} _justification A non-empty human-authored justification.
 * @returns {never} Always throws until Task 11 implements it.
 * @throws {Error} with message containing "not implemented" and "P1".
 */
function downgradeToLocal(_questionText, _justification) {
  throw new Error('downgradeToLocal is not implemented — P1 escape hatch (Task 11)');
}

// ─── applyResolutions() + escapeResolution() ────────────────────────────────

/**
 * Sanitize a user-supplied answer before persisting it into brief.md.
 *
 * Threat model: the answer is written verbatim into a markdown file that is
 * later re-parsed by `parse()` and read by downstream agents (spec-writer,
 * split-in-tasks). A malicious or careless answer could:
 *   - start a new heading (`## Injected Heading`) and split the Open
 *     Questions section;
 *   - terminate or open a fenced code block (```); or
 *   - contain embedded newlines that would break the block's single-line
 *     bullet structure.
 *
 * Rules (all fail-closed — any questionable content is neutralized rather
 * than preserved):
 *   1. Non-string / empty / nullish input → return `''`.
 *   2. Collapse all embedded newlines (`\r\n`, `\n`, `\r`) to single spaces.
 *   3. Strip triple-backtick sequences anywhere in the string.
 *   4. Strip all leading `#` characters and the whitespace that follows so
 *      the answer cannot start a heading at the beginning of its line.
 *   5. Trim surrounding whitespace.
 *
 * The result is safe to splice into a `- **Resolution:** <answer>` line
 * without altering the surrounding parser-observable structure.
 */
function escapeResolution(answer) {
  if (typeof answer !== 'string' || answer.length === 0) return '';
  let out = answer;
  // Collapse newlines (handle CRLF before LF so we don't double-space).
  out = out.replace(/\r\n/g, ' ').replace(/[\r\n]+/g, ' ');
  // Remove triple-backtick sequences entirely — they have no legitimate
  // place in a single-line bullet, and they're the single biggest risk for
  // markdown fence injection.
  out = out.replace(/```/g, '');
  // Strip any leading `#` block (repeatedly, in case the input begins with
  // `## ## ...`), along with the whitespace immediately following it.
  out = out.replace(/^\s*(?:#+\s*)+/, '');
  // Final whitespace cleanup.
  out = out.trim();
  return out;
}

/**
 * Normalize a `resolutions` argument into a plain `Map<string, string>` so
 * callers can pass either a real Map or a plain object for ergonomics.
 * Non-string keys/values are dropped.
 */
function normalizeResolutions(resolutions) {
  const out = new Map();
  if (!resolutions) return out;
  if (resolutions instanceof Map) {
    for (const [k, v] of resolutions.entries()) {
      if (typeof k === 'string' && typeof v === 'string') out.set(k, v);
    }
    return out;
  }
  if (typeof resolutions === 'object') {
    for (const [k, v] of Object.entries(resolutions)) {
      if (typeof k === 'string' && typeof v === 'string') out.set(k, v);
    }
  }
  return out;
}

/**
 * Rewrite a `resolved: false` subfield line to `resolved: true`, preserving
 * the original indentation and surrounding formatting. If the line already
 * says `resolved: true`, return it unchanged.
 */
function flipResolvedLine(line) {
  return line.replace(/(`resolved:\s*)(false)(\s*`)/i, (_m, pre, _val, post) => `${pre}true${post}`);
}

/**
 * Build the `- **Resolution:** ...` line for a block, matching the
 * indentation of the block's existing subfield lines so the parser can
 * recognize it on re-read.
 */
function buildResolutionLine(blockLines, escaped) {
  // Find the indentation of an existing subfield line (they all start with
  // at least two spaces). Default to two spaces if we can't find one.
  let indent = '  ';
  for (const line of blockLines) {
    const match = line.match(/^(\s{2,})-\s+/);
    if (match) {
      indent = match[1];
      break;
    }
  }
  return `${indent}- **Resolution:** ${escaped}`;
}

/**
 * Rewrite `brief.md` markdown so that every question in `resolutions` is
 * marked resolved and gets a `Resolution:` subfield appended to its block.
 *
 * Guarantees:
 *   - **Idempotency.** A block whose parsed `resolved === true` is never
 *     touched, even if the caller passes a new answer for it. Running
 *     `applyResolutions` twice with the same resolutions produces byte-equal
 *     output.
 *   - **Injection safety.** User answers pass through `escapeResolution` so
 *     they cannot introduce new headings, fences, or block-boundary-breaking
 *     newlines. Re-parsing the rewritten markdown MUST yield the same
 *     `Question[]` count as the input.
 *   - **Minimal rewrite.** Lines outside the changed block are preserved
 *     byte-for-byte.
 *   - **No I/O.** Pure function. Invalid / empty / unknown-question
 *     resolutions are silent no-ops.
 *
 * The rewriter operates by:
 *   1. Parsing the input to locate each question block (with `startLine`
 *      and `endLine` ranges).
 *   2. Walking the question list from LAST to FIRST so that line indices
 *      computed by `parse()` remain valid as we splice new lines in.
 *   3. For each match: flipping an in-block `resolved: false` subfield to
 *      `resolved: true` and inserting an escaped `- **Resolution:** …` line
 *      immediately after the block's last content line.
 *
 * @param {string} markdown
 * @param {Map<string,string>|Record<string,string>} resolutions
 * @returns {string}
 */
function applyResolutions(markdown, resolutions) {
  if (typeof markdown !== 'string' || markdown.length === 0) return markdown;

  const resMap = normalizeResolutions(resolutions);
  if (resMap.size === 0) return markdown;

  const questions = parse(markdown);
  if (questions.length === 0) return markdown;

  const lines = markdown.split('\n');

  // Walk LAST → FIRST so earlier indices stay stable as we splice.
  for (let i = questions.length - 1; i >= 0; i--) {
    const q = questions[i];
    if (!resMap.has(q.questionText)) continue;
    // Idempotency guard: never touch already-resolved blocks. The guard
    // intentionally uses the parser's definition of `resolved` (the boolean
    // on the Question object), which is derived solely from `resolved: true`
    // in the `resolved:` subfield line (see `buildQuestion`). A block that
    // carries a `**Resolution:**` sub-bullet but still has `resolved: false`
    // (an inconsistent manual-edit state) is treated as unresolved here.
    if (q.resolved === true) continue;

    const rawAnswer = resMap.get(q.questionText);
    const escaped = escapeResolution(rawAnswer);
    // Guard: if the sanitized answer collapses to empty (e.g. the user
    // supplied a pure-hash `"###"` or a whitespace-only string), skip the
    // rewrite entirely. Writing a dangling `- **Resolution:** ` line would
    // leave `resolution === ''` in the parsed block — a shape that differs
    // from both "unresolved" (`resolution === undefined`) and
    // "resolved with answer" and could confuse downstream consumers.
    // Leaving the block untouched means the gate re-prompts next pass.
    if (escaped === '') continue;

    // Flip the block's `resolved: false` line (if any) to `resolved: true`,
    // modifying the original `lines` array in place.
    let resolvedLineFlipped = false;
    for (let j = q.startLine; j <= q.endLine; j++) {
      const flipped = flipResolvedLine(lines[j]);
      if (flipped !== lines[j]) {
        lines[j] = flipped;
        resolvedLineFlipped = true;
        break;
      }
    }

    // If the block had no `resolved:` subfield at all (the parser defaults
    // to resolved: false), we must insert one so re-parsing yields
    // `resolved: true`. Use the same indentation as sibling subfields.
    let insertionPoint = q.endLine + 1;
    if (!resolvedLineFlipped) {
      const blockLines = lines.slice(q.startLine, q.endLine + 1);
      let indent = '  ';
      for (const bl of blockLines) {
        const m = bl.match(/^(\s{2,})-\s+/);
        if (m) { indent = m[1]; break; }
      }
      lines.splice(insertionPoint, 0, `${indent}- \`resolved: true\``);
      insertionPoint++; // Resolution line goes AFTER resolved: true
    }

    // Append a `- **Resolution:** ...` line right after the block's last
    // content line (or after the newly-inserted resolved: true line).
    // We splice rather than concatenate so interior blocks don't disturb
    // downstream content.
    const blockLines = lines.slice(q.startLine, q.endLine + 1);
    const resolutionLine = buildResolutionLine(blockLines, escaped);
    lines.splice(insertionPoint, 0, resolutionLine);
  }

  return lines.join('\n');
}

module.exports = {
  parse,
  findBlocking,
  classify,
  downgradeToLocal,
  applyResolutions,
  escapeResolution,
  SCOPES,
};
