# 酒店评论 AI 仪表盘插件当前状态

## 2026-06-24 后端拥有的 Postgres analysis store / read model 验证

本次任务按 `docs/superpowers/plans/2026-06-23-backend-owned-analysis-postgres-persistence.md` 的 B 路径推进：后端数据库成为 `analysis_configs`、`analysis_jobs`、`analysis_results`、topic evidence、`review_records`、`review_source_versions` 和 `sync_jobs` 的事实源。

已验证命令：

```bash
DATABASE_URL=postgresql://hotel_review_ai:hotel_review_ai_dev@127.0.0.1:5432/hotel_review_ai npm test -- --run server/postgresAnalysisStore.test.ts server/reviewSync.test.ts server/analysisWorker.test.ts src/App.test.tsx server/analysisPreflightSync.test.ts server/indexPostgresWiring.test.ts src/services/backendAnalysisClient.test.ts server/backendAnalysis.test.ts server/backendOwnedMigration.test.ts --exclude '.worktrees/**'
DATABASE_URL=postgresql://hotel_review_ai:hotel_review_ai_dev@127.0.0.1:5432/hotel_review_ai npm test -- --run --exclude '.worktrees/**'
npm run build
docker compose up -d postgres
docker compose exec -T postgres psql -U hotel_review_ai -d hotel_review_ai -f /dev/stdin < server/migrations/001_backend_owned_analysis.sql
DATABASE_URL=postgresql://hotel_review_ai:hotel_review_ai_dev@127.0.0.1:5432/hotel_review_ai WARMUP_PORT=8798 npm run server
```

结果：

- 上述 focused suite 覆盖 Postgres analysis store、review sync、analysis worker、View restore、preflight sync、server wiring、backend client、backend service 和 migration replay；本次运行结果是 9 个测试文件、109 个测试通过。
- 完整 `npm test -- --run --exclude '.worktrees/**'` 通过，47 个测试文件、317 个测试通过。
- `npm run build` 通过，只有既有的 Sass deprecation 和 chunk size warning。
- 本地 Postgres/HTTP smoke 验证 `/api/hotel-review-ai/results/latest` 可以读到手工 seed 的 persisted result，并返回 `configVersion: 3`、`sourceVersion.kind: "postgres"`、`summary.overview.totalReviews: 2`。
- `POST /api/hotel-review-ai/sync/feishu/record-changed` 的本地 smoke 之前曾在旧数据库 schema 上碰到 `sync_jobs.base_token` 缺列；当前迁移已补齐这组旧表列和状态约束，重放迁移后可以继续 smoke。
- sync smoke 返回 `202 Accepted` 只代表 receiver/enqueue/DB write 成功；本地 async worker 后续仍可能因为真实 Base app 凭据或 source 配置不足而出现 Feishu OpenAPI `400`，需要单独处理。

当前结论：

- `server/index.ts` 当前使用 `createPostgresAnalysisBackendStore(postgresPool)`，不再接 `createInMemoryAnalysisBackendStore()`；缺少 `DATABASE_URL` 时启动失败，不做内存兜底。
- 插件前端保存后端分析配置时上送 `source.kind: "postgres"`，保留 `upstreamSourceKind: "feishu_base"`、Base token/table/view/field mapping。
- `AnalysisBackendService.createOrGetAnalysisJob()` 会在 postgres config 下先跑 `analysis_preflight` sync，再用 `PostgresReviewSource` 解析 scope。
- View restore 仍要优先读后端 latest result，再异步补 host data 和过滤项，避免慢读挡住首屏。
- 还没有在真实飞书 Base 授权链路上完整跑一遍全量同步 + AI 分析 + 发布结果；本地验证覆盖的是 Postgres-backed 存取、迁移、server wiring 和 HTTP latest result 读路径。

## V1.2 AI Cache Warmup 更新

更新时间：2026-06-17

本次按 `docs/superpowers/specs/2026-06-17-ai-cache-warmup-design.md` 增加插件侧缓存预热能力：

- 新增 `warmupAnalysisCache()` 服务契约，用于复用证据缓存和主题映射缓存的 hit/miss 预热逻辑。
- 新增 warmup API client，插件配置支持 `warmup.endpointUrl` 和 `warmup.secret`。
- 配置面板新增 `缓存预热` 区域，提供 `初始化缓存` 和 `立即预热` 两个按钮。
- Dashboard 内容区新增 `缓存预热状态`，展示证据缓存覆盖、待补评论、主题映射覆盖、上次状态和错误 stage/message。
- 定时预热仍由飞书 Workflow 或外部调度调用后端接口，Dashboard 插件前端不承载 cron。
- 仓库根目录支持 `.env.local`，可本地填写 `LARK_BASE_AUTH_CODE`、`WARMUP_SECRET` 和 `VITE_BACKEND_ENDPOINT_URL`；其中 `LARK_BASE_AUTH_CODE` 只给后端进程使用，`VITE_BACKEND_ENDPOINT_URL` 只用于前端默认填充 `Backend Endpoint`。

后端边界：

- 当前仓库没有后端 API 宿主。
- 当前实现已准备 `POST /api/hotel-review-ai/warmup` 的请求/响应契约和插件触发入口。
- 真正的 Base 读写、AI API 密钥、Workflow 调度和 job log 由后端部署层承接。

## 本地配置约定

仓库根目录支持 `.env.local`，本地可填写：

- `LARK_BASE_AUTH_CODE`
- `WARMUP_SECRET`
- `VITE_BACKEND_ENDPOINT_URL`

其中 `LARK_BASE_AUTH_CODE` 只给后端进程使用，`VITE_BACKEND_ENDPOINT_URL` 只用于前端默认填充 `Backend Endpoint`。

Workflow 配置说明见：

```text
docs/ai-cache-warmup-workflow.md
```

最终验证：

```bash
npm test -- --run
npm run build
```

结果：21 个测试文件、161 个测试通过；构建通过。Vite 仍提示既有 Sass deprecation 和 chunk size warning，不影响本次 warmup 插件侧改造。

## V1.2 更新

更新时间：2026-06-15

当前目录：

```bash
/Users/yxk/Documents/Codex/2026-06-03/spec-users-yxk-documents-codex-2026-2/work/hotel-review-ai-dashboard-plugin-v1.2
```

V1.2 将分析链路从 `topic -> recordIds` 调整为 `record -> quote evidence -> topic`：

- AI 批处理只抽取 `evidenceItems`，每条证据包含 `recordId`、`quote`、`sentiment`、`aspectLabel`。
- 程序校验 `recordId` 必须存在，`quote` 必须能在评论正文 `content` 中命中。
- 全局主题归并阶段返回 `groups`，明确拆分 `category`、`mergeKey`、`displayTopic`，并在成员级别返回 `acceptedQuotes`，同一 `aspectLabel` 里混入的无关 quote 会被剔除，避免“雪花酥”这类证据挂到“地理位置”主题。
- 评论可以贡献多个证据；同一条评论既有好评也有负面细节时，会同时计入好评主题和风险主题，并进入 `mixedReviews`。
- 主题命中数由程序按去重后的 `commentRecordIds` 重算，不再相信 AI 返回的 count。
- 写回 `AI主题汇总` 时新增 `证据片段 JSON`，方便追溯主题证据。

已验证：

```bash
npm test -- --run
npm run build
```

结果：16 个测试文件、117 个测试通过；构建通过。Vite 仍提示既有 Sass deprecation 和 chunk size warning，不影响本次 Dashboard 插件合规验证。

## Dashboard Plugin UI Verification

- `?state=Create`: desktop 与 390px viewport 下 config layout 无横向溢出，保存操作可见。
- `?state=Config`: grouped config panel renders and save action is visible；desktop 与 390px viewport 均无横向溢出。
- `?state=View`: config panel is hidden.
- `?state=FullScreen`: transparent/dark background is applied and content does not overlap.

---

更新时间：2026-06-11

当前版本：V1.0

## 项目路径

```bash
/Users/yxk/Documents/Codex/2026-06-03/spec-users-yxk-documents-codex-2026-2/work/hotel-review-ai-dashboard-plugin
```

## 启动方式

推荐先用已构建的 `dist` 静态产物预览：

```bash
cd /Users/yxk/Documents/Codex/2026-06-03/spec-users-yxk-documents-codex-2026-2/work/hotel-review-ai-dashboard-plugin
python3 -m http.server 5173 --bind 127.0.0.1 --directory dist
```

访问：

```text
http://localhost:5173/?state=Config
```

如果要重新构建：

```bash
cd /Users/yxk/Documents/Codex/2026-06-03/spec-users-yxk-documents-codex-2026-2/work/hotel-review-ai-dashboard-plugin
npm test -- --run
npm run build
python3 -m http.server 5173 --bind 127.0.0.1 --directory dist
```

如果 5173 被占用，换一个端口，例如：

```bash
python3 -m http.server 5174 --bind 127.0.0.1 --directory dist
```

然后访问：

```text
http://localhost:5174/?state=Config
```

## 当前数据源

本地 standalone 模式已经从旧 fixture 切到 CSV：

```text
public/hotel_xx_comments_25_merged_with_names.csv
dist/hotel_xx_comments_25_merged_with_names.csv
```

CSV 来源文件：

```text
/Users/yxk/Downloads/hotel_xx_comments_25_merged_with_names.csv
```

本地 runtime 请求路径：

```text
/hotel_xx_comments_25_merged_with_names.csv
```

已解析字段：

- `评论ID` -> `reviewId`
- `评论内容` -> `content`
- `酒店名称` -> `hotelName`
- `评分` -> `score`
- `评论日期` -> `reviewDate`
- `入住日期` -> `checkInMonth`
- `酒店回复内容` -> `replyContent`
- `房型` -> `roomType`

CSV 解析支持带引号、多行评论正文和转义双引号。加载或解析失败时会直接报错，不回退到旧 fixture。

## 数据规模

CSV 解析结果：

- 总记录：6070 条
- 非空评论：6070 条
- `评论日期` 分布：
  - 2026-04：2832 条
  - 2026-05：3184 条
  - 2026-06：54 条

当前日期按 2026-06-11 计算时，“本月”筛选范围是：

```text
2026-06-01 到 2026-06-30
```

因此“本月 + 全部酒店 + 全部入住月份”应读取 54 条评论。

## 关键实现文件

- `src/services/csvRecords.ts`：CSV parser 和字段映射。
- `src/runtime/sdk.ts`：standalone runtime 从 CSV 读取本地记录。
- `src/services/aiClient.ts`：AI API 请求、超时、JSON/schema 校验。
- `src/services/analysisPipeline.ts`：按批次聚合分析，失败时带第几批上下文。
- `src/constants/defaults.ts`：默认筛选与 AI 配置。
- `src/components/ConfigPanel.tsx`：配置面板。

## 当前 AI 配置行为

- `测试连接` 使用小请求，已在浏览器验证成功。
- 真实分析请求没有兜底。模型未返回、JSON 不合法、schema 不合法、网络失败都会直接展示错误。
- 分析超时为 180 秒。
- 默认 `maxBatchSize` 已降到 10。
- 已新增 `batchConcurrency` 配置，右侧配置面板显示为“并发数”，范围 1 到 20，默认 3。
- AI 批次现在按配置并发执行，不再固定串行。任一批失败时仍直接报错，错误会包含第几批和该批评论数。
- 写回未确认时仍保持原有行为：提示 `写回创建尚未确认，已仅保存插件缓存`。

## 已验证结果

最近一次验证：

```bash
npm test -- --run
```

结果：10 个测试文件通过，44 个测试通过。当前沙箱会拒绝 Vitest WebSocket 端口绑定并打印 `listen EPERM 0.0.0.0:24678`，但测试进程退出码为 0，测试本体通过。

```bash
npm run build
```

结果：构建通过。Vite 仍有 chunk size warning，不影响本地运行。

浏览器验证：

- 新 bundle 已加载。
- CSV 文件请求成功。
- API URL 和 API Key 在浏览器配置里保持已填写状态。
- `测试连接` 成功，模型显示为 `gpt-5.4`。
- 点击“更新分析”时，页面按本月 CSV 数据拆成 6 批，说明 54 条数据已进入分析流程。
- 2026-06-11 已构建并发配置版本，最新 bundle 为 `dist/assets/index-Dmg9-yK-.js`。

## 当前阻塞点

真实分析请求在浏览器直连 API 阶段失败。

最近一次页面错误：

```text
第 1/6 批 AI 分析失败（10 条评论）：AI API 网络请求失败：Failed to fetch
```

这说明：

- 数据源切换已生效。
- 筛选范围不是旧 fixture 的 2 条。
- API Key / API Base URL 对小请求可用。
- 长分析请求在浏览器 `fetch` 层失败，尚未拿到模型 JSON，因此没有生成新缓存。

页面上仍显示“总评论 2”是旧分析缓存，不是当前 CSV 分析结果。

## 建议下一步

优先先试右侧“并发数”配置，例如 5、10、20，确认当前 API 通道能承受的并发上限；如果仍失败，再把 AI 调用迁到后端代理，或者换一个对浏览器长请求更稳定的 OpenAI-compatible API 通道。

原因：

- 浏览器直连此前无法稳定完成第一批 10 条评论的真实分析。
- 小请求成功只能证明 key、URL、模型基本可用，不能证明长请求稳定。
- 当前实现已经避免兜底，问题会直接暴露为批次级错误。

如果继续在前端直连调试，建议临时把筛选范围缩到更小，例如自定义日期只选 1 天，验证单批 1 到 3 条是否能完整返回 JSON。
