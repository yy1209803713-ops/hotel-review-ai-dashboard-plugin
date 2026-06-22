# Feishu Auth Code + Base Token Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the `AppID / AppSecret` runtime path and make Feishu Base access use the custom plugin authorization code plus `Base Token` only.

**Architecture:** Backend reads a single Feishu Base authorization code from local/backend config and sends it as the bearer token for Base OpenAPI requests. The Feishu-specific HTTP logic will live in a reusable server-side client layer, and the dashboard UI will keep collecting `Backend Endpoint` and `Base Token`; the auth code stays server-side only. Tests and docs will be updated to match the new contract and to keep the config story explicit.

**Tech Stack:** TypeScript, Node `fetch`, Vitest, existing backend runtime modules, repo docs and `.env.example`.

---

### Task 1: Rewrite the Feishu OpenAPI runtime to use auth code bearer auth

**Files:**
- Create: `server/feishuBaseClient.ts`
- Create: `server/feishuBaseClient.test.ts`
- Modify: `server/larkOpenApiRuntime.ts`
- Modify: `server/reviewSourceRuntime.ts`
- Modify: `server/baseSummaryExporter.ts`
- Modify: `server/larkOpenApiRuntime.test.ts`
- Modify: `server/reviewSourceRuntime.test.ts`
- Modify: `server/baseSummaryExporter.test.ts`

- [ ] **Step 1: Write the failing test**

Add or update tests so the runtime expects a direct auth code and never calls the tenant-token exchange endpoint.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --run server/larkOpenApiRuntime.test.ts server/reviewSourceRuntime.test.ts server/baseSummaryExporter.test.ts`
Expected: fail because the implementation still expects `LARK_APP_ID / LARK_APP_SECRET` and tenant-token exchange.

- [ ] **Step 3: Write minimal implementation**

Change the runtime options to accept `authCode` instead of app credentials, send `Authorization: Bearer <authCode>` on every request, and remove the tenant-token cache / refresh flow.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- --run server/larkOpenApiRuntime.test.ts server/reviewSourceRuntime.test.ts server/baseSummaryExporter.test.ts`
Expected: pass with direct bearer auth.

- [ ] **Step 5: Commit**

```bash
git add server/larkOpenApiRuntime.ts server/reviewSourceRuntime.ts server/baseSummaryExporter.ts
git commit -m "feat: switch feishu runtime to auth code bearer"
```

### Task 2: Update env loading, tests, and error messages to the new config name

**Files:**
- Modify: `server/env.ts`
- Modify: `server/env.test.ts`
- Modify: `server/larkOpenApiRuntime.test.ts`
- Modify: `server/reviewSourceRuntime.test.ts`
- Modify: `server/baseSummaryExporter.test.ts`
- Modify: `src/App.test.tsx`

- [ ] **Step 1: Write the failing test**

Add coverage for a backend env key such as `LARK_BASE_AUTH_CODE` and update the export/runtime assertions so they mention auth code, not app credentials.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --run server/env.test.ts server/larkOpenApiRuntime.test.ts server/reviewSourceRuntime.test.ts server/baseSummaryExporter.test.ts src/App.test.tsx`
Expected: fail until the new env name and error text are implemented.

- [ ] **Step 3: Write minimal implementation**

Teach the env loader and the factories to look for `LARK_BASE_AUTH_CODE`, keep it server-side, and update user-facing error text to say the auth code is missing.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- --run server/env.test.ts server/larkOpenApiRuntime.test.ts server/reviewSourceRuntime.test.ts server/baseSummaryExporter.test.ts src/App.test.tsx`
Expected: pass with the new env key and updated messages.

- [ ] **Step 5: Commit**

```bash
git add server/env.ts server/env.test.ts server/larkOpenApiRuntime.test.ts server/reviewSourceRuntime.test.ts server/baseSummaryExporter.test.ts src/App.test.tsx
git commit -m "test: cover feishu auth code config"
```

### Task 3: Update docs and sample config for the auth-code flow

**Files:**
- Modify: `.env.example`
- Modify: `docs/local-config-and-feishu-setup.md`
- Modify: `docs/current-status.md`
- Modify: `docs/ai-cache-warmup-workflow.md`

- [ ] **Step 1: Write the failing test**

No code test here; instead, update the docs to explicitly show `.env.local` with `LARK_BASE_AUTH_CODE` and explain that `Base Token` comes from the `/base/<token>` URL.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --run` only after the docs text is updated in the repo and the code changes are in place.

- [ ] **Step 3: Write minimal implementation**

Replace every `LARK_APP_ID / LARK_APP_SECRET` setup example with the auth-code flow, and keep the UI explanation limited to `Backend Endpoint` plus `Base Token`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- --run`
Run: `npm run build`
Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add .env.example docs/local-config-and-feishu-setup.md docs/current-status.md docs/ai-cache-warmup-workflow.md
git commit -m "docs: switch feishu setup to auth code"
```

### Task 4: Final verification and branch handoff

**Files:**
- None

- [ ] **Step 1: Run the full test suite**

Run: `npm test -- --run`

- [ ] **Step 2: Run the production build**

Run: `npm run build`

- [ ] **Step 3: Review the final diff**

Run: `git status --short` and `git log --oneline -5`

- [ ] **Step 4: Commit or hand off**

If any last-minute cleanup is needed, make a final commit before handing the branch back.
