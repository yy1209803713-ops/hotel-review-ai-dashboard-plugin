# Backend-Owned Analysis Design

## Goal

将酒店评论 AI Dashboard 插件从“前端执行分析并把结果写入插件配置/Base 内部表”的模式，迁移到“后端拥有分析任务、结果、缓存、密钥、定时任务和数据源读模型”的模式。

目标效果：

- 浏览器刷新、关闭、切换浏览器后，用户仍能看到自己的分析结果。
- 分析进行中刷新或关闭页面，后端继续执行并持久化结果。
- AI API Key、飞书应用密钥、调度配置和内部缓存不出现在前端或 Base 普通页签中。
- `AI分析批次`、`AI主题汇总`、`AI评论证据缓存`、`AI评论主题映射缓存` 默认迁移到 Postgres，不再自动创建到飞书 Base。
- 架构拆分 `AI 分析`、`数据源读取`、`数据采集/同步` 三层，后续可从飞书 Base 读取切换为本地数据库或外部数据源读取。

## Background

当前 v1.2 前端已经有完整聚合分析链路：

1. 读取当前 Base 评论记录。
2. 读取 `AI评论证据缓存`。
3. 对缓存 miss 的评论调用 AI 抽取证据。
4. 读取 `AI评论主题映射缓存`。
5. 对缓存 miss 的主题候选调用 AI 归并。
6. 汇总好评点、差评点、行动建议和证据。
7. 把最终结果写入 `customConfig.analysisCache`，并可选写回 `AI分析批次` / `AI主题汇总`。

这套方式存在几个结构性问题：

- 分析任务依赖浏览器页面生命周期，刷新或关闭页面会丢失运行态。
- 分析结果绑定在前端和插件配置里，跨浏览器、跨用户、长任务恢复能力弱。
- AI Key 等敏感配置曾经通过前端配置承载，不适合长期使用。
- 四张 Base 表更多是程序中间态和缓存态，对普通用户价值低，并暴露内部机制。
- 飞书 Base 表作为缓存和历史结果存储，数据量上来后查询、分页和容量风险更高。

## Design Principles

- 后端是任务、结果、缓存、密钥和调度的事实源。
- 前端只负责 Dashboard 宿主配置、触发任务、查询任务状态、展示结果。
- 飞书 Base 第一版仍可作为评论源数据读取入口，但不能让 AI pipeline 直接依赖飞书 SDK 形态。
- 数据源读取和数据采集/同步分开。读取层只回答“分析用什么评论数据”，采集层只负责“数据库里的评论数据从哪里来、何时更新”。
- 不使用兜底逻辑掩盖 SDK、权限、字段映射、同步、AI schema 或 DB 写入问题；错误必须暴露 stage 和 message。
- 第一版不强行做 Base 到 Postgres 的实时读模型；先保留 `FeishuBaseReviewSource`，同时设计可升级的 `PostgresReviewSource` 和 `DataIngestion`。

## Non-Goals

- 第一版不实现 Base <-> Postgres 双向同步。
- 第一版不依赖飞书把 Base 直接双向同步到我们的数据库。
- 第一版不自动创建 `AI分析批次`、`AI主题汇总`、`AI评论证据缓存`、`AI评论主题映射缓存` 四张 Base 表。
- 第一版不按飞书用户权限裁剪源数据；后端使用飞书应用身份读取管理员配置范围内的数据。
- 第一版不保证实时数据同步；如果启用 Postgres 读模型，分析读取的是最近一次成功同步的数据版本。
- 第一版不做复杂多租户商业化权限模型，但表结构必须包含 `tenantKey` 和插件实例维度，避免后续迁移困难。

## Architecture Overview

```text
Dashboard Plugin
  - read dashboard config / host scope
  - get tenantKey, baseUserId, pluginInstanceId
  - upsert backend config
  - create analysis job
  - poll job state
  - fetch latest result
  - render dashboard

Backend API
  - auth and request validation
  - config service
  - job service
  - result service
  - export service
  - sync trigger endpoint

AI Analysis Layer
  - analysis pipeline
  - evidence extraction
  - topic merge
  - result summary
  - shared AI caches

Review Source Layer
  - FeishuBaseReviewSource
  - PostgresReviewSource
  - ExternalReviewSource

Data Ingestion Layer
  - Feishu event receiver
  - scheduled sync
  - manual sync
  - future crawler/import pipelines

Postgres
  - configs
  - jobs
  - results
  - shared caches
  - source snapshots
  - ingested review records
  - sync jobs/logs
```

## Layer Boundaries

### AI Analysis Layer

只负责把 `ReviewRecord[]` 转成 `AnalysisResult`。

它可以依赖：

- `AiConfig`
- `AnalysisConfig`
- `EvidenceCacheRepository`
- `TopicMappingCacheRepository`
- `AnalysisResultRepository`

它不能依赖：

- 飞书 Dashboard SDK。
- 飞书 Base OpenAPI 响应原始结构。
- 前端状态。
- 数据采集调度细节。

输出必须保持现有 UI 可消费的 `AnalysisResult` 语义：概览、好评主题、差评主题、行动建议、证据列表。

### Review Source Layer

只负责提供分析需要的评论数据。

统一接口：

```ts
type ReviewSourceKind = 'feishu_base' | 'postgres' | 'external';

type ReviewSourceQuery = {
  tenantKey: string;
  baseToken?: string;
  tableId?: string;
  viewId?: string;
  fieldMapping: FieldMapping;
  filters: FilterState;
  hostScope?: HostScope;
  sourceVersionHint?: string;
};

type SourceVersion = {
  kind: ReviewSourceKind;
  sourceId: string;
  version: string;
  generatedAt: string;
  recordCount: number;
  contentHash: string;
};

interface ReviewSource {
  kind: ReviewSourceKind;
  listReviews(query: ReviewSourceQuery): Promise<ReviewRecord[]>;
  getSourceVersion(query: ReviewSourceQuery): Promise<SourceVersion>;
}
```

第一版实现：

- `FeishuBaseReviewSource`：后端用飞书应用身份分页读取 Base。
- `PostgresReviewSource`：设计接口和表结构，后续启用。

后续可扩展：

- `ExternalReviewSource`：读取外部酒店评论 API、采集系统或导入文件。

### Data Ingestion Layer

只负责把外部数据写入 Postgres 读模型，不负责 AI 分析。

来源包括：

- Feishu Base record changed event。
- Feishu Base field changed event。
- 后端定时同步。
- 手动同步。
- 后续新增的评论采集服务。
- 后续外部数据源导入。

Data Ingestion 输出到 Postgres 的 `review_records` / `review_source_versions`，供 `PostgresReviewSource` 读取。

## Identity And Ownership

后端读取 Base 使用飞书应用身份，因为该插件面向管理员分析全量数据，不按不同用户的 Base 可见权限裁剪结果。

用户维度用于任务和结果隔离：

- `tenantKey`：通过 `bitable.bridge.getTenantKey()` 获取。
- `baseUserId`：通过 `bitable.bridge.getBaseUserId()` 获取。
- `pluginInstanceId`：通过 `bitable.bridge.getInstanceId()` 获取。

`baseUserId` 只用于 Base/插件体系内区分用户，不作为开放平台 OpenUserId 使用。

同一用户在不同浏览器打开同一插件实例时，使用相同：

```text
tenantKey + baseUserId + pluginInstanceId + scopeKey
```

来恢复当前 job 和 latest result。不同用户即使 scope 相同，也拥有各自的 analysis job 和 result snapshot。

共享缓存不按用户隔离：

```text
sourceRecordHash + model + pipelineVersion
```

相同评论、相同模型、相同规则版本下的证据缓存和主题映射缓存可跨用户复用。

## Scope Key

`scopeKey` 决定“同一份结果”的边界。它必须稳定且可解释。

组成：

- `tenantKey`
- `pluginInstanceId`
- `source.kind`
- `baseToken` 或 source id
- `tableId`
- `viewId`
- `fieldMapping`
- dashboard host scope
- user filters
- AI model key
- pipeline version
- source version

`scopeKey` 生成方式：

```text
sha256(canonicalJson(scopeDescriptor))
```

`scopeDescriptor` 必须按 key 排序序列化，避免对象顺序导致同一范围生成不同 key。

如果字段映射、筛选、视图、模型、pipeline 版本或源数据版本变化，就生成新的 `scopeKey`，避免旧结果串到新范围。

## Backend Configuration

前端仍保存 Dashboard 必需配置：

- `dataConditions`
- `source.tableId`
- `source.viewId`
- `fieldMapping`
- UI filters
- backend config id

后端保存敏感和运行配置：

- AI provider/base URL/model/api key reference。
- scheduler config。
- data source mode。
- Postgres sync config。
- pipeline version。
- export preferences。

前端配置保存时必须同时：

1. 调用 `dashboard.saveConfig()` 保存飞书 Dashboard 必需配置。
2. 调用 `POST /api/hotel-review-ai/configs/upsert` 保存后端分析配置。

任一保存失败都必须提示用户，不做 silent fallback。

## Backend API

### Upsert Config

```text
POST /api/hotel-review-ai/configs/upsert
```

请求包含：

```ts
type UpsertConfigRequest = {
  tenantKey: string;
  baseUserId: string;
  pluginInstanceId: string;
  baseToken?: string;
  source: {
    kind: 'feishu_base' | 'postgres' | 'external';
    tableId?: string;
    viewId?: string;
    fieldMapping: FieldMapping;
  };
  filters: FilterState;
  dashboardDataConditions: unknown;
};
```

响应：

```ts
type UpsertConfigResponse = {
  configId: string;
  configVersion: number;
};
```

### Create Or Get Analysis Job

```text
POST /api/hotel-review-ai/analysis-jobs
```

行为：

- 计算 `scopeKey`。
- 如果同一用户同一 `scopeKey` 已有 `queued` / `running` job，返回已有 job。
- 否则创建新 job 并入队。

请求：

```ts
type CreateAnalysisJobRequest = {
  tenantKey: string;
  baseUserId: string;
  pluginInstanceId: string;
  configId: string;
  forceRefresh?: boolean;
};
```

响应：

```ts
type CreateAnalysisJobResponse = {
  jobId: string;
  scopeKey: string;
  status: 'queued' | 'running' | 'success' | 'failed' | 'canceled';
};
```

### Resolve Current Scope

```text
POST /api/hotel-review-ai/scopes/resolve
```

用于页面初始化时由后端根据最新 config、source version 和 pipeline version 计算 `scopeKey`。前端不需要自己拼 source version，也不需要知道当前数据源是实时 Base 读取还是 Postgres 读模型。

请求：

```ts
type ResolveScopeRequest = {
  tenantKey: string;
  baseUserId: string;
  pluginInstanceId: string;
  configId: string;
};
```

响应：

```ts
type ResolveScopeResponse = {
  scopeKey: string;
  sourceVersion: SourceVersion;
  configVersion: number;
};
```

### Get Current Job

```text
GET /api/hotel-review-ai/analysis-jobs/current?tenantKey=...&baseUserId=...&pluginInstanceId=...&scopeKey=...
```

用于页面刷新后恢复任务状态。

### Get Job

```text
GET /api/hotel-review-ai/analysis-jobs/:jobId
```

响应必须包含：

- status
- stage
- progress
- startedAt
- finishedAt
- errorStage
- errorMessage
- resultId

### Get Latest Result

```text
GET /api/hotel-review-ai/results/latest?tenantKey=...&baseUserId=...&pluginInstanceId=...&scopeKey=...
```

用于刷新/换浏览器后展示同一用户最近成功结果。

### Get Topic Evidence

```text
GET /api/hotel-review-ai/results/:resultId/topics/:topicId/evidence?page=1&pageSize=20
```

证据分页从后端结果快照或证据索引读取，不要求前端持有完整大 JSON。

### Export Summary To Base

```text
POST /api/hotel-review-ai/results/:resultId/export/base-summary
```

显式导出当前结果摘要到飞书 Base。默认不自动创建四张内部表。

导出内容只包含用户可读摘要：

- 分析批次摘要。
- 主题汇总。
- 可选少量证据片段。

不导出：

- evidence cache。
- topic mapping cache。
- cache key。
- pipeline version 细节。
- 内部错误栈。

## Job Lifecycle

状态：

```text
queued -> running -> success
queued -> running -> failed
queued -> canceled
running -> canceled
```

阶段：

```text
validate_request
load_config
resolve_source
read_reviews
read_evidence_cache
extract_evidence
save_evidence_cache
read_topic_mapping_cache
merge_topics
save_topic_mapping_cache
build_result
save_result
export_summary
```

前端页面初始化：

1. 读取 Dashboard config。
2. 获取 `tenantKey` / `baseUserId` / `pluginInstanceId`。
3. upsert backend config。
4. 计算或请求当前 `scopeKey`。
5. 查询 current job。
6. 如果 job running，展示运行态并轮询。
7. 如果无 running job，查询 latest result。
8. 渲染结果或空状态。

分析中刷新页面：

- 后端 job 不受影响。
- 新页面通过 current job API 找回 job。
- job 完成后通过 result API 获取结果。

## Concurrency

### User Job Lock

锁粒度：

```text
tenantKey:baseUserId:pluginInstanceId:scopeKey
```

作用：

- 防止同一用户重复点击创建多个相同任务。
- 同一用户刷新页面不会重建任务。

### Shared Cache Lock

锁粒度：

```text
sourceRecordHash:model:pipelineVersion
```

作用：

- 不同用户分析同一批评论时，共享证据缓存和主题映射缓存。
- 防止重复调用 AI。

### Source Sync Lock

锁粒度：

```text
tenantKey:sourceKind:sourceId
```

作用：

- 防止事件触发同步、定时同步、手动同步同时处理同一张源表。

## Postgres Schema

### analysis_configs

```text
id
tenant_key
plugin_instance_id
created_by_base_user_id
source_kind
source_ref_json
field_mapping_json
filters_json
dashboard_data_conditions_json
ai_profile_id
schedule_id
config_version
created_at
updated_at
```

### analysis_jobs

```text
id
tenant_key
base_user_id
plugin_instance_id
config_id
scope_key
status
stage
progress_json
error_stage
error_message
started_at
finished_at
created_at
updated_at
```

Unique partial index:

```text
(tenant_key, base_user_id, plugin_instance_id, scope_key)
where status in ('queued', 'running')
```

### analysis_results

```text
id
tenant_key
base_user_id
plugin_instance_id
config_id
job_id
scope_key
source_version_id
model
pipeline_version
result_json
summary_json
generated_at
created_at
```

Index:

```text
(tenant_key, base_user_id, plugin_instance_id, scope_key, generated_at desc)
```

### evidence_cache

```text
id
tenant_key
source_kind
source_id
source_record_id
content_hash
model
extractor_version
evidence_json
created_at
updated_at
last_used_at
```

Unique index:

```text
(tenant_key, source_kind, source_id, source_record_id, content_hash, model, extractor_version)
```

### topic_mapping_cache

```text
id
tenant_key
source_kind
source_id
sentiment
normalized_source_label
model
mapping_version
mapping_json
created_at
updated_at
last_used_at
```

Unique index:

```text
(tenant_key, source_kind, source_id, sentiment, normalized_source_label, model, mapping_version)
```

### review_records

Used only when `PostgresReviewSource` is enabled.

```text
id
tenant_key
source_kind
source_id
base_token
table_id
record_id
fields_json
parsed_review_json
content_hash
source_updated_at
synced_at
is_deleted
created_at
updated_at
```

Unique index:

```text
(tenant_key, source_kind, source_id, record_id)
```

### review_source_versions

```text
id
tenant_key
source_kind
source_id
version
record_count
content_hash
generated_at
created_at
```

### sync_jobs

```text
id
tenant_key
source_kind
source_id
trigger_type
status
stage
records_read
records_upserted
records_deleted
error_stage
error_message
started_at
finished_at
created_at
updated_at
```

`trigger_type`:

```text
event
schedule
manual
analysis_preflight
```

### schedules

```text
id
tenant_key
plugin_instance_id
config_id
enabled
cron
timezone
next_run_at
last_run_at
created_at
updated_at
```

## Source Performance And Upgrade Criteria

第一版 `FeishuBaseReviewSource` 必须记录读取指标：

```text
baseReadDurationMs
recordCount
pageCount
recordsPerSecond
apiRetryCount
rateLimitCount
readErrorCount
```

判断标准：

- 正常：当前分析范围读取 <= 10 秒。
- 可接受：10-30 秒。
- 偏慢：30-60 秒，需要观察。
- 不可接受：> 60 秒，或频繁限流/重试。

升级到 `PostgresReviewSource` 的触发条件：

- 单次读取 Base 超过 60 秒。
- 连续 3 次读取超过 30 秒。
- 飞书 API 出现限流，影响分析任务排队。
- 数据量达到 5 万-10 万条后分页读取明显拖慢。
- 定时分析窗口内无法稳定完成。

升级方式：

1. 新建并启用 `review_records` 读模型。
2. 运行一次全量同步，把 Base 当前评论导入 Postgres。
3. 开启事件触发同步和定时补偿同步。
4. 将该 source 的 `source_kind` 从 `feishu_base` 切为 `postgres`。
5. AI pipeline 不变，只替换 `ReviewSource` 实现。

## Data Ingestion And Sync

### Feishu Event Trigger

飞书开放平台提供多维表格记录变更事件和字段变更事件，可用于触发同步。

事件接收原则：

- webhook 接口只校验、去重、快速入队。
- 不在 webhook 请求内执行完整同步。
- 重复事件必须幂等。
- 事件失败或遗漏由定时补偿处理。

记录变更事件：

```text
drive.file.bitable_record_changed_v1
```

用途：

- 标记某个 source dirty。
- 创建 `sync_job(trigger_type='event')`。
- worker 异步读取变更后的记录或扫描受影响范围。

字段变更事件：

- 标记相关 config `schema_stale`。
- 触发字段映射校验。
- 必要时要求管理员重新确认字段映射。

### Scheduled Sync

即使启用事件，也必须有定时补偿：

- 每 5-15 分钟执行增量同步。
- 每天低峰执行一次全量校验或 hash 校验。
- 后端重启后恢复未完成 sync job，或标记 failed 并等待下一次补偿。

### Analysis Preflight Sync

当 `PostgresReviewSource` 启用后，分析前检查：

- `lastSyncedAt`
- source dirty flag
- sync lag

如果同步太旧：

- 创建 `sync_job(trigger_type='analysis_preflight')`。
- 前端显示“数据同步中”。
- 同步完成后再创建分析 job。

### Source Change Handling

新增评论：

- insert 到 `review_records`。

修改评论：

- 按 `recordId` upsert。
- 更新 `fields_json`、`parsed_review_json`、`content_hash`、`source_updated_at`、`synced_at`。
- 如果评论正文变化，旧 evidence cache 因 `content_hash` 不匹配而自动失效。

删除评论：

- 能从事件判断删除时，软删除 `is_deleted=true`。
- 不能可靠判断时，由定时全量校验发现缺失记录后软删除。

字段映射变化：

- 增加 config version。
- 重新生成 `scopeKey`。
- 必要时重新解析 `parsed_review_json`。

## Scheduler

定时任务放后端，不放 Dashboard 插件前端。

第一版可使用后端 cron/worker：

```text
schedules -> enqueue analysis job -> worker executes -> result saved
```

Feishu Workflow 可作为外部触发器，但不是必需运行时。若保留 Workflow，只传轻量信息到后端，不传 AI Key 或完整 pipeline 参数。

## Frontend Changes

前端保留：

- Dashboard lifecycle。
- `dataConditions`。
- 表/视图/字段映射配置。
- 用户筛选。
- 主题和展示组件。
- `setRendered()`。

前端移除或降级：

- AI API Key 输入。
- 直接运行 AI pipeline。
- 直接读写四张内部 Base 表。
- `customConfig.analysisCache` 作为最终结果事实源。
- 前端定时刷新缓存。

前端新增：

- 获取 `tenantKey`、`baseUserId`、`pluginInstanceId`。
- 后端配置保存状态。
- 任务状态轮询。
- 后端 latest result 加载。
- 后端错误 stage/message 展示。
- 显式导出摘要按钮。

## Result Visibility

同一用户：

- 同一 `tenantKey + baseUserId + pluginInstanceId + scopeKey` 可跨浏览器恢复同一 job/result。

不同用户：

- 默认不共享 analysis job 和 analysis result。
- 共享底层 evidence/topic cache，降低重复 AI 消耗。

管理员读取全量数据：

- 后端应用身份读取 Base 或 Postgres source。
- 不按用户 Base 权限裁剪源数据。

## Error Handling

所有失败必须带 stage：

- `load_config`
- `resolve_identity`
- `read_source`
- `sync_source`
- `read_evidence_cache`
- `extract_evidence`
- `save_evidence_cache`
- `read_topic_mapping_cache`
- `merge_topics`
- `save_topic_mapping_cache`
- `save_result`
- `export_summary`

前端展示：

- 简短中文错误。
- stage。
- 可复制 jobId。

后端日志保存：

- jobId。
- stage。
- message。
- durationMs。
- retry count。

## Migration Plan

第一阶段：后端拥有任务和结果。

- 新增 Postgres。
- 新增 config/job/result/cache repositories。
- 前端分析按钮改为创建后端 job。
- 后端仍通过 `FeishuBaseReviewSource` 读取 Base。
- 结果写 `analysis_results`。
- 前端刷新后读 latest result。

第二阶段：移除 Base 内部表写入。

- 停止自动创建 `AI分析批次`、`AI主题汇总`、`AI评论证据缓存`、`AI评论主题映射缓存`。
- 旧表不自动删除。
- 新增显式导出摘要到 Base。

第三阶段：数据源读模型可切换。

- 新增 `review_records`。
- 新增 Feishu event receiver。
- 新增 scheduled sync。
- 支持 `PostgresReviewSource`。
- 根据读取指标决定是否从 `FeishuBaseReviewSource` 切换。

第四阶段：数据采集接入。

- 新增独立采集服务或外部数据导入。
- 采集结果写 Postgres。
- 飞书 Base 可变成展示/同步目标，而不再是唯一源数据。
- 分析默认读取 Postgres。

## Testing

Unit tests:

- `scopeKey` canonicalization。
- user job lock。
- shared cache key。
- `FeishuBaseReviewSource` pagination。
- `PostgresReviewSource` filtering。
- evidence cache repository。
- topic mapping cache repository。
- job state transitions。
- source sync event idempotency。

Integration tests:

- 创建 job 后刷新页面可恢复 running job。
- job 成功后换浏览器可读取 latest result。
- 同一用户重复点击返回同一 running job。
- 不同用户同一 scope 创建不同 result，但复用 shared cache。
- Base 读取超时或限流时 job 失败并记录 stage。
- Postgres source 数据变动后 `scopeKey` 或 source version 变化。

Build verification:

```bash
npm test -- --run
npm run build
```

如果后端拆独立 package，需要增加后端 test/build/migration 验证。

## Open Decisions

已确定：

- 使用飞书应用身份读取 Base。
- 使用 Postgres。
- 方案选择后端 DB 全托管。
- 默认不自动创建四张 Base 内部表。
- 保留显式导出摘要到 Base 的能力。
- 用户维度使用 `tenantKey + baseUserId + pluginInstanceId`。
- 任务和结果按用户隔离，缓存跨用户共享。
- 后端定时任务承接调度。

保留为后续实现时确认：

- 后端服务部署位置。
- 队列实现：数据库队列、BullMQ、云队列或平台任务。
- 飞书事件订阅的具体审批、权限和回调域名配置。
- `FeishuBaseReviewSource` 第一版的 page size、retry 和 rate-limit 策略。
- Postgres schema migration 工具。
