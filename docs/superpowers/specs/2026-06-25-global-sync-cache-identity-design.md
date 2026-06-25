# Global Sync And Cache Identity Design

## Goal

把酒店评论插件的数据身份拆成两层：

- 共享数据层：原始评论镜像和 AI 中间缓存使用固定 global identity，可跨用户复用。
- 用户结果层：分析任务和最终分析结果继续按真实 `tenant_key/base_user_id/plugin_instance_id` 隔离。

这样同一张 Base 表只同步一份原始数据、只预热一份 AI 中间缓存，同时不同用户不会互相看到对方的 latest analysis result。

## Background

当前开发阶段已经发现两个问题：

1. 原始镜像 `review_records` 里同一批飞书记录因为不同 `tenant_key/source_id` 组合被重复写入。
2. 缓存命中不稳定，原因之一是分析、同步、预热使用的身份不一致，例如有的路径使用真实租户，有的路径使用 fixture identity；有的 `source_id` 是 `baseToken:tableId`，有的是 `baseToken:tableId:viewId`。

这会导致：

- 同一张 Base 表被当成多份数据源。
- 第二次点击分析仍然可能读不到第一次产生的缓存。
- 全量/增量同步、缓存预热、正式分析之间无法形成稳定闭环。

本设计把“共享数据”和“用户结果”拆开，明确身份和 source id 规则。

## Scope

本设计覆盖：

- 原始镜像层身份。
- AI 中间缓存层身份。
- 分析任务和分析结果身份。
- `source_id` 规范。
- 全量同步接口。
- 增量同步接口。
- 点击分析链路和同步链路的边界。
- `demo=1` 缓存诊断返回。
- 开发阶段历史数据处理策略。

本设计不覆盖：

- 飞书视图自身复杂筛选规则。
- 历史分裂数据的生产迁移。
- 多租户商业化权限模型。
- 飞书 record changed 事件接入。

## Identity Model

### Shared Data Identity

原始镜像层和 AI 中间缓存层统一使用项目常量：

```ts
const GLOBAL_REVIEW_SOURCE_TENANT_KEY = 'global-review-source';
```

使用该 identity 的表：

- `review_records`
- `review_source_versions`
- `evidence_cache`
- `topic_mapping_cache`
- 后续如果有缓存预热 job log，也按同一 global identity 记录源数据维度。

这些表表达的是“这张 Base 表的共享数据和共享中间产物”，不是某个用户的最终分析结果。

接口调用方不传 `tenantKey`。服务端在同步、预热和共享缓存读写时统一注入 `GLOBAL_REVIEW_SOURCE_TENANT_KEY`。

### User Result Identity

分析配置、分析任务、分析结果继续使用真实运行身份：

```text
tenant_key + base_user_id + plugin_instance_id
```

使用真实身份的表：

- `analysis_configs`
- `analysis_jobs`
- `analysis_results`
- `analysis_result_topics`
- `analysis_result_evidence`

原因：

- 不同用户点击同一个插件实例，不能互相看到 latest result。
- 同一个用户刷新页面或换浏览器，应能恢复自己的 job/result。
- 共享缓存可以降低 AI 成本，但最终结果属于一次用户分析上下文。

## Source ID Rules

### Canonical Source ID

原始镜像和 AI 中间缓存统一使用：

```text
source_id = baseToken + ':' + tableId
```

不包含：

- `viewId`
- 酒店筛选条件
- 日期筛选条件
- 关键词
- dashboard data conditions
- 用户身份

### Why View ID Is Excluded

当前页面是我们自己的插件筛选，不接入飞书视图自身复杂筛选规则。

因此：

- `viewId` 不进入原始镜像 `source_id`。
- `viewId` 不进入共享 AI 缓存 source identity。
- 酒店、日期、关键词等只在分析阶段过滤。

同一张 Base 表只应有一份原始镜像：

```text
global-review-source + feishu_base + baseToken:tableId
```

如果后续真的要支持飞书视图复杂筛选，应另开设计，不能把 `viewId` 悄悄塞回原始镜像 identity。

## Data Flow

### Full Sync

全量同步只由接口触发，不由分析按钮触发。

```text
POST /api/hotel-review-ai/sync/full
```

请求体不包含 `tenantKey`：

```json
{
  "baseToken": "DCXnbnOk0afmeFsJ0Gpcd17anK4",
  "tableId": "tbl37qjFGwC2XccK",
  "fieldMapping": {
    "reviewId": "fldxxx",
    "content": "fldxxx",
    "hotelName": "fldxxx",
    "score": "fldxxx",
    "reviewDate": "fldxxx",
    "checkInMonth": "fldxxx"
  }
}
```

服务端生成：

```ts
sourceKey = {
  tenantKey: GLOBAL_REVIEW_SOURCE_TENANT_KEY,
  sourceKind: 'feishu_base',
  sourceId: `${baseToken}:${tableId}`,
  baseToken,
  tableId,
  fieldMapping,
};
```

行为：

1. 创建一条 `sync_jobs` 记录，`mode='full'`，`trigger_type='manual_api'`。
2. 读取飞书 Base 全表记录。
3. 按 canonical source identity 写入 `review_records`。
4. 对飞书已不存在的记录做 soft delete。
5. 写入 `review_source_versions`。
6. 更新 `sync_jobs` 的统计、状态、开始时间、结束时间和耗时。

### Incremental Sync

第一版增量同步也是接口触发，不接飞书事件。

```text
POST /api/hotel-review-ai/sync/incremental
```

请求体与 full sync 相同，不包含 `tenantKey`。

行为：

1. 创建一条 `sync_jobs` 记录，`mode='incremental'`，`trigger_type='manual_api'`。
2. 扫描飞书 Base 全表记录。
3. 读取当前 DB active records。
4. 按 `recordId + contentHash + mappedFields` 对比差异。
5. 只 upsert 新增和变化的记录。
6. 对飞书缺失的 DB active records 做 soft delete。
7. 未变化记录不写入。
8. 写入新的 `review_source_versions`。
9. 更新 `sync_jobs` 的统计、状态、开始时间、结束时间和耗时。

增量同步的“增量”指 DB 写入增量，不是飞书 API 读取增量。第一版仍然扫描飞书全量记录，用来保证结果可验证、逻辑简单。

## Sync Job Logging

每次 full/incremental sync 都必须落库记录触发历史。

`sync_jobs` 至少记录：

- `id`
- `tenant_key = global-review-source`
- `source_kind = feishu_base`
- `source_id = baseToken:tableId`
- `source_key_hash`
- `mode = full | incremental`
- `trigger_type = manual_api`
- `status = queued | running | success | failed`
- `stage`
- `records_read`
- `records_upserted`
- `records_deleted`
- `records_unchanged`
- `started_at`
- `finished_at`
- `duration_ms`
- `error_stage`
- `error_message`
- `created_at`
- `updated_at`

其中 `duration_ms` 必须写入数据库，不能只靠查询时临时计算。

## Analysis Button Boundary

点击分析只做分析，不做同步。

点击分析允许做：

1. 保存或 upsert 当前用户的 backend config。
2. 创建当前用户的 analysis job。
3. worker 从 Postgres read model 读取 canonical source data。
4. 按插件筛选条件过滤评论。
5. 读取 shared AI caches。
6. 对 cache miss 部分调用 AI。
7. 保存 shared AI caches。
8. 保存当前用户隔离的 analysis result。
9. 前端轮询并展示当前用户结果。

点击分析不允许做：

- full sync。
- incremental sync。
- `analysis_preflight` sync。
- 飞书 event sync。
- 任何隐式从飞书 Base 拉全量再写 `review_records` 的逻辑。

改造后应通过代码扫描确认这些字符串没有活跃调用路径：

```bash
rg "analysis_preflight|preflightSyncRunner|record-changed|handleFeishuRecordChangedEvent"
```

如果历史类型或文档仍保留，必须确认它们不在运行路径中。

## Cache Identity

AI 中间缓存使用与原始镜像一致的 global identity：

```text
tenant_key = global-review-source
source_kind = feishu_base
source_id = baseToken:tableId
```

证据缓存 key 继续包含：

- `tenant_key`
- `source_kind`
- `source_id`
- `record_id`
- `content_hash`
- `model`
- `extractor_version`

主题映射缓存 key 继续包含：

- `tenant_key`
- `source_kind`
- `source_id`
- `candidate_hash`
- `model`
- `mapper_version`

筛选条件不进入 cache identity。因为缓存的是评论级证据和候选主题映射，不是某次筛选后的最终汇总。

## Demo Cache Diagnostics

当 URL 包含：

```text
demo=1
```

每次点击分析完成后，前端展示本次分析的缓存诊断。

后端在 analysis summary 中返回：

```ts
type CacheDiagnostics = {
  triggered: boolean;
  layers: Array<'evidence_cache' | 'topic_mapping_cache'>;
  evidenceCache: {
    requested: number;
    hits: number;
    misses: number;
    hitRate: number;
  };
  topicMappingCache: {
    requested: number;
    hits: number;
    misses: number;
    hitRate: number;
  };
  aiTriggered: {
    evidenceExtraction: boolean;
    topicMapping: boolean;
  };
};
```

前端只在 `demo=1` 时展示：

```text
缓存诊断
证据缓存：命中 180 / 220，命中率 81.8%
主题映射缓存：命中 12 / 15，命中率 80.0%
本次触发层：evidence_cache, topic_mapping_cache
本次是否调用 AI：证据抽取 是；主题归并 是
```

非 `demo=1` 时不展示这块 UI，但后端仍可以把字段存在 summary 中，方便日志和调试。

## Historical Data Strategy

当前仍是开发阶段，不做历史数据兼容和迁移。

处理策略：

1. 不迁移旧的 `review_records`。
2. 不迁移旧的 `review_source_versions`。
3. 不迁移旧的 `evidence_cache`。
4. 不迁移旧的 `topic_mapping_cache`。
5. 不保留旧的 `tenant_key/source_id` 分裂数据作为可命中缓存。
6. 切到 global identity 后，通过 full sync 重建原始镜像。
7. 通过 warmup 或首次分析重建 AI 中间缓存。

开发环境可以直接清理这些共享层历史数据：

```sql
delete from review_records;
delete from review_source_versions;
delete from evidence_cache;
delete from topic_mapping_cache;
```

用户结果层是否清理另行决定。默认不把 `analysis_results` 作为共享缓存迁移对象，因为它仍然按真实用户身份隔离。

如果后续进入生产阶段，需要另写 migration plan，不能沿用本开发阶段清库策略。

## API Contract Summary

### Full Sync

```text
POST /api/hotel-review-ai/sync/full
```

```json
{
  "baseToken": "DCXnbnOk0afmeFsJ0Gpcd17anK4",
  "tableId": "tbl37qjFGwC2XccK",
  "fieldMapping": {
    "reviewId": "fldxxx",
    "content": "fldxxx",
    "hotelName": "fldxxx"
  }
}
```

### Incremental Sync

```text
POST /api/hotel-review-ai/sync/incremental
```

```json
{
  "baseToken": "DCXnbnOk0afmeFsJ0Gpcd17anK4",
  "tableId": "tbl37qjFGwC2XccK",
  "fieldMapping": {
    "reviewId": "fldxxx",
    "content": "fldxxx",
    "hotelName": "fldxxx"
  }
}
```

### Sync Response

接口返回 queued job，不同步等待任务跑完：

```json
{
  "jobId": "sync-job-id",
  "mode": "full",
  "tenantKey": "global-review-source",
  "sourceKind": "feishu_base",
  "sourceId": "DCXnbnOk0afmeFsJ0Gpcd17anK4:tbl37qjFGwC2XccK",
  "status": "queued",
  "stage": "queued",
  "createdAt": "2026-06-25T10:00:00.000Z"
}
```

worker 完成后 `sync_jobs` 里能看到最终统计和耗时。

## Open Questions

当前没有需要阻塞实现的问题。

已确认：

- 飞书视图复杂筛选不用管。
- 页面筛选是插件自己的筛选。
- `GLOBAL_REVIEW_SOURCE_TENANT_KEY` 写项目常量。
- 同步接口不传 `tenantKey`。
- 开发阶段不做历史数据迁移，按新 identity 重建。

## Verification Plan

实现时至少验证：

1. 分析按钮不会创建 sync job。
2. 分析按钮不会调用 full/incremental sync。
3. `/sync/full` 会创建 full sync job。
4. `/sync/incremental` 会创建 incremental sync job。
5. 两个同步接口都不接受调用方传入的 `tenantKey` 作为最终写库 identity。
6. `source_id` 始终是 `baseToken:tableId`。
7. `viewId` 不进入原始镜像和 AI 中间缓存 source identity。
8. `sync_jobs.duration_ms` 在成功和失败时都会记录。
9. incremental sync 对未变化记录不写入，并记录 `records_unchanged`。
10. `demo=1` 点击分析后展示本次 evidence/topic cache 命中率。
11. 非 `demo=1` 不展示缓存诊断 UI。
12. `npm test -- --run` 通过。
13. `npm run build` 通过。
14. `rg "analysis_preflight|preflightSyncRunner|record-changed|handleFeishuRecordChangedEvent"` 没有活跃运行路径。
