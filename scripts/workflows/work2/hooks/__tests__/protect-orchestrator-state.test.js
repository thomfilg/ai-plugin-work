const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawnSync } = require('child_process');

const HOOK = path.resolve(__dirname, '..', 'protect-orchestrator-state.js');

/**
 * Spawn the hook with the given JSON payload on stdin and return { code, stderr }.
 * Mirrors the pattern used by other hook tests in this repo (spawn + exit code).
 */
function runHook(payload) {
  const res = spawnSync('node', [HOOK], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    timeout: 10000,
  });
  return { code: res.status, stderr: res.stderr || '', stdout: res.stdout || '' };
}

describe('protect-orchestrator-state hook', () => {
  describe('blocks (exit 2) Edit/Write/MultiEdit on orchestrator-managed files', () => {
    const cases = [
      ['.work-state.json', '/tmp/t/ECHO-1/.work-state.json'],
      ['.work-state.json.bak', '/tmp/t/ECHO-1/.work-state.json.bak.20260512'],
      ['.work2-orchestrator.pid', '/tmp/t/ECHO-1/.work2-orchestrator.pid'],
      ['.last-commit-sha', '/tmp/t/ECHO-1/.last-commit-sha'],
      ['.work-actions.json', '/tmp/t/ECHO-1/.work-actions.json'],
      ['task<N>/tdd-phase.json', '/tmp/t/ECHO-1/task3/tdd-phase.json'],
      ['task<N>/task-review-tests.md', '/tmp/t/ECHO-1/task1/task-review-tests.md'],
      ['task<N>/task-review-code.md', '/tmp/t/ECHO-1/task1/task-review-code.md'],
      ['.claims/<lock>', '/tmp/t/ECHO-1/.claims/task-1.lock'],
      ['runs/run<N>/<file>', '/tmp/t/ECHO-1/runs/run5/spec.md'],
      ['archives/<file>', '/tmp/t/ECHO-1/archives/snapshot.json'],
      ['.archive/<file>', '/tmp/t/ECHO-1/.archive/snapshot.json'],
    ];
    for (const [label, fp] of cases) {
      for (const tool of ['Write', 'Edit', 'MultiEdit']) {
        it(`${tool} ${label}`, () => {
          const r = runHook({ tool_name: tool, tool_input: { file_path: fp } });
          assert.equal(r.code, 2, `expected exit 2; stderr=${r.stderr.slice(0, 200)}`);
          assert.match(r.stderr, /orchestrator-managed/);
        });
      }
    }
  });

  describe('blocks (exit 2) Bash write vectors', () => {
    const cases = [
      ['redirect to .work-state.json', 'echo {} > /tmp/t/ECHO-1/.work-state.json'],
      ['append to .work-state.json', 'echo {} >> /tmp/t/ECHO-1/.work-state.json'],
      ['tee .last-commit-sha', 'echo abc | tee /tmp/t/ECHO-1/.last-commit-sha'],
      ['cp into runs/runN', 'cp /tmp/x /tmp/t/ECHO-1/runs/run2/file.md'],
      ['mv onto tdd-phase.json', 'mv /tmp/x /tmp/t/ECHO-1/task1/tdd-phase.json'],
      ['node -e fs.writeFileSync', 'node -e require("fs").writeFileSync(".work-state.json","{}")'],
      ['python3 -c open w', "python3 -c \"open('.work-state.json','w').write('{}')\""],
    ];
    for (const [label, command] of cases) {
      it(label, () => {
        const r = runHook({ tool_name: 'Bash', tool_input: { command } });
        assert.equal(r.code, 2, `expected exit 2; stderr=${r.stderr.slice(0, 200)}`);
      });
    }
  });

  describe('allows (exit 0) legitimate writes', () => {
    const cases = [
      // step-gated artefacts (the other protectors handle step gating; this hook must not block)
      ['Write spec.md', 'Write', '/tmp/t/ECHO-1/spec.md'],
      ['Write brief.md', 'Write', '/tmp/t/ECHO-1/brief.md'],
      ['Write check.md report', 'Write', '/tmp/t/ECHO-1/qa.check.md'],
      ['Write task1 source file', 'Write', '/tmp/t/ECHO-1/task1/src/index.ts'],
      ['Write task1 test file', 'Edit', '/tmp/t/ECHO-1/task1/src/index.test.ts'],
      // unrelated paths must not be touched
      ['Write unrelated json', 'Write', '/tmp/whatever/foo.json'],
      ['Write user file with similar name', 'Write', '/tmp/t/myruns/file.md'],
      ['Write archives.md (file, not dir)', 'Write', '/tmp/t/ECHO-1/archives.md'],
    ];
    for (const [label, tool, fp] of cases) {
      it(`${tool} ${label}`, () => {
        const r = runHook({ tool_name: tool, tool_input: { file_path: fp } });
        assert.equal(r.code, 0, `expected exit 0; stderr=${r.stderr.slice(0, 200)}`);
      });
    }
  });

  describe('allows (exit 0) Bash read-only operations', () => {
    const cases = [
      ['cat .work-state.json', 'cat /tmp/t/ECHO-1/.work-state.json'],
      ['grep tdd-phase.json', 'grep -r foo /tmp/t/ECHO-1/task1/tdd-phase.json'],
      ['ls .claims', 'ls -la /tmp/t/ECHO-1/.claims/'],
      ['echo without redirect', 'echo "this mentions .work-state.json but does not write"'],
    ];
    for (const [label, command] of cases) {
      it(label, () => {
        const r = runHook({ tool_name: 'Bash', tool_input: { command } });
        assert.equal(r.code, 0, `expected exit 0; stderr=${r.stderr.slice(0, 200)}`);
      });
    }
  });

  describe('fail-open behaviour', () => {
    it('exits 0 on malformed JSON input', () => {
      const res = spawnSync('node', [HOOK], { input: 'not json', encoding: 'utf8' });
      assert.equal(res.status, 0);
    });
    it('exits 0 when tool_input is missing', () => {
      const r = runHook({ tool_name: 'Write' });
      assert.equal(r.code, 0);
    });
  });
});
