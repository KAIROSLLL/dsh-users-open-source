/**
 * dsh-users-open-source — 宿主半边（Host half）。
 *
 * 干什么：在本机开一个**只绑 127.0.0.1 的回环测速口**，然后自己当客户端去压它，
 * 量出这台机器的 TCP 吞吐（下载 / 上传）。所有字节都在本进程与回环网卡之间来回，
 * **不连接任何外部服务器、不发起任何模型请求**，因此测速本身消耗 0 token。
 *
 * 为什么是回环：用户要求「只跑用户本地带宽、不能接入其他服务器」。真正测外网带宽
 * 必须有一个对端，那必然要连第三方；所以这里测得的是本机协议栈 + 回环吞吐
 * （通常几 GB/s，远高于物理网卡），它反映的是本机网络栈上限，而不是运营商带宽。
 *
 * 三个对外入口（都挂在主 webServer 上，同源，浏览器直接 fetch）：
 *   GET  /dsh-users-open-source/state   当前状态：是否在跑、瞬时速率、配置、最近结果、历史
 *   POST /dsh-users-open-source/run     开始一次测速（后台执行，立即返回）
 *   POST /dsh-users-open-source/cancel  取消正在跑的测速
 *   POST /dsh-users-open-source/config  保存配置（定时策略 / 单次时长 / 并发连接数）
 *   （「云端备份」用的 POST /dsh-users-open-source/open-workspace 在伴生包
 *     dsh-users-open-source-workspace 里，entry 由本包的 cordis.patch.yml 插入）
 *
 * 定时测速完全在宿主侧跑（浏览器关着也照跑），配置与历史落在
 * `$DSH_HOME/dsh-users-open-source/{config,history}.json`。
 *
 * @module dsh-users-open-source
 */
import { createServer, request as httpRequest } from 'node:http'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 插件名（cordis loader 行 id 与客户端模块 id 都用它）。 */
export const name = 'dsh-users-open-source'
/** 依赖宿主 webServer 服务来注册路由。 */
export const inject = ['webServer']

/** 本插件所有 HTTP 路由的公共前缀。 */
const BASE = '/dsh-users-open-source'
/** 本文件所在目录（`../assets` 放静态图）。 */
const HERE = dirname(fileURLToPath(import.meta.url))
/** 包内自带的默认图。 */
const DEFAULT_IMAGE = join(HERE, '..', 'assets', 'code-upload.jpg')
/** 允许用户上传的图片类型 → 落盘扩展名。 */
const IMAGE_TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' }
/** 用户上传图片的大小上限（解码后字节数）。 */
const IMAGE_MAX_BYTES = 3 * 1024 * 1024
/** 单块数据大小：1 MiB。太小会让 syscall 开销盖过吞吐，太大则浪费内存。 */
const CHUNK = Buffer.alloc(1 << 20, 0x61)
/** 历史记录保留条数（滚动覆盖）。 */
const HISTORY_LIMIT = 60
/** 采样瞬时速率的间隔（毫秒）。 */
const SAMPLE_MS = 250
/** 配置文件与历史文件所在的目录名（挂在 $DSH_HOME 下）。 */
const STORE_DIR = 'dsh-users-open-source'
/** 单次测速时长与并发数的安全边界。 */
const LIMITS = {
  durationMs: { min: 500, max: 15000, fallback: 3000 },
  connections: { min: 1, max: 16, fallback: 4 },
  intervalMinutes: { min: 1, max: 10080, fallback: 60 },
  sidebarImageSize: { min: 60, max: 400, fallback: 120 }
}

/** 出厂配置。 */
const DEFAULT_CONFIG = {
  /** 单次测速时长（毫秒）。 */
  durationMs: 3000,
  /** 并发连接数。 */
  connections: 4,
  /** 测速时侧栏那张图边长（像素）。 */
  sidebarImageSize: 120,
  /**
   * 定时策略：
   *   mode 'off'      不自动跑
   *   mode 'interval' 每 intervalMinutes 分钟跑一次
   *   mode 'daily'    每天 dailyTime（HH:MM）跑一次
   */
  schedule: { mode: 'off', intervalMinutes: 60, dailyTime: '03:00' }
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
 * 把一个值夹到整数区间里。
 * @param {unknown} value - 原始输入。
 * @param {{min:number,max:number,fallback:number}} range - 边界与兜底值。
 * @returns {number} 规整后的整数。
 */
function clampInt(value, range) {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10)
  if (!Number.isFinite(parsed)) return range.fallback
  return Math.min(range.max, Math.max(range.min, Math.round(parsed)))
}

/**
 * 校验并补齐一份配置（外部输入永远不可信）。
 * @param {unknown} input - 待校验的对象。
 * @param {typeof DEFAULT_CONFIG} base - 作为兜底的现有配置。
 * @returns {typeof DEFAULT_CONFIG} 完整配置。
 */
function normalizeConfig(input, base = DEFAULT_CONFIG) {
  const raw = input !== null && typeof input === 'object' ? input : {}
  const rawSchedule = raw.schedule !== null && typeof raw.schedule === 'object' ? raw.schedule : {}
  const mode = ['off', 'interval', 'daily'].includes(rawSchedule.mode) ? rawSchedule.mode : base.schedule.mode
  const time = typeof rawSchedule.dailyTime === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(rawSchedule.dailyTime)
    ? rawSchedule.dailyTime
    : base.schedule.dailyTime
  return {
    durationMs: clampInt(raw.durationMs, LIMITS.durationMs),
    connections: clampInt(raw.connections, LIMITS.connections),
    sidebarImageSize: clampInt(raw.sidebarImageSize, LIMITS.sidebarImageSize),
    schedule: {
      mode,
      intervalMinutes: clampInt(rawSchedule.intervalMinutes, LIMITS.intervalMinutes),
      dailyTime: time
    }
  }
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
function readJsonBody(req, limit = 16384) {
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
 * 建一个回环测速服务器：只监听 127.0.0.1 的随机端口。
 *
 * 路由刻意保持"哑"：不鉴权、不落盘、不读业务状态 —— 它唯一的职责是把字节搬来搬去。
 * 因为只绑回环地址，局域网里的其他机器根本连不上。
 *
 * @param {() => number} portOf - 读取当前监听端口（`/hello` 会报出去）。
 * @returns {import('node:http').Server} 尚未监听的服务器实例。
 */
function createLoopbackServer(portOf) {
  const server = createServer((req, res) => {
    res.setHeader('cache-control', 'no-store')
    // 浏览器若直连这个口（跨源），放开 CORS；测速本身不需要它，但留着无副作用。
    res.setHeader('access-control-allow-origin', '*')
    const url = new URL(typeof req.url === 'string' ? req.url : '/', 'http://127.0.0.1')
    res.on('error', () => {})

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-headers': 'content-type',
        'access-control-allow-methods': 'GET,POST,OPTIONS'
      })
      res.end()
      return
    }

    if (url.pathname === '/hello') {
      sendJson(res, 200, { ok: true, port: portOf() })
      return
    }

    // 下载：按请求方要求灌数据，灌满 durationMs 就收尾。
    if (url.pathname === '/down') {
      const ms = clampInt(url.searchParams.get('ms'), { min: 100, max: 60000, fallback: 3000 })
      res.writeHead(200, { 'content-type': 'application/octet-stream' })
      const deadline = Date.now() + ms
      const pump = () => {
        while (Date.now() < deadline) {
          if (res.destroyed || res.writableEnded) return
          if (!res.write(CHUNK)) {
            res.once('drain', pump)
            return
          }
        }
        if (!res.destroyed && !res.writableEnded) res.end()
      }
      pump()
      return
    }

    // 上传：把请求体吃干抹净，回报真正收到的字节数。
    if (url.pathname === '/up') {
      let bytes = 0
      req.on('data', (chunk) => {
        bytes += chunk.length
      })
      req.on('end', () => {
        sendJson(res, 200, { ok: true, bytes })
      })
      req.on('error', () => {})
      return
    }

    sendJson(res, 404, { ok: false, error: 'not found' })
  })
  server.on('error', () => {})
  return server
}

/**
 * 起一个共享计数器：worker 往里加字节，采样器读它算瞬时速率。
 * @returns {{bytes:number}} 计数器对象。
 */
function makeCounter() {
  return { bytes: 0 }
}

/**
 * 按固定间隔把计数器增量换算成瞬时字节/秒，写进 progress。
 * @param {{instantBps:number,bytes:number,elapsedMs:number,startedAt:number,samples:number[]}} progress - 进度对象。
 * @param {{bytes:number}} counter - 共享计数器。
 * @returns {() => void} 停止采样的函数。
 */
function startSampler(progress, counter) {
  let lastBytes = 0
  let lastAt = Date.now()
  const timer = setInterval(() => {
    const now = Date.now()
    const dt = (now - lastAt) / 1000
    const bytes = counter.bytes
    const instant = dt > 0 ? (bytes - lastBytes) / dt : 0
    lastBytes = bytes
    lastAt = now
    progress.instantBps = instant
    progress.bytes = bytes
    progress.elapsedMs = now - progress.startedAt
    progress.samples.push(Math.round(instant))
    if (progress.samples.length > 40) progress.samples.shift()
  }, SAMPLE_MS)
  if (typeof timer.unref === 'function') timer.unref()
  return () => clearInterval(timer)
}

/**
 * 下载测速：并发若干条 GET /down，跑满 durationMs。
 * @param {number} port - 回环测速口。
 * @param {object} options - 参数。
 * @param {number} options.durationMs - 目标时长。
 * @param {number} options.connections - 并发连接数。
 * @param {{bytes:number}} options.counter - 共享字节计数器。
 * @param {() => boolean} options.cancelled - 是否已被要求取消。
 * @returns {Promise<number>} 实际耗时（毫秒）。
 */
function measureDownload(port, { durationMs, connections, counter, cancelled }) {
  const startedAt = Date.now()
  const deadline = startedAt + durationMs
  const workers = []
  for (let index = 0; index < connections; index += 1) {
    workers.push(new Promise((resolve) => {
      let settled = false
      const finish = () => {
        if (settled) return
        settled = true
        resolve()
      }
      const req = httpRequest({
        host: '127.0.0.1',
        port,
        path: `/down?ms=${durationMs + 5000}`,
        method: 'GET',
        agent: false
      }, (res) => {
        res.on('data', (chunk) => {
          counter.bytes += chunk.length
          if (Date.now() >= deadline || cancelled()) req.destroy()
        })
        res.on('end', finish)
        res.on('close', finish)
        res.on('error', finish)
      })
      req.on('error', finish)
      req.end()
    }))
  }
  return Promise.all(workers).then(() => Date.now() - startedAt)
}

/**
 * 上传测速：并发若干条 POST /up，往回环口灌数据直到 durationMs。
 * @param {number} port - 回环测速口。
 * @param {object} options - 参数。
 * @param {number} options.durationMs - 目标时长。
 * @param {number} options.connections - 并发连接数。
 * @param {{bytes:number}} options.counter - 共享字节计数器。
 * @param {() => boolean} options.cancelled - 是否已被要求取消。
 * @returns {Promise<number>} 实际耗时（毫秒）。
 */
function measureUpload(port, { durationMs, connections, counter, cancelled }) {
  const startedAt = Date.now()
  const deadline = startedAt + durationMs
  const workers = []
  for (let index = 0; index < connections; index += 1) {
    workers.push(new Promise((resolve) => {
      let settled = false
      const finish = () => {
        if (settled) return
        settled = true
        resolve()
      }
      const req = httpRequest({
        host: '127.0.0.1',
        port,
        path: '/up',
        method: 'POST',
        agent: false,
        headers: {
          'content-type': 'application/octet-stream',
          'transfer-encoding': 'chunked'
        }
      }, (res) => {
        res.resume()
        res.on('end', finish)
        res.on('close', finish)
        res.on('error', finish)
      })
      req.on('error', finish)
      // 兜底：无论回环口出什么幺蛾子，也不让这一次测速挂死。
      const guard = setTimeout(finish, durationMs + 8000)
      if (typeof guard.unref === 'function') guard.unref()
      const pump = () => {
        while (Date.now() < deadline && !cancelled()) {
          counter.bytes += CHUNK.length
          if (!req.write(CHUNK)) {
            req.once('drain', pump)
            return
          }
        }
        req.end()
      }
      pump()
    }))
  }
  return Promise.all(workers).then(() => Date.now() - startedAt)
}

/**
 * 读一次 JSON 文件，读不到或坏掉时给兜底值。
 * @param {string} path - 文件路径。
 * @param {unknown} fallback - 兜底值。
 * @returns {Promise<any>} 解析结果或兜底值。
 */
async function readJsonFile(path, fallback) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return fallback
  }
}

/**
 * 建一个插件运行时状态。
 * @returns {object} 状态对象。
 */
function createState() {
  return {
    /** 回环测速服务器。 */
    server: null,
    /** 回环测速端口（0 表示还没起来）。 */
    port: 0,
    /** 配置就绪的 Promise。 */
    ready: null,
    /** 生效中的配置。 */
    config: normalizeConfig({}),
    /** 最近一次结果。 */
    last: null,
    /** 历史结果（新→旧）。 */
    history: [],
    /** 是否正在测速。 */
    running: false,
    /** 当前进度（未测速时为 null）。 */
    progress: null,
    /** 取消标志。 */
    cancel: false,
    /** 定时器句柄。 */
    timer: null
  }
}

/**
 * 把当前历史落盘（历史只是锦上添花，写不进去也不影响使用）。
 * @param {object} state - 插件状态。
 * @returns {Promise<void>} 落盘完成。
 */
async function persistHistory(state) {
  try {
    const dir = join(dshHome(), STORE_DIR)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'history.json'), JSON.stringify(state.history, null, 2), 'utf8')
  } catch {
    /* 写不进去就算了 */
  }
}

/**
 * 记一条结果：更新 last / history，并落盘。
 * @param {object} state - 插件状态。
 * @param {object} record - 结果记录。
 * @returns {Promise<void>} 落盘完成。
 */
async function recordResult(state, record) {
  state.last = record
  state.history = [record, ...state.history].slice(0, HISTORY_LIMIT)
  await persistHistory(state)
}

/**
 * 保存配置并落盘。
 * @param {object} state - 插件状态。
 * @param {unknown} patch - 新的配置片段。
 * @returns {Promise<object>} 生效后的配置。
 */
async function saveConfig(state, patch) {
  state.config = normalizeConfig(patch, state.config)
  try {
    const dir = join(dshHome(), STORE_DIR)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'config.json'), JSON.stringify(state.config, null, 2), 'utf8')
  } catch {
    /* 同上：配置写不进去不影响本次生效 */
  }
  return state.config
}

/**
 * 跑一次完整测速：先下载后上传，全程更新 progress，结束后记账。
 * @param {object} state - 插件状态。
 * @param {'manual'|'schedule'} source - 触发来源。
 * @returns {Promise<object>} 结果记录（失败或取消时带 error/cancelled）。
 */
async function runTest(state, source) {
  if (state.running) return { ok: false, error: 'busy' }
  if (!state.port) return { ok: false, error: 'loopback server not ready' }
  const { durationMs, connections } = state.config
  state.running = true
  state.cancel = false
  const startedAt = Date.now()
  /** @type {any} */
  const progress = {
    phase: 'down',
    phaseIndex: 1,
    phaseCount: 2,
    bytes: 0,
    instantBps: 0,
    elapsedMs: 0,
    startedAt,
    durationMs,
    connections,
    samples: []
  }
  state.progress = progress
  const cancelled = () => state.cancel
  try {
    const downCounter = makeCounter()
    progress.phase = 'down'
    progress.startedAt = Date.now()
    progress.bytes = 0
    progress.samples = []
    let stop = startSampler(progress, downCounter)
    const downMs = await measureDownload(state.port, { durationMs, connections, counter: downCounter, cancelled })
    stop()

    const upCounter = makeCounter()
    progress.phase = 'up'
    progress.phaseIndex = 2
    progress.startedAt = Date.now()
    progress.bytes = 0
    progress.samples = []
    stop = startSampler(progress, upCounter)
    const upMs = await measureUpload(state.port, { durationMs, connections, counter: upCounter, cancelled })
    stop()

    const record = {
      at: new Date().toISOString(),
      source,
      cancelled: state.cancel,
      durationMs,
      connections,
      download: {
        bytes: downCounter.bytes,
        ms: downMs,
        bps: downMs > 0 ? (downCounter.bytes * 1000) / downMs : 0
      },
      upload: {
        bytes: upCounter.bytes,
        ms: upMs,
        bps: upMs > 0 ? (upCounter.bytes * 1000) / upMs : 0
      },
      totalMs: Date.now() - startedAt
    }
    await recordResult(state, record)
    return { ok: true, result: record }
  } catch (error) {
    return { ok: false, error: String((error && error.message) || error) }
  } finally {
    state.running = false
    state.progress = null
    state.cancel = false
  }
}

/**
 * 安排下一次定时测速（每次跑完都重排，天天跟着系统时间走）。
 * @param {object} state - 插件状态。
 * @returns {void}
 */
function scheduleNext(state) {
  if (state.timer !== null) {
    clearTimeout(state.timer)
    state.timer = null
  }
  const schedule = state.config.schedule
  if (schedule.mode === 'off') return
  let delay
  if (schedule.mode === 'interval') {
    delay = schedule.intervalMinutes * 60000
  } else {
    const [hours, minutes] = schedule.dailyTime.split(':').map((part) => Number.parseInt(part, 10))
    const now = new Date()
    const next = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hours, minutes, 0, 0)
    if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1)
    delay = next.getTime() - now.getTime()
  }
  state.timer = setTimeout(() => {
    state.timer = null
    void runTest(state, 'schedule').finally(() => { scheduleNext(state) })
  }, delay)
  if (typeof state.timer.unref === 'function') state.timer.unref()
}

/**
 * 把状态整理成浏览器能直接吃的快照。
 * @param {object} state - 插件状态。
 * @returns {object} 快照。
 */
function snapshot(state) {
  const progress = state.running && state.progress !== null
    ? {
        phase: state.progress.phase,
        phaseIndex: state.progress.phaseIndex,
        phaseCount: state.progress.phaseCount,
        bytes: state.progress.bytes,
        instantBps: state.progress.instantBps,
        elapsedMs: state.progress.elapsedMs,
        durationMs: state.progress.durationMs,
        samples: state.progress.samples
      }
    : null
  return {
    ok: true,
    plugin: name,
    running: state.running,
    progress,
    config: state.config,
    last: state.last,
    history: state.history.slice(0, 20),
    loopbackPort: state.port,
    customImage: findCustomImage() !== null,
    limits: LIMITS
  }
}

/**
 * 找用户自己上传的那张图（按扩展名依次找）。
 * @returns {{path:string,mime:string}|null} 命中结果，没上传过时 null。
 */
function findCustomImage() {
  for (const [mime, ext] of Object.entries(IMAGE_TYPES)) {
    const file = join(dshHome(), STORE_DIR, `sidebar-image.${ext}`)
    if (existsSync(file)) return { path: file, mime }
  }
  return null
}

/**
 * 删掉所有自定义图（恢复默认）。
 * @returns {Promise<void>} 完成。
 */
async function clearCustomImages() {
  for (const ext of Object.values(IMAGE_TYPES)) {
    try {
      await rm(join(dshHome(), STORE_DIR, `sidebar-image.${ext}`), { force: true })
    } catch {
      /* 删不掉就算了 */
    }
  }
}

/**
 * 插件入口：起回环测速口、读配置、排定时、挂路由。
 * @param {import('@deepseek-ai/cordis').Context} ctx - 宿主上下文。
 * @returns {void}
 */
export function apply(ctx) {
  const state = createState()

  // 路由先挂上（同步），状态随后异步就绪；处理器统一 await state.ready。
  state.ready = (async () => {
    const dir = join(dshHome(), STORE_DIR)
    const storedConfig = await readJsonFile(join(dir, 'config.json'), null)
    if (storedConfig !== null) state.config = normalizeConfig(storedConfig, state.config)
    const storedHistory = await readJsonFile(join(dir, 'history.json'), [])
    if (Array.isArray(storedHistory)) {
      state.history = storedHistory.slice(0, HISTORY_LIMIT)
      state.last = state.history[0] ?? null
    }

    const server = createLoopbackServer(() => state.port)
    state.server = server
    await new Promise((resolve) => {
      server.once('error', (error) => {
        ctx.logger.warn(`net-speed: 回环测速口起不来: ${String((error && error.message) || error)}`)
        resolve()
      })
      server.listen(0, '127.0.0.1', () => {
        const address = server.address()
        if (address !== null && typeof address === 'object') state.port = address.port
        ctx.logger.info(`net-speed: 回环测速口就绪 127.0.0.1:${state.port}（只在本机内跑，不连外部服务器）`)
        resolve()
      })
    })
    scheduleNext(state)
  })()

  ctx.effect(() => () => {
    if (state.timer !== null) clearTimeout(state.timer)
    state.timer = null
    state.cancel = true
    const server = state.server
    if (server !== null) server.close()
  }, 'net-speed: 关掉回环测速口与定时器')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: `${BASE}/state`,
    handler: async (req, res) => {
      try {
        await state.ready
        sendJson(res, 200, snapshot(state))
      } catch (error) {
        sendJson(res, 500, { ok: false, error: String((error && error.message) || error) })
      }
    }
  }), 'net-speed: /state')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: `${BASE}/run`,
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'POST only' })
        return
      }
      try {
        await state.ready
        if (state.running) {
          sendJson(res, 409, { ok: false, error: 'busy' })
          return
        }
        // 后台跑：浏览器靠轮询 /state 看进度，这个请求立刻返回，避免长连接。
        void runTest(state, 'manual')
        sendJson(res, 200, { ok: true, started: true })
      } catch (error) {
        sendJson(res, 500, { ok: false, error: String((error && error.message) || error) })
      }
    }
  }), 'net-speed: /run')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: `${BASE}/cancel`,
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'POST only' })
        return
      }
      state.cancel = true
      sendJson(res, 200, { ok: true })
    }
  }), 'net-speed: /cancel')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: `${BASE}/config`,
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'POST only' })
        return
      }
      try {
        await state.ready
        const body = await readJsonBody(req)
        const config = await saveConfig(state, body.config ?? body)
        scheduleNext(state)
        sendJson(res, 200, { ok: true, config })
      } catch (error) {
        sendJson(res, 500, { ok: false, error: String((error && error.message) || error) })
      }
    }
  }), 'net-speed: /config')

  // 删记录：`{ action: 'clear' }` 清空，`{ action: 'delete', at }` 删单条。
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: `${BASE}/history`,
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'POST only' })
        return
      }
      try {
        await state.ready
        const body = await readJsonBody(req)
        const action = typeof body.action === 'string' ? body.action : ''
        if (action === 'clear') {
          state.history = []
          state.last = null
        } else if (action === 'delete') {
          const at = typeof body.at === 'string' ? body.at : ''
          if (at === '') {
            sendJson(res, 400, { ok: false, error: 'missing at' })
            return
          }
          state.history = state.history.filter((item) => item === null || item === undefined || item.at !== at)
          state.last = state.history.length > 0 ? state.history[0] : null
        } else {
          sendJson(res, 400, { ok: false, error: `unknown action: ${JSON.stringify(action)}` })
          return
        }
        await persistHistory(state)
        sendJson(res, 200, { ok: true, last: state.last, history: state.history.slice(0, 20) })
      } catch (error) {
        sendJson(res, 500, { ok: false, error: String((error && error.message) || error) })
      }
    }
  }), 'net-speed: /history')

  // 静态图：测速时客户端在侧栏和面板里弹出来的那张。
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: `${BASE}/asset/code-upload.jpg`,
    handler: async (req, res) => {
      try {
        const bytes = await readFile(join(HERE, '..', 'assets', 'code-upload.jpg'))
        res.writeHead(200, {
          'content-type': 'image/jpeg',
          'cache-control': 'public, max-age=86400',
          'content-length': String(bytes.length)
        })
        res.end(bytes)
      } catch (error) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
        res.end(`asset unavailable: ${String((error && error.message) || error)}`)
      }
    }
  }), 'net-speed: 图片资源')

  // 当前该显示的那张图：GET 取图（用户上传的优先，否则包内默认图），POST 换图（base64）。
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: `${BASE}/asset/image`,
    handler: async (req, res) => {
      if (req.method === 'POST') {
        try {
          const body = await readJsonBody(req, 8 * 1024 * 1024)
          const type = typeof body.type === 'string' ? body.type : ''
          const ext = IMAGE_TYPES[type]
          if (ext === undefined) {
            sendJson(res, 400, { ok: false, error: 'unsupported image type' })
            return
          }
          const data = typeof body.data === 'string' ? body.data : ''
          if (data === '') {
            sendJson(res, 400, { ok: false, error: 'missing data' })
            return
          }
          const bytes = Buffer.from(data, 'base64')
          if (bytes.length === 0) {
            sendJson(res, 400, { ok: false, error: 'bad base64' })
            return
          }
          if (bytes.length > IMAGE_MAX_BYTES) {
            sendJson(res, 413, { ok: false, error: 'image too large' })
            return
          }
          const dir = join(dshHome(), STORE_DIR)
          await mkdir(dir, { recursive: true })
          await clearCustomImages()
          await writeFile(join(dir, `sidebar-image.${ext}`), bytes)
          ctx.logger.info(`net-speed: 已保存用户上传的图片（${bytes.length} 字节 ${type}）`)
          sendJson(res, 200, { ok: true, bytes: bytes.length, type })
        } catch (error) {
          sendJson(res, 500, { ok: false, error: String((error && error.message) || error) })
        }
        return
      }
      try {
        const custom = findCustomImage()
        const file = custom !== null ? custom.path : DEFAULT_IMAGE
        const mime = custom !== null ? custom.mime : 'image/jpeg'
        const bytes = await readFile(file)
        res.writeHead(200, {
          'content-type': mime,
          // 换过图必须立刻生效，所以这里不缓存。
          'cache-control': 'no-store',
          'content-length': String(bytes.length)
        })
        res.end(bytes)
      } catch (error) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
        res.end(`asset unavailable: ${String((error && error.message) || error)}`)
      }
    }
  }), 'net-speed: /asset/image')

  // 恢复默认图。
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: `${BASE}/asset/image/reset`,
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'POST only' })
        return
      }
      try {
        await clearCustomImages()
        sendJson(res, 200, { ok: true })
      } catch (error) {
        sendJson(res, 500, { ok: false, error: String((error && error.message) || error) })
      }
    }
  }), 'net-speed: /asset/image/reset')
}
