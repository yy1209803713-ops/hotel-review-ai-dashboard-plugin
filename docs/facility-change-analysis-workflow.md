# 酒店设施和政策变动分析 Workflow

## 实现口径

- 数据读取仍走现有 Feishu Base OpenAPI runtime，不在本地另起采集链路。
- 分析对象是设施/政策快照，不复用评论主题分析 schema。
- 语义层设计见 [`docs/facility-change-analysis-semantic-model.md`](./facility-change-analysis-semantic-model.md)。
- 每次运行会读取设施表全量历史记录，取表中最新 `采集日期` 作为“本次采集”。
- 同一酒店本次记录会和该酒店上一条更早 `采集时间` 的记录对比，不机械对比昨天。
- 本次采集中新出现且没有历史记录的酒店，会标记为 `新采集，无历史数据`。
- JSON 会先做 canonicalize，忽略对象 key 顺序和数组顺序；单纯顺序变化不会被判定为变动。
- 代码先计算结构化 diff，AI 只负责把确定差异写成可读摘要。
- 分析结果保存到 Postgres `facility_analysis_runs.result_json`。

## 后端接口

```text
POST /api/hotel-review-ai/facilities/analyze
Authorization: Bearer <FACILITY_ANALYSIS_SECRET>
Content-Type: application/json
```

请求体：

```json
{
  "tenantKey": "default",
  "baseToken": "DCXnbnOk0afmeFsJ0Gpcd17anK4",
  "tableId": "tbl4E0oXrtLaqVD1",
  "viewId": "vew4lxWDMf"
}
```

本地示例：

```bash
curl -X POST 'http://127.0.0.1:8787/api/hotel-review-ai/facilities/analyze' \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer local-facility-analysis-secret' \
  --data '{
    "tenantKey": "default",
    "baseToken": "DCXnbnOk0afmeFsJ0Gpcd17anK4",
    "tableId": "tbl4E0oXrtLaqVD1",
    "viewId": "vew4lxWDMf"
  }'
```

## 环境变量

```text
DATABASE_URL=postgresql://hotel_review_ai:hotel_review_ai_dev@127.0.0.1:5432/hotel_review_ai
LARK_BASE_AUTH_CODE=<Feishu Base auth code>
AI_BASE_URL=<OpenAI-compatible base URL>
AI_API_KEY=<AI key>
AI_MODEL=<model>
FACILITY_ANALYSIS_SECRET=<workflow bearer secret>
```

如果不配置 `FACILITY_ANALYSIS_SECRET`，本地后端会沿用 `WARMUP_SECRET`。

## 飞书 Workflow

推荐链路：

```text
TimerTrigger(每天 12:00 Asia/Shanghai) -> HTTPClientAction
```

HTTP 动作配置：

```text
Method: POST
URL: https://<backend-domain>/api/hotel-review-ai/facilities/analyze
Headers:
  Content-Type: application/json
  Authorization: Bearer <FACILITY_ANALYSIS_SECRET>
Body: 上面的 JSON 请求体
```
