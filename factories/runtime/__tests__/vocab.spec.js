/**
 * Tests for factories/runtime/vocab.js — the claude renderings are pinned
 * byte-for-byte to the literals the emitting sources produced at HEAD before
 * the vocabulary port (WP-08), so the layer is provably inert on Claude. The
 * source files now ROUTE those strings through the tokens (asserted below);
 * codex renderings honor the degradation contract (C1/C13).
 *
 * Run: node --test factories/runtime/__tests__/vocab.spec.js
 */

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { T, renderInstruction, renderDelegate } = require('../vocab');

const REPO = path.join(__dirname, '..', '..', '..');
const INSTRUCTION_BUILDER = fs.readFileSync(
  path.join(REPO, 'plugins/work/scripts/workflows/work/lib/instruction-builder.js'),
  'utf8'
);
const IMPLEMENT = fs.readFileSync(
  path.join(REPO, 'plugins/work/scripts/workflows/work/lib/step-enrichments/implement.js'),
  'utf8'
);

describe('T — claude snapshots equal the HEAD literals', () => {
  it('delegate.task.note is the instruction-builder.js task note, byte-identical', () => {
    const rendered = T('delegate.task.note', {}, 'claude');
    assert.equal(
      rendered,
      'Pass the prompt directly to the agent. Do NOT read brief/spec/tasks files yourself — the agent reads them.'
    );
    assert.ok(
      INSTRUCTION_BUILDER.includes("T('delegate.task.note'"),
      'instruction-builder.js must route the note through the vocab token'
    );
  });

  it('delegate.task.note.short is the implement.js parallel note, byte-identical', () => {
    const rendered = T('delegate.task.note.short', {}, 'claude');
    assert.equal(rendered, 'Pass the prompt directly to the agent.');
    assert.ok(
      IMPLEMENT.includes("T('delegate.task.note.short'"),
      'implement.js must route the note through the vocab token'
    );
  });

  it('parallel.dispatch matches the historical implement.js template, byte-identical', () => {
    const rendered = T('parallel.dispatch', { count: 3 }, 'claude');
    assert.equal(
      rendered,
      'Launch ALL 3 agents IN PARALLEL (single message, multiple Task tool calls). Each task is independent.'
    );
    assert.ok(
      IMPLEMENT.includes("T('parallel.dispatch'"),
      'implement.js must route the dispatch line through the vocab token'
    );
  });

  it('tool tokens render the claude names verbatim', () => {
    assert.equal(T('tool.plan', {}, 'claude'), 'TodoWrite');
    assert.equal(T('tool.question', {}, 'claude'), 'AskUserQuestion');
    assert.equal(
      T('skill.invoke', { plugin: 'work-workflow', skill: 'configure' }, 'claude'),
      '/work-workflow:configure'
    );
    assert.equal(
      T('monitor.step', { command: 'node listen.js' }, 'claude'),
      'Monitor(node listen.js)'
    );
  });

  it('unknown runtimes fall back to claude; unknown keys throw', () => {
    assert.equal(T('tool.plan', {}, 'gemini'), 'TodoWrite');
    assert.throws(() => T('no.such.token', {}, 'claude'), /unknown token/);
  });
});

describe('T — codex renderings', () => {
  it('tool tokens swap to the codex vocabulary (probe-verified names)', () => {
    assert.equal(T('tool.plan', {}, 'codex'), 'update_plan');
    assert.equal(T('tool.question', {}, 'codex'), 'request_user_input');
    assert.equal(
      T('skill.invoke', { plugin: 'work-workflow', skill: 'configure' }, 'codex'),
      'the $configure skill (work-workflow:configure)'
    );
  });

  it('degraded tokens carry the greppable notice prefix', () => {
    assert.match(T('parallel.dispatch', { count: 2 }, 'codex'), /^\[work:codex-degraded\]/);
    assert.match(T('monitor.step', {}, 'codex'), /no Monitor on codex/);
  });
});

describe('renderInstruction', () => {
  it('claude branch returns the input UNCHANGED (byte identity)', () => {
    const text = 'Run /work-workflow:configure then use TodoWrite and AskUserQuestion.';
    assert.equal(renderInstruction(text, 'claude'), text);
  });

  it('codex swaps slash-skill invocations, TodoWrite, AskUserQuestion', () => {
    assert.equal(
      renderInstruction('Run /work-workflow:configure to set them up', 'codex'),
      'Run the $configure skill (work-workflow:configure) to set them up'
    );
    assert.equal(
      renderInstruction('Track with TodoWrite; gate via AskUserQuestion.', 'codex'),
      'Track with update_plan; gate via request_user_input.'
    );
  });

  it('codex leaves non-invocation slashes alone', () => {
    assert.equal(renderInstruction('see docs/foo:bar.md', 'codex'), 'see docs/foo:bar.md');
    assert.equal(renderInstruction('https://x.y/z:1', 'codex'), 'https://x.y/z:1');
  });
});

describe('renderDelegate', () => {
  const taskDelegate = {
    type: 'task',
    agentType: 'developer-nodejs-tdd',
    description: 'Task 1/3 — implement',
    prompt: 'Run task-next.js.',
    note: 'Pass the prompt directly to the agent.',
  };

  it('claude returns the SAME delegate reference — provably inert', () => {
    assert.equal(renderDelegate(taskDelegate, 'claude'), taskDelegate);
    const bash = { type: 'bash', command: 'ls' };
    assert.equal(renderDelegate(bash, 'claude'), bash);
  });

  it('codex task → inline-agent with an existing personaPath (C1)', () => {
    const pluginRoot = path.join(REPO, 'plugins', 'work');
    const rendered = renderDelegate(taskDelegate, 'codex', { pluginRoot });
    assert.equal(rendered.type, 'inline-agent');
    assert.ok(rendered.personaPath, 'personaPath resolves');
    assert.ok(fs.existsSync(rendered.personaPath), 'personaPath exists on disk');
    assert.match(rendered.howTo, /adopt it, execute the prompt inline NOW, then re-run the driver/);
    assert.deepEqual(rendered.notices, [
      "[work:codex-degraded] subagent 'developer-nodejs-tdd' runs INLINE; parallel dispatch serialized",
    ]);
    // Additive: the original delegate fields survive for claude-shaped consumers.
    assert.equal(rendered.prompt, taskDelegate.prompt);
    assert.equal(rendered.description, taskDelegate.description);
  });

  it('codex task without a resolvable persona still renders a howTo', () => {
    const rendered = renderDelegate(taskDelegate, 'codex');
    assert.equal(rendered.personaPath, null);
    assert.match(rendered.howTo, /Adopt the agent persona/);
  });

  it('WORK_CODEX_SPAWN_AGENT=1 renders spawn_agent guidance instead (U8 escape hatch)', () => {
    process.env.WORK_CODEX_SPAWN_AGENT = '1';
    try {
      const rendered = renderDelegate(taskDelegate, 'codex');
      assert.equal(rendered.type, 'task');
      assert.match(rendered.howTo, /spawn_agent/);
    } finally {
      delete process.env.WORK_CODEX_SPAWN_AGENT;
    }
  });

  it('codex skill delegate gains the mention howTo with the SKILL.md path fallback', () => {
    const pluginRoot = path.join(REPO, 'plugins', 'work');
    const rendered = renderDelegate(
      { type: 'skill', name: 'work', prompt: '/work GH-1' },
      'codex',
      { pluginRoot }
    );
    assert.match(rendered.howTo, /\$work skill/);
    assert.match(rendered.howTo, /SKILL\.md at .*plugins\/work\/skills\/work\/SKILL\.md/);
  });

  it('custom resolveDocPath takes precedence', () => {
    const rendered = renderDelegate(taskDelegate, 'codex', {
      resolveDocPath: (rel) => `/resolved/${rel}`,
    });
    assert.equal(rendered.personaPath, '/resolved/agents/developer-nodejs-tdd.md');
  });
});
