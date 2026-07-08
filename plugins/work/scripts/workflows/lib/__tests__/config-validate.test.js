'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const MODULE_PATH = path.join(__dirname, '..', 'config-validate.js');

// Resolve the module through a try/catch so a not-yet-authored module surfaces
// as a per-test assertion failure (a behavior gap: "module not authored yet")
// rather than a load-time crash whose raw "Cannot find module" string the RED
// recorder treats as a structurally broken test. We swallow the require error
// and assert on a boolean so the failure is a clean behavior gap.
function tryRequireFresh() {
  try {
    delete require.cache[require.resolve(MODULE_PATH)];
  } catch {
    /* not resolvable yet — fall through to the require attempt */
  }
  try {
    return require(MODULE_PATH);
  } catch {
    return null;
  }
}

function loadValidateModule() {
  const mod = tryRequireFresh();
  assert.ok(mod, 'config-validate module is authored and exports an object');
  return mod;
}

// Force a fresh module instance so the module-level `_validated` once-guard
// resets between once-per-invocation assertions.
function freshValidateModule() {
  const mod = tryRequireFresh();
  assert.ok(mod, 'config-validate module is authored and exports an object');
  return mod;
}

// A deterministic test schema mirroring the descriptor shape from
// `config-schema.js`. Tests pass this explicitly to `validateEnv(env, schema)`
// so they do not depend on the live SCHEMA contents.
function testSchema() {
  return {
    ENABLE_DRAFT_PR: { type: 'flag01', description: 'Draft PR flag.' },
    ENABLE_SYMLINK: { type: 'flag01', description: 'Symlink flag.' },
    TICKET_PROVIDER: {
      type: 'enum',
      allowed: ['jira', 'linear', 'github', 'none', ''],
      description: 'Provider.',
    },
    FOLLOW_UP_PR_POLL_REVIEWS: { type: 'bool', description: 'Poll reviews.' },
    WEB_APPS: { type: 'json-array', description: 'Web apps.' },
    BASE_BRANCH: { type: 'string', description: 'Base branch.' },
  };
}

describe('validateEnv — unknown-key scan', () => {
  it('exports validateEnv, formatWarnings, and runStartupValidation', () => {
    const mod = loadValidateModule();
    assert.equal(typeof mod.validateEnv, 'function', 'validateEnv is a function');
    assert.equal(typeof mod.formatWarnings, 'function', 'formatWarnings is a function');
    assert.equal(typeof mod.runStartupValidation, 'function', 'runStartupValidation is a function');
  });

  it('a known key with a valid value produces no warning', () => {
    const { validateEnv } = loadValidateModule();
    const warnings = validateEnv({ ENABLE_DRAFT_PR: '1' }, testSchema());
    assert.deepEqual(warnings, [], 'no warnings for a valid known key');
  });

  it('an unknown prefixed key within edit distance 2 suggests the correct key (R3)', () => {
    const { validateEnv } = loadValidateModule();
    const warnings = validateEnv({ ENABEL_DRAFT_PR: '1' }, testSchema());
    const unknown = warnings.filter((w) => w.kind === 'unknown-key');
    assert.equal(unknown.length, 1, 'one unknown-key warning');
    assert.equal(unknown[0].key, 'ENABEL_DRAFT_PR', 'names the typo key');
    assert.equal(unknown[0].suggestion, 'ENABLE_DRAFT_PR', 'suggestion names the intended key');
  });

  it('an unknown prefixed key beyond edit distance 2 warns without a suggestion (R4)', () => {
    const { validateEnv } = loadValidateModule();
    const warnings = validateEnv({ WORK_TOTALLY_DIFFERENT_KEY: 'x' }, testSchema());
    const unknown = warnings.filter((w) => w.kind === 'unknown-key');
    assert.equal(unknown.length, 1, 'one unknown-key warning');
    assert.equal(unknown[0].key, 'WORK_TOTALLY_DIFFERENT_KEY', 'names the key');
    assert.ok(
      !('suggestion' in unknown[0]) || unknown[0].suggestion === undefined,
      'no suggestion field when nearest key is at distance > 2'
    );
  });

  it('breaks ties by first-by-index when a typo is equidistant from two known keys', () => {
    const { validateEnv } = loadValidateModule();
    // FOO and FOB are both at edit distance 1 from FOX. The nearest-candidate
    // selection must keep the FIRST known key by declaration order (FOO),
    // matching the prior stable tie-break of `nearest(key, knownKeys, 1)`.
    const schema = {
      FOO: { type: 'string' },
      FOB: { type: 'string' },
    };
    const warnings = validateEnv({ FOX: 'x' }, schema);
    const unknown = warnings.filter((w) => w.kind === 'unknown-key');
    assert.equal(unknown.length, 1, 'one unknown-key warning');
    assert.equal(unknown[0].key, 'FOX', 'names the typo key');
    assert.equal(unknown[0].suggestion, 'FOO', 'tie resolves to the first known key by index');
  });

  it('non-prefixed unknown keys are ignored by the unknown-key scan (R5)', () => {
    const { validateEnv } = loadValidateModule();
    const warnings = validateEnv({ SOME_RANDOM_PATH: '/tmp/x' }, testSchema());
    const unknown = warnings.filter(
      (w) => w.kind === 'unknown-key' && w.key === 'SOME_RANDOM_PATH'
    );
    assert.equal(unknown.length, 0, 'no unknown-key warning for non-prefixed key');
  });
});

describe('validateEnv — value-format validation', () => {
  it('a known flag01 key with an invalid value warns with the expected format (R6)', () => {
    const { validateEnv } = loadValidateModule();
    const warnings = validateEnv({ ENABLE_DRAFT_PR: 'yes' }, testSchema());
    const invalid = warnings.filter((w) => w.kind === 'invalid-value');
    assert.equal(invalid.length, 1, 'one invalid-value warning');
    assert.equal(invalid[0].key, 'ENABLE_DRAFT_PR', 'names the key');
    assert.equal(invalid[0].value, 'yes', 'names the offending value');
    assert.match(String(invalid[0].expected), /0 or 1/, 'expected format describes "0 or 1"');
  });

  it('validates enum, bool, and json-array types', () => {
    const { validateEnv } = loadValidateModule();

    const badEnum = validateEnv({ TICKET_PROVIDER: 'gitlab' }, testSchema());
    assert.ok(
      badEnum.some((w) => w.kind === 'invalid-value' && w.key === 'TICKET_PROVIDER'),
      'invalid enum value warns'
    );

    const badBool = validateEnv({ FOLLOW_UP_PR_POLL_REVIEWS: 'maybe' }, testSchema());
    assert.ok(
      badBool.some((w) => w.kind === 'invalid-value' && w.key === 'FOLLOW_UP_PR_POLL_REVIEWS'),
      'invalid bool value warns'
    );

    const badJson = validateEnv({ WEB_APPS: '{not json}' }, testSchema());
    assert.ok(
      badJson.some((w) => w.kind === 'invalid-value' && w.key === 'WEB_APPS'),
      'unparseable json-array warns'
    );
  });

  it('treats an empty-string value as unset (matches config.js || default) and does not warn', () => {
    const { validateEnv } = loadValidateModule();
    // config.js resolves every value via `process.env.KEY || default`, so an
    // empty string is falsy and uniformly replaced by the default — i.e. an
    // empty value is semantically "unset". The validator must not emit
    // spurious invalid-value warnings for these.
    const warnings = validateEnv(
      {
        FOLLOW_UP_PR_POLL_REVIEWS: '',
        WEB_APPS: '',
        ENABLE_DRAFT_PR: '',
      },
      testSchema()
    );
    const invalid = warnings.filter((w) => w.kind === 'invalid-value');
    assert.deepEqual(invalid, [], 'empty-string values produce no invalid-value warnings');
  });

  it('still flags a genuinely-invalid non-empty value (guards against over-skipping)', () => {
    const { validateEnv } = loadValidateModule();
    const warnings = validateEnv({ FOLLOW_UP_PR_POLL_REVIEWS: 'maybe' }, testSchema());
    assert.ok(
      warnings.some((w) => w.kind === 'invalid-value' && w.key === 'FOLLOW_UP_PR_POLL_REVIEWS'),
      'a non-empty invalid value is still flagged'
    );
  });

  it('enforces a declared pattern on a string-type key even when the type check passes', () => {
    const { validateEnv } = loadValidateModule();
    const schema = {
      SOMEKEY: { type: 'string', pattern: /^[a-zA-Z0-9_/-]+$/ },
    };

    const bad = validateEnv({ SOMEKEY: '../../evil' }, schema);
    const invalid = bad.filter((w) => w.kind === 'invalid-value' && w.key === 'SOMEKEY');
    assert.equal(invalid.length, 1, 'a pattern mismatch on a string key warns');
    assert.match(String(invalid[0].expected), /matching/, 'expected text mentions the pattern');

    const good = validateEnv({ SOMEKEY: 'feature/x' }, schema);
    assert.deepEqual(
      good.filter((w) => w.kind === 'invalid-value'),
      [],
      'a pattern-matching value produces no invalid-value warning'
    );
  });

  it('accepts valid values for every type with no warning', () => {
    const { validateEnv } = loadValidateModule();
    const warnings = validateEnv(
      {
        ENABLE_DRAFT_PR: '0',
        TICKET_PROVIDER: 'github',
        FOLLOW_UP_PR_POLL_REVIEWS: 'TRUE',
        WEB_APPS: '[{"name":"app"}]',
        BASE_BRANCH: 'main',
      },
      testSchema()
    );
    assert.deepEqual(warnings, [], 'all valid values produce no warnings');
  });
});

describe('validateEnv — one-entry extension (R10)', () => {
  it('a newly-added schema entry is picked up by both scans', () => {
    const { validateEnv } = loadValidateModule();
    // The ONLY edit: append one entry to the schema.
    const schema = testSchema();
    schema.ENABLE_NEWLY_ADDED = { type: 'flag01', description: 'New.' };

    const invalid = validateEnv({ ENABLE_NEWLY_ADDED: 'nope' }, schema);
    assert.ok(
      invalid.some((w) => w.kind === 'invalid-value' && w.key === 'ENABLE_NEWLY_ADDED'),
      'invalid value of the new key is caught by value-format scan'
    );

    const typo = validateEnv({ ENABLE_NEWLY_ADDE: '1' }, schema);
    const unknown = typo.filter((w) => w.kind === 'unknown-key');
    assert.equal(unknown.length, 1, 'near-typo of new key warns');
    assert.equal(
      unknown[0].suggestion,
      'ENABLE_NEWLY_ADDED',
      'near-typo suggests the newly-added key'
    );
  });
});

describe('formatWarnings (R7)', () => {
  it('returns an empty string for an empty warning list', () => {
    const { formatWarnings } = loadValidateModule();
    assert.equal(formatWarnings([]), '', 'empty list renders empty string');
  });

  it('renders multiple warnings into a single grouped block', () => {
    const { validateEnv, formatWarnings } = loadValidateModule();
    const warnings = validateEnv({ ENABEL_DRAFT_PR: '1', ENABLE_SYMLINK: 'yes' }, testSchema());
    const block = formatWarnings(warnings);
    assert.equal(typeof block, 'string', 'returns a string');
    assert.ok(block.length > 0, 'block is non-empty');
    assert.match(block, /ENABEL_DRAFT_PR/, 'block names the typo key');
    assert.match(block, /ENABLE_SYMLINK/, 'block names the malformed key');
  });

  it('renders a "did you mean" line for a prefixed near-miss typo', () => {
    const { validateEnv, formatWarnings } = loadValidateModule();
    const block = formatWarnings(validateEnv({ ENABEL_DRAFT_PR: '1' }, testSchema()));
    assert.match(
      block,
      /did you mean "ENABLE_DRAFT_PR"\?/,
      'a near-miss keeps the typo-suggestion message'
    );
  });

  it('renders an "another tool" note for a prefixed unknown key with no near-miss', () => {
    const { validateEnv, formatWarnings } = loadValidateModule();
    const block = formatWarnings(validateEnv({ ENABLE_TELEMETRY: '1' }, testSchema()));
    assert.match(
      block,
      /may belong to another tool/,
      'a prefixed key with no near-miss notes it may belong to another tool'
    );
    assert.doesNotMatch(
      block,
      /no close known key/,
      'the old "no close known key" phrasing is gone'
    );
  });
});

describe('runStartupValidation — non-blocking + once-per-invocation', () => {
  let originalWrite;
  let captured;
  let savedMarker;

  beforeEach(() => {
    originalWrite = process.stderr.write;
    captured = [];
    process.stderr.write = (chunk) => {
      captured.push(String(chunk));
      return true;
    };
    savedMarker = process.env.__WORK_CONFIG_VALIDATED;
    delete process.env.__WORK_CONFIG_VALIDATED;
  });

  afterEach(() => {
    process.stderr.write = originalWrite;
    if (savedMarker === undefined) {
      delete process.env.__WORK_CONFIG_VALIDATED;
    } else {
      process.env.__WORK_CONFIG_VALIDATED = savedMarker;
    }
  });

  it('is non-blocking: writes a block to stderr, never throws, never exits (R8)', () => {
    const { runStartupValidation } = freshValidateModule();
    const env = { ENABEL_DRAFT_PR: '1', ENABLE_SYMLINK: 'yes' };

    assert.doesNotThrow(() => {
      runStartupValidation(env, testSchema());
    }, 'runStartupValidation never throws to the caller');

    const out = captured.join('');
    assert.ok(out.length > 0, 'a warning block was written to stderr');
  });

  it('writes nothing when there are no warnings (R8)', () => {
    const { runStartupValidation } = freshValidateModule();
    runStartupValidation({ ENABLE_DRAFT_PR: '1' }, testSchema());
    assert.equal(captured.join(''), '', 'no stderr output for a clean env');
  });

  it('terminates the stderr block in exactly one trailing newline, not two', () => {
    const { runStartupValidation } = freshValidateModule();
    const env = { ENABEL_DRAFT_PR: '1', ENABLE_SYMLINK: 'yes' };

    runStartupValidation(env, testSchema());

    const out = captured.join('');
    assert.ok(out.length > 0, 'a warning block was written to stderr');
    assert.ok(out.endsWith('\n'), 'block ends with a single trailing newline');
    assert.ok(
      !out.endsWith('\n\n'),
      'block does not end with a double newline (no trailing blank line)'
    );
  });

  it('is guarded by a once-per-invocation flag: a second call is a no-op (R9)', () => {
    const { runStartupValidation } = freshValidateModule();
    const env = { ENABEL_DRAFT_PR: '1' };

    runStartupValidation(env, testSchema());
    const afterFirst = captured.join('');
    assert.ok(afterFirst.length > 0, 'first call writes a block');

    runStartupValidation(env, testSchema());
    const afterSecond = captured.join('');
    assert.equal(afterSecond, afterFirst, 'second call writes nothing more (once-guard honored)');
  });

  it('sets the cross-process marker so re-entrant loads do not re-run (R9)', () => {
    const { runStartupValidation } = freshValidateModule();
    runStartupValidation({ ENABEL_DRAFT_PR: '1' }, testSchema());
    assert.ok(process.env.__WORK_CONFIG_VALIDATED, 'cross-process marker is set after first run');

    // A re-entrant module load sees the marker and self-disables.
    captured.length = 0;
    const { runStartupValidation: reentrant } = freshValidateModule();
    reentrant({ ENABEL_DRAFT_PR: '1' }, testSchema());
    assert.equal(
      captured.join(''),
      '',
      'fresh module load honors the cross-process marker and does not re-run'
    );
  });

  it('fail-open: an internal error is swallowed and never reaches the caller (R8)', () => {
    const { runStartupValidation } = freshValidateModule();
    // A schema whose entry throws when inspected forces an internal error path.
    const hostileSchema = new Proxy(
      {},
      {
        get() {
          throw new Error('boom');
        },
        ownKeys() {
          throw new Error('boom');
        },
        getOwnPropertyDescriptor() {
          throw new Error('boom');
        },
      }
    );
    assert.doesNotThrow(() => {
      runStartupValidation({ ENABEL_DRAFT_PR: '1' }, hostileSchema);
    }, 'internal errors are caught and swallowed (fail-open)');
  });
});
