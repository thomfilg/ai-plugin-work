# Tasks (unique-ownership negative fixture — disjoint scope sets)

_Valid fixture: each task owns a disjoint path under `### Files in scope`. The unique-ownership validator must NOT produce any errors._

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

## Task 2 — Add helper B

### Type
chore

### Files in scope
- `lib/b.ts`

### Deliverables
- [ ] 2.1 **GREEN:** add helper B
  - Test: `helperB()` returns 2

### Test Command
```bash
CHANGED_FILES="lib/b.test.ts" eval "$TEST_UNIT_COMMAND"
```

---

## Task 3 — Add helper C

### Type
chore

### Files in scope
- `lib/c.ts`

### Deliverables
- [ ] 3.1 **GREEN:** add helper C
  - Test: `helperC()` returns 3

### Test Command
```bash
CHANGED_FILES="lib/c.test.ts" eval "$TEST_UNIT_COMMAND"
```
