/**
 * Brief-gate step enrichment.
 *
 * Overrides the brief_gate prompt with structured step-by-step instructions:
 * 1. Solve local questions (AI investigates codebase)
 * 2. Ask user remaining questions (AskUserQuestion)
 * 3. Apply resolutions via applyBriefResolutions()
 */

'use strict';

module.exports = function registerBriefGate(register) {
  register('brief_gate', (entry, ctx) => {
    if (!entry.askUserQuestionPayload) return;

    const { tasksDir, workDir, path } = ctx;
    const questions = entry.askUserQuestionPayload.questions || [];
    if (questions.length === 0) return;

    const localQs = questions.filter((q) => q.scope === 'local');
    const userQs = questions.filter((q) => q.scope !== 'local');
    const briefGatePath = path.join(workDir, 'steps', 'brief-gate.js');
    const briefPath = path.join(tasksDir, 'brief.md');

    const lines = ['## brief_gate: Resolve Open Questions\n'];
    lines.push(`Brief file: ${briefPath}`);
    lines.push(`Total blocking questions: ${questions.length}\n`);

    if (localQs.length > 0 && userQs.length === 0) {
      // Only local questions — these don't block the gate. They'll be resolved
      // during spec phase when the AI investigates the codebase in depth.
      lines.push('### LOCAL questions (non-blocking — resolved during spec phase)\n');
      lines.push(
        'These questions will be answered by the spec-writer agent when it analyzes the codebase.'
      );
      lines.push('No action needed here — the gate will pass automatically.\n');
      localQs.forEach((q, i) => {
        lines.push(`${i + 1}. "${q.questionText}" → deferred to spec`);
      });
      lines.push('');
    } else if (localQs.length > 0) {
      lines.push('### LOCAL questions (investigate codebase yourself before asking user)\n');
      localQs.forEach((q, i) => {
        lines.push(`${i + 1}. "${q.questionText}"`);
        if (q.rationale) lines.push(`   Rationale: ${q.rationale}`);
      });
      lines.push('');
    }

    if (userQs.length > 0) {
      lines.push(
        `### Step ${localQs.length > 0 ? '2' : '1'}: Ask USER these questions (use AskUserQuestion)\n`
      );
      userQs.forEach((q, i) => {
        lines.push(`${i + 1}. "${q.questionText}"`);
        if (q.rationale) lines.push(`   Rationale: ${q.rationale}`);
      });
      lines.push('');
    }

    lines.push(
      `### Step ${localQs.length > 0 && userQs.length > 0 ? '3' : '2'}: Apply resolutions\n`
    );
    lines.push('Run this command with your answers (JSON map of questionText → answer):');
    lines.push('```bash');
    lines.push(
      `node -e "require('${briefGatePath}').applyBriefResolutions('${briefPath}', JSON.parse(process.argv[1]))" '<JSON_RESOLUTIONS>'`
    );
    lines.push('```');
    lines.push('');
    lines.push('Example:');
    lines.push('```bash');
    const example = {};
    example[questions[0].questionText] = 'Your answer here';
    lines.push(
      `node -e "require('${briefGatePath}').applyBriefResolutions('${briefPath}', JSON.parse(process.argv[1]))" '${JSON.stringify(example)}'`
    );
    lines.push('```');
    lines.push(
      '\nIMPORTANT: Do NOT edit brief.md directly. Only applyBriefResolutions can modify it during brief_gate.'
    );

    entry.agentPrompt = lines.join('\n');
  });
};
