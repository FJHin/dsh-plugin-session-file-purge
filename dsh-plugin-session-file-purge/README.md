# dsh-plugin-session-file-purge

**Delete a DeepSeek Harness session *and* the files that session produced.**

- 📖 **写给人的介绍（中文，可分享）**：[介绍.md](介绍.md) — 为什么需要它、怎么工作、怎么用、有哪些限制
- 📚 安装 / 接口 / 配置 / 排障：[中文说明](#中文说明) · [English](#english)
- 🚀 上传/发布这份仓库：[发布到GitHub.md](发布到GitHub.md)（维护者备忘）

---

## 中文说明

### 为什么需要这个插件

DSH 与大多数 harness 一样，**没有「会话 ↔ 文件」的台账**：会话日志里只有会话自身的数据，模型通过 shell、python、构建脚本写出来的文件，运行时一概不知道。所以现有的会话删除插件（例如 [`@pepsi-ai/dsh-plugin-session-delete`](https://www.npmjs.com/package/@pepsi-ai/dsh-plugin-session-delete)）只能删掉会话日志、投影缓存和工作区记账——工作目录里那些生成物，还得你自己动手清理。

这个插件补上这一段：**会话开始时给工作目录做一次基线快照，删除会话时把「基线之后新建/改动过的文件」列成可勾选的清单，先把选中项移入回收站，再删会话本身。**

```
┌─ 删除会话 ─────────────────────────────────────────────┐
│ 会话：季度汇报整理 (1)                                  │
│ 会话 ID：session-00000000-…                            │
│                                                        │
│ 本次会话产生或改动的文件                                │
│ 新建 · 3   [全选] [全不选]                              │
│  ☑ report.docx                          1.2 MB         │
│  ☑ charts/revenue.png                   240 KB         │
│  ☑ data/raw.csv                         18 KB          │
│ 改动 · 1   [全选] [全不选]                              │
│  ☐ src/config.yaml                      2 KB           │
│  合计：3 · 1.4 MB                                      │
│  [不清理文件，只删除会话]                                │
│                                                        │
│              [取消]  [移入回收站（保留会话）]  [移入回收站并删除会话] │
└────────────────────────────────────────────────────────┘
```

### 为什么用文件系统快照，而不是解析工具调用

会话日志里确实有 `write`/`edit`/`present` 这类工具调用的参数，理论上能抽出路径，但：

- 日志是 zstd 压缩的内部格式，解析它等于依赖未公开的实现细节；
- 更致命的是**漏报**：`python build.py` 生成 20 个文件，日志里只有一个命令字符串，一个路径都拿不到；`npm run build`、重定向、脚本批处理全都一样。

文件系统快照没有这个问题：不管谁写的、怎么写出来的，只要文件在会话开始后出现或变化，就能被发现。代价是首次快照要遍历目录（`node_modules`、`.git`、各类缓存目录默认跳过），超大仓库首次快照会有几秒延迟感。

### 功能

- **基线快照**：会话第一个回合开始时（`turn/start`，任何工具执行之前）记录工作目录中每个文件的 `路径 → 大小/修改时间`，存到 `~/.dsh/session-file-purge/baselines/<sessionId>.json`。
- **可勾选清单**：删除会话时列出「新建」和「改动」两组文件；新建默认勾选，「改动」默认不勾选（这类文件在会话开始前就存在，整文件移走风险更大）。两组各自有全选/全不选，显示单文件大小与合计。
- **先回收站、后删除**：选中文件按原相对路径移入 `~/.dsh/session-file-purge/trash/<时间戳>-<会话短id>/files/` 并写入 `manifest.json`；随后才删除会话日志、投影缓存、工作区记账。被移空的文件夹一并删掉，仍非空的目录不动。
- **可撤销**：结束页有「撤销：把文件放回去」；侧边栏行菜单与弹窗里都能打开「文件回收站」，逐批放回或永久删除。
- **只清文件不删会话**：侧边栏行菜单的「清理本会话产生的文件…」只做回收站这一步。
- **Agent 工具** `session_files`：`mode: "list"` 列出某会话产生/改动的文件，`mode: "purge"` 按 `paths` 移入回收站。

### 安装

```sh
# GitHub（仓库根目录就是这个包）
dsh plugin --profile <profile> add github:FJHin/dsh-plugin-session-file-purge

# 本地 checkout
dsh plugin --profile <profile> add file:/path/to/dsh-plugin-session-file-purge
```

安装后**重启该 profile**（新的 bundle 在组合阶段解析，运行中的实例不会热加载一个新增的 bundle）。

本包不依赖任何运行时第三方库：宿主端只用 `node:fs`/`node:os`/`node:path`，客户端 bundle 通过宿主提供的模块表 `require('react')` 与 `@deepseek-ai/dsh-client-ui-primitives`。唯一的 peer 是 `@deepseek-ai/dsh-tools`，且标记为 optional——compositor 里没有工具注册表时插件仍会加载（只是不注册 agent 工具）。

与 [`@pepsi-ai/dsh-plugin-session-delete`](https://www.npmjs.com/package/@pepsi-ai/dsh-plugin-session-delete) 的关系：两者提供同一套界面（会话头部垃圾桶按钮 + 侧边栏「⋯」菜单项 + 风险确认弹窗），会话删除链路也走同一套 `storageDomain` 表。**同时启用会出现两个垃圾桶按钮、两层弹窗**，二选一即可。选择用本插件时，把另一个在自己的 profile patch 里关掉：

```yaml
# ~/.dsh/profiles/<profile>/cordis.patch.yml
- id: chameleon-session-delete
  name: "@pepsi-ai/dsh-plugin-session-delete"
  disabled: true
```

### 界面入口

| 入口 | 行为 |
|---|---|
| 会话头部垃圾桶按钮 | 打开删除流程：确认会话 → 文件清单 → 移入回收站并删会话 |
| 侧边栏会话行「⋯」菜单 → 删除会话（含产生的文件）… | 同上，不需要切换会话 |
| 侧边栏会话行「⋯」菜单 → 清理本会话产生的文件… | 直接进入文件清单，**只移文件、保留会话** |
| 侧边栏会话行「⋯」菜单 → 打开文件回收站… | 回收站面板：逐批放回 / 永久删除 |
| 弹窗结束页 | 撤销（把本批文件放回原处）、打开回收站 |

侧边栏的「⋯」菜单在客户端是硬编码的，没有扩展槽，所以这三个菜单项是注入 DOM 实现的；头部按钮走 `conversation.session.header.actions` 槽、弹窗与回收站面板走 `shell.overlay` 槽。

### HTTP 接口

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/__sespurge/ping` | 探活：返回插件名与宿主 pid |
| GET | `/__sespurge/session/list` | 会话列表（标题/id/是否运行/是否有基线），供客户端把侧边栏标题对到会话 id |
| POST | `/__sespurge/plan` | `{sessionId}` → 待清理清单（**只读，不改动任何文件**） |
| POST | `/__sespurge/purge` | `{sessionId, paths[]}` → 移入回收站，保留会话 |
| POST | `/__sespurge/cleanup` | `{sessionId, paths[], deleteSession}` → 移入回收站（可选）并删除会话 |
| GET | `/__sespurge/trash` | 回收站批次列表 |
| POST | `/__sespurge/trash/restore` | `{id, paths?}` → 放回指定文件或整批 |
| POST | `/__sespurge/trash/drop` | `{id}` → 永久删除某一批 |

`sessionId` 必须是 `<uuid>` 或 `session-<uuid>`；`paths` 一律相对工作目录，服务端用 `resolveInside` 校验，`../` 之类的越界路径会被拒绝并计入响应里的 `failed`。

### 配置

profile 行的 `config` 支持这些字段（正整数，缺省用默认值）：

| 字段 | 默认 | 含义 |
|---|---|---|
| `maxEntries` | `200000` | 一次快照/对比最多访问的文件数，超过则标记 `truncated` |
| `baselineBudgetMs` | `30000` | 基线快照的时间预算 |
| `planBudgetMs` | `20000` | 生成清理清单的时间预算 |
| `trashRetentionDays` | `30` | 回收站保留天数，超期批次在下次清理动作时删除 |

> **给插件作者的一个坑**：本插件刻意**不**导出 `Config`。cordis 的加载器会把插件导出的 `Config` 当成 schemastery 配置模式，用 `Config['~standard'].validate(行配置)` 校验；导出一个普通默认值对象会让这一步直接抛错，row 静默不激活——模块确实被 import 了，但 `apply` 永远不会被调用，HTTP 路由一条都不会注册，而客户端 bundle 照常发布（扫描只看 `dsh.client` 声明）。现象非常迷惑：**界面是新的、功能全报 404/405**。`test/plugin-contract.mjs` 复刻了加载器这一步来防止回归。

### 安全设计

- **只快照、只对比，不改文件**：`plan` 完全只读；只有 `purge`/`cleanup` 才移动文件，且优先 `rename`（跨盘或被占用时退化为复制后删除）。
- **越界拦截**：所有来自客户端或模型的路径都过 `resolveInside(root, path)`，解析后必须仍在会话工作目录内。
- **不碰依赖和版本库**：`node_modules`、`.git`、`.hg`、`.venv`、`__pycache__`、`.next`、`.gradle` 等从不进入快照，也从不出现在清单里。
- **不静默删除**：任何选中文件先入回收站；`drop` 是唯一真正删除的接口，且只作用于回收站内的批次。
- **默认勾选保守**：只默认勾选「新建」文件；「改动」文件默认不勾，并在列表里显式提示风险。
- **不采集任何数据**：不使用网络，不读取凭据，不写工作目录以外的位置（除 `~/.dsh/session-file-purge/` 下的基线与回收站）。

### 已知限制

- **基线只在会话开始时建立**。插件安装之前就已经开始的会话没有基线，弹窗会提示「无法判断哪些文件是它产生的」，此时只能删会话本身。
- **会话开始时就存在、且整段会话都没变过的文件不会被列出**——它们不是这次会话的产物，这是设计意图。
- **你在会话进行中亲手改的文件也会进「改动」组**（快照看不出是谁改的）。它不是默认勾选项，但请留意。
- **扫描有预算**：单次快照/对比最多访问 `maxEntries` 个文件（默认 20 万）或超出时间预算即截断，弹窗会提示，截断时清单可能不完整（宁可漏报也不误报）。
- **长会话的清单会很大**：基线是会话开始时建立的，会话活得越久，`plan` 列出的「新建」就越多（也包含你自己后来放进工作目录的东西）。为此**默认只勾选最新的 400 个新建文件**，其余仍然列出但默认不勾——请按需手动勾。
- **弹窗最多渲染 2000 行**文件（更长的清单只显示前 2000 条，但「合计」和接口返回的仍是完整清单）。
- **请求体上限 4 MB**：路径清单本身很小，正常使用不会触及；一次选中上万条极端路径时才会遇到。
- **回收站不会自动过期**，除非下一次清理动作触发保留期检查；也可以手动删 `~/.dsh/session-file-purge/trash` 下的目录。
- **会话删除链路复用了 `storageDomain` 的 `session_projcache` / `workspace` 表结构**，DSH 大版本升级后需要跟着核对（本版本对 `0.2.0-rc.2` 验证）。
- 只清理**工作目录内**的文件；会话写到 `/tmp`、其他盘符或家目录别处的文件不在范围内。

### 排障

`~/.dsh/session-file-purge/diagnostics.log` 记录插件启动过程，每行是 `时间 事件 详情`：

| 事件 | 含义 |
|---|---|
| `module-load` | 宿主端模块被 import（说明 row 存在、包能被解析） |
| `apply` | `apply` 开始执行，详情带 `webServer present: true/false` |
| `http-register` | HTTP 路由注册成功，详情说明走的是 `direct`/`inject`/`poll` 哪条路 |
| `http-register-skipped` | 拿到了服务但没有 `register()` 方法 |
| `inject-no-webServer` | 延迟注入回调里没有 webServer 服务 |

- 只有 `module-load`、没有 `apply` → 插件未被激活（见上一节「给插件作者的一个坑」）。
- 有 `apply`、没有 `http-register` → webServer 服务时序问题；插件已用「直接取 / 延迟注入 / 轮询」三条路兜底。
- `GET /__sespurge/ping` 返回插件名与 pid，一条命令判断宿主端是否活着。

### 开发

```
src/index.js            宿主端：快照调度、清单、回收站、会话删除链路、HTTP 接口、agent 工具
src/scan.js             目录遍历与基线对比（忽略规则、预算、越界校验）
src/trash.js            回收站：清单、移入、放回、永久删除
src/diagnostics.js      启动诊断日志
src/client.js           客户端 bundle：头部按钮、两步弹窗、回收站面板、侧边栏注入
test/plugin-contract.mjs  插件契约测试（复刻加载器的 Config / 激活判定）
test/bundle-install.mjs   bundle 安装契约（包名 / bundles 条目 / patch 行名 / node_modules 目录名必须一致）
test/scan-rules.mjs       遍历忽略规则、越界校验、基线对比、预算截断
test/harness.mjs          宿主端行为测试（假 ctx + 假 storageDomain）
test/client-smoke.mjs     客户端 bundle 冒烟测试（假 React + 假 fetch）
tools/run-tests.mjs       跑全部测试套件
tools/verify-live.mjs     对运行中的 harness 做只读验证（ping / 会话列表 / 回收站，可选一次只读 plan）
tools/asar-read.mjs       从桌面版 app.asar 里读单个文件，便于查证运行时内部实现
```

```sh
node tools/run-tests.mjs                 # 或 npm test
node tools/verify-live.mjs               # 针对运行中的实例，只读
node tools/verify-live.mjs --plan <sessionId>
```

五套测试都是纯 `node`，不需要安装任何依赖（`@deepseek-ai/dsh-tools` 由测试自己 stub）。两个最值得记住的：

- 改了忽略规则或路径校验 → 务必跑 `test/scan-rules.mjs`，它是唯一会阻止「清单里出现不该出现的文件」的防线；
- 改了包名、`cordis.patch.yml` 的行名或导出路径 → 跑 `test/bundle-install.mjs`，它复刻启动器的四步解析（bundles 条目 → 目录 → patch → 按行名导入模块），这四处名字不一致时 bundle 会被**静默跳过**。

### 许可

MIT。

---

## English

### Why this exists

Like most harnesses, DSH keeps **no per-session ledger of files**. A session log holds the session's own data; the files a model writes through the shell, python, or a build script are invisible to it. Session-delete plugins such as [`@pepsi-ai/dsh-plugin-session-delete`](https://www.npmjs.com/package/@pepsi-ai/dsh-plugin-session-delete) therefore remove the session log, projection cache and workspace accounting — and leave every generated file in your working directory for you to clean up by hand.

This plugin closes that gap: **it snapshots the working directory when a session starts, lists the files created or changed since that snapshot when you delete the session, moves the checked ones into a trash directory, and only then removes the session.**

### Why a filesystem snapshot and not the tool-call log

The transcript does carry `write`/`edit`/`present` arguments, so paths could be scraped from it — but the log is a compressed internal format, and more importantly it under-reports badly: `python build.py`, `npm run build`, a redirect or any script writes files that never appear as a path anywhere in the log. A filesystem diff sees every writer. The cost is one directory walk per session start (`node_modules`, `.git` and build caches are skipped), which is noticeable only on very large trees.

### Features

- **Baseline snapshot** on the session's first `turn/start`, before any tool runs: `path → size/mtime` for the whole working directory, stored under `~/.dsh/session-file-purge/baselines/<sessionId>.json`.
- **Checkbox list** at deletion time, split into *created* (checked by default) and *changed* (unchecked — those existed before the session, so moving them whole is riskier), with per-group select-all and per-file sizes.
- **Trash first, delete second**: checked files move to `~/.dsh/session-file-purge/trash/<timestamp>-<short id>/files/` preserving their relative paths, with a `manifest.json`; the session log, projection cache and workspace accounting are removed only afterwards. Folders the purge emptied are removed; folders that still hold files are left alone.
- **Undo**: the final step restores the batch; a trash panel in the sidebar lists every batch with restore and delete-for-good.
- **Files only**: a sidebar item purges a session's files while keeping the session.
- **Agent tool** `session_files`: `mode: "list"` or `mode: "purge"` with explicit `paths`.

### Install

```sh
# from GitHub (the repository root is the package)
dsh plugin --profile <profile> add github:FJHin/dsh-plugin-session-file-purge

# from a local checkout
dsh plugin --profile <profile> add file:/path/to/dsh-plugin-session-file-purge
```

Restart the profile afterwards: a newly added bundle is resolved during composition and is not hot-loaded into a running instance.

No third-party runtime dependencies: the host half uses only `node:fs`/`node:os`/`node:path`, and the client bundle reaches the shared UI through the module table (`require('react')`, `require('@deepseek-ai/dsh-client-ui-primitives')`). The only peer, `@deepseek-ai/dsh-tools`, is optional, so a composition without the tool registry still loads the plugin.

### HTTP API

| Method | Path | Purpose |
|---|---|---|
| GET | `/__sespurge/ping` | liveness: plugin name and host pid |
| GET | `/__sespurge/session/list` | session list (title/id/running/has-baseline) |
| POST | `/__sespurge/plan` | `{sessionId}` → what a purge would move (read-only) |
| POST | `/__sespurge/purge` | `{sessionId, paths[]}` → trash the selection, keep the session |
| POST | `/__sespurge/cleanup` | `{sessionId, paths[], deleteSession}` → trash, then delete |
| GET | `/__sespurge/trash` | trash batches |
| POST | `/__sespurge/trash/restore` | `{id, paths?}` → restore one file or a whole batch |
| POST | `/__sespurge/trash/drop` | `{id}` → delete a batch for good |

Paths are always relative to the session's working directory and are re-validated with `resolveInside`; anything escaping the root is refused and reported in `failed`.

### Configuration

| Field | Default | Meaning |
|---|---|---|
| `maxEntries` | `200000` | files visited per snapshot/diff before the result is marked `truncated` |
| `baselineBudgetMs` | `30000` | time budget for a baseline snapshot |
| `planBudgetMs` | `20000` | time budget for building the cleanup list |
| `trashRetentionDays` | `30` | trash retention; expired batches are dropped by the next purge |

> **A trap for plugin authors**: this plugin deliberately does **not** export `Config`. A cordis plugin that exports `Config` declares a schemastery schema, and the loader validates the row's config through `Config['~standard'].validate(...)`. Exporting a plain defaults object throws during config resolution, so the row silently never activates: the module is imported, `apply` is never called, no HTTP route is registered — while the client bundle still gets published (that scan only looks for the `dsh.client` declaration). The symptom is confusing: a working new UI over a host that answers 404/405 to everything. `test/plugin-contract.mjs` reproduces the loader step so this cannot regress.

### Safety

- `plan` is read-only; only `purge`/`cleanup` move files, and they `rename` (falling back to copy-then-remove across devices).
- Every client- or model-supplied path goes through `resolveInside(root, path)`.
- `node_modules`, `.git` and build caches never enter a snapshot or a list.
- Nothing is deleted silently: selected files go to the trash, and `drop` is the only real deletion, scoped to a trash batch.
- Only *created* files start checked; *changed* files are listed with an explicit warning.
- No network access, no credentials, no writes outside `~/.dsh/session-file-purge/` and the moves you confirm.

### Known limitations

- A session that started before the plugin was installed has no baseline and cannot have its files identified.
- Files that already existed and were never touched during the session are not listed.
- Files **you** edited during the session land in the *changed* group (a snapshot cannot tell who wrote what).
- Scans are budgeted (`maxEntries`, default 200,000 files, plus a time budget); a truncated scan says so in the dialog.
- A long-lived session accumulates a long *created* list (it also includes things you placed in the working directory yourself). Only the newest 400 created files start checked; the rest are listed unchecked.
- The dialog renders at most 2,000 file rows (the totals and the API response stay complete).
- Request bodies are capped at 4 MB, which only a pathological selection of tens of thousands of paths would reach.
- The trash does not expire on its own except through the retention check on the next purge.
- The session-deletion chain relies on the `session_projcache` / `workspace` storage tables and needs re-checking after a major DSH upgrade (verified against `0.2.0-rc.2`).
- Only files inside the working directory are considered.

### Troubleshooting

See `~/.dsh/session-file-purge/diagnostics.log` (one line per lifecycle step: `module-load`, `apply`, `http-register`, …) and `GET /__sespurge/ping`. `node tools/verify-live.mjs` walks the read-only routes against a running harness and prints sessions, baselines and trash batches; add `--plan <sessionId>` to inspect what a purge would move (still read-only).

### License

MIT.
