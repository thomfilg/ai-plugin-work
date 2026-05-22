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
    '| Proposed component | Data inputs | Could be agnostic? | Decision | Rationale |',
    '|---|---|---|---|---|',
    '| `ExternalAssetLineage` | `{nodes, activeId}` | Yes | **Generic `LineagePanel`** | Three call sites need identical layout; data-only differences. |',
    '```',
    '',
    'One row per new UI component. Default to Generic for layout/list/sidebar/table/panel components consuming typed data; Specific requires a hard-constraint rationale. If no new UI components are proposed, include a single "N/A" row — the table is still required so the question is asked.',
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
