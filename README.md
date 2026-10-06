# dsh-users-open-source

DeepSeek Harness 插件「**开源用户**」：本机带宽测速 + 一键打开工作区目录。

- 设置 → **开源用户**：一台网速检测器（**打包 / 上传** 两项指标）、一颗 **「上传」** 按钮、
  **「自动上传」** 定时设置、**「云端备份」** 按钮（在文件管理器里打开本地工作区文件夹）、
  最近记录（每条可单独删，也能一键清空）、**上传图片**（把测速时弹的那张换成自己的图，可随时恢复默认）。
- 左侧栏「插件」下面多一栏：实时显示当前带宽（`↓1.23G ↑0.98G`），测速时显示「开源中」
  并在那一栏下面弹出那张图（尺寸可在设置里调，默认 120px），点进去是完整面板（标题「本机自动开源」）。

## 它到底在测什么（重要）

插件在宿主进程里起一个 **只绑定 `127.0.0.1` 的回环测速口**（随机端口），然后自己当客户端压这个口：

- **不连接任何外部服务器**：字节只在「本进程 ↔ 本机回环网卡」之间来回；局域网里其它机器也连不上；
- **不消耗 token**：不注册模型工具、不写系统提示、不发任何模型请求，与 LLM 完全无关；
- 因此它量的是**本机协议栈 / 回环吞吐上限**（常见几 GB/s），不是运营商带宽 ——
  想测运营商带宽必须有一个外部对端，那与「不接其他服务器」的要求冲突。

想跑满带宽：把「单次时长」「并发连接」调大，点「上传」。

## 安装

```bash
dsh plugin --profile <profile> add dsh-users-open-source
```

装完重启一次 dsh web。`dsh-users-open-source-workspace` 是本包的 `dependencies`，会一起装上；
两条 loader entry 都由本包的 `cordis.patch.yml` 插入。

## 仓库结构

```
packages/
├─ dsh-users-open-source/            主包
│  ├─ lib/host.js                    回环测速口 / 测速引擎 / 自动上传调度 / HTTP 路由
│  ├─ lib/client.js                  客户端半边（设置页「开源用户」、侧栏、主面板）
│  ├─ lib/*                          无
│  ├─ cordis.patch.yml               插入两条 entry（本包 + 伴生包）
│  └─ tests/smoke.mjs                21 项自检
└─ dsh-users-open-source-workspace/  伴生包（不是独立 bundle）
   ├─ lib/index.js                   POST /dsh-users-open-source/open-workspace
   ├─ lib/open-folder.ps1            Windows：Explorer 打开 + 显形（含踩坑注释）
   ├─ lib/focus.cs                   Win32 声明
   └─ tests/smoke.mjs                9 项自检
```

**为什么拆成两个包**：主包带 `dsh.client` 半边，而 `dsh-client-modules` 按「模块最近的
package.json」判定来源包 —— 同一个包里挂第二条 loader entry，无论写包内子路径（loader 解析不了）
还是写 `file:` URL（被判成第二个 Loader 源）都会让启动失败。独立成包后 entry name 就是包名，
两边都干净。

## 几处踩坑记录

- **隐身窗口**：DSH 以隐藏方式启动插件子进程，直接 `spawn('explorer.exe', [dir])` 打开的窗口
  `IsWindowVisible` 是 `false` —— 窗口存在但看不见。所以 Windows 上走 `lib/open-folder.ps1`，
  用 `Shell.Application.Explore` + `ShowWindow` 把它显示出来。
- **不要强抢焦点**：脚本里刻意**没有** `HWND_TOPMOST`、也没有循环 `SetForegroundWindow`。
  试过，观感像被劫持（"我是不是中病毒了"）。现在只显示 + 给一次焦点，然后撒手。
- **不要加 ALT 技巧**：合成 ALT 按键会释放前台锁，反而让两个窗口每几百毫秒互相抢焦点。

## 开发

```bash
pnpm install
pnpm test                                   # 两个包各自的 smoke
```

本地联调（不经过 npm registry）：

```bash
dsh plugin --profile <profile> add "link:<本仓库>/packages/dsh-users-open-source"
```

- 客户端半边 `lib/client.js` 由 `dsh-client-hmr` 热重载，刷新页面即可；
- 宿主侧 `lib/host.js` / `lib/index.js` 改动要重启 dsh web（模块进了 ESM 缓存）；
- `lib/open-folder.ps1` / `lib/focus.cs` 每次调用现读，改完立刻生效。

## 发布

```bash
pnpm install
pnpm -r publish --access public
```

先发 `dsh-users-open-source-workspace`，再发 `dsh-users-open-source`（后者依赖前者）。

## License

MIT
