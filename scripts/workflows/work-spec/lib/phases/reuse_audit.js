/**
 * Phase: reuse_audit — enforce the existing "Reuse Audit" section of spec.md.
 *
 * Validates that spec.md contains:
 *   1. A `## Reuse Audit` section with non-trivial content.
 *   2. Evidence of a broad reuse search (codegraph or a `Codebase search:` /
 *      `Filesystem search:` subheading) AND a ticket-provider keyword search
 *      (`Linear search:` / `Jira search:` / `Issue search:` / `GitHub search:`
 *      subheading). The ECHO-4452 incident shipped 6 duplicate `Lineage*`
 *      components because the audit searched only the current branch for
 *      exact names and never scanned the project's other tickets.
 *   3. A `## Component Shape Decision` section that forces an explicit
 *      generic-vs-specific decision per new UI component (or an N/A row).
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { SPEC_PHASES } = require('../../spec-phase-registry');
const { parseShapeSection, parseShapeFromSpec } = require('../component-shape');

/**
 * Rationale anti-patterns: phrases that signal the author is avoiding the
 * Generic split for *organisational* reasons rather than naming a hard
 * technical constraint. Lifted directly from ECHO-4466's spec, which justified
 * a duplicate `LineageRow` by saying it "would force a cross-cutting change
 * to the asset-level file" — i.e. the work was deferred, not impossible.
 *
 * A Specific-only rationale must describe what makes the component
 * page-bound (page-local hook, route-scoped state, server-component
 * boundary, etc.). If it instead describes effort/risk/scope, reject it.
 */
const RATIONALE_ANTIPATTERNS = [
  {
    re: /cross[-\s]?cutting\s+change/i,
    hint: 'rewrite as: "the component depends on <page-local hook / route-scoped state> that cannot be lifted"',
  },
  {
    re: /out\s+of\s+scope/i,
    hint: 'scope is not a technical constraint — name what makes the component page-bound, or do the split',
  },
  {
    // Optional article between verb and object: "would force a refactor",
    // "would require the refactoring", etc. matches as well as the no-article
    // form. Mirrors the same allowance in the `defer` pattern below.
    re: /would\s+(force|require)\s+(a\s+|the\s+|some\s+)?(refactor|refactoring|modifying|modification|changing|change|touching)/i,
    hint: 'refactor effort is not a hard constraint — name a technical limit or do the split',
  },
  {
    re: /too\s+(risky|much\s+work|big|large|complex)/i,
    hint: 'risk/effort is not a hard constraint — name a technical limit or do the split',
  },
  {
    re: /premature\s+abstraction/i,
    hint: '"premature abstraction" is a smell on the FIRST occurrence; by the time the spec asks, the use-case is concrete — split it',
  },
  {
    re: /defer(red|ral)?\s+(to\s+|until\s+|for\s+)?(a\s+|the\s+|some\s+)?(another|future|later|next|follow[-\s]?up|backlog)/i,
    hint: 'deferring is not a hard constraint — file a follow-up ticket and do the split now',
  },
  {
    re: /YAGNI/i,
    hint: 'YAGNI does not apply when the broad-reuse search proves another page already needs the role',
  },
];

function findCrossSpecConflicts(tasksDir, currentRows) {
  // Walk siblings of tasksDir under TASKS_BASE for other spec.md files,
  // collect their Specific-only rows, and report stems shared with this
  // spec's Specific-only rows. The current ticket is excluded.
  const conflicts = [];
  const tasksBase = path.dirname(tasksDir);
  let entries = [];
  try {
    entries = fs.readdirSync(tasksBase, { withFileTypes: true });
  } catch {
    return conflicts;
  }
  const currentTicket = path.basename(tasksDir);
  const myStems = new Set(
    currentRows.filter((r) => r.isSpecificOnly && r.stem).map((r) => r.stem.toLowerCase())
  );
  if (myStems.size === 0) return conflicts;
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    if (ent.name === currentTicket) continue;
    const otherSpec = path.join(tasksBase, ent.name, 'spec.md');
    const { rows } = parseShapeFromSpec(otherSpec);
    for (const r of rows) {
      if (!r.isSpecificOnly || !r.stem) continue;
      if (myStems.has(r.stem.toLowerCase())) {
        conflicts.push({ otherTicket: ent.name, stem: r.stem, otherComponent: r.proposed });
      }
    }
  }
  return conflicts;
}

function readFile(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

function sliceSection(text, headerRe) {
  const m = text.match(headerRe);
  if (!m) return null;
  const after = text.slice(m.index + m[0].length);
  const next = after.match(/^##\s/m);
  return next ? after.slice(0, next.index) : after;
}

const CODEBASE_EVIDENCE_RE =
  /(codegraph_search|^\s{0,3}#{2,4}\s+(Codebase|Filesystem)\s+search:|^\s*[-*]\s*\*\*(Codebase|Filesystem)\s+search:)/im;
const PROVIDER_EVIDENCE_RE =
  /(^\s{0,3}#{2,4}\s+(Linear|Jira|Issue|GitHub)\s+search:|^\s*[-*]\s*\*\*(Linear|Jira|Issue|GitHub)\s+search:)/im;

function hasComponentShapeRow(section) {
  if (!section) return false;
  // Look for any markdown table row with at least 4 pipes (5 columns) after a
  // header row. We don't enforce specific content — only that the author
  // touched the table.
  const lines = section.split('\n');
  let sawHeader = false;
  for (const line of lines) {
    if (/^\s*\|/.test(line) && (line.match(/\|/g) || []).length >= 5) {
      if (!sawHeader) {
        sawHeader = true;
        continue;
      }
      // Skip the separator row (---|---|...).
      if (/^\s*\|[\s:|-]+\|\s*$/.test(line)) continue;
      // Any non-separator data row counts.
      return true;
    }
  }
  return false;
}

function validateArtifacts(tasksDir) {
  const errors = [];
  const specPath = path.join(tasksDir, 'spec.md');
  const spec = readFile(specPath);
  if (!spec) {
    errors.push(
      `Missing ${specPath}. spec.md must exist by the end of the draft phase, but a stub is required here so reuse_audit has somewhere to land.`
    );
    return errors;
  }
  const reuse = sliceSection(spec, /^##\s+Reuse Audit(?=\s|$)/im);
  if (!reuse || reuse.trim().length < 30) {
    errors.push(
      `spec.md is missing a non-trivial \`## Reuse Audit\` section (< 30 chars). List the existing helpers/components/types you considered (with file:line references) before proposing new code.`
    );
    return errors;
  }

  if (!CODEBASE_EVIDENCE_RE.test(reuse)) {
    errors.push(
      `\`## Reuse Audit\` is missing broad codebase-search evidence. Include either a \`codegraph_search('<stem>')\` call result or a "Codebase search:" / "Filesystem search:" subheading with stem-based fuzzy searches (e.g. \`**/components/**/*Lineage*\`). Exact-name searches on the current branch alone caused the ECHO-4452 duplicate-component incident.`
    );
  }
  if (!PROVIDER_EVIDENCE_RE.test(reuse)) {
    errors.push(
      `\`## Reuse Audit\` is missing project-wide ticket-keyword-search evidence. Add a "Linear search:" / "Jira search:" / "Issue search:" / "GitHub search:" subheading documenting a keyword scan of the whole project for tickets describing similar components. The Lineage tickets were spread across different epics; only a provider-wide search would have surfaced them.`
    );
  }

  const shape = sliceSection(spec, /^##\s+Component Shape Decision(?=\s|$)/im);
  if (!shape) {
    errors.push(
      `spec.md is missing a \`## Component Shape Decision\` section. For every NEW UI component proposed, add a row to the table deciding Generic (default for layout/list/sidebar/table/panel components consuming typed data) vs Specific (requires a hard-constraint rationale). If no new UI components are proposed, include a single "N/A" row — the table is still required so the question is asked.`
    );
  } else if (!hasComponentShapeRow(shape)) {
    errors.push(
      `\`## Component Shape Decision\` section exists but contains no decision rows. Add at least one table row deciding Generic vs Specific for each new UI component (or an "N/A" row if none).`
    );
  } else {
    // Rationale-quality + cross-spec checks on the parsed rows.
    const { rows } = parseShapeSection(spec);
    for (const row of rows) {
      // Unknown decisions must surface regardless of category — typos and
      // malformed cells (e.g. "Maybe", "TBD") need to fail the gate even
      // when they don't match Specific-only. This check sits BEFORE the
      // specific-only filter so it can fire on any row.
      if (row.kind === 'unknown') {
        errors.push(
          `\`## Component Shape Decision\` row "${row.proposed || '(unnamed)'}" has an unrecognised Decision cell ("${row.decision}"). Use "Split: Generic <Name> + Specific <Name>", "Specific-only", or "N/A".`
        );
        continue;
      }
      if (!row.isSpecificOnly) continue;
      for (const ap of RATIONALE_ANTIPATTERNS) {
        if (ap.re.test(row.rationale)) {
          errors.push(
            `\`## Component Shape Decision\` row "${row.proposed || '(unnamed)'}" is **Specific-only** with a non-technical rationale ("${row.rationale}"). ${ap.hint}.`
          );
        }
      }
    }
    const conflicts = findCrossSpecConflicts(tasksDir, rows);
    if (conflicts.length > 0) {
      const byStem = new Map();
      for (const c of conflicts) {
        if (!byStem.has(c.stem)) byStem.set(c.stem, new Set());
        byStem.get(c.stem).add(`${c.otherTicket}::${c.otherComponent}`);
      }
      for (const [stem, others] of byStem.entries()) {
        errors.push(
          `\`## Component Shape Decision\` declares **Specific-only** for stem "${stem}" but other in-flight spec(s) also chose Specific-only for the same stem: ${[...others].join(', ')}. Revisit the Generic split decision — multiple specs declaring the same role page-bound is the ECHO-4452 duplication pattern.`
        );
      }
    }
  }
  return errors;
}

function validate(ctx) {
  const errors = validateArtifacts(ctx.tasksDir);
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, summary: 'reuse audit recorded' };
}

function instructions(ctx) {
  const { ticket, tasksDir } = ctx;
  return [
    `# spec-next — Phase 2 of 8: REUSE AUDIT`,
    `Ticket: ${ticket}`,
    '',
    '### What you do',
    `Create or edit \`${path.join(tasksDir, 'spec.md')}\` and ensure it has TWO sections:`,
    '',
    '```markdown',
    '## Reuse Audit',
    '',
    '- `path/to/existing/helper.ts:42` — already does X; reused here.',
    '- `components/foo/Bar.tsx` — covers the empty-state pattern; mirror it.',
    '- (none found for Y — explicit miss, propose new code in §Files to Create/Modify)',
    '',
    '### Codebase search:',
    "- `codegraph_search('Lineage')` → 3 hits (asset, table-detail, workbook) — see Architecture Decisions for the consolidation plan.",
    '- Globs: `**/components/**/*Lineage*`, `**/shared/**/*Sidebar*` — N matches.',
    '',
    '### Linear search:',
    '- `mcp__linear__list_issues` keyword "Lineage" → ECHO-4466, ECHO-4487 ship sibling components in different epics. Decision: extract `LineagePanel` to `shared/`.',
    '```',
    '',
    'Audit must be concrete: include file paths and line numbers where applicable. List both REUSED items and EXPLICIT MISSES (so reviewers can challenge whether the miss is real).',
    '',
    'The Codebase search and Linear/Jira/Issue search subheadings (or a `codegraph_search` call result) are REQUIRED. Exact-name searches on the current branch alone caused the ECHO-4452 duplicate-component incident (6 near-identical `Lineage*` components).',
    '',
    '```markdown',
    '## Component Shape Decision',
    '',
    '| Proposed component | Data inputs | Other pages could use the generic part? | Decision | Rationale |',
    '|---|---|---|---|---|',
    '| `UsersTable` | `users[]` | Yes — every list page needs a Table | **Split: Generic `Table` + Specific `UsersTable`** | UsersTable picks columns and feeds rows into `Table`; layout/sort/empty-state live in the generic shell. |',
    '```',
    '',
    'Rule: if ANY other page could plausibly use the role (Table, Breadcrumb, Modal, Sidebar, Panel, List), split into a Generic shell in `shared/`/`ui/` plus a Specific wrapper for this page. Specific-only is allowed when the component is genuinely page-bound — name what makes it so. If no new UI components are proposed, include a single "N/A" row — the table is still required so the question is asked.',
    '',
    '### What I will check before advancing',
    `- \`spec.md\` exists`,
    `- \`## Reuse Audit\` section present with ≥ 30 chars of content`,
    `- Reuse Audit shows BOTH codebase-search evidence (\`codegraph_search\` or a "Codebase search:" / "Filesystem search:" subheading) AND a "Linear search:" / "Jira search:" / "Issue search:" / "GitHub search:" subheading`,
    `- \`## Component Shape Decision\` section present with ≥ 1 decision row`,
    '',
    'Re-invoke me to verify.',
    '',
  ].join('\n');
}

module.exports = function register(registerPhase) {
  registerPhase(SPEC_PHASES.reuse_audit, {
    next: SPEC_PHASES.surface_audit,
    validate,
    instructions,
  });
};

module.exports.validate = validate;
module.exports.instructions = instructions;
module.exports.validateArtifacts = validateArtifacts;
module.exports.hasComponentShapeRow = hasComponentShapeRow;
module.exports.CODEBASE_EVIDENCE_RE = CODEBASE_EVIDENCE_RE;
module.exports.PROVIDER_EVIDENCE_RE = PROVIDER_EVIDENCE_RE;
