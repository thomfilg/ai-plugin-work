---
name: create-jira-consensus
description: Multi-agent consensus protocol for Jira task creation
user-invocable: true
allowed-tools: Task, Bash, Read, Write, Grep, Glob
---
# Create Jira - Consensus Protocol

Referenced by: [create-jira.md](create-jira.md) Steps 5, 10-12

## Multi-Agent Consensus Protocol

```
╔══════════════════════════════════════════════════════════════════════════════╗
║  MULTI-AGENT CONSENSUS PROTOCOL                                              ║
║                                                                              ║
║  ITERATION 1: Run all agents IN PARALLEL (no dependencies yet)               ║
║  ITERATION 2+: Run sequentially (agents review each other's changes)         ║
║                                                                              ║
║  Each agent provides:                                                        ║
║    • Their perspective on the task                                           ║
║    • Implementation recommendations                                          ║
║    • Pros and cons of their suggested approach                               ║
║    • Testing requirements from their domain                                  ║
║    • Acceptance criteria                                                     ║
║                                                                              ║
║  Loop until ALL agents agree on the final task definition                    ║
╚══════════════════════════════════════════════════════════════════════════════╝
```

## Iteration Algorithm

```
MAX_ITERATIONS = 3
iteration = 0
consensus = false
INVOLVED_AGENTS = [determined in step 3]

WHILE !consensus AND iteration < MAX_ITERATIONS:
    iteration++

    IF iteration == 1:
        # PARALLEL: First iteration - agents work independently
        # Claude Code supports multiple Task tool calls in a single assistant message
        # All calls execute concurrently and results return together
        #
        # HOW TO DO IT: Include multiple Task tool invocations in ONE response
        # Example structure (pseudocode):
        #   Response contains:
        #     Task(developer-nodejs-tdd, prompt1)
        #     Task(developer-react-ui-architect, prompt2)
        #     Task(qa-feature-tester, prompt3)
        #   All three run simultaneously

        FOR EACH agent IN INVOLVED_AGENTS (all in ONE message):
            Task(agent): [analysis request with 200-line context excerpt]

    ELSE:
        # SEQUENTIAL: Later iterations - agents review changes from others
        # Must be sequential because each agent needs to see updated task definition
        FOR EACH agent IN INVOLVED_AGENTS (one at a time):
            Task(agent): [re-analysis with merged task definition + other agents' inputs]

    # After all agents respond:
    FOR EACH agent IN INVOLVED_AGENTS:
        1. Read agent's contribution from returned result
        2. Save to ${DRAFT_DIR}/${agent}-v${iteration}.md
        3. Parse checkbox: /\[x\]\s*I AGREE/i or /\[x\]\s*I SUGGEST CHANGES/i
        4. Log to consensus-log.md

    IF any agent suggested changes (checked [x] I SUGGEST CHANGES):
        - Merge changes into unified task definition
        - Log disagreements to consensus-log.md
        - Save to ${DRAFT_DIR}/task-v${iteration}.md
        - Mark consensus = false
        - Continue loop
    ELSE:
        - All agents checked [x] I AGREE
        - Mark consensus = true
        - EXIT loop

IF iteration >= MAX_ITERATIONS AND !consensus:
    # Escalate to user - agents couldn't agree
    AskUserQuestion: "Agents couldn't reach consensus after 3 iterations. How to proceed?"
    Options:
      - Accept current version (use latest task-v3.md as-is)
      - Partial consensus (accept agreed items, flag disputes as "Needs Discussion")
      - Make manual edits (I'll modify the task definition myself)
      - Abandon (cancel task creation)

    IF "Partial consensus" selected:
        # Identify agreed vs disputed items by comparing agent outputs
        agreed_items = items where ALL agents checked [x] I AGREE or didn't object
        disputed_items = items where ANY agent checked [x] I SUGGEST CHANGES

        # Create final task with disputed items flagged
        In final-task.md, add section:
        ## Needs Discussion
        > These items had agent disagreement and require team input:
        > - [Disputed item 1] - Backend vs Frontend disagreement
        > - [Disputed item 2] - QA raised testability concern
```

## Error Handling for Agent Failures

```
╔══════════════════════════════════════════════════════════════════════════════╗
║  AGENT ERROR HANDLING                                                        ║
║                                                                              ║
║  If an agent fails to respond or returns malformed output:                   ║
║                                                                              ║
║  1. RETRY once with simplified prompt                                        ║
║  2. If retry fails, LOG the failure and CONTINUE without that agent          ║
║  3. Mark the agent as "unavailable" in consensus-log.md                      ║
║  4. Require at least ONE agent to respond for the workflow to continue       ║
║  5. If ALL agents fail, escalate to user                                     ║
╚══════════════════════════════════════════════════════════════════════════════╝
```

### Simplified Prompt Definition

When retrying a failed agent, simplify the prompt by:
1. Remove codebase context entirely (agent works from description only)
2. Remove references to other agents' inputs
3. Keep only: description, required output sections, agreement checkbox

```javascript
function simplifyPrompt(originalPrompt, description) {
  return `
## Task Analysis Request (Simplified Retry)

**Description:** ${description}

**IMPORTANT:** Previous attempt failed. Please provide a focused response.

Provide ONLY:
1. Brief technical approach (3-5 bullet points)
2. Key acceptance criteria (3-5 items)
3. Agreement status (MUST check one box)

### Agreement Status
- [ ] I AGREE with the task as described
- [x] I SUGGEST CHANGES: [list changes here]
`;
}
```

### Retry Logic

```javascript
async function consultAgent(agentType, prompt, draftDir, iteration, description) {
  const MAX_RETRIES = 2;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const result = await Task(agentType, prompt);

      // Strict validation: check for actual checkbox selection
      const agreesPattern = /\[x\]\s*I AGREE/i;
      const suggestsPattern = /\[x\]\s*I SUGGEST CHANGES/i;

      if (!agreesPattern.test(result) && !suggestsPattern.test(result)) {
        throw new Error('Agent did not check Agreement Status checkbox');
      }

      // Save successful response
      saveToFile(`${draftDir}/${agentType}-v${iteration}.md`, result);
      return { success: true, result };

    } catch (error) {
      logToConsensusLog(`Agent ${agentType} attempt ${attempt} failed: ${error.message}`);

      if (attempt < MAX_RETRIES) {
        // Retry with simplified prompt (no context, fewer sections)
        prompt = simplifyPrompt(prompt, description);
      }
    }
  }

  // All retries failed
  logToConsensusLog(`Agent ${agentType} UNAVAILABLE after ${MAX_RETRIES} attempts`);
  return { success: false, error: 'Agent unavailable' };
}
```

## Consensus Logging

### Create/Update consensus-log.md

```markdown
# Consensus Log

## Iteration ${iteration}
**Timestamp:** ${new Date().toISOString()}

### Agent Responses

| Agent | Status | Changes Suggested |
|-------|--------|-------------------|
| backend | ✅ Responded | [Yes/No] |
| frontend | ✅ Responded | [Yes/No] |
| qa | ⚠️ Unavailable | N/A |
| devops | ✅ Responded | [Yes/No] |

### Disagreements
${if any agent suggested changes}
- **Backend:** Wants to add rate limiting consideration
- **Frontend:** Suggests different component structure
${endif}

### Resolution
- Changes merged into task-v${iteration}.md
- Proceeding to iteration ${iteration + 1}

---
```

### Consensus Check Script

```bash
echo "📋 Consensus Check (Iteration ${iteration}):"

CHANGES_SUGGESTED=false
AGENTS_RESPONDED=0

for agent in backend frontend qa devops; do
  FILE="${DRAFT_DIR}/${agent}-v${iteration}.md"
  if [ -f "$FILE" ]; then
    AGENTS_RESPONDED=$((AGENTS_RESPONDED + 1))

    # Strict checkbox parsing: look for [x] before the text
    if grep -qiE '\[x\]\s*I SUGGEST CHANGES' "$FILE"; then
      echo "  ⚠️  ${agent}: SUGGESTS CHANGES"
      CHANGES_SUGGESTED=true
      # Extract what changes they want
      grep -A5 "Suggested Changes" "$FILE" >> "${DRAFT_DIR}/consensus-log.md"
    elif grep -qiE '\[x\]\s*I AGREE' "$FILE"; then
      echo "  ✅ ${agent}: AGREES"
    else
      echo "  ⚠️  ${agent}: RESPONDED but no checkbox selected - treating as DISAGREE"
      CHANGES_SUGGESTED=true
    fi
  else
    echo "  ❌ ${agent}: NO RESPONSE"
  fi
done

if [ "$AGENTS_RESPONDED" -eq 0 ]; then
  echo "❌ NO AGENTS RESPONDED - Escalating to user"
  # Use AskUserQuestion to get manual input
fi

if [ "$CHANGES_SUGGESTED" = true ]; then
  echo ""
  echo "🔄 Changes suggested - synthesizing and re-consulting..."
else
  echo ""
  echo "🎉 CONSENSUS REACHED!"
fi
```

## Synthesize Changes (If No Consensus)

If any agent suggested changes:

1. Read all suggested changes from agent files
2. Create unified task definition incorporating changes
3. Save to `${DRAFT_DIR}/task-v${iteration+1}.md`
4. Log synthesis decisions to consensus-log.md
5. Return to iteration loop

### Unified Task Definition Template

```markdown
# Unified Task Definition v${iteration}

## Summary
[Synthesized from all agent inputs]

## Scope
[Merged scope from all perspectives]

## Technical Approach
### Backend
[From backend agent]

### Frontend
[From frontend agent]

### Infrastructure
[From devops agent]

## Acceptance Criteria
[Merged and deduplicated from all agents]

## Testing Requirements
[From QA agent + developer testing needs]

## Open Questions
[Unresolved issues that need discussion]

## Changes from v${iteration-1}
- [List of changes made based on agent feedback]
```
