'use strict';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseEnvContent, findUp, readValues } = require('../envFiles');

let tmp;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'envcfg-files-'));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('parseEnvContent handles export, quotes, comments, and dynamic values', () => {
  const parsed = parseEnvContent(
    [
      '# comment',
      'PLAIN=value',
      'export EXPORTED=yes',
      'QUOTED="two words"',
      "SINGLE='one'",
      'DYNAMIC=$(git config user.name)',
      'REF=$HOME/worktrees',
      'not a var line',
      'lower=skipped',
    ].join('\n')
  );
  assert.equal(parsed.PLAIN.value, 'value');
  assert.equal(parsed.EXPORTED.value, 'yes');
  assert.equal(parsed.QUOTED.value, 'two words');
  assert.equal(parsed.SINGLE.value, 'one');
  assert.equal(parsed.DYNAMIC.dynamic, true);
  assert.equal(parsed.REF.dynamic, true);
  assert.equal(parsed.PLAIN.dynamic, false);
  assert.ok(!('lower' in parsed));
});

test('findUp locates the nearest file walking parents', () => {
  const nested = path.join(tmp, 'a', 'b', 'c');
  fs.mkdirSync(nested, { recursive: true });
  fs.writeFileSync(path.join(tmp, 'a', '.envrc'), 'export X=1\n');
  assert.equal(findUp(nested, ['.envrc']), path.join(tmp, 'a', '.envrc'));
  assert.equal(findUp(nested, ['.does-not-exist'], 3), null);
});

test('readValues layers global < .env < .envrc < process env', () => {
  const home = path.join(tmp, 'home');
  const project = path.join(tmp, 'project');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', '.env'), 'LAYER=global\nONLY_GLOBAL=g\n');
  fs.writeFileSync(path.join(project, '.env'), 'LAYER=env\nONLY_ENV=e\n');
  fs.writeFileSync(path.join(project, '.envrc'), 'export LAYER=envrc\nexport ONLY_ENVRC=r\n');
  const { values, files } = readValues({
    cwd: project,
    home,
    env: { LAYER: 'process', ONLY_PROCESS: 'p' },
  });
  assert.equal(values.LAYER.value, 'process');
  assert.equal(values.ONLY_GLOBAL.value, 'g');
  assert.equal(values.ONLY_ENV.value, 'e');
  assert.equal(values.ONLY_ENVRC.value, 'r');
  assert.equal(values.ONLY_PROCESS.value, 'p');
  assert.equal(files.envrc, path.join(project, '.envrc'));
});
