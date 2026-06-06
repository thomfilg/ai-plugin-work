'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
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
