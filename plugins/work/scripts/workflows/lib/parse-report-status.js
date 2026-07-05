'use strict';

const AppAccessStatus = require('../check/lib/app-access-status');

// ---------------------------------------------------------------------------
// Icons — keyed by normalized status (Object.create(null) per convention)
// ---------------------------------------------------------------------------
const ICONS = Object.create(null);
ICONS['APPROVED'] = '✅';
ICONS['NEEDS_WORK'] = '❌';
ICONS['MISSING'] = '❓';
ICONS['NOT_APPLICABLE'] = '➖';
ICONS['UNKNOWN'] = '❓';
ICONS['INFRASTRUCTURE_FAILURE'] = '🛑';
ICONS['ACCESS_FAILED'] = '🔒';

// ---------------------------------------------------------------------------
// Status normalization — maps raw values to canonical statuses.
// Base aliases apply to all types; type-specific overrides extend them.
// ---------------------------------------------------------------------------
const BASE_ALIASES = Object.create(null);
BASE_ALIASES['APPROVED'] = 'APPROVED';
BASE_ALIASES['PASS'] = 'APPROVED';
BASE_ALIASES['PASSED'] = 'APPROVED';
BASE_ALIASES['NEEDS_WORK'] = 'NEEDS_WORK';
BASE_ALIASES['FAIL'] = 'NEEDS_WORK';
BASE_ALIASES['FAILED'] = 'NEEDS_WORK';
BASE_ALIASES['INCOMPLETE'] = 'NEEDS_WORK';
BASE_ALIASES['PENDING'] = 'NEEDS_WORK';
BASE_ALIASES['NOT_APPLICABLE'] = 'NOT_APPLICABLE';

// Per-type alias maps extend BASE_ALIASES with type-specific keywords.
// tests must use explicit APPROVED/PASS/PASSED.
const TYPE_ALIASES = Object.create(null);
TYPE_ALIASES['completion'] = Object.assign(Object.create(null), BASE_ALIASES, {
  COMPLETE: 'APPROVED',
  DELIVERED: 'APPROVED',
});
// codeReview accepts WELL_IMPLEMENTED — the code-checker agent template's
// real-world verdict wording ("## Overall Assessment: ✅ Well-Implemented").
TYPE_ALIASES['codeReview'] = Object.assign(Object.create(null), BASE_ALIASES, {
  WELL_IMPLEMENTED: 'APPROVED',
});
// QA accepts SUCCESS as APPROVED (used by QA report generators),
// and recognizes infrastructure/access failure statuses from write-qa-report.js.
TYPE_ALIASES['qa'] = Object.assign(Object.create(null), BASE_ALIASES, {
  SUCCESS: 'APPROVED',
  INFRASTRUCTURE_FAILURE: 'NEEDS_WORK',
  ACCESS_FAILED: 'NEEDS_WORK',
});
// Fallback for types without overrides
const STATUS_ALIASES = BASE_ALIASES;

/**
 * Resolve a raw status string to a canonical status, scoped by report type.
 * @param {string} raw - uppercase raw status value
 * @param {string} [type] - report type for type-specific aliases
 * @returns {string|undefined}
 */
function resolveAlias(raw, type) {
  const typeMap = type && TYPE_ALIASES[type];
  if (typeMap && typeMap[raw] !== undefined) return typeMap[raw];
  return STATUS_ALIASES[raw];
}

// ---------------------------------------------------------------------------
// Per-type marker patterns (migrated from check-generate-summary.js)
// Uses Object.create(null) for all lookup maps per project convention.
// ---------------------------------------------------------------------------
const TYPE_CHECKS = Object.create(null);

TYPE_CHECKS['tests'] = Object.create(null);
TYPE_CHECKS['tests'].fail = [
  '❌ FAIL',
  'NEEDS_WORK',
  '(?:^|\\n)(?:ℹ\\s*)?fail(?:ed)?\\s+[1-9]\\d*',
];
TYPE_CHECKS['tests'].pass = ['✅ PASS', '\\bAPPROVED\\b', '\\bAll\\b.*\\bpass'];

TYPE_CHECKS['codeReview'] = Object.create(null);
TYPE_CHECKS['codeReview'].fail = ['(?<!No )CRITICAL(?!\\s*ISSUES?\\b)', 'NEEDS_WORK'];
TYPE_CHECKS['codeReview'].pass = [
  '\\bAPPROVED\\b',
  '\\bWell[- ]Implemented\\b',
  '\\bNo critical issues\\b',
  '\\bNo issues found\\b',
];

TYPE_CHECKS['qa'] = Object.create(null);
TYPE_CHECKS['qa'].fail = [
  '❌ FAIL',
  'FAILED:\\s*[1-9]',
  'failures:\\s*[1-9]',
  'Status:\\s*FAIL',
  'Status:\\s*NEEDS_WORK',
];
TYPE_CHECKS['qa'].pass = [
  '✅ PASS',
  '\\bAll tests passed\\b',
  '(?:^|\\n)\\s*SUCCESS\\s*(?:\\n|$)',
  'Status:\\s*SUCCESS',
  'Status:\\s*APPROVED',
];

TYPE_CHECKS['completion'] = Object.create(null);
TYPE_CHECKS['completion'].fail = ['\\bINCOMPLETE\\b', '\\bPENDING\\b'];
TYPE_CHECKS['completion'].pass = ['\\bCOMPLETE\\b', '\\bDELIVERED\\b'];

// ---------------------------------------------------------------------------
// Status line regex — shared with validate-check-report-status.js
// ---------------------------------------------------------------------------
const STATUS_LINE_RE = /^\s*\*{0,2}Status:\*{0,2}\s*\*{0,2}\s*([A-Z_]+)\s*\*{0,2}/im;

// ---------------------------------------------------------------------------
// Format checkers — each returns a normalized status string or null
// ---------------------------------------------------------------------------

/**
 * Check for QA-specific infrastructure/access failures.
 * Only applies to 'qa' type reports.
 * @param {string} content
 * @param {string} type
 * @returns {string|null}
 */
function checkInfrastructureFailure(content, type) {
  if (type !== 'qa') return null;
  if (
    content.includes('INFRASTRUCTURE_FAILURE') ||
    content.includes('PLAYWRIGHT_UNAVAILABLE') ||
    content.includes('PLAYWRIGHT UNAVAILABLE')
  ) {
    return 'INFRASTRUCTURE_FAILURE';
  }
  if (content.includes(AppAccessStatus.ACCESS_FAILED)) {
    return 'ACCESS_FAILED';
  }
  return null;
}

// Negation words that neutralize a fail marker when they appear earlier in the
// same clause (echo-5349: "**NOT incomplete** for THIS ticket" must not force
// NEEDS_WORK). Clause = text since the last sentence/clause boundary.
const NEGATION_WORD_RE = /\b(?:not|no|none|never|isn'?t|aren'?t|wasn'?t|weren'?t)\b/i;
const CLAUSE_BOUNDARY_CHARS = ['\n', '.', ';', ':', ',', '!', '?'];

/**
 * True when the match at `matchIndex` is preceded by a negation word within
 * the same clause (no sentence/clause boundary between the negation and the marker).
 * @param {string} content
 * @param {number} matchIndex
 * @returns {boolean}
 */
function isNegatedAt(content, matchIndex) {
  const before = content.slice(0, matchIndex);
  let boundary = -1;
  for (const ch of CLAUSE_BOUNDARY_CHARS) {
    const idx = before.lastIndexOf(ch);
    if (idx > boundary) boundary = idx;
  }
  const clause = before.slice(boundary + 1);
  return NEGATION_WORD_RE.test(clause);
}

/**
 * Check for type-specific fail markers.
 * Fail markers are checked first to enforce fail-first precedence (R10).
 * Negation-aware: a marker occurrence preceded by not/no/none/isn't/... within
 * the same clause is ignored; any non-negated occurrence still fails.
 * @param {string} content
 * @param {string} type
 * @returns {string|null}
 */
function checkFailMarkers(content, type) {
  const checks = TYPE_CHECKS[type];
  if (!checks) return null;
  for (const pattern of checks.fail) {
    const re = new RegExp(pattern, 'gi');
    let m;
    while ((m = re.exec(content)) !== null) {
      if (!isNegatedAt(content, m.index)) {
        return 'NEEDS_WORK';
      }
      // Zero-width safety for exotic patterns
      if (m.index === re.lastIndex) re.lastIndex++;
    }
  }
  return null;
}

/**
 * Check for explicit Status: line (with optional bold markdown).
 * Matches: Status: APPROVED, **Status:** **APPROVED**, **Status:** APPROVED
 * @param {string} content
 * @param {string} [type] - report type for type-scoped alias resolution
 * @returns {string|null}
 */
function checkStatusLine(content, type) {
  // Match the FIRST Status: at start of line (^ with multiline). The top-level
  // declaration is authoritative — later Status: tokens in embedded output must
  // not override it. If the first Status: line's value is not recognized for this
  // type, return UNKNOWN to prevent heuristic fallback from overriding an explicit
  // (but type-invalid) declaration.
  const match = content.match(STATUS_LINE_RE);
  if (!match) return null;
  const raw = match[1].toUpperCase();
  const resolved = resolveAlias(raw, type);
  return resolved || 'UNKNOWN';
}

/**
 * Check for status in a markdown summary table.
 * Matches: | Status | APPROVED |
 * @param {string} content
 * @param {string} [type] - report type for type-scoped alias resolution
 * @returns {string|null}
 */
function checkSummaryTable(content, type) {
  const match = content.match(/\|\s*Status\s*\|\s*\*{0,2}([A-Z_]+)\*{0,2}\s*\|/i);
  if (!match) return null;
  const raw = match[1].toUpperCase();
  // Return UNKNOWN for type-invalid values to prevent heuristic fallback.
  return resolveAlias(raw, type) || 'UNKNOWN';
}

/**
 * Check for type-specific pass markers.
 * @param {string} content
 * @param {string} type
 * @returns {string|null}
 */
function checkPassMarkers(content, type) {
  const checks = TYPE_CHECKS[type];
  if (!checks) return null;
  for (const pattern of checks.pass) {
    if (new RegExp(pattern, 'i').test(content)) {
      return 'APPROVED';
    }
  }
  return null;
}

/**
 * Freeform status patterns — a P1 fallback that catches status declarations
 * agents emit outside of the canonical "Status: <VALUE>" line or summary
 * table. Checked in order; `kind` selects how the capture resolves:
 *   - 'alias'           → resolveAlias(match.toUpperCase(), type)
 *   - 'alias-normalize' → like 'alias' but [-_ ] squashed to '_' first
 *   - 'icon'            → ✅ = APPROVED, ❌ = NEEDS_WORK (unconditional)
 */
const FREEFORM_PATTERNS = [
  // 1. Standalone bold status on own line: **APPROVED**, **NEEDS_WORK**, etc.
  {
    re: /^\s*\*{2}(APPROVED|NEEDS_WORK|COMPLETE|INCOMPLETE|PASS|PASSED|FAIL|FAILED)\*{2}\s*$/im,
    kind: 'alias',
  },
  // 2. "Overall Assessment: <status>" — includes the code-checker agent's
  //    real-world verdict wording "✅ Well-Implemented" (echo-5219/echo-5349)
  {
    re: /Overall\s+Assessment:\s*(?:✅|❌)?\s*(Approved|Needs[_ ]Work|Pass|Fail|Well[- ]Implemented)/im,
    kind: 'alias-normalize',
  },
  // 2b. Icon-only "Overall Assessment: ✅ / ❌" — the code-checker report
  //     template's verdict line when no word follows the icon.
  { re: /Overall\s+Assessment:\s*(✅|❌)\s*$/im, kind: 'icon' },
  // 3. "Final Status:" verdict — completion-checker template writes
  //    "### Final Status:" followed by "[COMPLETE]" on the next line.
  {
    re: /Final\s+Status:?\s*\n{0,2}\s*\*{0,2}\[?(COMPLETE|INCOMPLETE|APPROVED|NEEDS_WORK|DELIVERED)\]?\*{0,2}/i,
    kind: 'alias',
  },
  // 4. "Result: <status>"
  { re: /Result:\s*(APPROVED|NEEDS_WORK|COMPLETE|INCOMPLETE|PASS|FAIL)/im, kind: 'alias' },
  // 5. Standalone status at line start followed by dash: COMPLETE — ...
  { re: /^(COMPLETE|APPROVED|NEEDS_WORK|INCOMPLETE)\s*[—–-]/m, kind: 'alias' },
];

/**
 * Check for freeform status patterns in report content (GH-326).
 * Only returns a value when the raw match resolves via resolveAlias for the
 * given type. Returns null otherwise (lets other checks handle it).
 *
 * @param {string} content
 * @param {string} [type] - report type for type-scoped alias resolution
 * @returns {string|null}
 */
function checkFreeformStatus(content, type) {
  for (const { re, kind } of FREEFORM_PATTERNS) {
    const match = content.match(re);
    if (!match) continue;
    if (kind === 'icon') return match[1] === '✅' ? 'APPROVED' : 'NEEDS_WORK';
    const raw =
      kind === 'alias-normalize'
        ? match[1].replace(/[-_ ]/g, '_').toUpperCase()
        : match[1].toUpperCase();
    const resolved = resolveAlias(raw, type);
    if (resolved) return resolved;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse the status from report file content.
 *
 * Resolution priority (matches implementation order):
 *   1. Explicit Status: line (first match, authoritative when present)
 *   2. Summary table with status column
 *   2.5. Freeform fallback patterns (GH-326)
 *   3. Infrastructure failures (QA only — after Status line so declared status wins)
 *   4. Fail markers (type-specific heuristics, only when no explicit status)
 *   5. Pass markers (type-specific heuristics)
 *   6. Fallback: UNKNOWN
 *
 * @param {string|null|undefined} content - report file content
 * @param {string} type - one of 'tests', 'codeReview', 'qa', 'completion'
 * @returns {{ status: string, icon: string }}
 */
function parseReportStatus(content, type) {
  // R9: null / undefined / empty -> MISSING
  if (!content || !content.trim()) {
    return { status: 'MISSING', icon: ICONS['MISSING'] };
  }

  // Ordered checks — see the priority list above. Infrastructure failures
  // (QA only) run AFTER explicit Status/table so that a declared
  // Status: NOT_APPLICABLE or Status: APPROVED is honored even when the
  // report body mentions infrastructure tokens like PLAYWRIGHT_UNAVAILABLE
  // in prose. Fail markers run only when no explicit status was declared.
  const orderedChecks = [
    checkStatusLine,
    checkSummaryTable,
    checkFreeformStatus,
    checkInfrastructureFailure,
    checkFailMarkers,
    checkPassMarkers,
  ];
  for (const check of orderedChecks) {
    const status = check(content, type);
    if (status) {
      return { status, icon: ICONS[status] || ICONS['UNKNOWN'] };
    }
  }

  // Unknown type or no match
  return { status: 'UNKNOWN', icon: ICONS['UNKNOWN'] };
}

// Reply-decision parsing and code-review resolution live in
// parse-report-resolution.js — re-exported here for backward compatibility.
const { parseReplyDecisions, isCodeReviewResolved } = require('./parse-report-resolution');

module.exports = {
  parseReportStatus,
  parseReplyDecisions,
  isCodeReviewResolved,
  resolveAlias,
  STATUS_LINE_RE,
};
