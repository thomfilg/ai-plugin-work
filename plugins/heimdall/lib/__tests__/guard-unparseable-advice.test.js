// CHAR-8178: the `bash-absolute-path-write` lane told the agent the wrong thing.
//
// That lane is the COARSE fallback — it runs only when the structured scanner
// could not model the command, and then matches "write token anywhere +
// protected dir anywhere". Running a script that merely lives under a
// protected dir tripped it, and the message answered with "ask the user to
// UNLOCK this path": wrong twice, because there was no write to unlock and an
// unlock cannot make a command parseable.
//
// Two fixes are pinned here:
//   1. bash-scan modelled `2>/dev/null; cmd` (a redirect target glued to a
//      separator) as unparseable, which is what pushed the reported command
//      into the coarse lane at all — the whole shape now parses and ALLOWS.
//   2. When the coarse lane does fire, the block leads with why the match is
//      imprecise, the fragment that failed to parse, the construct that broke
//      it, and a parseable re-issue; the unlock instruction stays, gated
//      behind that retry.
//
// Discovered by plugins/work/scripts/run-tests.sh (searches plugins/heimdall/).
// Manual: node --test plugins/heimdall/lib/__tests__/guard-unparseable-advice.test.js

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { buildEntries, evaluate } = require(path.resolve(__dirname, '..', 'guard'));
const { scanCommand } = require(path.resolve(__dirname, '..', 'guard', 'bash-scan'));
const { failingFragment, causesFor } = require(
  path.resolve(__dirname, '..', 'guard', 'bash-advice')
);

// Scratch base OUTSIDE os.tmpdir(): the engine exempts temp paths by design
// (GH-658), so a lock rooted there would never match. Mirrors guard.test.js.
const LOCKS = [{ protect: ['.claude'], unlockPhrase: 'edit .claude', trustedSubdirs: ['plugins'] }];

let root;
let repo;
let entries;
let cacheScript;

before(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.homedir(), '.heimdall-char8178-')));
  repo = path.join(root, 'repo');
  cacheScript = path.join(repo, '.claude', 'plugins', 'cache', 'work', 'follow-up-next.js');
  fs.mkdirSync(path.dirname(cacheScript), { recursive: true });
  fs.writeFileSync(cacheScript, '// runner\n');
  entries = buildEntries(LOCKS, repo);
});

after(() => fs.rmSync(root, { recursive: true, force: true }));

const run = (command) =>
  evaluate({
    toolName: 'Bash',
    toolInput: { command },
    transcriptPath: '',
    entries,
    cwd: repo,
  });

describe('bash-scan: a redirect target glued to a separator', () => {
  it('parses `2>/dev/null; cmd` — endTok resolves the pending redirect', () => {
    const scanned = scanCommand('sleep 1 2>/dev/null; echo hi');
    assert.ok(scanned, 'expected a parse, got unparseable');
    assert.equal(scanned.segments.length, 2);
  });

  it('parses `>file&& cmd` and `>file| cmd` too', () => {
    assert.ok(scanCommand('ls > out.txt&& echo hi'));
    assert.ok(scanCommand('ls > out.txt| cat'));
  });

  it('still fails closed on a redirect with no target', () => {
    assert.equal(scanCommand('ls > ; echo hi'), null);
    assert.equal(scanCommand('ls >'), null);
  });
});

describe('the reported CHAR-8178 command', () => {
  // Verbatim shape from the report: an inline assignment, tmux wrappers, a
  // script under the protected dir's trusted `plugins` subdir, and the log
  // redirect that made the coarse lane see "a write".
  const command = (scriptPath) =>
    [
      'S=feature-char-8178',
      'tmux kill-session -t "$S" 2>/dev/null',
      `tmux new-session -d -s "$S" "node '${scriptPath}' CHAR-8178 --init --pr 2068 > /tmp/f.log 2>&1"`,
      'sleep 1 2>/dev/null; tmux has-session -t "$S" 2>/dev/null && echo running || echo exited',
    ].join('\n');

  it('is ALLOWED — the script lives under a trusted subdir and the write goes to /tmp', () => {
    const r = run(command(cacheScript));
    assert.equal(r.exitCode, 0, r.message);
  });

  it('still BLOCKS when the same shape redirects INTO the protected dir', () => {
    const into = command(cacheScript).replace('/tmp/f.log', path.join(repo, '.claude', 'f.log'));
    const r = run(into);
    assert.equal(r.exitCode, 2);
    assert.match(r.message, /BLOCKED \(heimdall\)/);
  });
});

describe('coarse-fallback advice', () => {
  const procSub = () =>
    run(`diff <(cat ${path.join(repo, '.claude', 'settings.json')}) b.json > /tmp/d.txt`);

  it('fires the coarse lane on a command the scanner cannot model', () => {
    const r = procSub();
    assert.equal(r.exitCode, 2);
    assert.match(r.message, /MATCH: bash-absolute-path-write/);
  });

  it('says the match is imprecise instead of asserting a write', () => {
    const { message } = procSub();
    assert.match(message, /could not parse this command/);
    assert.match(message, /whole-string check/);
    assert.match(message, /READING or RUNNING a script that merely lives under a protected/);
  });

  it('names the fragment that failed to parse and the construct that broke it', () => {
    const { message } = procSub();
    assert.match(message, /Could not parse:\n {2}diff <\(cat /);
    assert.match(message, /Unmodeled here: process substitution/);
  });

  it('asks for a parseable re-issue BEFORE the unlock instruction', () => {
    const { message } = procSub();
    const retry = message.indexOf('RE-ISSUE IT IN A SHAPE HEIMDALL CAN SCOPE');
    const unlock = message.indexOf('ACTION REQUIRED');
    assert.ok(retry > 0, 'expected the re-issue block');
    assert.ok(unlock > retry, 'unlock instruction must come after the re-issue block');
    assert.match(message, /ONLY IF the re-issued command is still blocked is the write real/);
  });

  it('names a substitution command word as the cause when that is what broke it', () => {
    const r = run(`R=node; $R ${cacheScript} --init > /tmp/l.log 2>&1`);
    assert.equal(r.exitCode, 2);
    assert.match(r.message, /Unmodeled here: a command word that is a substitution \(`\$R`\)/);
  });

  it('leaves a precisely-matched write untouched — no advice on the exact lane', () => {
    const r = run(`rm -rf ${path.join(repo, '.claude', 'hooks')}`);
    assert.equal(r.exitCode, 2);
    assert.match(r.message, /MATCH: bash-write \.claude/);
    assert.doesNotMatch(r.message, /RE-ISSUE IT IN A SHAPE/);
    assert.doesNotMatch(r.message, /ONLY IF the re-issued command/);
  });
});

describe('bash-advice diagnosis helpers', () => {
  it('narrows a multi-line command to the offending line', () => {
    const command = ['echo one', 'diff <(echo a) b', 'echo three'].join('\n');
    assert.equal(failingFragment(command), 'diff <(echo a) b');
  });

  it('returns null when the literal command parses (a variant broke it, not this text)', () => {
    assert.equal(failingFragment('node run.js --init > /tmp/x.log 2>&1'), null);
  });

  it('reports every unmodeled construct it can prove', () => {
    assert.deepEqual(causesFor('echo $((1+2))'), ['arithmetic expansion `$((…))`']);
    assert.deepEqual(causesFor('echo "unterminated'), ['an unbalanced quote']);
    assert.deepEqual(causesFor('ls >'), ['a redirect with no target']);
  });
});
