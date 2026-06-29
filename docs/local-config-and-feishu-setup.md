# 本地配置与飞书侧配置

## 1. 本地配置文件

在仓库根目录创建 `.env.local`，按需填写：

```bash
LARK_BASE_AUTH_CODE=pt_xxx
AI_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
AI_API_KEY=sk_xxx
AI_MODEL=qwen-plus
AI_TEMPERATURE=0.2
AI_MAX_BATCH_SIZE=10
AI_BATCH_CONCURRENCY=3
AI_REQUEST_TIMEOUT_SECONDS=600
AI_TOP_N=10
WARMUP_SECRET=local-warmup-secret
VITE_BACKEND_ENDPOINT_URL=http://127.0.0.1:8787
```

说明：

- `LARK_BASE_AUTH_CODE` 是飞书多维表格自定义插件里的授权码，只给后端用。
- `AI_BASE_URL` / `AI_API_KEY` / `AI_MODEL` 是后端真实调用大模型用的配置。没有这些配置时，后端分析会在 `extract_evidence` 阶段失败，不会生成本地假结果。
- `AI_TEMPERATURE`、`AI_MAX_BATCH_SIZE`、`AI_BATCH_CONCURRENCY`、`AI_REQUEST_TIMEOUT_SECONDS`、`AI_TOP_N` 是后端分析参数，不填时使用项目默认值。
- `WARMUP_SECRET` 给插件按钮和飞书工作流调用后端 warmup 接口用。
- `VITE_BACKEND_ENDPOINT_URL` 只用于前端默认填充 `Backend Endpoint`。
- shell 里手动设置的同名环境变量优先于 `.env` / `.env.local`。

## 2. Base Token 是什么

这里的 `Base Token` 就是多维表格 URL 里的那段 Base 标识，通常也会被文档/API 叫作 `app_token`。

获取方式：

1. 打开目标多维表格。
2. 从浏览器地址栏复制 Base URL。
3. 取 `/base/` 后面、`?` 前面的那段字符串。

例如：

```text
https://bytedance.feishu.cn/base/QtTUxxxx?table=tblxxx&view=vewxxx
```

其中 `QtTUxxxx` 就是要填到插件里的 `Base Token`。

## 3. 飞书后台要配什么

1. 打开目标多维表格，在「自定义插件」里获取授权码。
2. 把这个授权码填到本地 `.env.local` 的 `LARK_BASE_AUTH_CODE`，不要放进前端。
3. 把大模型地址、Key 和模型名填到 `.env.local` 的 `AI_BASE_URL`、`AI_API_KEY`、`AI_MODEL`。
4. 把后端服务地址填到插件的 `Backend Endpoint`。
5. 把上面的 `Base Token` 填到插件的 `Base Token`。
6. 插件里的 `Model` 需要和后端 `AI_MODEL` 保持一致，用于任务 scope/cache 标识；API Key 和 Base URL 不在飞书插件里填写。
7. 如果你只做这套后端读写，不需要先走新建飞书应用那条路。

## 4. 启动

```bash
npm run server
npm run dev -- --host 127.0.0.1 --port 5173
```

如果要让飞书工作流打到本地后端，后端地址不能用 `127.0.0.1`，需要换成公网可访问地址或 tunnel。

这次妙搭部署里的完整经验和正确外部 curl 也整理在 [docs/feishu-miaoda-deployment-notes.md](./feishu-miaoda-deployment-notes.md)。
