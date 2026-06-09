# createDetectorRunner

Declarative builder for the event-loop detector-runner shape. Wraps a
`{ detect(ctx) → hit }` detector module in the standard
"guard → detect → dispatch hit/miss → maybe-short-circuit" envelope an
event loop needs.

Drop-in target: any place where an event loop runs a list of detector
modules per tick and acts on hits.

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

## Example callers

Below is a typical pipeline wiring six detectors with the factory. The
`tickSession` pipeline collapses to a 3-line loop:

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

  // ... commitStall, prComments, prStatus follow the same shape
};

for (const key of detectorsToRun) {
  const halted = RUNNERS[key]?.(ctx, restartEligible(ctx.session));
  if (halted) return;
}
```

## What this factory does NOT cover

- Always-first short-circuit guards (e.g. a "question" detector that
  must run before the pipeline) — those aren't per-phase detectors, so
  keep them hand-written.
- Per-detector cooldowns. They live inside the `onHit` callback by
  design because keying strategy varies (per-session vs per-ticket vs
  per-(session, kind)).
- The pipeline composition (which detectors run, in what order) — that
  belongs in a dispatch table validated by `dispatchRegistryValidator`.
