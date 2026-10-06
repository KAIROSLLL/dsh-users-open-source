/**
 * dsh-users-open-source-workspace — 「云端备份」的宿主半边（打开本地工作区目录）。
 *
 * 干什么：受理 `POST /dsh-users-open-source/open-workspace`，在系统文件管理器里打开
 * **用户当前正在用的那个工作区目录**。
 *
 * 目录怎么定的（按可靠性排序，任何一步都只从 DSH 自己的账本里取路径）：
 *   1. 客户端递来的 sessionId 命中的工作区（最准，但客户端不一定拿得到 id）；
 *   2. 最近有写入的会话目录 → 反解它所属的 workspace bucket（`$DSH_HOME/sessions/<bucket>/`）
 *      → 匹配已注册工作区。当前正在跑的会话日志一直在写，所以这一条能顶住 id 缺失；
 *   3. 注册表里的第一个工作区。
 * 客户端永远只能递 sessionId，**路径不由客户端决定**，所以不存在「递个路径就打开任意目录」。
 *
 * 为什么是**独立的包**（而不是 dsh-users-open-source 包里的第二个 entry）：
 *   dsh-users-open-source 带 `dsh.client` 客户端半边，`dsh-client-modules` 按「模块最近的
 *   package.json」判定来源包 —— 同包内再挂第二个 loader 入口，无论 name 写包内子路径
 *   （loader 解析不了，报 failed to import）还是写 file: URL（被算成第二个 Loader 源，
 *   `package dsh-users-open-source resolves from multiple active Loader sources`，启动崩），
 *   都走不通。独立成包后 entry name 就是包名，两边都干净。
 *   顺带：宿主的「云端备份」按钮改用本条路由，所以它不必等 dsh web 重启。
 *
 * @module dsh-users-open-source-workspace
 */
import { existsSync } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 插件名（= 包名 = cordis loader 行 id）。 */
export const name = 'dsh-users-open-source-workspace'
/** 依赖宿主 webServer（挂路由）与 subprocess（起文件管理器）。 */
export const inject = ['webServer', 'subprocess']

/** 路由路径（客户端只认这一个口）。 */
const OPEN_PATH = '/dsh-users-open-source/open-workspace'

/** 本文件所在目录（`open-folder.ps1` 与 `focus.cs` 都放在这里）。 */
const HERE = dirname(fileURLToPath(import.meta.url))

/**
 * 系统自带 PowerShell 的绝对路径（不走 PATH：DSH 给子进程的 PATH 可能是清理过的）。
 * @returns {string} powershell.exe 的绝对路径。
 */
function powershellPath() {
  const root = typeof process.env.SystemRoot === 'string' && process.env.SystemRoot !== ''
    ? process.env.SystemRoot
    : 'C:\\Windows'
  return `${root}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
}

/**
 * 解析 DSH home（与内核 `dshHomePath()` 同优先级：$DSH_HOME 优先，否则 ~/.dsh）。
 * @returns {string} 绝对的 DSH home 路径。
 */
function dshHome() {
  const configured = process.env.DSH_HOME
  if (typeof configured === 'string' && configured.trim() !== '') return configured.trim()
  return join(homedir(), '.dsh')
}

/**
 * 写一个 JSON 响应。
 * @param {import('node:http').ServerResponse} res - 响应对象。
 * @param {number} status - HTTP 状态码。
 * @param {unknown} payload - 要序列化的值。
 */
function sendJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8')
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': String(body.length)
  })
  res.end(body)
}

/**
 * 读取请求体并解析 JSON，带大小上限。
 * @param {import('node:http').IncomingMessage} req - 请求对象。
 * @param {number} [limit] - 最大字节数。
 * @returns {Promise<Record<string, unknown>>} 解析后的对象。
 */
function readJsonBody(req, limit = 8192) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      if (text.trim() === '') {
        resolve({})
        return
      }
      try {
        const parsed = JSON.parse(text)
        resolve(parsed !== null && typeof parsed === 'object' ? parsed : {})
      } catch (error) {
        reject(new Error(`invalid JSON body: ${String(error && error.message)}`))
      }
    })
    req.on('error', reject)
  })
}

/**
 * 在系统文件管理器里打开一个目录。
 *
 * Windows：走包内的 `open-folder.ps1`。**不能**直接 spawn `explorer.exe` ——
 * DSH 以隐藏方式启动插件的子进程，explorer 派生出来的窗口会带着 `visible=false`
 * （实测：窗口存在、COM 能枚举到，但就是看不见），后台进程直接调
 * SetForegroundWindow 也会被 Windows 拒绝。脚本里用
 * Shell.Application.Explore + AttachThreadInput/ShowWindow/SetForegroundWindow
 * 把窗口真正显出来并顶到前台。
 *
 * 其它平台：直接用系统自带的打开器，目录走 argv，不经 shell。
 * @param {import('@deepseek-ai/cordis').Context} ctx - 宿主上下文。
 * @param {string} directory - 要打开的绝对目录。
 * @returns {string} 实际用的方式（写进日志与响应）。
 */
function openInFileManager(ctx, directory) {
  if (process.platform === 'win32') {
    const script = join(HERE, 'open-folder.ps1')
    if (process.env.DSH_NET_SPEED_DRY_OPEN === '1') return 'powershell:open-folder.ps1'
    const handle = ctx.subprocess.spawn({
      argv: [
        powershellPath(),
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        script,
        directory
      ],
      cwd: directory,
      stdio: { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' },
      graceMs: 20000
    })
    void handle.done.catch(() => {})
    return 'powershell:open-folder.ps1'
  }

  const command = process.platform === 'darwin' ? '/usr/bin/open' : '/usr/bin/xdg-open'
  if (process.env.DSH_NET_SPEED_DRY_OPEN === '1') return command
  const handle = ctx.subprocess.spawn({
    argv: [command, directory],
    cwd: directory,
    stdio: { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' },
    graceMs: 3000
  })
  void handle.done.catch(() => {})
  return command
}

/**
 * 把一个工作区路径编码成 DSH 的会话分桶目录名。
 *
 * 观察到的规则：`D:\work\my-project` → `--D-work-my-project--`（`:` 与 `\` `/` 都变 `-`，
 * 原有的 `-` 保留，两端各包 `--`）。用于把会话目录反查回工作区。
 * @param {string} path - 工作区绝对路径。
 * @returns {string} 分桶目录名。
 */
function encodeWorkspaceBucket(path) {
  return `--${path.replace(/[:\\/]/g, '-')}--`
}

/**
 * 读一个会话目录里最新的文件写入时间。
 * @param {string} directory - 会话目录。
 * @returns {Promise<number>} 最新 mtime（毫秒），读不到时 0。
 */
async function newestWriteIn(directory) {
  let newest = 0
  let entries = []
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch {
    return 0
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue
    try {
      const info = await stat(join(directory, entry.name))
      if (info.mtimeMs > newest) newest = info.mtimeMs
    } catch {
      /* 单个文件读不到不影响整体判断 */
    }
  }
  return newest
}

/**
 * 两个路径是否指同一个目录（Windows 大小写不敏感、容忍尾部分隔符）。
 * @param {unknown} a - 路径一。
 * @param {unknown} b - 路径二。
 * @returns {boolean} 相同则 true。
 */
function samePath(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  const norm = (value) => value.replace(/[\\/]+$/, '').replace(/\//g, '\\').toLowerCase()
  return norm(a) === norm(b)
}

/**
 * 在一份 JSON 里找第一个非空 `cwd` 字符串。
 * 投影缓存的结构随内核版本会变，所以不写死层级，只限深度。
 * @param {unknown} value - 任意 JSON 值。
 * @param {number} [depth] - 递归深度上限。
 * @returns {string} 命中的 cwd，或空串。
 */
function findCwdDeep(value, depth = 0) {
  if (depth > 5 || value === null || typeof value !== 'object') return ''
  if (Array.isArray(value)) {
    for (const item of value) {
      const hit = findCwdDeep(item, depth + 1)
      if (hit !== '') return hit
    }
    return ''
  }
  const record = value
  if (typeof record.cwd === 'string' && record.cwd !== '') return record.cwd
  for (const item of Object.values(record)) {
    const hit = findCwdDeep(item, depth + 1)
    if (hit !== '') return hit
  }
  return ''
}

/**
 * 线索 1：会话日志分桶 —— 当前会话一直在写，最新 mtime 的桶就是它。
 * @param {object[]} workspaces - 已注册工作区。
 * @returns {Promise<{path:string,title:string,source:'recent'}|null>} 命中结果。
 */
async function recentFromSessionBuckets(workspaces) {
  const root = join(dshHome(), 'sessions')
  let buckets = []
  try {
    buckets = await readdir(root, { withFileTypes: true })
  } catch {
    return null
  }
  let best = null
  for (const bucket of buckets) {
    if (!bucket.isDirectory()) continue
    const bucketDir = join(root, bucket.name)
    let sessions = []
    try {
      sessions = await readdir(bucketDir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const session of sessions) {
      if (!session.isDirectory()) continue
      const mtime = await newestWriteIn(join(bucketDir, session.name))
      if (mtime > 0 && (best === null || mtime > best.mtime)) {
        best = { bucket: bucket.name, mtime }
      }
    }
  }
  if (best === null) return null
  const hit = workspaces.find((workspace) => {
    const path = workspace === null || workspace === undefined ? undefined : workspace.path
    return typeof path === 'string' && encodeWorkspaceBucket(path) === best.bucket
  })
  if (hit === undefined || hit === null || typeof hit.path !== 'string') return null
  return { path: hit.path, title: String(hit.title ?? ''), source: 'recent' }
}

/**
 * 线索 2：会话投影缓存 —— 最新那个文件里带着明确的 cwd。
 * @param {object[]} workspaces - 已注册工作区。
 * @returns {Promise<{path:string,title:string,source:'recent'}|null>} 命中结果。
 */
async function recentFromProjectionCache(workspaces) {
  const dir = join(dshHome(), 'storages', 'session_projcache', 'sessions')
  let entries = []
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return null
  }
  let best = null
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue
    const file = join(dir, entry.name)
    try {
      const info = await stat(file)
      if (best === null || info.mtimeMs > best.mtime) best = { file, mtime: info.mtimeMs }
    } catch {
      /* 单个文件读不到不影响整体判断 */
    }
  }
  if (best === null) return null
  let cwd = ''
  try {
    cwd = findCwdDeep(JSON.parse(await readFile(best.file, 'utf8')))
  } catch {
    return null
  }
  if (cwd === '') return null
  const hit = workspaces.find((workspace) => {
    const path = workspace === null || workspace === undefined ? undefined : workspace.path
    return samePath(path, cwd)
  })
  if (hit !== undefined && hit !== null && typeof hit.path === 'string') {
    return { path: hit.path, title: String(hit.title ?? ''), source: 'recent' }
  }
  // 缓存里的目录不在注册表里也认（他可能刚加进来还没入库）
  if (existsSync(cwd)) return { path: cwd, title: '', source: 'recent' }
  return null
}

/**
 * 找"用户当前正在用"的工作区（客户端拿不到 sessionId 时的救命绳）。
 *
 * 三条线索依次尝试，任一命中即返回：
 *   1. 会话日志分桶（当前会话一直在写，最新的桶就是它）；
 *   2. 会话投影缓存（文件里带明确的 cwd）；
 *   3. 注册表里 updatedAt 最新的工作区。
 * 全落空时返回 null，调用方退到"注册表里第一个工作区"。
 * @param {import('@deepseek-ai/cordis').Context} ctx - 宿主上下文。
 * @param {object[]} workspaces - 已注册工作区。
 * @returns {Promise<{path:string,title:string,source:'recent'}|null>} 命中结果。
 */
async function findRecentlyActiveWorkspace(ctx, workspaces) {
  const fromBuckets = await recentFromSessionBuckets(workspaces)
  if (fromBuckets !== null) return fromBuckets

  const fromCache = await recentFromProjectionCache(workspaces)
  if (fromCache !== null) return fromCache

  let newest = null
  for (const workspace of workspaces) {
    if (workspace === null || workspace === undefined) continue
    const stamp = typeof workspace.updatedAt === 'string' ? workspace.updatedAt : ''
    if (stamp === '') continue
    if (newest === null || stamp > newest.stamp) newest = { workspace, stamp }
  }
  if (newest !== null && typeof newest.workspace.path === 'string') {
    return { path: newest.workspace.path, title: String(newest.workspace.title ?? ''), source: 'recent' }
  }
  return null
}

/**
 * 定出要打开的工作区目录（三步兜底，见模块头）。
 * @param {import('@deepseek-ai/cordis').Context} ctx - 宿主上下文。
 * @param {string} sessionId - 客户端报的当前会话 id（可为空）。
 * @returns {Promise<{path:string,title:string,source:'session'|'recent'|'first'}|null>} 结果。
 */
async function resolveWorkspaceDirectory(ctx, sessionId) {
  const registry = ctx.get('workspaceRegistry')
  if (registry === undefined || typeof registry.list !== 'function') return null
  let workspaces = []
  try {
    workspaces = registry.list()
  } catch {
    return null
  }
  if (!Array.isArray(workspaces) || workspaces.length === 0) return null

  if (sessionId !== '') {
    const hit = workspaces.find((workspace) => {
      const ids = workspace === null || workspace === undefined ? undefined : workspace.sessionIds
      return Array.isArray(ids) ? ids.includes(sessionId) : false
    })
    if (hit !== undefined && hit !== null && typeof hit.path === 'string') {
      return { path: hit.path, title: String(hit.title ?? ''), source: 'session' }
    }
  }

  const recent = await findRecentlyActiveWorkspace(ctx, workspaces)
  if (recent !== null) return recent

  const first = workspaces[0]
  if (first === undefined || first === null || typeof first.path !== 'string') return null
  return { path: first.path, title: String(first.title ?? ''), source: 'first' }
}

/**
 * 插件入口：挂上「打开工作区目录」这一条路由。
 * @param {import('@deepseek-ai/cordis').Context} ctx - 宿主上下文。
 * @returns {void}
 */
export function apply(ctx) {
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: OPEN_PATH,
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'POST only' })
        return
      }
      try {
        const body = await readJsonBody(req)
        const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
        const target = await resolveWorkspaceDirectory(ctx, sessionId)
        if (target === null) {
          sendJson(res, 200, { ok: false, error: 'no-workspace' })
          return
        }
        if (!existsSync(target.path)) {
          sendJson(res, 200, { ok: false, error: 'workspace-missing', path: target.path })
          return
        }
        const command = openInFileManager(ctx, target.path)
        ctx.logger.info(`net-speed-open: 打开工作区目录 ${target.path}（${target.source} / ${command}）`)
        sendJson(res, 200, { ok: true, path: target.path, title: target.title, source: target.source, command })
      } catch (error) {
        sendJson(res, 500, { ok: false, error: String((error && error.message) || error) })
      }
    }
  }), 'net-speed-open: /open-workspace')
}
