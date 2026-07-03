'use strict';

// Unit tests for hooks/lib/enforce.js (GH-520): override marker scanning over
// the SERIALIZED tool_input (JSON-escaped quotes), the deny message builder,
// and the nudge appender.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { scanOverrides, buildDenyMessage, appendNudges } = require('../lib/enforce');

describe('scanOverrides', () => {
  it('finds a marker with an escaped-quote reason inside a Bash command', () => {
    const toolInput = {
      command:
        'git push origin main # synapsys:override=push-block reason="deploy approved by ops"',
    };
    const out = scanOverrides(toolInput);
    assert.equal(out.get('push-block'), 'deploy approved by ops');
  });

  it('finds a marker in the description field', () => {
    const toolInput = {
      file_path: '/x.js',
      description: 'synapsys:override=recall-before-edit reason="already recalled manually"',
    };
    assert.equal(scanOverrides(toolInput).get('recall-before-edit'), 'already recalled manually');
  });

  it('captures a short reason (caller enforces the 10-char minimum)', () => {
    const out = scanOverrides({ command: 'x # synapsys:override=mem reason="short"' });
    assert.equal(out.get('mem'), 'short');
  });

  it('ignores markers with no reason and returns empty on bad input', () => {
    assert.equal(scanOverrides({ command: 'x # synapsys:override=mem' }).size, 0);
    assert.equal(scanOverrides(undefined).size, 0);
    assert.equal(scanOverrides(null).size, 0);
  });

  it('first occurrence wins per memory name; multiple names coexist', () => {
    const out = scanOverrides({
      command:
        'synapsys:override=a reason="first long reason" synapsys:override=a reason="second long reason" synapsys:override=b reason="another long reason"',
    });
    assert.equal(out.get('a'), 'first long reason');
    assert.equal(out.get('b'), 'another long reason');
  });
});

describe('buildDenyMessage', () => {
  const memory = { name: 'push-block', body: '\nDo not push directly.\n' };

  it('emits the structured format with a trimmed body', () => {
    const msg = buildDenyMessage(memory);
    assert.equal(
      msg,
      [
        '[synapsys:block] push-block',
        'Do not push directly.',
        '',
        'To override, re-issue the SAME tool call including the marker:',
        '  # synapsys:override=push-block reason="<10+ char reason>"',
        "(in the Bash command or the tool's description field). Overrides are per-call and logged.",
      ].join('\n')
    );
  });

  it('appends the too-short notice when asked', () => {
    const msg = buildDenyMessage(memory, { reasonTooShort: true });
    assert.match(msg, /reason is too short \(< 10 chars\) — the block still applies\./);
  });
});

describe('appendNudges', () => {
  it('appends nudge lines below existing output', () => {
    assert.equal(
      appendNudges('BODY', ['[synapsys:suggest] a — x']),
      'BODY\n[synapsys:suggest] a — x'
    );
  });

  it('returns just the nudges when output is empty, and output when no nudges', () => {
    assert.equal(appendNudges('', ['n1', 'n2']), 'n1\nn2');
    assert.equal(appendNudges('OUT', []), 'OUT');
    assert.equal(appendNudges('', []), '');
  });
});
