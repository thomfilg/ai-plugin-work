#!/usr/bin/env bash
# Shared provider-prefix resolver, sourced by maestro-conduct.sh and
# maestro-bootstrap.sh so the two can never derive a different prefix for the
# same repository.
#
# Derive the session-name / ticket prefix from the ticket provider
# (ticket-provider.js) instead of hardcoding "GH". Fail-open: any node/module
# failure, an empty projectKey (github / unconfigured), or a value that fails
# the strict ^[A-Z][A-Z0-9]*$ validation all fall back to "GH" — never an empty
# prefix. Sets the global PREFIX. Always exits 0 (never hard-errors the caller).
resolve_prefix() {
  local script_dir provider_js raw
  script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  # This lib lives in plugins/maestro/scripts/lib/, so the work plugin is three
  # levels up (../../../work) — one deeper than the calling scripts.
  provider_js="$script_dir/../../../work/scripts/workflows/lib/ticket-provider.js"

  # Shell out to node to read the provider's projectKey, mirroring
  # config.js safeTicketId (getProviderConfig({ skipPrompt: true })). Any
  # failure is swallowed (2>/dev/null) so the caller never hard-errors.
  raw="$(node -e '
    try {
      const tp = require(process.argv[1]);
      const cfg = tp.getProviderConfig({ skipPrompt: true });
      process.stdout.write((cfg && cfg.projectKey) ? String(cfg.projectKey) : "");
    } catch (_) {
      process.stdout.write("");
    }
  ' "$provider_js" 2>/dev/null)" || raw=""

  # Validate: strict uppercase key only; anything else (empty, github,
  # unconfigured, malformed/injected) falls back to GH.
  if [[ "$raw" =~ ^[A-Z][A-Z0-9]*$ ]]; then
    PREFIX="$raw"
  else
    PREFIX="GH"
  fi
}
