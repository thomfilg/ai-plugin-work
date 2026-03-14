# Copilot Code Review Instructions

## Comment Severity Classification

Every review comment MUST include a severity tag at the start. Use one of these levels:

- `[critical]` — Security vulnerability, data loss risk, or breaking production behavior. Must be fixed before merge.
- `[high]` — Bug, incorrect logic, or missing error handling that will cause issues. Must be fixed before merge.
- `[medium]` — Code quality issue, missing validation, or suboptimal pattern that should be addressed. Should be fixed before merge.
- `[low]` — Minor improvement, slightly better naming, or small refactor suggestion. Nice to have but not required.
- `[nitpick]` — Stylistic preference, trivial formatting, or cosmetic suggestion. Can be safely ignored.

### Example Format

```
[medium] Consider adding error handling for the async call on line 42.
The `fetchData()` call can throw if the API is unreachable...
```

```
[nitpick] Could rename `val` to `value` for clarity.
```

## Review Focus

When reviewing pull requests in this repository:

1. Focus on correctness, security, and maintainability
2. This is a Claude Code plugin (Node.js, no TypeScript) — hooks and scripts run as CLI processes
3. Check for proper error handling (fail-open patterns are intentional in hooks)
4. Verify exit codes are used correctly (0 = success, 1 = failure, 2 = error)
5. Do not flag missing TypeScript types — this project uses plain JavaScript intentionally
6. Do not suggest adding JSDoc to every function — only flag genuinely unclear APIs
