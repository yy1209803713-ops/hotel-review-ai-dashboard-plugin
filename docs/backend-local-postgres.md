# Backend Local Postgres

本地开发可以用仓库里的 `docker-compose.yml` 启一个 Postgres，用于验证 backend-owned analysis 的 Postgres 持久化、read-model 和 sync 路径。

当前后端启动必须提供 `DATABASE_URL`。`server/index.ts` 使用 `createPostgresAnalysisBackendStore(postgresPool)`、`createPostgresReviewSyncStore(postgresPool)` 和 `PostgresReviewSource`；没有内存 store 兜底。`analysis_configs`、`analysis_jobs`、`analysis_results`、`analysis_topic_evidence`、`review_records`、`review_source_versions` 和 `sync_jobs` 都由 Postgres 承接。

## 启动数据库

```bash
docker compose up -d postgres
```

默认连接信息：

```text
host=127.0.0.1
port=5432
database=hotel_review_ai
user=hotel_review_ai
password=hotel_review_ai_dev
```

如果本机 `5432` 已被占用，可以覆盖本地端口：

```bash
POSTGRES_PORT=15432 docker compose up -d postgres
```

此时 DSN 里的端口也要同步改成 `15432`。

DSN：

```text
postgresql://hotel_review_ai:hotel_review_ai_dev@127.0.0.1:5432/hotel_review_ai
```

如果本机已有一个旧数据库，直接重放当前迁移脚本即可补齐旧 `sync_jobs` 的缺列和状态约束。

## 执行 migration

```bash
psql "postgresql://hotel_review_ai:hotel_review_ai_dev@127.0.0.1:5432/hotel_review_ai" \
  -f server/migrations/001_backend_owned_analysis.sql
```

如果本机没有 `psql`，可以通过容器执行：

```bash
docker compose exec -T postgres psql -U hotel_review_ai -d hotel_review_ai \
  -f /dev/stdin < server/migrations/001_backend_owned_analysis.sql
```

## 启动后端

```bash
DATABASE_URL=postgresql://hotel_review_ai:hotel_review_ai_dev@127.0.0.1:5432/hotel_review_ai \
WARMUP_PORT=8797 \
npm run server
```

`WARMUP_PORT` 只是本地烟测端口，避免占用已有的 `8787`。

如果缺少 `DATABASE_URL`，后端会在启动时直接抛出 `DATABASE_URL is required`，不会退回内存存储。

## Analysis store

后端分析状态主要落在：

- `analysis_configs`
- `analysis_jobs`
- `analysis_results`
- `analysis_topic_evidence`

插件前端保存配置时会上送 `source.kind: "postgres"`，并把真实上游标成 `upstreamSourceKind: "feishu_base"`。后端收到创建分析任务请求后，会先通过 `analysis_preflight` 跑一次同步，把 Feishu Base 数据写入 `review_records` 和 `review_source_versions`，再用 `PostgresReviewSource` 解析 scope 并创建 job。

## 同步接口

```text
POST /api/hotel-review-ai/sync/feishu/record-changed
POST /api/hotel-review-ai/sync/manual
```

这两条路由会先做请求校验，再把事件/手动同步转成 `sync_jobs` 里的工作项。它们依赖 `sync_jobs`、`review_records` 和 `review_source_versions` 这三张表。

## Read model

后端 Postgres 读模型主要是：

- `review_records`
- `review_source_versions`
- `sync_jobs`

`PostgresReviewSource.listReviews()` 读 `review_records` 的非删除记录。
`PostgresReviewSource.getSourceVersion()` 读最近一次成功同步写入的 `review_source_versions`。

## View restore

View restore 的正确顺序是先读后端 latest result，再把 host data / filter options 的读取放到后面。当前实现里，restore 不应因为 host data 慢读而挡住已持久化的结果首屏。

## Smoke tests

结果查询可以用一个已存在的 persisted `scopeKey` 验证最新结果是否从 Postgres 返回：

```bash
curl 'http://127.0.0.1:8797/api/hotel-review-ai/results/latest?tenantKey=tenant-a&baseUserId=user-a&pluginInstanceId=plugin-a&scopeKey=scope-missing'
```

返回示例：

```json
{"stage":"load_config","message":"analysis result not found"}
```

如果数据库里存在已成功发布的 `analysis_results`，同一个接口应直接返回该结果，不需要重新扫描 Base。

同步事件：

```bash
curl -X POST 'http://127.0.0.1:8797/api/hotel-review-ai/sync/feishu/record-changed' \
  -H 'content-type: application/json' \
  -d '{"recordId":"rec-1","operation":"update","sourceKey":{"tenantKey":"tenant-a","sourceKind":"feishu_base","sourceId":"base-token-a:tbl-review:vew-active","baseToken":"base-token-a","tableId":"tbl-review","viewId":"vew-active","fieldMapping":{"content":"fld-review","rating":"fld-rating","hotelName":"fld-hotel"}}}'
```

当前本地 smoke 曾遇到的真实失败边界已经由迁移修复：

```json
{"error":"internal server error"}
```

重放迁移后，旧表会自动补上 `base_token`、`table_id`、`view_id`、`field_mapping_json`，并把 `sync_jobs_status_check` 升级到当前状态集合。这样 `POST /api/hotel-review-ai/sync/feishu/record-changed` 的 smoke 可以直接继续，不需要重建表或手工补列。

补充说明：这个 smoke 返回 `202 Accepted` 只说明 receiver、enqueue 和数据库写入这条链路是通的；在本地环境里，async worker 之后仍可能因为真实 Base 应用凭据或 source 配置不完整而触发 Feishu OpenAPI `400`，这是另一个独立的后续失败点。

## 快速检查

```bash
docker compose exec postgres psql -U hotel_review_ai -d hotel_review_ai \
  -c "\\dt"
```
