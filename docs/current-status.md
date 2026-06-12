# 酒店评论 AI 仪表盘插件当前状态

## V1.2 更新

更新时间：2026-06-11

当前目录：

```bash
/Users/yxk/Documents/Codex/2026-06-03/spec-users-yxk-documents-codex-2026-2/work/hotel-review-ai-dashboard-plugin-v1.2
```

V1.2 将分析链路从 `topic -> recordIds` 调整为 `record -> quote evidence -> topic`：

- AI 批处理只抽取 `evidenceItems`，每条证据包含 `recordId`、`quote`、`sentiment`、`aspectLabel`。
- 程序校验 `recordId` 必须存在，`quote` 必须能在评论正文 `content` 中命中。
- 全局主题归并阶段返回 `topicGroups`，明确拆分 `category`、`mergeKey`、`displayTopic`，并在成员级别返回 `acceptedQuotes`，同一 `aspectLabel` 里混入的无关 quote 会被剔除，避免“雪花酥”这类证据挂到“地理位置”主题。
- 评论可以贡献多个证据；同一条评论既有好评也有负面细节时，会同时计入好评主题和风险主题，并进入 `mixedReviews`。
- 主题命中数由程序按去重后的 `commentRecordIds` 重算，不再相信 AI 返回的 count。
- 写回 `AI主题汇总` 时新增 `证据片段 JSON`，方便追溯主题证据。

已验证：

```bash
npm test -- --run
npm run build
```

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
