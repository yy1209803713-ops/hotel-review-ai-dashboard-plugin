# AI Cache Warmup Workflow

## 当前实现边界

这个仓库当前包含三部分：

1. 在 Dashboard 插件里提供缓存预热配置、手动触发按钮和状态展示。
2. 通过 `src/services/warmupClient.ts` 向后端 warmup API 发起请求。
3. 通过 `server/` 提供一个最小本地 warmup HTTP endpoint。

当前 `server/` 先用于接住插件或飞书工作流请求、校验 `WARMUP_SECRET`、输出触发日志并返回标准 `WarmupResponse`。真正读取 Base、写缓存表、跑 AI 的执行适配仍需继续接入。

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

当前最小本地后端需要：

```text
WARMUP_SECRET
```

后续接入真实 Base 读写和 AI 执行时，还需要：

```text
LARK_APP_ID
LARK_APP_SECRET
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

当前仓库已有最小本地后端 API 宿主：`server/index.ts` 和 `server/warmupHandler.ts`。它用于验证插件和飞书工作流是否能触发 warmup endpoint；真实 warmup 执行还需要把 Base OpenAPI 读写和 AI pipeline 接入到这个 endpoint 后面。
