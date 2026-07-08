// Runtime e2e for the heimdall-fsguard LD_PRELOAD interposer (GH-657).
//
// Proves the ACTUAL enforcement: a write that resolves under a protected dir is
// denied (EACCES) at the syscall level regardless of how the path was built
// (variable / path.join / subprocess), while reads, allowed-subdir writes, and
// writes elsewhere succeed. Linux/glibc only — skipped otherwise.
//
// Discovered by plugins/work/scripts/run-tests.sh.
// Manual: node --test plugins/heimdall/tests/e2e/fsguard-runtime.spec.js

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const PLUGIN_ROOT = path.resolve(__dirname, '..', '..');
const ARCH_MAP = { x64: 'x86_64', arm64: 'aarch64' };
const arch = ARCH_MAP[process.arch] || process.arch;
const SO = path.join(PLUGIN_ROOT, 'scripts', 'bin', `heimdall-fsguard.linux-${arch}.so`);

const linux = process.platform === 'linux';

function ensureShim() {
  if (fs.existsSync(SO)) return true;
  const build = spawnSync('bash', [path.join(PLUGIN_ROOT, 'scripts', 'build-fsguard.sh')], {
    encoding: 'utf8',
  });
  return build.status === 0 && fs.existsSync(SO);
}

let repo;
let prot;
let allowed;

// Run `node -e <code>` with the interposer preloaded; returns spawnSync result.
function guarded(code) {
  return spawnSync('node', ['-e', code], {
    encoding: 'utf8',
    env: {
      ...process.env,
      LD_PRELOAD: SO,
      HEIMDALL_PROTECTED: prot,
      HEIMDALL_ALLOWED: allowed,
    },
  });
}

describe('heimdall-fsguard runtime interposer (GH-657)', { skip: !linux }, () => {
  before(() => {
    if (!ensureShim()) throw new Error(`interposer .so not available at ${SO}`);
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'fsguard-e2e-'));
    prot = path.join(repo, 'prot');
    allowed = path.join(prot, 'ok');
    fs.mkdirSync(allowed, { recursive: true });
    fs.writeFileSync(path.join(prot, 'secret.txt'), 'orig');
  });
  after(() => repo && fs.rmSync(repo, { recursive: true, force: true }));

  const denies = {
    'direct write': `require('fs').writeFileSync(${JSON.stringify('__P__/x.txt')}, 'x')`,
    'path.join write': `const p=require('path');require('fs').writeFileSync(p.join(${JSON.stringify('__P__')},'via.txt'),'x')`,
    subprocess: `require('child_process').execSync('echo x > __P__/child.txt')`,
    unlink: `require('fs').unlinkSync(${JSON.stringify('__P__/secret.txt')})`,
    mkdir: `require('fs').mkdirSync(${JSON.stringify('__P__/newdir')})`,
  };

  for (const [name, tmpl] of Object.entries(denies)) {
    it(`denies ${name}`, () => {
      const r = guarded(tmpl.replaceAll('__P__', prot));
      assert.notEqual(r.status, 0, `expected failure; stderr: ${r.stderr}`);
    });
  }

  it('keeps the protected secret intact after a denied unlink', () => {
    assert.equal(fs.readFileSync(path.join(prot, 'secret.txt'), 'utf8'), 'orig');
  });

  it('allows reading a protected file', () => {
    const r = guarded(
      `process.stdout.write(require('fs').readFileSync(${JSON.stringify(path.join(prot, 'secret.txt'))}, 'utf8'))`
    );
    assert.equal(r.status, 0);
    assert.equal(r.stdout, 'orig');
  });

  it('allows writing into an allowed subdir', () => {
    const r = guarded(
      `require('fs').writeFileSync(${JSON.stringify(path.join(allowed, 'a.txt'))}, 'x')`
    );
    assert.equal(r.status, 0, r.stderr);
  });

  it('allows writing outside the protected dir', () => {
    const out = path.join(os.tmpdir(), `fsguard-free-${process.pid}.txt`);
    const r = guarded(`require('fs').writeFileSync(${JSON.stringify(out)}, 'x')`);
    try {
      assert.equal(r.status, 0, r.stderr);
    } finally {
      fs.rmSync(out, { force: true });
    }
  });
});
