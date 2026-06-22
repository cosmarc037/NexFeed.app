---
name: Closure-to-factory free-variable capture
description: When extracting a closure-heavy function into a deps-injected factory module, capture EVERY free variable, not just the obvious helpers.
---

When moving a large in-component function (closes over component scope) into a
standalone factory module that receives its dependencies via an injected `deps`
object, the obvious helper functions are easy to spot — but rarely-hit code paths
reference other component-scope variables that are easy to miss.

**Why:** A missed free variable does NOT fail at parse time or on import. esbuild/
Vite treat an undeclared identifier as a (possibly global) free var, so the module
loads fine and HMR shows no error. It throws a `ReferenceError` only when that
specific branch executes at runtime — which may be a niche path (e.g. powermix
generated-order handling) you don't exercise during a quick smoke test.

**How to apply:** After extraction, grep the new module for bare identifiers that
are NOT declared inside it and NOT in the `deps` destructure. Watch especially for
data/state captured from the original scope (lookup tables, query results) rather
than pure helpers. Verify by actually running the path, not just parsing. Example
gap: the plant combine/place factory referenced `pmxSplitRules` (a React Query
result) which wasn't in the deps list; it had to be added to both the factory
destructure and every call site.
