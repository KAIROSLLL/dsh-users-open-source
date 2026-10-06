/**
 * dsh-users-open-source-workspace 冒烟测试：不需要 DSH 运行时，node 直接跑。
 *
 * 覆盖：路由注册、sessionId 命中工作区、以及三条"当前工作区"兜底线索
 * （会话日志分桶 → 投影缓存 cwd → updatedAt 最新）与各种失败分支。
 *
 * 用法：node tests/smoke.mjs
 */
import { strict as assert } from 'node:assert'
import { createServer } from 'node:http'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** 测试期间把 DSH home 指到临时目录，别污染真身。 */
process.env.DSH_HOME = join(tmpdir(), 'dsh-users-open-source-ws-smoke')
/** 只解析、不真的弹资源管理器。 */
process.env.DSH_NET_SPEED_DRY_OPEN = '1'

const mod = await import(new URL('../lib/index.js', import.meta.url).href)

/** 收集失败，最后统一决定退出码。 */
const failures = []

/**
 * 跑一个测试用例，失败不中断。
 * @param {string} title - 用例名。
 * @param {() => Promise<void>|void} body - 用例体。
 * @returns {Promise<void>} 结束。
 */
async function test(title, body) {
  try {
    await body()
    console.log(`  ✓ ${title}`)
  } catch (error) {
    failures.push(`${title}: ${String((error && error.stack) || error)}`)
    console.log(`  ✗ ${title}`)
  }
}

/** 路由表：path → handler。 */
const routes = new Map()
/** effect 清理函数。 */
const disposers = []
const logs = []
/** 假的宿主服务表。 */
const services = {}

const ctx = {
  get: (name) => services[name],
  logger: {
    info: (message) => logs.push(`[info] ${message}`),
    warn: (message) => logs.push(`[warn] ${message}`)
  },
  effect: (factory) => {
    const dispose = factory()
    if (typeof dispose === 'function') disposers.push(dispose)
    return () => {}
  },
  webServer: {
    register: (route) => {
      routes.set(route.path, route.handler)
      return () => routes.delete(route.path)
    }
  },
  subprocess: {
    spawn: () => ({ done: Promise.resolve({ exitCode: 0, signal: null }) })
  }
}

const home = process.env.DSH_HOME

await test('模块导出 name / inject / apply', () => {
  assert.equal(mod.name, 'dsh-users-open-source-workspace')
  assert.deepEqual(Array.from(mod.inject), ['webServer', 'subprocess'])
  assert.equal(typeof mod.apply, 'function')
})

await test('apply() 挂上 /dsh-users-open-source/open-workspace', () => {
  mod.apply(ctx)
  assert.deepEqual(Array.from(routes.keys()), ['/dsh-users-open-source/open-workspace'])
})

/** 把路由挂到一个真 HTTP 口上，方便用 fetch 打。 */
const bridge = createServer((req, res) => {
  const url = new URL(typeof req.url === 'string' ? req.url : '/', 'http://127.0.0.1')
  const handler = routes.get(url.pathname)
  if (handler === undefined) {
    res.writeHead(404, { 'content-type': 'text/plain' })
    res.end('no route')
    return
  }
  Promise.resolve(handler(req, res)).catch(() => {
    try {
      res.destroy()
    } catch {
      /* 忽略 */
    }
  })
})
await new Promise((resolve) => bridge.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${bridge.address().port}`

/**
 * 打一个接口。
 * @param {string} path - 路径。
 * @param {object} [init] - fetch 选项。
 * @returns {Promise<{status:number, body:any}>} 状态码与 JSON。
 */
async function call(path, init) {
  const res = await fetch(base + path, init)
  let body = null
  try {
    body = await res.json()
  } catch {
    body = null
  }
  return { status: res.status, body }
}

/**
 * 发一个 JSON POST。
 * @param {string} path - 路径。
 * @param {object} payload - 请求体。
 * @returns {Promise<{status:number, body:any}>} 结果。
 */
function open(payload) {
  return call('/dsh-users-open-source/open-workspace', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload ?? {})
  })
}

/** 一个"真实存在"的工作区目录。 */
const wsDir = join(tmpdir(), 'dsh-ns-ws-a')
/** 另一个"真实存在"的工作区目录。 */
const otherDir = join(tmpdir(), 'dsh-ns-ws-b')

await test('sessionId 命中工作区（最准的一条）', async () => {
  await mkdir(wsDir, { recursive: true })
  await mkdir(otherDir, { recursive: true })
  services.workspaceRegistry = {
    list: () => [
      { id: 'w-a', path: wsDir, title: 'A', sessionIds: ['session-a'], updatedAt: '2026-01-01T00:00:00.000Z' },
      { id: 'w-b', path: otherDir, title: 'B', sessionIds: ['session-b'], updatedAt: '2026-01-02T00:00:00.000Z' }
    ]
  }
  const result = await open({ sessionId: 'session-a' })
  assert.equal(result.status, 200)
  assert.equal(result.body.ok, true, JSON.stringify(result.body))
  assert.equal(result.body.path, wsDir)
  assert.equal(result.body.source, 'session')
})

await test('线索 1：会话日志分桶（客户端没给 id 时）', async () => {
  const bucket = `--${wsDir.replace(/[:\\/]/g, '-')}--`
  const sessionDir = join(home, 'sessions', bucket, 'session-recent')
  await mkdir(sessionDir, { recursive: true })
  await writeFile(join(sessionDir, 'session.v4.jsonl.zstd'), 'x')
  const result = await open({ sessionId: 'session-unknown' })
  assert.equal(result.body.ok, true, JSON.stringify(result.body))
  assert.equal(result.body.path, wsDir)
  assert.equal(result.body.source, 'recent')
  await rm(join(home, 'sessions'), { recursive: true, force: true })
})

await test('线索 2：会话投影缓存里的 cwd', async () => {
  const cacheDir = join(home, 'storages', 'session_projcache', 'sessions')
  await mkdir(cacheDir, { recursive: true })
  await writeFile(
    join(cacheDir, 'session-x.json'),
    JSON.stringify({ record: { header: { cwd: otherDir }, rows: {} } })
  )
  const result = await open({ sessionId: 'session-unknown' })
  assert.equal(result.body.ok, true, JSON.stringify(result.body))
  assert.equal(result.body.path, otherDir)
  assert.equal(result.body.source, 'recent')
  await rm(join(home, 'storages'), { recursive: true, force: true })
})

await test('线索 3：updatedAt 最新的工作区', async () => {
  const result = await open({ sessionId: 'session-unknown' })
  assert.equal(result.body.ok, true, JSON.stringify(result.body))
  assert.equal(result.body.path, otherDir, 'updatedAt 更新的是 B')
  assert.equal(result.body.source, 'recent')
})

await test('三条线索都落空时退到第一个工作区', async () => {
  services.workspaceRegistry = {
    list: () => [
      { id: 'w-a', path: wsDir, title: 'A', sessionIds: [] },
      { id: 'w-b', path: otherDir, title: 'B', sessionIds: [] }
    ]
  }
  const result = await open({})
  assert.equal(result.body.path, wsDir)
  assert.equal(result.body.source, 'first')
})

await test('工作区目录不在了 → workspace-missing', async () => {
  services.workspaceRegistry = {
    list: () => [{ id: 'w-x', path: join(tmpdir(), 'dsh-ns-definitely-missing'), title: 'X', sessionIds: [] }]
  }
  const result = await open({})
  assert.equal(result.body.ok, false)
  assert.equal(result.body.error, 'workspace-missing')
})

await test('一个工作区都没有 → no-workspace；GET → 405', async () => {
  services.workspaceRegistry = { list: () => [] }
  const none = await open({})
  assert.equal(none.body.ok, false)
  assert.equal(none.body.error, 'no-workspace')

  const wrongMethod = await call('/dsh-users-open-source/open-workspace')
  assert.equal(wrongMethod.status, 405)
})

// 收尾
for (const dispose of disposers) {
  try {
    dispose()
  } catch {
    /* 忽略 */
  }
}
bridge.close()
await rm(home, { recursive: true, force: true })

console.log('')
if (failures.length > 0) {
  console.error(`✗ ${failures.length} 个用例失败：`)
  for (const failure of failures) console.error(`\n--- ${failure}`)
  process.exit(1)
}
console.log(`✓ 全部用例通过（宿主日志 ${logs.length} 条）`)
for (const line of logs) console.log(`    ${line}`)
