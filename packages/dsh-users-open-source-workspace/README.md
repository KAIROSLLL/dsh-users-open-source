# dsh-users-open-source-workspace

`dsh-users-open-source` 的伴生插件：受理 `POST /dsh-users-open-source/open-workspace`，在系统文件管理器里
打开**用户当前正在用的那个工作区目录**（Web 界面上就是设置页「开源用户」里的 **云端备份** 按钮）。

## 目录是怎么定的

按可靠性依次尝试，任一命中即用：

1. 请求里带 `sessionId` → 命中该会话所属的工作区（最准）；
2. 会话日志分桶目录里**最新写入**的那个桶 → 编码回工作区路径
   （例如 `D:\work\my-project` ⇄ `--D-work-my-project--`）。当前会话一直在写日志，所以这条能顶住 id 缺失；
3. 会话投影缓存 `$DSH_HOME/storages/session_projcache/sessions/*.json` 里最新那份的 `cwd`；
4. 注册表里 `updatedAt` 最新的工作区；
5. 全落空 → 注册表第一个工作区。

客户端只能递 `sessionId`，**路径永远由宿主从 DSH 自己的账本里取**，所以不存在
「递个路径就打开任意目录」的面。打开动作走宿主自己的 `ctx.subprocess`，目录作为 argv
里的一项直传、不经 shell，所以空格、中文、`&` 都不会被当成命令。

## 为什么 Windows 上要绕一圈 PowerShell

DSH 以**隐藏方式**启动插件的子进程 —— 直接 `spawn('explorer.exe', [dir])` 得到的窗口
确实存在（COM 能枚举到 `CabinetWClass`），但 `IsWindowVisible` 是 `false`：**看不见**。
后台进程再直接调 `SetForegroundWindow` 也会被 Windows 拒绝。

所以 Windows 上改走包内的 `open-folder.ps1` + `focus.cs`：用 `Shell.Application.Explore`
打开目录，再用 `AttachThreadInput` + `ShowWindow(SW_SHOW/SW_RESTORE)` +
`BringWindowToTop` + `SetForegroundWindow` 把窗口真正显示并顶到前台（实测：窗口
`visible` 由 false 变 true，前台窗口变成「工作区名 - 文件资源管理器」）。

## 为什么是独立的包

`dsh-users-open-source` 带 `dsh.client` 客户端半边，而 `dsh-client-modules` 按「模块最近的
package.json」判定来源包 —— 同一个包里再挂第二个 loader 入口：

- name 写包内子路径 → loader 解析不了，entry 报 `failed to import`；
- name 写 file: URL → 被算成本包第二个 Loader 源，启动直接崩：
  `client-modules: package dsh-users-open-source resolves from multiple active Loader sources`。

独立成包后 entry name 就是包名，两边都干净，宿主侧改动也不必等 dsh web 重启。

## 安装

```powershell
# 通常不需要单独装：它由主包 dsh-users-open-source 作为 dependency 带上来
dsh plugin --profile desktop add "link:<本仓库>\packages\dsh-users-open-source-workspace"
```

## 自检

```powershell
node tests/smoke.mjs
```

9 项：路由注册、sessionId 命中、三条兜底线索各自命中、全落空退第一个、
目录缺失、无工作区、非 POST 405。
