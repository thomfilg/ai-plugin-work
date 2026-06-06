# createDetectorRunner

Declarative builder for the maestro detector-runner shape. Wraps a
`{ detect(ctx) → hit }` detector module in the event-loop's
"guard → detect → dispatch hit/miss → maybe-short-circuit" wrapper.

Models the 6 `run<X>Detector` functions currently hand-written in
`plugins/maestro/scripts/maestro-conduct.js` (`runSpinnerDetector`,
`runSilenceDetector`, `runPhaseStallDetector`, `runCommitStallDetector`,
`runPrCommentsDetector`, `runPrStatusDetector`).

## Decision matrix

| # | Condition | Action |
|---|---|---|
| 1 | `requireRestartEligible: true` and `!isEligible` | return false (skip detect) |
| 2 | `detect(ctx).hit === false` | `onMiss?(ctx, hit)`; return false |
| 3 | `requireRestartEligible: 'after-hit'` and `!isEligible` | `onIneligibleHit?(ctx, hit)`; return false |
| 4 | otherwise | `onHit(ctx, hit)`; short-circuit per `shortCircuit` flag |

The runner returns `boolean` — true means "halt the remaining detectors
for this tick" (the caller's pipeline loop reads this). When
`shortCircuit` is false the runner always returns false regardless of
what `onHit` returns.

## Mapping the 6 maestro detectors to the factory

```js
const RUNNERS = {
  spinner: createDetectorRunner({
    name: 'spinner',
    detector: DETECTORS.spinner,
    shortCircuit: true,
    onHit: (ctx, hit) => {
      const prev = state.read(ctx.session, 'spinner');
      if (prev && state.minutesSince(prev.lastInterruptAt) < SPINNER_RE_INTERRUPT_MIN) return false;
      actions.interrupt(ctx.session, `spinner stuck ${hit.elapsedMin}m: ${hit.line}`);
      state.write(ctx.session, 'spinner', { lastInterruptAt: state.now() });
      return true;
    },
    onMiss: (ctx) => {
      if (state.read(ctx.session, 'spinner')) state.clear(ctx.session, 'spinner');
    },
  }),

  silence: createDetectorRunner({
    name: 'silence',
    detector: DETECTORS.silence,
    requireRestartEligible: 'after-hit',
    shortCircuit: true,
    onHit: (ctx, _hit) => {
      const ok = actions.autoRestart({ /* ... */ });
      if (!ok) return false;
      ['silence', 'spinner', 'question'].forEach((k) => state.clear(ctx.session, k));
      ['phase', 'pr-comments'].forEach((k) => state.clear(ctx.ticket, k));
      return true;
    },
    onIneligibleHit: (ctx) => {
      state.write(ctx.session, 'silence', { hash: null, tokens: null, lastActiveAt: state.now() });
    },
  }),

  phaseStall: createDetectorRunner({
    name: 'phaseStall',
    detector: DETECTORS.phaseStall,
    requireRestartEligible: true,
    onHit: (ctx, hit) => handlePhaseStall(ctx, hit),
  }),

  commitStall: createDetectorRunner({
    name: 'commitStall',
    detector: DETECTORS.commitStall,
    requireRestartEligible: true,
    onHit: (ctx, hit) =>
      alerts.log(`${ctx.session} commit-stall ${hit.mins}m in phase=${ctx.phase} (threshold=${hit.threshold}m)`),
  }),

  prComments: createDetectorRunner({
    name: 'prComments',
    detector: DETECTORS.prComments,
    requireRestartEligible: true,
    onHit: (ctx, hit) => handlePrComments(ctx, hit),
    onMiss: (ctx, hit) => {
      if (hit.reset) {
        alerts.resetCount(alerts.alertKey({ session: ctx.session, kind: 'pr-comments-stuck', phase: ctx.phase }));
      }
    },
  }),

  prStatus: createDetectorRunner({
    name: 'prStatus',
    detector: DETECTORS.prStatus,
    requireRestartEligible: true,
    onHit: (ctx, hit) => {
      if (hit.kind === 'pr-pending') {
        alerts.log(`${ctx.session} pr-pending PR #${hit.prNumber} ...`);
        return;
      }
      const workSession = `${ctx.ticket}-work`;
      actions.alert(prStatusPayload.buildPayload({ ctx, sHit: hit, workSession, tmux }));
      ciGate.maybeFreeOnPrReady({ ctx, sHit: hit, workSession, actions });
    },
  }),
};
```

The `tickSession` pipeline collapses to a 3-line loop:

```js
for (const key of detectorsToRun) {
  const halted = RUNNERS[key]?.(ctx, restartEligible(ctx.session));
  if (halted) return;
}
```

## What this factory does NOT cover

- The `question` detector is the always-first short-circuit guard that
  precedes the rest of the pipeline. It's not part of the per-phase
  detector list, so leave it hand-written.
- Per-detector cooldowns (spinner's `SPINNER_RE_INTERRUPT_MIN`) live
  inside the `onHit` callback by design — the factory doesn't model
  cooldowns generically because they vary in keying strategy
  (per-session vs per-ticket vs per-(session, kind)).
- The pipeline composition (which detectors run, in what order) stays
  with `phaseFor(phase).detectors` and `maestroPhaseValidator`.
