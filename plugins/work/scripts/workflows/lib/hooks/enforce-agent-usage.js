#!/usr/bin/env node

'use strict';

/**
 * enforce-agent-usage.js — PreToolUse hook enforcing agent usage for operations
 * that have a designated agent (Jira creation, PR creation, semantic commits,
 * wiki upload) and blocking agent self-invocation loops.
 *
 * GH-539: relocated from the global `~/.claude/hooks/` into the work-workflow
 * plugin so its lifecycle is owned here, and the "Semantic Commits" rule now
 * FORCES every commit through the sanctioned `commit-and-push.js` script. A raw
 * `git commit` is ALWAYS blocked (no agent bypass, no install step) and the
 * operator is told to run the script, which validates semantic format, blocks
 * AI attribution, enforces a human git identity, and pushes. The script itself
 * commits via child_process (not the Bash tool), so it never trips this hook,
 * and it is explicitly exempt from the script-bypass scan below.
 *
 * exit 0 = allow, exit 2 = block. Fails open (exit 0) on any internal error.
 */

const path = require('path');
const { isRunningInAgent } = require('../agent-detection');
const { commandAccessesProtectedPaths } = require('../command-analysis');
const { logHookError } = require('../hook-error-log');

// Absolute path to the sanctioned commit script agents are forced to use.
const COMMIT_SCRIPT = path.resolve(__dirname, '..', '..', 'work', 'scripts', 'commit-and-push.js');

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
    agentAliases: [
      'pr-generator',
      'PR Generator',
      'Pull Request Generator',
      'work-workflow:pr-generator',
    ],
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
    // GH-539: a raw `git commit` is ALWAYS blocked — there is no agent bypass and
    // no install step. Every commit MUST go through `commit-and-push.js`, which
    // validates the message + committer identity and pushes. The script commits
    // via child_process, so it never re-enters this hook.
    agentAliases: [],
    allowPatterns: [/--allow-empty/, /--amend/, /fixup!/, /squash!/],
    message: `❌ Direct \`git commit\` is not allowed.

✅ Author your semantic message, then commit + push through the guard script — it
   validates the format, blocks AI attribution, enforces a human git identity,
   and pushes. It is the ONLY sanctioned commit path; nothing commits around it:

     node "${COMMIT_SCRIPT}" -m "type(scope): summary (#123)"

   (Use \`-F <file>\` for a multi-line message, or \`--no-push\` to commit only.)

💡 Amend / fixup / empty commits are exempt via --amend / --allow-empty / fixup! / squash!.`,
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

/** Skill-tool self-call: `skillName` names a blocked agent AND we're inside it. */
function skillSelfCall(skillName, blocked, transcriptPath) {
  const named = skillName === blocked || skillName === `/${blocked}`;
  return named && isRunningInAgent(transcriptPath, [blocked]);
}

/** Task-tool self-call: dispatched subagent equals the currently-running agent. */
function taskSelfCall(subagentType, blocked) {
  const currentAgent = process.env.CLAUDE_CURRENT_AGENT;
  return (
    subagentType === blocked &&
    Boolean(currentAgent) &&
    currentAgent.toLowerCase() === blocked.toLowerCase()
  );
}

function blockSelfCall(toolName, toolInput, transcriptPath) {
  const skillName = toolInput?.skill || '';
  const subagentType = toolInput?.subagent_type || '';
  for (const blocked of SELF_CALL_BLOCKED_AGENTS) {
    if (toolName === 'Skill' && skillSelfCall(skillName, blocked, transcriptPath)) {
      process.stderr.write(
        `BLOCKED: Infinite loop detected!\n\nAgent "${blocked}" cannot call itself via Skill tool.\n` +
          `You ARE the ${blocked} — do the work directly.\n`
      );
      process.exit(2);
    }
    if (toolName === 'Task' && taskSelfCall(subagentType, blocked)) {
      process.stderr.write(
        `INFINITE LOOP BLOCKED\n\nAgent "${blocked}" cannot call itself via Task tool.\nDo the work directly.\n`
      );
      process.exit(2);
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

/** Whether `rule` applies to the current tool invocation (tool + command match). */
function ruleMatches(rule, toolName, toolInput) {
  if (rule.toolName !== toolName) return false;
  return rule.commandPattern ? rule.commandPattern.test(toolInput?.command || '') : true;
}

/** Whether a matched rule is satisfied (bypassed or run by the right agent). */
function ruleSatisfied(rule, toolInput, transcriptPath, hookData) {
  return (
    shouldBypass(toolInput, rule.allowPatterns) ||
    isRunningInAgent(transcriptPath, rule.agentAliases, hookData) ||
    agentHintsMatch(hookData, transcriptPath, rule.agentAliases)
  );
}

function enforceRules(toolName, toolInput, transcriptPath, hookData) {
  for (const rule of AGENT_ENFORCEMENT_RULES) {
    if (!ruleMatches(rule, toolName, toolInput)) continue;
    if (ruleSatisfied(rule, toolInput, transcriptPath, hookData)) continue;
    process.stderr.write(`BLOCKED: ${rule.name} requires agent!\n\n${rule.message}\n`);
    process.exit(2);
  }
}

// Trusted script roots whose contents are never treated as agent-gate bypasses
// (the plugin's own hooks/scripts must be able to run these operations).
const TRUSTED_SCRIPT_ROOTS = ['/.claude/hooks/', 'claude-plugin-work/', '/.claude/plugins/'];

// The plugin's own sanctioned commit script — it IS the enforcement path, so it
// must never be flagged as a `git commit` bypass regardless of where it lives.
const SANCTIONED_SCRIPT_BASENAMES = ['commit-and-push.js'];

/** A protected-operation script hit that is NOT under a trusted root / sanctioned. */
function isUntrustedScriptHit(scriptCheck) {
  if (!scriptCheck.found) return false;
  const scriptPath = scriptCheck.scriptPath;
  if (TRUSTED_SCRIPT_ROOTS.some((root) => scriptPath.includes(root))) return false;
  if (SANCTIONED_SCRIPT_BASENAMES.some((name) => scriptPath.endsWith(name))) return false;
  return true;
}

/** The Bash rule whose command-pattern the script's source matches, or undefined. */
function ruleMatchedInScript(bashRules, scriptPath) {
  const source = require('fs').readFileSync(scriptPath, 'utf8');
  return bashRules.find((r) => r.commandPattern.test(source));
}

function enforceScriptBypass(toolName, toolInput, transcriptPath, hookData) {
  if (toolName !== 'Bash') return;
  const command = toolInput?.command || '';
  const bashRules = AGENT_ENFORCEMENT_RULES.filter(
    (r) => r.toolName === 'Bash' && r.commandPattern
  );
  const scriptCheck = commandAccessesProtectedPaths(
    command,
    bashRules.map((r) => r.commandPattern)
  );
  if (!isUntrustedScriptHit(scriptCheck)) return;
  const matchedRule = ruleMatchedInScript(bashRules, scriptCheck.scriptPath);
  if (!matchedRule) return;
  if (isRunningInAgent(transcriptPath, matchedRule.agentAliases, hookData)) return;
  process.stderr.write(
    `BLOCKED: Script "${scriptCheck.scriptPath}" contains ${matchedRule.name} operation!\n\n${matchedRule.message}\n`
  );
  process.exit(2);
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
  COMMIT_SCRIPT,
  shouldBypass,
};
