# Tasks (unique-ownership conflict fixture — glob vs literal)

_Invalid fixture: Task 1 owns `lib/foo/**` (glob) and Task 2 owns the literal `lib/foo/bar.ts`. The glob in Task 1 covers the literal in Task 2 — the unique-ownership validator must flag this overlap._

## Task 1 — Own lib/foo

### Type
wiring

### Files in scope
- `lib/foo/**`

### Deliverables
- [ ] 1.1 **GREEN:** own lib/foo
  - Test: covers lib/foo

### Test Command
```bash
CHANGED_FILES="lib/foo/index.test.ts" eval "$TEST_UNIT_COMMAND"
```

---

## Task 2 — Own bar.ts directly

### Type
chore

### Files in scope
- `lib/foo/bar.ts`

### Deliverables
- [ ] 2.1 **GREEN:** edit bar
  - Test: bar exports something

### Test Command
```bash
CHANGED_FILES="lib/foo/bar.test.ts" eval "$TEST_UNIT_COMMAND"
```
