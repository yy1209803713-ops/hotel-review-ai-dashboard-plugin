# AI Cache Warmup Workflow

## 当前实现边界

这个仓库当前包含三部分：

1. 在 Dashboard 插件里提供缓存预热配置、手动触发按钮和状态展示。
2. 通过 `src/services/warmupClient.ts` 向后端 warmup API 发起请求。
3. 通过 `server/` 提供一个最小本地 warmup HTTP endpoint。

当前 `server/` 会接住插件、飞书工作流或手工请求，校验 `WARMUP_SECRET`，创建 `warmup_jobs` 审计记录，异步读取 Postgres 全局评论镜像并复用正式分析 runner 构建两层缓存。

Warmup 不直接从飞书 Base 读取评论。它使用已经同步到数据库的全局 read model：

```text
tenant_key = global-review-source
source_kind = feishu_base
source_id = <baseToken>:<tableId>
```

如果还没有先跑过 `/api/hotel-review-ai/sync/full` 或 `/api/hotel-review-ai/sync/incremental`，warmup 会失败并把错误记录到 `warmup_jobs`。

## 本地启动

启动插件前端：

```bash
npm run dev
```

启动 warmup 后端：

```bash
WARMUP_SECRET=local-warmup-secret npm run server
```

后端启动后会监听：

```text
http://127.0.0.1:8787/api/hotel-review-ai/warmup
```

本地插件里填写：

```text
Warmup Endpoint URL = http://127.0.0.1:8787/api/hotel-review-ai/warmup
Warmup Secret = local-warmup-secret
```

如果要让飞书工作流打到本地服务，需要用公网隧道把 `127.0.0.1:8787` 暴露出去，例如：

```bash
cloudflared tunnel --url http://127.0.0.1:8787
```

飞书工作流的 URL 填隧道给出的公网地址加路径：

```text
https://<tunnel-domain>/api/hotel-review-ai/warmup
```

## 插件侧请求

请求地址由插件配置中的 `warmup.endpointUrl` 提供，按钮触发时使用 `Authorization: Bearer <secret>`。

请求体示例：

```json
{
  "mode": "incremental",
  "source": "dashboard-button",
  "baseToken": "base_xxx",
  "tableId": "tbl_xxx",
  "fieldMapping": {
    "reviewId": "fld_review_id",
    "content": "fld_content",
    "hotelName": "fld_hotel",
    "score": "fld_score",
    "reviewDate": "fld_review_date",
    "checkInMonth": "fld_checkin_month",
    "replyContent": "fld_reply",
    "roomType": "fld_room_type"
  },
  "viewId": "view_xxx",
  "startDate": "2026-06-01",
  "endDate": "2026-06-30",
  "dryRun": false
}
```

`bootstrap` 用于首次初始化；`incremental` 用于日常补齐。`startDate` / `endDate` 是评论时间口径，对应评论字段 `reviewDate`；不传时扫描当前全局 read model 全部评论，再只对两层缓存 miss 调 AI。定时任务可传 `dateRange: "today"`，后端会按 `Asia/Shanghai` 展开为当天 `00:00:00` 到 `23:59:59`；如果同时传了 `startDate` 或 `endDate`，显式时间优先。

定时任务只扫当天时，可用下面的时间参数替代显式 `startDate` / `endDate`：

```json
{
  "dateRange": "today"
}
```

本地 curl：

```bash
curl -sS -X POST 'http://127.0.0.1:8787/api/hotel-review-ai/warmup' \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer local-warmup-secret' \
  --data-raw '{
    "mode": "incremental",
    "source": "manual",
    "baseToken": "base_xxx",
    "tableId": "tbl_xxx",
    "fieldMapping": {
      "reviewId": "fld_review_id",
      "content": "fld_content",
      "hotelName": "fld_hotel",
      "score": "fld_score",
      "reviewDate": "fld_review_date",
      "checkInMonth": "fld_checkin_month",
      "replyContent": "fld_reply",
      "roomType": "fld_room_type"
    },
    "startDate": "2026-06-01",
    "endDate": "2026-06-30"
  }'
```

返回 `202 accepted` 后，后台继续执行。结果和统计查看：

`records_scanned` 是 warmup 从全局 read model 扫到的原始评论数量；最终 `result_json.summary.totalReviews` 是按 `reviewDate` 时间范围过滤后进入两层缓存构建的评论数量。

```sql
select
  id,
  status,
  trigger_type,
  review_start_date,
  review_end_date,
  records_scanned,
  evidence_cache_hits,
  evidence_cache_misses,
  evidence_cache_inserts,
  evidence_cache_updates,
  topic_mapping_cache_hits,
  topic_mapping_cache_misses,
  topic_mapping_cache_inserts,
  topic_mapping_cache_updates,
  error_stage,
  error_message,
  created_at,
  started_at,
  finished_at
from warmup_jobs
order by created_at desc
limit 10;
```

## Sync 后联动 warmup

`/api/hotel-review-ai/sync/full` 和 `/api/hotel-review-ai/sync/incremental` 支持可选 `warmup` 参数。默认不联动，只有显式传 `warmup.enabled=true` 时，sync job 成功后才 enqueue warmup job。联动 warmup 在 sync 写入评论 read model、source version 和 sync job success 状态的事务提交之后才创建，因此能读到本次 sync 的新增/更新/删除结果。

示例：

```bash
curl -sS -X POST 'http://127.0.0.1:8787/api/hotel-review-ai/sync/incremental' \
  -H 'Content-Type: application/json' \
  --data-raw '{
    "baseToken": "base_xxx",
    "tableId": "tbl_xxx",
    "fieldMapping": {
      "reviewId": "fld_review_id",
      "content": "fld_content",
      "hotelName": "fld_hotel",
      "score": "fld_score",
      "reviewDate": "fld_review_date",
      "checkInMonth": "fld_checkin_month",
      "replyContent": "fld_reply",
      "roomType": "fld_room_type"
    },
    "warmup": {
      "enabled": true,
      "mode": "incremental",
      "dateRange": "today"
    }
  }'
```

`/sync/full` 使用同样的 body 结构。联动 warmup 的 `trigger_type` 会记录为 `sync_followup`。

## Workflow 侧调用

推荐的飞书工作流链路是：

`TimerTrigger -> HTTPClientAction -> backend warmup endpoint`

飞书侧配置步骤：

1. 打开目标多维表格 Base。
2. 进入 `自动化` 或 `工作流`。
3. 新建工作流，触发器选择 `定时触发`。
4. 选择每天固定时间，例如 `06:00`。
5. 新增动作，选择 `发送 HTTP 请求` / `HTTP 请求`。
6. Method 选择 `POST`。
7. URL 填后端 warmup endpoint。
8. Headers 填 `Content-Type` 和 `Authorization`。
9. Body 选择 JSON，填下面的请求体。
10. 先手动运行一次工作流，再看后端控制台日志。

HTTP 请求建议：

```text
POST https://<backend-domain>/api/hotel-review-ai/warmup
Content-Type: application/json
Authorization: Bearer <warmup-secret>
```

Body:

```json
{
  "mode": "incremental",
  "source": "feishu-workflow",
  "baseToken": "<base-token>",
  "tableId": "<review-table-id>",
  "viewId": "<review-view-id>"
}
```

## 后端环境变量

当前本地后端需要：

```text
WARMUP_SECRET
```

真实同步、warmup 和 AI 执行还需要：

```text
DATABASE_URL
LARK_BASE_AUTH_CODE
AI_API_KEY
AI_BASE_URL
```

## 失败约定

后端返回错误时，插件直接展示 `stage + message`，不做静默兜底。

## 控制台日志

当 `server/` 收到 warmup 请求时，服务端控制台会输出：

```text
__HOTEL_REVIEW_AI_WARMUP_TRIGGER__ {"jobId":"warmup-...","source":"feishu-workflow","mode":"incremental","baseToken":"...","tableId":"...","viewId":"...","dryRun":false}
```

这个日志不包含 `Authorization`、`WARMUP_SECRET`、`AI_API_KEY` 或飞书应用密钥。你可以先用它确认工作流是否打到了后端。

## 现阶段说明

当前仓库已有后端 API 宿主：`server/index.ts` 和 `server/warmupHandler.ts`。`warmup_jobs` 会记录每次触发的入参、接口 accepted response、最终结果、触发时间、扫描评论数量、两层缓存 hit/miss、新增/更新数量和错误信息。
