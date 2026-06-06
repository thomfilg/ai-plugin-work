// Infra-classifier: identifies CI failures that look like infrastructure
// flakes. Fires `infra-suspected` only when ≥2 signals fire per R7
// (INFRA_SUSPECTED_PAIRS). Collectors are pure; classifier shells out via
// injected ctx.exec. See [[never-rerun-ci]] — gate retries on evidence.

'use strict';

const { filterLogs } = require('./log-utils');

/** Pairs of signals whose joint firing triggers `infra-suspected`. */
const INFRA_SUSPECTED_PAIRS = [
  ['signal1', 'signal2'],
  ['signal3', 'signal4'],
  ['signal2', 'signal4'],
];

const NUMERIC_ID_RE = /^\d+$/;

// Strip matrix shard suffixes from a job name so siblings in the same matrix
// family collapse to a single stem (e.g. `e2e [shard-3]` -> `e2e`).
function stripShardSuffix(name) {
  if (typeof name !== 'string') return '';
  return name
    .replace(/\s*\[shard-\d+\]\s*$/i, '')
    .replace(/\s*\(\d+\/\d+\)\s*$/, '')
    .trim();
}

// Runtime (ms) of a job from its ISO timestamps; 0 if missing/unparseable.
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

// Bug 542-25: enriched `failed` is a COPY; reference equality `j !== failed`
// always returned true, leaking the failed shard into the median. Match by
// jobId (against databaseId/id) or by name.
function isSameJob(j, failed) {
  if (!j || !failed) return false;
  if (failed.jobId && allJobIdMatches(j, failed.jobId)) return true;
  return Boolean(failed.name) && j.name === failed.name;
}

function siblingMedianRuntime(family, failed) {
  const siblings = family.filter((j) => !isSameJob(j, failed));
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

function allJobIdMatches(j, jobId) {
  if (!j) return false;
  const s = String(jobId);
  return String(j.databaseId) === s || String(j.id) === s;
}

// Bug 542-15 / 542-23: enrich _ciFailedJobs with startedAt/completedAt from
// _ciAllJobs (which uses databaseId/id, not jobId). Name fallback.
function enrichFailedFromAll(failed, safeAll) {
  if (!failed) return failed;
  if (failed.startedAt && failed.completedAt) return failed;
  const byId = failed.jobId ? safeAll.find((j) => allJobIdMatches(j, failed.jobId)) : null;
  const matched = byId || safeAll.find((j) => j && j.name === failed.name);
  if (!matched) return failed;
  return Object.assign({}, failed, {
    startedAt: matched.startedAt || failed.startedAt,
    completedAt: matched.completedAt || failed.completedAt,
  });
}

function signal1_shardAsymmetry(failedJobs, allJobs) {
  const safeFailed = Array.isArray(failedJobs) ? failedJobs : [];
  const safeAll = Array.isArray(allJobs) ? allJobs : [];
  const families = groupJobsByFamily(safeAll);

  let lastSkipReason = null;
  for (const failedRaw of safeFailed) {
    const failed = enrichFailedFromAll(failedRaw, safeAll);
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

// Aggregate the four signal collectors. classify() (below) decides between
// `infra-suspected` and `code-failure` using INFRA_SUSPECTED_PAIRS.
function collectSignals(s, c, failedJobs) {
  const signal4Raw = signal4_setupArtifacts(c.rawLogs || '');
  // R16: when signal4 fires, attach a conservative upper bound on
  // setup-evidence-bearing jobs (we lack per-job logs). jobCount =
  // min(failedJobs, distinct patterns) — fail-open cross-check.
  const patternHits = ((signal4Raw.evidence && signal4Raw.evidence.patterns) || []).length;
  const jobCount = signal4Raw.fired ? Math.min(failedJobs.length, Math.max(patternHits, 1)) : 0;
  const signal4 = { fired: signal4Raw.fired, evidence: { ...signal4Raw.evidence, jobCount } };
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
  // Bug 542-19: signal2 must consider every failed job, not just the first.
  // If ANY failed job has real assertion output, refuse to fire — otherwise
  // we'd misclassify a real code failure as an infra flake whenever the FIRST
  // failed job happens to have an empty log.
  const failedJobs = Array.isArray(s._ciFailedJobs) ? s._ciFailedJobs : [];
  const fallbackRunId = c.runId || s.runId;
  const fallbackJobId = c.jobId;
  const candidates =
    failedJobs.length > 0
      ? failedJobs.map((j) => ({
          runId: j.runId || fallbackRunId,
          jobId: j.jobId || fallbackJobId,
        }))
      : [{ runId: fallbackRunId, jobId: fallbackJobId }];
  const evaluable = candidates.filter((j) => j.runId && j.jobId);
  if (evaluable.length === 0) {
    return { fired: false, evidence: { reason: 'no runId/jobId' } };
  }
  // Bug 542-27: catch signal2 throws (bad ids) so they don't propagate up
  // through uncaughtException and block the whole follow-up loop.
  let lastFired = null;
  for (const j of evaluable) {
    let result;
    try {
      result = signal2_emptyFailedLog(j.runId, j.jobId, c.exec);
    } catch (err) {
      return {
        fired: false,
        evidence: { runId: j.runId, jobId: j.jobId, reason: `invalid id: ${err.message}` },
      };
    }
    // If ANY failed job has real error markers (fired=false), signal2 must
    // NOT fire — there's a real code failure somewhere.
    if (!result.fired) {
      return {
        fired: false,
        evidence: { ...result.evidence, reason: 'real assertion output present' },
      };
    }
    lastFired = result;
  }
  return lastFired;
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
