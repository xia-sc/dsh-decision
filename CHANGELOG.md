# 变更记录（Changelog）

本文件记录 `@xia-sc/dsh-decision` 的版本变更。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.2.1] — 2026-10-30

DSH **0.2.1-rc.5** 兼容性测试修复版。参数形状与返回结构不变。

### 修复

- **清除 API Key 无效**：`POST /config {"apiKey":""}` 现在优先调用 DSH credentials 的 `unset(ref)`
  （rc.3 起接口就是 `resolve/describe/set/unset`，没有 `delete`/`remove`）。此前桌面形态只删掉
  `config.json` 的兜底副本，credentials 里的 Key 仍被 `resolveApiKey` 取到，清除实际无效；旧接口
  `delete`/`remove` 保留为回退。
- **工具参数 schema 对齐 DSH enforced JSON-Schema subset**：`decision_ask.parameters.questions.additionalProperties`
  由 schema 对象改为 boolean `true`，每题形状移入 `description`。此前能注册只是因为 raw `parameters`
  不做 subset 断言，DSH 收紧参数校验或 PTC 使用参数时会失败；插件侧 `buildQuestions()` 逐题强校验不变。
- **样式节点补 `data-plugin="@xia-sc/dsh-decision"`**：对齐 DSH 0.2.1-rc.5 按插件清理自有 `<style>`
  的约定，作为 `ctx.effect` 清理之外的第二道保险（HMR 场景）。

### 测试

- `scripts/smoke-regressions.mjs` 增至 **141 条断言**：新增 `clear-key`（10 条：rc.5 `unset` 形态与旧
  `delete` 回退形态）与 `schema-subset`（6 条：递归守卫 `additionalProperties` 必须为 boolean）。
- 兼容性实测（DSH 0.2.1-rc.5）：Host 工具注册、5 条同源路由、两个 Client 槽位、12 个主题 token、
  `engines.dsh` 放行均通过；rc.3 → rc.5 相关 DSH 包无契约变化（仅 `dsh-client-modules` 构建 hash 不同）。
- `preflight`（3 个 smoke）通过。

### 升级注意

- `decision_ask` 的工具 schema 描述更集中（每题形状在 description），模型侧行为不变；返回值与
  `lowConfidence` / `warnings` / `hint` 契约不变。
- `output.schema` 在 rc.5 会被真实校验且 `additionalProperties: false`：以后给工具返回值加字段必须
  同步 schema，否则会 `INVALID_TOOL_OUTPUT`。

## [0.2.0] — 2026-10-29

本版是**行为变更版**：修复了上一轮全面测试报告（`test-reports/REPORT.md`）中的 3 个 P1、19 个 P2 与主要 P3，
并新增 box 请求串行化。升级前请阅读文末「升级注意」。

### 新增

- **box 请求串行化**：上游对**同一 API key + 同一 model** 同时只允许 1 个 box 请求（并发第二个返回
  `429 concurrency_limit`）。Host 现在按「key 的 SHA-256 摘要 + model」把 box 请求串行排队；非 box 请求
  继续并行，`isConcurrencySafe` 仍为 `true`。
- **`429 concurrency_limit` 重试一次**：跨进程/外部客户端仍可能撞上并发上限，插件捕获该错误后等待约
  1.5 秒重试一次；仍失败则原样抛出（保留 `status` / `code`，由调用侧串行）。排队中的请求被
  `exec.signal` 取消时立即失败，不会卡住队列。
- `decision_ask` 工具描述写明 box 串行规则，模型侧可据此避免并发 box 调用。
- **`engines.dsh`**：`>=0.2.1-rc.3 <0.3.0-0`。DSH 安装器据此拒绝不兼容运行时（此前不声明 = 不校验）。
- `npm test` → `node scripts/smoke-regressions.mjs`（125 条 Host 回归断言，含 box 串行 / `429 concurrency_limit` 重试 / 排队 abort），`npm run check` 仍只做语法检查。
- `scripts/preflight.mjs` 检查项扩充：`engines.node` / `engines.dsh` 存在性、`exports` 子路径目标存在、
  `files` 覆盖随包文件、`locale/*.json` 可解析、`CHANGELOG.md` 随包、以及覆盖用户主目录 / 项目目录
  （Windows 正反斜杠、JSON 双反斜杠、UNC）、`/Users`、`/home` 的本机路径扫描；CI 与本地都跑 3 个 smoke。
  子进程在受限沙箱里拿不到管道时回退 `stdio: 'inherit'`，不再因 EPERM 误判失败。
- 本 CHANGELOG。

### 修复（P1 / P2）

- **P1-1**：无 `credentials` 服务（TUI/headless）时，先保存 Key 再改模型会把 Key 静默抹掉。写入改为
  read-modify-write，保留 `apiKey`、`baseUrl` 与未知字段；单请求同时提交 key + model 也保留。
- **P1-2**：README 安装验收断言不再写"返回 7 个模型"，改为"`models` 非空且包含默认模型（当前 6 个，
  `d3-turbo` / `d3` 是 `d3-ultra` 的别名）"，并明确"不要用模型数量判断安装成败"。
- **P1-3**：`/config` 接受规范 id **或别名**并归一化为规范 id 落盘（`vllm-sr/d3-turbo` → `vllm-sr/d3-ultra`），
  未知模型本地 400；README 全文统一别名表述，能力按 `/api/info` 的 per-model limits 动态描述
  （`d3-flash` 已 `box=true`，删除过期的"无原生 box"结论并标注历史数据）。
- **P2-1**：本地校验改用 `/api/info` 的 per-model limits（`d3-ultra`：131072 字符 / 16 图 / 16 MB；其余：
  32000 / 4 / 8 MB），`/api/info` 不可用时回退 32000 / 4 / 8 MB / 64 题，错误文案点明"当前模型的限制"。
- **P2-2**：`data:` URL 不再绕过校验：MIME 白名单（`image/png|jpeg|webp`、`video/mp4|webm|quicktime|x-matroska`）、
  必须 `;base64`、校验 base64 合法性与解码后字节数。
- **P2-3**：`/config` 的模型校验 fail-closed——`/api/info` 不可达时返回 400 并提示稍后重试，绝不写入未验证 id。
- **P2-4**：`decision_info` 的非法 `action` 本地报错（此前静默按 `usage` 处理并回显 `action:"usage"`）。
- **P2-5**：`results.json` 写盘前与磁盘已有条目按 `callId` 合并（newest wins）并回填内存，缓解多 Host 进程
  互相覆盖；写失败清理临时文件。
- **P2-6**：拒绝 `Origin: null`（sandbox iframe / `file://` 页面），并拒绝绝对形式请求目标。
- **P2-7**：`maskKey` 改为 4+4 掩码（长度 ≤ 12 的 token 只显示 `…`）。
- **P2-8**：新增单次调用媒体 data URL 聚合上限 40 MB，超限本地拒绝并提示拆分。
- **P2-9**：文档补充隐私提示：`images` 可指向本机任意 png/jpeg/webp 并发送给 `baseUrl`（默认第三方），
  不要把敏感图片路径交给模型。
- **P2-10**：服务端 `warnings` / `hint` 原样透传到工具输出与卡片数据（此前被丢弃）。
- **P2-11**：设置页新增错误边界（`role="alert"`）并过滤上游畸形 `models` / `quota` / `status` 形状。
- **P2-12**：用量加载/失败显示「加载中…」/「—」，不再在失败时显示"0 请求 · 0 tokens"。
- **P2-13**：`ctx.locale.register` 返回的 disposer 交给 `ctx.effect`，避免重复注册抛错与 HMR 后回退中文。
- **P2-14**：6 处中文硬编码迁入字典（`zh` / `en` 各 48 键），`locale/*.json` 与内置 DICT 键保持一致并补 `meta`。
- **P2-15**：保存请求加 30 秒超时与取消（`AbortController`），失败文案本地化。
- **P2-16**：`scripts/preflight.mjs` 本机路径正则修复（此前 Windows 单反斜杠的绝对路径会漏检）。
- **P2-17**：README 更正 TUI / headless / ACP 口径：工具与配置读写可用，但**没有 HTTP 路由**（无 `webServer`），
  设置页与卡片整体不出现。
- **P2-18**：README 删除不存在的 `NPM_TOKEN` 发布路径（workflow 只有 OIDC Trusted Publishing）；新增 `engines.dsh`。
- **P2-19**：设置页表单补可读 `aria-label`（Key 输入、默认模型下拉、模型表），错误行 `role="alert"`。

### 修复（P3 主要）

- 写盘临时文件 `*.tmp` 在失败时清理；`loadResults` 读取后按 200 条裁剪；`baseUrl:"///"` 归一化为默认值；
  `legacy/*.bak` 不覆盖旧备份；`settingsCache` 随外部改文件失效。
- 卡片 `/result` 按 `callId` 缓存（同 callId 只请求一次，phase 变化不重复取）；取数 miss 只上报一次，
  404 按"已过期"上报而不是卡片错误。
- `score` 概率按降序渲染并标 `← most likely`；`choice` 标 `← chosen`；概率与 box 坐标越界时 clamp；
  `answers` 为数组时按索引展示并提示；缺 `confidence` / `noul` / `box` 字段时标低置信并给
  `lowConfidenceReason`（落盘到 `results.json`）。
- 低置信文案按实际原因区分（如 `confidence 0.328 is below 0.5`），不再固定说 "distribution is not concentrated"。
- 删除 `index.js` 中 box 图的死代码；box 文案改为"恰好 1 张图，多个 box 题可共用同一张图"。
- HTTP：405 带 `Allow` 头；所有 JSON 响应带 `X-Content-Type-Options: nosniff`；两个 POST 路由要求
  `content-type: application/json`（否则 415）；`/client-report` 空 body 返回 400。
- `dsh.client.inject` 由未使用的 `@deepseek-ai/dsh-client-ui-conversation` 改为 `[]`（本插件 Client 半区只
  `require('react')`，槽位由内置包声明并经 `ctx.slots.inject` 被动等待）。
- `.github/workflows/publish.yml` 与 README 对齐：只保留 OIDC、`npm publish --provenance`、Node 22、
  `workflow_dispatch` 必须填写并校验版本。

### 升级注意（0.1.4 → 0.2.0）

- `data:` URL 现在会被本地校验：非白名单 MIME、非 `;base64`、超限的调用会直接报错（以前透传到服务端）。
- `decision_info(action=...)` 传入非法值会报错（以前静默当 `usage`）。
- `/status` 的 `keyPrefix` 变为 4+4 掩码；长度 ≤ 12 的 token 只显示 `…`。
- `POST /config` 的 `model` 接受别名并归一化；`/api/info` 不可达时返回 400（fail-closed）。
- box 题请求在 Host 内串行，延迟可能增加（单个 box 请求本身不变），但不再因并发 429。
- 低置信结果新增 `lowConfidenceReason`；服务端 `warnings` / `hint` 会出现在工具输出里。
- `package.json` 新增 `engines.dsh`：Harness 0.2.1-rc.3 之前或 0.3 系列会被安装器拒绝。

## [0.1.4] — 已发布（具体发布日期以 npm 记录为准）

- 数据目录迁到 `$DSH_HOME/dsh-decision/`（`config.json`、`results.json`）；首次使用把 `$DSH_HOME` 根目录的
  `.dsh-decision*.json` 自动迁入，冲突时备份到 `dsh-decision/legacy/`。
- 五条同源路由（`/status`、`/usage`、`/config`、`/result`、`/client-report`）、双层缓存、卡片错误边界。

## [0.1.0] — 2026-10-27

- 首个 npm 版本：`decision_ask` / `decision_info` 两个工具、Settings 页、概率条卡片。

## [< 0.1.0]

- 不存在公开版本；早期仅在本地以 `@local/dsh-decision` 链接安装。
