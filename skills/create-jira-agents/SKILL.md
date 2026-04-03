---
name: create-jira-agents
description: Agent consultation prompts for multi-agent Jira task creation
user-invocable: true
allowed-tools: Task, Bash, Read, Write, Grep, Glob
---
# Create Jira - Agent Consultation Prompts

Referenced by: [create-jira.md](create-jira.md) Steps 6-9

## Backend Agent Consultation

```
Task(developer-nodejs-tdd):
  ## Task Analysis Request

  **Description:** ${description}

  **Context:** [From context.md - keep under 200 lines]

  **Current Task Definition:** [Latest version or initial description]

  ---

  Please analyze this task and provide:

  ### 1. Technical Approach
  - How would you implement this?
  - What patterns would you use?
  - What files/modules would be affected?

  ### 2. Pros and Cons
  | Pros | Cons |
  |------|------|
  | ... | ... |

  ### 3. Testing Strategy
  - Unit tests needed
  - Integration tests needed
  - Mocking requirements

  ### 4. Acceptance Criteria (from backend perspective)
  - [ ] Criterion 1
  - [ ] Criterion 2

  ### 5. Suggested Changes to Task Definition
  - Any scope adjustments?
  - Additional requirements identified?
  - Risks or blockers?

  ### 6. Agreement Status
  - [ ] I AGREE with the current task definition
  - [ ] I SUGGEST CHANGES (listed above)

  Save output to: ${DRAFT_DIR}/backend-v${iteration}.md
```

## Frontend Agent Consultation

```
Task(developer-react-ui-architect):
  ## Task Analysis Request

  **Description:** ${description}

  **Context:** [From context.md - keep under 200 lines]

  **Current Task Definition:** [Latest version]

  **Backend Input:** [From backend-v${iteration}.md if exists - iteration 2+]

  ---

  Please analyze this task and provide:

  ### 1. UI/UX Approach
  - Component architecture
  - State management strategy
  - User interaction flows

  ### 2. Pros and Cons
  | Pros | Cons |
  |------|------|
  | ... | ... |

  ### 3. Visual Testing Strategy
  - Storybook stories needed
  - Visual regression tests
  - Accessibility requirements

  ### 4. Acceptance Criteria (from frontend perspective)
  - [ ] Criterion 1
  - [ ] Criterion 2

  ### 5. Suggested Changes to Task Definition
  - Any scope adjustments?
  - Additional requirements identified?
  - Dependencies on backend changes?

  ### 6. Agreement Status
  - [ ] I AGREE with the current task definition
  - [ ] I SUGGEST CHANGES (listed above)

  Save output to: ${DRAFT_DIR}/frontend-v${iteration}.md
```

## QA Agent Consultation

```
Task(qa-feature-tester):
  ## Task Analysis Request (QA Perspective)

  **Description:** ${description}

  **Context:** [From context.md - keep under 200 lines]

  **Current Task Definition:** [Latest version]

  **Developer Inputs:** [From backend/frontend files if exists - iteration 2+]

  ---

  Please analyze this task and provide:

  ### 1. Testing Plan
  - Manual test scenarios
  - Edge cases to cover
  - Regression areas to verify

  ### 2. Acceptance Criteria (comprehensive)
  Merge developer criteria and add:
  - [ ] User-facing behavior
  - [ ] Error handling scenarios
  - [ ] Performance expectations

  ### 3. Test Data Requirements
  - Database fixtures needed
  - Mock data specifications
  - Environment requirements

  ### 4. Suggested Changes to Task Definition
  - Missing test coverage areas?
  - Unclear requirements that need clarification?
  - Testability concerns?

  ### 5. Agreement Status
  - [ ] I AGREE with the current task definition
  - [ ] I SUGGEST CHANGES (listed above)

  Save output to: ${DRAFT_DIR}/qa-v${iteration}.md
```

## DevOps Agent Consultation

```
Task(developer-devops):
  ## Task Analysis Request (DevOps Perspective)

  **Description:** ${description}

  **Context:** [From context.md - keep under 200 lines]

  **Current Task Definition:** [Latest version]

  ---

  Please analyze this task and provide:

  ### 1. Infrastructure Approach
  - CI/CD changes needed
  - Environment configuration
  - Deployment considerations

  ### 2. Pros and Cons
  | Pros | Cons |
  |------|------|
  | ... | ... |

  ### 3. Operational Considerations
  - Monitoring requirements
  - Logging needs
  - Rollback strategy

  ### 4. Acceptance Criteria (from DevOps perspective)
  - [ ] Criterion 1
  - [ ] Criterion 2

  ### 5. Suggested Changes to Task Definition
  - Security concerns?
  - Scalability issues?
  - Missing infrastructure work?

  ### 6. Agreement Status
  - [ ] I AGREE with the current task definition
  - [ ] I SUGGEST CHANGES (listed above)

  Save output to: ${DRAFT_DIR}/devops-v${iteration}.md
```

## Agent Communication Protocol

### Initial Request Format (Iteration 1 - Parallel)

When first contacting agents IN PARALLEL, provide:
```
## Task Analysis Request

**Original Request:** ${user_description}

**Context Gathered:**
${context_from_exploration}

**Your Role:** Provide ${domain} perspective on this task

**Expected Output:**
1. Technical approach from your domain
2. Pros and cons
3. Testing requirements
4. Acceptance criteria
5. Agreement or suggested changes
```

### Re-consultation Format (Iteration 2+ - Sequential)

```
## Task Re-Analysis Request (Iteration ${n})

**Updated Task Definition:**
${latest_unified_definition}

**Changes from previous iteration:**
- Backend suggested: ${changes}
- Frontend suggested: ${changes}
- QA suggested: ${changes}

**Your Previous Input:** [link to previous file]

**Please review the updated definition and provide:**
1. Do you agree with the changes?
2. Any additional modifications needed?
3. Final agreement status
```
