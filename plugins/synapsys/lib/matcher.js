'use strict';

function safeRegex(pattern) {
  try {
    return new RegExp(pattern, 'i');
  } catch {
    return null;
  }
}

function matchPrompt(memory, prompt) {
  if (!memory.events.includes('UserPromptSubmit')) return false;
  if (!memory.triggerPrompt) return false;
  const re = safeRegex(memory.triggerPrompt);
  if (!re) return false;
  return re.test(prompt || '');
}

function parsePretoolSpec(spec) {
  const colon = spec.indexOf(':');
  if (colon === -1) return { tool: spec, pat: '' };
  return {
    tool: spec.slice(0, colon).trim(),
    pat: spec.slice(colon + 1).trim(),
  };
}

function pretoolSpecMatches(spec, toolName, argBlob) {
  const { tool, pat } = parsePretoolSpec(spec);
  if (tool && tool !== '*' && tool !== toolName) return false;
  if (!pat) return true;
  const re = safeRegex(pat);
  return re ? re.test(argBlob) : false;
}

function matchPreTool(memory, payload) {
  if (!memory.events.includes('PreToolUse')) return false;
  if (!memory.triggerPretool.length) return false;
  const toolName = payload?.tool_name || '';
  const argBlob = JSON.stringify(payload?.tool_input || {});
  return memory.triggerPretool.some((spec) => pretoolSpecMatches(spec, toolName, argBlob));
}

function matchSession(memory) {
  if (!memory.events.includes('SessionStart')) return false;
  return memory.triggerSession === true;
}

// Stop event fires at the assistant's turn end. The classifier matrix assigns
// Stop to memories that are retrospective checks ("did I run follow-up-pr?",
// "cleanup the tmp file"). They fire unconditionally for any memory listing
// Stop in events — the body itself IS the reminder, no separate trigger.
function matchStop(memory) {
  return memory.events.includes('Stop');
}

function selectForEvent(memories, event, payload) {
  const matched = [];
  for (const m of memories) {
    let hit = false;
    if (event === 'UserPromptSubmit') hit = matchPrompt(m, payload?.prompt || '');
    else if (event === 'PreToolUse') hit = matchPreTool(m, payload);
    else if (event === 'SessionStart') hit = matchSession(m);
    else if (event === 'Stop') hit = matchStop(m);
    if (hit) matched.push(m);
  }
  return matched;
}

module.exports = { selectForEvent, matchPrompt, matchPreTool, matchSession, matchStop };
