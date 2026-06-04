/**
 * Infra-classifier: identifies CI failures that look like infrastructure
 * flakes rather than genuine code/test failures. Used by the `infra-retry`
 * step to decide whether a 60s-wait + `gh run rerun --failed` is warranted.
 *
 * Per the spec, classification fires `infra-suspected` only when ≥2 signals
 * fire per the rule: (s1 && s2) || (s3 && s4) || (s2 && s4). This ≥2-signal
 * floor (R7) is documented at the call site by iterating
 * `INFRA_SUSPECTED_PAIRS` rather than inlining the boolean.
 *
 * Each collector is pure: it accepts pre-fetched payloads (or an injectable
 * `exec` for Signal 2) so unit tests can drive every branch without spawning
 * `gh`. The classifier itself never shells out — the orchestrator pre-fetches
 * payloads and passes them through `ctx`.
 *
 * See also: synapsys memory [[never-rerun-ci]] — local evidence first, no
 * blind `gh run rerun`. This module's whole purpose is to GATE retries on
 * evidence (the 4 signals) rather than retry blindly.
 */

'use strict';

const { filterLogs } = require('./log-utils');

/** Pairs of signals whose joint firing triggers `infra-suspected`. */
const INFRA_SUSPECTED_PAIRS = [
  ['signal1', 'signal2'],
  ['signal3', 'signal4'],
  ['signal2', 'signal4'],
];

const NUMERIC_ID_RE = /^\d+$/;

/**
 * Strip matrix shard suffixes from a job name so siblings in the same
 * matrix family collapse to a single stem (e.g. `e2e [shard-3]` -> `e2e`).
 *
 * @param {string} name
 * @returns {string}
 */
function stripShardSuffix(name) {
  if (typeof name !== 'string') return '';
  return name
    .replace(/\s*\[shard-\d+\]\s*$/i, '')
    .replace(/\s*\(\d+\/\d+\)\s*$/, '')
    .trim();
}

/**
 * Compute the runtime (in milliseconds) of a job from its ISO timestamps.
 * Returns 0 if either timestamp is missing or unparseable.
 *
 * @param {{ startedAt?: string, completedAt?: string }} job
 * @returns {number}
 */
function jobRuntimeMs(job) {
  if (!job || !job.startedAt || !job.completedAt) return 0;
  const s = Date.parse(job.startedAt);
  const e = Date.parse(job.completedAt);
  if (Number.isNaN(s) || Number.isNaN(e)) return 0;
  return Math.max(0, e - s);
}

/**
 * Signal 1 — shard asymmetry. Fires when a matrix family has ≥3 shards and
 * a failing shard's runtime is >=3x the median of its sibling shards.
 *
 * @param {Array<object>} failedJobs - Jobs with conclusion === 'failure'.
 * @param {Array<object>} allJobs - All jobs from the run.
 * @returns {{ fired: boolean, evidence: object }}
 */
function groupJobsByFamily(safeAll) {
  const families = new Map();
  for (const job of safeAll) {
    const stem = stripShardSuffix(job?.name || '');
    if (!stem) continue;
    if (!families.has(stem)) families.set(stem, []);
    families.get(stem).push(job);
  }
  return families;
}

function siblingMedianRuntime(family, failed) {
  const siblings = family.filter((j) => j !== failed);
  const siblingRuntimes = siblings
    .map(jobRuntimeMs)
    .filter((ms) => ms > 0)
    .sort((a, b) => a - b);
  if (siblingRuntimes.length === 0) return 0;
  const mid = Math.floor(siblingRuntimes.length / 2);
  return siblingRuntimes.length % 2 === 0
    ? (siblingRuntimes[mid - 1] + siblingRuntimes[mid]) / 2
    : siblingRuntimes[mid];
}

/**
 * Evaluate one failed job against its family. Returns:
 *  - { fire: true, evidence } when asymmetry detected
 *  - { skipReason } when family is too small to evaluate
 *  - {} otherwise (keep iterating)
 */
function evaluateFamilyAsymmetry(failed, families) {
  const stem = stripShardSuffix(failed?.name || '');
  if (!stem) return {};
  const family = families.get(stem) || [];
  if (family.length < 3) {
    return {
      skipReason: {
        reason: 'matrix family size <3 — N<3 shards cannot establish asymmetry',
        family: stem,
        shardCount: family.length,
      },
    };
  }
  const medianMs = siblingMedianRuntime(family, failed);
  if (medianMs <= 0) return {};
  const failedMs = jobRuntimeMs(failed);
  if (failedMs >= medianMs * 3) {
    return {
      fire: true,
      evidence: {
        family: stem,
        failedJob: failed.name,
        failedRuntimeMs: failedMs,
        siblingMedianMs: medianMs,
        ratio: failedMs / medianMs,
      },
    };
  }
  return {};
}

function signal1_shardAsymmetry(failedJobs, allJobs) {
  const safeFailed = Array.isArray(failedJobs) ? failedJobs : [];
  const safeAll = Array.isArray(allJobs) ? allJobs : [];
  const families = groupJobsByFamily(safeAll);

  let lastSkipReason = null;
  for (const failed of safeFailed) {
    const r = evaluateFamilyAsymmetry(failed, families);
    if (r.fire) return { fired: true, evidence: r.evidence };
    if (r.skipReason) lastSkipReason = r.skipReason;
  }
  if (lastSkipReason) return { fired: false, evidence: lastSkipReason };
  return { fired: false, evidence: { reason: 'no shard with >=3x median runtime' } };
}

/**
 * Signal 2 — empty failed log. Fires when `gh run view --log-failed` returns
 * empty stdout despite the job conclusion being `failure`. Validates both
 * IDs against `/^\d+$/` BEFORE invoking `exec` (R17, security: no shell
 * injection via IDs).
 *
 * @param {string} runId
 * @param {string} jobId
 * @param {(cmd: string) => { stdout: string, stderr?: string, status?: number }} exec
 * @returns {{ fired: boolean, evidence: object }}
 */
function signal2_emptyFailedLog(runId, jobId, exec) {
  if (!NUMERIC_ID_RE.test(String(runId || ''))) {
    throw new TypeError(`signal2_emptyFailedLog: runId must match /^\\d+$/, got: ${runId}`);
  }
  if (!NUMERIC_ID_RE.test(String(jobId || ''))) {
    throw new TypeError(`signal2_emptyFailedLog: jobId must match /^\\d+$/, got: ${jobId}`);
  }
  if (typeof exec !== 'function') {
    throw new TypeError('signal2_emptyFailedLog: exec must be a function');
  }
  const result = exec(`gh run view ${runId} --job ${jobId} --log-failed`);
  return evaluateSignal2Result(result || {}, runId, jobId);
}

const SIGNAL2_MARKER_RE = /error|fail|assert|expect|✗|✕/i;

function evaluateSignal2Result(result, runId, jobId) {
  const stdout = result.stdout || '';
  const stderr = result.stderr || '';
  const stripped = filterLogs(stdout).trim();
  const hasErrorMarker = SIGNAL2_MARKER_RE.test(stdout) || SIGNAL2_MARKER_RE.test(stderr);
  if (!hasErrorMarker && stripped.length === 0) {
    return {
      fired: true,
      evidence: { runId, jobId, rawLength: stdout.length, reason: 'empty failed log' },
    };
  }
  return {
    fired: false,
    evidence: { runId, jobId, rawLength: stdout.length, stderrLength: stderr.length },
  };
}

/**
 * Signal 3 — unrelated failures. Fires when none of the failing test paths
 * share a path prefix with any file in the PR diff (the failures are not
 * in code the PR touched).
 *
 * @param {string[]} failedTests - Paths to failing test files.
 * @param {string[]} prDiffFiles - Files changed by the PR.
 * @returns {{ fired: boolean, evidence: object }}
 */
function stemsOverlap(testStem, ds) {
  return (
    testStem === ds ||
    testStem.startsWith(ds + '/') ||
    ds.startsWith(testStem + '/') ||
    testStem.includes(ds) ||
    ds.includes(testStem)
  );
}

function findOverlappingDiffStem(testStem, diffStems) {
  for (const ds of diffStems) {
    if (stemsOverlap(testStem, ds)) return ds;
  }
  return null;
}

function signal3_unrelatedFailures(failedTests, prDiffFiles) {
  const tests = Array.isArray(failedTests) ? failedTests : [];
  const diff = Array.isArray(prDiffFiles) ? prDiffFiles : [];
  if (tests.length === 0) {
    return { fired: false, evidence: { reason: 'no failing tests provided' } };
  }
  // Bug 542-8: an empty diff (fails-open from loadPrDiffFiles) cannot
  // distinguish "unrelated failures" from "the PR touches no files we know
  // about". Refuse to fire signal3 in that case rather than misclassifying
  // real regressions as infra flakes that get auto-retried.
  if (diff.length === 0) {
    return { fired: false, evidence: { reason: 'PR diff unavailable; signal3 inconclusive' } };
  }
  const diffStems = diff.map((f) => f.replace(/\.[a-z]+$/i, ''));
  const overlapping = [];
  for (const t of tests) {
    const testStem = t.replace(/\.(test|spec)\.[jt]sx?$/i, '').replace(/\.[a-z]+$/i, '');
    const matched = findOverlappingDiffStem(testStem, diffStems);
    if (matched !== null) {
      overlapping.push({ test: t, diffFile: matched });
    }
  }
  if (overlapping.length === 0) {
    return {
      fired: true,
      evidence: {
        failedTestCount: tests.length,
        prDiffCount: diff.length,
        reason: 'no overlap between failing tests and PR diff paths',
      },
    };
  }
  return {
    fired: false,
    evidence: { overlapping, reason: 'failing tests overlap with PR diff' },
  };
}

/**
 * Signal 4 — setup / artifact failures. Fires when the raw logs contain
 * known setup-artifact failure patterns (cache miss + fallback install
 * failed, download-artifact 404, etc.).
 *
 * @param {string} rawLogs
 * @returns {{ fired: boolean, evidence: object }}
 */
function signal4_setupArtifacts(rawLogs) {
  const text = typeof rawLogs === 'string' ? rawLogs : '';
  const hits = [];
  if (/cache:\s*MISS/i.test(text)) hits.push('cache-miss');
  if (/fallback install FAILED/i.test(text)) hits.push('fallback-install-failed');
  if (/download-artifact.*(404|not found)/i.test(text)) hits.push('artifact-404');
  if (/setup-node.*EAI_AGAIN|ETIMEDOUT|ECONNRESET/i.test(text)) hits.push('setup-node-network');
  if (/actions\/cache.*Failed to restore/i.test(text)) hits.push('cache-restore-failed');

  // Require ≥2 hits OR the canonical pair (cache-miss + fallback-install-failed)
  // to avoid firing on isolated transient mentions.
  const hasCanonicalPair = hits.includes('cache-miss') && hits.includes('fallback-install-failed');
  if (hasCanonicalPair || hits.length >= 2) {
    return { fired: true, evidence: { patterns: hits } };
  }
  return { fired: false, evidence: { patterns: hits } };
}

/**
 * Aggregate the four signal collectors and decide between `infra-suspected`
 * and `code-failure`. The classifier itself never shells out — collectors
 * receive payloads / `exec` from `ctx`.
 *
 * @param {object} state - Workflow state. Reads `_ciFailedJobs`, `failedTests`,
 *   `runId`.
 * @param {object} ctx - Pre-fetched context: `allJobs`, `prDiffFiles`,
 *   `rawLogs`, `exec`, `jobId`.
 * @returns {{ classification: 'infra-suspected'|'code-failure', signals: string[], evidence: object }}
 */
function collectSignals(s, c, failedJobs) {
  const signal4Raw = signal4_setupArtifacts(c.rawLogs || '');
  // Propagate jobCount (R16): when Signal 4 fires we attach the number of
  // failing jobs so the step can decide whether to cross-check githubstatus.
  // We approximate "jobs with setup evidence" by the failing-jobs count —
  // signal4 fires off raw aggregated logs, not per-job, so this is the best
  // available proxy without re-fetching per-job logs.
  const signal4 = {
    fired: signal4Raw.fired,
    evidence: { ...signal4Raw.evidence, jobCount: failedJobs.length },
  };
  return {
    signal1: signal1_shardAsymmetry(failedJobs, c.allJobs || []),
    signal2: evaluateSignal2(s, c),
    signal3: signal3_unrelatedFailures(s.failedTests || [], c.prDiffFiles || []),
    signal4,
  };
}

// Bug C (GH-508): prefer ctx.runId (sourced from _ciFailedJobs[0].runId in
// production). Fall back to state.runId for tests/callers that still set it
// directly. Skip signal2 cleanly when ids are missing rather than throwing —
// the ≥2-signal floor (R7) means missing signal2 alone is fine.
function evaluateSignal2(s, c) {
  if (typeof c.exec !== 'function') {
    return { fired: false, evidence: { reason: 'no exec provided' } };
  }
  const runId = c.runId || s.runId || null;
  if (!runId || !c.jobId) {
    return { fired: false, evidence: { reason: 'no runId/jobId' } };
  }
  return signal2_emptyFailedLog(runId, c.jobId, c.exec);
}

function isInfraSuspected(firedSignals) {
  // ≥2-signal floor (R7): iterate the documented pair list rather than
  // inlining the boolean — keeps the spec rule reviewable at the call site.
  return INFRA_SUSPECTED_PAIRS.some(
    ([a, b]) => firedSignals.includes(a) && firedSignals.includes(b)
  );
}

function classify(state, ctx) {
  const s = state || {};
  const c = ctx || {};
  const failedJobs = Array.isArray(s._ciFailedJobs) ? s._ciFailedJobs : [];
  const results = collectSignals(s, c, failedJobs);
  const firedSignals = Object.entries(results)
    .filter(([, r]) => r.fired)
    .map(([name]) => name);
  const infraSuspected = isInfraSuspected(firedSignals);
  return {
    classification: infraSuspected ? 'infra-suspected' : 'code-failure',
    signals: firedSignals,
    evidence: {
      signal1: results.signal1.evidence,
      signal2: results.signal2.evidence,
      signal3: results.signal3.evidence,
      signal4: results.signal4.evidence,
    },
  };
}

module.exports = {
  classify,
  __test__: {
    signal1_shardAsymmetry,
    signal2_emptyFailedLog,
    signal3_unrelatedFailures,
    signal4_setupArtifacts,
    stripShardSuffix,
    INFRA_SUSPECTED_PAIRS,
  },
};
