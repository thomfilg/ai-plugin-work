---
name: check-browser
description: Verify browser/UI state using API-first approach with browser fallback
argument-hint: <question>
user-invocable: true
allowed-tools: Bash, Read, mcp__playwright__browser_navigate, mcp__playwright__browser_snapshot, mcp__playwright__browser_evaluate, mcp__playwright__browser_take_screenshot
---

# Browser Verification Command

Verify browser/UI state efficiently using **API-first approach** when possible, falling back to browser automation only when visual verification is required.

## Purpose

When you need to verify something in the browser (element exists, data status, counts), use this command to get a **concise answer** without filling up context.

## Strategy (API-First)

1. **PREFER API checks** - Most data can be verified via API endpoints:
   - Queue Health: `curl -s http://localhost:5175/api/queue-monitoring | jq '{totalQueues, operationalQueues, criticalQueues}'`
   - Services: `curl -s http://localhost:5175/api/services-status | jq '.summary'`
   - Incidents: `curl -s http://localhost:5175/api/incidents | jq '{total: .incidents | length}'`

2. **Use browser automation ONLY for**:
   - Visual styling (colors, borders, animations)
   - Layout verification
   - User interaction flows
   - Elements not backed by API

## Usage

```
/check-browser <question>
```

## Examples with Preferred Implementation

### Data verification (use API):
```
/check-browser Is Queue Health showing all operational?
→ curl -s localhost:5175/api/queue-monitoring | jq '{total: .queueData.totalQueues, operational: .queueData.operationalQueues}'
```

### Visual verification (use browser):
```
/check-browser What color is the Queue Health card border?
→ Navigate to page, inspect specific element's computed style
```

## Implementation

**For API-verifiable questions:**
Run curl command with jq to extract only the needed data. Return concise JSON.

**For visual verification (rare):**
Use `mcp__playwright_headed__*` tools with `browser_evaluate` to extract specific CSS values:
```javascript
// Example: Get border color
document.querySelector('[data-testid="queue-health-card"]')?.style.borderColor
```

## Response Format

```
ANSWER: Yes, Queue Health is green - 20/20 queues operational
```

```
ANSWER: Border color is rgb(34, 197, 94) / green
```

## Key APIs for Status Site

| Check | API Endpoint | jq Filter |
|-------|--------------|-----------|
| Queue Health | `/api/queue-monitoring` | `.queueData | {totalQueues, operationalQueues, criticalQueues}` |
| Services | `/api/services-status` | `.summary` |
| Incidents | `/api/incidents` | `{total: .incidents \| length, open: [.incidents[] \| select(.status=="open")] \| length}` |
| Dashboard | `/api/dashboard` | `.` |

## Benefits

- **Small responses**: API returns ~100 tokens vs browser snapshot ~14k tokens
- **Faster**: No browser startup/navigation latency
- **More reliable**: Direct data access vs DOM parsing
