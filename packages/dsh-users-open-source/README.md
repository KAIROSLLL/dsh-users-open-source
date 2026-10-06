# dsh-users-open-source

DeepSeek Harness 插件「**开源用户**」：本机带宽测速 + 一键打开工作区目录。

> 这是 monorepo 里的**主包**。伴生包 `dsh-users-open-source-workspace`（负责"打开工作区目录"那一半）
> 是本包的 `dependencies`，会随本包一起装上 —— 用户只需要装本包一个名字。

## 功能

**设置 → 开源用户**

- **打包 / 上传** 两项指标，一颗 **「上传」** 按钮（点一下跑一轮测速）；
- 实时进度条 + 瞬时速率柱状图，测速时柱形图下面会弹出那张图；
- **自动上传**：每隔一段时间 / 每天某个时刻自动跑（跑在宿主进程里，浏览器关着也照跑）；
- **最近记录**：每条可单独删，也能一键清空；
- **上传图片**：把测速时弹的那张换成自己的图，也能一键恢复默认；旁边可调"侧栏图片"宽度。

**左侧栏「插件」下面多一栏**

- 平时显示当前带宽 `↓1.23G ↑0.98G`；没测过时显示 **等待上传**；测速中显示 **开源中**；
- 测速时在那一栏里接一张图 —— 图是**栏目内容的一部分**（把栏目撑高），不是浮层，不会挡住别的东西。

**主面板 `net-speed`**：标题「本机自动开源」，和设置页是同一台仪器。

## 它到底在测什么（重要）

插件在宿主进程里起一个 **只绑定 `127.0.0.1` 的回环测速口**（随机端口），然后自己当客户端压这个口：

- **不连接任何外部服务器**：字节只在「本进程 ↔ 本机回环网卡」之间来回；局域网里其它机器也连不上；
- **不消耗 token**：不注册模型工具、不写系统提示、不发任何模型请求，与 LLM 完全无关；
- 因此它量的是**本机协议栈 / 回环吞吐上限**（常见几 GB/s），不是运营商带宽 ——
  想测运营商带宽必须有一个外部对端，那与「不接其他服务器」的要求冲突。

想跑满带宽：把「单次时长」「并发连接」调大，点「上传」。

## 目录结构

| 文件 | 作用 |
| --- | --- |
| `lib/host.js` | 宿主半边：回环测速口、测速引擎、自动上传调度，以及 `state` / `run` / `cancel` / `config` / `history` / `asset/*` 路由 |
| `lib/client.js` | 客户端半边：设置页「开源用户」、侧栏那一栏、主面板 |
| `assets/code-upload.jpg` | 测速时弹的那张默认图（用户可自行上传替换） |
| `cordis.patch.yml` | 插入两条 loader entry：本包 + 伴生包 |
| `tests/smoke.mjs` | 自检（`node tests/smoke.mjs`） |

## 安装

```powershell
# 从 npm（推荐）
dsh plugin --profile desktop add dsh-users-open-source

# 本地开发（不经过 registry）
dsh plugin --profile desktop add "link:<本仓库>\packages\dsh-users-open-source"
```

装完**重启一次 dsh web**。伴生包是本包的 `dependencies`，不需要单独装；
两条 loader entry 都由本包的 `cordis.patch.yml` 插入。

- 客户端半边 `lib/client.js` 由 dsh-client-hmr 热重载，刷新页面即可；
- 宿主侧 `lib/host.js` 改动要重启 dsh web（模块进了 ESM 缓存）。

## 配置

存在 `$DSH_HOME/dsh-users-open-source/config.json`，历史在同目录 `history.json`（保留最近 60 条）。

| 字段 | 含义 | 边界 |
| --- | --- | --- |
| `durationMs` | 单次测速时长 | 500–15000 ms（打包、上传各一次） |
| `connections` | 并发连接数 | 1–16 |
| `sidebarImageSize` | 侧栏那张图的宽度 | 60–400 px（默认 120） |
| `schedule.mode` | `off` / `interval` / `daily` | — |
| `schedule.intervalMinutes` | interval 模式的间隔 | 1–10080 分钟 |
| `schedule.dailyTime` | daily 模式的时刻 | `HH:MM` |

用户上传的图存在 `$DSH_HOME/dsh-users-open-source/sidebar-image.<ext>` —— **不动包内文件**，
所以升级插件不会覆盖你自己换的图。

## HTTP 接口（同源，浏览器用）

```
GET  /dsh-users-open-source/state                当前状态（running / progress / config / last / history / customImage）
POST /dsh-users-open-source/run                  开始一次测速（后台跑，立即返回；已在跑返回 409）
POST /dsh-users-open-source/cancel               取消
POST /dsh-users-open-source/config               保存配置（立刻重排定时器）
POST /dsh-users-open-source/history              删记录：{action:'clear'} 清空，{action:'delete', at} 删单条
GET  /dsh-users-open-source/asset/image          当前那张图（用户上传的优先，否则包内默认图）
POST /dsh-users-open-source/asset/image          换图：{type:'image/png', data:'<base64>'}（≤3 MB）
POST /dsh-users-open-source/asset/image/reset    恢复默认图
GET  /dsh-users-open-source/asset/code-upload.jpg 包内默认图
```

「打开工作区目录」的接口 `POST /dsh-users-open-source/open-workspace` 在**伴生包**里。

## 自检

```powershell
cd packages/dsh-users-open-source
node tests/smoke.mjs
```

## License

MIT
