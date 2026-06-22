---
name: Bash background-process measurement gotcha
description: Why background curls/timers in the bash tool give false "endpoint hangs" readings.
---

# Don't measure long requests with backgrounded bash processes

A backgrounded process started inside a `bash` tool call (e.g.
`curl ... & echo done > /tmp/flag`) is reaped when that tool call returns — the
sandbox kills child processes at the end of each invocation. So a flag file that
should be written on completion never gets written, and a perfectly healthy
long-running endpoint looks like it hung for "4+ minutes."

Also: `/tmp/logs/*.log` are point-in-time snapshots refreshed only by
`refresh_all_logs`, not live tails — don't poll them expecting streaming output.

**How to measure a long (tens-of-seconds) request reliably:** use the persistent
`code_execution` sandbox and hold the `fetch` across the call (state persists
notebook-style), or run a single foreground request within one bash call's
timeout. That is how the ~44s trace run was decisively confirmed.
