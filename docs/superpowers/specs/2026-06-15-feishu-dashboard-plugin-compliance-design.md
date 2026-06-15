# Feishu Dashboard Plugin Compliance Design

## Goal

将当前 `hotel-review-ai-dashboard-plugin-v1.2` 收敛成合规的飞书多维表格 Dashboard 插件。保留现有酒店评论 AI 聚合分析能力，优先修正插件生命周期、配置协议、数据范围、字段映射、配置保存、宿主事件监听、主题与全屏适配。

## Background

本项目已经使用 React、Vite、TypeScript、Semi dashboard theme 和 `@lark-base-open/js-sdk@1.0.2`，并已有 runtime adapter、本地 fixture/CSV、AI 分析、缓存、写回和测试。项目内飞书资料提供了两个可参考示例：

- `docs/多维表格仪表盘插件开发资料/examples/Count-Down`：可参考主题、`customConfig` 和 `onConfigChange` 写法。
- `docs/多维表格仪表盘插件开发资料/examples/radar_chart_demo`：可参考 `Create` / `Config` / `View` / `FullScreen`、`getPreviewData`、`getData` 和 `saveConfig(dataConditions)` 写法。

这些资料没有提供可直接迁移业务逻辑的插件框架，因此本次不重开项目模板，而是在当前项目上做插件协议完整收敛。

## Non-Goals

- 不做后端代理。
- 不做飞书自动化定时分析。
- 不做插件中心上架材料。
- 不迁移到 `Count-Down` 或 `radar_chart_demo` 模板。
- 不大规模重做 UI；只做飞书 Dashboard 容器所需的适配和必要交互收敛。
- 不使用兜底逻辑掩盖 SDK、权限、字段类型、保存失败或数据范围问题。

## Product Scope

插件继续服务“小范围几个人使用”的酒店评论 AI 聚合分析场景：

- 用户在配置态选择数据表、数据范围和字段映射。
- 插件按当前配置范围读取评论，手动触发 AI 聚合分析。
- 插件展示好评点、差评点、统计概览、行动建议和评论证据。
- 分析结果缓存到插件配置中，重新打开插件后可展示已缓存结果。
- 用户点击保存配置时必须真实保存到飞书插件配置；失败时明确报错。

## Architecture

继续沿用当前结构：

- `src/runtime/sdk.ts`：封装真实飞书 SDK 与本地 fixture runtime。
- `src/services/*`：保留记录读取、过滤、AI 分析、缓存、写回和统计逻辑。
- `src/components/*`：保留现有展示组件，局部调整配置面板、状态提示和容器适配。
- `src/styles/*`：保留现有视觉基底，补齐飞书主题、全屏和尺寸适配。

新增或调整的核心设计单元：

- Dashboard config builder：从 `PluginConfig` 生成合规 `dataConditions`。
- Field auto-mapper：基于字段名和别名自动预填字段映射。
- Config validator：保存前验证表、数据范围、必需字段、AI 配置。
- Host event bridge：统一处理 `onConfigChange`、`onDataChange`、`onThemeChange`。

## Dashboard Lifecycle

### Create

`Create` 状态下插件相关数据未落库，不能调用 `dashboard.getConfig()` 或 `dashboard.getData()`。

行为：

- 初始化默认草稿配置。
- 读取当前 Base 表列表。
- 若存在表，默认选择第一张表或当前默认配置能匹配的表。
- 读取表的数据范围和字段列表。
- 按字段名/别名自动预填字段映射。
- 展示配置面板和预览区域。
- 配置未完整时展示明确引导，不尝试分析。

### Config

`Config` 状态用于配置修改和预览。

行为：

- 调用 `dashboard.getConfig()` 读取已保存配置。
- 用户修改数据源、数据范围或字段映射后，刷新配置草稿。
- 使用 `dashboard.getPreviewData(dataConditions)` 验证 Dashboard 数据源配置是否可计算。
- 保存时调用 `dashboard.saveConfig({ dataConditions, customConfig })`。

### View

`View` 状态只展示结果，不显示配置面板。

行为：

- 调用 `dashboard.getConfig()` 读取配置。
- 调用 `dashboard.getData()` 获取宿主计算数据，用于判断宿主数据条件是否可用。
- 加载 `customConfig.analysisCache` 展示缓存结果。
- 如果数据源或筛选变化导致缓存过期，展示“需要重新分析”的提示。

### FullScreen

`FullScreen` 与 `View` 使用同一业务逻辑，但 UI 必须适配深色和透明背景。

行为：

- 设置 `theme-mode="dark"` 或等价 class。
- 保证 `html` 和 `body` 背景透明。
- 保持组件在全屏尺寸下不溢出、不重叠。

### Render Completion

初始化、配置预览、分析完成、证据弹窗记录加载完成后调用 `dashboard.setRendered()`。如果某一步失败，也应在错误状态渲染完成后调用 `setRendered()`，让自动化截图能拿到稳定画面。

## Configuration Model

保存配置必须同时包含 `dataConditions` 和 `customConfig`。

`dataConditions` 存储飞书 Dashboard 数据源配置：

- `tableId`
- `dataRange`
- `groups`
- `series`

`customConfig` 存储业务自定义配置：

- 字段映射。
- 用户筛选条件。
- AI API 配置。
- 写回配置。
- 分析缓存。

`dataConditions` 中必须包含表结构相关信息，保证复制 Base 或宿主映射时插件可恢复配置。

## Data Conditions

插件需要构造一个稳定的数据条件：

- `tableId` 使用用户选择的数据表。
- `dataRange` 使用用户选择的全部数据或视图范围。
- 默认不在 `dataConditions` 中做业务聚合分组，避免将长评论正文交给宿主聚合导致计算量或结果体积异常。
- 如果为了宿主字段依赖需要设置 `groups`，优先使用评论 ID 这类稳定短字段，不使用评论正文作为分组字段。
- `series` 使用 `'COUNTA'`，用于让宿主计算当前数据范围的记录数量。

`getPreviewData` 和 `getData` 的结果不是评论正文来源。它们用于验证 Dashboard 数据源配置、响应宿主筛选变化和判断缓存是否过期。

## Field Mapping

字段名不固定，因此配置面板必须支持手动选择字段。

选表后自动执行字段预填：

- 拉取字段列表。
- 根据字段名和别名匹配必需字段。
- 匹配成功时自动填入。
- 匹配不成功时保留为空，并要求用户手动选择。

必需字段：

- 评论 ID
- 评论内容
- 酒店名称
- 评分
- 评论日期
- 入住日期
- 回复内容
- 房型

推荐别名规则：

- 评论 ID：`评论ID`、`评论 ID`、`reviewId`、`review_id`、`id`
- 评论内容：`评论内容`、`内容`、`comment`、`content`、`review`
- 酒店名称：`酒店名称`、`酒店`、`hotelName`、`hotel_name`、`hotel`
- 评分：`评分`、`score`、`rating`
- 评论日期：`评论日期`、`评论时间`、`reviewDate`、`review_date`、`commentDate`
- 入住日期：`入住日期`、`入住月份`、`checkInMonth`、`check_in_month`、`checkInDate`
- 回复内容：`酒店回复内容`、`回复内容`、`replyContent`、`reply`
- 房型：`房型`、`roomType`、`room_type`

保存前必须校验必需字段均已绑定。缺字段时阻止保存并展示具体缺失项，不猜测、不默认到其他字段。

## Data Range And Host Filters

插件必须尊重用户配置的数据范围和仪表盘全局筛选。

行级评论读取的原则：

- 优先按 `dataRange` 中的 view 读取记录。
- 若 `dataRange` 带有 `filterInfo`，应在 SDK 支持范围内等价应用。
- 若飞书 Dashboard 全局筛选只能反映在 `getData()` 计算结果中，而行级 API 无法获取完全等价的筛选后记录，插件必须显式提示当前行级分析范围无法完全等同宿主筛选。
- 在无法等价应用宿主筛选时，不能把全表数据混入分析并标记为“已按宿主筛选”。

缓存有效性必须包含：

- 表 ID。
- 数据范围。
- 字段映射。
- 用户筛选条件。
- AI model。
- 分析 copy version。
- 宿主数据变更信号。

## AI Configuration

本阶段为小范围自用，允许前端配置并保存 AI API 信息。

要求：

- 代码中不再硬编码默认 API Key。
- `API Base URL`、`API Key`、`Model` 由用户在配置面板填写。
- 点击“保存配置”必须写入 `customConfig.ai`。
- API Key 为空时不能执行测试连接或分析，直接提示用户填写。
- 保存失败必须显示错误。

后续如果需要公开上架或多人使用，再单独设计后端代理，不纳入本次 scope。

## Host Events

插件需要持有宿主事件监听。

`onConfigChange`：

- 更新本地配置状态。
- 重新加载数据范围、字段列表和缓存状态。

`onDataChange`：

- 标记当前分析缓存可能过期。
- 刷新当前数据条件下的记录选项。
- 不自动消耗 AI token 重新分析。

`onThemeChange`：

- 更新 `theme-mode`。
- 更新 CSS token 或 class。
- 保持全屏深色和普通模式一致。

所有监听必须在组件卸载时注销。

## UI Adjustments

UI 只做必要飞书适配。

配置态：

- 左侧保留当前预览和状态展示。
- 右侧配置面板按“数据源”“字段映射”“AI API”“写回设置”分组。
- 字段映射区域展示自动匹配结果和缺失项。
- 保存按钮明确执行 `dashboard.saveConfig`。

展示态：

- 隐藏配置面板。
- 保留概览、主题榜、行动建议、证据弹窗。
- 当配置缺失、API Key 缺失、缓存过期、数据范围不支持时展示明确状态。

视觉：

- 保持现有 UI 基本结构。
- 避免营销页式布局。
- 适配飞书 Dashboard 容器宽度、全屏深色和透明背景。
- 防止文本、按钮、表格、弹窗在小宽度下溢出或重叠。

## Error Handling

错误必须暴露根因，不使用兜底掩盖。

需要明确展示的错误：

- `Create` 状态误调用禁用 API。
- `getConfig`、`getPreviewData`、`getData`、`saveConfig`、`setRendered` 失败。
- 数据表不存在。
- 数据范围不存在或不支持。
- 必需字段未映射。
- 字段类型或单元格值无法解析。
- API Key 缺失。
- AI API 请求失败或返回 schema 不合法。
- 写回权限不足。

本地 fixture 可以保留开发期 localStorage；真实飞书宿主里保存失败不能写 localStorage 兜底。

## Verification

常规验证：

- `npm test -- --run`
- `npm run build`

本地预览验证：

- `?state=Create`
- `?state=Config`
- `?state=View`
- `?state=FullScreen`

检查项：

- `Create` 状态不调用 `getConfig/getData`。
- `Config` 状态保存后 `dataConditions` 和 `customConfig` 均存在。
- 字段可按名称/别名自动预填，缺失字段会阻止保存。
- 代码中没有硬编码 API Key。
- 保存配置后重新打开可恢复 API 配置和字段映射。
- 缓存过期提示能响应数据或配置变化。
- 全屏深色模式背景透明且内容不溢出。

飞书宿主验证：

- 通过“添加自定义插件”添加本地或部署后的插件地址。
- 首次添加进入配置态。
- 保存配置后进入展示态。
- 重新打开插件能加载已保存配置。
- 切换 view 或宿主筛选后缓存状态正确变化。
- 全屏模式可用。

## Acceptance Criteria

- 插件在 `Create`、`Config`、`View`、`FullScreen` 四种状态均符合 Dashboard API 限制。
- 配置保存使用 `dashboard.saveConfig`，且保存内容包含 `dataConditions` 与 `customConfig`。
- 用户可以手动映射字段，系统会自动预填能匹配的字段。
- 数据读取和分析遵守配置的数据范围；无法完全遵守宿主全局筛选时明确提示。
- AI Key 不再硬编码，用户填写后可保存并用于测试连接和分析。
- 真实 SDK 错误、字段错误、权限错误和保存错误不会被兜底吞掉。
- UI 保持当前业务结构，并完成飞书 Dashboard 容器必要适配。
