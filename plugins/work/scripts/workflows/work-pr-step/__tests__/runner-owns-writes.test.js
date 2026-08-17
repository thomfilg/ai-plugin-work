'use strict';

/**
 * The pr-step runner performs its own filesystem writes.
 *
 * `agents/pr-generator.md` grants `Bash, Read, Grep, Glob, WebFetch` — no Write
 * — and `work-pr/agents/pr-generator/pr-generator-readonly-guard.js` blocks
 * every shell redirect, `tee`, `sed -i` and friends. That read-only-ness is
 * deliberate. But three phases used to block on writes only a Write tool could
 * perform (pr-body.md, the pr-context.json prNumber/url patch, the
 * `<!-- pr-memorized -->` sentinel), plus a memory-plugin MCP call the agent
 * has no binding for. The agent correctly stopped and reported each time, and
 * the orchestrator had to do the writes by hand.
 *
 * The runner owns them now — the same thing `diff_audit` already does with its
 * changed-file snapshot — so the guard stays intact.
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const descDraft = require('../lib/phases/description_draft');
const createOrUpdate = require('../lib/phases/create_or_update');
const memorize = require('../lib/phases/memorize');

let sandbox;
let savedPath;

const LOCAL_HEAD = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';

/**
 * Put a fake `gh` (and a `git` answering `branch --show-current` /
 * `rev-parse HEAD`) at the front of PATH. `payload` is what
 * `gh pr view --json ...` returns; pass null to make `gh` exit non-zero, i.e.
 * "no PR for this branch". `headSha` is what local git reports for HEAD.
 */
function stubGh(payload, headSha = LOCAL_HEAD) {
  const bin = path.join(sandbox, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const fixture = path.join(sandbox, 'gh-payload.json');
  if (payload === null) {
    fs.rmSync(fixture, { force: true });
  } else {
    fs.writeFileSync(fixture, JSON.stringify(payload));
  }
  fs.writeFileSync(
    path.join(bin, 'gh'),
    ['#!/bin/sh', `[ -f "${fixture}" ] || exit 1`, `cat "${fixture}"`, ''].join('\n'),
    { mode: 0o755 }
  );
  fs.writeFileSync(
    path.join(bin, 'git'),
    [
      '#!/bin/sh',
      'case "$1 $2" in',
      '  "rev-parse HEAD") echo ' + headSha + ' ;;',
      '  *) echo feature-branch ;;',
      'esac',
      '',
    ].join('\n'),
    { mode: 0o755 }
  );
  process.env.PATH = `${bin}${path.delimiter}${savedPath}`;
}

/** An OPEN PR payload. */
function openPr(extra = {}) {
  return {
    number: 4211,
    url: 'https://github.com/o/r/pull/4211',
    state: 'OPEN',
    headRefOid: LOCAL_HEAD,
    ...extra,
  };
}

/** Build a tasks dir seeded with `files`, and the ctx the phase runner passes. */
function mkCtx(files, extra = {}) {
  const tasksDir = path.join(sandbox, 'ECHO-6842');
  fs.mkdirSync(tasksDir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(tasksDir, name), content);
  }
  return {
    ticket: 'ECHO-6842',
    tasksDir,
    tasksBase: sandbox,
    worktreeRoot: sandbox,
    linkedIds: [],
    memory: null,
    ...extra,
  };
}

function readJson(dir, name) {
  return JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
}

const LONG_BODY =
  '## Existing Behavior\n\nThe gate rejected every body the template produced.\n\n' +
  '## Testing Plan / Demo\n\n- run pnpm test\n';

beforeEach(() => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-step-writes-'));
  savedPath = process.env.PATH;
});

afterEach(() => {
  process.env.PATH = savedPath;
  fs.rmSync(sandbox, { recursive: true, force: true });
});

describe('create_or_update owns the pr-context.json patch', () => {
  it('records prNumber and url from the live PR without the agent writing', () => {
    stubGh(openPr());
    const ctx = mkCtx({
      'pr-context.json': JSON.stringify({ base: 'origin/main', files: ['a.ts'] }),
    });

    const r = createOrUpdate.validate(ctx);

    assert.equal(r.ok, true, `blocked: ${JSON.stringify(r.errors)}`);
    const pctx = readJson(ctx.tasksDir, 'pr-context.json');
    assert.equal(pctx.prNumber, 4211);
    assert.equal(pctx.url, 'https://github.com/o/r/pull/4211');
    assert.equal(pctx.base, 'origin/main', 'must merge, not replace, the diff_audit snapshot');
    assert.deepEqual(pctx.files, ['a.ts']);
  });

  it('leaves an already-recorded prNumber alone', () => {
    stubGh(openPr({ number: 9999, url: 'https://github.com/o/r/pull/9999' }));
    const ctx = mkCtx({
      'pr-context.json': JSON.stringify({ files: ['a.ts'], prNumber: 1234, url: 'kept' }),
    });

    assert.equal(createOrUpdate.validate(ctx).ok, true);
    assert.equal(readJson(ctx.tasksDir, 'pr-context.json').prNumber, 1234);
  });

  it('blocks when the branch has no PR yet', () => {
    stubGh(null);
    const ctx = mkCtx({ 'pr-context.json': JSON.stringify({ files: ['a.ts'] }) });

    const r = createOrUpdate.validate(ctx);

    assert.equal(r.ok, false);
    assert.match(r.errors.join('\n'), /gh pr create/);
  });

  it('still blocks when pr-context.json is missing entirely', () => {
    stubGh(openPr({ url: 'u' }));
    const r = createOrUpdate.validate(mkCtx({}));
    assert.equal(r.ok, false);
    assert.match(r.errors.join('\n'), /diff_audit/);
  });
});

describe('description_draft seeds pr-body.md from the open PR', () => {
  it('writes the file itself when the branch already has a PR', () => {
    stubGh(openPr({ body: LONG_BODY }));
    const ctx = mkCtx({});

    const r = descDraft.validate(ctx);

    assert.equal(r.ok, true, `blocked: ${JSON.stringify(r.errors)}`);
    assert.equal(fs.readFileSync(path.join(ctx.tasksDir, 'pr-body.md'), 'utf8'), LONG_BODY);
    assert.match(r.summary, /seeded from the open PR/);
  });

  it('does not overwrite a body that is already substantial', () => {
    stubGh(openPr({ body: LONG_BODY }));
    const ctx = mkCtx({ 'pr-body.md': `${LONG_BODY}\nlocal edits worth keeping\n` });

    assert.equal(descDraft.validate(ctx).ok, true);
    assert.match(
      fs.readFileSync(path.join(ctx.tasksDir, 'pr-body.md'), 'utf8'),
      /local edits worth keeping/
    );
  });

  it('blocks with a first-PR message when there is nothing to seed from', () => {
    stubGh(null);
    const r = descDraft.validate(mkCtx({}));
    assert.equal(r.ok, false);
    assert.match(r.errors.join('\n'), /no PR to seed it from/);
  });

  it('ignores a PR body too short to satisfy the gate', () => {
    stubGh(openPr({ body: 'wip' }));
    const r = descDraft.validate(mkCtx({}));
    assert.equal(r.ok, false);
    assert.equal(fs.existsSync(path.join(sandbox, 'ECHO-6842', 'pr-body.md')), false);
  });
});

// `gh pr view <branch>` falls back to the most recent CLOSED or MERGED PR when
// the branch has no open one. Branch reuse is normal here — a merged branch is
// reset onto the default branch and carries follow-up work under the same name
// — so a stale PR must not be recorded as this change's PR, nor its
// description seeded into pr-body.md.
describe('a stale PR from a reused branch is not adopted', () => {
  const STALE_HEAD = '0000000000000000000000000000000000000000';

  it('create_or_update ignores a MERGED PR whose head is no longer HEAD', () => {
    stubGh(openPr({ state: 'MERGED', headRefOid: STALE_HEAD }));
    const ctx = mkCtx({ 'pr-context.json': JSON.stringify({ files: ['a.ts'] }) });

    const r = createOrUpdate.validate(ctx);

    assert.equal(r.ok, false, "must not advance on a previous change's PR");
    assert.equal(readJson(ctx.tasksDir, 'pr-context.json').prNumber, undefined);
  });

  it('create_or_update ignores a CLOSED PR', () => {
    stubGh(openPr({ state: 'CLOSED', headRefOid: STALE_HEAD }));
    const ctx = mkCtx({ 'pr-context.json': JSON.stringify({ files: ['a.ts'] }) });

    assert.equal(createOrUpdate.validate(ctx).ok, false);
  });

  it('create_or_update still accepts a MERGED PR that is still this HEAD', () => {
    // Merged between phases — rejecting this would strand the ticket, the trap
    // work/workflow-def/delivery-verifiers.js documents.
    stubGh(openPr({ state: 'MERGED', headRefOid: LOCAL_HEAD }));
    const ctx = mkCtx({ 'pr-context.json': JSON.stringify({ files: ['a.ts'] }) });

    assert.equal(createOrUpdate.validate(ctx).ok, true);
    assert.equal(readJson(ctx.tasksDir, 'pr-context.json').prNumber, 4211);
  });

  it('description_draft does not seed from a stale PR body', () => {
    stubGh(openPr({ state: 'MERGED', headRefOid: STALE_HEAD, body: LONG_BODY }));

    const r = descDraft.validate(mkCtx({}));

    assert.equal(r.ok, false);
    assert.equal(fs.existsSync(path.join(sandbox, 'ECHO-6842', 'pr-body.md')), false);
  });
});

describe('memorize owns the sentinel and the payload', () => {
  const MEMORY = { name: 'cortex', rememberTool: 'mcp__plugin_cortex_cortex__cortex_remember' };

  it('writes pr-memory.json and appends the sentinel itself', () => {
    const ctx = mkCtx(
      {
        'pr-body.md': LONG_BODY,
        'pr-context.json': JSON.stringify({
          base: 'origin/main',
          files: ['a.ts', 'b.ts'],
          prNumber: 4211,
          url: 'https://github.com/o/r/pull/4211',
        }),
      },
      { memory: MEMORY, linkedIds: ['ECHO-1'] }
    );

    const r = memorize.validate(ctx);

    assert.equal(r.ok, true, `blocked: ${JSON.stringify(r.errors)}`);
    assert.match(
      fs.readFileSync(path.join(ctx.tasksDir, 'pr-body.md'), 'utf8'),
      /<!-- pr-memorized -->/
    );
    assert.deepEqual(readJson(ctx.tasksDir, 'pr-memory.json'), {
      ticket: 'ECHO-6842',
      prNumber: 4211,
      url: 'https://github.com/o/r/pull/4211',
      baseBranch: 'origin/main',
      changedFiles: ['a.ts', 'b.ts'],
      linkedTickets: ['ECHO-1'],
      memoryPlugin: 'cortex',
      rememberTool: MEMORY.rememberTool,
    });
  });

  it('is idempotent — re-running does not stack sentinels', () => {
    const ctx = mkCtx(
      { 'pr-body.md': LONG_BODY, 'pr-context.json': JSON.stringify({ prNumber: 1 }) },
      { memory: MEMORY }
    );

    memorize.validate(ctx);
    memorize.validate(ctx);

    const body = fs.readFileSync(path.join(ctx.tasksDir, 'pr-body.md'), 'utf8');
    assert.equal(body.match(/<!-- pr-memorized -->/g).length, 1);
  });

  it('points whoever holds the memory binding at the payload', () => {
    const ctx = mkCtx({ 'pr-body.md': LONG_BODY }, { memory: MEMORY });
    const text = memorize.instructions(ctx);
    assert.match(text, /pr-memory\.json/);
    assert.match(text, /Nothing for you to write/);
  });

  it('still blocks when pr-body.md does not exist', () => {
    const r = memorize.validate(mkCtx({}, { memory: MEMORY }));
    assert.equal(r.ok, false);
    assert.match(r.errors.join('\n'), /Missing pr-body\.md/);
  });

  it('auto-passes when no memory plugin is installed', () => {
    assert.equal(memorize.validate(mkCtx({})).ok, true);
  });
});

describe('the read-only guard is still intact', () => {
  const AGENT_MD = path.resolve(__dirname, '..', '..', '..', '..', 'agents', 'pr-generator.md');

  it('pr-generator is granted no file-writing tool', () => {
    const md = fs.readFileSync(AGENT_MD, 'utf8');
    const line = md.split('\n').find((l) => l.startsWith('tools:'));
    assert.ok(line, 'pr-generator.md has no tools: line');
    const tools = line
      .replace(/^tools:\s*/, '')
      .split(',')
      .map((t) => t.trim());
    for (const forbidden of ['Write', 'Edit', 'MultiEdit', 'NotebookEdit']) {
      assert.ok(
        !tools.includes(forbidden),
        `pr-generator must stay read-only — found ${forbidden} in: ${line}`
      );
    }
  });

  it('the guard still blocks redirects and in-place edits', () => {
    const guard = fs.readFileSync(
      path.resolve(
        __dirname,
        '..',
        '..',
        'work-pr',
        'agents',
        'pr-generator',
        'pr-generator-readonly-guard.js'
      ),
      'utf8'
    );
    assert.match(guard, /sed\\s\+-i/);
    assert.match(guard, /FILE_MODIFY_PATTERNS/);
  });
});
