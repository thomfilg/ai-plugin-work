/**
 * Instruction builder for work-next.js.
 *
 * Converts a plan entry into a work_instruction JSON object
 * with the appropriate delegation type. Delegates render through the
 * instruction vocabulary (design §F): on claude the output is byte-identical
 * to the historical literals (pinned by the runtime characterization tests);
 * on codex `task` delegates become `inline-agent` persona executions with a
 * `howTo` + degradation notices and `skill` delegates gain a mention-based
 * `howTo` — additive fields only, the claude schema is unchanged.
 */

'use strict';

const path = require('path');

const { T, renderDelegateForRuntime, getRuntime } = require(
  path.join(__dirname, '..', '..', 'lib', 'instruction-vocab')
);

/** `<step> <reason>` trimmed and capped at 80 chars — the delegate description. */
function shortDescription(entry) {
  return `${entry.step} ${entry.reason || ''}`.trim().slice(0, 80);
}

function buildSkillDelegate(entry) {
  const skillMatch = (entry.agentPrompt || '').match(/^\/([\w-]+)/);
  return {
    type: 'skill',
    name: skillMatch ? skillMatch[1] : entry.command,
    prompt: entry.agentPrompt,
  };
}

function buildBashDelegate(entry) {
  return {
    type: 'bash',
    // NOTE: unlike the other delegate kinds this description is NOT capped
    // at 80 chars — preserved verbatim from the historical literal.
    description: `${entry.step} ${entry.reason || ''}`.trim(),
    command: entry.agentPrompt || entry.command,
  };
}

// GH-539: the session agent authors the commit message and commits directly
// (no subagent). The `prompt` is the directive the orchestrator executes.
function buildCommitDelegate(entry) {
  return {
    type: 'commit',
    description: shortDescription(entry),
    prompt: entry.agentPrompt || entry.command,
  };
}

/** Simple single-command prompts run as "bash" instead of spawning an agent. */
function isSingleCommandPrompt(entry, prompt) {
  return (
    entry.agentType === 'general-purpose' &&
    /^(Fetch|Run|Execute|Check)\b/.test(prompt) &&
    /\bgh\s|\bgit\s|\bnode\s|\bcurl\s/.test(prompt) &&
    prompt.split('\n').filter((l) => l.trim()).length <= 3
  );
}

// Task-based (general-purpose, brief-writer, spec-writer, commit-writer, etc.)
// Detect simple single-command prompts and emit as "bash" instead of spawning an agent
function buildTaskDelegate(entry, rt) {
  const prompt = entry.agentPrompt || '';
  if (isSingleCommandPrompt(entry, prompt)) {
    return {
      type: 'bash',
      description: shortDescription(entry),
      command: prompt,
    };
  }
  return {
    type: 'task',
    agentType: entry.agentType,
    description: shortDescription(entry),
    prompt,
    note: T('delegate.task.note', {}, rt.name),
  };
}

/** Delegation block — dispatch on entry.agentType. */
function buildDelegate(entry, rt) {
  if (entry.agentType === 'skill') return buildSkillDelegate(entry);
  if (entry.agentType === 'Bash' || entry.agentType === 'bash') return buildBashDelegate(entry);
  if (entry.agentType === 'inline-commit') return buildCommitDelegate(entry);
  return buildTaskDelegate(entry, rt);
}

/**
 * Build a work_instruction from a plan entry.
 * @param {object} entry - Plan entry with step, agentType, agentPrompt, etc.
 * @param {object} stateCtx - State context block
 * @returns {object} work_instruction JSON
 */
function buildInstruction(entry, stateCtx) {
  const rt = getRuntime();
  const instruction = {
    type: 'work_instruction',
    action: 'execute',
    state: stateCtx,
    continue: true,
  };

  // preCommands
  if (entry.preCommands && entry.preCommands.length > 0) {
    instruction.preCommands = entry.preCommands;
  }

  // Runtime-correct delegate rendering (claude: same reference back — inert).
  // Every buildDelegate branch returns a delegate; renderDelegate passes falsy through.
  instruction.delegate = renderDelegateForRuntime(buildDelegate(entry, rt), rt);

  return instruction;
}

module.exports = { buildInstruction };
