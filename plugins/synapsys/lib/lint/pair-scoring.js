'use strict';

/**
 * Trigger×trigger and trigger×body pair scoring + classification.
 *
 * Split out of `scripts/synapsys-lint.js` (GH-534) for file-size cap. Each
 * exported function takes `applyIntentionalDowngrades` as an argument so this
 * module stays pure / stateless.
 */

const {
  extractAlternationTokens,
  jaccard,
  triggerMatchesBody,
} = require('../shared/trigger-tokens');

const { getDomains, setsIntersect, forEachPair } = require('./domain-utils');

const OVERLAP_REPORT_FLOOR = 0.25;
const BODY_DENSITY_FLOOR = 2;

/**
 * scorePair — raw Jaccard overlap of two alternation-token sets.
 */
function scorePair(a, b) {
  const aTokens = new Set(extractAlternationTokens(a.triggerPrompt || ''));
  const bTokens = new Set(extractAlternationTokens(b.triggerPrompt || ''));
  const score = jaccard(aTokens, bTokens);
  return { score, aTokens, bTokens };
}

/**
 * classifyPair — Task 4 trigger×trigger severity + downgrade rules.
 */
function classifyPair(a, b, score, overlapThreshold, applyIntentionalDowngrades) {
  if (score < OVERLAP_REPORT_FLOOR) return { severity: null, intentional: {} };
  const aDomains = getDomains(a);
  const bDomains = getDomains(b);
  const isCrossDomain =
    aDomains.size > 0 && bDomains.size > 0 && !setsIntersect(aDomains, bDomains);
  let severity;
  if (score >= overlapThreshold) {
    severity = isCrossDomain ? 'high' : 'medium';
  } else {
    severity = isCrossDomain ? 'medium' : 'low';
  }
  return applyIntentionalDowngrades(a, b, severity);
}

/**
 * Build the trigger-overlap pair array over all `(i<j)` memory pairs.
 */
function computeTriggerPairs(
  memories,
  overlapThreshold,
  onlyInvolving,
  applyIntentionalDowngrades
) {
  const pairs = [];
  forEachPair(memories, onlyInvolving, (a, b) => {
    const { score } = scorePair(a, b);
    const { severity, intentional } = classifyPair(
      a,
      b,
      score,
      overlapThreshold,
      applyIntentionalDowngrades
    );
    if (severity === null) return;
    pairs.push({
      rule: 'trigger-overlap',
      a: a.name,
      b: b.name,
      severity,
      score,
      suggestion: null,
      intentional,
    });
  });
  return pairs;
}

/**
 * classifyBodyPair — severity for trigger×body match-density (Task 5).
 */
function classifyBodyPair(a, b, matchCount, bodyDensityHigh, applyIntentionalDowngrades) {
  if (matchCount < BODY_DENSITY_FLOOR) return { severity: null, intentional: {} };
  const severity = matchCount >= bodyDensityHigh ? 'high' : 'medium';
  return applyIntentionalDowngrades(a, b, severity);
}

/**
 * Build the trigger-body-overlap pair array (both directions).
 */
function computeBodyPairs(memories, bodyDensityHigh, onlyInvolving, applyIntentionalDowngrades) {
  const pairs = [];
  for (let i = 0; i < memories.length; i++) {
    for (let j = 0; j < memories.length; j++) {
      if (i === j) continue;
      const a = memories[i];
      const b = memories[j];
      if (onlyInvolving && a.name !== onlyInvolving && b.name !== onlyInvolving) continue;
      const { matchCount, matchedTokens } = triggerMatchesBody(b.triggerPrompt || '', a.body || '');
      const { severity, intentional } = classifyBodyPair(
        a,
        b,
        matchCount,
        bodyDensityHigh,
        applyIntentionalDowngrades
      );
      if (severity === null) continue;
      pairs.push({
        rule: 'trigger-body-overlap',
        a: a.name,
        b: b.name,
        severity,
        score: matchCount,
        matchedTokens,
        intentional,
      });
    }
  }
  return pairs;
}

module.exports = {
  scorePair,
  classifyPair,
  classifyBodyPair,
  computeTriggerPairs,
  computeBodyPairs,
};
