---
name: smoke-test
description: Run TLM end-to-end against local mock providers to see real routing, fallback, streaming, hot reload and logs. Use after changing request handling, logging or reload behavior, or when the user asks to try it out.
---

# Smoke test TLM locally

Everything this skill creates (mock servers, configs, logs) goes in a **temporary directory outside
the repository** (the session scratchpad or the OS temp directory). Never add these files to the repo.

## Steps

1. `npm run build`.
2. In the temp dir, write `mock.mjs`: a `node:http` server that
   - listens on one port and always returns `503` (a "down" provider), and
   - listens on another port and returns a chat completion, or SSE chunks ending in `data: [DONE]`
     when `stream: true`.
3. In the temp dir, write `config.yaml` with `logging: { level: debug, pretty: true }`, two providers
   pointing at the mock ports (`baseUrl: http://127.0.0.1:<port>/v1`), and a `priority` route that
   lists the failing provider first.
4. Start both processes in the background:
   `node <tmp>/mock.mjs &` and `node dist/index.js --config <tmp>/config.yaml > <tmp>/tlm.log 2>&1 &`.
5. Exercise the service on port 30000:
   - `POST /v1/chat/completions` without and with `"stream": true`. Expect `x-tlm-attempts: 2` and a
     warning in the log about the fallback.
   - An unknown model. Expect `404` with `model_not_found`.
   - Append a route to the temp config, then `GET /v1/models`. The new route should appear (hot reload).
   - Append an invalid key. The log should show "configuration change rejected", and `/health` should
     keep the previous generation.
6. Stop both processes and read `<tmp>/tlm.log`. Report anything unexpected to the user.
7. Confirm `git status` shows no new untracked files from the smoke test.
