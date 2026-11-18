# dsh-session-delete

给 DeepSeek Harness 的 Web/桌面端补一个**真正删除会话**的按钮。

官方桌面端（0.2.2-rc.1）只有「归档会话」（移出列表、可恢复），
`session delete` 只存在于 ACP 协议和一个内部 API 里，界面没接。
这个插件把缺的那一环补上：**在会话右键菜单里加一条「删除对话」**
（排在「归档会话」后面，红字 + 垃圾桶图标），确认后就把这个会话在磁盘上的
日志目录真删掉。会话标题栏也留了一个垃圾桶按钮，走同一个确认弹窗。

实现走的是官方自己的菜单注册表 `ctx.contextMenus.register`
（`target: "session"`, `order: 700`），不是往 DOM 里塞节点 ——
所以右键菜单的样式、键盘导航、关闭动画都跟官方项一致。

## 行为

1. 右键会话 → 「删除对话」→ 弹窗确认（标题里点出会话名，并提示不可恢复）；
2. `POST /plugin/session-delete`，主机半边用 `node:fs` 删掉
   `<sessions root>/<项目目录>/<sessionId>/`；
   句柄还被 Windows 占着时（`EBUSY/EPERM/EACCES/ENOTEMPTY`）主机侧重试 6 次；
3. 如果主机报 `in-use`（这个会话的 agent 还攥着日志句柄），
   客户端先切到一个空白会话让宿主 dispose，再重试 3 次；
4. 刷新会话列表；列表里还赖着就整页 reload 兜底。

## 边界（写清楚，别踩）

- **不可恢复**：删的是磁盘目录，不进回收站。想留着就用官方的「归档」。
- **不级联**：这个会话派生出的 subagent 子会话目录不会一起删
  （它们是独立 session id，通常也不在会话列表里显示）。
- **不清理**：工作区注册表里的 stale id、归档标记都留着不动（无害）。
- 搜索索引 `dsh-session-query-sqlite` 自带 `_reconcile()`，磁盘上没了的会话
  会在下次搜索时自动从索引里清掉，不用手动清库。

## 结构

```
lib/index.js    主机半边：注册 POST /plugin/session-delete，node:fs 删目录
lib/client.js   浏览器半边：右键菜单项（ctx.contextMenus）+ 确认弹窗（槽 shell.overlay）
                + 标题栏按钮（槽 conversation.session.header.actions）
cordis.patch.yml  插件装载条目
test/index.test.mjs  主机半边单测（15 例，夹具默认落系统临时目录）
test/client.test.mjs 浏览器半边接线测试（6 例，stub 掉 window.__ModuleLoader__）
```

改完源码要**重启 DeepSeek Harness** 才会生效（主机半边重载、客户端 bundle
在启动时构建进模块图）。

## 安装 / 卸载

从 GitHub 装（不需要 npm，也不要求源码在本机）：

```powershell
dsh plugin --profile desktop add "git+https://github.com/yueshao-hash/dsh-session-delete.git"
dsh plugin --profile desktop remove dsh-session-delete
```

自己改源码调试时，把 spec 换成 `link:<你的目录>`：

```powershell
dsh plugin --profile desktop add "link:<你的源码目录>"
```

装完**重启 DeepSeek Harness**。也可以手改 `<DSH_HOME>/profiles/desktop/package.json`：
`dependencies` 加一条 spec，`dsh.profile.bundles` 加 `"dsh-session-delete"`。

插件不关心自己装在哪：会话根目录是运行时从宿主的 `ctx.sessionPersistence.root`
读的（读不到才退回 `$DSH_HOME/sessions`），装在哪个盘、哪个目录都一样。

## 测试

在包目录下跑（不需要 DSH 在运行）：

```powershell
node test/index.test.mjs
node test/client.test.mjs
```

夹具默认建在系统临时目录（`os.tmpdir()`），跑完自动删；想指定位置就设
`DSD_TEST_SCRATCH`：

```powershell
# Windows
$env:DSD_TEST_SCRATCH = "<你想放夹具的目录>"
node test/index.test.mjs
# macOS / Linux
DSD_TEST_SCRATCH=/tmp/dsd node test/index.test.mjs
```

主机半边 15 例（含根目录解析、跨项目目录删除、句柄重试、路由状态码、
cordis 未注入服务时不抛异常），浏览器半边 6 例（用 stub 的
`window.__ModuleLoader__` 真加载 `lib/client.js`，验证菜单项 / 弹窗 / 图标 /
标题栏按钮的注册与删除顺序）。

## 踩过的坑（留着，别重犯）

- **cordis 的 `ctx` 代理只允许读 `inject` 里声明过的服务**。
  没声明就 `Reflect.get(ctx, 'connection')` 会抛
  `cannot get property "connection" without inject`；
  这个异常从路由 handler 冒出去会被 `dsh-host-webserver` 兜住，
  变成**空响应的 400**（不是 401/403，很容易误判成"路由没注册"）。
  → 所以 `inject` 必须是 `['webServer', 'connection', 'sessionPersistence']`。
- 客户端 bundle 由 `@deepseek-ai/dsh-client-modules` 在**启动时**构图服务，
  改了源码要重启（或用 `plugin_manager set_bundle` 关一次再开一次，能热重载）。

## 安全

- 路由要求同源 + 已认证（复用宿主的 `connection.requestRejection`）；
- 只接受 POST；请求体 ≤ 4KB；`sessionId` 必须匹配
  `/^[A-Za-z0-9][A-Za-z0-9._-]{5,127}$/`，杜绝路径穿越；
- 只在会话持久化根目录的各项目子目录里找同名 id，不做任何递归上升。