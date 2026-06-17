# AI Cache Warmup Design

## Goal

为酒店评论 AI Dashboard 插件增加一套可落地的缓存预热方案，让常规点击分析时尽量命中已有缓存，减少浏览器端长 AI 请求和等待时间。

本设计覆盖：

- 首次全量初始化缓存。
- 每日 06:00 自动增量预热。
- 插件内手动触发 `初始化缓存` 和 `立即预热`。
- 后端 warmup API 与飞书 Workflow 的接入方式。
- AI 证据缓存和 AI 评论主题映射缓存的幂等补齐规则。

## Background

当前主分析链路已经具备两层缓存：

- `AI评论证据缓存`：按评论内容抽取原文证据片段。
- `AI评论主题映射缓存`：按候选主题标签和 sentiment 缓存主题归并结果。

当前点击分析时的行为是：

1. 读取证据缓存，只对 miss 评论调用 AI 抽取证据。
2. 将缓存证据和新增证据合并成本地候选主题。
3. 读取主题映射缓存，只对 miss 候选调用 AI 归并主题。
4. 本地汇总正面和负面主题。
5. 保存分析结果缓存到插件 `customConfig.analysisCache`。

这套逻辑能降低重复分析成本，但新评论仍会在用户点击分析时触发 AI。预热任务的目标就是把这部分 AI 消耗提前到后台完成。

## Platform Constraint

本项目是飞书多维表格 Dashboard 插件，不是普通 Web 应用。Dashboard 插件只有前端生命周期和宿主 API，例如 `Create`、`Config`、`View`、`FullScreen`、`getData`、`getPreviewData`、`saveConfig`、`setRendered`、`onDataChange`。

因此：

- 插件内不能承载真正可靠的 cron。
- 插件内 `setInterval` 只能表示页面打开时的前端刷新。
- 每天 06:00 这种无人值守任务应由飞书 Workflow 或外部调度触发。
- 当前推荐路径是：`Feishu Workflow TimerTrigger -> HTTPClientAction -> backend warmup endpoint -> 回写 Base 缓存表 -> plugin 展示/消费缓存`。

## Non-Goals

- 不把定时任务写进 Dashboard 插件前端。
- 不把完整批量 AI pipeline 硬塞进飞书 Workflow step。
- 不在 Workflow body 中传 AI API Key、飞书 app secret 或其他长期密钥。
- 不用兜底逻辑掩盖 SDK 权限、字段类型、缓存结构或 AI schema 错误。
- 不改变现有点击分析的结果口径。
- 不在本阶段实现复杂队列系统；先以单任务锁和批次控制满足小范围自用。

## Architecture

### Components

- Dashboard Plugin
  - 展示分析结果。
  - 展示缓存状态。
  - 提供 `初始化缓存` 和 `立即预热` 按钮。
  - 调用后端 warmup API，不直接执行后台长任务。

- Feishu Workflow
  - 每天 06:00 定时触发。
  - 使用 HTTP 请求调用后端 warmup API。
  - 只传业务参数和鉴权 token。

- Backend Warmup API
  - 校验请求。
  - 读取 Base 评论表和两张缓存表。
  - 复用当前 AI 证据抽取、主题候选构造、主题归并和缓存保存逻辑。
  - 写入 job log。

- Base Tables
  - 评论源表。
  - `AI评论证据缓存`。
  - `AI评论主题映射缓存`。
  - 可选 `AI缓存预热任务日志`。

### Runtime Direction

后端需要能访问：

- 飞书 OpenAPI / Base 数据。
- AI API。
- 当前缓存规则版本。

插件和 Workflow 不持有长期敏感密钥。插件可通过后端授权机制触发 warmup；Workflow 只持有 `WARMUP_SECRET` 这类可轮换的调用密钥。

## User Workflows

### Initialization

用户首次配置好数据源和字段后，在插件内点击 `初始化缓存`。

行为：

1. 插件调用后端 warmup API，`mode=bootstrap`。
2. 后端扫描当前配置下的历史评论。
3. 对缺失证据缓存的评论补齐证据缓存。
4. 基于证据生成主题候选，对缺失主题映射缓存的候选补齐映射缓存。
5. 写入 job log。
6. 插件展示任务状态和缓存覆盖率。

### Immediate Warmup

用户在插件内点击 `立即预热`。

行为：

1. 插件调用后端 warmup API，`mode=incremental`。
2. 后端只处理当前 miss 的评论和候选主题。
3. 插件展示最新 warmup 状态。

### Scheduled Warmup

飞书 Workflow 每天 06:00 触发。

行为：

1. TimerTrigger 到点触发。
2. HTTPClientAction 调用后端 warmup API。
3. 后端执行 `mode=incremental`。
4. 后端写入 job log。
5. 插件下次打开或刷新时读取最新缓存状态。

## Feishu Workflow Configuration

在飞书多维表格中配置：

1. 进入目标 Base。
2. 打开 `自动化` / `工作流`。
3. 新建工作流。
4. 触发器选择 `定时触发`。
5. 设置每天 06:00 触发，永不结束。
6. 添加动作 `HTTP 请求`。
7. Method 选择 `POST`。
8. URL 填写后端接口地址。
9. Headers 填写 `Content-Type` 和 `Authorization`。
10. Body 填写 JSON。
11. 保存并启用工作流。

推荐 HTTP 配置：

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
  "tableId": "<review-table-id>"
}
```

如果需要绑定某个视图范围，可增加：

```json
{
  "mode": "incremental",
  "source": "feishu-workflow",
  "baseToken": "<base-token>",
  "tableId": "<review-table-id>",
  "viewId": "<review-view-id>"
}
```

Workflow 只负责调度和调用，不负责批量循环、AI 分析、schema 校验、缓存写入重试或复杂错误恢复。

## Backend API

### Endpoint

```text
POST /api/hotel-review-ai/warmup
```

### Request

```ts
type WarmupRequest = {
  mode: 'bootstrap' | 'incremental';
  source: 'dashboard-button' | 'feishu-workflow' | 'manual';
  baseToken: string;
  tableId: string;
  viewId?: string;
  configId?: string;
  dryRun?: boolean;
};
```

### Response

```ts
type WarmupResponse = {
  jobId: string;
  status: 'accepted' | 'running' | 'success' | 'partial_success' | 'failed' | 'skipped';
  mode: 'bootstrap' | 'incremental';
  summary: {
    totalReviews: number;
    evidenceCacheHits: number;
    evidenceCacheMisses: number;
    evidenceRecordsSaved: number;
    topicMappingHits: number;
    topicMappingMisses: number;
    topicMappingsSaved: number;
  };
  errors: Array<{
    stage: 'read_reviews' | 'read_evidence_cache' | 'extract_evidence' | 'save_evidence_cache' | 'read_topic_mapping_cache' | 'merge_topics' | 'save_topic_mapping_cache';
    message: string;
    recordId?: string;
  }>;
};
```

### Environment Variables

后端至少需要：

```text
LARK_APP_ID
LARK_APP_SECRET
AI_API_KEY
AI_BASE_URL
WARMUP_SECRET
```

如果后端支持多模型或多租户，可把 AI model、max batch size、batch concurrency 作为服务端配置或从插件保存配置读取。

## Warmup Logic

### Common Steps

1. 校验 `Authorization`。
2. 校验 `mode`、`baseToken`、`tableId`。
3. 获取 job lock，防止同一 Base 和同一表并发预热。
4. 读取评论表字段和记录。
5. 按插件配置或请求范围解析评论记录。
6. 读取证据缓存。
7. 对证据缓存 miss 的评论调用 AI 抽取证据。
8. 保存新增证据缓存。
9. 基于所有可用证据构造主题候选。
10. 读取主题映射缓存。
11. 对主题映射 miss 的候选调用 AI 归并。
12. 保存新增主题映射缓存。
13. 写 job log。
14. 释放 job lock。

### Bootstrap Mode

`bootstrap` 面向历史全量初始化。

规则：

- 扫描配置范围内全部评论。
- 仍然按缓存 hit/miss 处理，已经存在且版本匹配的缓存不重复生成。
- 适合首次上线后人工触发。
- 可限制最大处理数量，避免一次任务过长；超限时返回 `partial_success` 并在 job log 记录 next cursor。

### Incremental Mode

`incremental` 面向每日 06:00 和手动即时预热。

规则：

- 读取配置范围内评论，但只对证据缓存 miss 执行 AI。
- 若近期数据量不大，可直接全表读后本地判定 miss。
- 如果评论表有可靠的创建时间或更新时间字段，后续可增加按时间窗口缩小扫描范围，但第一版不依赖它，避免字段不一致导致漏处理。

## Cache Keys

### Evidence Cache

有效命中条件：

- `数据表 ID` 等于 source `tableId`。
- `评论 recordId` 等于评论记录 ID。
- `评论内容 hash` 等于当前评论正文 hash。
- `模型` 等于当前 model。
- `抽取规则版本` 等于当前 `EVIDENCE_CACHE_EXTRACTOR_VERSION`。
- `证据 JSON` 可解析且结构有效。

缓存 miss 需要暴露原因，例如：

- `cache_table_missing`
- `model_mismatch`
- `extractor_version_mismatch`
- `content_hash_mismatch`
- `evidence_json_invalid`
- `cache_no_matching_row`

### Topic Mapping Cache

有效命中条件：

- `数据表 ID` 等于 source `tableId`。
- `候选 sentiment` 等于 candidate sentiment。
- `候选标签归一化 key` 等于 normalized source label。
- `模型` 等于当前 model。
- `主题映射规则版本` 等于当前 `TOPIC_MAPPING_CACHE_VERSION`。
- `映射 JSON` 可解析且 sentiment 一致。

缓存 miss 需要暴露原因，例如：

- `cache_table_missing`
- `model_mismatch`
- `mapping_version_mismatch`
- `mapping_json_invalid`
- `cache_no_matching_row`

## Idempotency And Locking

Warmup 必须幂等：

- 同一条评论已命中证据缓存时不重复调用 AI。
- 同一候选主题已命中映射缓存时不重复调用 AI。
- 保存缓存使用追加记录时，读取逻辑必须能按版本和 hash 找到有效记录。
- 后续如果重复记录膨胀明显，再增加 upsert 或清理策略。

锁粒度：

```text
warmup:<baseToken>:<tableId>
```

锁行为：

- 已有运行中任务时，新请求返回 `skipped` 或 `running`。
- 不用 silent fallback。
- 锁过期时间应大于预期最长任务时间。

## Failure Handling

设计原则：问题必须可见，不用兜底掩盖。

- 读评论失败：任务失败。
- 读缓存失败：任务失败。
- 单批 AI 失败：任务失败或 `partial_success`，取决于是否已有批次成功写入。
- 保存证据缓存失败：任务失败，已写入的前序批次保留。
- 主题归并 schema 无效：任务失败，不写入错误映射。
- Workflow 调用失败：由飞书 Workflow 记录失败；后端若收到请求则写 job log。

错误输出必须包含 stage 和 message，便于定位是 Base 权限、字段配置、AI API、schema 还是缓存表结构问题。

## Job Log

建议新增可选表 `AI缓存预热任务日志`。

字段建议：

- `jobId`
- `mode`
- `source`
- `status`
- `baseToken`
- `tableId`
- `viewId`
- `startedAt`
- `finishedAt`
- `totalReviews`
- `evidenceCacheHits`
- `evidenceCacheMisses`
- `evidenceRecordsSaved`
- `topicMappingHits`
- `topicMappingMisses`
- `topicMappingsSaved`
- `errorStage`
- `errorMessage`

插件的缓存状态区可以读取最近一条 job log 展示。

## Plugin UI Changes

新增一个轻量 `缓存状态` 区域。

显示：

- 证据缓存覆盖率。
- 主题映射缓存覆盖率。
- 上次预热时间。
- 上次预热状态。
- 待补评论数。

操作：

- `初始化缓存`：调用 `mode=bootstrap`。
- `立即预热`：调用 `mode=incremental`。
- `刷新状态`：重新读取缓存状态和 job log。

按钮行为：

- 任务运行中禁用重复点击。
- 成功后提示保存数量和覆盖率。
- 失败时展示后端返回的 stage 和 message。

## Security

- Workflow 和插件不保存 AI API Key。
- Workflow 不传 `LARK_APP_SECRET` 或 `AI_API_KEY`。
- 后端使用 `Authorization: Bearer <warmup-secret>` 校验 Workflow 调用。
- 后端密钥通过环境变量配置。
- `WARMUP_SECRET` 支持轮换。
- 若未来公开多人使用，需要补充租户隔离、用户授权和审计设计。

## Testing

### Unit Tests

- 证据缓存 hit/miss 判定。
- 主题映射缓存 hit/miss 判定。
- `bootstrap` 不重复处理已命中缓存。
- `incremental` 只处理 miss。
- content hash 变化触发 miss。
- model/version 变化触发 miss。
- AI schema invalid 时不写缓存。
- job lock 已存在时跳过或返回 running。

### Integration Tests

- 用 fixture records 跑完整 warmup。
- 验证新增证据缓存记录数量。
- 验证新增主题映射缓存记录数量。
- 验证第二次 warmup AI 调用数为 0。

### Build Verification

常规验证：

```bash
npm test
npm run build
```

如果后端独立 package，额外运行后端对应测试和 build。

## Implementation Plan Outline

后续实现可拆成：

1. 抽出可复用 `warmupAnalysisCache()` 服务函数。
2. 新增后端 runtime，用飞书 OpenAPI 适配当前 `DashboardRuntime` 需要的表读写能力。
3. 新增 `POST /api/hotel-review-ai/warmup`。
4. 新增 job lock 和 job log。
5. 插件配置区增加缓存状态和两个按钮。
6. 补充 Feishu Workflow 配置说明或 JSON 示例。
7. 跑测试和 build。

## Open Questions

- 后端部署位置：现有项目内新增 API，还是单独服务。
- 后端身份：使用飞书应用身份，还是用户授权身份。
- Workflow 是否能稳定调用公网 HTTPS 地址，以及是否需要 IP 白名单。
- 当前 Base 的评论表是否有可靠 `createdAt` / `updatedAt` 字段；如果有，可在第二版优化增量扫描范围。
- `AI缓存预热任务日志` 是否接受自动建表；若不接受，则先只写服务端日志。
