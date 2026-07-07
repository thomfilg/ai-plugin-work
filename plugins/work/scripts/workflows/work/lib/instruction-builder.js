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

  // Delegation block
  if (entry.agentType === 'skill') {
    const skillMatch = (entry.agentPrompt || '').match(/^\/([\w-]+)/);
    instruction.delegate = {
      type: 'skill',
      name: skillMatch ? skillMatch[1] : entry.command,
      prompt: entry.agentPrompt,
    };
  } else if (entry.agentType === 'Bash' || entry.agentType === 'bash') {
    instruction.delegate = {
      type: 'bash',
      description: `${entry.step} ${entry.reason || ''}`.trim(),
      command: entry.agentPrompt || entry.command,
    };
  } else if (entry.agentType === 'inline-commit') {
    // GH-539: the session agent authors the commit message and commits directly
    // (no subagent). The `prompt` is the directive the orchestrator executes.
    instruction.delegate = {
      type: 'commit',
      description: `${entry.step} ${entry.reason || ''}`.trim().slice(0, 80),
      prompt: entry.agentPrompt || entry.command,
    };
  } else {
    // Task-based (general-purpose, brief-writer, spec-writer, commit-writer, etc.)
    // Detect simple single-command prompts and emit as "bash" instead of spawning an agent
    const prompt = entry.agentPrompt || '';
    const isSingleCommand =
      entry.agentType === 'general-purpose' &&
      /^(Fetch|Run|Execute|Check)\b/.test(prompt) &&
      /\bgh\s|\bgit\s|\bnode\s|\bcurl\s/.test(prompt) &&
      prompt.split('\n').filter((l) => l.trim()).length <= 3;

    if (isSingleCommand) {
      instruction.delegate = {
        type: 'bash',
        description: `${entry.step} ${entry.reason || ''}`.trim().slice(0, 80),
        command: prompt,
      };
    } else {
      instruction.delegate = {
        type: 'task',
        agentType: entry.agentType,
        description: `${entry.step} ${entry.reason || ''}`.trim().slice(0, 80),
        prompt,
        note: T('delegate.task.note', {}, rt.name),
      };
    }
  }

  // Runtime-correct delegate rendering (claude: same reference back — inert).
  // Every branch above sets a delegate; renderDelegate passes falsy through.
  instruction.delegate = renderDelegateForRuntime(instruction.delegate, rt);

  return instruction;
}

module.exports = { buildInstruction };
