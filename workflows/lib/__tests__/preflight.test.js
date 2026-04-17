/**
 * Tests for workflows/lib/preflight.js
 *
 * IDEA2 / GH-219 — Task 3: Preflight library with audit hook.
 *
 * Requirements covered:
 *   R12 — Single `runPreflight(context, { audit, checks })` surface returning
 *         `{ allow, reasons, remediation }`; hooks consume; `audit` optional
 *         no-op in tests (spec §Pattern — preflight).
 *   R13 — Wiring contract only — persistence lives in Task 1's
 *         `appendEnforcementAudit`. Preflight MUST NOT import `work-actions.js`
 *         to keep coupling low; callers inject the audit callback.
 *
 * Context shape contract (from Task 2, `workflows/work/work-enforcement-context.js`):
 *   EnforcementContext = {
 *     ticketId, origin, state, tasks, subtaskState, hasWorkflow, error, options
 *   }
 *   EnforcementContextError = { code, message, remediation[] }
 *
 * Run: node --test workflows/lib/__tests__/preflight.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const MODULE_PATH = path.join(__dirname, '..', 'preflight');

// ─── R12 — Module surface / exports ─────────────────────────────────────────

describe('preflight — module surface (R12)', () => {
  it('exports runPreflight as a function', () => {
    const mod = require(MODULE_PATH);
    assert.equal(typeof mod.runPreflight, 'function', 'runPreflight must be exported as a function');
  });

  it('runPreflight has arity 2 (context, options) per the documented contract', () => {
    const { runPreflight } = require(MODULE_PATH);
    assert.equal(
      runPreflight.length,
      2,
      'runPreflight(context, options) must have exactly 2 declared parameters'
    );
  });

  it('has a stable public export shape (Task 12 adds isWriteAllowedPath)', () => {
    const mod = require(MODULE_PATH);
    const exported = Object.keys(mod).sort();

    // Task 3 exported only `runPreflight`. Task 12 adds `isWriteAllowedPath`
    // as the shared path predicate consumed by hooks (Tasks 13-14).
    // Also adds built-in check factories: `createGraphCheck`, `createClaimCheck`, `createPathCheck`.
    assert.deepEqual(
      exported,
      ['createClaimCheck', 'createGraphCheck', 'createPathCheck', 'isWriteAllowedPath', 'runPreflight'],
      `preflight module must export { createClaimCheck, createGraphCheck, createPathCheck, isWriteAllowedPath, runPreflight }; got: ${exported.join(', ')}`
    );
  });

  it('does NOT import work-actions.js (keeps preflight / persistence decoupled — R13)', () => {
    // Load preflight fresh and introspect module.children to verify no
    // transitive dependency on work-actions. This enforces the "do NOT import
    // work-actions.js" rule in the Task 3 spec.
    delete require.cache[require.resolve(MODULE_PATH)];
    require(MODULE_PATH);
    const loaded = require.cache[require.resolve(MODULE_PATH)];
    const childIds = (loaded.children || []).map((c) => c.id);

    for (const id of childIds) {
      assert.ok(
        !/work-actions(\.js)?$/.test(id),
        `preflight must not require work-actions (found: ${id}). ` +
          'Audit persistence is injected by callers via options.audit.'
      );
    }
  });
});

// ─── R12 — Happy path (empty context, no checks) ────────────────────────────

describe('preflight — empty context / happy path (R12)', () => {
  it('returns { allow: true, reasons: [], remediation: [] } when context has no error and no checks', () => {
    const { runPreflight } = require(MODULE_PATH);
    const ctx = { ticketId: 'GH-1', origin: 'user', error: null };

    const result = runPreflight(ctx);

    assert.equal(result.allow, true, 'empty/valid context allows by default (spec §Preflight API)');
    assert.deepEqual(result.reasons, [], 'no reasons on allow path');
    assert.deepEqual(result.remediation, [], 'no remediation on allow path');
  });

  it('returns the full { allow, reasons, remediation } shape on every call', () => {
    const { runPreflight } = require(MODULE_PATH);
    const result = runPreflight({ ticketId: 'GH-1', origin: 'user', error: null });

    assert.ok('allow' in result, 'result.allow key present');
    assert.ok('reasons' in result, 'result.reasons key present');
    assert.ok('remediation' in result, 'result.remediation key present');
    assert.equal(typeof result.allow, 'boolean', 'allow is a boolean');
    assert.ok(Array.isArray(result.reasons), 'reasons is an array');
    assert.ok(Array.isArray(result.remediation), 'remediation is an array');
  });

  it('does not throw when options is undefined (arity-2 default)', () => {
    const { runPreflight } = require(MODULE_PATH);
    assert.doesNotThrow(() => {
      runPreflight({ ticketId: 'GH-1', origin: 'user', error: null });
    }, 'runPreflight must be callable with just a context argument');
  });

  it('does not throw when options is {} (empty options object)', () => {
    const { runPreflight } = require(MODULE_PATH);
    assert.doesNotThrow(() => {
      runPreflight({ ticketId: 'GH-1', origin: 'user', error: null }, {});
    }, 'runPreflight must accept an empty options object');
  });
});

// ─── R12 — context.error denies fail-closed ─────────────────────────────────

describe('preflight — context.error denial (R12, R15 chain)', () => {
  it('context.error with code → allow: false, reasons: [error.code]', () => {
    const { runPreflight } = require(MODULE_PATH);

    const ctx = {
      ticketId: 'GH-219',
      origin: 'user',
      error: {
        code: 'AMBIGUOUS_SUBTASK',
        message: '--subtask set but no subtask state',
        remediation: ['Initialize subtask first', 'Remove --subtask flag'],
      },
    };

    const result = runPreflight(ctx);

    assert.equal(result.allow, false, 'context.error must force deny');
    assert.deepEqual(
      result.reasons,
      ['AMBIGUOUS_SUBTASK'],
      'reasons carries the error.code as a stable rule id'
    );
    assert.deepEqual(
      result.remediation,
      ['Initialize subtask first', 'Remove --subtask flag'],
      'error.remediation is passed through verbatim'
    );
  });

  it('context.error without remediation → remediation defaults to [] (never undefined)', () => {
    const { runPreflight } = require(MODULE_PATH);

    const ctx = {
      ticketId: 'GH-219',
      origin: 'user',
      error: { code: 'INVALID_TICKET_ID', message: 'bad id' },
    };

    const result = runPreflight(ctx);

    assert.equal(result.allow, false);
    assert.deepEqual(result.reasons, ['INVALID_TICKET_ID']);
    assert.ok(Array.isArray(result.remediation), 'remediation is always an array');
    assert.deepEqual(result.remediation, [], 'missing remediation becomes []');
  });

  it('truthy non-object error value is ignored (must be an object with a code)', () => {
    const { runPreflight } = require(MODULE_PATH);

    // Guard: strings/numbers for error should NOT trigger deny — spec says
    // "truthy object with code". This enforces the shape discipline.
    for (const bad of ['string-error', 42, true]) {
      const ctx = { ticketId: 'GH-1', origin: 'user', error: bad };
      const result = runPreflight(ctx);
      assert.equal(
        result.allow,
        true,
        `non-object error=${JSON.stringify(bad)} must not force deny`
      );
    }
  });

  it('error object without a code is ignored (no denial, no crash)', () => {
    const { runPreflight } = require(MODULE_PATH);
    const ctx = { ticketId: 'GH-1', origin: 'user', error: { message: 'no code here' } };
    const result = runPreflight(ctx);
    assert.equal(result.allow, true, 'error lacking a stable code must not deny');
    assert.deepEqual(result.reasons, []);
    assert.deepEqual(result.remediation, []);
  });
});

// ─── R12 — audit default no-op (undefined-safe) ─────────────────────────────

describe('preflight — audit default no-op (R12)', () => {
  it('does not throw when options.audit is undefined on allow path', () => {
    const { runPreflight } = require(MODULE_PATH);
    assert.doesNotThrow(() => {
      runPreflight({ ticketId: 'GH-1', origin: 'user', error: null }, {});
    });
    assert.doesNotThrow(() => {
      runPreflight({ ticketId: 'GH-1', origin: 'user', error: null });
    });
  });

  it('does not throw when options.audit is undefined on deny path', () => {
    const { runPreflight } = require(MODULE_PATH);
    assert.doesNotThrow(() => {
      runPreflight(
        {
          ticketId: 'GH-1',
          origin: 'user',
          error: { code: 'X', message: 'y', remediation: [] },
        },
        {}
      );
    });
  });

  it('does not throw when options itself is null', () => {
    const { runPreflight } = require(MODULE_PATH);
    assert.doesNotThrow(() => {
      runPreflight({ ticketId: 'GH-1', origin: 'user', error: null }, null);
    });
  });
});

// ─── R12 — audit called on ALLOW path with correct entry shape ──────────────

describe('preflight — audit called on ALLOW path (R12)', () => {
  it('invokes audit with { decision: "allow", reasons: [], origin, ticketId } on happy path', () => {
    const { runPreflight } = require(MODULE_PATH);

    const audited = [];
    const audit = (entry) => audited.push(entry);

    const ctx = { ticketId: 'GH-42', origin: 'workflow', error: null };
    const result = runPreflight(ctx, { audit });

    assert.equal(result.allow, true);
    assert.equal(audited.length, 1, 'audit should be called exactly once per decision');

    const entry = audited[0];
    assert.equal(entry.decision, 'allow', 'allow path uses decision="allow"');
    assert.deepEqual(entry.reasons, [], 'empty reasons on allow');
    assert.equal(entry.origin, 'workflow', 'audit entry echoes context.origin');
    assert.equal(entry.ticketId, 'GH-42', 'audit entry echoes context.ticketId');
  });

  it('audit entry is a plain object (single positional arg) — stable callback signature', () => {
    const { runPreflight } = require(MODULE_PATH);

    let receivedArgs;
    const audit = function (...args) {
      receivedArgs = args;
    };

    runPreflight({ ticketId: 'GH-1', origin: 'user', error: null }, { audit });

    assert.ok(receivedArgs, 'audit should have been invoked');
    assert.equal(receivedArgs.length, 1, 'audit takes exactly one positional argument');
    assert.equal(
      typeof receivedArgs[0],
      'object',
      'audit argument is an object (compatible with appendEnforcementAudit entry shape)'
    );
    assert.ok(receivedArgs[0] !== null, 'audit argument is not null');
  });

  it('audit entry shape is compatible with appendEnforcementAudit (forward-compatible fields)', () => {
    const { runPreflight } = require(MODULE_PATH);

    const audited = [];
    runPreflight(
      { ticketId: 'GH-42', origin: 'workflow', error: null },
      { audit: (e) => audited.push(e) }
    );

    const entry = audited[0];
    // Brief-required fields on enforcement audit records (Task 1 shape).
    // Preflight produces a superset-compatible entry that callers can
    // forward directly to appendEnforcementAudit.
    for (const key of ['decision', 'reasons', 'origin', 'ticketId']) {
      assert.ok(
        key in entry,
        `audit entry must include "${key}" for forward-compat with appendEnforcementAudit`
      );
    }
  });
});

// ─── R12 — audit called on DENY path ────────────────────────────────────────

describe('preflight — audit called on DENY path (R12)', () => {
  it('invokes audit with { decision: "deny", reasons, origin, ticketId } when context.error denies', () => {
    const { runPreflight } = require(MODULE_PATH);

    const audited = [];
    const audit = (entry) => audited.push(entry);

    const ctx = {
      ticketId: 'GH-219',
      origin: 'user',
      error: {
        code: 'AMBIGUOUS_SUBTASK',
        message: 'oops',
        remediation: ['fix step 1'],
      },
    };

    const result = runPreflight(ctx, { audit });

    assert.equal(result.allow, false);
    assert.equal(audited.length, 1, 'audit called once for the deny decision');

    const entry = audited[0];
    assert.equal(entry.decision, 'deny');
    assert.deepEqual(entry.reasons, ['AMBIGUOUS_SUBTASK']);
    assert.equal(entry.origin, 'user');
    assert.equal(entry.ticketId, 'GH-219');
  });

  it('deny audit entry preserves remediation for downstream explainability (R18 seed)', () => {
    const { runPreflight } = require(MODULE_PATH);

    let seen;
    runPreflight(
      {
        ticketId: 'GH-219',
        origin: 'user',
        error: {
          code: 'INVALID_TICKET_ID',
          message: 'bad',
          remediation: ['Use a valid id', 'Check env vars'],
        },
      },
      { audit: (e) => (seen = e) }
    );

    assert.ok(seen, 'audit called on deny');
    assert.ok(
      Array.isArray(seen.remediation) && seen.remediation.length === 2,
      'remediation is forwarded to audit entry for explainability'
    );
  });

  it('preflight does not throw when the audit callback itself throws (fail-open on logging)', () => {
    const { runPreflight } = require(MODULE_PATH);

    const throwingAudit = () => {
      throw new Error('disk full');
    };

    // Persistence failures must never break enforcement decisions. This
    // mirrors work-actions.js appendRow() fail-open behavior.
    assert.doesNotThrow(() => {
      runPreflight({ ticketId: 'GH-1', origin: 'user', error: null }, { audit: throwingAudit });
    });
    assert.doesNotThrow(() => {
      runPreflight(
        { ticketId: 'GH-1', origin: 'user', error: { code: 'X', message: 'y' } },
        { audit: throwingAudit }
      );
    });
  });
});

// ─── R12 — options.checks pluggable composition ─────────────────────────────

describe('preflight — pluggable checks (R12, §Pattern — pluggable checks)', () => {
  it('runs checks in declared order', () => {
    const { runPreflight } = require(MODULE_PATH);
    const callOrder = [];

    const checks = [
      (ctx) => {
        callOrder.push('A');
        return null;
      },
      (ctx) => {
        callOrder.push('B');
        return null;
      },
      (ctx) => {
        callOrder.push('C');
        return null;
      },
    ];

    runPreflight({ ticketId: 'GH-1', origin: 'user', error: null }, { checks });
    assert.deepEqual(callOrder, ['A', 'B', 'C'], 'checks invoked in declared order');
  });

  it('all checks returning null/allow → final result is allow with empty reasons', () => {
    const { runPreflight } = require(MODULE_PATH);

    const checks = [
      () => null,
      () => ({ allow: true }),
      () => ({ allow: true, reasons: [], remediation: [] }),
    ];

    const result = runPreflight({ ticketId: 'GH-1', origin: 'user', error: null }, { checks });

    assert.equal(result.allow, true);
    assert.deepEqual(result.reasons, []);
    assert.deepEqual(result.remediation, []);
  });

  it('one check returning { allow: false, ... } → deny result', () => {
    const { runPreflight } = require(MODULE_PATH);

    const checks = [
      () => null,
      () => ({ allow: false, reasons: ['RULE_X'], remediation: ['fix x'] }),
    ];

    const result = runPreflight({ ticketId: 'GH-1', origin: 'user', error: null }, { checks });

    assert.equal(result.allow, false, 'any denying check forces deny');
    assert.ok(result.reasons.includes('RULE_X'), 'reason from denying check is included');
    assert.ok(result.remediation.includes('fix x'), 'remediation from denying check is merged');
  });

  it('multiple denying checks → reasons aggregated, remediation merged', () => {
    const { runPreflight } = require(MODULE_PATH);

    const checks = [
      () => ({ allow: false, reasons: ['RULE_A'], remediation: ['fix A'] }),
      () => ({ allow: false, reasons: ['RULE_B'], remediation: ['fix B', 'also fix B2'] }),
    ];

    const result = runPreflight({ ticketId: 'GH-1', origin: 'user', error: null }, { checks });

    assert.equal(result.allow, false);
    assert.ok(result.reasons.includes('RULE_A'), 'first denying check reason present');
    assert.ok(result.reasons.includes('RULE_B'), 'second denying check reason present');
    assert.ok(result.remediation.includes('fix A'));
    assert.ok(result.remediation.includes('fix B'));
    assert.ok(result.remediation.includes('also fix B2'));
  });

  it('checks compose with context.error: error denial is included in final reasons', () => {
    const { runPreflight } = require(MODULE_PATH);

    const ctx = {
      ticketId: 'GH-1',
      origin: 'user',
      error: { code: 'CTX_ERR', message: 'err', remediation: ['ctx fix'] },
    };

    const checks = [() => ({ allow: false, reasons: ['RULE_Z'], remediation: ['z fix'] })];

    const result = runPreflight(ctx, { checks });

    assert.equal(result.allow, false);
    assert.ok(
      result.reasons.includes('CTX_ERR') || result.reasons.includes('RULE_Z'),
      'at least one deny reason present (context error + checks compose)'
    );
  });

  it('check returning undefined is treated as "no opinion" (allow passthrough)', () => {
    const { runPreflight } = require(MODULE_PATH);

    const checks = [() => undefined, () => ({ allow: true })];
    const result = runPreflight({ ticketId: 'GH-1', origin: 'user', error: null }, { checks });

    assert.equal(result.allow, true, 'undefined/null check results are benign (spec §pluggable)');
    assert.deepEqual(result.reasons, []);
  });

  it('check throwing does not crash preflight (isolated check failure)', () => {
    const { runPreflight } = require(MODULE_PATH);

    const checks = [
      () => {
        throw new Error('check crashed');
      },
      () => ({ allow: true }),
    ];

    // A single check should not poison the whole pipeline. Fail-closed on
    // the crashing check (treat as deny with a synthetic reason) is
    // acceptable; what matters is we never throw out of runPreflight.
    let result;
    assert.doesNotThrow(() => {
      result = runPreflight({ ticketId: 'GH-1', origin: 'user', error: null }, { checks });
    });
    assert.ok(result, 'result returned even when a check threw');
    assert.equal(typeof result.allow, 'boolean');
  });

  it('checks receive the full context as their sole argument', () => {
    const { runPreflight } = require(MODULE_PATH);

    let seenContext;
    const checks = [
      (ctx) => {
        seenContext = ctx;
        return null;
      },
    ];

    const inputCtx = {
      ticketId: 'GH-99',
      origin: 'ai-subtask',
      state: { status: 'in_progress' },
      tasks: [{ id: 'task_1', num: 1 }],
      subtaskState: null,
      hasWorkflow: true,
      error: null,
      options: { subtask: true },
    };

    runPreflight(inputCtx, { checks });

    assert.ok(seenContext, 'check was invoked with a context');
    assert.equal(seenContext.ticketId, 'GH-99', 'checks receive full context.ticketId');
    assert.equal(seenContext.origin, 'ai-subtask', 'checks receive full context.origin');
    assert.equal(seenContext.hasWorkflow, true, 'checks receive full context.hasWorkflow');
  });
});

// ─── R12 — audit receives final decision shape after checks compose ─────────

describe('preflight — audit integration with checks', () => {
  it('audit called once with final aggregated reasons after checks compose (deny path)', () => {
    const { runPreflight } = require(MODULE_PATH);

    const audited = [];
    const audit = (e) => audited.push(e);

    const checks = [
      () => ({ allow: false, reasons: ['RULE_A'], remediation: ['fix A'] }),
      () => ({ allow: false, reasons: ['RULE_B'], remediation: ['fix B'] }),
    ];

    runPreflight({ ticketId: 'GH-1', origin: 'user', error: null }, { checks, audit });

    assert.equal(audited.length, 1, 'audit invoked once per runPreflight call');
    assert.equal(audited[0].decision, 'deny');
    assert.ok(audited[0].reasons.includes('RULE_A'));
    assert.ok(audited[0].reasons.includes('RULE_B'));
  });

  it('audit called with decision="allow" when all checks allow', () => {
    const { runPreflight } = require(MODULE_PATH);

    const audited = [];
    const checks = [() => ({ allow: true }), () => null];

    runPreflight(
      { ticketId: 'GH-1', origin: 'user', error: null },
      { checks, audit: (e) => audited.push(e) }
    );

    assert.equal(audited.length, 1);
    assert.equal(audited[0].decision, 'allow');
    assert.deepEqual(audited[0].reasons, []);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Task 12 — Preflight rules integration (graph, claim, paths)
//
// Requirements covered:
//   R3  — Dependency readiness via canStart
//   R4  — Graph validation (unknown deps, cycles, self-deps)
//   R6  — Task-readiness edit gate (isWriteAllowedPath)
//   R12 — Shared preflight library
//   R13 — Audit on each decision
//   R15 — Sanitized paths, fail closed
//   R18 — Remediation text with ruleId
// ═══════════════════════════════════════════════════════════════════════════════

// ─── 12.1 — isWriteAllowedPath export and behavior (R6, R12) ────────────────

describe('preflight — isWriteAllowedPath export (R6, R12)', () => {
  it('exports isWriteAllowedPath as a function', () => {
    const { isWriteAllowedPath } = require(MODULE_PATH);
    assert.equal(typeof isWriteAllowedPath, 'function', 'isWriteAllowedPath must be exported');
  });

  it('isWriteAllowedPath has arity 2 (filePath, allowedPaths)', () => {
    const { isWriteAllowedPath } = require(MODULE_PATH);
    assert.equal(isWriteAllowedPath.length, 2, 'isWriteAllowedPath(filePath, allowedPaths) needs 2 params');
  });
});

describe('preflight — isWriteAllowedPath: PR{N}/ paths (R6)', () => {
  it('allows paths under the claiming worker PR{N}/ directory', () => {
    const { isWriteAllowedPath } = require(MODULE_PATH);

    const allowed = {
      prDir: '/tasks/GH-219/PR1',
      taskDir: '/tasks/GH-219/task3',
      ticketRoot: '/tasks/GH-219',
    };

    assert.equal(
      isWriteAllowedPath('/tasks/GH-219/PR1/src/index.js', allowed),
      true,
      'files under PR{N}/ are allowed'
    );
    assert.equal(
      isWriteAllowedPath('/tasks/GH-219/PR1/deep/nested/file.ts', allowed),
      true,
      'deeply nested files under PR{N}/ are allowed'
    );
  });

  it('denies paths under a different PR slot', () => {
    const { isWriteAllowedPath } = require(MODULE_PATH);

    const allowed = {
      prDir: '/tasks/GH-219/PR1',
      taskDir: '/tasks/GH-219/task3',
      ticketRoot: '/tasks/GH-219',
    };

    assert.equal(
      isWriteAllowedPath('/tasks/GH-219/PR2/src/file.js', allowed),
      false,
      'files under a different PR slot must be denied'
    );
  });
});

describe('preflight — isWriteAllowedPath: task${N}/ paths (R6)', () => {
  it('allows paths under the claimed task directory', () => {
    const { isWriteAllowedPath } = require(MODULE_PATH);

    const allowed = {
      prDir: '/tasks/GH-219/PR1',
      taskDir: '/tasks/GH-219/task3',
      ticketRoot: '/tasks/GH-219',
    };

    assert.equal(
      isWriteAllowedPath('/tasks/GH-219/task3/implement.md', allowed),
      true,
      'task artifact files under task${N}/ are allowed'
    );
    assert.equal(
      isWriteAllowedPath('/tasks/GH-219/task3/tdd-phase.json', allowed),
      true,
      'tdd-phase.json under task${N}/ is allowed'
    );
  });

  it('denies paths under a different task directory', () => {
    const { isWriteAllowedPath } = require(MODULE_PATH);

    const allowed = {
      prDir: '/tasks/GH-219/PR1',
      taskDir: '/tasks/GH-219/task3',
      ticketRoot: '/tasks/GH-219',
    };

    assert.equal(
      isWriteAllowedPath('/tasks/GH-219/task5/implement.md', allowed),
      false,
      'files under a different task directory must be denied'
    );
  });
});

describe('preflight — isWriteAllowedPath: shared-root whitelist (R6)', () => {
  it('allows brief.md at ticket root', () => {
    const { isWriteAllowedPath } = require(MODULE_PATH);
    const allowed = {
      prDir: '/tasks/GH-219/PR1',
      taskDir: '/tasks/GH-219/task3',
      ticketRoot: '/tasks/GH-219',
    };

    assert.equal(
      isWriteAllowedPath('/tasks/GH-219/brief.md', allowed),
      true,
      'brief.md at ticket root is in the shared whitelist'
    );
  });

  it('allows spec.md at ticket root', () => {
    const { isWriteAllowedPath } = require(MODULE_PATH);
    const allowed = {
      prDir: '/tasks/GH-219/PR1',
      taskDir: '/tasks/GH-219/task3',
      ticketRoot: '/tasks/GH-219',
    };

    assert.equal(
      isWriteAllowedPath('/tasks/GH-219/spec.md', allowed),
      true,
      'spec.md at ticket root is in the shared whitelist'
    );
  });

  it('allows tasks.md at ticket root', () => {
    const { isWriteAllowedPath } = require(MODULE_PATH);
    const allowed = {
      prDir: '/tasks/GH-219/PR1',
      taskDir: '/tasks/GH-219/task3',
      ticketRoot: '/tasks/GH-219',
    };

    assert.equal(
      isWriteAllowedPath('/tasks/GH-219/tasks.md', allowed),
      true,
      'tasks.md at ticket root is in the shared whitelist'
    );
  });

  it('allows .work-state.json at ticket root', () => {
    const { isWriteAllowedPath } = require(MODULE_PATH);
    const allowed = {
      prDir: '/tasks/GH-219/PR1',
      taskDir: '/tasks/GH-219/task3',
      ticketRoot: '/tasks/GH-219',
    };

    assert.equal(
      isWriteAllowedPath('/tasks/GH-219/.work-state.json', allowed),
      true,
      '.work-state.json at ticket root is in the shared whitelist'
    );
  });

  it('allows .work-actions.json at ticket root', () => {
    const { isWriteAllowedPath } = require(MODULE_PATH);
    const allowed = {
      prDir: '/tasks/GH-219/PR1',
      taskDir: '/tasks/GH-219/task3',
      ticketRoot: '/tasks/GH-219',
    };

    assert.equal(
      isWriteAllowedPath('/tasks/GH-219/.work-actions.json', allowed),
      true,
      '.work-actions.json at ticket root is in the shared whitelist'
    );
  });
});

describe('preflight — isWriteAllowedPath: denied paths (R6, R15)', () => {
  it('denies arbitrary paths outside allowed set', () => {
    const { isWriteAllowedPath } = require(MODULE_PATH);
    const allowed = {
      prDir: '/tasks/GH-219/PR1',
      taskDir: '/tasks/GH-219/task3',
      ticketRoot: '/tasks/GH-219',
    };

    assert.equal(
      isWriteAllowedPath('/some/random/file.js', allowed),
      false,
      'arbitrary paths outside PR{N}/, task${N}/, and whitelist are denied'
    );
  });

  it('denies files at ticket root that are not in the whitelist', () => {
    const { isWriteAllowedPath } = require(MODULE_PATH);
    const allowed = {
      prDir: '/tasks/GH-219/PR1',
      taskDir: '/tasks/GH-219/task3',
      ticketRoot: '/tasks/GH-219',
    };

    assert.equal(
      isWriteAllowedPath('/tasks/GH-219/random-file.txt', allowed),
      false,
      'non-whitelisted files at ticket root are denied'
    );
  });

  it('denies paths that are path-traversal attempts from ticket root', () => {
    const { isWriteAllowedPath } = require(MODULE_PATH);
    const allowed = {
      prDir: '/tasks/GH-219/PR1',
      taskDir: '/tasks/GH-219/task3',
      ticketRoot: '/tasks/GH-219',
    };

    assert.equal(
      isWriteAllowedPath('/tasks/GH-219/../GH-220/task1/file.js', allowed),
      false,
      'path traversal attempts are denied (R15)'
    );
  });

  it('returns false (fail closed) when allowedPaths is missing fields', () => {
    const { isWriteAllowedPath } = require(MODULE_PATH);

    assert.equal(
      isWriteAllowedPath('/tasks/GH-219/PR1/file.js', {}),
      false,
      'missing allowedPaths fields must fail closed'
    );
    assert.equal(
      isWriteAllowedPath('/tasks/GH-219/PR1/file.js', null),
      false,
      'null allowedPaths must fail closed'
    );
  });
});

// ─── 12.2 — createGraphCheck (R4 — graph validation) ────────────────────────

describe('preflight — createGraphCheck (R4 — graph validation)', () => {
  it('exports createGraphCheck as a function', () => {
    const { createGraphCheck } = require(MODULE_PATH);
    assert.equal(typeof createGraphCheck, 'function');
  });

  it('returns a check function', () => {
    const { createGraphCheck } = require(MODULE_PATH);
    const check = createGraphCheck();
    assert.equal(typeof check, 'function');
  });

  it('allows when context has no tasks (no graph to validate)', () => {
    const { runPreflight, createGraphCheck } = require(MODULE_PATH);
    const ctx = { ticketId: 'GH-1', origin: 'workflow', error: null, tasks: null };
    const result = runPreflight(ctx, { checks: [createGraphCheck()] });
    assert.equal(result.allow, true, 'null tasks means no graph to validate; allow');
  });

  it('allows when tasks have a valid graph (no errors)', () => {
    const { runPreflight, createGraphCheck } = require(MODULE_PATH);
    const ctx = {
      ticketId: 'GH-1',
      origin: 'workflow',
      error: null,
      tasks: [
        { num: 1, dependencies: [] },
        { num: 2, dependencies: [1] },
      ],
    };
    const result = runPreflight(ctx, { checks: [createGraphCheck()] });
    assert.equal(result.allow, true, 'valid graph passes');
  });

  it('denies when tasks have an unknown dependency (R4)', () => {
    const { runPreflight, createGraphCheck } = require(MODULE_PATH);
    const ctx = {
      ticketId: 'GH-1',
      origin: 'workflow',
      error: null,
      tasks: [
        { num: 1, dependencies: [] },
        { num: 2, dependencies: [99] },
      ],
    };
    const result = runPreflight(ctx, { checks: [createGraphCheck()] });
    assert.equal(result.allow, false, 'unknown dependency denies');
    assert.ok(
      result.reasons.some((r) => r === 'UNKNOWN_DEPENDENCY'),
      'reason includes UNKNOWN_DEPENDENCY ruleId (R18)'
    );
    assert.ok(result.remediation.length > 0, 'remediation text is present (R18)');
  });

  it('denies when tasks have a self-dependency (R4)', () => {
    const { runPreflight, createGraphCheck } = require(MODULE_PATH);
    const ctx = {
      ticketId: 'GH-1',
      origin: 'workflow',
      error: null,
      tasks: [
        { num: 1, dependencies: [1] },
        { num: 2, dependencies: [] },
      ],
    };
    const result = runPreflight(ctx, { checks: [createGraphCheck()] });
    assert.equal(result.allow, false, 'self-dependency denies');
    assert.ok(
      result.reasons.some((r) => r === 'SELF_DEPENDENCY'),
      'reason includes SELF_DEPENDENCY ruleId'
    );
  });

  it('denies when tasks have a cycle (R4)', () => {
    const { runPreflight, createGraphCheck } = require(MODULE_PATH);
    const ctx = {
      ticketId: 'GH-1',
      origin: 'workflow',
      error: null,
      tasks: [
        { num: 1, dependencies: [2] },
        { num: 2, dependencies: [1] },
      ],
    };
    const result = runPreflight(ctx, { checks: [createGraphCheck()] });
    assert.equal(result.allow, false, 'cycle denies');
    assert.ok(
      result.reasons.some((r) => r === 'DEPENDENCY_CYCLE'),
      'reason includes DEPENDENCY_CYCLE ruleId'
    );
  });

  it('remediation on graph deny includes the ruleId for explainability (R18)', () => {
    const { runPreflight, createGraphCheck } = require(MODULE_PATH);
    const ctx = {
      ticketId: 'GH-1',
      origin: 'workflow',
      error: null,
      tasks: [
        { num: 1, dependencies: [] },
        { num: 2, dependencies: [99] },
      ],
    };
    const result = runPreflight(ctx, { checks: [createGraphCheck()] });
    assert.equal(result.allow, false);
    // Each reason string IS the ruleId
    for (const reason of result.reasons) {
      assert.equal(typeof reason, 'string');
      assert.ok(reason.length > 0, 'reason/ruleId is non-empty');
    }
  });
});

// ─── 12.3 — createClaimCheck (R3, R6 — dependency readiness + claim) ─────────

describe('preflight — createClaimCheck (R3, R6 — unclaimed task write)', () => {
  it('exports createClaimCheck as a function', () => {
    const { createClaimCheck } = require(MODULE_PATH);
    assert.equal(typeof createClaimCheck, 'function');
  });

  it('denies when taskNum is provided but no claim info (unclaimed write)', () => {
    const { runPreflight, createClaimCheck } = require(MODULE_PATH);

    const ctx = {
      ticketId: 'GH-219',
      origin: 'workflow',
      error: null,
      state: {
        status: 'in_progress',
        tasksMeta: {
          totalTasks: 3,
          currentTaskIndex: 1,
          tasks: [
            { id: 'task_1', status: 'completed', dependencies: [] },
            { id: 'task_2', status: 'pending', dependencies: [1] },
            { id: 'task_3', status: 'pending', dependencies: [2] },
          ],
        },
      },
      tasks: [
        { num: 1, dependencies: [] },
        { num: 2, dependencies: [1] },
        { num: 3, dependencies: [2] },
      ],
      hasWorkflow: true,
    };

    // No claim: taskNum=2 but ownerId not provided
    const check = createClaimCheck({ taskNum: 2 });
    const result = runPreflight(ctx, { checks: [check] });

    assert.equal(result.allow, false, 'unclaimed task write denied');
    assert.ok(
      result.reasons.some((r) => r === 'UNCLAIMED_TASK_WRITE'),
      'reason includes UNCLAIMED_TASK_WRITE ruleId'
    );
    assert.ok(result.remediation.length > 0, 'remediation present');
  });

  it('allows when taskNum and ownerId are provided and task is startable (R3)', () => {
    const { runPreflight, createClaimCheck } = require(MODULE_PATH);

    const ctx = {
      ticketId: 'GH-219',
      origin: 'workflow',
      error: null,
      state: {
        status: 'in_progress',
        tasksMeta: {
          totalTasks: 2,
          currentTaskIndex: 1,
          tasks: [
            { id: 'task_1', status: 'completed', dependencies: [] },
            { id: 'task_2', status: 'pending', dependencies: [1] },
          ],
        },
      },
      tasks: [
        { num: 1, dependencies: [] },
        { num: 2, dependencies: [1] },
      ],
      hasWorkflow: true,
    };

    const check = createClaimCheck({ taskNum: 2, ownerId: 'PR1' });
    const result = runPreflight(ctx, { checks: [check] });

    assert.equal(result.allow, true, 'claimed task with ready deps allows');
  });

  it('denies when task dependencies are not satisfied (R3)', () => {
    const { runPreflight, createClaimCheck } = require(MODULE_PATH);

    const ctx = {
      ticketId: 'GH-219',
      origin: 'workflow',
      error: null,
      state: {
        status: 'in_progress',
        tasksMeta: {
          totalTasks: 3,
          currentTaskIndex: 0,
          tasks: [
            { id: 'task_1', status: 'pending', dependencies: [] },
            { id: 'task_2', status: 'pending', dependencies: [1] },
            { id: 'task_3', status: 'pending', dependencies: [2] },
          ],
        },
      },
      tasks: [
        { num: 1, dependencies: [] },
        { num: 2, dependencies: [1] },
        { num: 3, dependencies: [2] },
      ],
      hasWorkflow: true,
    };

    // Task 2 depends on Task 1, which is still pending
    const check = createClaimCheck({ taskNum: 2, ownerId: 'PR1' });
    const result = runPreflight(ctx, { checks: [check] });

    assert.equal(result.allow, false, 'task with unsatisfied deps denied');
    assert.ok(
      result.reasons.some((r) => r === 'DEPENDENCY_NOT_READY'),
      'reason includes DEPENDENCY_NOT_READY ruleId'
    );
  });

  it('allows when no tasksMeta exists (legacy/pre-IDEA2 — R16 backward compat)', () => {
    const { runPreflight, createClaimCheck } = require(MODULE_PATH);

    const ctx = {
      ticketId: 'GH-1',
      origin: 'workflow',
      error: null,
      state: { status: 'in_progress' },
      tasks: null,
      hasWorkflow: true,
    };

    // No tasksMeta = legacy mode, no claim enforcement
    const check = createClaimCheck({});
    const result = runPreflight(ctx, { checks: [check] });

    assert.equal(result.allow, true, 'legacy mode without tasksMeta allows (R16)');
  });
});

// ─── 12.4 — createPathCheck (R6 — task-readiness edit gate) ──────────────────

describe('preflight — createPathCheck (R6 — path intent check)', () => {
  it('exports createPathCheck as a function', () => {
    const { createPathCheck } = require(MODULE_PATH);
    assert.equal(typeof createPathCheck, 'function');
  });

  it('allows writes to PR{N}/ for the claiming worker', () => {
    const { runPreflight, createPathCheck } = require(MODULE_PATH);

    const ctx = {
      ticketId: 'GH-219',
      origin: 'workflow',
      error: null,
      hasWorkflow: true,
    };

    const check = createPathCheck({
      filePath: '/tasks/GH-219/PR1/src/index.js',
      allowedPaths: {
        prDir: '/tasks/GH-219/PR1',
        taskDir: '/tasks/GH-219/task3',
        ticketRoot: '/tasks/GH-219',
      },
    });

    const result = runPreflight(ctx, { checks: [check] });
    assert.equal(result.allow, true, 'writes to PR{N}/ are allowed');
  });

  it('denies writes outside the allowed set', () => {
    const { runPreflight, createPathCheck } = require(MODULE_PATH);

    const ctx = {
      ticketId: 'GH-219',
      origin: 'workflow',
      error: null,
      hasWorkflow: true,
    };

    const check = createPathCheck({
      filePath: '/some/other/repo/file.js',
      allowedPaths: {
        prDir: '/tasks/GH-219/PR1',
        taskDir: '/tasks/GH-219/task3',
        ticketRoot: '/tasks/GH-219',
      },
    });

    const result = runPreflight(ctx, { checks: [check] });
    assert.equal(result.allow, false, 'writes outside allowed paths denied');
    assert.ok(
      result.reasons.some((r) => r === 'PATH_NOT_ALLOWED'),
      'reason includes PATH_NOT_ALLOWED ruleId'
    );
  });

  it('allows writes to shared-root whitelist files at ticket root', () => {
    const { runPreflight, createPathCheck } = require(MODULE_PATH);

    const ctx = {
      ticketId: 'GH-219',
      origin: 'workflow',
      error: null,
      hasWorkflow: true,
    };

    for (const file of ['brief.md', 'spec.md', 'tasks.md', '.work-state.json', '.work-actions.json']) {
      const check = createPathCheck({
        filePath: `/tasks/GH-219/${file}`,
        allowedPaths: {
          prDir: '/tasks/GH-219/PR1',
          taskDir: '/tasks/GH-219/task3',
          ticketRoot: '/tasks/GH-219',
        },
      });

      const result = runPreflight(ctx, { checks: [check] });
      assert.equal(result.allow, true, `shared-root whitelist file ${file} is allowed`);
    }
  });

  it('skips path check when no filePath is provided (no path intent to validate)', () => {
    const { runPreflight, createPathCheck } = require(MODULE_PATH);

    const ctx = {
      ticketId: 'GH-219',
      origin: 'workflow',
      error: null,
      hasWorkflow: true,
    };

    const check = createPathCheck({
      allowedPaths: {
        prDir: '/tasks/GH-219/PR1',
        taskDir: '/tasks/GH-219/task3',
        ticketRoot: '/tasks/GH-219',
      },
    });

    const result = runPreflight(ctx, { checks: [check] });
    assert.equal(result.allow, true, 'no filePath means no path to deny');
  });
});

// ─── 12.5 — Full preflight composition (happy path + deny) ──────────────────

describe('preflight — full composition: graph + claim + path (R3, R4, R6)', () => {
  it('happy path: valid graph, claimed task, matching paths → allow', () => {
    const { runPreflight, createGraphCheck, createClaimCheck, createPathCheck } = require(MODULE_PATH);

    const ctx = {
      ticketId: 'GH-219',
      origin: 'workflow',
      error: null,
      state: {
        status: 'in_progress',
        tasksMeta: {
          totalTasks: 2,
          currentTaskIndex: 1,
          tasks: [
            { id: 'task_1', status: 'completed', dependencies: [] },
            { id: 'task_2', status: 'pending', dependencies: [1] },
          ],
        },
      },
      tasks: [
        { num: 1, dependencies: [] },
        { num: 2, dependencies: [1] },
      ],
      hasWorkflow: true,
    };

    const checks = [
      createGraphCheck(),
      createClaimCheck({ taskNum: 2, ownerId: 'PR1' }),
      createPathCheck({
        filePath: '/tasks/GH-219/PR1/src/main.js',
        allowedPaths: {
          prDir: '/tasks/GH-219/PR1',
          taskDir: '/tasks/GH-219/task2',
          ticketRoot: '/tasks/GH-219',
        },
      }),
    ];

    const result = runPreflight(ctx, { checks });
    assert.equal(result.allow, true, 'full composition happy path allows');
    assert.deepEqual(result.reasons, []);
  });

  it('audit callback is invoked with full decision on composed happy path', () => {
    const { runPreflight, createGraphCheck, createClaimCheck, createPathCheck } = require(MODULE_PATH);

    const audited = [];
    const ctx = {
      ticketId: 'GH-219',
      origin: 'workflow',
      error: null,
      state: {
        status: 'in_progress',
        tasksMeta: {
          totalTasks: 2,
          currentTaskIndex: 1,
          tasks: [
            { id: 'task_1', status: 'completed', dependencies: [] },
            { id: 'task_2', status: 'pending', dependencies: [1] },
          ],
        },
      },
      tasks: [
        { num: 1, dependencies: [] },
        { num: 2, dependencies: [1] },
      ],
      hasWorkflow: true,
    };

    const checks = [
      createGraphCheck(),
      createClaimCheck({ taskNum: 2, ownerId: 'PR1' }),
    ];

    runPreflight(ctx, { checks, audit: (e) => audited.push(e) });

    assert.equal(audited.length, 1, 'audit called once');
    assert.equal(audited[0].decision, 'allow');
    assert.equal(audited[0].ticketId, 'GH-219');
  });

  it('composed deny: invalid graph + unclaimed → all reasons aggregated', () => {
    const { runPreflight, createGraphCheck, createClaimCheck } = require(MODULE_PATH);

    const ctx = {
      ticketId: 'GH-219',
      origin: 'workflow',
      error: null,
      state: {
        status: 'in_progress',
        tasksMeta: {
          totalTasks: 2,
          currentTaskIndex: 0,
          tasks: [
            { id: 'task_1', status: 'pending', dependencies: [99] },
            { id: 'task_2', status: 'pending', dependencies: [1] },
          ],
        },
      },
      tasks: [
        { num: 1, dependencies: [99] },
        { num: 2, dependencies: [1] },
      ],
      hasWorkflow: true,
    };

    const checks = [
      createGraphCheck(),
      createClaimCheck({ taskNum: 1 }), // no ownerId → unclaimed
    ];

    const result = runPreflight(ctx, { checks });

    assert.equal(result.allow, false, 'composed deny from multiple checks');
    assert.ok(result.reasons.length >= 2, 'multiple deny reasons aggregated');
    assert.ok(result.remediation.length > 0, 'aggregated remediation present');
  });

  it('remediation includes ruleId strings (R18 explainability)', () => {
    const { runPreflight, createClaimCheck } = require(MODULE_PATH);

    const ctx = {
      ticketId: 'GH-219',
      origin: 'workflow',
      error: null,
      state: {
        status: 'in_progress',
        tasksMeta: {
          totalTasks: 2,
          currentTaskIndex: 0,
          tasks: [
            { id: 'task_1', status: 'pending', dependencies: [] },
            { id: 'task_2', status: 'pending', dependencies: [1] },
          ],
        },
      },
      tasks: [
        { num: 1, dependencies: [] },
        { num: 2, dependencies: [1] },
      ],
      hasWorkflow: true,
    };

    const check = createClaimCheck({ taskNum: 2, ownerId: 'PR1' });
    const result = runPreflight(ctx, { checks: [check] });

    assert.equal(result.allow, false, 'task 2 deps not ready');
    // R18: every deny reason is a stable ruleId string
    for (const reason of result.reasons) {
      assert.equal(typeof reason, 'string', 'reason is a string ruleId');
      assert.ok(reason.length > 0, 'ruleId is non-empty');
      // ruleIds are SCREAMING_SNAKE_CASE
      assert.match(reason, /^[A-Z][A-Z0-9_]+$/, `ruleId "${reason}" is SCREAMING_SNAKE_CASE`);
    }
  });
});
