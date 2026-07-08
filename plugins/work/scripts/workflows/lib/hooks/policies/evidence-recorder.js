/**
 * policies/evidence-recorder.js
 *
 * Evidence load/save/clear cycle extracted from enforce-step-workflow.js.
 *
 * Provides:
 *   - loadEvidence({ tasksBase, ticketId, evidenceFile, safeTicketPath }): read evidence file
 *   - saveEvidence({ ... evidence }): atomic write via the vendored safeIO writer
 *   - recordEvidenceEntry({ toolName, toolInput }): build an evidence row from a tool call
 *   - clearBackwardEvidence({ evidence, steps, currentStep, targetStep }): clear on rewind
 *
 * Pure functions where possible — only saveEvidence touches the filesystem.
 */

const fs = require('fs');
const path = require('path');
const { writeJsonAtomic } = require('../../safeIO');

function loadEvidence({ tasksBase, ticketId, evidenceFile, safeTicketPath }) {
  const p = path.join(tasksBase, safeTicketPath(ticketId), evidenceFile);
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch {
    return {};
  }
}

function saveEvidence({ tasksBase, ticketId, evidenceFile, evidence, safeTicketPath }) {
  const target = path.join(tasksBase, safeTicketPath(ticketId), evidenceFile);
  // Vendored safeIO handles dir creation and the Windows rename-over-existing
  // case (win32-only unlink+retry). Deliberate change: the old any-platform
  // copyFile fallback is gone, so a pathological EPERM rename on POSIX
  // (immutable dir) now throws instead of degrading to a non-atomic copy.
  writeJsonAtomic(target, evidence, { mode: 0o666 });
}

/**
 * Build the evidence object for a single tool call.
 */
function recordEvidenceEntry({ toolName, toolInput }) {
  const command = toolInput?.command || toolInput?.skill || toolInput?.subagent_type || '(unknown)';
  return {
    executed: true,
    command,
    tool: toolName,
    timestamp: new Date().toISOString(),
  };
}

/**
 * On a backward transition (target earlier than current), clear evidence for
 * steps AFTER target through current. Target step itself is preserved — we're
 * going TO it, so redo everything after.
 *
 * Returns the mutated evidence object (also mutated in place).
 */
function clearBackwardEvidence({ evidence, steps, currentStep, targetStep }) {
  if (!currentStep || !targetStep) return evidence;
  const currentIdx = steps.indexOf(currentStep);
  const targetIdx = steps.indexOf(targetStep);
  if (targetIdx < 0 || currentIdx < 0 || targetIdx >= currentIdx) return evidence;

  for (let i = targetIdx + 1; i <= currentIdx; i++) {
    delete evidence[steps[i]];
  }
  return evidence;
}

module.exports = {
  loadEvidence,
  saveEvidence,
  recordEvidenceEntry,
  clearBackwardEvidence,
};
