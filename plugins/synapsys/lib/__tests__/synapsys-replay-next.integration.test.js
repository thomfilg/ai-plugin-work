'use strict';

/**
 * Integration tests for `plugins/synapsys/scripts/synapsys-replay-next.js`
 * (GH-517 Task 2). Drives the phase-next script as a child process with a
 * fake dispatcher loop and asserts the walk→judge→aggregate→report envelope
 * machine + agent file contract.
 *
 * Scenarios (verbatim from tasks.md Task 2):
 *   - phase-next script drives walk to report end-to-end with a fake dispatcher
 *   - --no-judge skips the judge phase entirely
 *   - walk phase persists state and resumes on re-invocation
 *   - judge cap caps dispatched batches via sampleForCap
 *   - agent output with judge-failed entries is reflected in the aggregate
 *   - independent CLI runnability
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SYNAPSYS_ROOT = path.resolve(__dirname, '..', '..');
const NEXT_SCRIPT = path.join(SYNAPSYS_ROOT, 'scripts', 'synapsys-replay-next.js');
const AGENT_FILE = path.join(SYNAPSYS_ROOT, 'agents', 'synapsys-replay-judge.md');

function mkStore(tmp, memories) {
  const storeDir = path.join(tmp, 'store', '.claude', 'synapsys');
  fs.mkdirSync(storeDir, { recursive: true });
  fs.writeFileSync(path.join(storeDir, '.synapsys.json'), '{}');
  for (const m of memories) {
    fs.writeFileSync(
      path.join(storeDir, `${m.name}.md`),
      [
        '---',
        `name: ${m.name}`,
        `description: ${m.description || 'test'}`,
        `events: ${m.events || 'UserPromptSubmit'}`,
        `trigger_prompt: ${m.triggerPrompt || 'foo'}`,
        '---',
        m.body || 'body',
        '',
      ].join('\n')
    );
  }
  return storeDir;
}

function mkTranscripts(tmp, prompts) {
  const baseDir = path.join(tmp, 'projects');
  const projDir = path.join(baseDir, '-tmp-proj');
  fs.mkdirSync(projDir, { recursive: true });
  const jsonl = path.join(projDir, 'session.jsonl');
  fs.writeFileSync(
    jsonl,
    prompts.map((p) => JSON.stringify({ type: 'user', message: { content: p } })).join('\n') + '\n'
  );
  return baseDir;
}

function mkFixture({ memories, prompts }) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'syn-replay-next-'));
  const storeDir = mkStore(tmp, memories);
  const baseDir = mkTranscripts(tmp, prompts);
  const runDir = path.join(tmp, 'run');
  fs.mkdirSync(runDir, { recursive: true });
  return { tmp, storeDir, baseDir, runDir };
}

function runScript(args, { cwd, env } = {}) {
  if (!fs.existsSync(NEXT_SCRIPT)) {
    // Behavioral assertion: script must be installed at the documented path.
    assert.fail(`phase-next script not yet implemented at ${NEXT_SCRIPT}`);
  }
  const result = spawnSync(process.execPath, [NEXT_SCRIPT, ...args], {
    encoding: 'utf8',
    cwd: cwd || process.cwd(),
    env: { ...process.env, ANTHROPIC_API_KEY: '', ...(env || {}) },
  });
  // Strip module-load errors from stderr to keep RED-phase output behavioral.
  if (result.stderr && /Cannot find module|MODULE_NOT_FOUND/.test(result.stderr)) {
    assert.fail('phase-next script missing required modules (not yet implemented)');
  }
  return result;
}

function parseEnvelope(stdout) {
  // Script may emit multiple lines; the envelope is the last JSON line.
  const lines = stdout
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      return JSON.parse(lines[i]);
    } catch {
      /* not json */
    }
  }
  throw new Error(`no JSON envelope in stdout: ${stdout}`);
}

function driveLoop({ storeDir, baseDir, runDir, extraArgs = [], dispatcher, maxIters = 50 }) {
  const args = [
    `--store=${storeDir}`,
    `--transcripts-base=${baseDir}`,
    `--run-dir=${runDir}`,
    ...extraArgs,
  ];
  const envelopes = [];
  let dispatches = 0;
  for (let i = 0; i < maxIters; i++) {
    const result = runScript(args);
    if (result.status !== 0) {
      throw new Error(
        `script exit ${result.status} on iteration ${i}: ${result.stderr}\n${result.stdout}`
      );
    }
    const env = parseEnvelope(result.stdout);
    envelopes.push(env);
    if (env.action === 'done') return { envelopes, dispatches };
    if (env.action === 'dispatch_agent') {
      dispatches++;
      const input = JSON.parse(fs.readFileSync(env.input_file, 'utf8'));
      const output = dispatcher(input, env);
      fs.writeFileSync(env.output_file, JSON.stringify(output));
      continue;
    }
    // action === 'continue' — re-invoke
  }
  throw new Error(`loop did not terminate after ${maxIters} iterations`);
}

test('phase-next script drives walk to report end-to-end with a fake dispatcher', () => {
  const { tmp, storeDir, baseDir, runDir } = mkFixture({
    memories: [{ name: 'ups-bug', triggerPrompt: 'auth bug|login' }],
    prompts: ['please fix the auth bug today', 'login is broken'],
  });

  const { envelopes, dispatches } = driveLoop({
    storeDir,
    baseDir,
    runDir,
    extraArgs: ['--json'],
    dispatcher: (input) => input.map((it) => ({ memory: it.memory, relevant: 'yes' })),
  });

  // Walk → judge (≥1 dispatch) → aggregate → report
  const phases = envelopes.map((e) => e.current_phase);
  assert.ok(phases.includes('walk'), `walk envelope present: ${phases}`);
  assert.ok(phases.includes('judge'), `judge envelope present: ${phases}`);
  assert.ok(phases.includes('aggregate'), `aggregate envelope present: ${phases}`);
  assert.equal(envelopes[envelopes.length - 1].current_phase, 'report');
  assert.equal(envelopes[envelopes.length - 1].action, 'done');
  assert.ok(dispatches >= 1, 'at least one dispatch_agent envelope');

  const finalEnv = envelopes[envelopes.length - 1];
  assert.ok(finalEnv.report_path, 'report_path present');
  assert.ok(fs.existsSync(finalEnv.report_path), 'report file written');
  const payload = JSON.parse(finalEnv.stdout_payload);
  const ups = payload.memories.find((m) => m.name === 'ups-bug');
  assert.ok(ups, 'ups-bug in report');
  assert.notEqual(ups.relevant, null, 'relevant non-null after judge');
  assert.notEqual(ups.fp_rate, null, 'fp_rate non-null after judge');

  fs.rmSync(tmp, { recursive: true, force: true });
});

test('judge phase dispatches the numbered/clipped agent payload with the correct envelope', () => {
  // A long prompt (2000 chars) and a long matched substring exercise the
  // clipping budget; memory name + body must survive untouched (R5/R7).
  const LONG_PROMPT_LEN = 2000;
  const longPrompt = 'auth bug ' + 'x'.repeat(LONG_PROMPT_LEN - 'auth bug '.length);
  assert.equal(longPrompt.length, LONG_PROMPT_LEN, 'fixture prompt is exactly 2000 chars');
  const memoryBody = 'BODY-START ' + 'b'.repeat(400) + ' BODY-END';

  const { tmp, storeDir, baseDir, runDir } = mkFixture({
    // Trigger captures a long substring of the prompt so `matched` needs clipping.
    memories: [{ name: 'ups-bug', triggerPrompt: 'auth bug.*', body: memoryBody }],
    prompts: [longPrompt],
  });

  const inspected = { input: null, envelope: null };
  driveLoop({
    storeDir,
    baseDir,
    runDir,
    extraArgs: ['--json'],
    dispatcher: (input, env) => {
      // Capture the agent dispatch surface: the on-disk numbered payload + envelope.
      if (!inspected.input) {
        inspected.input = input;
        inspected.envelope = env;
      }
      return input.map((it) => ({ memory: it.memory, relevant: 'yes' }));
    },
  });

  // (a) Envelope shape: dispatch_agent to the judge subagent, with the file-mailbox
  //     contract keys and a `remaining` batch count. No api.anthropic.com endpoint.
  const env = inspected.envelope;
  assert.ok(env, 'a dispatch_agent envelope was emitted');
  assert.equal(env.action, 'dispatch_agent', 'envelope action is dispatch_agent');
  assert.equal(env.subagent_type, 'synapsys-replay-judge', 'subagent_type is the judge agent');
  assert.equal(env.current_phase, 'judge', 'dispatch happens in the judge phase');
  assert.ok(
    typeof env.input_file === 'string' && env.input_file.length > 0,
    'input_file path present'
  );
  assert.ok(
    typeof env.output_file === 'string' && env.output_file.length > 0,
    'output_file path present'
  );
  assert.equal(typeof env.remaining, 'number', 'remaining is a numeric batch count');
  // Numbered payload: the FIRST batch is human-numbered batch-1 (1-based), not batch-0.
  assert.match(
    env.input_file,
    /batch-1\.in\.json$/,
    `first dispatch input_file is the numbered batch-1.in.json, got ${env.input_file}`
  );
  assert.match(
    env.output_file,
    /batch-1\.out\.json$/,
    `first dispatch output_file is the numbered batch-1.out.json, got ${env.output_file}`
  );
  // Envelope-only dispatch: nothing references the legacy direct API surface.
  // Absence assertion on the vendor marker, not the full hostname: a hostname
  // substring/regex here trips CodeQL (missing-regexp-anchor /
  // incomplete-url-substring-sanitization) even though this is not
  // sanitization — any 'anthropic' mention would mean the legacy judge leaked.
  assert.ok(
    !JSON.stringify(env).toLowerCase().includes('anthropic'),
    'envelope makes no legacy direct-API (anthropic) reference'
  );

  // (b) The on-disk batch-1.in.json holds the clipped, numbered payload.
  const onDisk = JSON.parse(fs.readFileSync(env.input_file, 'utf8'));
  assert.ok(Array.isArray(onDisk) && onDisk.length >= 1, 'batch input is a non-empty array');
  assert.deepEqual(onDisk, inspected.input, 'envelope input_file matches dispatched input');

  const entry = onDisk[0];
  assert.equal(entry.memory, 'ups-bug', 'memory name preserved verbatim');
  // body preserved (up to the 200-char preview) — not clipped with an ellipsis.
  assert.equal(
    entry.body,
    memoryBody.slice(0, 200),
    'body preserved (first 200 chars, no ellipsis)'
  );
  assert.ok(!entry.body.includes('…'), 'body is not ellipsis-clipped');
  // prompt clipped within the 600-char preview budget.
  assert.ok(entry.prompt.length <= 600, `prompt clipped to <=600, got ${entry.prompt.length}`);
  assert.ok(entry.prompt.length < LONG_PROMPT_LEN, 'prompt is shorter than the 2000-char original');
  assert.match(entry.prompt, /…/, 'long prompt carries the ellipsis marker');
  // matched substring clipped within the 200-char preview budget.
  assert.ok(typeof entry.matched === 'string', 'matched is a string');
  assert.ok(entry.matched.length <= 200, `matched clipped to <=200, got ${entry.matched.length}`);

  fs.rmSync(tmp, { recursive: true, force: true });
});

test('--no-judge skips the judge phase entirely', () => {
  const { tmp, storeDir, baseDir, runDir } = mkFixture({
    memories: [{ name: 'ups-bug', triggerPrompt: 'auth bug|login' }],
    prompts: ['please fix the auth bug today'],
  });

  const { envelopes, dispatches } = driveLoop({
    storeDir,
    baseDir,
    runDir,
    extraArgs: ['--no-judge', '--json'],
    dispatcher: () => {
      throw new Error('dispatcher must not be called under --no-judge');
    },
  });

  assert.equal(dispatches, 0, 'zero dispatch_agent envelopes');
  const phases = envelopes.map((e) => e.current_phase);
  assert.ok(!phases.includes('judge'), `no judge phase: ${phases}`);
  const finalEnv = envelopes[envelopes.length - 1];
  assert.equal(finalEnv.current_phase, 'report');
  assert.equal(finalEnv.action, 'done');
  const payload = JSON.parse(finalEnv.stdout_payload);
  for (const m of payload.memories) {
    assert.equal(m.relevant, null, `${m.name}.relevant=null`);
    assert.equal(m.fp_rate, null, `${m.name}.fp_rate=null`);
  }

  fs.rmSync(tmp, { recursive: true, force: true });
});

test('walk phase persists state and resumes on re-invocation', () => {
  // 11 UPS fires -> 2 batches (JUDGE_BATCH_SIZE=10).
  const prompts = [];
  for (let i = 0; i < 11; i++) prompts.push('please fix the auth bug now');
  const { tmp, storeDir, baseDir, runDir } = mkFixture({
    memories: [{ name: 'ups-bug', triggerPrompt: 'auth bug|login' }],
    prompts,
  });

  const args = [
    `--store=${storeDir}`,
    `--transcripts-base=${baseDir}`,
    `--run-dir=${runDir}`,
    '--json',
  ];
  // First invocation: walk → judge dispatch envelope.
  const r1 = runScript(args);
  assert.equal(r1.status, 0, `first run exit 0: ${r1.stderr}`);
  // State must persist after walk.
  const stateFile = path.join(runDir, 'state.json');
  assert.ok(fs.existsSync(stateFile), 'state.json persisted');

  // Walk through envelopes until first dispatch.
  let envelopes = [parseEnvelope(r1.stdout)];
  while (envelopes[envelopes.length - 1].action === 'continue') {
    const r = runScript(args);
    assert.equal(r.status, 0);
    envelopes.push(parseEnvelope(r.stdout));
  }
  const firstDispatch = envelopes[envelopes.length - 1];
  assert.equal(firstDispatch.action, 'dispatch_agent');
  assert.equal(firstDispatch.current_phase, 'judge');
  assert.equal(firstDispatch.remaining, 2, 'first dispatch remaining=2');

  // Fulfill first batch.
  const input1 = JSON.parse(fs.readFileSync(firstDispatch.input_file, 'utf8'));
  fs.writeFileSync(
    firstDispatch.output_file,
    JSON.stringify(input1.map((it) => ({ memory: it.memory, relevant: 'yes' })))
  );

  // Next invocation: should now emit second dispatch with remaining=1.
  const r2 = runScript(args);
  assert.equal(r2.status, 0, `second run exit 0: ${r2.stderr}`);
  const env2 = parseEnvelope(r2.stdout);
  assert.equal(env2.action, 'dispatch_agent');
  assert.equal(env2.remaining, 1, 'remaining decremented to 1');

  fs.rmSync(tmp, { recursive: true, force: true });
});

test('judge cap caps dispatched batches via sampleForCap', () => {
  // 50 UPS fires; --max-judges=10 caps to 1 batch.
  const prompts = [];
  for (let i = 0; i < 50; i++) prompts.push('please fix the auth bug now');
  const { tmp, storeDir, baseDir, runDir } = mkFixture({
    memories: [{ name: 'ups-bug', triggerPrompt: 'auth bug|login' }],
    prompts,
  });

  const { envelopes, dispatches } = driveLoop({
    storeDir,
    baseDir,
    runDir,
    extraArgs: ['--max-judges=10', '--json'],
    dispatcher: (input) => input.map((it) => ({ memory: it.memory, relevant: 'yes' })),
  });

  assert.ok(dispatches <= 1, `≤1 dispatch_agent envelope, got ${dispatches}`);
  const finalEnv = envelopes[envelopes.length - 1];
  const payload = JSON.parse(finalEnv.stdout_payload);
  assert.equal(payload.extrapolated, true, 'report marked extrapolated=true');

  fs.rmSync(tmp, { recursive: true, force: true });
});

test('agent output with judge-failed entries is reflected in the aggregate', () => {
  const { tmp, storeDir, baseDir, runDir } = mkFixture({
    memories: [{ name: 'ups-bug', triggerPrompt: 'auth bug|login' }],
    prompts: ['please fix the auth bug today', 'login is broken'],
  });

  const { envelopes } = driveLoop({
    storeDir,
    baseDir,
    runDir,
    extraArgs: ['--json'],
    dispatcher: (input) =>
      input.map((it, i) => ({
        memory: it.memory,
        relevant: i === 0 ? 'judge-failed' : 'no',
      })),
  });

  const finalEnv = envelopes[envelopes.length - 1];
  const payload = JSON.parse(finalEnv.stdout_payload);
  const ups = payload.memories.find((m) => m.name === 'ups-bug');
  assert.ok(ups, 'ups-bug in report');
  assert.equal(ups.judge_failed, 1, 'judge_failed=1');
  assert.equal(ups.irrelevant, 1, 'irrelevant=1');
  assert.equal(ups.relevant, 0, 'relevant=0');
  // fp_rate excludes judge_failed: 1 - 0/(0+1) = 1
  assert.equal(ups.fp_rate, 1, 'fp_rate excludes judge_failed from denom');

  fs.rmSync(tmp, { recursive: true, force: true });
});

test('independent CLI runnability', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'syn-replay-next-cli-'));
  if (!fs.existsSync(NEXT_SCRIPT)) {
    assert.fail(`phase-next script not yet implemented at ${NEXT_SCRIPT}`);
  }
  const result = spawnSync(process.execPath, [NEXT_SCRIPT], {
    encoding: 'utf8',
    cwd: tmp,
    env: { ...process.env, ANTHROPIC_API_KEY: '' },
  });
  assert.equal(result.status, 0, `expected exit 0, got ${result.status}: ${result.stderr}`);
  // Exactly one JSON envelope on stdout.
  const env = parseEnvelope(result.stdout);
  assert.ok(env.current_phase, 'envelope has current_phase');
  assert.ok(env.action, 'envelope has action');

  // Agent file presence + contract.
  assert.ok(fs.existsSync(AGENT_FILE), `agent file exists at ${AGENT_FILE}`);
  const body = fs.readFileSync(AGENT_FILE, 'utf8');
  assert.match(body, /relevance judge/i, 'agent mentions relevance judge');
  // Front-matter tools: Read, Write
  const fm = body.split('---')[1] || '';
  assert.match(fm, /tools\s*:\s*.*Read/i, 'agent declares Read in tools');
  assert.match(fm, /tools\s*:\s*.*Write/i, 'agent declares Write in tools');

  fs.rmSync(tmp, { recursive: true, force: true });
});
