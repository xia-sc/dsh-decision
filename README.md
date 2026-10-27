# @xia-sc/dsh-decision

[![npm version](https://img.shields.io/npm/v/@xia-sc/dsh-decision.svg)](https://www.npmjs.com/package/@xia-sc/dsh-decision)
[![npm downloads](https://img.shields.io/npm/dm/@xia-sc/dsh-decision.svg)](https://www.npmjs.com/package/@xia-sc/dsh-decision)
[![license](https://img.shields.io/npm/l/@xia-sc/dsh-decision.svg)](LICENSE)
[![publish](https://github.com/xia-sc/dsh-decision/actions/workflows/publish.yml/badge.svg)](https://github.com/xia-sc/dsh-decision/actions/workflows/publish.yml)

把 [Decision 3.0](https://decision.vllm-sr.ai/)（vLLM Semantic Router 的 System One 决策 API）接进 DeepSeek Harness：
让 Agent 能对一段文本 / 图片 / 视频**问带选项的问题**，拿回的是**校准概率**而不是生成文本；同时在 Web UI 里给出可视化的概率条和设置页。

> 决策模型不生成文字，它一次前向就回答"哪个选项 / 是或否 / 几分 / 在图里哪里"，并给出每个答案的概率与置信度。

## 目录

- [1. 它做什么](#1-它做什么)
- [2. 安装与配置](#2-安装与配置)
  - [2.1 给 Agent 的安装与验证步骤](#2-1-给-Agent-的安装步骤)
- [3. 工作原理](#3-工作原理)
- [4. 什么时候触发](#4-什么时候触发)
- [5. 如何实现](#5-如何实现)
- [6. 工具参数与返回](#6-工具参数与返回)
- [7. 服务端限制](#7-服务端限制)
  - [7.1 性能实测](#7-1-性能实测)
- [8. 排查](#8-排查)
- [9. 已知边界](#9-已知边界)
- [10. 兼容性](#10-兼容性)
  - [10.1 运行环境](#10-1-运行环境)
  - [10.2 依赖的 Harness 扩展点](#10-2-Harness-扩展点)
  - [10.3 Decision API 依赖](#10-3-Decision-API)
  - [10.4 版本矩阵](#10-4-版本矩阵)
  - [10.5 发布与安装形态](#10-5-发布与安装形态)
  - [10.6 已知不兼容 / 限制](#10-6-已知不兼容)

-----

<a id="1-它做什么"></a>
## 1. 它做什么

| 能力 | 入口 | 形态 |
|---|---|---|
| 多类型决策（choice / noul / score / box） | Agent 工具 `decision_ask` | 一次请求问多个问题，返回概率、置信度、框选坐标 |
| 服务洞察（模型表 / 配额 / 状态） | Agent 工具 `decision_info` | `models` · `usage` · `status` |
| 概率可视化 | 对话内卡片 | 长在 `decision_ask` 的工具调用行里，画概率条 |
| Key / 默认模型 / 用量管理 | Settings → 决策模型 | 同源路由读写，Key 不下发浏览器 |

典型用法：分类路由、二选一判定、0–10 档打分、图片目标定位、给候选答案打分后由外层挑选。

<a id="2-安装与配置"></a>
## 2. 安装与配置

```text
# 从 npm 安装（已发布：https://www.npmjs.com/package/@xia-sc/dsh-decision）
plugin_manager action=install_bundle target=@xia-sc/dsh-decision

# 或者从本地目录安装（开发：link 到本目录，改代码即时生效）
plugin_manager action=install_bundle target=<本目录绝对路径>
```

Host 端零 npm 依赖、无需构建；安装后整页刷新（`Ctrl+R`）即可看到设置页与卡片。

| 项目 | 位置 | 默认值 |
|---|---|---|
| API Key | DSH 凭据 `DECISION_API_KEY`（设置页写入），或环境变量 `DECISION_API_KEY` | 无（未配置时工具返回可读错误） |
| 默认模型 | `$DSH_HOME/.dsh-decision.json` 的 `model` | `vllm-sr/d3-flash` |
| 服务地址 | `$DSH_HOME/.dsh-decision.json` 的 `baseUrl` | `https://decision.vllm-sr.ai` |
| 卡片结果缓存 | `$DSH_HOME/.dsh-decision-results.json` | 200 条 / 1 小时，自动清理 |

<a id="2-1-给-Agent-的安装步骤"></a>
### 2.1 给 Agent 的安装与验证步骤

这一节写给**执行安装的 Agent**：每步都有可判断的成功标志和失败处理，不要跳过验证步骤，也不要把 API Key 写进任何文件。

**第 0 步 — 前置检查**

- 确认插件目录是本包根（同时存在 `package.json`、`cordis.patch.yml`、`index.js`、`client.js`），记下它的**绝对路径** `<PLUGIN_DIR>`。
- 确认 `package.json` 的 `name` 是 `@xia-sc/dsh-decision`，`dsh.bundle.patch` 指向 `./cordis.patch.yml`。
- 不需要 `npm install`、不需要构建（Host 零依赖，Client 只 `require('react')`）。

**第 1 步 — 安装 bundle**

```text
plugin_manager(action: "install_bundle", target: "<PLUGIN_DIR>")
```

成功标志：返回 `"application": "applied"`（若为 `restart-required`，提示用户重启 Harness；若为 `failed`，读 `error.code` 后停止，不要重复安装）。

**第 2 步 — 确认工具已注册**

```text
cordis_inspect_query(platform: "host", provider: "Tool", method: "listTools")
```

成功标志：结果里同时出现 `decision_ask` 与 `decision_info`。这两个是免审批的只读查询，优先用它而不是 `list_plugins`。

**第 3 步 — 确认 Client 半区已加载**

```text
cordis_inspect_query(platform: "client", provider: "Slots", method: "listSubTree",
                     input: { "root": "settings.section" })
```

成功标志：`occupants` 里出现 `id: "dsh-decision", order: 60, active: true`；再查 `root: "tool.call.toolview"`，`occupants` 里出现 `key: "decision_ask"`。

若 Host 通过但这里缺失：Client bundle 没加载，让用户**整页重载**（`Ctrl+R`）后再查；仍缺失则检查 `client.js` 语法与 `dsh.client` 字段。

**第 4 步 — 确认同源路由已注册**

取当前 webServer 端口（GUI URL 的端口，或 `webApp.getAdvertisedUrl()`），然后：

```text
GET http://127.0.0.1:<PORT>/dsh-decision/status
```

成功标志：`200`，响应是 JSON 且含 `models` 数组、`keyConfigured`、`diagnostics`。

- `404/405` → 路由未注册（冷启动竞态）：`plugin_manager` 里对该 row 先 `enabled: false` 再 `enabled: true`，重试。
- `403` → 请求带了跨站标记或非回环 Host：用回环地址、不要伪造 `Origin`。

**第 5 步 — 配置 API Key（需要用户提供）**

```text
POST http://127.0.0.1:<PORT>/dsh-decision/config
content-type: application/json

{ "apiKey": "sk-vsr-..." }
```

成功标志：`200` 且返回的 `keyConfigured` 为 `true`、`keyPrefix` 是掩码（`sk-vsr-abc…yz`）。
`400 key rejected` 表示 key 无效或已吊销；`400 API key should look like…` 表示格式不对。**不要**把 key 写入 README、脚本、`cordis.patch.yml` 或 shell 历史。

**第 6 步 — 端到端冒烟**

1. 调用一次 `decision_ask`，最小参数：

   ```jsonc
   { "state": "ping", "questions": { "ok": { "type": "noul", "instructions": "Is this a test?" } } }
   ```

   成功标志：工具返回含 `answers.ok.noul`（0–1 之间）与 `usage.input_tokens`。
2. 调用 `decision_info`（`action: "models"`），成功标志：返回 7 个模型与 limits。

**第 7 步 — 报告**

向用户报告：安装结果（`applied`）、工具是否可见、路由是否 200、Key 是否配置成功、冒烟结果；**只在报告里写 key 的掩码前缀**，不写原文。

**回滚**

```text
plugin_manager(action: "set_plugin", target: "<entryId>", enabled: false)
```

`<entryId>` 形如 `include:dsh-decision`（用 `list_plugins` 精确确认）。彻底移除用 `remove_bundle`。

**验收清单（全部为“是”才算装好）**

- [ ] `application: applied`
- [ ] `Tool.listTools` 含 `decision_ask` / `decision_info`
- [ ] `settings.section` 有 `dsh-decision`、`tool.call.toolview` 有 `decision_ask`
- [ ] `GET /dsh-decision/status` 返回 200 且含 `models`
- [ ] `keyConfigured: true`（用户提供了 key 时）
- [ ] 一次 `decision_ask` 返回概率、一次 `decision_info models` 返回模型表

<a id="3-工作原理"></a>
## 3. 工作原理

<a id="3-1-两个半区"></a>
### 3.1 两个半区

插件是一个 bundle，包含 Host 与 Client 两半，通过 **同源 HTTP 路由**（而不是 typert Remote）通信：

```text
┌──────────────────────────── Host 进程 ────────────────────────────┐
│ index.js                                                          │
│  ├─ ctx.tools.register(decision_ask)   ── Agent 工具（模型可见）    │
│  ├─ ctx.tools.register(decision_info)                             │
│  ├─ ctx.inject(['webServer']) → 5 条路由                          │
│  │    GET  /dsh-decision/status         设置页数据（快，20s 缓存）  │
│  │    GET  /dsh-decision/usage          配额用量（慢，独立请求）    │
│  │    POST /dsh-decision/config         保存 Key / 默认模型        │
│  │    GET  /dsh-decision/result?callId  卡片取结构化结果           │
│  │    POST /dsh-decision/client-report  客户端异常上报（仅异常）    │
│  ├─ 密钥：ctx.credentials(REF) → env → 文件                        │
│  └─ 缓存：内存 Map + $DSH_HOME/.dsh-decision-results.json          │
│                          │ fetch /v1/systemone（带 X-API-Key）     │
└──────────────────────────┼────────────────────────────────────────┘
                           ▼
                 https://decision.vllm-sr.ai
                           ▲
┌──────────────────────────┼────────────── 浏览器渲染进程 ──────────┐
│ client.js                │                                        │
│  ├─ settings.section  ←──┴─  GET /status · /usage · POST /config   │
│  └─ tool.call.toolview ←───  GET /result?callId                   │
└───────────────────────────────────────────────────────────────────┘
```

**为什么用同源路由**：Client 插件能直接用相对 `fetch('/dsh-decision/...')` 打到同一个 webServer（桌面壳与 Web 形态都会转发到宿主 HTTP），不需要给 typert 编译 schema、也不需要额外的 RPC 通道；同时浏览器永远拿不到 API Key。

<a id="3-2-一次决策调用"></a>
### 3.2 一次 `decision_ask` 的完整链路

1. **模型决定调用**：工具描述里写清了题型与限制，Agent 据此决定何时调用（插件不注入 system prompt）。
2. **Host 校验与准备**（`execute`）：
   - 解析 Key（env → 凭据 → 文件），无 Key 直接返回可读错误；
   - 校验 `state` 长度、题数、每题 `type`/`criteria` 形状；
   - 读取本地图片/视频（`png/jpeg/webp`、`mp4/webm/mov/mkv`）→ base64 data URL，超限即拒绝；
   - `box` 题要求恰好 1 张图，否则本地报错（不浪费一次网络请求）。
3. **请求服务端**：`POST /v1/systemone`，`timeoutMs = 60s`，透传服务端错误码（`model_not_allowed`、`request_too_long` 等）。
4. **返回与记录**：工具结果 `{ model, answers, usage, requestId }`；
   - `output.render` 把结果渲染成分题 markdown 文本，写进会话日志（这是权威副本）；
   - 同时按 `exec.callId` 写入结果缓存（内存 + 落盘），供卡片使用。
5. **卡片渲染**：Chat 渲染到该工具调用时挂载卡片，用 `callId` 取回结构化结果画条（见 3.3）。

<a id="3-3-卡片的数据从哪来"></a>
### 3.3 卡片的数据从哪来

卡片不解析工具文本，而是按 `callId` 向 Host 要**结构化结果**：

- 工具执行成功时 `rememberResult(exec.callId, value)`；
- 卡片挂载后 `GET /dsh-decision/result?callId=…`；
- 结果按 200 条 / 1 小时保留，并持久化到 `$DSH_HOME/.dsh-decision-results.json`，**重启后历史卡片仍能回放**；
- 取不到（过期 / 被淘汰 / 非本机产生）时显示「详细结果不可用 · call xxxx」，工具文本仍在会话里，所以不会丢信息。

<a id="3-4-设置页"></a>
### 3.4 设置页如何读写配置

**读**（三个来源，先快后慢，永远不会因为慢请求白屏）：

1. 浏览器 `localStorage` 里上次的快照（`dsh-decision.status.v1` / `dsh-decision.usage.v1`）—— 进页面**立即**渲染，不转圈；
2. `GET /status` —— Key 掩码前缀、默认模型、模型表、诊断信息（Host 端 20 秒复用，热时 3–80 ms）；
3. `GET /usage` —— 今日请求/tokens 与每个模型的配额条（上游较慢，单独请求，到达后补进页面；Host 端同样 20 秒复用）。

后台请求返回后会替换屏幕上的缓存并回写 `localStorage`；请求失败时**保留已有数据**，只在下面补一行错误提示（不会把页面清空）。前端两个请求都带 15 秒超时。

**写**：

- 填写 Key → `POST /config`：Host 先用 `/api/keys/self` **验证该 Key**，成功才 `credentials.set`；失败返回 400 与原因。
- 选择模型 → 同一个 `POST /config`：校验它在 `/api/info` 的模型列表里，然后原子写入 `$DSH_HOME/.dsh-decision.json`。
- 保存成功后 Host 使缓存失效并返回最新 status + usage，页面直接应用，不再多打一轮请求。

**为什么拆成 `/status` 与 `/usage`**：`/api/info` 冷启动要 4–5 秒、配额接口约 0.8–2.5 秒，而模型表/Key 状态是页面的主体。拆开后主体先出来，配额随后补齐；再叠加两级缓存（Host 20 秒 + 浏览器上次快照），重复进入设置页基本是瞬时的。

<a id="3-5-密钥解析顺序"></a>
### 3.5 密钥与配置的解析顺序

```text
DECISION_API_KEY 环境变量
  → DSH 凭据 DECISION_API_KEY（ctx.credentials.resolve，返回 { value, source }）
  → $DSH_HOME/.dsh-decision.json 的 apiKey（无 credentials 服务时的兜底写入位置）
```

默认模型每次调用时读取（`readSettings` 有进程内缓存，写入后失效），所以改完设置立刻生效，不需要重启。

<a id="4-什么时候触发"></a>
## 4. 什么时候触发

| 触发点 | 时机 / 条件 | 行为 | 失败退路 |
|---|---|---|---|
| `decision_ask` | **模型主动调用**；工具描述说明"需要概率而非生成文本时使用" | 发一次 `/v1/systemone`，多题合并为一个请求 | 返回可读错误（无 Key / 超限 / 服务端错误码） |
| `decision_info` | 模型需要模型表、配额或服务状态时 | `models` 走 `/api/info`（缓存 10 分钟，无 Key 也可） | 返回错误文本 |
| 卡片挂载 | Chat 渲染该 `decision_ask` 调用时（打开会话、滚到该行、展开） | `fetch /result?callId` 一次 | 显示「详细结果不可用 · call xxxx」 |
| 设置页加载 | 打开 Settings → 决策模型 | 先用 `localStorage` 快照立即渲染，再 `GET /status`（Host 20s 缓存） | 保留旧数据 + 一行错误提示 |
| 设置页用量 | `/status` 到达后立刻发起 | `GET /usage`（上游慢，独立请求，12s 超时） | 保留旧用量；失败不阻塞页面 |
| 保存配置 | 点击「保存并验证」/「刷新」 | `POST /config`；「刷新」= 两个 GET 加 `?refresh=1` | 页面显示失败原因，不改动现有配置 |
| 结果落盘 | 每次工具成功返回后 **800ms 防抖** | 原子写 `~/.dsh/.dsh-decision-results.json` | 写失败只影响回放，不影响调用 |
| 客户端上报 | **仅异常**：取数失败或卡片渲染崩溃 | `POST /client-report` | 无影响（fire-and-forget） |

注意：**插件不改变模型的调度策略**，也不会自动替 Agent 决策；是否调用 `decision_ask` 完全由模型根据工具描述与任务判断。

<a id="5-如何实现"></a>
## 5. 如何实现

<a id="5-1-文件"></a>
### 5.1 文件与职责

| 文件 | 职责 |
|---|---|
| `index.js` | Host：两个工具 + 五条同源路由 + Key/模型存储 + 媒体编码 + 结果缓存 |
| `client.js` | Client：`settings.section` 设置页 + `tool.call.toolview` 决策卡片 + 错误边界 |
| `cordis.patch.yml` | 插入 bundle 行（不写任何密钥） |
| `locale/{zh,en}.json` | Plugins 页显示的标题与描述 |
| `icon.svg` | 插件图标（决策分叉 + 概率条） |
| `package.json` | `dsh.bundle.patch` + `dsh.client`（`platform: web`） |

<a id="5-2-Host-关键函数"></a>
### 5.2 Host 端关键函数（`index.js`）

| 函数 | 作用 |
|---|---|
| `apply(ctx)` | 注册工具；`ctx.inject(['webServer'])` **等服务就绪**后注册路由（冷启动竞态修复点） |
| `registerTools(ctx)` | `ctx.tools.register` 两个 ToolDefinition（`parameters` / `output.schema` / `execute` / `render`） |
| `buildQuestions(raw)` | 按题型校验 `criteria`，统计 box 题数量 |
| `buildMedia(list, kind)` | 本地文件 → `data:` URL，按扩展名定 MIME、按大小上限拒绝 |
| `apiRequest(ctx, opts)` | 统一 fetch：超时 35s、`X-API-Key`、错误归一化（`code`/`status`/`retryAfter`） |
| `resolveApiKey` / `saveApiKey` | 三级解析与写入（见 3.5） |
| `readSettings` / `writeSettings` | `$DSH_HOME/.dsh-decision.json` 原子读写（`0600`） |
| `rememberResult` / `recallResult` | 结果缓存与持久化（防抖写、TTL 1h、上限 200） |
| `buildStatus(ctx, {refresh})` | 设置页主体：Key 状态、模型表、limits、诊断信息；Host 端 20 秒复用 |
| `buildUsage(ctx, {refresh})` | 配额与用量（独立慢请求，`USAGE_TIMEOUT_MS = 4s`），20 秒复用 |
| `invalidateStatus` / `invalidateUsage` | 保存配置后让两个缓存立即失效 |
| `fetchInfo` | `/api/info`，10 分钟缓存，失败时回退到上一份快照 |
| `registerRoutes(ctx, webServer)` | 五条路由与 `ctx.effect` 释放 |
| `guardRequest(req)` | 回环 Host + 拒绝 `cross-site` + Origin 与 Host 同源 |

工具注册形如：

```js
ctx.tools.register({
  name: 'decision_ask',
  description: 'Ask the Decision 3.0 multimodal decision models for calibrated probabilities: …',
  parameters: { type: 'object', required: ['state', 'questions'], properties: { /* … */ } },
  output: {
    schema: { /* model / answers / usage / requestId */ },
    render: (_args, value) => [{ type: 'text', text: formatAnswers(value) }],
  },
  timeoutMs: 60_000,
  isConcurrencySafe: () => true,
  async execute(args, exec) { /* 校验 → 媒体 → POST → 缓存 → 返回 */ },
})
```

<a id="5-3-Client-关键结构"></a>
### 5.3 Client 端关键结构（`client.js`）

- 以 `window.__ModuleLoader__.load({ id: '@xia-sc/dsh-decision', factory(require) })` 注册；`inject: ['slots', 'locale']`。
- **设置页**：`ctx.slots.inject('settings.section', () => ctx.slots.register({ name, id: 'dsh-decision', order: 60, label }, Component))`。
- **卡片**：`ctx.slots.register({ name: 'tool.call.toolview', key: 'decision_ask' }, Wrapper)`，`Wrapper` 用 `CardBoundary`（错误边界）包住卡片，渲染失败时显示原因并上报，而不是整行空白。
- **卡片组件**：`callId` → `/result` → 按 `answer.type` 渲染：
  - `choice`：每个选项一行横向条（选中项用品牌色），右侧百分比；
  - `noul`：单条"是"概率；
  - `score`：每档概率条 + 期望值 + `legend`；
  - `box`：四边百分比 + 置信度，`confidence < 0.5` 用告警色标注。
- **样式**：只用 `--dsw-alias-*` token（`bg-layer-*`、`border-l1`、`label-primary/secondary`、`brand-primary`、`state-warn/error-primary`），类名统一 `dsd-` 前缀；`<style>` 作为组件内 React 元素渲染，卸载即移除。
- **文案**：`ctx.locale.register('dsh-decision', { zh, en })` + 本地字典兜底。

<a id="5-4-路由与安全"></a>
### 5.4 路由与安全

- 全部 `kind: 'exact'`，前缀 `/dsh-decision/`，`Cache-Control: no-store`。
- `guardRequest`：要求 `Host` 解析为回环地址（`127.0.0.0/8`、`localhost`、`::1`）；拒绝 `Sec-Fetch-Site: cross-site`；有 `Origin` 时必须与 `Host` 同源。失败返回 403。
- 方法限定：`status` / `usage` / `result` 只允许 GET，`config` / `client-report` 只允许 POST，否则 405。
- 请求体上限 64 KB；响应**从不包含 Key 原文**，只有 `sk-vsr-AbCd…xYz` 这类掩码前缀。
- Key 校验放在写入之前，验证失败不落库。

<a id="5-5-卡片的可观测性"></a>
### 5.5 可观测性

- `GET /dsh-decision/status` 的 `diagnostics.recentRequests`：最近到达的请求（方法 / URL / Host / Origin / Sec-Fetch-Site），用于区分"客户端没请求到"和"请求被拒"。
- `diagnostics.clientReports`：卡片取数失败或渲染崩溃时的客户端上报（正常渲染不上报，零噪音）。

<a id="6-工具参数与返回"></a>
## 6. 工具参数与返回

```jsonc
// decision_ask 参数
{
  "model": "vllm-sr/d3-flash",           // 可选，省略用默认模型
  "state": "要判断的文本，或写成文本的 JSON",
  "images": ["C:\\path\\to\\photo.png"],  // 可选，≤4 张；本地路径（png/jpeg/webp）或 data: URL
  "videos": ["C:\\path\\to\\clip.mp4"],   // 可选，≤1 个
  "questions": {
    "route":   { "type": "choice", "instructions": "哪个团队处理？", "criteria": { "returns": "退换货", "billing": "账单", "technical": "技术" } },
    "receipt": { "type": "noul",   "instructions": "客户有收据吗？" },
    "urgency": { "type": "score",  "instructions": "多紧急？", "criteria": ["常规", "尽快", "今天"] },
    "where":   { "type": "box",    "instructions": "火箭在哪里？" }
  }
}
```

| 题型 | `criteria` | 答案字段 |
|---|---|---|
| `choice` | 选项对象（≥2 项，值为描述或 `null`） | `choice` + `probabilities` + `confidence` |
| `noul` | 可选 `{"false": "...", "true": "..."}` | `noul`（是概率） |
| `score` | 有序档位数组（2–10 项） | `score`（期望档位）+ `probabilities` + `legend` + `confidence` |
| `box` | 无（靠 `instructions` 描述目标） | `box{top,left,bottom,right}` + `confidence` |

返回给模型的结构化结果：`{ model, answers, usage, requestId }`；同时渲染成分题 markdown 文本（概率降序、`confidence`、`legend`、错误题原样展示）。

`decision_info` 的 `action`：`models`（模型与 limits）、`usage`（今日配额与 p50/p90 延迟）、`status`（模型实时状态）。

<a id="7-服务端限制"></a>
## 7. 服务端限制

`state` ≤ 32000 字符 · ≤ 64 题 · ≤ 4 图（每图 ≤ 8 MB）· ≤ 1 视频（≤ 32 MB）· 请求估算 token ≤ 131072 · 单请求 30 秒超时。

超过时服务端返回 `400` 与具体错误码（如 `request_too_long`、`box_needs_image`、`too_many_questions`）；部分题型限制随模型不同（`d3-turbo` 支持 16 图、131072 字符 state）。

<a id="7-1-性能实测"></a>
### 7.1 性能实测（2026-10-27，本机直连服务端）

每次先跑 1 次不计入预热，随后顺序执行；文本题 5 次、box 题 3 次。

| 场景 | 模型 | 平均 | 中位 | p90 | 最大 | 输入 tokens |
|---|---|---|---|---|---|---|
| 短文本 / 1 题 | d3-edge | 298 ms | 299 | 302 | 307 | 102 |
| 短文本 / 1 题 | d3-ultra | 306 ms | 304 | 311 | 321 | 119 |
| 短文本 / 1 题 | d3-nano | 331 ms | 303 | 306 | 462 | 102 |
| 短文本 / 1 题 | d3-turbo | 336 ms | 336 | 352 | 360 | 102 |
| 短文本 / 1 题 | d3-lite | 375 ms | 298 | 317 | 679 | 102 |
| 短文本 / 1 题 | d3-mini | 380 ms | 312 | 318 | 667 | 102 |
| 短文本 / 1 题 | d3-flash | 385 ms | 319 | 326 | 670 | 102 |
| 长文本 / 3 题（约 1200 字符） | d3-flash | 320 ms | 321 | 321 | 356 | 588 |
| 图片 box（1 张） | d3-flash | **1664 ms** | 1558 | 1558 | 1946 | 20769 |
| 图片 box（1 张） | d3-turbo | **377 ms** | 380 | 380 | 383 | 442 |

结论：

- **文本决策的延迟与模型大小基本无关**：7 个模型都在 ~300 ms 量级（平均 298–385 ms），差异小于尾部抖动（p90 到 ~680 ms），主要由网络与排队决定。选型应按准确率（官方 Jev Decision Index）而不是按速度。
- **图像定位差异巨大**：`d3-flash` 没有原生 box 输出，用 65 个 `noul` 子问题做 grid scoring（约 2 万输入 tokens、1.5–1.9 s）；`d3-turbo` 有原生 box 输出（442 tokens、~0.38 s）。**box 题优先 `d3-turbo` / `d3-ultra`**，又快又省 token 配额。
- 工具默认 `timeoutMs = 60s` 对上述场景都很宽裕；真正需要预留时间的是"多题 + 大图/多图"。

复测（脚本在 `.bench/`，不参与打包，只读凭据、不打印）：

```powershell
# 所有文本模型的短文本延迟
$env:N = '5'
node .bench/latency.mjs vllm-sr/d3-flash vllm-sr/d3-mini vllm-sr/d3-turbo vllm-sr/d3-ultra

# 长文本 3 题 + 图片 box（flash 对比 turbo）；需要 .bench/test.png
node .bench/probe2.mjs
```

`.bench/test.png` 可用 Pillow 重新生成：640×480 米白底，左侧红圆（80,90–300,310）、右侧蓝方块（380,150–570,340）。

<a id="8-排查"></a>
## 8. 排查

| 现象 | 先看 |
|---|---|
| 设置页「请求失败：HTTP 404/405」 | 路由没注册（`ctx.inject(['webServer'])` 竞态），重载插件；`GET /dsh-decision/status` 直接验证 |
| 设置页用量显示「用量查询超时」 | 上游配额接口慢；其它数据不受影响，点「刷新」重试 |
| 设置页首屏仍是旧数据 | 正常：先显示 `localStorage` 快照，几十毫秒后会被新数据替换（底部有「正在刷新…」提示） |
| 设置页显示未配置 Key | `diagnostics` 与 `~/.dsh/.credentials.yaml` 的 `refs.DECISION_API_KEY` |
| 工具报 `No Decision API key configured` | 同上；或环境变量未生效 |
| 卡片显示「详细结果不可用 · call xxxx」 | 该 callId 的结果已过期/被淘汰（1 小时、200 条），工具文本仍在会话日志里 |
| 卡片渲染异常 | 卡片会显示「决策卡片渲染失败：…」，并出现在 `diagnostics.clientReports` |
| 调用返回 403 `model_not_allowed` | 模型 id 不在 `/api/info` 列表（如 `vllm-sr/d3` 是 `d3-turbo` 别名） |
| 调用返回 429 | 每分钟额度或并发限制；看响应 `Retry-After` |

<a id="9-已知边界"></a>
## 9. 已知边界

- 卡片数据依赖 Host 的结果缓存（200 条 / 1 小时，已持久化）；超出后回放失败，但工具文本永不丢失。
- 设置页的即时感依赖浏览器 `localStorage` 快照（`status` / `usage` 各一份，24 小时过期）与 Host 端 20 秒缓存；换浏览器、清缓存或很久没打开时，首次进入仍会走一次网络（模型表 4–5 秒、配额 1–3 秒）。
- 服务端可能记录请求与响应（见官方 Logging 章节），不要发送敏感数据。
- 视频只作为普通题的输入（`noul` / `choice` / `score`），不产生轨迹（`track`）；`box` 只有 `d3-turbo` / `d3-ultra` / `d3-flash` 支持。
- 插件不导出 `Config`：参数在设置页与 `$DSH_HOME/.dsh-decision.json` 管理，不引入 `schemastery` 依赖。
- 卡片渲染在工具调用行内（不在助手正文里），历史会话需要滚到对应调用处。

<a id="10-兼容性"></a>
## 10. 兼容性

<a id="10-1-运行环境"></a>
### 10.1 运行环境

| 项 | 支持范围 | 说明 |
|---|---|---|
| DeepSeek Harness | 0.2.x（实测 `0.2.1-rc.3`） | 依赖的扩展点见 10.2；更早版本未验证 |
| Harness 形态 | **Web GUI**（`dsh web` 或桌面应用的渲染进程） | Host 工具与 `/dsh-decision/*` 路由在 Host 进程；设置页与卡片需要 Client slots |
| TUI / headless / ACP | **部分支持** | 工具、路由、密钥/模型存储可用；设置页与卡片不渲染（没有 slots），Key 用环境变量或 `$DSH_HOME` 文件配置 |
| Node.js | ≥ 18（宿主运行时，实测 Node 26） | 用全局 `fetch`、`AbortController`、`performance.now`，无原生依赖 |
| 操作系统 | Windows（实测）/ macOS / Linux | 无平台特定代码；路径走 `node:path`，媒体按扩展名转 `data:` URL |
| 浏览器 | Chromium / Firefox 现代版 | 只用 `fetch`、CSS 变量（`--dsw-alias-*`）、`localStorage` |
| npm（发布） | ≥ 9 | 发布走 `.github/workflows/publish.yml`，见 10.5 |

<a id="10-2-Harness-扩展点"></a>
### 10.2 依赖的 Harness 扩展点

| 扩展点 | 用途 | 缺失时的行为 |
|---|---|---|
| `ctx.tools.register` | 注册 `decision_ask` / `decision_info` | 插件不激活（`inject: ['tools']`） |
| `ctx.inject(['webServer'])` + `webServer.register` | 五条同源路由 | 工具可用，设置页/卡片报 404 |
| `ctx.credentials` | Key 存 `DECISION_API_KEY` | 回退到环境变量或 `$DSH_HOME/.dsh-decision.json` |
| `ctx.slots`（`settings.section`、`tool.call.toolview`） | 设置页与卡片 | 只影响 UI，不影响工具 |
| `window.__ModuleLoader__` | Client bundle 注册 | 同上 |
| `--dsw-alias-*` 主题 token | 样式跟随主题 | 回退为基础样式，不崩 |

<a id="10-3-Decision-API"></a>
### 10.3 Decision API 依赖

| 能力 | 端点 / 字段 | 必需 |
|---|---|---|
| 决策请求 | `POST /v1/systemone`（`/v1/decisions` 同义） | 是 |
| 模型表与上限 | `GET /api/info` | 是（模型下拉、limits） |
| 配额与用量 | `GET /api/keys/self`、`/api/keys/self/usage` | 否（失败只影响用量区） |
| 服务状态 | `GET /api/status` | 否（`decision_info action=status`） |
| 鉴权 | `X-API-Key` 或 `Authorization: Bearer` | 是 |
| 题型 | `choice` / `noul` / `score` | 全部模型 |
| 题型 | `box` | 仅 `d3-turbo` / `d3-ultra` / `d3-flash`（其余返回 `box_unsupported`） |
| 媒体 | 图片（PNG/JPEG/WebP）、视频（MP4/WebM/MOV/MKV） | 可选 |

<a id="10-4-版本矩阵"></a>
### 10.4 版本矩阵

| 插件版本 | Harness 版本 | npm | 说明 |
|---|---|---|---|
| `0.1.x` | `0.2.x`（rc 系列） | `@xia-sc/dsh-decision` | 当前版本：五条路由、双层缓存、卡片错误边界 |
| `< 0.1.0` | — | — | 不存在（早期仅在本地以 `@local/dsh-decision` 链接安装） |

升级约定：插件小版本只加能力，不改 `decision_ask` 的参数形状；`answers` 字段跟随上游 API。

<a id="10-5-发布与安装形态"></a>
### 10.5 发布与安装形态

| 形态 | 命令 | 适用 |
|---|---|---|
| 本地目录（开发） | `plugin_manager install_bundle target=<绝对路径>` | 改代码即时生效（link） |
| npm 包 | `plugin_manager install_bundle target=@xia-sc/dsh-decision` | 分发、多机安装 |
| 发布 | push `v*` tag → GitHub Actions | 见 `.github/workflows/publish.yml` |

**发布到 npm**：`0.1.0` 已由本地发布（2026-10-27），之后的版本交给 [`.github/workflows/publish.yml`](.github/workflows/publish.yml)。workflow 有两条凭据路径，任选其一：

- **A. `NPM_TOKEN` secret**：npmjs.com 建 token（granular：scope `@xia-sc`、Read and write、勾选 **Bypass 2FA**；或 classic **Automation** token），加到仓库 `Settings → Secrets and variables → Actions → NPM_TOKEN`。
- **B. Trusted Publishing（OIDC，无 token，带 provenance）**：包已存在后，在 npm 包页面 `Settings → Trusted publishing` 添加 GitHub：repository `xia-sc/dsh-decision`、workflow file `publish.yml`。workflow 已带 `id-token: write` 且会升级到 npm ≥ 11.5。

发版流程：

```bash
npm version patch            # 0.1.0 → 0.1.1，自动 commit 并打 v0.1.1 tag
git push origin main --tags  # 触发 workflow：preflight → 校验 tag 与版本一致 → 发布
```

workflow 的行为：

- tag 与 `package.json` 版本不一致 → 直接失败（不发布）；
- 该版本**已存在于 npm** → 输出 notice 并跳过发布（所以给已发布版本补 tag 不会产生失败记录）；
- 没有任何凭据（既无 `NPM_TOKEN` 也未配 Trusted Publishing）→ 发布步骤失败，日志会写明认证错误。

`scripts/preflight.mjs` 会在发布前检查：必需文件齐全、包名是 `@xia-sc/dsh-decision`、`private` 未开启、`publishConfig.access = "public"`、`client.js` 的 module id 与包名一致、无 API Key / 本机路径、两个 JS 文件语法正确。

<a id="10-6-已知不兼容"></a>
### 10.6 已知不兼容 / 限制

- **TUI / headless / ACP**：没有 Client slots，设置页与卡片不出现；`decision_ask`、`decision_info` 与路由照常可用。
- **桌面端（Electron）**：改 Client bundle 后必须整页重载（`Ctrl+R`）或重启应用；只重载 Host 不会刷新前端。
- **Harness < 0.2.0**：`ctx.inject` 的用法与 slot 名称可能不同，未验证。
- 插件不注册任何 slash command、不改 agent preset，也不注入 system prompt。
