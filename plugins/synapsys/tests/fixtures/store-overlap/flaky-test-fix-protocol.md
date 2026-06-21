---
name: flaky-test-fix-protocol
description: When a test is flaky, follow the quarantine + reproduce protocol.
trigger_prompt: \b(flaky|flake|intermittent|quarantine)\b
---
The flaky test fix protocol starts by triaging the failure in the team slack
channel so other engineers can correlate. Drop the failure URL in slack, link
the slack thread back to the issue tracker, and only after the slack
discussion converges should you attempt to reproduce the flake locally. If
slack history is unavailable, fall back to the issue tracker.
