# page-harness

[English](./README.md)

给任意正在运行的前端地址，页面上就多出 **取点 / 产物 / 对话** 底栏，由你本机已有的编码 Agent CLI（Claude Code、Codex、Cursor Agent、CodeBuddy Code、OpenCode）驱动。不需要沙箱、不需要账号、不用改你的项目代码。

```bash
npx page-harness http://localhost:5173 --project ./my-app --agent claude
# 打开 http://127.0.0.1:17990 —— 页面就是你的应用，右下角多出底栏
```

## 功能

- **取点（Pick）**：点选页面元素后选择要做什么：**引用到对话**（选择器、文本、outerHTML 附到下一条消息；Shift+点击直接引用）、**评论**、**编辑**（没有源码的站点）或 **Live 候选**。Live：选中元素、描述改动，Agent 直接在源码里写出 2–4 个候选；你在页面上轮换、并排对比、调参数、细化某一个，最后采用或放弃。
- **对话（Chat）**：可拖动、可缩放的对话窗。流式回复，Markdown 与代码高亮，可折叠的思考过程，工具卡片，改动文件列表，图片/文件附件（粘贴、拖入、选择），每个会话独立的排队（可拖动排序、编辑、撤回），停止 / 重试，多会话，每个会话可选 Agent 与模型。
- **页面控制**（默认关闭）：允许 Agent 读取页面并点击、输入、选择、滚动。开启时页面顶部有横幅，随时可以停止。
- **产物（Artifacts）**：Agent 通过 MCP 写报告、原型、JSON、图片等文件。标签页预览并保留版本历史：Markdown、沙箱 HTML（桌面 / 手机宽度）、结构化 JSON、代码、图片；可复制、下载、导出 PNG / PDF。
- **意见**：在元素上评论或直接修改、讨论串回复、解决与按页面审批；加 `--share` 后同一网络的同事可以作为评审者加入。没有源码的站点也能用。
- **提问**：Agent 可以向你发选择题或小表单，等你回答后继续。
- **聊天记录**：每个会话都是磁盘上只追加的事件日志。在 `http://127.0.0.1:17991/__ph/history` 或会话切换菜单里浏览、搜索、导出。

## 环境要求

- Node.js 20.11 及以上。
- `PATH` 上至少有一个已登录的 Agent CLI：
  - [Claude Code](https://docs.anthropic.com/en/docs/claude-code)（`claude`）
  - [Codex](https://github.com/openai/codex)（`codex`）
  - [Cursor Agent](https://docs.cursor.com/en/cli/overview)（`cursor-agent`）
  - [CodeBuddy Code](https://www.codebuddy.ai/cli)（`codebuddy`，`npm i -g @tencent-ai/codebuddy-code`）
  - [OpenCode](https://opencode.ai)（`opencode`，`npm i -g opencode-ai`）

启动时会自动检测已安装的 CLI 并在终端里列出。不在默认位置时用 `--claude-path` / `--codex-path` / `--cursor-path` / `--codebuddy-path` / `--opencode-path` 指定。没装的 Agent 也会出现在对话的 Agent 选择器里，置灰，点一下能看到安装命令。

各 Agent 支持情况：

| | Claude Code | Codex | Cursor Agent | CodeBuddy Code | OpenCode |
|---|---|---|---|---|---|
| 流式文字 / 思考过程 | ✓ | ✓ | ✓ | ✓ | 按段¹ |
| 工具卡片、改动文件 | ✓ | ✓ | ✓ | ✓ | ✓¹ |
| 续接对话 | ✓ | ✓ | ✓ | ✓ | ✓ |
| 模型列表 | ✓ | ✓ | ✓ | ✓（取自 `--help`） | ✓（`opencode models`） |
| 推理强度 | – | ✓ | – | ✓（`--effort`） | ✓（`--variant`） |
| 图片附件 | ✓ | ✓ | 只传文件路径 | ✓ | ✓（`--file`） |

¹ `opencode run --format json` 只在每段文字、思考和工具调用结束后才输出，所以回复是一段一段出来的，工具卡片也是一次性出现并完成。

## 用法

```text
page-harness <前端地址> [选项]

  --project <dir>        Agent 工作的项目目录（默认当前目录）
  --agent <id>           claude | codex | cursor | codebuddy | opencode（默认第一个已安装的）
  --model <name>         新会话的默认模型
  --port <n>             应用端口：代理后的前端（默认 17990）
  --control-port <n>     面板 / API 端口（默认应用端口 + 1）
  --host <addr>          监听地址（默认 127.0.0.1）
  --allow-host <name>    额外允许的 Host 头（可重复），比如局域网域名
  --keep-host            把浏览器的 Host 头原样转发给目标
  --public-scheme <s>    http | https：浏览器访问两个端口用的协议（默认 http）；
                         放在同端口卸载 TLS 的负载均衡后面时用 https
  --open                 自动打开浏览器
  --live-guard-hook      安装 git pre-commit 钩子，拒绝提交 Live 候选标记
  --review / --source    强制评审模式（无源码）或源码模式；默认按域名判断
  --share                允许同一网络的同事以评审者身份加入（监听 0.0.0.0）
  --verbose / --quiet
```

`<前端地址>` 可以是端口（`3000`）、`host:port` 或完整 URL。开发服务器的热更新（Vite、webpack、Next.js 等）通过代理照常工作，包括 WebSocket。

## 原理

```text
浏览器 ──► :17990  应用端口  反向代理到你的开发服务器，在 HTML 里注入 /__ph/overlay.js
       └─► :17991  控制端口  面板 UI、聊天记录页、JSON API、WebSocket、MCP
                      │
                      └─ 每一轮对话启动一次 Agent CLI（claude -p / codex app-server / cursor-agent -p /
                        codebuddy -p / opencode run --format json），
                         并接入本地 MCP：page_*、产物、提问、Live
```

- 底栏在 Shadow DOM 里，和你的样式互不影响。对话窗、产物窗是来自控制端口的 iframe，通过 `MessagePort` 握手和页面通信。
- 每个会话记住 Agent 的 session id，后续消息续接同一个 Agent 会话；一轮还在跑时发的消息进入该会话的队列。
- Agent 会收到一段简短的系统提示，说明页面上下文、MCP 工具和 Live 协议。除了 `.page-harness/`（自带 `.gitignore`）和 Live 期间的临时候选标记外，不会往你的项目里写东西。

### MCP 工具

| 工具 | 用途 |
| --- | --- |
| `page_state`、`page_click`、`page_input`、`page_select`、`page_scroll` | 读取与操作页面（仅在用户允许页面控制时可用） |
| `write_artifact`、`read_artifact`、`list_artifacts`、`set_artifact_preview` | 带版本的产物，存放在 `.page-harness/artifacts` |
| `ask_question`、`ask_form` | 向用户提问并等待回答（最长 30 分钟） |
| `live_update` | 上报 Live 候选的 ready / done / failed |
| `live_patch_variants` | 仅评审模式：以一组页面修改的形式给出 Live 候选 |
| `page_note`、`list_review`、`reply_review`、`resolve_review`、`remove_review` | 在页面上钉意见，读取大家的反馈，回复并标记解决 |
| `page_patch` | 仅评审模式：对元素做临时的文字、CSS 或图片修改 |

### Live 候选

收到 Live 请求时，Agent 在源码里把目标元素包成这样：

```html
<div data-ph-live="L1a2b3c4" style="display:contents">
  <h1 data-ph-variant="0" hidden>原版</h1>
  <h1 data-ph-variant="1" data-ph-variant-label="Bold">…</h1>
  <h1 data-ph-variant="2" data-ph-variant-label="Soft" hidden
      data-ph-params='[{"name":"gap","type":"range","min":0,"max":40,"unit":"px"}]'>…</h1>
</div>
```

开发服务器热更新后，底栏找到这个包裹层并接管各候选的显示与隐藏（参数以 `--ph-<name>` CSS 变量写在包裹层上）。采用时让 Agent 只保留选中的候选并去掉包裹层；放弃则还原原版。每次 Live 或改了文件的回合结束后，会用 `git grep` 扫描工作区，发现遗留标记就提醒；`--live-guard-hook` 还会拦住含标记的提交。

### 评审模式（没有源码）

目标是公网站点（不是 localhost、内网 IP 或局域网主机名）时，手里没有源码可改，page-harness 会以评审模式启动；也可以用 `--review` / `--source` 强制指定。

- Agent 会被告知不要改文件、不要做原型。`write_artifact` 只接受报告类文件（`.md`、`.txt`、`.json`、`.csv`、图片），HTML/SVG 原型会被拒绝。
- 结论直接落在页面上：`page_note` 在元素上钉一条带编号的意见（问题 / 建议 / 说明）；`page_patch` 修改元素的文字、CSS 或图片（`src` / `alt`），原地看到效果。不支持改 HTML 结构。
- 两个工具都会先拿选择器到你打开的页面上核对（不需要页面控制权限），选择器写错会直接反馈给 Agent，而不是钉了个空。
- 人也可以直接动手：用「取点」选中元素，点「评论」留言，或点「编辑」实时预览地修改文字、颜色、背景、字号、字重、内边距、圆角或图片，保存为一条修改。
- **Live** 在这里也能用，候选是页面修改：Agent 用 `live_patch_variants` 给出 2–4 个候选，每个候选是最多 12 个元素上的文字 / CSS / 图片修改。在页面上切换、看原版、细化；采用后选中的候选存为「意见」里的修改条目，放弃则还原页面。没有并排对比、参数调节和插入，这些需要源码。

### 意见、讨论与审批

意见在两种模式下都能用；手动编辑和 `page_patch` 只在没有源码时可用。

- 意见属于创建它的页面（路径，忽略 hash、末尾斜杠和统计参数）。「本页」只看当前页面；「全部」按页面分组，点其他页面的条目会跳过去并打开它。底栏角标只计当前页面未解决的意见，其他页面有意见时显示小圆点。
- 每个图钉打开一个讨论串：作者、回复、解决 / 重新打开、修改与原版对比、引用到对话（所有者）、删除（作者或所有者）。
- 「通过」/「需修改」按页面、按人记录审批结论。
- 页面重新渲染或改版导致选择器失效时，用指纹（标签、id、稳定的 class、关键属性、文字及上下文）重新定位。没有足够匹配的元素时显示「页面上找不到了」，而不是钉到错误的元素上。刷新和重新渲染后修改会自动重新套上，不会向站点发送任何东西。
- Agent 用 `list_review` 看到大家的意见，用 `reply_review` 回复，用 `resolve_review` 附上说明后关闭；它只能删除自己的条目。
- 「导出」把 `page-review.md`（意见、文字前后对比、CSS、回复、审批）写入产物。

### 团队评审（`--share`）

```bash
npx page-harness https://example.com --share
#   Share  http://192.168.1.20:17991/__ph/join?t=…
```

把 Share 链接（设置 → 团队里也有）发给同一网络的同事。打开后这个浏览器获得评审者身份，填一次显示名，就能实时看到页面上所有人的意见和修改。评审者可以评论、编辑（评审模式）、回复、解决、审批；不能使用或看到 Agent、对话、聊天记录、上传和页面控制。没有链接的其他机器一律 `403`。

## 安全模型

用户使用上不需要登录：这是本地开发工具，默认只监听 `127.0.0.1`。内部各个入口都有鉴权：

- **两个源。** 你的应用（以及其中任何脚本）在应用端口；面板、API、Agent 接口在控制端口，页面脚本读不到。
- **所有者与评审者。** 不加 `--share` 时只有本机能连，一切按单用户处理。加了 `--share` 后，所有者会话只发给本机回环请求；其他机器必须通过邀请链接拿到带 HMAC 签名的评审者 Cookie（面板和应用端口各一个），没有就两个端口都返回 `403`。评审者在 WebSocket 上只能做评审操作，API 只能读产物，其余一律 `403`。所有者名字在设置 → 团队里修改。
- **会话 Cookie。** 面板拿到 `HttpOnly`、`SameSite=Strict`、作用于 `/__ph` 的 Cookie；转发到你的开发服务器前会去掉它。
- **API。** 读请求要求同源的 `Sec-Fetch-Site`；写请求要求匹配的 `Origin` 加自定义 `X-PH` 头。WebSocket 校验 Cookie 和 `Origin`。
- **MCP。** 每一轮 Agent 调用都发一个独立的 Bearer token（通过环境变量或私有临时文件传递，不出现在命令行），回合结束即作废。来自浏览器的 MCP 请求一律拒绝。
- **Host 白名单。** `Host` 头不符的请求返回 `421`（防 DNS rebinding）。在局域网使用时用 `--allow-host` 添加。
- **嵌入限制。** 面板只允许被应用源嵌入；聊天记录页不允许被任何页面嵌入。
- **产物。** HTML / SVG 产物带 `sandbox` CSP 返回，并放在不含 `allow-same-origin` 的 iframe 里展示。
- **页面控制**需要在浏览器里手动开启，开启时有横幅提示，密码框的值不会发给 Agent。

Agent 以各自 CLI 的非交互权限在 `--project` 里运行（例如 Claude Code `--permission-mode bypassPermissions`、Codex 关闭审批、Cursor Agent `--force`、CodeBuddy Code `--permission-mode bypassPermissions`、OpenCode `run --auto`）。只对你愿意让 Agent 修改的项目使用。

## 数据

全部保存在 `<project>/.page-harness/`：

```text
chats/<id>/meta.json        标题、Agent、模型、session id
chats/<id>/events.jsonl     只追加的事件日志（提问、增量、工具、结果）
artifacts/<name>/v<n>       产物各版本 + index.json
uploads/                    附件
live.json                   Live 会话
review.json                 意见、页面修改、回复与审批
team.json                   邀请 token、签名密钥和评审者名字（权限 600）
```

删除该目录即可重置。

## 开发

```bash
npm install
npm run dev            # 监听并重建前端脚本与 CLI
node dist/cli.js http://localhost:5173 --project ../some-app

npm run lint
npm run typecheck
npm test               # 单元测试 + 服务端集成测试（脚本化 Agent）
npx playwright install chromium
npm run build && npm run test:e2e   # 基于示例应用的浏览器测试
```

设置 `PH_FAKE_AGENT=1` 会多出一个脚本化的 `fake` Agent，测试用它走真实的 MCP 接口，不需要大模型就能覆盖整条链路。

## 许可证

[MIT](./LICENSE)。打包进来的第三方代码见 [THIRD_PARTY_LICENSES.md](./THIRD_PARTY_LICENSES.md)。
