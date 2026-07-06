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

// Read a file, returning '' when it is missing or unreadable (layer skipped).
function readFileOrEmpty(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
}

// Return the full matched section (group 0), trimmed, or '' when absent.
function extractSection(content, regex) {
  const m = content.match(regex);
  return m ? m[0].trim() : '';
}

// ── Layer 1: Ticket ─────────────────────────────────────────────────────────
function buildTicketLayer(tasksDir) {
  let ticketTitle = '';
  let ticketBody = '';
  try {
    const ticket = JSON.parse(fs.readFileSync(path.join(tasksDir, 'ticket.json'), 'utf8'));
    ticketTitle = ticket.title || '';
    ticketBody = ticket.body || ticket.description || '';
  } catch {
    return []; // No ticket.json — skip layer
  }

  if (!ticketTitle && !ticketBody) return [];
  return [
    '## Layer 1: Ticket Requirements',
    '',
    `**Title:** ${ticketTitle}`,
    '',
    ticketBody ? ticketBody.substring(0, 2000) : '(no description)',
    '',
    '**Verify:** Does the code change address what the ticket asked for?',
    '',
  ];
}

// ── Layer 2: Brief ──────────────────────────────────────────────────────────
function buildBriefLayer(tasksDir) {
  const briefContent = readFileOrEmpty(path.join(tasksDir, 'brief.md'));
  if (!briefContent) return [];

  const requirements = extractSection(
    briefContent,
    /## Requirements[\s\S]*?(?=\n## [A-Z]|\n---|\n# |$)/i
  );
  const acceptanceCriteria = extractSection(
    briefContent,
    /## (?:Acceptance Criteria|Success Metrics)[\s\S]*?(?=\n## [A-Z]|\n---|\n# |$)/i
  );

  return [
    '## Layer 2: Brief Requirements',
    '',
    requirements || '(no requirements section found in brief.md)',
    '',
    acceptanceCriteria || '',
    '',
    '**Verify:** For EACH P0/P1 requirement, grep the code diff to confirm it was implemented.',
    '',
  ];
}

// ── Layer 3: Spec ───────────────────────────────────────────────────────────
function buildSpecLayer(tasksDir) {
  const specContent = readFileOrEmpty(path.join(tasksDir, 'spec.md'));
  if (!specContent) return [];

  const architecture = extractSection(
    specContent,
    /## Architecture Decisions[\s\S]*?(?=\n## [A-Z]|\n---|\n# |$)/i
  );
  const reuseAudit = extractSection(
    specContent,
    /## Reuse Audit[\s\S]*?(?=\n## [A-Z]|\n---|\n# |$)/i
  );
  const filesToModify = extractSection(
    specContent,
    /## Files to Create\/Modify[\s\S]*?(?=\n## [A-Z]|\n---|\n# |$)/i
  );

  return [
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
    '',
  ];
}

// ── Layer 4: Tasks ──────────────────────────────────────────────────────────
// Build the verification block for a single `## Task N` section.
function buildTaskVerification(num, body) {
  const titleMatch = body.match(/^[\s]*[—–-]+\s*(.+?)$/m);
  const title = titleMatch ? titleMatch[1].trim() : `Task ${num}`;

  const typeMatch = body.match(/### Type\s*\n([^\n#]+)/);
  const type = typeMatch ? typeMatch[1].trim().toLowerCase() : 'unknown';

  const acMatch = body.match(/### Acceptance Criteria\s*\n([\s\S]*?)(?=\n###|\n## |$)/);
  const ac = acMatch ? acMatch[1].trim() : '';

  const scopeMatch = body.match(/### Files in scope[^\n]*\n([\s\S]*?)(?=\n###|\n## |$)/);
  const scope = scopeMatch ? scopeMatch[1].trim() : '';

  return [
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
    '',
  ];
}

function buildTasksLayer(tasksDir) {
  const tasksContent = readFileOrEmpty(path.join(tasksDir, 'tasks.md'));
  if (!tasksContent) return [];

  const out = [];

  // Parse each task's acceptance criteria
  const taskBlocks = tasksContent.split(/^## Task (\d+)/m);
  const taskVerifications = [];
  for (let i = 1; i < taskBlocks.length; i += 2) {
    taskVerifications.push(...buildTaskVerification(taskBlocks[i], taskBlocks[i + 1] || ''));
  }

  if (taskVerifications.length > 0) {
    out.push(
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
    out.push(
      '## Requirement Coverage Table',
      '',
      coverageMatch[0].trim(),
      '',
      '**Verify:** Every requirement in this table must be DELIVERED with code evidence.',
      ''
    );
  }

  return out;
}

/**
 * Build completion-checker context from planning artifacts.
 *
 * @param {string} tasksDir — path to the ticket's tasks directory
 * @param {string} ticketId — ticket identifier
 * @returns {string} structured prompt section with all context
 */
function buildCompletionContext(tasksDir, ticketId) {
  const sections = [
    ...buildTicketLayer(tasksDir),
    ...buildBriefLayer(tasksDir),
    ...buildSpecLayer(tasksDir),
    ...buildTasksLayer(tasksDir),
  ];

  if (sections.length === 0) {
    return '(No planning artifacts found — verify against the original request only)';
  }

  return sections.filter(Boolean).join('\n');
}

module.exports = { buildCompletionContext };
