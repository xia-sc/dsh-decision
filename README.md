# @xia-sc/dsh-decision

[![npm version](https://img.shields.io/npm/v/@xia-sc/dsh-decision.svg)](https://www.npmjs.com/package/@xia-sc/dsh-decision)
[![license](https://img.shields.io/npm/l/@xia-sc/dsh-decision.svg)](LICENSE)
[![publish](https://github.com/xia-sc/dsh-decision/actions/workflows/publish.yml/badge.svg)](https://github.com/xia-sc/dsh-decision/actions/workflows/publish.yml)

把 [Decision 3.0](https://decision.vllm-sr.ai/) 接进 DeepSeek Harness：让 Agent 对文本 / 图片 / 视频**问带选项的问题**，拿回校准概率而不是生成文本；Web UI 里还有设置页和概率条卡片。

> 决策模型不生成文字：一次前向就回答「哪个选项 / 是或否 / 几分 / 在图里哪里」，并给出每个答案的概率与置信度。

## 它做什么

| 能力 | 入口 |
|---|---|
| 四类决策：`choice` / `noul` / `score` / `box`（图内定位） | Agent 工具 `decision_ask` |
| 模型表、配额、服务状态 | Agent 工具 `decision_info` |
| 概率条卡片（跟在工具调用行里） | 对话 UI |
| API Key、默认模型、今日用量 | Settings → 决策模型 |

常见场景：分类路由、二选一判定、给候选答案打分、图片目标定位。一次调用可以合并多个问题。

## 给 AI Agent 的安装引导

把下面整段交给你的 Agent（DSH 里的 Agent、Claude Code、Codex 都行），它就能自己装好并验证：

```text
任务：给 DSH 安装 @xia-sc/dsh-decision 插件。

1. 确认目标 profile 名：问用户，或看 <DSH_HOME>/profiles/ 下的目录名。
  （桌面版通常是 desktop，且由桌面应用独占管理；CLI 起的 web GUI 是 web，TUI 是 dsh-tui。）
2. 安装（把 <profile> 换成实际名字）：
  桌面应用：在应用内用插件管理器安装 —— plugin_manager(action: "install_bundle", target: "@xia-sc/dsh-decision")
  命令行 profile（web / tui 等）：
  dsh plugin --profile <profile> add @xia-sc/dsh-decision
  若 dsh 不在 PATH：桌面版自带 CLI 在 <安装目录>/resources/runtime/cli/bin/dsh（Windows 为 dsh.cmd）。
  命令行参数顺序固定为：dsh plugin --profile <profile> add <包名>（--profile 不能省）。
3. 验证已进入组合（只读、不启服务、不用重启）：
  dsh --profile <profile> --dump-config
  期望在 `# == @xia-sc/dsh-decision` 那一层下看到 `id: dsh-decision`。
  （desktop profile 由桌面应用独占，CLI 会报 "managed exclusively by the Electron application"，这时改在应用内确认插件已启用。）
4. 告诉用户重启：宿主行只在启动时组合 —— CLI 重启 `dsh web`，桌面版退出并重新打开应用。
5. 重启后可选自检：在任意会话里让 Agent 调用 decision_info（action: "models"），能返回非空模型表（当前 6 个）即说明新代码已加载；随后打开 Settings → 决策模型 配置 API Key。
  （这也是判断「改了但没重启」的唯一可靠依据。）
6. 不要做的事：
  - 不要手工把插件文件拷进 <DSH_HOME>/profiles/<profile>/（用插件管理器 / dsh plugin 安装）；
  - 不要手改 <DSH_HOME>/profiles/*/package.json（安装器会自己维护 dsh.profile.bundles）；
  - 不要为了「验证」反复重装 —— 装不上先看第 3 步的 dump-config 输出。

权限提醒：插件运行时会写 <DSH_HOME>/dsh-decision/（config.json、results.json），API Key 存进 DSH 凭据；
在 DSH 会话里由 Agent 执行安装时，这些路径在工作区之外，需要先把文件权限切到 danger-full-access；
用户在终端自己执行则无此限制。
```

## 手动安装

```bash
# 从 npm 安装（推荐）
dsh plugin --profile web add @xia-sc/dsh-decision

# 锁定版本（当前 0.2.1）
dsh plugin --profile web add @xia-sc/dsh-decision@0.2.1

# 从 GitHub 源安装（可加 #v0.2.1 / #master 指定 tag / 分支）
dsh plugin --profile web add github:xia-sc/dsh-decision

# 从本地仓库安装（开发 / 调试）：装出来是 link，改代码后重载插件 / 重启应用即生效
git clone https://github.com/xia-sc/dsh-decision.git && cd dsh-decision
dsh plugin --profile web add .
```

> `0.2.1` 是当前版本（变更见 [CHANGELOG.md](CHANGELOG.md)）；若 npm 上暂时还看不到（发布传播延迟），
> 可用 GitHub 源或本地目录安装。装完记得重启宿主（`dsh web` 或桌面应用）。
> 桌面版 profile 由应用独占管理，请在应用内用插件管理器安装 / 卸载。

## 配置

- **API Key**：打开 Settings → 决策模型 填一次即可，也可用环境变量 `DECISION_API_KEY` 覆盖。解析顺序：环境变量 → DSH 凭据（`DECISION_API_KEY`）→ `$DSH_HOME/dsh-decision/config.json` 兜底。
- **默认模型**：默认 `vllm-sr/d3-flash`，可在设置页切换。当前 6 个模型：`d3-ultra`（别名 `d3-turbo` / `d3`）、`d3-flash`、`d3-mini`、`d3-nano`、`d3-lite`、`d3-edge`；box 题建议用 `d3-ultra`。
- **数据目录**：插件只写 `$DSH_HOME/dsh-decision/`（`config.json`、`results.json`），不碰 `$DSH_HOME` 根目录；从 0.1.3 及更早升级会自动迁移旧点文件。
- **卸载**：`dsh plugin --profile <profile> remove @xia-sc/dsh-decision`；桌面应用里用插件管理器移除。

## 用法

Agent 侧直接调用工具，不需要写代码。一次调用可以问多个问题：

```jsonc
{
  "state": "客户说：「发票抬头写错了，能重开吗？」",
  "questions": {
    "intent": { "type": "choice", "instructions": "用户想做什么？", "criteria": { "refund": "退款", "reissue": "重开发票", "other": "其它" } },
    "urgent": { "type": "noul",   "instructions": "是否要求今天处理？" },
    "level":  { "type": "score",  "instructions": "紧急程度？", "criteria": ["低", "中", "高"] }
  }
}
```

图片 / 视频题加 `images` / `videos`（本地路径或 `data:` URL，会先校验再发）；`box` 题要求恰好 1 张图，多个 box 题可共用同一张。

返回 `{ model, answers, usage, requestId, warnings?, hint? }`。低置信的题带 `lowConfidence: true` 与 `lowConfidenceReason`，整次结果带 `hint: "low-confidence"`——此时不要把 argmax 当结论。

`decision_info`：`models`（模型与 limits）、`usage`（今日配额与延迟）、`status`（模型实时状态）。

## 限制

本地会按当前模型的 limits 预校验（`/api/info` 不可用时回退）：

- **`d3-ultra`（别名 `d3-turbo` / `d3`）**：state ≤ 131072 字符、≤ 16 图、单图 ≤ 16 MB。
- **其余模型**：state ≤ 32000 字符、≤ 4 图、单图 ≤ 8 MB。
- 全局：≤ 64 题、≤ 1 视频（≤ 32 MB）、单请求 35 秒、工具总超时 60 秒。
- **box 并发**：上游对同一 key + model 同时只允许 1 个 box 请求，插件已在 Host 内串行排队并自动重试一次 429；非 box 请求可并行。

## 排查

| 现象 | 处理 |
|---|---|
| `No Decision API key configured` | 到 Settings → 决策模型 填 Key，或设 `DECISION_API_KEY` |
| 403 `model_not_allowed` | 模型 id 不在 `/api/info` 列表；`d3-turbo` / `d3` 只是 `d3-ultra` 的别名 |
| 429 `concurrency_limit` | 同一 key + model 的 box 请求并发；插件已排队并重试一次，仍报错请在调用侧串行 |
| 卡片显示「详细结果不可用」 | 结果缓存 1 小时 / 200 条已过期；工具文本仍在会话日志里 |
| 设置页 404 / 405 | 插件已装但宿主没重启；重启 `dsh web` 或桌面应用 |

## 兼容性

- DSH 0.2.x（实测 `0.2.1-rc.3`，`engines.dsh` 会拒绝不兼容版本）、Node ≥ 18；零 npm 依赖、无需构建。
- Web GUI（`dsh web` / 桌面应用）下功能完整；TUI / headless 里工具可用，但没有 HTTP 路由，设置页与卡片不出现（Key 用环境变量或文件配置）。
- 版本与变更见 [CHANGELOG.md](CHANGELOG.md)，当前 `0.2.1`。发布由 [`.github/workflows/publish.yml`](.github/workflows/publish.yml) 在 push `v*` tag 后走 OIDC 自动发布到 npm，并创建同 tag 的 GitHub Release；发布前门禁是 `npm test` + `node scripts/preflight.mjs`。

MIT © xia-sc
