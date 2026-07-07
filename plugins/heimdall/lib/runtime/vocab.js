// GENERATED — edit factories/runtime/vocab.js and run scripts/sync-vendored.js

'use strict';

/**
 * vocab.js — instruction vocabulary layer (design §F).
 *
 * Structured delegates are already the contract; this module fixes the
 * RENDERER, not the 77 files that mention Claude tool names. Every token's
 * 'claude' rendering is byte-identical to the literal currently emitted at
 * that chokepoint (pinned by snapshot tests that read the source files), so
 * adopting the vocabulary is provably inert on Claude. Codex renderings honor
 * the degradation contract: no Task/Skill/AskUserQuestion/TodoWrite/Monitor
 * tools, `$skill` mentions instead of `/plugin:skill`, inline persona
 * execution instead of subagents (C1, C13).
 */

const fs = require('node:fs');
const path = require('node:path');

const TOKENS = {
  // instruction-builder.js delegate note (claude literal, byte-identical)
  'delegate.task.note': {
    claude: () =>
      'Pass the prompt directly to the agent. Do NOT read brief/spec/tasks files yourself — the agent reads them.',
    codex: () =>
      'Execute the prompt INLINE in this session — codex has no Task tool. Do NOT read brief/spec/tasks files beyond what the prompt instructs.',
  },
  // step-enrichments/implement.js parallel delegate note (claude literal)
  'delegate.task.note.short': {
    claude: () => 'Pass the prompt directly to the agent.',
    codex: () => 'Execute the prompt inline in this session.',
  },
  // step-enrichments/implement.js:147 parallel-dispatch line (claude literal)
  'parallel.dispatch': {
    claude: ({ count }) =>
      `Launch ALL ${count} agents IN PARALLEL (single message, multiple Task tool calls). Each task is independent.`,
    codex: ({ count }) =>
      `[work:codex-degraded] parallel dispatch serialized — execute ALL ${count} tasks INLINE, one after another. Each task is independent.`,
  },
  'skill.invoke': {
    claude: ({ plugin, skill }) => `/${plugin}:${skill}`,
    codex: ({ plugin, skill }) => `the $${skill} skill (${plugin}:${skill})`,
  },
  'tool.plan': {
    claude: () => 'TodoWrite',
    codex: () => 'update_plan',
  },
  'tool.question': {
    claude: () => 'AskUserQuestion',
    // request_user_input is Plan-mode-only on codex (openai/codex#10384,
    // #29104: "request_user_input is unavailable in code mode") — default to
    // plain-chat numbered options, which work in every mode.
    codex: () => 'a plain-chat question with numbered options',
  },
  'monitor.step': {
    claude: ({ command }) => `Monitor(${command})`,
    codex: () => '[work:codex-degraded] inbox relayed via PostToolUse hook (no Monitor on codex)',
  },
  'background.run': {
    claude: ({ command }) =>
      `Run ${command} with run_in_background: true and poll it with BashOutput.`,
    codex: ({ command }) =>
      `Run detached: nohup ${command} >/tmp/bg-task.log 2>&1 & — then poll /tmp/bg-task.log with tail.`,
  },
};

/**
 * Render a vocabulary token. Unknown runtimes fall back to the claude
 * rendering (the load-bearing compatibility default).
 */
function T(key, args = {}, runtime = 'claude') {
  const entry = TOKENS[key];
  if (!entry) throw new Error(`vocab: unknown token "${key}"`);
  const renderer = entry[runtime] || entry.claude;
  return renderer(args);
}

const SLASH_SKILL_RE = /(^|[\s(`'"])\/([a-z][\w-]*):([a-z][\w-]*)/g;

/**
 * Rewrite Claude-vocabulary tokens inside an emitted instruction string for
 * the target runtime. Claude branch returns the input UNCHANGED (byte
 * identity); codex swaps `/plugin:skill` → `$skill` mention, TodoWrite →
 * update_plan, AskUserQuestion → plain-chat numbered options
 * (request_user_input is Plan-mode-only: openai/codex#10384, #29104).
 */
function renderInstruction(text, runtime) {
  if (runtime !== 'codex') return text;
  return String(text)
    .replace(
      SLASH_SKILL_RE,
      (_m, pre, plugin, skill) => `${pre}the $${skill} skill (${plugin}:${skill})`
    )
    .replace(/\bTodoWrite\b/g, 'update_plan')
    .replace(
      /\bAskUserQuestion\b/g,
      'a plain-chat question with numbered options (request_user_input only works in Plan mode)'
    );
}

function resolveVia(opts, relPath) {
  if (typeof opts.resolveDocPath === 'function') return opts.resolveDocPath(relPath) || null;
  if (opts.pluginRoot) {
    const abs = path.join(opts.pluginRoot, relPath);
    return fs.existsSync(abs) ? abs : null;
  }
  return null;
}

function renderCodexTaskDelegate(delegate, opts) {
  const agentType = delegate.agentType || 'general-purpose';
  const personaRel = `agents/${agentType}.md`;
  const personaPath = resolveVia(opts, personaRel);
  if (process.env.WORK_CODEX_SPAWN_AGENT === '1') {
    return {
      ...delegate,
      howTo: `Call spawn_agent with this prompt (persona: ${personaPath || personaRel}). If spawn_agent is unavailable, execute the prompt inline instead.`,
      notices: [
        '[work:codex-degraded] spawn_agent escape hatch enabled (WORK_CODEX_SPAWN_AGENT=1)',
      ],
    };
  }
  return {
    ...delegate,
    type: 'inline-agent',
    personaPath,
    howTo: personaPath
      ? `Read the persona file at ${personaPath}, adopt it, execute the prompt inline NOW, then re-run the driver.`
      : 'Adopt the agent persona, execute the prompt inline NOW, then re-run the driver.',
    notices: [
      `[work:codex-degraded] subagent '${agentType}' runs INLINE; parallel dispatch serialized`,
    ],
  };
}

function renderCodexSkillDelegate(delegate, opts) {
  const name = delegate.name || '';
  const skillPath = resolveVia(opts, `skills/${name}/SKILL.md`);
  return {
    ...delegate,
    howTo: skillPath
      ? `Invoke the $${name} skill; if it doesn't trigger, open its SKILL.md at ${skillPath} and follow it.`
      : `Invoke the $${name} skill; if it doesn't trigger, open its SKILL.md and follow it.`,
  };
}

/**
 * Runtime-correct rendering of an instruction delegate. On claude the input
 * is returned untouched (same reference — provably inert). On codex,
 * `type:'task'` becomes an inline persona execution (`type:'inline-agent'` +
 * personaPath + howTo + degradation notice; WORK_CODEX_SPAWN_AGENT=1 renders
 * spawn_agent guidance instead) and `type:'skill'` gains a mention-based
 * howTo with the deterministic SKILL.md path fallback. bash/commit delegates
 * pass through on both runtimes.
 *
 * @param {object} delegate - instruction-builder delegate
 * @param {string} runtime - 'claude' | 'codex'
 * @param {{resolveDocPath?: function, pluginRoot?: string}} [opts]
 */
function renderDelegate(delegate, runtime, opts = {}) {
  if (runtime !== 'codex' || !delegate || typeof delegate !== 'object') return delegate;
  if (delegate.type === 'task') return renderCodexTaskDelegate(delegate, opts);
  if (delegate.type === 'skill') return renderCodexSkillDelegate(delegate, opts);
  return delegate;
}

module.exports = { T, TOKENS, renderInstruction, renderDelegate };
