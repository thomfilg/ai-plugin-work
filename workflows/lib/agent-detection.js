/**
 * Shared agent detection utilities for Claude Code hooks.
 *
 * Provides reliable detection of whether code is executing inside
 * a specific subagent context, using multiple detection strategies.
 */

const fs = require('fs');

/**
 * Check if we're running inside a subagent by scanning the transcript
 * for the MOST RECENT Task tool invocation that matches our agent.
 *
 * Only checks the last 50 lines. If the most recent matching Task call
 * has no tool_result yet, we're likely executing inside that agent.
 *
 * @param {string} transcriptPath - Path to the session transcript
 * @param {string[]} agentAliases - Agent names to check for
 * @returns {boolean} true if running in subagent context
 */
function isSubagentFromTranscript(transcriptPath, agentAliases) {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) {
    return false;
  }

  try {
    const content = fs.readFileSync(transcriptPath, 'utf8');
    const lines = content.trim().split('\n');

    // Check the last 200 lines for recent Task calls (subagents may produce
    // many transcript lines between the Task invocation and subsequent tool calls)
    const recentLines = lines.slice(-200);

    // Scan in reverse to find the most recent Task tool invocation for our agent
    for (let i = recentLines.length - 1; i >= 0; i--) {
      try {
        const entry = JSON.parse(recentLines[i]);

        // Look for assistant messages with tool_use
        if (entry.type === 'assistant' && entry.message?.content) {
          const contentItems = Array.isArray(entry.message.content)
            ? entry.message.content
            : [entry.message.content];

          for (const item of contentItems) {
            if (item.type === 'tool_use' && (item.name === 'Task' || item.name === 'Agent')) {
              const subagentType = item.input?.subagent_type || '';
              if (agentAliases.some(alias =>
                alias.toLowerCase() === subagentType.toLowerCase()
              )) {
                // Check if there's a corresponding tool_result in subsequent lines
                const hasResult = recentLines.slice(i + 1).some(line => {
                  try {
                    const laterEntry = JSON.parse(line);
                    if (laterEntry.type === 'user' && laterEntry.message?.content) {
                      const laterItems = Array.isArray(laterEntry.message.content)
                        ? laterEntry.message.content
                        : [laterEntry.message.content];
                      return laterItems.some(li =>
                        li.type === 'tool_result' && li.tool_use_id === item.id
                      );
                    }
                  } catch { /* ignore */ }
                  return false;
                });

                const ACTIVE_TASK_LINE_THRESHOLD = 200;
                const linesFromEnd = recentLines.length - i;
                if (!hasResult && linesFromEnd <= ACTIVE_TASK_LINE_THRESHOLD) {
                  return true;
                }

                // Most recent Task for this agent already completed — stop
                return false;
              }
            }
          }
        }
      } catch {
        continue;
      }
    }

    return false;
  } catch {
    return false;
  }
}

/**
 * Check if running inside a specific agent by examining context.
 *
 * Detection methods (in priority order):
 * 1. Environment variable CLAUDE_CURRENT_AGENT (most reliable)
 * 2. Transcript scanning for active Task tool invocations
 * 3. Frontmatter parsing for legacy transcripts
 *
 * @param {string} transcriptPath - Path to the session transcript
 * @param {string[]} agentAliases - Agent names to check for
 * @returns {boolean} true if running inside one of the specified agents
 */
function isRunningInAgent(transcriptPath, agentAliases) {
  // Primary: Check environment variable
  const currentAgent = process.env.CLAUDE_CURRENT_AGENT;
  if (currentAgent && agentAliases.some(alias =>
    alias.toLowerCase() === currentAgent.toLowerCase()
  )) {
    return true;
  }

  // Quick check: If this is a subagent process, its transcript initial
  // prompt will mention the agent type. Check this early since it's fast
  // and handles Task subprocesses that don't set CLAUDE_CURRENT_AGENT.
  if (isSubagentFromInitialPrompt(transcriptPath, agentAliases)) {
    return true;
  }

  // Secondary: Scan transcript for active Task tool invocations
  if (isSubagentFromTranscript(transcriptPath, agentAliases)) {
    return true;
  }

  // Fallback: Transcript frontmatter (legacy)
  if (!transcriptPath || !fs.existsSync(transcriptPath)) {
    return false;
  }

  try {
    const content = fs.readFileSync(transcriptPath, 'utf8');
    for (const alias of agentAliases) {
      const frontmatterPattern = new RegExp(`^name:\\s*${alias}\\s*$`, 'm');
      if (frontmatterPattern.test(content)) {
        return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Detect agent identity from the subagent's own transcript.
 *
 * When a subagent is launched via Task, its transcript starts with a
 * system/user message containing the prompt. The prompt often includes
 * the agent type name or role description. We check the first few
 * lines of the transcript for matches.
 *
 * @param {string} transcriptPath - Path to the subagent's transcript
 * @param {string[]} agentAliases - Agent names to check for
 * @returns {boolean} true if initial prompt indicates this agent
 */
function isSubagentFromInitialPrompt(transcriptPath, agentAliases) {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) {
    return false;
  }

  try {
    const content = fs.readFileSync(transcriptPath, 'utf8');
    const lines = content.trim().split('\n');

    // Check the first 10 lines for the agent type in system or user messages
    const earlyLines = lines.slice(0, 10);
    for (const line of earlyLines) {
      try {
        const entry = JSON.parse(line);
        // System messages may contain subagent_type
        if (entry.type === 'system' || entry.type === 'user') {
          const msgContent = entry.message?.content;
          const text = typeof msgContent === 'string'
            ? msgContent
            : Array.isArray(msgContent)
              ? msgContent.map(i => i.text || '').join(' ')
              : '';

          for (const alias of agentAliases) {
            // Match "subagent_type": "code-checker" or similar patterns
            if (text.toLowerCase().includes(alias.toLowerCase())) {
              return true;
            }
          }
        }
      } catch { /* skip non-JSON lines */ }
    }
    return false;
  } catch {
    return false;
  }
}

module.exports = { isRunningInAgent, isSubagentFromTranscript, isSubagentFromInitialPrompt };
