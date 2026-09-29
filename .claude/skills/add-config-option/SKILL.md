---
name: add-config-option
description: Add or change a TLM configuration option (server, logging, proxy, upstream, health, provider, route or target settings) and keep schema, example, docs and hot reload consistent.
---

# Add or change a configuration option

`src/config/schema.ts` is the single source of truth. Types are inferred from it, so do not declare
config interfaces by hand.

## Steps

1. **Schema.** Add the field to the right `z.strictObject` in `src/config/schema.ts`:
   - Give it a `.default(...)` unless it must be required or truly optional.
   - Add a short doc comment.
   - Nested objects use `.prefault({})` so inner defaults apply.
   - Wrap non-string fields with the `num()`, `bool()` or `list()` helpers, so they also accept
     values from `${VAR}` placeholders (which are always strings; an empty string means "use the
     default"). Add a case to the "environment variables in non-string settings" tests.
   - For overridable settings, follow the existing precedence: route, then provider, then global.
   - Cross-field rules go in the `superRefine` at the bottom.
2. **Use it.** Read it from the request's generation (`runtime.current.config` captured at the start
   of `proxyRequest`), not from a module-level variable. This keeps hot reload consistent.
3. **Hot reload.** Decide whether the option can change at runtime:
   - Most options take effect on the next request automatically.
   - If it is baked in at startup (server options, logger transport), add it to the
     `restartRequired` checks in `Runtime.apply` (`src/runtime.ts`).
   - If it affects connection pools (proxy, TLS), make sure `Dispatchers` in
     `src/upstream/dispatchers.ts` builds pools from it.
4. **Tests.** Cover defaults and validation in `test/config.test.ts`, and the behavior in the relevant
   suite. `config.example.yaml` is validated by a test, so keep it valid.
5. **Docs.**
   - Add a row to the right table in `docs/configuration.md` (type, default, notes, whether a restart
     is required).
   - Add it with a comment to `config.example.yaml`. Never include real secrets: use `${ENV_VAR}`.
   - Mention it in `README.md` if users need to know about it.
6. Run `npm run check`.

All code, comments and docs must be in English.
