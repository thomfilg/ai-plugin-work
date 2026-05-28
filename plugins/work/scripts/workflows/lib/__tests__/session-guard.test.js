/**
 * Tests for session-guard.js
 *
 * Run with: node --test hooks/__tests__/session-guard.test.js
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const HOOK_PATH = path.join(__dirname, '..', 'hooks', 'session-guard.js');
const SESSION_DIR = path.join(require('os').tmpdir(), 'session-guard-test-' + process.pid);
const TEST_TICKET = 'TEST-999';
const TEST_WORKFLOW = '/work';

function sessionFilePath(ticketId) {
  return path.join(SESSION_DIR, `claude-session-guard-${ticketId}.json`);
}

function cleanupSession(ticketId) {
  try {
    fs.unlinkSync(sessionFilePath(ticketId));
  } catch {
    /* */
  }
}

/**
 * Remove ALL session guard files from the isolated test directory.
 * Safe because SESSION_DIR is a dedicated temp dir per test process.
 */
function cleanupAllSessions() {
  try {
    const files = fs.readdirSync(SESSION_DIR);
    for (const f of files) {
      if (f.startsWith('claude-session-guard-') && f.endsWith('.json')) {
        try {
          fs.unlinkSync(path.join(SESSION_DIR, f));
        } catch {
          /* */
        }
      }
    }
  } catch {
    /* ignore dir read errors */
  }
}

function readSession(ticketId) {
  try {
    return JSON.parse(fs.readFileSync(sessionFilePath(ticketId), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Run session-guard.js as a CLI subcommand
 */
function runCli(args = [], extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, SESSION_GUARD_DIR: SESSION_DIR, ...extraEnv };
    // Neutralize ambient session id unless a test opts in, so legacy-path tests
    // (no ownerSessionId scoping) stay deterministic when run inside a Claude session.
    if (!('CLAUDE_CODE_SESSION_ID' in extraEnv)) delete env.CLAUDE_CODE_SESSION_ID;
    const proc = spawn('node', [HOOK_PATH, ...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
    });

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => {
      stdout += d.toString();
    });
    proc.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    proc.on('close', (code) => resolve({ stdout, stderr, code }));
    proc.on('error', reject);

    proc.stdin.end();
  });
}

/**
 * Run session-guard.js as a hook (stdin JSON input, hook type via env)
 */
function runHook(hookData, hookType, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      SESSION_GUARD_DIR: SESSION_DIR,
      ...extraEnv,
      CLAUDE_HOOK_TYPE: hookType,
    };
    if (!('CLAUDE_CODE_SESSION_ID' in extraEnv)) delete env.CLAUDE_CODE_SESSION_ID;
    const proc = spawn('node', [HOOK_PATH], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
    });

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => {
      stdout += d.toString();
    });
    proc.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    proc.on('close', (code) => resolve({ stdout, stderr, code }));
    proc.on('error', reject);

    proc.stdin.write(JSON.stringify(hookData));
    proc.stdin.end();
  });
}

describe('session-guard', () => {
  before(() => {
    fs.mkdirSync(SESSION_DIR, { recursive: true });
    cleanupAllSessions();
  });
  after(() => {
    cleanupAllSessions();
    try {
      fs.rmdirSync(SESSION_DIR);
    } catch {
      /* */
    }
  });

  beforeEach(() => {
    cleanupAllSessions();
  });

  afterEach(() => {
    cleanupAllSessions();
  });

  // ─── CLI: init ───

  describe('CLI: init', () => {
    it('creates session file with correct fields', async () => {
      const r = await runCli(['init', TEST_TICKET, TEST_WORKFLOW]);
      assert.equal(r.code, 0);

      const session = readSession(TEST_TICKET);
      assert.ok(session, 'session file should exist');
      assert.equal(session.ticketId, TEST_TICKET);
      assert.equal(session.workflow, TEST_WORKFLOW);
      assert.equal(typeof session.passphrase, 'string');
      assert.ok(session.passphrase.length > 0, 'passphrase should be non-empty');
      assert.equal(typeof session.startTime, 'string');
      assert.equal(session.revealed, false);
    });

    it('generates passphrase in WORD-WORD-NUMBER format', async () => {
      await runCli(['init', TEST_TICKET, TEST_WORKFLOW]);
      const session = readSession(TEST_TICKET);
      assert.ok(session);
      // Passphrase should match pattern: WORD-WORD-NNNN (NATO-style)
      assert.match(
        session.passphrase,
        /^[A-Z]+-[A-Z]+-\d{4}$/,
        `passphrase "${session.passphrase}" should match WORD-WORD-NNNN format`
      );
    });

    it('generates unique passphrases on repeated calls', async () => {
      await runCli(['init', TEST_TICKET, TEST_WORKFLOW]);
      const s1 = readSession(TEST_TICKET);
      cleanupSession(TEST_TICKET);

      await runCli(['init', TEST_TICKET, TEST_WORKFLOW]);
      const s2 = readSession(TEST_TICKET);

      // Generate several passphrases and verify no duplicates
      const passphrases = new Set([s1.passphrase, s2.passphrase]);
      for (let i = 0; i < 5; i++) {
        cleanupSession(TEST_TICKET);
        await runCli(['init', TEST_TICKET, TEST_WORKFLOW]);
        const s = readSession(TEST_TICKET);
        passphrases.add(s.passphrase);
      }
      assert.ok(passphrases.size > 1, 'should generate at least 2 unique passphrases out of 7');
    });

    it('outputs session info to stderr', async () => {
      const r = await runCli(['init', TEST_TICKET, TEST_WORKFLOW]);
      assert.equal(r.code, 0);
      assert.ok(r.stderr.length > 0, 'should produce stderr output');
    });
  });

  // ─── CLI: reveal ───

  describe('CLI: reveal', () => {
    it('outputs passphrase to stdout and sets revealed=true', async () => {
      await runCli(['init', TEST_TICKET, TEST_WORKFLOW]);
      const session = readSession(TEST_TICKET);

      const r = await runCli(['reveal', TEST_TICKET]);
      assert.equal(r.code, 0);
      assert.ok(
        r.stdout.includes(session.passphrase),
        `stdout should contain passphrase "${session.passphrase}"`
      );

      const updated = readSession(TEST_TICKET);
      assert.equal(updated.revealed, true);
    });

    it('exits 0 gracefully if no session exists (fail-open)', async () => {
      const r = await runCli(['reveal', 'NONEXISTENT-123']);
      assert.equal(r.code, 0);
    });
  });

  // ─── CLI: complete ───

  describe('CLI: complete', () => {
    it('removes session file', async () => {
      await runCli(['init', TEST_TICKET, TEST_WORKFLOW]);
      assert.ok(readSession(TEST_TICKET), 'session should exist before complete');

      const r = await runCli(['complete', TEST_TICKET]);
      assert.equal(r.code, 0);
      assert.equal(readSession(TEST_TICKET), null, 'session should be removed');
    });

    it('succeeds even if no session exists', async () => {
      const r = await runCli(['complete', 'NONEXISTENT-123']);
      assert.equal(r.code, 0);
    });
  });

  // ─── CLI: finish (atomic teardown) ───

  describe('CLI: finish', () => {
    it('reveals passphrase and removes session file', async () => {
      await runCli(['init', TEST_TICKET, TEST_WORKFLOW]);
      const session = readSession(TEST_TICKET);
      assert.ok(session, 'session should exist before finish');

      const r = await runCli(['finish', TEST_TICKET]);
      assert.equal(r.code, 0);
      assert.ok(r.stdout.includes(session.passphrase), 'should output passphrase');
      assert.equal(readSession(TEST_TICKET), null, 'session file should be removed');
    });

    it('succeeds when no session exists (fail-open)', async () => {
      const r = await runCli(['finish', 'NONEXISTENT-123']);
      assert.equal(r.code, 0);
      assert.ok(r.stderr.includes('skipping finish'));
    });

    it('fails with usage error when no ticketId provided', async () => {
      const r = await runCli(['finish']);
      assert.equal(r.code, 1);
      assert.ok(r.stderr.includes('Usage'));
    });
  });

  // ─── CLI: status ───

  describe('CLI: status', () => {
    it('outputs session info when session exists', async () => {
      await runCli(['init', TEST_TICKET, TEST_WORKFLOW]);
      const r = await runCli(['status', TEST_TICKET]);
      assert.equal(r.code, 0);
      assert.ok(r.stdout.includes(TEST_TICKET));
    });

    it('outputs no-session message when session does not exist', async () => {
      const r = await runCli(['status', 'NONEXISTENT-123']);
      assert.equal(r.code, 0);
      assert.ok(
        r.stdout.includes('no active') || r.stdout.includes('No active'),
        'should indicate no active session'
      );
    });
  });

  // ─── Hook: PreCompact ───

  describe('Hook: PreCompact', () => {
    it('outputs workflow reminder when active session exists', async () => {
      await runCli(['init', TEST_TICKET, TEST_WORKFLOW]);

      const r = await runHook({ session_id: 'test-session', cwd: '/tmp' }, 'PreCompact', {
        SESSION_GUARD_TICKET_ID: TEST_TICKET,
      });
      assert.equal(r.code, 0);
      assert.ok(r.stdout.includes(TEST_TICKET), 'should mention ticket ID');
      assert.ok(
        r.stdout.includes(TEST_WORKFLOW) || r.stdout.includes('/work'),
        'should mention workflow'
      );
      assert.ok(
        r.stdout.toLowerCase().includes('must continue') ||
          r.stdout.toLowerCase().includes('do not abandon') ||
          r.stdout.toLowerCase().includes('active workflow'),
        'should contain reminder language'
      );
    });

    it('is silent when no active session', async () => {
      const r = await runHook({ session_id: 'test-session', cwd: '/tmp' }, 'PreCompact', {
        SESSION_GUARD_TICKET_ID: TEST_TICKET,
      });
      assert.equal(r.code, 0);
      assert.equal(r.stdout.trim(), '', 'should produce no stdout when no session');
    });

    it('always exits 0 (never blocks)', async () => {
      await runCli(['init', TEST_TICKET, TEST_WORKFLOW]);
      const r = await runHook({ session_id: 'test-session', cwd: '/tmp' }, 'PreCompact', {
        SESSION_GUARD_TICKET_ID: TEST_TICKET,
      });
      assert.equal(r.code, 0, 'PreCompact must always exit 0');
    });
  });

  // ─── Hook: Stop ───

  describe('Hook: Stop', () => {
    it('blocks when active unrevealed session exists', async () => {
      await runCli(['init', TEST_TICKET, TEST_WORKFLOW]);

      const r = await runHook(
        { session_id: 'test-session', transcript_path: '/tmp/fake-transcript.jsonl' },
        'Stop',
        { SESSION_GUARD_TICKET_ID: TEST_TICKET }
      );
      assert.equal(r.code, 2, 'should exit 2 to block stop');
      assert.ok(
        r.stderr.includes('BLOCKED') || r.stderr.includes('ACTIVE WORKFLOW SESSION'),
        'should contain blocking message'
      );
      assert.ok(r.stderr.includes(TEST_TICKET), 'should mention ticket');
    });

    it('allows when session is revealed', async () => {
      await runCli(['init', TEST_TICKET, TEST_WORKFLOW]);
      await runCli(['reveal', TEST_TICKET]);

      const r = await runHook(
        { session_id: 'test-session', transcript_path: '/tmp/fake-transcript.jsonl' },
        'Stop',
        { SESSION_GUARD_TICKET_ID: TEST_TICKET }
      );
      assert.equal(r.code, 0, 'should exit 0 when passphrase revealed');
    });

    it('allows when no active session', async () => {
      const r = await runHook(
        { session_id: 'test-session', transcript_path: '/tmp/fake-transcript.jsonl' },
        'Stop',
        { SESSION_GUARD_TICKET_ID: TEST_TICKET }
      );
      assert.equal(r.code, 0, 'should exit 0 when no session');
    });

    it('allows when "abort workflow" in stop message', async () => {
      await runCli(['init', TEST_TICKET, TEST_WORKFLOW]);

      const r = await runHook(
        {
          session_id: 'test-session',
          transcript_path: '/tmp/fake-transcript.jsonl',
          stop_message: 'User said: abort workflow please',
        },
        'Stop',
        { SESSION_GUARD_TICKET_ID: TEST_TICKET }
      );
      assert.equal(r.code, 0, 'should allow stop when abort workflow detected');
    });

    it('allows when "ABORT WORKFLOW" in stop message (case insensitive)', async () => {
      await runCli(['init', TEST_TICKET, TEST_WORKFLOW]);

      const r = await runHook(
        {
          session_id: 'test-session',
          transcript_path: '/tmp/fake-transcript.jsonl',
          stop_message: 'ABORT WORKFLOW',
        },
        'Stop',
        { SESSION_GUARD_TICKET_ID: TEST_TICKET }
      );
      assert.equal(r.code, 0, 'should allow case-insensitive abort');
    });

    it('blocks when stop message does not contain abort', async () => {
      await runCli(['init', TEST_TICKET, TEST_WORKFLOW]);

      const r = await runHook(
        {
          session_id: 'test-session',
          transcript_path: '/tmp/fake-transcript.jsonl',
          stop_message: 'I am done with this task',
        },
        'Stop',
        { SESSION_GUARD_TICKET_ID: TEST_TICKET }
      );
      assert.equal(r.code, 2, 'should block without abort keyword');
    });
  });

  // ─── Edge cases ───

  describe('Edge cases', () => {
    it('handles corrupt session file gracefully (PreCompact)', async () => {
      // Write invalid JSON to session file
      fs.writeFileSync(sessionFilePath(TEST_TICKET), 'not valid json{{{');

      const r = await runHook({ session_id: 'test-session', cwd: '/tmp' }, 'PreCompact');
      assert.equal(r.code, 0, 'should exit 0 on corrupt session');
    });

    it('handles corrupt session file gracefully (Stop)', async () => {
      fs.writeFileSync(sessionFilePath(TEST_TICKET), 'not valid json{{{');

      const r = await runHook(
        { session_id: 'test-session', transcript_path: '/tmp/fake-transcript.jsonl' },
        'Stop'
      );
      assert.equal(r.code, 0, 'should exit 0 (fail-open) on corrupt session');
    });

    it('handles missing CLI arguments', async () => {
      const r = await runCli(['init']); // Missing ticketId and workflow
      assert.ok(r.code !== 0, 'should fail when missing args');
    });

    it('handles unknown subcommand', async () => {
      const r = await runCli(['unknown-cmd', TEST_TICKET]);
      assert.ok(r.code !== 0, 'should fail on unknown command');
    });
  });

  // ─── /check workflow interaction ───

  describe('/check workflow suppresses stop blocking', () => {
    const TEMP_WB = path.join(require('os').tmpdir(), 'sg-check-test-' + process.pid);
    const TEMP_TASKS = path.join(TEMP_WB, 'tasks');
    const CHECK_TICKET = 'CHECK-777';

    before(() => {
      fs.mkdirSync(path.join(TEMP_TASKS, CHECK_TICKET), { recursive: true });
    });
    after(() => {
      try {
        fs.rmSync(TEMP_WB, { recursive: true, force: true });
      } catch {}
    });

    function writeCheckState(workflow, status) {
      const statePath = path.join(TEMP_TASKS, CHECK_TICKET, '.check.workflow-state.json');
      fs.writeFileSync(
        statePath,
        JSON.stringify({ workflow, instanceId: CHECK_TICKET, status, stepStatus: {} })
      );
    }

    function removeCheckState() {
      try {
        fs.unlinkSync(path.join(TEMP_TASKS, CHECK_TICKET, '.check.workflow-state.json'));
      } catch {}
    }

    afterEach(() => {
      cleanupAllSessions();
      removeCheckState();
    });

    it('allows stop when /check workflow is active', async () => {
      await runCli(['init', CHECK_TICKET, '/work'], { WORKTREES_BASE: TEMP_WB });
      writeCheckState('check', 'in_progress');

      const r = await runHook({ stop_message: '' }, 'Stop', {
        WORKTREES_BASE: TEMP_WB,
        SESSION_GUARD_TICKET_ID: CHECK_TICKET,
      });
      assert.equal(r.code, 0, 'should allow stop when /check is active');
    });

    it('still blocks stop when /check is NOT active', async () => {
      await runCli(['init', CHECK_TICKET, '/work'], { WORKTREES_BASE: TEMP_WB });
      // No check state written

      const r = await runHook({ stop_message: '' }, 'Stop', {
        WORKTREES_BASE: TEMP_WB,
        SESSION_GUARD_TICKET_ID: CHECK_TICKET,
      });
      assert.equal(r.code, 2, 'should block stop without /check');
    });

    it('still blocks stop when /check has completed', async () => {
      await runCli(['init', CHECK_TICKET, '/work'], { WORKTREES_BASE: TEMP_WB });
      writeCheckState('check', 'completed');

      const r = await runHook({ stop_message: '' }, 'Stop', {
        WORKTREES_BASE: TEMP_WB,
        SESSION_GUARD_TICKET_ID: CHECK_TICKET,
      });
      assert.equal(r.code, 2, 'should block stop when /check completed');
    });
  });

  describe('cwd-based session scoping', () => {
    afterEach(() => cleanupAllSessions());

    it('blocks stop when session cwd matches current cwd', async () => {
      // Create session with current cwd
      const sessionData = {
        ticketId: 'CWD-1',
        workflow: '/work',
        passphrase: 'TEST-ONLY-ALPHA',
        cwd: process.cwd(),
        startTime: new Date().toISOString(),
        revealed: false,
      };
      fs.writeFileSync(sessionFilePath('CWD-1'), JSON.stringify(sessionData));

      // Disable ticket-based matching to test cwd fallback
      const r = await runHook({ stop_message: '' }, 'Stop', { SESSION_GUARD_TICKET_ID: '' });
      assert.equal(r.code, 2, 'should block when cwd matches');
    });

    it('allows stop when session cwd does NOT match current cwd', async () => {
      // Create session with a different cwd
      const sessionData = {
        ticketId: 'CWD-2',
        workflow: '/work',
        passphrase: 'TEST-ONLY-BRAVO',
        cwd: '/some/other/directory',
        startTime: new Date().toISOString(),
        revealed: false,
      };
      fs.writeFileSync(sessionFilePath('CWD-2'), JSON.stringify(sessionData));

      // Disable ticket-based matching to test cwd fallback
      const r = await runHook({ stop_message: '' }, 'Stop', { SESSION_GUARD_TICKET_ID: '' });
      assert.equal(r.code, 0, 'should allow stop when cwd does not match');
    });

    it('blocks stop for legacy sessions without cwd (backward compat)', async () => {
      // Legacy session without cwd field
      const sessionData = {
        ticketId: 'LEGACY-1',
        workflow: '/work',
        passphrase: 'TEST-ONLY-CHARLIE',
        startTime: new Date().toISOString(),
        revealed: false,
      };
      fs.writeFileSync(sessionFilePath('LEGACY-1'), JSON.stringify(sessionData));

      // Disable ticket-based matching to test cwd fallback
      const r = await runHook({ stop_message: '' }, 'Stop', { SESSION_GUARD_TICKET_ID: '' });
      assert.equal(r.code, 2, 'should block for legacy sessions without cwd');
    });
  });

  // ─── Ticket-based session scoping ───

  describe('ticket-based session scoping', () => {
    afterEach(() => cleanupAllSessions());

    it('blocks stop when session ticketId matches SESSION_GUARD_TICKET_ID', async () => {
      const sessionData = {
        ticketId: 'TICKET-A',
        workflow: '/work',
        passphrase: 'TEST-ONLY-ALPHA',
        cwd: '/irrelevant/path',
        startTime: new Date().toISOString(),
        revealed: false,
      };
      fs.writeFileSync(sessionFilePath('TICKET-A'), JSON.stringify(sessionData));

      const r = await runHook({ stop_message: '' }, 'Stop', {
        SESSION_GUARD_TICKET_ID: 'TICKET-A',
      });
      assert.equal(r.code, 2, 'should block when ticket matches');
    });

    it('allows stop when session ticketId does NOT match SESSION_GUARD_TICKET_ID', async () => {
      const sessionData = {
        ticketId: 'TICKET-A',
        workflow: '/work',
        passphrase: 'TEST-ONLY-ALPHA',
        cwd: '/irrelevant/path',
        startTime: new Date().toISOString(),
        revealed: false,
      };
      fs.writeFileSync(sessionFilePath('TICKET-A'), JSON.stringify(sessionData));

      const r = await runHook({ stop_message: '' }, 'Stop', {
        SESSION_GUARD_TICKET_ID: 'TICKET-B',
      });
      assert.equal(r.code, 0, 'should allow stop when ticket does not match');
    });

    it('ignores unrelated tickets, only blocks matching', async () => {
      // Create two sessions with different tickets, both unrevealed
      const sessionA = {
        ticketId: 'TICKET-A',
        workflow: '/work',
        passphrase: 'TEST-ONLY-ALPHA',
        cwd: '/irrelevant/path',
        startTime: new Date().toISOString(),
        revealed: false,
      };
      const sessionB = {
        ticketId: 'TICKET-B',
        workflow: '/work',
        passphrase: 'TEST-ONLY-BRAVO',
        cwd: '/irrelevant/path',
        startTime: new Date().toISOString(),
        revealed: false,
      };
      fs.writeFileSync(sessionFilePath('TICKET-A'), JSON.stringify(sessionA));
      fs.writeFileSync(sessionFilePath('TICKET-B'), JSON.stringify(sessionB));

      const r = await runHook({ stop_message: '' }, 'Stop', {
        SESSION_GUARD_TICKET_ID: 'TICKET-B',
      });
      assert.equal(r.code, 2, 'should block for matching TICKET-B');
    });

    it('allows stop when matching ticket session is revealed', async () => {
      const sessionData = {
        ticketId: 'TICKET-A',
        workflow: '/work',
        passphrase: 'TEST-ONLY-ALPHA',
        cwd: '/irrelevant/path',
        startTime: new Date().toISOString(),
        revealed: true,
      };
      fs.writeFileSync(sessionFilePath('TICKET-A'), JSON.stringify(sessionData));

      const r = await runHook({ stop_message: '' }, 'Stop', {
        SESSION_GUARD_TICKET_ID: 'TICKET-A',
      });
      assert.equal(r.code, 0, 'should allow stop when matching session is revealed');
    });

    it('falls back to cwd filter when no ticket context', async () => {
      // Session with a different cwd — should not block when no ticket context
      const sessionData = {
        ticketId: 'TICKET-X',
        workflow: '/work',
        passphrase: 'TEST-ONLY-DELTA',
        cwd: '/some/other/dir',
        startTime: new Date().toISOString(),
        revealed: false,
      };
      fs.writeFileSync(sessionFilePath('TICKET-X'), JSON.stringify(sessionData));

      // Empty string opts out of ticket matching, falls back to cwd
      const r = await runHook({ stop_message: '' }, 'Stop', { SESSION_GUARD_TICKET_ID: '' });
      assert.equal(r.code, 0, 'should allow stop when cwd does not match (no ticket context)');
    });

    it('treats empty SESSION_GUARD_TICKET_ID as no ticket context (falls back to cwd)', async () => {
      // Session with current cwd — should block via cwd fallback
      const sessionData = {
        ticketId: 'TICKET-Y',
        workflow: '/work',
        passphrase: 'TEST-ONLY-NOT-SECRET',
        cwd: process.cwd(),
        startTime: new Date().toISOString(),
        revealed: false,
      };
      fs.writeFileSync(sessionFilePath('TICKET-Y'), JSON.stringify(sessionData));

      const r = await runHook({ stop_message: '' }, 'Stop', { SESSION_GUARD_TICKET_ID: '' });
      assert.equal(
        r.code,
        2,
        'should block via cwd fallback when SESSION_GUARD_TICKET_ID is empty'
      );
    });

    it('PreCompact only shows reminders for matching ticket', async () => {
      const sessionA = {
        ticketId: 'TICKET-A',
        workflow: '/work',
        passphrase: 'TEST-ONLY-ALPHA',
        cwd: '/irrelevant/path',
        startTime: new Date().toISOString(),
        revealed: false,
      };
      const sessionB = {
        ticketId: 'TICKET-B',
        workflow: '/work',
        passphrase: 'TEST-ONLY-BRAVO',
        cwd: '/irrelevant/path',
        startTime: new Date().toISOString(),
        revealed: false,
      };
      fs.writeFileSync(sessionFilePath('TICKET-A'), JSON.stringify(sessionA));
      fs.writeFileSync(sessionFilePath('TICKET-B'), JSON.stringify(sessionB));

      const r = await runHook({}, 'PreCompact', { SESSION_GUARD_TICKET_ID: 'TICKET-A' });
      assert.equal(r.code, 0);
      assert.ok(r.stdout.includes('TICKET-A'), 'should mention TICKET-A');
      assert.ok(!r.stdout.includes('TICKET-B'), 'should NOT mention TICKET-B');
    });
  });

  // ─── Hook: Stop — actionable /work message ───

  describe('Hook: Stop — actionable /work message', () => {
    const TASKS_DIR = path.join(SESSION_DIR, 'tasks-base');
    const WORK_TICKET = 'WORK-100';
    const { STEP_ORDER } = require(path.join(__dirname, '..', '..', 'work', 'step-registry'));
    // currentStep in .work-state.json is 1-based (stepIndex + 1)
    const BRIEF_GATE_STEP = STEP_ORDER.indexOf('brief_gate') + 1;

    function writeWorkState(ticketId, state) {
      const dir = path.join(TASKS_DIR, ticketId);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, '.work-state.json'), JSON.stringify(state));
    }

    function cleanupTasksDir() {
      try {
        fs.rmSync(TASKS_DIR, { recursive: true, force: true });
      } catch {
        /* */
      }
    }

    beforeEach(() => {
      cleanupTasksDir();
      fs.mkdirSync(TASKS_DIR, { recursive: true });
    });

    afterEach(() => {
      cleanupTasksDir();
    });

    it('outputs actionable message with step name when /work session active and .work-state.json exists', async () => {
      // currentStep should map to 'brief_gate' per STEP_ORDER
      writeWorkState(WORK_TICKET, { currentStep: BRIEF_GATE_STEP });
      await runCli(['init', WORK_TICKET, '/work']);

      const r = await runHook({ stop_message: '' }, 'Stop', {
        SESSION_GUARD_TICKET_ID: WORK_TICKET,
        TASKS_BASE: TASKS_DIR,
      });
      assert.equal(r.code, 2, 'should exit 2 to block stop');
      assert.ok(r.stderr.includes('BLOCKED'), 'should contain BLOCKED');
      assert.ok(r.stderr.includes('mid-workflow'), 'should mention mid-workflow');
      assert.ok(r.stderr.includes('Do NOT stop'), 'should contain Do NOT stop');
      assert.ok(r.stderr.includes(WORK_TICKET), 'should mention ticket ID');
      assert.ok(r.stderr.includes('brief_gate'), 'should include the step name');
      assert.ok(r.stderr.includes('work.workflow.js'), 'should include orchestrator command');
    });

    it('falls back to generic message when .work-state.json is missing', async () => {
      // No writeWorkState — file does not exist
      await runCli(['init', WORK_TICKET, '/work']);

      const r = await runHook({ stop_message: '' }, 'Stop', {
        SESSION_GUARD_TICKET_ID: WORK_TICKET,
        TASKS_BASE: TASKS_DIR,
      });
      assert.equal(r.code, 2, 'should exit 2 to block stop');
      assert.ok(r.stderr.includes('ACTIVE WORKFLOW SESSION'), 'should contain active workflow');
      assert.ok(r.stderr.includes('MUST continue'), 'should use MUST continue message');
    });

    it('falls back to generic message when .work-state.json has invalid JSON', async () => {
      const dir = path.join(TASKS_DIR, WORK_TICKET);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, '.work-state.json'), '{not valid json!!!');
      await runCli(['init', WORK_TICKET, '/work']);

      const r = await runHook({ stop_message: '' }, 'Stop', {
        SESSION_GUARD_TICKET_ID: WORK_TICKET,
        TASKS_BASE: TASKS_DIR,
      });
      assert.equal(r.code, 2, 'should exit 2 to block stop');
      assert.ok(r.stderr.includes('ACTIVE WORKFLOW SESSION'), 'should contain active workflow');
      assert.ok(r.stderr.includes('MUST continue'), 'should use MUST continue message');
    });

    it('non-/work sessions still get generic message', async () => {
      writeWorkState(WORK_TICKET, { currentStep: 3 });
      await runCli(['init', WORK_TICKET, '/deploy']);

      const r = await runHook({ stop_message: '' }, 'Stop', {
        SESSION_GUARD_TICKET_ID: WORK_TICKET,
        TASKS_BASE: TASKS_DIR,
      });
      assert.equal(r.code, 2, 'should exit 2 to block stop');
      assert.ok(r.stderr.includes('ACTIVE WORKFLOW SESSION'), 'should contain active workflow');
      assert.ok(r.stderr.includes('MUST continue'), 'should use MUST continue message');
    });
  });

  // ─── Session-id scoping (cross-terminal lock bleed) ───
  //
  // Regression for: a finished session whose worktree was removed leaves its
  // shell in another active workflow's cwd. Without session-id scoping, the
  // Stop hook force-holds THIS terminal with the OTHER ticket's lock (and feeds
  // its delegate instructions) because cwd alone cannot tell two co-located
  // Claude sessions apart.
  describe('session-id scoping', () => {
    afterEach(() => cleanupAllSessions());

    function writeOwnedSession(ticketId, ownerSessionId, extra = {}) {
      fs.writeFileSync(
        sessionFilePath(ticketId),
        JSON.stringify({
          ticketId,
          workflow: '/follow-up',
          passphrase: 'TEST-ONLY-OWNED',
          cwd: process.cwd(),
          ownerSessionId,
          startTime: new Date().toISOString(),
          revealed: false,
          ...extra,
        })
      );
    }

    it('init stamps ownerSessionId from CLAUDE_CODE_SESSION_ID', async () => {
      await runCli(['init', TEST_TICKET, TEST_WORKFLOW], {
        CLAUDE_CODE_SESSION_ID: 'sess-owner-1',
      });
      const session = readSession(TEST_TICKET);
      assert.equal(session.ownerSessionId, 'sess-owner-1');
    });

    it('does NOT block a terminal whose session_id differs from the owner', async () => {
      // Owned by another terminal; cwd matches AND ticket context is empty —
      // would have blocked via cwd fallback under the old logic.
      writeOwnedSession('OTHER-1', 'sess-owner-A');

      const r = await runHook({ stop_message: '', session_id: 'sess-terminal-B' }, 'Stop', {
        SESSION_GUARD_TICKET_ID: '',
      });
      assert.equal(r.code, 0, 'foreign-owned session must not hold this terminal');
    });

    it('still blocks the terminal that actually owns the session', async () => {
      writeOwnedSession('OWNED-1', 'sess-owner-A');

      const r = await runHook({ stop_message: '', session_id: 'sess-owner-A' }, 'Stop', {
        SESSION_GUARD_TICKET_ID: '',
      });
      assert.equal(r.code, 2, 'owning terminal should still be blocked');
    });

    it('falls back to cwd/ticket scoping for legacy sessions without ownerSessionId', async () => {
      // No ownerSessionId field → backward compatible: cwd match still blocks.
      const sessionData = {
        ticketId: 'LEGACY-2',
        workflow: '/work',
        passphrase: 'TEST-ONLY-LEGACY',
        cwd: process.cwd(),
        startTime: new Date().toISOString(),
        revealed: false,
      };
      fs.writeFileSync(sessionFilePath('LEGACY-2'), JSON.stringify(sessionData));

      const r = await runHook({ stop_message: '', session_id: 'sess-anything' }, 'Stop', {
        SESSION_GUARD_TICKET_ID: '',
      });
      assert.equal(r.code, 2, 'legacy session without owner still blocks via cwd');
    });

    it('PreCompact omits reminders for a foreign-owned session', async () => {
      writeOwnedSession('FOREIGN-1', 'sess-owner-A', { workflow: '/work' });

      const r = await runHook({ session_id: 'sess-terminal-B' }, 'PreCompact', {
        SESSION_GUARD_TICKET_ID: '',
      });
      assert.equal(r.code, 0);
      assert.ok(!r.stdout.includes('FOREIGN-1'), 'should not surface foreign session');
    });
  });

  // ─── Worktree scoping (cross-worktree lock bleed) ───
  //
  // Regression for: a /follow-up running in worktree A must never hold a Stop
  // firing in sibling worktree B. cwd-equality + branch-ticket heuristics fail
  // when the branch name has no parseable ticket (e.g. GitHub numeric tickets or
  // a `chore/…` branch), so the lock must also be scoped by git worktree root.
  describe('worktree scoping', () => {
    const REPO_ROOT = require('child_process')
      .execSync('git rev-parse --show-toplevel', { cwd: __dirname })
      .toString()
      .trim();

    afterEach(() => cleanupAllSessions());

    function writeWtSession(ticketId, worktreeRoot, extra = {}) {
      fs.writeFileSync(
        sessionFilePath(ticketId),
        JSON.stringify({
          ticketId,
          workflow: '/follow-up',
          passphrase: 'TEST-ONLY-WT',
          cwd: process.cwd(),
          worktreeRoot,
          startTime: new Date().toISOString(),
          revealed: false,
          ...extra,
        })
      );
    }

    it('init stamps worktreeRoot from the current git worktree', async () => {
      await runCli(['init', TEST_TICKET, TEST_WORKFLOW]);
      const session = readSession(TEST_TICKET);
      assert.equal(session.worktreeRoot, REPO_ROOT);
    });

    it('does NOT block a Stop firing in a different worktree', async () => {
      // Lock owned by a sibling worktree; cwd matches AND ticket context is empty
      // — would have blocked via cwd fallback under the old logic.
      writeWtSession('OTHERWT-1', '/some/other/worktree-root');

      const r = await runHook({ stop_message: '' }, 'Stop', { SESSION_GUARD_TICKET_ID: '' });
      assert.equal(r.code, 0, 'a lock from another worktree must not hold this one');
    });

    it('still blocks a Stop firing in the owning worktree', async () => {
      writeWtSession('OWNWT-1', REPO_ROOT);

      const r = await runHook({ stop_message: '' }, 'Stop', { SESSION_GUARD_TICKET_ID: '' });
      assert.equal(r.code, 2, 'owning worktree should still be blocked');
    });

    it('PreCompact omits reminders for a foreign-worktree session', async () => {
      writeWtSession('OTHERWT-2', '/some/other/worktree-root', { workflow: '/work' });

      const r = await runHook({}, 'PreCompact', { SESSION_GUARD_TICKET_ID: '' });
      assert.equal(r.code, 0);
      assert.ok(!r.stdout.includes('OTHERWT-2'), 'should not surface foreign-worktree session');
    });
  });
});
