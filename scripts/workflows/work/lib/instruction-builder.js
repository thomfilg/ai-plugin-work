/**
 * Instruction builder for work-next.js.
 *
 * Converts a plan entry into a work_instruction JSON object
 * with the appropriate delegation type.
 */

'use strict';

/**
 * Build a work_instruction from a plan entry.
 * @param {object} entry - Plan entry with step, agentType, agentPrompt, etc.
 * @param {object} stateCtx - State context block
 * @returns {object} work_instruction JSON
 */
function buildInstruction(entry, stateCtx) {
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
        note: 'Pass the prompt directly to the agent. Do NOT read brief/spec/tasks files yourself — the agent reads them.',
      };
    }
  }

  return instruction;
}

module.exports = { buildInstruction };
