# Tasks (unique-ownership conflict fixture — literal vs literal)

_Invalid fixture: Task 1 and Task 2 both list `lib/a.ts` under `### Files in scope`. The unique-ownership validator must flag this conflict._

## Task 1 — Add helper A

### Type
chore

### Files in scope
- `lib/a.ts`

### Deliverables
- [ ] 1.1 **GREEN:** add helper A
  - Test: `helperA()` returns 1

### Test Command
```bash
CHANGED_FILES="lib/a.test.ts" eval "$TEST_UNIT_COMMAND"
```

---

## Task 2 — Edit helper A again

### Type
chore

### Files in scope
- `lib/a.ts`

### Deliverables
- [ ] 2.1 **GREEN:** edit helper A
  - Test: `helperA()` returns 2

### Test Command
```bash
CHANGED_FILES="lib/a.test.ts" eval "$TEST_UNIT_COMMAND"
```
