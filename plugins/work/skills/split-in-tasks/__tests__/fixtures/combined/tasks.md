# Tasks (synthetic combined fixture)

_Operator end-to-end fixture for the `split-in-tasks` skill (GH-450, Task 7,
Scenario 8). Stitches the three regression fixtures into a single synthetic
ticket so one integration sweep exercises Pass A, Pass B, and Pass C against
the same project root._

_Sub-fixture map (see sibling directories under `__tests__/fixtures/`):_

- **Pass A — chronological collision** — replays `echo-5361/tasks.md`
  (Task 1 GREEN deletes `surfaces/foo.ts`; Task 2 RED asserts the same file
  is gone — already true after Task 1, so the RED is empty).
- **Pass B — contract divergence** — runs against `echo-5362/`
  (`deleter-select-field.tsx` consumes a `data: Array<…>` shape from sibling
  ticket ECHO-5352's `router.ts` which actually returns `{ deleters: … }`).
- **Pass C — lint blast-radius** — scans `echo-5353/`
  (pre-existing `no-test-focus` violation in `radial-pixel-table.test.ts`
  which is NOT in any task's `Files in scope`).

## Task 1 — Chronological collision (mirrors echo-5361)

### Type
chore

### Files in scope
- `surfaces/foo.ts`

### Deliverables
- [ ] 1.1 **GREEN:** delete `surfaces/foo.ts` from the working tree
  - Test: file `surfaces/foo.ts` no longer exists

---

## Task 2 — Verify legacy surface is gone (empty-RED — Pass A should warn)

### Type
verification

### Files in scope
- `surfaces/foo.ts`

### Deliverables
- [ ] 2.1 **RED:** assert that `surfaces/foo.ts` has been removed
  - Test: `fs.existsSync('surfaces/foo.ts')` returns false
- [ ] 2.2 **GREEN:** no implementation needed (verification only)

---

## Task 3 — Contract-divergent consumer (mirrors echo-5362 — Pass B should warn)

### Type
wiring

### Files in scope
- `deleter-select-field.tsx`

### Files explicitly out of scope
- `router.ts` (owned by sibling ticket ECHO-5352)

### Deliverables
- [ ] 3.1 **RED:** render the select field from `data` array
  - Test: component renders one `<option>` per entry in `data`
- [ ] 3.2 **GREEN:** wire `deleter-select-field.tsx` to consume the array

---

## Task 4 — Implement radial pixel renderer (mirrors echo-5353 — Pass C should warn)

### Type
wiring

### Files in scope
- `radial-pixel-renderer.ts`

### Files explicitly out of scope
_(no sibling tickets)_

### Deliverables
- [ ] 4.1 **RED:** assert renderer returns a non-empty canvas buffer
  - Test: today the function does not exist
- [ ] 4.2 **GREEN:** implement renderer
  - Test: assertion from 4.1 passes
