#!/usr/bin/env node
/**
 * Stop hook: Validate pr-reviewer output consistency
 * (Only runs in pr-reviewer context - no detection needed)
 * Blocks if review contains "Critical Issues" but recommends "APPROVE"
 */

function extractTextContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('\n');
  }
  return '';
}

function hasCriticalIssuesContent(text) {
  const sectionRegex = /##\s*Critical\s*Issues[^\n]*\n+([\s\S]*?)(?=##|$)/i;
  const match = text.match(sectionRegex);

  if (!match) {
    const hasInlineMention = /(?:critical|blocking)\s+(?:issue|problem|bug)/i.test(text);
    const isNegation = /\b(no|without|zero|0)\s+(?:critical|blocking)\s+(?:issue|problem|bug)/i.test(text);
    return hasInlineMention && !isNegation;
  }

  const sectionContent = match[1].trim();
  if (sectionContent.length < 10) return false;
  if (/^(none|n\/a|no critical issues?|-)$/i.test(sectionContent)) return false;
  return true;
}

function hasApproveRecommendation(text) {
  return /✅\s*APPROVE/i.test(text) ||
         /Final\s*Recommendation[:\s]*.*APPROVE/i.test(text);
}

function hasRequestChangesRecommendation(text) {
  return /❌\s*REQUEST[_\s]?CHANGES/i.test(text) ||
         /Final\s*Recommendation[:\s]*.*REQUEST[_\s]?CHANGES/i.test(text);
}

async function main() {
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
  }

  const hookData = JSON.parse(input);
  const agentOutput = extractTextContent(
    hookData.agent_output || hookData.response || hookData.result || ''
  );

  if (!agentOutput || agentOutput.length < 100) {
    process.exit(0);
  }

  const hasCritical = hasCriticalIssuesContent(agentOutput);
  const hasApprove = hasApproveRecommendation(agentOutput);
  const hasRequestChanges = hasRequestChangesRecommendation(agentOutput);

  if (hasCritical && hasApprove && !hasRequestChanges) {
    process.stderr.write(`🛑 PR-REVIEWER: Listed "Critical Issues" but recommended "APPROVE"

Either:
1. Change to "❌ REQUEST_CHANGES" if issues are blocking
2. Recategorize as "Suggestions" if not blocking
`);
    process.exit(2);
  }

  process.exit(0);
}

main().catch(() => {
  process.exit(0);
});
