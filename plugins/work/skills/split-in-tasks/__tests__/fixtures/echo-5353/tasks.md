# Tasks (ECHO-5353 regression fixture)

_Reproduces the ECHO-5353 lint blast-radius: a pre-existing `no-test-focus` violation exists in `radial-pixel-table.test.ts`, which is NOT listed in any task's `Files in scope`. Pass C must surface this violation as a SPLIT-WARNING with the three operator-resolution options._

## Task 1 — Implement radial pixel renderer

### Type
wiring

### Files in scope
- `radial-pixel-renderer.ts`

### Files explicitly out of scope
_(no sibling tickets)_

### Deliverables
- [ ] 1.1 **RED:** assert renderer returns a non-empty canvas buffer
  - Test: today the function does not exist
- [ ] 1.2 **GREEN:** implement renderer
  - Test: assertion from 1.1 passes
