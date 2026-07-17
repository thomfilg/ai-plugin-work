'use strict';

/**
 * replay-corpus — historical implement-phase incidents encoded as fixtures
 * (GH-751, outcome-verification Phase 0; plan §6 Phase 0).
 *
 * Each fixture captures one incident at the OBSERVATION layer: what a
 * task-boundary verifier would have seen (diff summary, deliverables,
 * base/head runner outcomes, coverage), plus the CORRECT verdict under the
 * outcome model. The corpus is the verifier's own regression suite: every
 * historical false-GREEN must map to CONTRADICTED and every historical wedge
 * must map to VERIFIED/UNVERIFIED (never a dead-end block). A rule change
 * that regresses a fixture in either direction does not ship (GH-755).
 *
 * Fixture shape (validated by validateFixture):
 *   {
 *     name,                 // kebab-case, must equal the filename stem
 *     incident,             // "GH-<n>" source issue
 *     incidentClass,        // 1..7 per plan §2 table
 *     taskKind,             // planner kind vocabulary (outcome-verdicts.js)
 *     description,          // what mechanically happened
 *     observations: { diff, deliverables, baseRun, headRun, coverage },
 *     expected: { verdict, violatedInvariants?, flags?, exit?, rationale },
 *     provenance: { issue, notes? }
 *   }
 */

const fs = require('node:fs');
const path = require('node:path');
const {
  VERDICTS,
  VERDICT_VALUES,
  EXIT_VALUES,
  INVARIANT_VALUES,
  FLAG_KIND_VALUES,
  TASK_KINDS,
} = require('../outcome-verdicts');

const FIXTURES_DIR = path.join(__dirname, 'fixtures');

/** Legal `outcome` values for base/head runner observations. */
const RUN_OUTCOMES = Object.freeze([
  'pass',
  'fail',
  'load-failure',
  'hang',
  'error',
  'skipped',
  'not-run',
]);

/** How the head run's test count was obtained. */
const REPORTER_KINDS = Object.freeze(['structured', 'exit-code-only', 'none']);

const INCIDENT_RE = /^GH-\d+$/;
const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function isStringArray(value) {
  return Array.isArray(value) && value.every((v) => typeof v === 'string');
}

function pushIf(errors, condition, message) {
  if (condition) errors.push(message);
}

function requireString(errors, obj, key, label) {
  pushIf(
    errors,
    !obj || typeof obj[key] !== 'string' || obj[key].length === 0,
    `${label}.${key} must be a non-empty string`
  );
}

function requireStringArray(errors, obj, key, label) {
  pushIf(errors, !obj || !isStringArray(obj[key]), `${label}.${key} must be a string array`);
}

function requireEnum(errors, value, allowed, label) {
  pushIf(errors, !allowed.includes(value), `${label} must be one of: ${allowed.join(', ')}`);
}

function validateDiff(errors, diff) {
  if (!diff || typeof diff !== 'object') {
    errors.push('observations.diff must be an object');
    return;
  }
  pushIf(errors, typeof diff.empty !== 'boolean', 'observations.diff.empty must be a boolean');
  requireStringArray(errors, diff, 'filesChanged', 'observations.diff');
  requireStringArray(errors, diff, 'scopeGlobs', 'observations.diff');
  requireStringArray(errors, diff, 'outOfScope', 'observations.diff');
  pushIf(
    errors,
    diff.scopeUnresolved !== undefined && typeof diff.scopeUnresolved !== 'boolean',
    'observations.diff.scopeUnresolved must be a boolean when present'
  );
}

function validateDeliverables(errors, deliverables) {
  if (!deliverables || typeof deliverables !== 'object') {
    errors.push('observations.deliverables must be an object');
    return;
  }
  requireStringArray(errors, deliverables, 'promised', 'observations.deliverables');
  requireStringArray(errors, deliverables, 'missing', 'observations.deliverables');
}

function validateRun(errors, run, label) {
  if (!run || typeof run !== 'object') {
    errors.push(`${label} must be an object`);
    return;
  }
  pushIf(errors, typeof run.attempted !== 'boolean', `${label}.attempted must be a boolean`);
  pushIf(errors, typeof run.supported !== 'boolean', `${label}.supported must be a boolean`);
  requireEnum(errors, run.outcome, RUN_OUTCOMES, `${label}.outcome`);
  pushIf(
    errors,
    run.testsRan !== undefined && !Number.isInteger(run.testsRan),
    `${label}.testsRan must be an integer when present`
  );
  pushIf(
    errors,
    run.failures !== undefined && !Number.isInteger(run.failures),
    `${label}.failures must be an integer when present`
  );
  pushIf(
    errors,
    run.exitCode !== undefined && run.exitCode !== null && !Number.isInteger(run.exitCode),
    `${label}.exitCode must be an integer or null when present`
  );
}

function validateHeadRun(errors, run) {
  validateRun(errors, run, 'observations.headRun');
  if (run && typeof run === 'object') {
    requireEnum(errors, run.reporterKind, REPORTER_KINDS, 'observations.headRun.reporterKind');
  }
}

function validateCoverage(errors, coverage) {
  if (!coverage || typeof coverage !== 'object') {
    errors.push('observations.coverage must be an object');
    return;
  }
  pushIf(
    errors,
    typeof coverage.supported !== 'boolean',
    'observations.coverage.supported must be a boolean'
  );
  const pct = coverage.changedLineCoveragePct;
  pushIf(
    errors,
    !(pct === null || (typeof pct === 'number' && pct >= 0 && pct <= 100)),
    'observations.coverage.changedLineCoveragePct must be null or a number in [0,100]'
  );
}

function validateExpected(errors, expected) {
  if (!expected || typeof expected !== 'object') {
    errors.push('expected must be an object');
    return;
  }
  requireEnum(errors, expected.verdict, VERDICT_VALUES, 'expected.verdict');
  requireString(errors, expected, 'rationale', 'expected');

  const invariants = expected.violatedInvariants || [];
  const flags = expected.flags || [];
  pushIf(
    errors,
    !isStringArray(invariants) || invariants.some((i) => !INVARIANT_VALUES.includes(i)),
    `expected.violatedInvariants entries must be among: ${INVARIANT_VALUES.join(', ')}`
  );
  pushIf(
    errors,
    !isStringArray(flags) || flags.some((f) => !FLAG_KIND_VALUES.includes(f)),
    `expected.flags entries must be among: ${FLAG_KIND_VALUES.join(', ')}`
  );

  if (expected.verdict === VERDICTS.contradicted) {
    requireEnum(errors, expected.exit, EXIT_VALUES, 'expected.exit (required for CONTRADICTED)');
    pushIf(
      errors,
      invariants.length === 0,
      'expected.violatedInvariants must be non-empty for CONTRADICTED'
    );
  } else {
    pushIf(errors, expected.exit !== undefined, 'expected.exit is only legal for CONTRADICTED');
  }
  if (expected.verdict === VERDICTS.unverified) {
    pushIf(errors, flags.length === 0, 'expected.flags must be non-empty for UNVERIFIED');
  }
}

/** Validate the top-level identity fields (name/incident/class/kind/description). */
function validateIdentity(errors, fixture) {
  requireString(errors, fixture, 'name', 'fixture');
  pushIf(
    errors,
    typeof fixture.name === 'string' && !NAME_RE.test(fixture.name),
    'fixture.name must be kebab-case'
  );
  pushIf(
    errors,
    typeof fixture.incident !== 'string' || !INCIDENT_RE.test(fixture.incident),
    'fixture.incident must match GH-<number>'
  );
  pushIf(
    errors,
    !Number.isInteger(fixture.incidentClass) ||
      fixture.incidentClass < 1 ||
      fixture.incidentClass > 7,
    'fixture.incidentClass must be an integer 1..7'
  );
  requireEnum(errors, fixture.taskKind, TASK_KINDS, 'fixture.taskKind');
  requireString(errors, fixture, 'description', 'fixture');
}

/** Legal `mode` values for the optional attribution block. */
const ATTRIBUTION_MODES = Object.freeze(['trailer', 'none']);

/**
 * Validate the OPTIONAL observations.attribution block (GH-769). Absence is
 * valid; when present it must be a well-formed object.
 */
function validateAttribution(errors, attribution) {
  if (attribution === undefined) return;
  if (!attribution || typeof attribution !== 'object' || Array.isArray(attribution)) {
    errors.push('observations.attribution must be an object when present');
    return;
  }
  pushIf(
    errors,
    typeof attribution.supported !== 'boolean',
    'observations.attribution.supported must be a boolean'
  );
  requireEnum(errors, attribution.mode, ATTRIBUTION_MODES, 'observations.attribution.mode');
  pushIf(
    errors,
    !(attribution.taskId === null || Number.isInteger(attribution.taskId)),
    'observations.attribution.taskId must be an integer or null'
  );
  requireStringArray(errors, attribution, 'foreignTasks', 'observations.attribution');
  pushIf(
    errors,
    !Number.isInteger(attribution.unattributedCount) || attribution.unattributedCount < 0,
    'observations.attribution.unattributedCount must be an integer >= 0'
  );
}

/** Validate the observations block (diff/deliverables/runs/coverage/attribution). */
function validateObservations(errors, obs) {
  if (!obs || typeof obs !== 'object') {
    errors.push('observations must be an object');
    return;
  }
  validateDiff(errors, obs.diff);
  validateDeliverables(errors, obs.deliverables);
  validateRun(errors, obs.baseRun, 'observations.baseRun');
  validateHeadRun(errors, obs.headRun);
  validateCoverage(errors, obs.coverage);
  validateAttribution(errors, obs.attribution);
}

/**
 * Validate one fixture object. Returns an array of human-readable problems
 * (empty = valid).
 */
function validateFixture(fixture) {
  const errors = [];
  if (!fixture || typeof fixture !== 'object' || Array.isArray(fixture)) {
    return ['fixture must be a JSON object'];
  }
  validateIdentity(errors, fixture);
  validateObservations(errors, fixture.observations);
  validateExpected(errors, fixture.expected);

  const prov = fixture.provenance;
  pushIf(
    errors,
    !prov || typeof prov !== 'object' || typeof prov.issue !== 'string' || prov.issue.length === 0,
    'provenance.issue must be a non-empty string'
  );
  return errors;
}

/** Parse + validate one fixture file into the accumulators. */
function loadFixtureFile(dir, file, fixtures, errors) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
  } catch (err) {
    errors.push(`${file}: unparseable JSON (${err.message})`);
    return;
  }
  for (const problem of validateFixture(parsed)) {
    errors.push(`${file}: ${problem}`);
  }
  const stem = file.replace(/\.json$/, '');
  const parsedName = parsed && typeof parsed === 'object' ? parsed.name : null;
  if (parsedName !== stem) {
    errors.push(`${file}: fixture.name "${parsedName}" must equal filename stem`);
  }
  fixtures.push(parsed);
}

/**
 * Load and validate every fixture in the corpus.
 * @returns {{ fixtures: object[], errors: string[] }} fixtures that parsed
 *   (valid or not) plus `<file>: <problem>` strings; callers decide severity.
 */
function loadCorpus(options = {}) {
  const dir = options.fixturesDir || FIXTURES_DIR;
  const fixtures = [];
  const errors = [];

  let files;
  try {
    files = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .sort();
  } catch (err) {
    return { fixtures, errors: [`cannot read fixtures dir ${dir}: ${err.message}`] };
  }

  for (const file of files) {
    loadFixtureFile(dir, file, fixtures, errors);
  }

  const names = fixtures.map((f) => f && f.name);
  const dupes = names.filter((n, i) => n && names.indexOf(n) !== i);
  for (const dupe of [...new Set(dupes)]) {
    errors.push(`duplicate fixture name: ${dupe}`);
  }

  return { fixtures, errors };
}

module.exports = {
  FIXTURES_DIR,
  RUN_OUTCOMES,
  REPORTER_KINDS,
  ATTRIBUTION_MODES,
  validateFixture,
  loadCorpus,
};
