#!/usr/bin/env node

'use strict';

/**
 * enforce-agent-usage.js — PreToolUse hook enforcing agent usage for operations
 * that have a designated agent (Jira creation, PR creation, semantic commits,
 * wiki upload) and blocking agent self-invocation loops.
 *
 * GH-539: relocated from the global `~/.claude/hooks/` into the work-workflow
 * plugin so its lifecycle is owned here, and the "Semantic Commits" rule is
 * ADAPTED — it now LIFTS the direct-`git commit` block in any worktree where
 * the `commit-msg` validator hook is installed (`hasCommitMsgValidator`). There
 * the git hook enforces the same rules deterministically, so the commit-writer
 * subagent is no longer the enforcement boundary and a direct `git commit`
 * (e.g. the /work commit step's direct path) is allowed. Worktrees without the
 * validator still require commit-writer, preserving the old behavior.
 *
 * exit 0 = allow, exit 2 = block. Fails open (exit 0) on any internal error.
 */

const { isRunningInAgent } = require('../agent-detection');
const { commandAccessesProtectedPaths } = require('../command-analysis');
const { hasCommitMsgValidator } = require('../commit-msg-hook');
const { logHookError } = require('../hook-error-log');

// Agents that should NEVER call themselves via Skill or Task tool.
const SELF_CALL_BLOCKED_AGENTS = [
  'pr-generator',
  'pr-post-generator',
  'jira-task-creator',
  'code-checker',
  'pr-reviewer',
  'qa-feature-tester',
  'quality-checker',
  'completion-checker',
  'project-coordinator',
  'developer-devops',
  'developer-nodejs-tdd',
  'developer-react-ui-architect',
  'developer-react-senior',
];

// Map operations to required agents.
const AGENT_ENFORCEMENT_RULES = [
  {
    name: 'Jira Ticket Creation',
    toolName: 'mcp__atlassian__jira_create_issue',
    requiredAgent: 'jira-task-creator',
    agentAliases: ['jira-task-creator', 'Jira Task Creator', 'work-workflow:jira-task-creator'],
    message: `❌ Direct Jira issue creation not allowed!

✅ Use Task tool with subagent_type="jira-task-creator" instead

Example:
  Task({
    description: "Create Jira ticket",
    prompt: "Create a Jira task for...",
    subagent_type: "jira-task-creator"
  })

This ensures consistent ticket formatting and validation.`,
  },
  {
    name: 'PR Creation',
    toolName: 'Bash',
    commandPattern: /gh\s+pr\s+create|gh\s+api\s+repos\/[^\s]*\/pulls\s+-X\s+POST/,
    requiredAgent: 'pr-generator',
    agentAliases: ['pr-generator', 'PR Generator', 'Pull Request Generator', 'work-workflow:pr-generator'],
    message: `❌ Direct PR creation not allowed!

✅ Use Task tool with subagent_type="pr-generator" instead

Example:
  Task({
    description: "Create PR",
    prompt: "Create a pull request for this branch",
    subagent_type: "pr-generator"
  })

This ensures consistent PR descriptions with proper analysis.`,
  },
  {
    name: 'Semantic Commits',
    toolName: 'Bash',
    commandPattern: /git\s+commit\s+(?!.*--amend)/, // git commit but not --amend
    // GH-539: commit-writer was removed. There is no agent bypass anymore — the
    // commit-msg validator hook IS the gate. A direct `git commit` is allowed
    // when that hook is installed (see `bypassOnValidatorHook`); otherwise it is
    // blocked and the operator is told to install the hook.
    agentAliases: [],
    allowPatterns: [/--allow-empty/, /--amend/, /fixup!/, /squash!/],
    bypassOnValidatorHook: true,
    message: `❌ Direct git commit is blocked: this worktree has no commit-msg validator hook.

✅ Install it — then direct \`git commit\` works with NO subagent, and git enforces
   semantic format, no AI attribution, and a human git identity on every commit:

     node scripts/workflows/work/scripts/install-commit-msg-hook.js "<worktree>"

   (In /work, bootstrap installs this automatically.) Author the commit message
   yourself — the hook validates it.

💡 Amend / fixup / empty commits bypass via --amend / --allow-empty / fixup! / squash!.`,
  },
  {
    name: 'Wiki Screenshot Upload',
    toolName: 'Bash',
    commandPattern: /git\s+clone.*\.wiki\.git/,
    requiredAgent: 'pr-post-generator',
    agentAliases: ['pr-post-generator', 'Post PR Generator', 'work-workflow:pr-post-generator'],
    message: `❌ Direct wiki operations not allowed!

✅ Use Task tool with subagent_type="pr-post-generator" instead

Example:
  Task({
    description: "Add screenshots to PR",
    prompt: "Upload QA screenshots to wiki and update PR",
    subagent_type: "pr-post-generator"
  })

This ensures consistent screenshot naming and PR description updates.`,
  },
];

/** Whether the command matches any allow (bypass) pattern. */
function shouldBypass(toolInput, allowPatterns) {
  if (!allowPatterns || allowPatterns.length === 0) return false;
  const command = toolInput?.command || '';
  return allowPatterns.some((pattern) => pattern.test(command));
}

/**
 * GH-539 adaptation: the Semantic Commits rule is lifted when the validator
 * commit-msg hook is installed in the worktree the command runs in. Resolve the
 * worktree from `git -C <path>` in the command, else the hook's cwd.
 */
function bypassOnValidatorHook(rule, toolInput, hookData) {
  if (!rule.bypassOnValidatorHook) return false;
  const command = toolInput?.command || '';
  const dashC = command.match(/git\s+-C\s+["']?([^"'\s]+)/);
  const worktree = dashC ? dashC[1] : hookData?.cwd || process.cwd();
  return hasCommitMsgValidator(worktree);
}

function blockSelfCall(toolName, toolInput, transcriptPath) {
  if (toolName === 'Skill') {
    const skillName = toolInput?.skill || '';
    for (const blocked of SELF_CALL_BLOCKED_AGENTS) {
      if ((skillName === blocked || skillName === `/${blocked}`) && isRunningInAgent(transcriptPath, [blocked])) {
        process.stderr.write(
          `BLOCKED: Infinite loop detected!\n\nAgent "${blocked}" cannot call itself via Skill tool.\n` +
            `You ARE the ${blocked} — do the work directly.\n`,
        );
        process.exit(2);
      }
    }
  }
  if (toolName === 'Task') {
    const subagentType = toolInput?.subagent_type || '';
    const currentAgent = process.env.CLAUDE_CURRENT_AGENT;
    for (const blocked of SELF_CALL_BLOCKED_AGENTS) {
      const isSelfCall =
        subagentType === blocked && currentAgent && currentAgent.toLowerCase() === blocked.toLowerCase();
      if (isSelfCall) {
        process.stderr.write(
          `INFINITE LOOP BLOCKED\n\nAgent "${blocked}" cannot call itself via Task tool.\nDo the work directly.\n`,
        );
        process.exit(2);
      }
    }
  }
}

function agentHintsMatch(hookData, transcriptPath, agentAliases) {
  const hints = [
    hookData.agent_name,
    hookData.agent_type,
    process.env.CLAUDE_AGENT_TYPE,
    transcriptPath ? require('path').basename(transcriptPath) : '',
  ]
    .filter(Boolean)
    .map((h) => h.toLowerCase());
  return hints.some((hint) => agentAliases.some((alias) => hint.includes(alias.toLowerCase())));
}

function enforceRules(toolName, toolInput, transcriptPath, hookData) {
  for (const rule of AGENT_ENFORCEMENT_RULES) {
    let matches = false;
    if (rule.toolName === toolName) {
      matches = rule.commandPattern ? rule.commandPattern.test(toolInput?.command || '') : true;
    }
    if (!matches) continue;
    if (shouldBypass(toolInput, rule.allowPatterns)) continue;
    if (bypassOnValidatorHook(rule, toolInput, hookData)) continue;
    if (isRunningInAgent(transcriptPath, rule.agentAliases, hookData)) continue;
    if (agentHintsMatch(hookData, transcriptPath, rule.agentAliases)) continue;
    process.stderr.write(`BLOCKED: ${rule.name} requires agent!\n\n${rule.message}\n`);
    process.exit(2);
  }
}

function enforceScriptBypass(toolName, toolInput, transcriptPath, hookData) {
  if (toolName !== 'Bash') return;
  const command = toolInput?.command || '';
  const bashRules = AGENT_ENFORCEMENT_RULES.filter((r) => r.toolName === 'Bash' && r.commandPattern);
  const scriptCheck = commandAccessesProtectedPaths(
    command,
    bashRules.map((r) => r.commandPattern),
  );
  if (
    !scriptCheck.found ||
    scriptCheck.scriptPath.includes('/.claude/hooks/') ||
    scriptCheck.scriptPath.includes('claude-plugin-work/') ||
    scriptCheck.scriptPath.includes('/.claude/plugins/')
  ) {
    return;
  }
  const fsMod = require('fs');
  const matchedRule = bashRules.find((r) => r.commandPattern.test(fsMod.readFileSync(scriptCheck.scriptPath, 'utf8')));
  if (!matchedRule) return;
  // Reuse the validator-hook lift for commit scripts too.
  if (bypassOnValidatorHook(matchedRule, toolInput, hookData)) return;
  if (!isRunningInAgent(transcriptPath, matchedRule.agentAliases, hookData)) {
    process.stderr.write(
      `BLOCKED: Script "${scriptCheck.scriptPath}" contains ${matchedRule.name} operation!\n\n${matchedRule.message}\n`,
    );
    process.exit(2);
  }
}

async function main() {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  const hookData = JSON.parse(input);
  const toolName = hookData.tool_name;
  const toolInput = hookData.tool_input || {};
  const transcriptPath = hookData.transcript_path;

  blockSelfCall(toolName, toolInput, transcriptPath);
  enforceRules(toolName, toolInput, transcriptPath, hookData);
  enforceScriptBypass(toolName, toolInput, transcriptPath, hookData);
  process.exit(0);
}

// Only read stdin / run when invoked directly as the hook; stay importable for tests.
if (require.main === module) {
  main().catch((err) => {
    try {
      logHookError(__filename, err);
    } catch {}
    process.exit(0); // fail open — never block legitimate operations on internal error
  });
}

module.exports = {
  AGENT_ENFORCEMENT_RULES,
  SELF_CALL_BLOCKED_AGENTS,
  shouldBypass,
  bypassOnValidatorHook,
};
