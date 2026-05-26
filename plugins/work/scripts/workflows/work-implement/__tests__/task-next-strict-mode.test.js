'use strict';

/**
 * RED-phase tests for Task 3 (GH-392 P0 #3) — strict-mode wrapper for
 * chained / multiline shell commands in task-next.js.
 *
 * Covers scenario: "P0 #3 — strict-mode multiline command"
 *
 * Asserts that:
 *  (a) wrapStrictMode is exported from task-next.js
 *  (b) wrapStrictMode('echo a && false && echo b') returns a string
 *      starting with 'set -euo pipefail;'
 *  (c) wrapStrictMode('echo solo') returns the input unchanged
 *  (d) when the wrapped chained command is run via `bash -lc`, it
 *      exits non-zero (middle-of-chain failure surfaces).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const TASK_NEXT_PATH = path.resolve(
	__dirname,
	'..',
	'task-next.js',
);

test('P0 #3 — strict-mode multiline command: wrapStrictMode is exported from task-next.js', () => {
	const mod = require(TASK_NEXT_PATH);
	assert.equal(
		typeof mod.wrapStrictMode,
		'function',
		'expected task-next.js to export wrapStrictMode()',
	);
});

test('P0 #3 — strict-mode multiline command: chained command gets set -euo pipefail prefix', () => {
	const { wrapStrictMode } = require(TASK_NEXT_PATH);
	const wrapped = wrapStrictMode('echo a && false && echo b');
	assert.equal(typeof wrapped, 'string');
	assert.ok(
		wrapped.startsWith('set -euo pipefail;'),
		`expected wrapped command to start with 'set -euo pipefail;', got: ${wrapped}`,
	);
	assert.ok(
		wrapped.includes('echo a && false && echo b'),
		'expected wrapped command to retain the original chain',
	);
});

test('P0 #3 — strict-mode multiline command: newline-separated commands also get strict prefix', () => {
	const { wrapStrictMode } = require(TASK_NEXT_PATH);
	const multiline = 'echo a\nfalse\necho b';
	const wrapped = wrapStrictMode(multiline);
	assert.ok(
		wrapped.startsWith('set -euo pipefail;'),
		`expected multiline command to be wrapped, got: ${wrapped}`,
	);
});

test('P0 #3 — strict-mode multiline command: single-command invocation is unchanged', () => {
	const { wrapStrictMode } = require(TASK_NEXT_PATH);
	assert.equal(wrapStrictMode('echo solo'), 'echo solo');
});

test('P0 #3 — strict-mode multiline command: wrapped chained failure exits non-zero under bash -lc', () => {
	const { wrapStrictMode } = require(TASK_NEXT_PATH);
	const wrapped = wrapStrictMode('echo a && false && echo b');
	const result = spawnSync('bash', ['-lc', wrapped], { encoding: 'utf8' });
	assert.notEqual(
		result.status,
		0,
		`expected non-zero exit for wrapped chain with middle failure, got status=${result.status} stdout=${result.stdout} stderr=${result.stderr}`,
	);
});
