---
name: create-design-doc
argument-hint: [topic] | --from-jira-draft <slug> | --publish-wiki <slug>
description: Guide for writing Design Docs - a communication and decision documentation tool
user-invocable: true
---
# Design Doc Guide

A comprehensive guide for writing Design Docs - relatively informal documents that software authors create before embarking on a coding project.

## Usage

This command can be run in three modes:

### Standalone Mode
```
/create-design-doc <topic or feature name>
```
Creates a new design doc from scratch. See [Standalone Mode Instructions](#standalone-mode-instructions) below.

### Bootstrap from Jira Draft Mode
```
/create-design-doc --from-jira-draft <slug>
```
Bootstraps a design doc from existing `/create-jira` artifacts. This reuses work already done during Jira task creation.

### Publish Existing Draft to Wiki
```
/create-design-doc --publish-wiki <slug>
```
Publishes an existing design doc from `tasks/design-docs/` to the repository wiki. Use this if you skipped wiki publishing earlier or want to publish updates.

**How it works:**
1. Reads artifacts from `tasks/drafts/<slug>/`
2. Maps create-jira outputs to design doc sections (see mapping table below)
3. Generates a pre-filled design doc draft

**Artifact Mapping:**

| create-jira Artifact | Design Doc Section |
|---------------------|-------------------|
| `context.md` | Scope and Context |
| `final-task.md` Summary | Overview |
| `final-task.md` Acceptance Criteria | Objectives |
| `final-task.md` Out of Scope | Non-Objectives |
| `*-v*.md` Technical Approach + Pros/Cons | Design (Trade-offs) |
| `consensus-log.md` Disagreements | Alternatives Considered |
| Agent notes (security, API, team mentions) | Cross-cutting Concerns |
| `final-task.md` Testing Plan | Testing and Observability |
| `final-task.md` Open Questions | Open Questions |

**Example:**
```bash
# First, create a Jira task (which generates artifacts)
/create-jira migrate status-site to new API architecture

# Later, bootstrap design doc from those artifacts
/create-design-doc --from-jira-draft migrate-status-site-to-new
```

---

## What is a Design Doc?

**Definition:** Relatively informal documents that the primary author(s) of a software system or application create before starting the coding project.

**Key characteristics:**

- Documents the high-level implementation strategy
- Emphasizes trade-offs and compensations
- Created by the team (not just tech leads or architects)
- Aims to make decisions clear and shareable

## Why Write Design Docs?

### Main Objectives

1. **Early Problem Identification** - Catch issues while they're still cheap to fix (before production)

2. **Achieve Consensus** - Build agreement around solutions within the organization

3. **Address Cross-cutting Concerns** - Security, testability, monitoring, observability, and team impacts

4. **Scale Knowledge** - Transfer knowledge from senior engineers to the entire organization

5. **Build Organizational Memory** - Document decisions for future reference

6. **Technical Portfolio** - Serves as evidence of your contributions for promotions

## Document Structure

> **Important:** These sections are recommendations, not strict requirements. The document should be relatively informal.

### 1. Header

| Field | Description |
|-------|-------------|
| **Title** | Document name |
| **Authors** | Primary author(s) and co-authors |
| **Reviewers** | People who reviewed the document |
| **Status** | Draft, Proposed, Approved, Rejected |
| **Created Date** | When the document was created |
| **Tags/Labels** | For indexing and searchability |

**Tips:**
- Always update the document status
- Involve senior people from relevant areas (security, infrastructure, platform)
- Add tags for easy searching later

### 2. Overview

A brief, high-level description of what the document is about.

**Tips:**
- Keep it to 1-2 paragraphs maximum
- No details - just enough context for readers to decide if they should continue reading
- Someone with prior knowledge should understand the general topic

**Example:**
```
This design doc presents the creation of a new Backend-for-Frontend (BFF)
for an online sales system that will now offer a new mobile application.
```

### 3. Scope and Context

Describe the scenario, motivators, and background information.

**Tips:**
- Be succinct - don't over-explain
- Don't include objectives or solutions here - just the problem
- Think of it as setting the stage for your story
- Include: current technologies, technical debt, the problem to solve

**Example:**
```
The online sales system of company XYZ seeks to enhance user experience
through the launch of a new mobile application. However, the current REST API
has an excessively large payload for mobile devices.
```

### 4. Objectives and Non-Objectives

#### Objectives
What you want to achieve with this solution.

**Tips:**
- Use measurable metrics when possible
- Format as a list, not prose
- Be specific: "reduce costs through traffic reduction" not just "reduce costs"

**Example Objectives:**
- Reduce response time of the online sales system to improve user experience
- Improve scalability to meet growing user demand
- Increase sales conversion rate by offering faster, more intuitive experience
- Facilitate maintenance by isolating legacy code

#### Non-Objectives (Out of Scope)
What will NOT be addressed in this document.

**Tips:**
- Don't just negate objectives
- Include things that might reasonably be expected but won't be done
- Helps set clear expectations

**Example Non-Objectives:**
- Creation of new core functionalities for the sales system
- Implementation of high-level security in the BFF (will be in another project)
- Creation of a caching solution (can be implemented later)

### 5. Design (The Solution)

The most crucial part - your proposed solution.

**Components:**
- **Solution Overview** - High-level description of your approach
- **Diagrams** - Context diagrams, sequence diagrams, C4 models
- **APIs** - Affected or new API endpoints
- **Data** - Data being manipulated, especially sensitive data
- **Pseudocode** - Only if explaining a new algorithm
- **Pros and Cons** - Trade-offs of your solution

**Tips:**
- Focus on trade-offs - this creates long-term value
- Use data and facts, not just opinions
- Don't copy entire schemas or APIs - only what's relevant
- Visuals complement explanations, they don't replace them
- Keep highlighting WHY decisions were made

**Example Pros:**
- Improved user experience
- Can create specific APIs for different clients
- 30% payload reduction

**Example Cons:**
- Added complexity with new component
- Increased development time and cost
- Need to ensure APIs support orchestration

### 6. Alternatives Considered

Other solutions that were evaluated and why they weren't chosen.

**Tips:**
- Always include "do nothing" as an alternative
- Explain why each alternative was rejected
- Focus on the trade-offs that led to your chosen solution

**Example:**
```
Alternative 1: Modify payload through HTTP compression
- Not adopted because: Implementation and maintainability would be compromised

Alternative 2: Use Gzip compression
- Not adopted because: Only achieved 10% payload reduction (insufficient)
```

### 7. Cross-cutting Concerns

Describe impacts on other teams, systems, or concerns.

**Include:**
- Security concerns (confidential data, vulnerabilities)
- API compatibility breaks
- Increased traffic to other systems
- Infrastructure considerations
- Impacted teams

**Tips:**
- Involve impacted teams as early as possible
- Request reviews from these stakeholders

### 8. Testing and Observability

How the solution will be tested and monitored.

**Include:**
- Testing strategy (unit, integration, e2e)
- Success metrics
- Monitoring and observability plan
- Rollout plan (phased deployment, A/B testing)
- **Rollback strategy** - How to revert if things go wrong in production

**Tips:**
- Don't overlook rollback strategy - it's often forgotten until things break in production
- Define clear rollback triggers (error rate thresholds, latency spikes)
- Document manual vs automated rollback procedures
- Consider data migration rollback if applicable

### 9. Open Questions

Questions that don't have answers yet.

**Tips:**
- It's okay to not know everything
- Document uncertainties for future discussion

## Document Lifecycle

```
┌─────────────────────────────────────────────────────────────────┐
│                                                                 │
│  1. Write (alone or with co-authors)                            │
│              │                                                  │
│              ▼                                                  │
│  2. Share with team (problem space experts)                     │
│              │                                                  │
│              ▼                                                  │
│  3. Receive feedback ◄────────────────────────┐                │
│              │                                 │                │
│              ▼                                 │                │
│  4. Iterate and improve ──────────────────────┘                │
│              │                                                  │
│              ▼                                                  │
│  5. Expand audience (seniors, architects, security)             │
│              │                                                  │
│              ▼                                                  │
│  6. Publish to central repository                               │
│              │                                                  │
│              ▼                                                  │
│  7. Final reviews and approval                                  │
│              │                                                  │
│              ▼                                                  │
│  8. Begin implementation                                        │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

**Key insight:** Start writing early! Don't wait until deadlines approach. The overhead is absorbed and diluted over time.

## When NOT to Write a Design Doc

1. **Pathological Culture** - If decisions are purely top-down with no room for discussion

2. **Overhead Without Understanding** - If people see it as bureaucracy rather than valuable communication

3. **No Complexity** - Simple features with only one obvious solution don't need extensive documentation

## Tools

> **Note:** The specific tool matters less than having a **searchable, linkable, and version-controlled** location. Tools and preferences change over time - what's important is that your design docs are discoverable and maintain their history.

| Tool | Best For | Notes |
|------|----------|-------|
| **Confluence** | Corporate wikis | Great integration with Jira, collaboration features, version history |
| **Google Docs** | If already available | Shared drives, easy collaboration |
| **Notion** | Modern teams | Good organization, but has costs |
| **GitHub/GitLab** | Code-adjacent docs | Good for technical audience, not ideal for non-developers |
| **PlantUML** | Diagrams as code | Textual diagrams, supports sequence, C4, etc. |
| **Structurizr** | C4 diagrams | One model generates multiple diagram views |
| **WebSequenceDiagrams** | Sequence diagrams | Simple and effective |

## Related Document Types

| Type | Purpose | Formality |
|------|---------|-----------|
| **Design Doc** | System/feature design | Relatively informal |
| **ADR** (Architecture Decision Record) | Single architectural decisions | Short, close to code |
| **RFC** (Request for Comments) | Proposals needing feedback | More formal |
| **Tutorial** | How-to guides | For onboarding |

## References

- [Design Docs at Google](https://www.industrialempathy.com/posts/design-docs-at-google/)
- [Introduction to Design Docs (PicPay)](https://medium.com/picpay-techlab/introdu%C3%A7%C3%A3o-a-design-docs-c5f7d7ef0ee4)
- [How to Write Effective Documentation](https://documentation.divio.com/)
- [Design Docs, Markdown, and Git](https://www.youtube.com/watch?v=hqE3V2V6r3E)
- [RFC-like Design Doc Collection](https://github.com/joelparkerhenderson/architecture-decision-record)

---

## Standalone Mode Instructions

When invoked with a topic (e.g., `/create-design-doc new-auth-system`), follow these steps:

### Step 1: Create draft directory and generate slug

```bash
TOPIC="$ARGUMENTS"
SLUG=$(echo "$TOPIC" | tr '[:upper:]' '[:lower:]' | tr -cs '[:alnum:]' '-' | cut -d'-' -f1-5 | sed 's/-$//')
DRAFT_DIR="tasks/design-docs"
mkdir -p "${DRAFT_DIR}"

echo "📁 Creating design doc for: ${TOPIC}"
echo "📄 Output: ${DRAFT_DIR}/${SLUG}-design-doc.md"
```

### Step 2: Optional context gathering

Ask user if they want codebase context:

```
AskUserQuestion:
  question: "Would you like me to explore the codebase for relevant context?"
  header: "Context"
  options:
    - label: "Yes, explore codebase"
      description: "Search for related code, patterns, and existing implementations"
    - label: "No, I'll provide context"
      description: "Skip exploration, I'll describe the context myself"
```

**If user selects "Yes":**

```
Task(Explore):
  Explore the codebase for context related to: ${TOPIC}

  Find:
  1. Existing implementations of similar functionality
  2. Related files and modules
  3. Current patterns and conventions
  4. Test patterns in related areas

  Keep exploration focused - max 300 lines of context.
  Save findings to: ${DRAFT_DIR}/${SLUG}-context.md
```

### Step 3: Interactive template prompts

Guide user through each section with targeted questions:

```
AskUserQuestion:
  question: "Describe the problem you're solving in 1-2 sentences"
  header: "Overview"
  options:
    - label: "Example: Our API latency exceeds SLA during peak hours"
      description: "Use this as a template, modify in 'Other'"
  # User provides actual input via "Other"
```

```
AskUserQuestion:
  question: "What are the measurable objectives? (comma-separated)"
  header: "Objectives"
  options:
    - label: "Example: Reduce latency by 30%, Support 10k concurrent users"
      description: "Use this as a template, modify in 'Other'"
  # User provides actual input via "Other"
```

```
AskUserQuestion:
  question: "What is explicitly OUT of scope?"
  header: "Non-Objectives"
  options:
    - label: "Example: Mobile app changes, Database migration, UI redesign"
      description: "Use this as a template, modify in 'Other'"
  # User provides actual input via "Other"
```

```
AskUserQuestion:
  question: "Describe your proposed solution approach"
  header: "Design"
  options:
    - label: "Example: Add Redis caching layer between API and database"
      description: "Use this as a template, modify in 'Other'"
  # User provides actual input via "Other"
```

```
AskUserQuestion:
  question: "What alternatives did you consider?"
  header: "Alternatives"
  options:
    - label: "I have alternatives to document"
      description: "I'll describe other approaches considered"
    - label: "Skip for now"
      description: "I'll fill this in later"
```

### Step 4: Generate design doc from inputs

Populate the Quick Start Template with user inputs and any gathered context.

**Migration warning detection:**

```javascript
// Check topic for migration-related keywords
if (/\b(migrate|migration|schema|data migration)\b/i.test(TOPIC)) {
  // Inject warning into Rollback Strategy section:
  // > ⚠️ **Review rollback strategy carefully** - migrations are often the hardest to reverse.
  // > Consider: data backup, down migrations, feature flags, blue-green deployment.
}
```

### Step 5: Save and offer wiki publish

```bash
TASK_DESIGN_DOC="${DRAFT_DIR}/${SLUG}-design-doc.md"
# Write generated design doc to file

echo "📄 Design doc saved to: ${TASK_DESIGN_DOC}"
```

Then proceed to [User confirmation before wiki publish](#step-5-user-confirmation-before-wiki-publish).

---

## Quick Start Template

```markdown
# [Title]

**Authors:** [names]
**Reviewers:** [names]
**Status:** Draft | Proposed | Approved | Rejected
**Date:** [date]
**Related Jira:** [PROJ-XXX](https://your-org.atlassian.net/browse/PROJ-XXX) _(if applicable)_
**Tags:** design-doc, [topic]

## Overview
[1-2 paragraphs - what is this about?]

## Context and Scope
[What's the current situation? What problem are we solving?]

## Objectives
- [Measurable goal 1]
- [Measurable goal 2]

## Non-Objectives
- [What we're NOT doing]

## Design
[Your solution with diagrams, trade-offs, pros/cons]

## Alternatives Considered
[Other options and why they weren't chosen]

## Cross-cutting Concerns
[Security, team impacts, infrastructure]

## Testing and Rollout
[How to test and deploy]

## Open Questions
- [Unanswered question 1]
```

---

## Bootstrap from Jira Draft Instructions

When invoked with `--from-jira-draft <slug>`, follow these steps:

### Step 1: Validate draft exists

```bash
SLUG="$ARGUMENTS"  # Extract slug from --from-jira-draft <slug>
DRAFT_DIR="tasks/drafts/${SLUG}"

if [ ! -d "$DRAFT_DIR" ]; then
  echo "❌ Draft directory not found: ${DRAFT_DIR}"
  echo "Available drafts:"
  ls -1 tasks/drafts/ 2>/dev/null || echo "  (none)"
  exit 1
fi
```

### Step 2: Read and parse artifacts

```
Read the following files from ${DRAFT_DIR}/:
- context.md (codebase exploration)
- final-task.md (consensus task definition)
- consensus-log.md (iteration history and disagreements)
- *-v*.md (agent contributions with pros/cons)
```

### Step 3: Generate design doc

Use the Quick Start Template above and populate each section:

```markdown
# [Title from final-task.md Summary]

**Authors:** [Generated by create-jira multi-agent workflow]
**Reviewers:** [To be assigned]
**Status:** Draft
**Date:** ${current_date}
**Related Jira:** [PROJ-XXX](https://your-org.atlassian.net/browse/PROJ-XXX) _(link added after Jira task created)_
**Tags:** design-doc, [extract from detected task types]

## Overview
[Extract Summary section from final-task.md - condense to 1-2 paragraphs]

## Context and Scope
[Extract from context.md:
 - Current state of the codebase
 - Problem being solved
 - Relevant existing patterns found]

## Objectives
[Convert Acceptance Criteria from final-task.md to measurable objectives:
 - Transform "[ ] Feature X works" → "Enable Feature X with <metric>"
 - Keep measurable where possible]

## Non-Objectives
[Copy Out of Scope section from final-task.md verbatim]

## Design

### Solution Overview
[Extract Technical Approach section from final-task.md]

### Trade-offs Analysis

[For each agent that contributed, extract their Pros/Cons table:]

#### Backend Perspective
| Pros | Cons |
|------|------|
[From backend-v*.md]

#### Frontend Perspective
| Pros | Cons |
|------|------|
[From frontend-v*.md]

#### DevOps Perspective
| Pros | Cons |
|------|------|
[From devops-v*.md]

## Alternatives Considered

[Extract from consensus-log.md:
 - Any "I SUGGEST CHANGES" items that were discussed
 - Resolution decisions made
 - Include "do nothing" if not already present]

Example format:
```
Alternative 1: [Suggested change from Agent X]
- Not adopted because: [Resolution from consensus-log.md]

Alternative 2: Do nothing (status quo)
- Not adopted because: [Problem statement from context.md]
```

## Cross-cutting Concerns

[Scan agent files for mentions of:
 - Security (grep for: security, auth, credential, vulnerability, OWASP)
 - API compatibility (grep for: breaking change, backward, deprecat)
 - Team impacts (grep for: team, notify, coordinate, dependency)
 - Infrastructure (grep for: infrastructure, deploy, scale, monitor)]

## Testing and Observability

### Testing Strategy
[Extract Testing Plan section from final-task.md]

### Rollback Strategy
[Generate based on task type:
 - For DB changes: "Revert migration with down script"
 - For API changes: "Feature flag rollback or version rollback"
 - For UI changes: "Deploy previous version"
 - Add: triggers, procedures, data considerations]

## Open Questions
[Copy Open Questions from final-task.md]
[Add any unresolved disagreements from consensus-log.md]
```

### Step 4: Save to tasks folder

```bash
# Save draft to drafts folder
OUTPUT_FILE="${DRAFT_DIR}/design-doc.md"
# Write generated design doc to file

# Copy to tasks/design-docs for version control
TASK_DESIGN_DOC="tasks/design-docs/${SLUG}-design-doc.md"
mkdir -p tasks/design-docs
cp "${OUTPUT_FILE}" "${TASK_DESIGN_DOC}"

echo "📄 Design doc saved to: ${TASK_DESIGN_DOC}"
```

### Step 5: User confirmation before wiki publish

```
═══════════════════════════════════════════════════════════
          DESIGN DOC READY FOR REVIEW
═══════════════════════════════════════════════════════════

📄 Draft: ${TASK_DESIGN_DOC}

Please review the design doc before publishing to wiki.

═══════════════════════════════════════════════════════════
```

Use AskUserQuestion:
- **Publish to wiki** - Review complete, publish design doc to repository wiki
- **Review first** - Let me review the draft file first
- **Skip wiki** - Keep local only, don't publish to wiki

**If user selects "Skip wiki":** Skip to Step 7 (completion report without wiki URL).

### Step 6: Publish to repository wiki (after confirmation)

```bash
# Clone wiki repository (if not already cloned)
WIKI_DIR="../$(basename $(pwd)).wiki"
if [ ! -d "$WIKI_DIR" ]; then
  gh repo clone $(gh repo view --json nameWithOwner -q .nameWithOwner).wiki "$WIKI_DIR" 2>/dev/null || {
    echo "⚠️ Wiki not enabled or empty. Initializing..."
    mkdir -p "$WIKI_DIR"
    cd "$WIKI_DIR"
    git init
    git remote add origin "https://github.com/$(gh repo view --json nameWithOwner -q .nameWithOwner).wiki.git"
    echo "# Wiki Home" > Home.md
    git add Home.md
    git commit -m "Initialize wiki"
    git push -u origin master || git push -u origin main
    cd -
  }
fi

# Copy design doc to wiki
WIKI_FILE="${WIKI_DIR}/Design-Docs/${SLUG}.md"
mkdir -p "${WIKI_DIR}/Design-Docs"
cp "${TASK_DESIGN_DOC}" "${WIKI_FILE}"

# Update Design-Docs index page
INDEX_FILE="${WIKI_DIR}/Design-Docs.md"
if [ ! -f "$INDEX_FILE" ]; then
  echo "# Design Documents" > "$INDEX_FILE"
  echo "" >> "$INDEX_FILE"
  echo "Index of design documents for this project." >> "$INDEX_FILE"
  echo "" >> "$INDEX_FILE"
  echo "## Documents" >> "$INDEX_FILE"
  echo "" >> "$INDEX_FILE"
fi

# Add link to index if not already present
if ! grep -q "${SLUG}" "$INDEX_FILE" 2>/dev/null; then
  echo "- [${SLUG}](Design-Docs/${SLUG})" >> "$INDEX_FILE"
fi

# Commit and push to wiki
cd "$WIKI_DIR"
git add .
git commit -m "docs: add design doc for ${SLUG}"
git push origin master || git push origin main
cd -

WIKI_URL="https://github.com/$(gh repo view --json nameWithOwner -q .nameWithOwner)/wiki/Design-Docs/${SLUG}"
echo "📚 Wiki published: ${WIKI_URL}"
```

### Step 7: Report completion

```bash
echo "═══════════════════════════════════════════════════════════"
echo "          DESIGN DOC GENERATED"
echo "═══════════════════════════════════════════════════════════"
echo ""
echo "📄 Local:  ${TASK_DESIGN_DOC}"
${if wiki_published}
echo "📚 Wiki:   ${WIKI_URL}"
${else}
echo "📚 Wiki:   (skipped)"
${endif}
echo ""
echo "Sections populated from Jira draft artifacts:"
echo "  ✅ Overview (from final-task.md)"
echo "  ✅ Context and Scope (from context.md)"
echo "  ✅ Objectives (from acceptance criteria)"
echo "  ✅ Non-Objectives (from out of scope)"
echo "  ✅ Design + Trade-offs (from agent contributions)"
echo "  ✅ Alternatives Considered (from consensus-log.md)"
echo "  ✅ Testing and Observability (from testing plan)"
echo "  ✅ Open Questions"
echo ""
echo "Next steps:"
echo "  • Review and refine the generated design doc"
echo "  • Add diagrams (context, sequence, C4) as needed"
echo "  • Fill in Cross-cutting Concerns with specifics"
${if wiki_published}
echo "  • Share wiki link with reviewers for feedback"
${else}
echo "  • Run /create-design-doc --publish-wiki ${SLUG} to publish later"
${endif}
echo "  • Update status from Draft → Proposed when ready"
echo "═══════════════════════════════════════════════════════════"
```

---

## Publish Wiki Instructions

When invoked with `--publish-wiki <slug>`, follow these steps:

### Step 1: Validate design doc exists

```bash
SLUG="$ARGUMENTS"  # Extract slug from --publish-wiki <slug>
TASK_DESIGN_DOC="tasks/design-docs/${SLUG}-design-doc.md"

if [ ! -f "$TASK_DESIGN_DOC" ]; then
  echo "❌ Design doc not found: ${TASK_DESIGN_DOC}"
  echo "Available design docs:"
  ls -1 tasks/design-docs/*.md 2>/dev/null || echo "  (none)"
  exit 1
fi

echo "📄 Found: ${TASK_DESIGN_DOC}"
```

### Step 2: Publish to wiki

```bash
# Clone wiki repository (if not already cloned)
WIKI_DIR="../$(basename $(pwd)).wiki"
if [ ! -d "$WIKI_DIR" ]; then
  gh repo clone $(gh repo view --json nameWithOwner -q .nameWithOwner).wiki "$WIKI_DIR" 2>/dev/null || {
    echo "⚠️ Wiki not enabled or empty. Initializing..."
    mkdir -p "$WIKI_DIR"
    cd "$WIKI_DIR"
    git init
    git remote add origin "https://github.com/$(gh repo view --json nameWithOwner -q .nameWithOwner).wiki.git"
    echo "# Wiki Home" > Home.md
    git add Home.md
    git commit -m "Initialize wiki"
    git push -u origin master || git push -u origin main
    cd -
  }
fi

# Copy design doc to wiki
WIKI_FILE="${WIKI_DIR}/Design-Docs/${SLUG}.md"
mkdir -p "${WIKI_DIR}/Design-Docs"
cp "${TASK_DESIGN_DOC}" "${WIKI_FILE}"

# Update Design-Docs index page
INDEX_FILE="${WIKI_DIR}/Design-Docs.md"
if [ ! -f "$INDEX_FILE" ]; then
  echo "# Design Documents" > "$INDEX_FILE"
  echo "" >> "$INDEX_FILE"
  echo "Index of design documents for this project." >> "$INDEX_FILE"
  echo "" >> "$INDEX_FILE"
  echo "## Documents" >> "$INDEX_FILE"
  echo "" >> "$INDEX_FILE"
fi

# Add link to index if not already present
if ! grep -q "${SLUG}" "$INDEX_FILE" 2>/dev/null; then
  echo "- [${SLUG}](Design-Docs/${SLUG})" >> "$INDEX_FILE"
fi

# Commit and push to wiki
cd "$WIKI_DIR"
git add .
git commit -m "docs: add/update design doc for ${SLUG}"
git push origin master || git push origin main
cd -

WIKI_URL="https://github.com/$(gh repo view --json nameWithOwner -q .nameWithOwner)/wiki/Design-Docs/${SLUG}"
```

### Step 3: Report completion

```bash
echo "═══════════════════════════════════════════════════════════"
echo "          DESIGN DOC PUBLISHED TO WIKI"
echo "═══════════════════════════════════════════════════════════"
echo ""
echo "📄 Local:  ${TASK_DESIGN_DOC}"
echo "📚 Wiki:   ${WIKI_URL}"
echo ""
echo "Share this link with reviewers for feedback."
echo "═══════════════════════════════════════════════════════════"
```
