# 飞书妙搭部署记录

更新时间：2026-06-29

这份记录只写这次妙搭部署里真正踩过的坑和最终跑通的口径，方便以后直接复制，不用再从头猜。

## 1. 最终结果

- 线上应用地址：`https://z11gk8nt38x.aiforce.cloud/app/app_178y1bawrh0`
- 当前最新发布状态：`release 7656723055540882644` 已 `finished`
- 当前最新发布 commit：`bda9094bca9e566a975f01dd5dd0e74afc2645bc`
- 首次全栈部署跑通发布：`release 7655733198701759674` 已 `finished`
- 实际可用的外部接口前缀：`https://z11gk8nt38x.aiforce.cloud/public-api/hotel-review-ai`

页面和接口是两条线：

- 浏览器里看应用，用 `/app/app_178y1bawrh0`
- 外部 curl 打后端接口，用 `/public-api/hotel-review-ai/...`

## 2. 正确的 curl

统一规则：

- 不要再用 `x-suda-csrf-token`
- 不要再带 `Cookie`
- 统一用 `Authorization: Bearer <WARMUP_SECRET>`
- `sync` 和 `warmup` 都是异步任务，返回 `202` 只代表入队成功

### 全量同步

```bash
curl --location --request POST 'https://z11gk8nt38x.aiforce.cloud/public-api/hotel-review-ai/sync/full' \
  --header 'Authorization: Bearer <WARMUP_SECRET>' \
  --header 'Content-Type: application/json' \
  --data-raw '{
    "baseToken": "<BASE_TOKEN>",
    "tableId": "<TABLE_ID>",
    "fieldMapping": {
      "reviewId": "<REVIEW_ID_FIELD>",
      "content": "<CONTENT_FIELD>",
      "hotelName": "<HOTEL_NAME_FIELD>",
      "score": "<SCORE_FIELD>",
      "reviewDate": "<REVIEW_DATE_FIELD>",
      "checkInMonth": "<CHECKIN_MONTH_FIELD>",
      "replyContent": "<REPLY_CONTENT_FIELD>",
      "roomType": "<ROOM_TYPE_FIELD>"
    }
  }'
```

### 增量同步

```bash
curl --location --request POST 'https://z11gk8nt38x.aiforce.cloud/public-api/hotel-review-ai/sync/incremental' \
  --header 'Authorization: Bearer <WARMUP_SECRET>' \
  --header 'Content-Type: application/json' \
  --data-raw '{
    "baseToken": "<BASE_TOKEN>",
    "tableId": "<TABLE_ID>",
    "fieldMapping": {
      "reviewId": "<REVIEW_ID_FIELD>",
      "content": "<CONTENT_FIELD>",
      "hotelName": "<HOTEL_NAME_FIELD>",
      "score": "<SCORE_FIELD>",
      "reviewDate": "<REVIEW_DATE_FIELD>",
      "checkInMonth": "<CHECKIN_MONTH_FIELD>",
      "replyContent": "<REPLY_CONTENT_FIELD>",
      "roomType": "<ROOM_TYPE_FIELD>"
    },
    "warmup": {
      "enabled": true,
      "mode": "incremental",
      "startDate": "2026-05-01",
      "endDate": "2026-05-01"
    }
  }'
```

### Warmup

```bash
curl --location --request POST 'https://z11gk8nt38x.aiforce.cloud/public-api/hotel-review-ai/warmup' \
  --header 'Authorization: Bearer <WARMUP_SECRET>' \
  --header 'Content-Type: application/json' \
  --data-raw '{
    "mode": "incremental",
    "source": "manual",
    "baseToken": "<BASE_TOKEN>",
    "tableId": "<TABLE_ID>",
    "fieldMapping": {
      "reviewId": "<REVIEW_ID_FIELD>",
      "content": "<CONTENT_FIELD>",
      "hotelName": "<HOTEL_NAME_FIELD>",
      "score": "<SCORE_FIELD>",
      "reviewDate": "<REVIEW_DATE_FIELD>",
      "checkInMonth": "<CHECKIN_MONTH_FIELD>",
      "replyContent": "<REPLY_CONTENT_FIELD>",
      "roomType": "<ROOM_TYPE_FIELD>"
    },
    "startDate": "2026-05-01",
    "endDate": "2026-05-01"
  }'
```

### 设施分析

```bash
curl --location --request POST 'https://z11gk8nt38x.aiforce.cloud/app/app_178y1bawrh0/public-api/hotel-review-ai/facilities/analyze' \
  --header 'Authorization: Bearer <FACILITY_ANALYSIS_SECRET>' \
  --header 'Content-Type: application/json' \
  --data-raw '{
    "tenantKey": "<TENANT_KEY>",
    "baseToken": "DCXnbnOk0afmeFsJ0Gpcd17anK4",
    "tableId": "tbl4E0oXrtLaqVD1",
    "viewId": "vew4lxWDMf"
  }'
```

重分析时加上：

```json
{
  "reanalyze": true,
  "reanalyzeDateRange": {
    "startDate": "2026-06-25",
    "endDate": "2026-06-26"
  }
}
```

这个接口在妙搭线上必须走 app-scoped 的 `public-api`，不要再打根域名下的 `/api/hotel-review-ai/facilities/analyze`。

## 3. 数据库和状态怎么看

这次不要再把状态只看接口返回，重点要看数据库里的 job 表。

主要表：

- `analysis_configs`
- `analysis_jobs`
- `analysis_results`
- `analysis_topic_evidence`
- `review_records`
- `review_source_versions`
- `sync_jobs`
- `warmup_jobs`

常用检查思路：

```sql
select id, status, created_at, started_at, finished_at, error_stage, error_message
from sync_jobs
order by created_at desc
limit 10;
```

```sql
select id, status, trigger_type, records_scanned, evidence_cache_hits, topic_mapping_cache_hits,
       error_stage, error_message, created_at, started_at, finished_at
from warmup_jobs
order by created_at desc
limit 10;
```

```sql
select id, status, result_id, created_at, started_at, finished_at
from analysis_jobs
order by created_at desc
limit 10;
```

## 4. 这次踩过的坑

- `/app/.../api/...` 那条路会把请求带进错误的宿主上下文，外部 curl 直接打会撞到 `csrf token not found in cookie`
- 页面能打开不代表接口路径对，应用页和公共 API 不是同一个前缀
- `sync`、`warmup` 返回 `202` 只是入队，不是完成
- `analysis_jobs` / `warmup_jobs` 才是最后的事实来源，不要只看页面 toast
- 旧的 `review_sync_jobs` 名字不要再用
- `review_records.parsed_review` 这种旧列名不要再假设存在
- 发布前先保证代码已经提交，不然妙搭会提示还有代码没提交不能部署
- 如果页面是 401/403，先看应用可见范围是不是还停在仅创建者可见
- `npm run lint` 和 `npm run build` 不要并行跑，会抢 `dist/tsconfig.node.tsbuildinfo`
- 用 `lark-cli apps +db-execute` 查线上库时要明确 `--env online`

## 5. 验证口径

这次验证通过的口径是：

- 线上发布已完成
- 页面可打开
- 全量同步和增量同步都能入队
- warmup 能正常入队
- 数据库里能查到对应 job 状态
- 页面分析在最小日期窗下可以跑通
- 点击「更新分析」后，旧分析结果会保留到新结果生成完成，不再短暂显示「尚未分析」

实际结果里比较关键的几项：

- 增量同步 job：`records_read=7473`，`records_unchanged=7473`
- 全量同步 job：`records_read=7473`，`records_upserted=7473`
- warmup job：`records_scanned=113`，`evidence_cache_hits=113`，`topic_mapping_cache_hits=145`
- 最新分析 job 已成功产出结果
- 2026-06-29 在真实 Chrome 里复测：点击后 120ms 起页面显示「正在分析 / 正在后台更新」，`416` 条结果保持可见，未再出现「尚未分析」

## 6. 本地配置提醒

本地 `.env.local` 和妙搭运行时环境变量不要混着看。

- 本地开发用 `VITE_BACKEND_ENDPOINT_URL=http://127.0.0.1:8787`
- 线上不要留 `127.0.0.1`
- `WARMUP_SECRET` 要和接口鉴权一致
- `DATABASE_URL` 要指向真正可用的数据库
- `AI_BASE_URL`、`AI_API_KEY`、`AI_MODEL` 要和后端实际模型配置一致
