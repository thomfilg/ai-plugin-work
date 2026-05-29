# Tasks (ECHO-5361 regression fixture)

_Reproduces the ECHO-5361 chronological collision: Task 1 deletes `surfaces/foo.ts`, Task 2's RED then "asserts" the file is absent — which already holds after Task 1, so the RED is a no-op._

## Task 1 — Remove legacy surface file

### Type
chore

### Files in scope
- `surfaces/foo.ts`

### Deliverables
- [ ] 1.1 **GREEN:** delete `surfaces/foo.ts` from the working tree
  - Test: file `surfaces/foo.ts` no longer exists

---

## Task 2 — Verify legacy surface is gone

### Type
verification

### Files in scope
- `surfaces/foo.ts`

### Deliverables
- [ ] 2.1 **RED:** assert that `surfaces/foo.ts` has been removed
  - Test: `fs.existsSync('surfaces/foo.ts')` returns false
- [ ] 2.2 **GREEN:** no implementation needed (verification only)
