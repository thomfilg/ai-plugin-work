// pane-busy.js — "is the agent mid-tool?" signal from live pane subprocesses.
//
// Gates silence handling: a docker build / test run keeps children alive under
// the pane's claude process while the pane itself is silent. Frozen-idle
// agents have no such children. Fail-open: any lookup error → false.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const MOD = path.resolve(__dirname, '..', 'lib', 'maestro-conduct', 'pane-busy.js');

/**
 * Fake `tmux` (returns a fixed pane pid) + fake `ps` (returns a fixed
 * "pid ppid" table). Absolute /bin/bash shebang — an env-resolved bash would
 * find shims on PATH and recurse.
 */
function makeFakeBins({ panePid, psTable }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pane-busy-'));
  fs.writeFileSync(path.join(dir, 'tmux'), `#!/bin/bash\nprintf '%s\\n' "${panePid}"\nexit 0\n`, {
    mode: 0o755,
  });
  // %b interprets the \n escapes embedded in psTable (with %s they'd stay
  // literal backslash-n and the pid/ppid parser would see one garbage line).
  fs.writeFileSync(path.join(dir, 'ps'), `#!/bin/bash\nprintf '%b' "${psTable}"\nexit 0\n`, {
    mode: 0o755,
  });
  return dir;
}

function loadWith(fakeDir) {
  delete require.cache[require.resolve(MOD)];
  process.env.PATH = `${fakeDir}:${process.env.PATH}`;
  return require(MOD);
}

test('grandchild under the pane root → busy (sh → claude → docker)', () => {
  // 100 = pane root (sh), 200 = claude, 300 = docker build
  const fakeDir = makeFakeBins({ panePid: '100', psTable: '  200 100\\n  300 200\\n' });
  const paneBusy = loadWith(fakeDir);
  assert.equal(paneBusy.paneHasLiveSubprocess('GH-1-work'), true);
});

test('single childless child → NOT busy (lone claude idling under sh)', () => {
  const fakeDir = makeFakeBins({ panePid: '100', psTable: '  200 100\\n' });
  const paneBusy = loadWith(fakeDir);
  assert.equal(paneBusy.paneHasLiveSubprocess('GH-2-work'), false);
});

test('two childless level-1 children → busy (direct-exec claude with running tools)', () => {
  const fakeDir = makeFakeBins({ panePid: '100', psTable: '  200 100\\n  201 100\\n' });
  const paneBusy = loadWith(fakeDir);
  assert.equal(paneBusy.paneHasLiveSubprocess('GH-3-work'), true);
});

test('no children at all → NOT busy', () => {
  const fakeDir = makeFakeBins({ panePid: '100', psTable: '  999 1\\n' });
  const paneBusy = loadWith(fakeDir);
  assert.equal(paneBusy.paneHasLiveSubprocess('GH-4-work'), false);
});

test('fail-open: unresolvable pane pid → false', () => {
  const fakeDir = makeFakeBins({ panePid: '', psTable: '  200 100\\n  300 200\\n' });
  const paneBusy = loadWith(fakeDir);
  assert.equal(paneBusy.paneHasLiveSubprocess('GH-5-work'), false);
  assert.equal(paneBusy.panePid('GH-5-work'), null);
});
