# AI Cache Warmup Workflow

## 当前实现边界

这个仓库当前只负责两件事：

1. 在 Dashboard 插件里提供缓存预热配置、手动触发按钮和状态展示。
2. 通过 `src/services/warmupClient.ts` 向后端 warmup API 发起请求。

真正执行预热、读 Base、写缓存表、跑 AI 的逻辑不在插件前端里。

## 插件侧请求

请求地址由插件配置中的 `warmup.endpointUrl` 提供，按钮触发时使用 `Authorization: Bearer <secret>`。

请求体示例：

```json
{
  "mode": "incremental",
  "source": "dashboard-button",
  "tableId": "tbl_xxx",
  "viewId": "view_xxx",
  "dryRun": false
}
```

`bootstrap` 用于首次初始化；`incremental` 用于日常补齐。

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

后端至少需要：

```text
LARK_APP_ID
LARK_APP_SECRET
AI_API_KEY
AI_BASE_URL
WARMUP_SECRET
```

## 失败约定

后端返回错误时，插件直接展示 `stage + message`，不做静默兜底。

## 控制台日志

当后端调用 `warmupAnalysisCache()` 且请求来源是 `source=feishu-workflow` 时，服务端控制台会输出：

```text
__HOTEL_REVIEW_AI_WARMUP_TRIGGER__ {"jobId":"warmup-...","source":"feishu-workflow","mode":"incremental","baseToken":"...","tableId":"...","viewId":"...","dryRun":false}
```

这个日志不包含 `Authorization`、`WARMUP_SECRET`、`AI_API_KEY` 或飞书应用密钥。你可以先用它确认工作流是否打到了后端。

## 现阶段说明

当前仓库没有后端 API 宿主。`src/services/warmupClient.ts` 已准备好客户端契约，后端可按这个请求/响应结构实现 `/api/hotel-review-ai/warmup`。
