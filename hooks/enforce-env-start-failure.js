#!/usr/bin/env node

/**
 * Enforce dev environment failure handling via hard blocks.
 *
 * PHASE 1 (PostToolUse on Bash):
 *   When check-start-env.js output has "started": false,
 *   writes marker to /tmp/check-env-failed-<ticket>.
 *
 * PHASE 2 (PreToolUse on Task/Skill):
 *   BLOCKS ALL Task/Skill launches while marker exists.
 *   Only AskUserQuestion is allowed (to force user choice).
 *   stderr tells AI exactly what to do.
 *
 * PHASE 3 (PostToolUse on AskUserQuestion):
 *   When AskUserQuestion is called and marker exists,
 *   deletes the marker (unblocks everything).
 *   If user chose "Skip QA", writes skip-qa marker instead.
 */

const fs = require('fs');
const path = require('path');
const config = require('../lib/config');

const MARKER_DIR = '/tmp';

function getTicketId() {
  try {
    const { execSync } = require('child_process');
    const branch = execSync('git branch --show-current 2>/dev/null', { encoding: 'utf8' }).trim();
    const match = branch.match(new RegExp(config.TICKET_PROJECT_KEY + '-\\d+', 'i'));
    return match ? match[0].toUpperCase() : 'UNKNOWN';
  } catch {
    return 'UNKNOWN';
  }
}

function markerPath(ticketId) {
  return path.join(MARKER_DIR, `check-env-failed-${ticketId}`);
}

function skipQaMarkerPath(ticketId) {
  return path.join(MARKER_DIR, `check-skip-qa-${ticketId}`);
}

// ─── PHASE 1: PostToolUse/Bash — detect failure, write marker ───

function phase1_detectFailure(hookData) {
  const command = hookData.tool_input?.command || '';
  if (!command.includes('check-start-env')) return;

  const transcriptPath = hookData.transcript_path;
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return;

  let output = '';
  try {
    const content = fs.readFileSync(transcriptPath, 'utf8');
    const lines = content.split('\n').filter(Boolean);
    for (const line of lines.slice(-30)) {
      try {
        const entry = JSON.parse(line);
        if (entry.type === 'tool_result' || entry.content) {
          const text = typeof entry.content === 'string'
            ? entry.content
            : JSON.stringify(entry.content || '');
          output += text + '\n';
        }
      } catch { /* skip */ }
    }
  } catch { return; }

  const hasFail = /"started":\s*false/.test(output)
    || /Timeout waiting for app to start/.test(output);
  const hasEmptyApps = /"runningApps":\s*\{\s*\}/.test(output)
    && /"apps":\s*\{/.test(output);

  const ticketId = getTicketId();
  const mp = markerPath(ticketId);

  if (hasFail || hasEmptyApps) {
    const failedMatches = output.match(/"name":\s*"([^"]+)"[^}]*"started":\s*false/g) || [];
    const failedApps = failedMatches.map(m => {
      const n = m.match(/"name":\s*"([^"]+)"/);
      return n ? n[1] : 'unknown';
    });

    fs.writeFileSync(mp, JSON.stringify({ failedApps, timestamp: new Date().toISOString(), ticketId }));
    process.stderr.write(`ENV_FAILURE: marker written (${failedApps.join(', ')})\n`);
  } else {
    try { fs.unlinkSync(mp); } catch { /* */ }
  }
}

// ─── PHASE 2: PreToolUse/Task+Skill — block everything until user chooses ───

function phase2_blockUntilUserChoice(hookData) {
  const ticketId = getTicketId();
  const mp = markerPath(ticketId);

  if (!fs.existsSync(mp)) return; // No failure, allow

  let failInfo = {};
  try { failInfo = JSON.parse(fs.readFileSync(mp, 'utf8')); } catch { /* */ }
  const appList = (failInfo.failedApps || []).join(', ') || 'apps';

  process.stderr.write(
    `BLOCKED: Dev apps failed to start (${appList}). ` +
    'Call AskUserQuestion with options: "Retry" | "Start manually" | "Skip QA" | "Abort /check". ' +
    `Marker: ${mp}\n`
  );
  process.exit(2);
}

// ─── PHASE 3: PostToolUse/AskUserQuestion — user chose, unblock ───

function phase3_unblockAfterChoice(hookData) {
  const ticketId = getTicketId();
  const mp = markerPath(ticketId);

  if (!fs.existsSync(mp)) return; // No marker, nothing to do

  // Delete the block marker — user has been consulted
  try { fs.unlinkSync(mp); } catch { /* */ }
  process.stderr.write(`ENV_FAILURE: marker cleared after AskUserQuestion\n`);

  // Check if user chose to skip QA (look at transcript for the answer)
  const transcriptPath = hookData.transcript_path;
  if (transcriptPath && fs.existsSync(transcriptPath)) {
    try {
      const content = fs.readFileSync(transcriptPath, 'utf8');
      const lines = content.split('\n').filter(Boolean);
      const recent = lines.slice(-10).join(' ');
      if (/skip\s*qa/i.test(recent)) {
        fs.writeFileSync(skipQaMarkerPath(ticketId), JSON.stringify({ ticketId, timestamp: new Date().toISOString() }));
        process.stderr.write('Skip-QA marker written. QA agents will be skipped.\n');
      }
    } catch { /* */ }
  }
}

// ─── Main ───

async function main() {
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
  }

  const hookData = JSON.parse(input);
  const hookType = process.env.CLAUDE_HOOK_TYPE || 'PostToolUse';
  const toolName = hookData.tool_name;

  if (hookType === 'PreToolUse') {
    // Phase 2: Block Task and Skill while marker exists
    if (toolName === 'Task' || toolName === 'Skill') {
      phase2_blockUntilUserChoice(hookData);
    }
  } else if (hookType === 'PostToolUse') {
    if (toolName === 'Bash') {
      // Phase 1: Detect check-start-env failure
      phase1_detectFailure(hookData);
    } else if (toolName === 'AskUserQuestion') {
      // Phase 3: User made a choice, unblock
      phase3_unblockAfterChoice(hookData);
    }
  }
}

main().catch(() => {});
