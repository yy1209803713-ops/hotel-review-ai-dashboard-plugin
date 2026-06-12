# 多维表格仪表盘插件开发资料包

生成时间：2026-06-03 16:05 左右  
资料目录：`/Users/yxk/mydata/文档/多维表格仪表盘插件开发资料`

## 已下载内容

### docs

- `docs/多维表格-仪表盘插件-开发指南.md`  
  原始本地指南的副本。
- `docs/Base-JSSDK-Dashboard-插件-API-文档.md`  
  使用旧版 `docs +fetch` 导出的 Markdown 快照。
- `docs/Base-JSSDK-Dashboard-插件-API-文档.v2.xml`  
  使用 `lark-cli docs +fetch --api-version v2` 导出的 XML 快照。
- `docs/base-jssdk-dashboard-api.raw.json`
- `docs/base-jssdk-dashboard-api.v2.raw.json`
- `docs/Base-开放设计规范.md`
- `docs/Base-开放设计规范.v2.xml`
- `docs/base-open-design-spec.raw.json`
- `docs/base-open-design-spec.v2.raw.json`
- `docs/Base-JS-SDK-docs-index.html`
- `docs/Base-JS-SDK-dashboard-page.lean.js`
- `docs/semi-design-introduction.html`
- `docs/images/`  
  指南中的 20 张图片全部下载成功，映射表为 `docs/images/images-manifest.tsv`。
- `docs/js-sdk-pages/`  
  公开 Base JS SDK 站点常用页面的 VitePress `lean.js` 快照，共 19 个页面。

### examples

- `examples/Count-Down`  
  GitHub 示例仓库 `Lark-Base-Team/Count-Down`，当前 HEAD：`440460a`。
- `examples/radar_chart_demo`  
  GitHub 示例仓库 `Lark-Base-Team/radar_chart_demo`，当前 HEAD：`20725d3`。

### sdk

- `sdk/packages/`  
  已下载 6 个 SDK tarball：
  - `lark-base-open-js-sdk-0.4.0-alpha.1.tgz`
  - `lark-base-open-js-sdk-0.4.0-alpha.5-bytedns.tgz`
  - `lark-base-open-js-sdk-0.4.0-alpha.12-bytedns.tgz`
  - `lark-base-open-js-sdk-0.4.1-alpha.4.tgz`
  - `lark-base-open-js-sdk-0.4.1-beta.5-bytedns.tgz`
  - `lark-base-open-js-sdk-1.0.2.tgz`
- `sdk/types/`  
  已从上述 SDK 中提取 6 份 `index.d.ts`。
- `sdk/style/`  
  已提取可用的 `dashboard.css`。

## 已验证

- SDK tarball：已用 `tar -tzf` 验证，全部可正常解包。
- 指南图片：20 张全部下载成功，0 失败。
- JS SDK 常用页面快照：19 个页面已下载。
- 示例仓库：两个 Git 仓库均已克隆，并记录 HEAD。
- 当前 `lark-cli --version`：`1.0.46`，`docs +fetch` 已支持 `--api-version v2`。

## 后续开发判断

这些资料已经足够开始开发一个多维表格仪表盘插件。关键依据：

- 有可运行的 React/Vite 示例工程。
- 有 Dashboard API 文档和 SDK 类型定义。
- 有 `Create` / `Config` / `View` / `FullScreen` 状态说明。
- 有 `getConfig` / `saveConfig` / `getPreviewData` / `getData` / `setRendered` / `onDataChange` / `onConfigChange` / `getTheme` / `onThemeChange` 类型定义。
- 有 UI 布局、配置区、全屏深色模式、发布检查项和数据安全要求。

建议后续新插件优先从 `examples/Count-Down` 或一个新建 Vite React 项目开始，并根据需求决定使用 `@lark-base-open/js-sdk@1.0.2` 还是示例当前依赖的 CDN `0.4.1-beta.5`。开工前需要在飞书仪表盘宿主里实测最终选定版本。

## 未下载或不建议自动下载的链接

以下内容不是核心开发必需，或需要账号/交互权限，因此未批量下载：

- 发布表单、需求表单、需求汇总 Base。
- 交流群链接。
- Figma 模板和设计资源。
- i18n 翻译 Bot。
- Remix Icon、IconPark 等外部图标站点。
- Replit 预览/发布页面。

