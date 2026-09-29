# TLM — Tiny LLM Router

OpenAI-compatible routing microservice (Node.js + TypeScript, Fastify, undici, pino, zod).
Read `docs/architecture.md` before making structural changes.

## Rules

1. **English only.** Code, identifiers, comments, log messages, error messages, tests, commit messages,
   docs and config examples must be written in English, even when the conversation is in another language.
2. **Stay small.** TLM only routes requests. Do not add features outside routing, fallbacks, health,
   proxying, configuration and logging (no caching, prompt management, UI, databases, client auth)
   unless the user explicitly asks.
3. **Never commit local configuration or secrets.** `config.yaml`, `.env` and similar files are
   git-ignored. Only `config.example.yaml` and `.env.example` are tracked, and they must never contain
   real keys. Reference secrets as `${ENV_VAR}`.
4. **No temporary files in the repo.** Scratch scripts, mock servers and logs go in a temp directory,
   not the working tree.
5. **The config schema is the source of truth.** When adding or changing an option, update
   `src/config/schema.ts`, `config.example.yaml`, `docs/configuration.md`, and the README if the change
   is user-facing.
6. **Pass bodies through.** Only read or modify the request fields routing needs (`model`, `stream`).
   Forward upstream responses unchanged.
7. **Log what routing does.** New routing behavior needs structured log lines (with `route`, `target`,
   `attempt` where relevant). Never log API keys. Bodies are logged only when `logging.logBodies` is on.
8. **Test behavior changes.** Use the mock upstreams and the forward proxy in `test/helpers.ts`.
   Never call real providers from tests.

## Commands

```bash
npm run dev         # run from source with auto-restart (needs ./config.yaml)
npm test            # vitest
npm run typecheck   # tsc --noEmit
npm run format      # prettier --write
npm run check       # typecheck + format check + tests; run before finishing any change
npm run build       # compile to dist/
```

## Conventions

- ESM with `.js` suffixes in relative imports (`NodeNext` resolution).
- `strict` + `noUncheckedIndexedAccess`: use `!` only when an invariant guarantees presence
  (for example, providers referenced by routes are validated by the schema).
- Errors returned to clients use the OpenAI error shape (`src/http/errors.ts`).
- Prefer small pure functions (strategies, proxy resolution) that can be unit-tested without a server.
