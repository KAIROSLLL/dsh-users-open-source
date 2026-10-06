/**
 * dsh-users-open-source 冒烟测试：不需要 DSH 运行时，node 直接跑。
 *
 *   1. 宿主半边：apply() 起来 → 真起一次测速（回环流量）→ 校验速率与配置落盘；
 *   2. 客户端半边：用最小 React/DOM 桩加载 lib/client.js → 校验三个席位注册 →
 *      把各个组件在「空数据 / 测速中 / 有历史」三种快照下浅渲染一遍，确保不抛错。
 *
 * 用法：node tests/smoke.mjs
 */
import { strict as assert } from 'node:assert'
import { createServer } from 'node:http'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

/** 测试期间把 DSH home 指到临时目录，别污染真身。 */
process.env.DSH_HOME = join(tmpdir(), 'dsh-users-open-source-smoke')

const CLIENT_PATH = new URL('../lib/client.js', import.meta.url)
/** 收集失败，最后统一决定退出码。 */
const failures = []

/**
 * 跑一个测试用例，失败不中断（好把问题一次看全）。
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

// ═══════════════════════════════════════════════════════════════════════
// 1. 宿主半边
// ═══════════════════════════════════════════════════════════════════════
console.log('宿主半边：')

const host = await import(new URL('../lib/host.js', import.meta.url).href)
/** 路由表：path → handler。 */
const routes = new Map()
/** effect 清理函数。 */
const disposers = []
const logs = []
/** 假的宿主服务表（按需往里塞服务）。 */
const services = {}

await test('模块导出 name / inject / apply', () => {
  assert.equal(host.name, 'dsh-users-open-source')
  assert.deepEqual(Array.from(host.inject), ['webServer'])
  assert.equal(typeof host.apply, 'function')
})

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
  }
}

await test('apply() 挂上 8 条路由', () => {
  host.apply(ctx)
  assert.deepEqual(
    Array.from(routes.keys()).sort(),
    [
      '/dsh-users-open-source/asset/code-upload.jpg',
      '/dsh-users-open-source/asset/image',
      '/dsh-users-open-source/asset/image/reset',
      '/dsh-users-open-source/cancel',
      '/dsh-users-open-source/config',
      '/dsh-users-open-source/history',
      '/dsh-users-open-source/run',
      '/dsh-users-open-source/state'
    ]
  )
})

// 「云端备份」（打开工作区目录）那一半已拆成独立包 dsh-users-open-source-workspace，
// 它的路由与三条兜底线索在那边自己的 tests/smoke.mjs 里测。

/** 把插件路由挂到一个真 HTTP 口上，方便用 fetch 打。 */
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
const bridgePort = bridge.address().port
const base = `http://127.0.0.1:${bridgePort}`

/**
 * 打一个插件接口。
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
function postJson(path, payload) {
  return call(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload)
  })
}

/**
 * 等一小会儿。
 * @param {number} ms - 毫秒。
 * @returns {Promise<void>} 结束。
 */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

let readySnapshot = null
await test('回环测速口在 5 秒内就绪', async () => {
  for (let index = 0; index < 50; index += 1) {
    const { body } = await call('/dsh-users-open-source/state')
    if (body !== null && body.loopbackPort > 0) {
      readySnapshot = body
      return
    }
    await sleep(100)
  }
  throw new Error('loopbackPort 一直是 0')
})

await test('配置能存能读（定时 = 每 90 分钟）', async () => {
  const { status, body } = await postJson('/dsh-users-open-source/config', {
    config: { durationMs: 800, connections: 2, schedule: { mode: 'interval', intervalMinutes: 90, dailyTime: '04:30' } }
  })
  assert.equal(status, 200)
  assert.equal(body.ok, true)
  assert.equal(body.config.durationMs, 800)
  assert.equal(body.config.connections, 2)
  assert.equal(body.config.sidebarImageSize, 120, '侧栏图片大小默认 120px')
  assert.equal(body.config.schedule.mode, 'interval')
  assert.equal(body.config.schedule.intervalMinutes, 90)
})

await test('配置的非法值被夹回边界', async () => {
  const { body } = await postJson('/dsh-users-open-source/config', {
    config: { durationMs: 999999, connections: 0, schedule: { mode: 'daily', intervalMinutes: 0, dailyTime: '99:99' } }
  })
  assert.equal(body.config.durationMs, 15000)
  assert.equal(body.config.connections, 1)
  assert.equal(body.config.schedule.dailyTime, '04:30')
})

await test('POST /run 启动测速，重复点击返回 409', async () => {
  const first = await postJson('/dsh-users-open-source/run', {})
  assert.equal(first.status, 200)
  assert.equal(first.body.started, true)
  const second = await postJson('/dsh-users-open-source/run', {})
  assert.equal(second.status, 409)
  assert.equal(second.body.error, 'busy')
})

await test('测速跑完并给出正速率', async () => {
  const deadline = Date.now() + 40000
  let snapshot = null
  while (Date.now() < deadline) {
    const { body } = await call('/dsh-users-open-source/state')
    if (body !== null && body.running === false && body.last !== null) {
      snapshot = body
      break
    }
    await sleep(200)
  }
  assert.ok(snapshot !== null, '40 秒内没跑完')
  const record = snapshot.last
  assert.ok(record.download.bps > 0, `下载速率应为正数，实际 ${record.download.bps}`)
  assert.ok(record.upload.bps > 0, `上传速率应为正数，实际 ${record.upload.bps}`)
  assert.ok(record.download.bytes > 0 && record.upload.bytes > 0)
  assert.equal(record.source, 'manual')
  assert.ok(Array.isArray(snapshot.history) && snapshot.history.length >= 1)
  console.log(`    · 本次实测：下载 ${(record.download.bps / 1e6).toFixed(0)} MB/s · 上传 ${(record.upload.bps / 1e6).toFixed(0)} MB/s（回环，不连外网）`)
})

await test('自动测速（定时）在 1 分钟间隔下会自己跑一次', async () => {
  await postJson('/dsh-users-open-source/config', {
    config: { durationMs: 500, connections: 1, schedule: { mode: 'interval', intervalMinutes: 1, dailyTime: '03:00' } }
  })
  const before = await call('/dsh-users-open-source/state')
  const countBefore = before.body.history.length
  const deadline = Date.now() + 75000
  let found = false
  while (Date.now() < deadline) {
    const { body } = await call('/dsh-users-open-source/state')
    if (body.history.length > countBefore && body.history[0].source === 'schedule') {
      found = true
      break
    }
    await sleep(1000)
  }
  assert.ok(found, '75 秒内没看到定时测速的结果')
  await postJson('/dsh-users-open-source/config', { config: { schedule: { mode: 'off' } } })
})

await test('GET /cancel 不炸；GET /config 被拒（只收 POST）', async () => {
  const cancel = await call('/dsh-users-open-source/cancel')
  assert.equal(cancel.status, 405)
  const config = await call('/dsh-users-open-source/config')
  assert.equal(config.status, 405)
  const cancelPost = await postJson('/dsh-users-open-source/cancel', {})
  assert.equal(cancelPost.status, 200)
})

await test('POST /history 能删单条、能清空，并落盘', async () => {
  const before = await call('/dsh-users-open-source/state')
  const items = before.body.history
  assert.ok(Array.isArray(items) && items.length >= 2, `前置条件：至少两条历史，实际 ${items.length}`)

  const target = items[0].at
  const deleted = await postJson('/dsh-users-open-source/history', { action: 'delete', at: target })
  assert.equal(deleted.status, 200)
  assert.equal(deleted.body.ok, true)
  assert.ok(!deleted.body.history.some((entry) => entry.at === target), '被删的那条不该还在')
  assert.equal(deleted.body.history.length, items.length - 1)
  assert.equal(deleted.body.last.at, items[1].at, 'last 应回退到剩下最新的一条')

  const missingAt = await postJson('/dsh-users-open-source/history', { action: 'delete' })
  assert.equal(missingAt.status, 400)
  const unknown = await postJson('/dsh-users-open-source/history', { action: 'nope' })
  assert.equal(unknown.status, 400)
  const wrongMethod = await call('/dsh-users-open-source/history')
  assert.equal(wrongMethod.status, 405)

  const cleared = await postJson('/dsh-users-open-source/history', { action: 'clear' })
  assert.equal(cleared.body.ok, true)
  assert.deepEqual(cleared.body.history, [])
  assert.equal(cleared.body.last, null)

  const after = await call('/dsh-users-open-source/state')
  assert.deepEqual(after.body.history, [], '清空后状态里也不该有记录')
  assert.equal(after.body.last, null)

  // 重启一次宿主（重新 apply）应能读到清空后的文件
  host.apply(ctx)
  const reloaded = await call('/dsh-users-open-source/state')
  assert.deepEqual(reloaded.body.history, [], '落盘后再读回来仍应为空')
})

await test('图片：默认图能取、能换成自己上传的、能恢复默认', async () => {
  const fallback = await fetch(`${base}/dsh-users-open-source/asset/image`)
  assert.equal(fallback.status, 200)
  assert.equal(fallback.headers.get('content-type'), 'image/jpeg')
  const fallbackBytes = (await fallback.arrayBuffer()).byteLength
  assert.ok(fallbackBytes > 1000, '默认图应该有内容')

  // 一张 1x1 的 PNG
  const pixel = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
  const uploaded = await postJson('/dsh-users-open-source/asset/image', { type: 'image/png', data: pixel })
  assert.equal(uploaded.status, 200)
  assert.equal(uploaded.body.ok, true)

  const afterUpload = await call('/dsh-users-open-source/state')
  assert.equal(afterUpload.body.customImage, true, '上传后 state 应标记为自定义图')

  const custom = await fetch(`${base}/dsh-users-open-source/asset/image`)
  assert.equal(custom.headers.get('content-type'), 'image/png')
  assert.ok((await custom.arrayBuffer()).byteLength < fallbackBytes, '现在发的应该是那张 1x1 小图')

  const badType = await postJson('/dsh-users-open-source/asset/image', { type: 'text/plain', data: pixel })
  assert.equal(badType.status, 400)
  const noData = await postJson('/dsh-users-open-source/asset/image', { type: 'image/png' })
  assert.equal(noData.status, 400)

  const wrongMethod = await call('/dsh-users-open-source/asset/image/reset')
  assert.equal(wrongMethod.status, 405)

  const reset = await postJson('/dsh-users-open-source/asset/image/reset', {})
  assert.equal(reset.body.ok, true)
  const afterReset = await call('/dsh-users-open-source/state')
  assert.equal(afterReset.body.customImage, false)
  const back = await fetch(`${base}/dsh-users-open-source/asset/image`)
  assert.equal(back.headers.get('content-type'), 'image/jpeg', '恢复默认后又是包内那张 JPEG')
})

// ═══════════════════════════════════════════════════════════════════════
// 2. 客户端半边
// ═══════════════════════════════════════════════════════════════════════
console.log('客户端半边：')

/** 最小 React 桩：只提供组件体跑起来需要的那几个 API。 */
const reactStub = {
  createElement: (type, props, ...children) => ({ type, props: props === null || props === undefined ? {} : props, children }),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
  useCallback: (fn) => fn,
  useRef: (initial) => ({ current: initial })
}

let loadedId = null
let clientModule = null
/** 记录注册过的席位。 */
const registrations = []

const clientCode = await readFile(CLIENT_PATH, 'utf8')
const sandbox = {
  console,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  fetch: async () => {
    throw new Error('smoke: 桩里没有宿主')
  },
  document: {
    head: { appendChild: () => {} },
    createElement: () => ({ textContent: '', remove: () => {} })
  }
}
sandbox.window = {
  __ModuleLoader__: {
    load: ({ id, factory }) => {
      loadedId = id
      clientModule = factory((name) => {
        if (name === 'react') return reactStub
        throw new Error(`smoke: 意料之外的 require(${name})`)
      })
    }
  }
}

await test('client.js 能被 ModuleLoader 加载，id 与包名一致', () => {
  vm.runInNewContext(clientCode, sandbox, { filename: 'lib/client.js' })
  assert.equal(loadedId, 'dsh-users-open-source')
  assert.equal(typeof clientModule.apply, 'function')
  assert.deepEqual(Array.from(clientModule.inject), ['slots'])
  assert.equal(typeof clientModule.__test, 'object')
})

/** 客户端插件的假 ctx：后面几个用例还要借它的服务表。 */
const slotCtx = {
  effect: () => () => {},
  get: () => undefined,
  slots: {
    inject: (name, callback) => {
      const effect = callback()
      registrations.push({ name, effect })
      return () => {}
    },
    register: (spec, renderer) => ({ spec, renderer })
  }
}

await test('apply() 注册设置页 / 侧栏栏目 / 主面板三个席位', () => {
  clientModule.apply(slotCtx)
  const specs = registrations.map((entry) => entry.effect.spec)
  assert.deepEqual(specs.map((spec) => spec.name).sort(), ['main', 'settings.section', 'sidebar.panellist'])
  const section = specs.find((spec) => spec.name === 'settings.section')
  assert.equal(section.label, '开源用户')
  const panel = specs.find((spec) => spec.name === 'sidebar.panellist')
  assert.equal(panel.id, 'net-speed')
  assert.equal(panel.order, 10)
  assert.equal(typeof panel.label, 'function')
  const main = specs.find((spec) => spec.name === 'main')
  assert.equal(main.key, 'net-speed')
})

const testApi = clientModule.__test

/**
 * 浅渲染一个元素：直接调用组件函数体（hooks 用桩顶掉）。
 * @param {object} element - React 元素。
 * @returns {any} 渲染结果。
 */
function renderElement(element) {
  assert.equal(typeof element.type, 'function')
  return element.type(element.props)
}

/**
 * 把渲染树里的文本抠出来，用来断言文案。
 * @param {any} node - 渲染结果。
 * @returns {string} 拼起来的文本。
 */
function treeText(node) {
  if (node === null || node === undefined || node === false || node === true) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(treeText).join(' ')
  if (typeof node === 'object') {
    // 自定义组件元素：顺手展开一层，否则断言只能看到外壳文案
    if (typeof node.type === 'function') return treeText(node.type(node.props))
    const fromChildren = Array.isArray(node.children) ? node.children.map(treeText).join(' ') : ''
    const fromProps = node.props !== null && node.props !== undefined && Array.isArray(node.props.children)
      ? node.props.children.map(treeText).join(' ')
      : ''
    return `${fromChildren} ${fromProps}`
  }
  return ''
}

/** 造一份假的 /state 快照。 */
function makeSnapshot(overrides) {
  const base = {
    ok: true,
    plugin: 'dsh-users-open-source',
    running: false,
    progress: null,
    config: {
      durationMs: 3000,
      connections: 4,
      schedule: { mode: 'off', intervalMinutes: 60, dailyTime: '03:00' }
    },
    last: null,
    history: [],
    loopbackPort: 51234
  }
  return { ...base, ...(overrides || {}) }
}

const sampleRecord = {
  at: new Date().toISOString(),
  source: 'manual',
  durationMs: 3000,
  connections: 4,
  download: { bytes: 3.2e9, ms: 3000, bps: 1.07e9 },
  upload: { bytes: 2.1e9, ms: 3000, bps: 7.0e8 },
  totalMs: 6100
}

await test('currentSessionId 从会话快照里取当前会话', () => {
  assert.equal(testApi.currentSessionId(), '')
  slotCtx.get = (name) => (name === 'sessions'
    ? { list: { getSnapshot: () => ({ current: 'session-zzz' }) } }
    : undefined)
  assert.equal(testApi.currentSessionId(), 'session-zzz')
  slotCtx.get = () => undefined
  assert.equal(testApi.currentSessionId(), '')
})

await test('云端备份的路径是相对 API 前缀的（别拼成 /dsh-users-open-source/dsh-users-open-source/…）', () => {
  assert.equal(testApi.apiBase + testApi.openWorkspacePath, '/dsh-users-open-source/open-workspace')
})

await test('格式化函数给得出人话', () => {
  assert.equal(testApi.formatRate(1.07e9), '1020 MB/s')
  assert.equal(testApi.formatBitRate(1.07e9), '8.56 Gbps')
  assert.equal(testApi.compactRate(1.07e9), '1020M')
  assert.equal(testApi.formatRate(524288), '512 KB/s')
  assert.equal(testApi.formatBytes(3.2e9), '2.98 GB')
  assert.equal(testApi.formatRate(0), '0.00 B/s')
  assert.equal(testApi.panelLabel(), '等待上传')
})

await test('空快照下设置页 / 主面板 / 图标都能渲染', () => {
  testApi.store.update(makeSnapshot())
  const settings = renderElement(reactStub.createElement(testApi.SpeedPanel, { variant: 'settings' }))
  const text = treeText(settings)
  assert.ok(text.includes('开源用户'), '设置页标题应为「开源用户」')
  assert.ok(text.includes('打包') && text.includes('上传'))
  assert.ok(text.includes('云端备份'), '应有「云端备份」按钮')
  assert.ok(text.includes('（划掉）本地不备份'), '按钮后面应有那句文案')
  // 界面上不该再留任何解释性注释
  assert.ok(!text.includes('127.0.0.1'), '不该再提回环地址')
  assert.ok(!text.includes('不消耗 token'), '不该再提 token')
  assert.ok(!text.includes('本机带宽测速'), '不该再留「点上传开始跑…」那句')
  const panelTree = renderElement(reactStub.createElement(testApi.SpeedPanel, { variant: 'panel' }))
  assert.ok(treeText(panelTree).includes('本机自动开源'), '主面板标题应为「本机自动开源」')
  renderElement(reactStub.createElement(testApi.SpeedIcon, { size: 30, active: false }))
  renderElement(reactStub.createElement(testApi.SpeedIcon, { size: 30, active: true }))
  renderElement(reactStub.createElement(testApi.Sparkline, { samples: [] }))
  renderElement(reactStub.createElement(testApi.HistoryBlock, { items: [] }))

  const imageBlock = renderElement(reactStub.createElement(testApi.ImageBlock, {
    custom: false,
    busy: false,
    note: '',
    onPick: () => {},
    onReset: () => {}
  }))
  const imageText = treeText(imageBlock)
  assert.ok(imageText.includes('上传图片'), '应有「上传图片」块')
  assert.ok(imageText.includes('选择图片'), '应有选择图片按钮')
  assert.ok(imageText.includes('当前：默认图'), '默认状态下应标明用的是默认图')
  assert.ok(!imageText.includes('恢复默认图'), '没上传过时不显示恢复按钮')

  const customImageBlock = renderElement(reactStub.createElement(testApi.ImageBlock, {
    custom: true,
    busy: false,
    note: '已换成你选的图',
    onPick: () => {},
    onReset: () => {}
  }))
  const customText = treeText(customImageBlock)
  assert.ok(customText.includes('当前：你上传的图'))
  assert.ok(customText.includes('恢复默认图'), '上传过之后应能恢复默认')
  assert.ok(customText.includes('已换成你选的图'))
})

await test('有历史数据时侧栏 label 与面板都带上速率', () => {
  testApi.store.update(makeSnapshot({ last: sampleRecord, history: [sampleRecord] }))
  const label = testApi.panelLabel()
  assert.ok(label.startsWith('↓') && label.includes('↑'), `侧栏标签异常：${label}`)
  const settings = renderElement(reactStub.createElement(testApi.SpeedPanel, { variant: 'settings' }))
  const text = treeText(settings)
  assert.ok(text.includes('Gbps') || text.includes('Mbps'), '应给出比特速率')
  const history = renderElement(reactStub.createElement(testApi.HistoryBlock, { items: [sampleRecord] }))
  assert.ok(treeText(history).includes('手动'), '手动触发的记录应写「手动」')
  const scheduled = { ...sampleRecord, source: 'schedule' }
  const autoHistory = renderElement(reactStub.createElement(testApi.HistoryBlock, { items: [scheduled] }))
  assert.ok(treeText(autoHistory).includes('自动'), '定时触发的记录应写「自动」')

  const withButtons = renderElement(reactStub.createElement(testApi.HistoryBlock, {
    items: [sampleRecord, scheduled],
    onClear: () => {},
    onDelete: () => {}
  }))
  const buttonText = treeText(withButtons)
  assert.ok(buttonText.includes('清空记录'), '有记录时应出现清空按钮')
  assert.ok(buttonText.includes('×'), '每条记录右边应有删除按钮')

  const noRecords = renderElement(reactStub.createElement(testApi.HistoryBlock, { items: [], onClear: () => {} }))
  assert.ok(!treeText(noRecords).includes('清空记录'), '没记录时不该显示清空按钮')
})

await test('测速中的快照让面板显示实时进度、图标带活点', () => {
  testApi.store.update(makeSnapshot({
    running: true,
    progress: {
      phase: 'up',
      phaseIndex: 2,
      phaseCount: 2,
      bytes: 5e8,
      instantBps: 9.5e8,
      elapsedMs: 1200,
      durationMs: 3000,
      samples: [1e8, 5e8, 9.5e8]
    },
    last: sampleRecord
  }))
  const panel = renderElement(reactStub.createElement(testApi.SpeedPanel, { variant: 'settings' }))
  const text = treeText(panel)
  assert.ok(text.includes('正在开源用户'), `应显示「正在开源用户」：${text.slice(0, 200)}`)
  assert.ok(text.includes('上传中'), '按钮应显示「上传中」')
  assert.ok(!text.includes('测速中'), '不该再出现「测速中」')
  renderElement(reactStub.createElement(testApi.SpeedIcon, { size: 30, active: true }))
  assert.equal(testApi.panelLabel(), '开源中')
  // 运行时：面板柱形图下面出现那张图；侧栏那一栏则是「图标 + 图片」纵向排列（不是浮层，不遮挡）
  assert.ok(JSON.stringify(panel).includes('dns-shot'), '运行中面板里应出现那张图')
  const iconTree = renderElement(reactStub.createElement(testApi.SpeedIcon, { size: 30, active: true }))
  assert.equal(iconTree.type, 'div', '侧栏那一栏现在是「图标 + 图片」的纵向容器')
  assert.equal(iconTree.props.className, 'dns-bar')
  const kids = (Array.isArray(iconTree.children) ? iconTree.children : []).flat().filter(Boolean)
  assert.equal(kids.length, 2, '运行中应有「图标 + 图片」两个孩子')
  assert.equal(kids[1].type, 'img', '第二个孩子是那张图本身（不再是浮层）')
  assert.ok(String(kids[1].props.style.width).endsWith('px'), '图片宽度来自配置')

  testApi.store.update(makeSnapshot({ running: false }))
  assert.equal(testApi.panelLabel(), '等待上传')
  const idleTree = renderElement(reactStub.createElement(testApi.SpeedIcon, { size: 30, active: true }))
  const idleKids = (Array.isArray(idleTree.children) ? idleTree.children : []).flat().filter(Boolean)
  assert.equal(idleKids.length, 1, '不跑的时候只有图标，不占地方')
})

await test('侧栏文字变化时会重新注册那一栏（label thunk 得以刷新）', async () => {
  await sleep(1100)
  const before = registrations.length
  const changed = { ...sampleRecord, upload: { bytes: 512, ms: 1000, bps: 1048576 } }
  testApi.store.update(makeSnapshot({ last: changed, history: [changed] }))
  assert.ok(registrations.length > before, '数字变化后应重新注册侧栏席位')
  const latest = registrations[registrations.length - 1]
  assert.equal(latest.effect.spec.name, 'sidebar.panellist')
  assert.ok(latest.effect.spec.label().startsWith('↓'), `新标签应带速率：${latest.effect.spec.label()}`)
})

await test('定时设置区在三种模式下都能渲染', () => {
  for (const mode of ['off', 'interval', 'daily']) {
    const draft = {
      durationMs: 3000,
      connections: 4,
      schedule: { mode, intervalMinutes: 60, dailyTime: '03:00' }
    }
    const block = renderElement(reactStub.createElement(testApi.ScheduleBlock, {
      draft,
      dirty: true,
      saving: false,
      notice: '已保存',
      onPatch: () => {},
      onSave: () => {}
    }))
    const text = treeText(block)
    assert.ok(text.includes('自动上传'))
    if (mode === 'off') assert.ok(!text.includes('当前不会自动'), 'off 模式不该再留那句说明')
    if (mode === 'interval') assert.ok(text.includes('60'))
    if (mode === 'daily') assert.ok(text.includes('03:00'))
  }
})

// ═══════════════════════════════════════════════════════════════════════
// 收尾
// ═══════════════════════════════════════════════════════════════════════
for (const dispose of disposers) {
  try {
    dispose()
  } catch {
    /* 忽略 */
  }
}
bridge.close()
await rm(process.env.DSH_HOME, { recursive: true, force: true })

console.log('')
if (failures.length > 0) {
  console.error(`✗ ${failures.length} 个用例失败：`)
  for (const failure of failures) console.error(`\n--- ${failure}`)
  process.exit(1)
}
console.log(`✓ 全部用例通过（宿主日志 ${logs.length} 条）`)
for (const line of logs) console.log(`    ${line}`)
