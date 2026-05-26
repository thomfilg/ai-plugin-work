/**
 * Completion-checker context enrichment.
 *
 * Reads planning artifacts (ticket.json, brief.md, spec.md, tasks.md) and
 * builds a structured verification prompt. The completion-checker agent
 * receives pre-loaded context instead of having to discover it.
 *
 * Verification order (each layer builds on the previous):
 *   1. ticket.json → original requirements from the ticket
 *   2. brief.md → P0/P1/P2 requirements, constraints, acceptance criteria
 *   3. spec.md → architecture decisions, reuse audit, files to modify
 *   4. tasks.md → per-task deliverables and acceptance criteria
 *
 * The agent verifies each layer against the actual code diff.
 */

'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Build completion-checker context from planning artifacts.
 *
 * @param {string} tasksDir — path to the ticket's tasks directory
 * @param {string} ticketId — ticket identifier
 * @returns {string} structured prompt section with all context
 */
function buildCompletionContext(tasksDir, ticketId) {
  const sections = [];

  // ── Layer 1: Ticket ────────────────────────────────────────────────────────
  const ticketPath = path.join(tasksDir, 'ticket.json');
  let ticketTitle = '';
  let ticketBody = '';
  try {
    const ticket = JSON.parse(fs.readFileSync(ticketPath, 'utf8'));
    ticketTitle = ticket.title || '';
    ticketBody = ticket.body || ticket.description || '';
  } catch {
    // No ticket.json — skip layer
  }

  if (ticketTitle || ticketBody) {
    sections.push(
      '## Layer 1: Ticket Requirements',
      '',
      `**Title:** ${ticketTitle}`,
      '',
      ticketBody ? ticketBody.substring(0, 2000) : '(no description)',
      '',
      '**Verify:** Does the code change address what the ticket asked for?',
      ''
    );
  }

  // ── Layer 2: Brief ─────────────────────────────────────────────────────────
  const briefPath = path.join(tasksDir, 'brief.md');
  let briefContent = '';
  try {
    briefContent = fs.readFileSync(briefPath, 'utf8');
  } catch {
    // No brief — skip layer
  }

  if (briefContent) {
    // Extract requirements section
    const reqMatch = briefContent.match(/## Requirements[\s\S]*?(?=\n## [A-Z]|\n---|\n# |$)/i);
    const requirements = reqMatch ? reqMatch[0].trim() : '';

    // Extract acceptance criteria / success metrics
    const acMatch = briefContent.match(
      /## (?:Acceptance Criteria|Success Metrics)[\s\S]*?(?=\n## [A-Z]|\n---|\n# |$)/i
    );
    const acceptanceCriteria = acMatch ? acMatch[0].trim() : '';

    sections.push(
      '## Layer 2: Brief Requirements',
      '',
      requirements || '(no requirements section found in brief.md)',
      '',
      acceptanceCriteria || '',
      '',
      '**Verify:** For EACH P0/P1 requirement, grep the code diff to confirm it was implemented.',
      ''
    );
  }

  // ── Layer 3: Spec ──────────────────────────────────────────────────────────
  const specPath = path.join(tasksDir, 'spec.md');
  let specContent = '';
  try {
    specContent = fs.readFileSync(specPath, 'utf8');
  } catch {
    // No spec — skip layer
  }

  if (specContent) {
    // Extract architecture decisions
    const archMatch = specContent.match(
      /## Architecture Decisions[\s\S]*?(?=\n## [A-Z]|\n---|\n# |$)/i
    );
    const architecture = archMatch ? archMatch[0].trim() : '';

    // Extract reuse audit
    const reuseMatch = specContent.match(/## Reuse Audit[\s\S]*?(?=\n## [A-Z]|\n---|\n# |$)/i);
    const reuseAudit = reuseMatch ? reuseMatch[0].trim() : '';

    // Extract files to modify
    const filesMatch = specContent.match(
      /## Files to Create\/Modify[\s\S]*?(?=\n## [A-Z]|\n---|\n# |$)/i
    );
    const filesToModify = filesMatch ? filesMatch[0].trim() : '';

    sections.push(
      '## Layer 3: Spec Verification',
      '',
      architecture || '(no architecture decisions found)',
      '',
      reuseAudit ? reuseAudit.substring(0, 1500) : '',
      '',
      filesToModify || '',
      '',
      '**Verify:**',
      '- Were existing components reused (not duplicated)?',
      '- Were architecture decisions followed?',
      '- Were all listed files actually modified?',
      ''
    );
  }

  // ── Layer 4: Tasks ─────────────────────────────────────────────────────────
  const tasksPath = path.join(tasksDir, 'tasks.md');
  let tasksContent = '';
  try {
    tasksContent = fs.readFileSync(tasksPath, 'utf8');
  } catch {
    // No tasks — skip layer
  }

  if (tasksContent) {
    // Parse each task's acceptance criteria
    const taskBlocks = tasksContent.split(/^## Task (\d+)/m);
    const taskVerifications = [];

    for (let i = 1; i < taskBlocks.length; i += 2) {
      const num = taskBlocks[i];
      const body = taskBlocks[i + 1] || '';

      // Extract title
      const titleMatch = body.match(/^[\s]*[—–-]+\s*(.+?)$/m);
      const title = titleMatch ? titleMatch[1].trim() : `Task ${num}`;

      // Extract type
      const typeMatch = body.match(/### Type\s*\n([^\n#]+)/);
      const type = typeMatch ? typeMatch[1].trim().toLowerCase() : 'unknown';

      // Extract acceptance criteria
      const acMatch = body.match(/### Acceptance Criteria\s*\n([\s\S]*?)(?=\n###|\n## |$)/);
      const ac = acMatch ? acMatch[1].trim() : '';

      // Extract suggested scope
      const scopeMatch = body.match(/### Suggested Scope[^\n]*\n([\s\S]*?)(?=\n###|\n## |$)/);
      const scope = scopeMatch ? scopeMatch[1].trim() : '';

      taskVerifications.push(
        `### Task ${num} — ${title} (${type})`,
        ac ? `**Acceptance Criteria:**\n${ac}` : '(no acceptance criteria)',
        scope
          ? `**Files:** ${scope
              .split('\n')
              .map((l) => l.trim())
              .filter(Boolean)
              .join(', ')}`
          : '',
        `**Verify:** Check each criterion against the code diff for this task's files.`,
        ''
      );
    }

    if (taskVerifications.length > 0) {
      sections.push(
        '## Layer 4: Per-Task Verification',
        '',
        'For EACH task below, verify acceptance criteria against the actual code:',
        '',
        ...taskVerifications
      );
    }

    // Extract requirement coverage table
    const coverageMatch = tasksContent.match(/## Requirement Coverage[\s\S]*$/i);
    if (coverageMatch) {
      sections.push(
        '## Requirement Coverage Table',
        '',
        coverageMatch[0].trim(),
        '',
        '**Verify:** Every requirement in this table must be DELIVERED with code evidence.',
        ''
      );
    }
  }

  if (sections.length === 0) {
    return '(No planning artifacts found — verify against the original request only)';
  }

  return sections.filter(Boolean).join('\n');
}

module.exports = { buildCompletionContext };
