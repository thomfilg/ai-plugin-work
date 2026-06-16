'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const PKG_PATH = path.join(__dirname, '..', '..', '..', 'package.json');

test('pnpm synapsys:lint script wiring is present in package.json', () => {
  const raw = fs.readFileSync(PKG_PATH, 'utf8');
  const pkg = JSON.parse(raw);
  assert.ok(pkg.scripts, 'package.json should have a scripts section');
  assert.equal(
    pkg.scripts['synapsys:lint'],
    'node plugins/synapsys/scripts/synapsys-lint.js',
    'scripts["synapsys:lint"] should invoke plugins/synapsys/scripts/synapsys-lint.js'
  );
});
