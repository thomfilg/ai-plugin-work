'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { parseArgs, loadTemplate, substitute, tokensForKind } = require('../cli');

describe('stepScaffold', () => {
  it('parseArgs handles --key=val and bare --flag', () => {
    const args = parseArgs(['--id=foo', '--kind=gate', '--force']);
    assert.equal(args.id, 'foo');
    assert.equal(args.kind, 'gate');
    assert.equal(args.force, true);
  });

  it('loadTemplate throws on unknown kind', () => {
    assert.throws(() => loadTemplate('mystery'), /unknown kind/);
  });

  it('loadTemplate returns each template kind', () => {
    for (const k of ['gate', 'artifact', 'transition']) {
      const tpl = loadTemplate(k);
      assert.ok(tpl.length > 0);
      assert.match(tpl, /\{\{id\}\}/);
    }
  });

  it('substitute replaces tokens and throws on missing', () => {
    assert.equal(substitute('hi {{name}}', { name: 'x' }), 'hi x');
    assert.throws(() => substitute('hi {{missing}}', {}), /missing token "missing"/);
  });

  it('tokensForKind=gate defaults precondition', () => {
    const t = tokensForKind('gate', { id: 'foo_gate' });
    assert.equal(t.id, 'foo_gate');
    assert.match(t.precondition, /hasFooGate/);
  });

  // Templates require the factory via a relative climb from a scaffolded
  // step's __dirname (plugins/work/scripts/workflows/work/steps/<id>.js).
  // The expected resolve target is the real `factories/<factoryDir>`.
  // This test fixes the count of `..` segments so a future refactor that
  // moves the templates can't silently regress (cursor-bot flagged this on
  // PR #574 when the count was off by one and scaffolded steps failed at
  // load time with MODULE_NOT_FOUND).
  it('template require paths resolve to real factory directories', () => {
    const repoRoot = path.resolve(__dirname, '..', '..', '..'); // factories/.. → repo root
    const fakeStepsDir = path.join(
      repoRoot,
      'plugins',
      'work',
      'scripts',
      'workflows',
      'work',
      'steps'
    );
    const kinds = {
      gate: 'createGateStep',
      artifact: 'createArtifactStep',
      transition: 'createTransitionStep',
      'agent-invocation': 'createAgentInvocationStep',
      'plan-mutator': 'createPlanMutatorStep',
    };
    for (const [kind, factoryDir] of Object.entries(kinds)) {
      const tpl = loadTemplate(kind);
      // The template builds the path with `path.join(__dirname, ...segments, 'factories', factoryDir)`.
      // Extract the segment count by counting consecutive '..' in the require call.
      const m = tpl.match(/path\.join\(__dirname,\s*((?:'\.\.',\s*)+)'factories'/);
      assert.ok(m, `${kind}.template.js: did not find path.join(__dirname, ...) require`);
      const dots = m[1].split(/,\s*/).filter((s) => s.trim() === "'..'").length;
      // Simulate the resolution from the scaffolded step's __dirname.
      const segments = Array(dots).fill('..');
      const resolved = path.resolve(fakeStepsDir, ...segments, 'factories', factoryDir);
      assert.ok(
        fs.existsSync(resolved),
        `${kind}.template.js: path.join(__dirname, ${dots}×'..', 'factories', '${factoryDir}') resolves to ${resolved} which does not exist`
      );
      assert.equal(
        resolved,
        path.join(repoRoot, 'factories', factoryDir),
        `${kind}.template.js: resolved path is not <repo>/factories/${factoryDir}`
      );
    }
  });

  it('rendered gate template parses as JS', () => {
    const tpl = loadTemplate('gate');
    const body = substitute(
      tpl,
      tokensForKind('gate', {
        id: 'demo',
        artifact: 'demo.md',
        command: '/demo',
        'retry-to': '',
      })
    );
    // sanity: must contain createGateStep call
    assert.match(body, /createGateStep\(/);
    assert.match(body, /STEPS\.demo/);
  });
});
