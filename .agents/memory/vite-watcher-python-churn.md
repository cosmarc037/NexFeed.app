---
name: Vite watcher starved by Python/Jupyter files
description: Why installing Jupyter/Python can make Vite-SSR-dependent dev endpoints time out, and how to fix it.
---

# Vite file watcher churn from Python/Jupyter installs

Installing JupyterLab / Python packages drops thousands of files under
`.pythonlibs/` and `.cache/uv/`. Vite's dev `server.watch` will scan/watch these,
producing constant change events that starve the dev server. Any endpoint that
relies on `vite.ssrLoadModule` at request time (e.g. the dev-only
`/api/ai/auto-sequence/trace` route) then slows to the point of client timeouts.

**Symptom:** a request that should take ~45s (dominated by real Azure calls)
instead blows past a 180s client timeout, with no single slow stage server-side.

**Fix:** add `server.watch.ignored` in `vite.config.js` (note: this repo uses
`vite.config.js`, NOT `.ts`) excluding `**/.pythonlibs/**`, `**/.cache/**`,
`**/.local/**`, `**/__pycache__/**`, `**/.ipynb_checkpoints/**`, `**/*.ipynb`.
App source dirs stay watched, so HMR is unaffected. Also add the same patterns
to `.gitignore`.

**Why:** the trace endpoint's latency is real Azure per-line calls (~4–12s each,
~44s total), not pipeline logic — confirm by measuring stages; if every stage is
fast but the whole request hangs, suspect watcher/event-loop starvation, not the
handler.
