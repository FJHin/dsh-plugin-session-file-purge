# 发布到 GitHub —— 把这个文件夹传上去

这个文件夹就是完整的仓库根目录，可以直接上传：`git init` 已经做过、文件已 staged 在 `main` 分支上，只差提交和推送。

> 对读者来说，这个文件只是「维护者备忘」；插件怎么用看 [介绍.md](介绍.md) 和 [README.md](README.md)。不想让它出现在仓库里，删掉即可（它不在 npm 包的 `files` 里）。

## 一、文件夹里有什么

```
dsh-plugin-session-file-purge/
├── 介绍.md               ◄ 给人看的介绍（可分享）：为什么需要它、怎么工作、怎么用、限制
├── README.md                查阅型文档：安装、界面入口、HTTP 接口、配置、安全设计、排障（中英双语）
├── 发布到GitHub.md          ◄ 本文件：上传步骤、上线后自检、已知不完善
├── LICENSE                  MIT
├── package.json             包清单（无 scope 的公开包名，version 0.1.1）
├── cordis.patch.yml         bundle 层：向 profile 插入本插件的行
├── .gitignore               排除 node_modules、研究笔记、诊断日志
│
├── src/                     插件本体，零第三方运行时依赖
│   ├── index.js               宿主端：快照调度、清单、回收站、会话删除链路、HTTP 接口、agent 工具
│   ├── scan.js                目录遍历与基线对比：忽略规则、预算、越界校验
│   ├── trash.js               回收站：清单、移入、放回、永久删除
│   ├── diagnostics.js         启动诊断日志
│   └── client.js              客户端 bundle：头部按钮、两步弹窗、回收站面板、侧边栏注入
│
├── test/                    136 条断言，五套，全部纯 node、零安装
│   ├── plugin-contract.mjs    插件契约（复刻加载器的 Config / 激活判定）
│   ├── bundle-install.mjs     安装契约（包名/patch 行名/目录名四处一致，否则 bundle 被静默跳过）
│   ├── scan-rules.mjs         忽略规则、越界拦截、基线差异、预算截断
│   ├── harness.mjs            宿主端行为（假 ctx + 假 storageDomain）
│   └── client-smoke.mjs       客户端 bundle 冒烟（假 React + 假 fetch）
│
└── tools/                   开发与排障脚本
    ├── run-tests.mjs          跑全部测试套件（npm test）
    ├── verify-live.mjs        对运行中的实例做只读验证（ping / 会话列表 / 回收站，可选只读 plan）
    └── asar-read.mjs          从桌面版 app.asar 里读单个文件，便于查证运行时内部实现
```

共 20 个文件、约 190 KB。**没有任何密钥、凭据、个人路径或真实会话 ID**：文中的 `session-00000000-…`、`D:/work/demo`、`C:/home/.dsh/...` 都是测试夹具里的假值；`test/scan-rules.mjs` 里出现的 `../../etc/passwd` 是越界校验的测试样本。

## 二、占位符（已替换为 FJHin）

仓库地址已经写死成 `FJHin/dsh-plugin-session-file-purge`，**上传前不需要再改任何东西**：

| 位置 | 现在的内容 |
|---|---|
| `package.json` 的 `repository.url` | `https://github.com/FJHin/dsh-plugin-session-file-purge.git` |
| `package.json` 的 `bugs.url` | 同上 + `/issues` |
| `package.json` 的 `homepage` | 同上 + `#readme` |
| `README.md` 安装段（中/英各一处） | `github:FJHin/dsh-plugin-session-file-purge` |
| `LICENSE` 版权行（可选） | `dsh-plugin-session-file-purge contributors` — 想署名就改成你的名字 |

确认没有残留占位符：

```sh
grep -rn "OWNER" . --exclude-dir=node_modules --exclude-dir=.git   # 应无输出
```

## 三、上传

```sh
cd dsh-plugin-session-file-purge-发布包

# 这个文件夹已经 git init 过、20 个文件已 staged 在 main 分支上（0 个 commit）；
# 如果 git 报「请告诉我你是谁」，先配置一次：
git config user.name  "你的名字"
git config user.email "你的邮箱"

git add -A
git commit -m "feat: delete a DSH session together with the files it produced"
git remote add origin https://github.com/FJHin/dsh-plugin-session-file-purge.git
git push -u origin main
```

用 GitHub CLI 的话一条命令搞定：`gh repo create dsh-plugin-session-file-purge --public --source . --push`（仓库会建在你当前登录的账号下）。

**仓库名请保持 `dsh-plugin-session-file-purge`**：包名、`cordis.patch.yml` 的行名、`node_modules` 目录名和仓库名保持一致，`dsh plugin add github:FJHin/dsh-plugin-session-file-purge` 才能直接解析到根目录的 `package.json`。这条一致性有测试盯着（`test/bundle-install.mjs`）。

## 四、上传后自检

```sh
node tools/run-tests.mjs        # 五套全绿（136 条断言）
```

然后在一个**测试用 profile** 上真装一次，确认启动器能解析：

```sh
dsh plugin --profile <测试profile> add github:<你的用户名>/dsh-plugin-session-file-purge
# 重启该 profile，然后：
curl http://127.0.0.1:<端口>/__sespurge/ping
# 期望：{"ok":true,"value":{"plugin":"session-file-purge","pid":…,"via":"…"}}
```

`ping` 有返回就说明宿主端注册成功。若 404/405，看 `~/.dsh/session-file-purge/diagnostics.log`：

- 只有 `module-load`、没有 `apply` → 插件没被激活（多半是导出了 `Config` 之类让加载器配置校验抛错的东西）
- 有 `apply`、没有 `http-register` → webServer 服务时序问题（插件已用「直接取 / 延迟注入 / 轮询」三条路兜底）

## 五、可选：发布到 npm

包的 `files` 只包含 `src/`、`cordis.patch.yml`、`README.md`、`LICENSE`（`test/`、`tools/`、`介绍.md` 只进仓库、不进 npm 包）。要发 npm 的话：

```sh
npm publish --access public
```

发完之后安装方式就多一种：`dsh plugin --profile <profile> add dsh-plugin-session-file-purge`。

## 六、已知不完善的地方（可以先写进 README 的「Known limitations」，或作为 issue 记下来）

- 只在 **Windows 11 + Node 24.18.1 + DSH 0.2.0-rc.2** 上实测过；macOS / Linux 未验证。
- 会话删除链路依赖 DSH 内部的 `session_projcache` / `workspace` 存储表结构，DSH 大版本升级后需要跟着核对。
- 插件安装之前就已开始的会话没有基线，清不了文件。
- 长会话的「新建」清单会很长（默认只勾最新 400 个，弹窗最多渲染 2000 行）。
