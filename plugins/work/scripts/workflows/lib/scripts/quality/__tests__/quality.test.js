'use strict';

/**
 * Integration tests for the `quality.js` CLI entry.
 *
 * Each test spawns the CLI via `child_process.spawnSync` against a temp
 * repository directory populated with synthetic source files. Tests do not
 * mock the engine or rules — they exercise the full wiring.
 *
 * Tests use `BIOME_BRIDGE_DISABLE=1` to skip the biome-bridge shell-out for
 * the runs that don't exercise cognitive-complexity; the cognitive-complexity
 * scenario installs a stub `npx` shim on PATH so it can assert that path
 * without depending on a real Biome install.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const CLI = path.resolve(__dirname, '..', 'quality.js');

function mkRepo(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quality-cli-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function write(dir, rel, contents) {
  const full = path.join(dir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, contents);
  return full;
}

function runCli(cwd, args = [], extraEnv = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, BIOME_BRIDGE_DISABLE: '1', ...extraEnv },
  });
}

function bigLines(n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(`// line ${i}`);
  return out.join('\n');
}

test('Quality script passes on a clean repo with allowlist populated', (t) => {
  const repo = mkRepo(t);
  write(repo, 'src/clean.js', "'use strict';\nmodule.exports = 1;\n");
  write(repo, '.quality-exceptions', '# empty allowlist\n');

  const res = runCli(repo);
  assert.equal(res.status, 0, `stdout=${res.stdout}\nstderr=${res.stderr}`);
});

test('Quality script hard-fails on a new oversized file', (t) => {
  const repo = mkRepo(t);
  write(repo, 'src/huge.js', bigLines(500));
  write(repo, '.quality-exceptions', '');

  const res = runCli(repo);
  assert.equal(res.status, 1, `stdout=${res.stdout}\nstderr=${res.stderr}`);
  assert.match(res.stdout + res.stderr, /huge\.js/);
  assert.match(res.stdout + res.stderr, /max-lines/);
});

test('Quality script hard-fails on excessive cognitive complexity', (t) => {
  const repo = mkRepo(t);
  // The quality runner shells out to `npx biome ... --reporter=json`. We
  // install a fake `npx` on PATH that emits a synthetic Biome JSON payload
  // with one cognitive-complexity diagnostic for `src/complex.js`.
  write(repo, 'src/complex.js', "'use strict';\nfunction f() { return 1; }\n");
  write(repo, '.quality-exceptions', '');

  const binDir = path.join(repo, '.bin');
  const fakeNpx = path.join(binDir, 'npx');
  const targetFile = path.join(repo, 'src/complex.js');
  const payload = JSON.stringify({
    diagnostics: [
      {
        category: 'lint/complexity/noExcessiveCognitiveComplexity',
        location: { path: { file: targetFile }, line: 2 },
        description: 'Excessive complexity of 20 in function f',
      },
    ],
  });
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(fakeNpx, `#!/usr/bin/env bash\ncat <<'__EOF__'\n${payload}\n__EOF__\n`);
  fs.chmodSync(fakeNpx, 0o755);

  const res = runCli(repo, [], {
    BIOME_BRIDGE_DISABLE: '',
    PATH: `${binDir}:${process.env.PATH || ''}`,
  });

  assert.equal(res.status, 1, `stdout=${res.stdout}\nstderr=${res.stderr}`);
  assert.match(res.stdout + res.stderr, /cognitive-complexity > 15/);
});

test('Allowlisted file with violations is downgraded to a warning', (t) => {
  const repo = mkRepo(t);
  write(repo, 'src/legacy.js', bigLines(500));
  write(repo, '.quality-exceptions', 'src/legacy.js\n');

  const res = runCli(repo);
  assert.equal(res.status, 0, `stdout=${res.stdout}\nstderr=${res.stderr}`);
  assert.match(res.stdout + res.stderr, /allowlisted/);
});

test('Test files and markdown are excluded from max-lines rule', (t) => {
  const repo = mkRepo(t);
  write(repo, 'src/x.test.js', bigLines(500));
  write(repo, 'docs-readme.md', bigLines(500));
  write(repo, 'src/y.spec.js', bigLines(500));
  write(repo, '.quality-exceptions', '');

  const res = runCli(repo, ['--json']);
  assert.equal(res.status, 0, `stdout=${res.stdout}\nstderr=${res.stderr}`);
  const parsed = JSON.parse(res.stdout);
  const maxLinesViolations = parsed.violations.filter((v) => v.rule === 'max-lines');
  assert.equal(maxLinesViolations.length, 0);
});

test('Function over 80 lines is flagged', (t) => {
  const repo = mkRepo(t);
  const bodyLines = [];
  for (let i = 0; i < 90; i++) bodyLines.push(`  const x${i} = ${i};`);
  const body = bodyLines.join('\n');
  write(
    repo,
    'src/longfn.js',
    `'use strict';\nfunction big() {\n${body}\n  return [${bodyLines.length}];\n}\nmodule.exports = big;\n`
  );
  write(repo, '.quality-exceptions', '');

  const res = runCli(repo);
  assert.equal(res.status, 1, `stdout=${res.stdout}\nstderr=${res.stderr}`);
  assert.match(res.stdout + res.stderr, /max-lines-per-function/);
});

test('Nesting depth over 4 is flagged', (t) => {
  const repo = mkRepo(t);
  const deep = `'use strict';
function deep() {
  if (a) {
    if (b) {
      if (c) {
        if (d) {
          if (e) {
            return 1;
          }
        }
      }
    }
  }
}
module.exports = deep;
`;
  write(repo, 'src/deep.js', deep);
  write(repo, '.quality-exceptions', '');

  const res = runCli(repo);
  assert.equal(res.status, 1, `stdout=${res.stdout}\nstderr=${res.stderr}`);
  assert.match(res.stdout + res.stderr, /max-depth/);
});

test('Duplicate code blocks above 50 tokens are flagged', (t) => {
  const repo = mkRepo(t);
  const tokens = [];
  for (let i = 0; i < 60; i++) tokens.push(`token${i}`);
  const block = tokens.join('\n');
  write(repo, 'src/a.js', `'use strict';\n// a\n${block}\n`);
  write(repo, 'src/b.js', `'use strict';\n// b\n${block}\n`);
  write(repo, '.quality-exceptions', '');

  const res = runCli(repo, ['--json']);
  assert.equal(res.status, 1, `stdout=${res.stdout}\nstderr=${res.stderr}`);
  const parsed = JSON.parse(res.stdout);
  const dupes = parsed.violations.filter((v) => v.rule === 'duplicate-blocks');
  assert.ok(
    dupes.length >= 1,
    `expected at least one duplicate-blocks violation, got ${JSON.stringify(parsed.violations)}`
  );
});
