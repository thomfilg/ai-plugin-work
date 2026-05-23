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

function matchPreTool(memory, payload) {
  if (!memory.events.includes('PreToolUse')) return false;
  if (!memory.triggerPretool.length) return false;
  const toolName = payload?.tool_name || '';
  const blob = JSON.stringify(payload?.tool_input || {});
  for (const spec of memory.triggerPretool) {
    const colon = spec.indexOf(':');
    let tool, pat;
    if (colon === -1) {
      tool = spec;
      pat = '';
    } else {
      tool = spec.slice(0, colon).trim();
      pat = spec.slice(colon + 1).trim();
    }
    if (tool && tool !== '*' && tool !== toolName) continue;
    if (!pat) return true;
    const re = safeRegex(pat);
    if (re && re.test(blob)) return true;
  }
  return false;
}

function matchSession(memory) {
  if (!memory.events.includes('SessionStart')) return false;
  return memory.triggerSession === true;
}

function selectForEvent(memories, event, payload) {
  const matched = [];
  for (const m of memories) {
    let hit = false;
    if (event === 'UserPromptSubmit') hit = matchPrompt(m, payload?.prompt || '');
    else if (event === 'PreToolUse') hit = matchPreTool(m, payload);
    else if (event === 'SessionStart') hit = matchSession(m);
    if (hit) matched.push(m);
  }
  return matched;
}

module.exports = { selectForEvent, matchPrompt, matchPreTool, matchSession };
