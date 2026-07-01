# Topic Mapping Cache Quote Filter Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修正主题映射缓存把旧原句当成长期白名单的问题，让主题排行和下钻证据覆盖完整评论。

**Architecture:** 保留“证据缓存”和“主题映射缓存”两层缓存。主题映射缓存只作为“小标签归到哪个大主题”的稳定映射，不再用旧批次的原句拦截后续同标签证据。修复后必须重新发布飞书全栈应用，并用线上正式环境分日期 warmup 验证。

**Tech Stack:** TypeScript, Vitest, Vite, Node HTTP server, Postgres-backed Miaoda full-stack app, lark-cli apps release/db tools.

## Global Constraints

- 默认回复和任务记录使用简体中文，技术名词和路径保留原文。
- 不擅自使用兜底方案；问题必须暴露并修正根因。
- 本项目是飞书多维表格仪表盘插件项目；不得改 `@lark-base-open/js-sdk`、Vite 插件配置或插件运行入口。
- 常规改动后至少运行 `npm run build`；核心逻辑改动同时运行 `npm test`。
- 飞书线上全栈应用可用于验证；线上数据库查询走 `lark-cli apps +db-execute --env online`，不裸连数据库。
- 大范围 warmup 必须按单日请求；失败同日重试一次，第二次失败停止。

---

## 已知线上证据

- [x] 线上 app-scoped API 可用路径：`https://z11gk8nt38x.aiforce.cloud/app/app_178y1bawrh0/public-api/hotel-review-ai/...`。
- [x] `2026-06-01` 到 `2026-07-01` 线上结果 `totalReviews=2939`，但好评 Top1 只有 `15`。
- [x] 同一结果内 `overview.positiveReviews=2550`、`overview.negativeOrRiskReviews=356`。
- [x] 同一结果内 10 个好评主题只覆盖 `60` 个 distinct record，10 个风险主题只覆盖 `21` 个 distinct record。
- [x] 当前 6.1-7.1 范围可从 evidence cache 读到约 `6983` 条证据、`2691` 条有证据记录、`2023` 个候选标签。
- [x] 现有 `topic_mapping_cache.mapping_json.acceptedQuotes` 会把大量同标签新证据过滤掉，属于根因路径。

## 文件边界

- Modify: `src/services/analysisPipeline.ts`
  - 负责把已抽取证据、主题映射、主题摘要合成最终结果。
- Modify: `server/postgresAnalysisCache.ts`
  - 负责读写 Postgres 中的 evidence cache 和 topic mapping cache。
- Modify: `src/services/analysisPipeline.test.ts`
  - 增加缓存命中时不应丢弃同标签新证据的回归测试。
- Modify: `server/postgresAnalysisCache.test.ts`
  - 增加 Postgres topic mapping cache 读取时不应把旧 `acceptedQuotes` 带回长期过滤的回归测试。
- Modify: `docs/superpowers/plans/2026-07-01-topic-mapping-cache-quote-filter-fix.md`
  - 执行勾选和线上验证记录。

## Task 1: TDD 锁定问题

**Files:**
- Modify: `src/services/analysisPipeline.test.ts`
- Modify: `server/postgresAnalysisCache.test.ts`

**Interfaces:**
- Consumes: `runAnalysis`, `createPostgresAnalysisCacheRepository`
- Produces: 两个先失败后通过的回归测试

- [x] **Step 1: 写 `runAnalysis` 失败测试**
  - 场景：缓存映射来自旧批次，只包含旧原句；本次同标签有新原句。
  - 期望：只要小标签归到同一大主题，新原句也应计入主题和下钻证据。

- [x] **Step 2: 运行 focused test 观察失败**
  - Run: `npm test -- --run src/services/analysisPipeline.test.ts`
  - Expected: FAIL，主题计数仍被旧 `acceptedQuotes` 过滤。

- [x] **Step 3: 写 Postgres cache 失败测试**
  - 场景：DB 中 `mapping_json.acceptedQuotes` 只有旧原句，本次 candidate 有新原句。
  - 期望：读出的 `mapping.acceptedQuotes` 不再限制当前 candidate。

- [x] **Step 4: 运行 focused test 观察失败**
  - Run: `DATABASE_URL=postgresql://hotel_review_ai:hotel_review_ai_dev@127.0.0.1:5432/hotel_review_ai npm test -- --run server/postgresAnalysisCache.test.ts`
  - Expected: FAIL，读出的 mapping 仍带有旧 `acceptedQuotes`。

## Task 2: 最小实现修复缓存口径

**Files:**
- Modify: `src/services/analysisPipeline.ts`
- Modify: `server/postgresAnalysisCache.ts`

**Interfaces:**
- Consumes: `SourceTopicMapping.acceptedQuotes`, `TopicMergeMember.acceptedQuotes`
- Produces: 缓存命中路径不再用旧原句过滤同标签新证据

- [x] **Step 1: 修改缓存命中组装逻辑**
  - 缓存命中生成 `TopicMergeGroup` 时，不再把 `mapping.acceptedQuotes` 放回成员用于长期过滤。

- [x] **Step 2: 修改 Postgres cache 读取逻辑**
  - 读 `topic_mapping_cache` 时，保留主题映射字段，但不把历史 `acceptedQuotes` 作为当前 mapping 的过滤条件返回。

- [x] **Step 3: 运行 focused tests**
  - Run: `npm test -- --run src/services/analysisPipeline.test.ts server/postgresAnalysisCache.test.ts`
  - Expected: PASS。

## Task 3: 回归验证

**Files:**
- Existing test suite and build config

- [x] **Step 1: 运行核心相关测试**
  - Run: `npm test -- --run src/services/analysisPipeline.test.ts server/formalAnalysisCacheRunner.test.ts server/postgresAnalysisCache.test.ts server/warmupJob.test.ts`

- [x] **Step 2: 运行完整测试**
  - Run: `npm test -- --run`

- [x] **Step 3: 构建**
  - Run: `npm run build`

## Task 4: 发布飞书全栈应用

**Files:**
- Git working tree
- Miaoda app `app_178y1bawrh0`

- [x] **Step 1: 检查 diff**
  - Run: `git diff --stat && git diff -- src/services/analysisPipeline.ts server/postgresAnalysisCache.ts src/services/analysisPipeline.test.ts server/postgresAnalysisCache.test.ts`

- [x] **Step 2: 提交并推送到发布分支**
  - Run: `git status --short`
  - Run: `git add ...`
  - Run: `git commit -m "fix: keep cached topic mappings from filtering new evidence"`
  - Run: `git push`

- [x] **Step 3: 创建 release 并轮询完成**
  - Run: `lark-cli apps +release-create --app-id app_178y1bawrh0`
  - Run: `lark-cli apps +release-get --app-id app_178y1bawrh0 --release-id <release_id>`
  - Expected: `status=finished`。

## Task 5: 线上 warmup 6.1-6.10

**Files:**
- Online app database
- Warmup endpoint

- [x] **Step 1: 按天请求 warmup**
  - Dates: `2026-06-01` through `2026-06-10`
  - Endpoint: `POST https://z11gk8nt38x.aiforce.cloud/app/app_178y1bawrh0/public-api/hotel-review-ai/warmup`
  - Payload: 每次 `startDate` 和 `endDate` 都等于当天。

- [x] **Step 2: 查库等待每个 warmup job 结束**
  - Run: `lark-cli apps +db-execute --app-id app_178y1bawrh0 --env online --sql "<warmup_jobs select>" --yes`
  - Expected: 每个日期 `status=success`，失败同日只重试一次。

## Task 6: 线上验证 6.1-6.10

**Files:**
- Online app API and database

- [x] **Step 1: 发起 6.1-6.10 分析**
  - 用线上 `/configs/upsert`、`/scopes/resolve`、`/analysis-jobs` 走真实后端分析流程。

- [x] **Step 2: 等待 analysis job 成功**
  - 查 `analysis_jobs`，等待 `status=success`。

- [x] **Step 3: 验证主题覆盖**
  - 读取 latest result。
  - 检查 `overview.positiveReviews` 与 Top 主题覆盖不再出现几十条级别的断崖。
  - 检查主题下钻 `analysis_topic_evidence` 行数和主题 count 对齐。

## Task 7: 线上 warmup 6.10-7.1 并最终复现

**Files:**
- Online app API and database

- [x] **Step 1: 按天请求 warmup**
  - Dates: `2026-06-10` through `2026-07-01`
  - 每天单独请求，单日失败重试一次。

- [x] **Step 2: 等待 warmup jobs 完成**
  - 查 `warmup_jobs`，确认 `status=success` 或记录失败日期。

- [x] **Step 3: 发起 6.1-7.1 最终分析**
  - 复现用户截图口径。

- [x] **Step 4: 验证最终结果**
  - 检查总评论接近 3000。
  - 检查 Top 主题数量恢复到合理量级。
  - 检查主题下钻证据数量与主题 count 一致。

## 执行记录

- [x] 文档创建完成。
- [x] `runAnalysis` 红灯已验证：旧 `acceptedQuotes` 导致同标签新证据被丢弃，`count` 从期望 `2` 变成当前 `1`。
- [x] Postgres cache 红灯已验证：旧 `acceptedQuotes` 被读成 `[]`，会让下游把当前同标签证据全部过滤掉。
- [x] Focused tests 转绿：`analysisPipeline` 25 passed；`postgresAnalysisCache` 4 passed。
- [x] 核心相关测试通过：`analysisPipeline`、`formalAnalysisCacheRunner`、`postgresAnalysisCache`、`warmupJob` 共 39 passed。
- [x] 完整测试通过：50 test files，373 tests passed。
- [x] 构建通过：`tsc && vite build` completed。
- [x] 本地 TDD 修复完成。
- [x] 本地测试和 build 完成。
- [x] 提交并推送：`9f0fd76 fix: keep cached topic mappings from filtering new evidence`，已推到 `codex/backend-owned-analysis-ingestion-spec` 和 `sprint/default`。
- [x] 妙搭实际发布仓库修复完成：`/Users/yxk/Documents/Codex/2026-06-03/spec-users-yxk-documents-codex-2026-2/work/hotel-review-ai-miaoda-fullstack` 提交 `8ff0c1f fix: keep cached topic mappings from filtering new evidence`，已推到妙搭 `sprint/default`。
- [x] 妙搭仓库验证通过：focused Jest 4 passed；完整 Jest 11 suites / 30 tests passed；`npm run build` passed。
- [x] 飞书全栈应用发布完成：release `7657406698252946610` finished，线上 commit `8ff0c1f582fac0a20e9cb6407d1af963238efcec`。
- [x] 6.1-6.10 warmup 完成：10 个单日 job 全部 `success`，总扫描 `910` 条；无重试。
- [x] 6.1-6.10 分析通过：result `c41d66c1-1fb9-432c-a2ec-16c23853c9ac`，`totalReviews=910`，`positiveReviews=787`，好评 Top1 `224` 条；证据下钻 API 对 `出行位置` 返回 `total=224`。
- [x] 6.1-6.10 线上验证通过。
- [x] 6.10-7.1 warmup 完成：22 个单日 job 全部 `success`；6.30 补建 `62` 条 evidence cache miss 和 `36` 个 topic mapping miss。
- [x] 6.1-7.1 最终复现通过：result `063073ed-227b-4c6d-937b-25d012379bc0`，`totalReviews=3010`，`positiveReviews=2610`，好评 Top1 `出行位置=741`；证据下钻 API 对 `出行位置` 返回 `total=741`。
