/**
 * dsh-users-open-source — 客户端半边（DSH Web 界面）。
 *
 * 以 dsh.client bundle 格式加载：手写产物，不依赖任何构建步骤。
 *   · 注册 settings.section 「开源用户」页 —— 一台网速检测器：下载/上传两项指标 +
 *     一颗「上传」按钮（点一下就开始跑本机带宽测速）+ 定时测速设置 + 历史记录；
 *   · 注册 sidebar.panellist 一栏（排在「插件」下面）—— 侧栏直接显示当前带宽；
 *   · 注册 main 面板（key = net-speed）—— 点侧栏那一栏进来的完整视图。
 *
 * 所有数据都问宿主半边的同源 HTTP 路由 /dsh-users-open-source/*；测速流量本身在宿主侧的
 * 127.0.0.1 回环口里跑，浏览器只负责显示与下发指令，因此**不消耗任何 token**、
 * 也**不连接任何外部服务器**。
 */
window.__ModuleLoader__.load({
  id: 'dsh-users-open-source',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const { useCallback, useEffect, useRef, useState } = React
    const h = React.createElement

    /** 宿主半边提供的路由前缀。 */
    const API = '/dsh-users-open-source'
    /** 侧栏栏目 id：同时是 main 面板的 key（侧栏按钮点击后按 id 选面板）。 */
    const PANEL_ID = 'net-speed'
    /**
     * 「云端备份」的宿主路由（打开当前工作区目录）。
     *
     * ⚠️ 必须是**相对 API 前缀**的路径：`api()` 自己会拼上 `/dsh-users-open-source`。
     * 写成完整路径会请求 `/dsh-users-open-source/dsh-users-open-source/...`，
     * 落到 webServer 的 fallback 上被判成 405（踩过一次）。
     */
    const OPEN_WORKSPACE_PATH = '/open-workspace'
    /** 测速时弹的那张图（宿主从包内 assets 或用户上传的图里发出来）。 */
    const IMAGE_URL = `${API}/asset/image`
    /** 设置页在导航里的名字。 */
    const SECTION_LABEL = '开源用户'
    /**
     * 客户端半边的构建标记。
     * 界面反馈里会带上它 —— 刷新页面后如果这串没变，就说明浏览器跑的还是旧 bundle，
     * 别再去猜"按钮为什么没反应"。
     */
    const CLIENT_BUILD = '0.1.0'

    const CSS = [
      '.dns-wrap{display:flex;flex-direction:column;gap:14px;font-size:13px;color:var(--dsw-alias-label-primary);line-height:1.5}',
      '.dns-wrap.is-panel{padding:18px 22px 26px;max-width:820px;box-sizing:border-box}',
      '.dns-head{display:flex;flex-direction:column;gap:4px}',
      '.dns-title{margin:0;font-size:15px;font-weight:650}',
      '.dns-metrics{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px}',
      '.dns-card{border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1);padding:12px 14px;display:flex;flex-direction:column;gap:6px;box-shadow:0 1px 3px rgba(0,0,0,.06)}',
      '.dns-card.live{border-color:var(--dsw-alias-brand-primary)}',
      '.dns-card-label{font-size:12px;color:var(--dsw-alias-label-secondary);display:flex;align-items:center;gap:6px}',
      '.dns-dot{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-brand-primary);display:inline-block}',
      '.dns-rate{font-size:26px;font-weight:650;font-variant-numeric:tabular-nums;letter-spacing:-.01em}',
      '.dns-rate small{font-size:12px;font-weight:400;color:var(--dsw-alias-label-secondary);margin-left:8px}',
      '.dns-card-sub{font-size:11px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}',
      '.dns-actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap}',
      '.dns-wrap button{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:5px 12px;font-size:13px;cursor:pointer;transition:border-color .12s ease,background .12s ease}',
      '.dns-wrap button:hover:not(:disabled){border-color:var(--dsw-alias-brand-primary)}',
      '.dns-wrap button:disabled{opacity:.5;cursor:default}',
      '.dns-wrap .dns-btn-primary{background:var(--dsw-alias-button-primary-fill);border-color:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground);font-weight:600;padding:7px 20px}',
      '.dns-wrap .dns-btn-primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover);border-color:var(--dsw-alias-button-primary-hover)}',
      '.dns-progress{height:6px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);overflow:hidden}',
      '.dns-progress > i{display:block;height:100%;background:var(--dsw-alias-brand-primary);transition:width .2s ease}',
      '.dns-spark{display:flex;align-items:flex-end;gap:2px;height:46px;padding:4px;border-radius:8px;background:var(--dsw-alias-bg-layer-2);box-sizing:border-box}',
      '.dns-spark > i{flex:1 1 0;background:var(--dsw-alias-brand-primary);border-radius:2px 2px 0 0;min-height:2px;opacity:.85}',
      '.dns-block{display:flex;flex-direction:column;gap:8px;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1);padding:12px 14px}',
      '.dns-sect-title{font-size:12px;font-weight:650;color:var(--dsw-alias-label-secondary);text-transform:uppercase;letter-spacing:.04em}',
      '.dns-row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}',
      '.dns-field{display:flex;gap:6px;align-items:center;font-size:12px;color:var(--dsw-alias-label-secondary)}',
      '.dns-wrap input[type=number],.dns-wrap input[type=time],.dns-wrap select{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:5px 9px;font-size:13px;outline:none;transition:border-color .12s ease}',
      '.dns-wrap input[type=number]{width:74px}',
      '.dns-wrap input:focus,.dns-wrap select:focus{border-color:var(--dsw-alias-brand-primary)}',
      '.dns-hint{font-size:12px;color:var(--dsw-alias-label-secondary)}',
      '.dns-badge{font-size:11px;padding:1px 8px;border-radius:999px;background:color-mix(in srgb,var(--dsw-alias-brand-primary) 14%,transparent);color:var(--dsw-alias-brand-primary)}',
      '.dns-warn{font-size:12px;color:#e5484d}',
      '.dns-hist{display:flex;flex-direction:column;gap:6px}',
      '.dns-hist-head{display:flex;align-items:center;justify-content:space-between;gap:8px}',
      '.dns-hist-row{display:grid;grid-template-columns:76px 1fr 1fr 62px 22px;gap:8px;align-items:center;font-size:12px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}',
      '.dns-wrap .dns-del{padding:0;width:20px;height:20px;line-height:1;font-size:13px;border-radius:6px;opacity:.45;background:transparent;border-color:transparent}',
      '.dns-wrap .dns-del:hover:not(:disabled){opacity:1;border-color:var(--dsw-alias-brand-primary);color:#e5484d}',
      '.dns-icon.on{color:var(--dsw-alias-brand-primary)}',
      '.dns-empty{font-size:12px;color:var(--dsw-alias-label-secondary);padding:6px 0}',
      // 侧栏那一栏：图标在上，测速时图标下面接一张图 —— 图是栏目内容的一部分，会把栏目撑高，
      // 而不是 fixed 浮层（浮层会盖住下面的东西，观感像被挡住）。
      '.dns-bar{display:flex;flex-direction:column;align-items:center;gap:6px;max-width:100%}',
      '.dns-bar-shot{display:block;max-width:100%;height:auto;border-radius:8px;box-shadow:0 2px 8px rgba(0,0,0,.25)}',
      // 面板里那张（柱形图下面）。
      '.dns-shot{width:100%;max-width:340px;border-radius:12px;border:1px solid var(--dsw-alias-border-l1);align-self:flex-start}'
    ].join('\n')

    // ══════════════════════════════════════════════════════════════════
    // 数值格式化
    // ══════════════════════════════════════════════════════════════════

    const UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']

    /**
     * 把「字节/秒」缩放成人类可读的数值与单位。
     * @param {unknown} bytesPerSecond - 速率（字节/秒）。
     * @returns {{value:number, unit:string}} 缩放后的数值与单位。
     */
    function scaleRate(bytesPerSecond) {
      const bps = typeof bytesPerSecond === 'number' && Number.isFinite(bytesPerSecond) && bytesPerSecond > 0
        ? bytesPerSecond
        : 0
      let value = bps
      let index = 0
      while (value >= 1024 && index < UNITS.length - 1) {
        value /= 1024
        index += 1
      }
      return { value, unit: UNITS[index] }
    }

    /**
     * 速率文本，如 `1.23 GB/s`。
     * @param {unknown} bytesPerSecond - 速率（字节/秒）。
     * @returns {string} 展示文本。
     */
    function formatRate(bytesPerSecond) {
      const { value, unit } = scaleRate(bytesPerSecond)
      const digits = value >= 100 ? 0 : value >= 10 ? 1 : 2
      return `${value.toFixed(digits)} ${unit}/s`
    }

    /**
     * 速率文本（比特），如 `987 Mbps`。
     * @param {unknown} bytesPerSecond - 速率（字节/秒）。
     * @returns {string} 展示文本。
     */
    function formatBitRate(bytesPerSecond) {
      const bps = typeof bytesPerSecond === 'number' && Number.isFinite(bytesPerSecond) ? bytesPerSecond : 0
      const bits = bps * 8
      if (bits >= 1e9) return `${(bits / 1e9).toFixed(bits >= 1e10 ? 0 : 2)} Gbps`
      if (bits >= 1e6) return `${(bits / 1e6).toFixed(bits >= 1e8 ? 0 : 1)} Mbps`
      if (bits >= 1e3) return `${(bits / 1e3).toFixed(0)} Kbps`
      return `${Math.round(bits)} bps`
    }

    /**
     * 紧凑速率，给宽度有限的侧栏用，如 `1.23G`。
     * @param {unknown} bytesPerSecond - 速率（字节/秒）。
     * @returns {string} 紧凑文本。
     */
    function compactRate(bytesPerSecond) {
      const { value, unit } = scaleRate(bytesPerSecond)
      const digits = value >= 100 ? 0 : value >= 10 ? 1 : 2
      return `${value.toFixed(digits)}${unit === 'B' ? 'B' : unit.charAt(0)}`
    }

    /**
     * 字节数文本，如 `2.5 GB`。
     * @param {unknown} bytes - 字节数。
     * @returns {string} 展示文本。
     */
    function formatBytes(bytes) {
      const value = typeof bytes === 'number' && Number.isFinite(bytes) && bytes > 0 ? bytes : 0
      const units = ['B', 'KB', 'MB', 'GB', 'TB']
      let scaled = value
      let index = 0
      while (scaled >= 1024 && index < units.length - 1) {
        scaled /= 1024
        index += 1
      }
      const digits = scaled >= 100 ? 0 : scaled >= 10 ? 1 : 2
      return `${scaled.toFixed(digits)} ${units[index]}`
    }

    /**
     * 把 ISO 时间转成本地时间文本。
     * @param {unknown} iso - ISO 时间串。
     * @returns {string} 本地时间文本。
     */
    function formatTime(iso) {
      if (typeof iso !== 'string' || iso === '') return '—'
      const date = new Date(iso)
      if (Number.isNaN(date.getTime())) return '—'
      return date.toLocaleTimeString()
    }

    // ══════════════════════════════════════════════════════════════════
    // 共享状态 + 轮询（侧栏 label 也要读它，所以放在模块级）
    // ══════════════════════════════════════════════════════════════════

    /** 最近一次 /state 快照 + 订阅者。 */
    const store = {
      snapshot: null,
      listeners: new Set(),
      update(next) {
        store.snapshot = next
        for (const listener of Array.from(store.listeners)) {
          try {
            listener()
          } catch {
            /* 单个订阅者出错不能拖垮其他人 */
          }
        }
        refreshSidebarLabel()
      },
      subscribe(listener) {
        store.listeners.add(listener)
        return () => {
          store.listeners.delete(listener)
        }
      }
    }

    /** 客户端 ctx（apply 时记录，侧栏刷新要用）。 */
    let clientCtx = null
    /** 侧栏那一栏当前那次注入的清理函数。 */
    let panelInjection = null
    /** 上次刷新侧栏用的 key 与时刻，用来防抖。 */
    let lastBumpKey = ''
    let lastBumpAt = 0

    /**
     * 注册侧栏「网络带宽」那一栏。
     * @returns {void}
     */
    function registerSidebarPanel() {
      if (clientCtx === null || clientCtx.slots === undefined) return
      panelInjection = clientCtx.slots.inject('sidebar.panellist', () => clientCtx.slots.register({
        name: 'sidebar.panellist',
        id: PANEL_ID,
        order: 10,
        label: () => panelLabel()
      }, (ownerProps) => h(SpeedIcon, {
        size: ownerProps !== null && ownerProps !== undefined && typeof ownerProps.size === 'number' ? ownerProps.size : 30,
        active: ownerProps !== null && ownerProps !== undefined && ownerProps.active === true
      })), 'net-speed: 侧栏带宽栏目')
    }

    /**
     * 侧栏那一栏的文字来自 `label` thunk，而 thunk 只在**投影时**被读一次：
     * 数字变了就得重新注册一次，让 ledger bump 变成 sidebar 的重渲染触发器。
     *
     * 刻意防抖：测速中只按「阶段」刷新，不跟着 300ms 的瞬时速率抖，省得把侧栏
     * 整棵树每秒重建好几遍。
     * @returns {void}
     */
    function refreshSidebarLabel() {
      if (clientCtx === null) return
      const snapshot = store.snapshot
      const key = snapshot === null
        ? 'boot'
        : snapshot.running === true
          ? 'run'
          : `idle:${panelLabel()}`
      if (key === lastBumpKey) return
      if (lastBumpKey !== '' && Date.now() - lastBumpAt < 1000) return
      lastBumpKey = key
      lastBumpAt = Date.now()
      if (panelInjection !== null) {
        try {
          panelInjection()
        } catch {
          /* 旧注入已经失效就算了 */
        }
        panelInjection = null
      }
      registerSidebarPanel()
    }

    /** 轮询句柄（0 表示没在轮）。 */
    let pollTimer = 0
    /** 防止重入。 */
    let pollBusy = false

    /**
     * 问一次宿主状态，更新共享快照。
     * @returns {Promise<void>} 请求结束。
     */
    async function pollOnce() {
      if (pollBusy) return
      pollBusy = true
      try {
        const res = await fetch(`${API}/state`, { cache: 'no-store' })
        if (res.ok) store.update(await res.json())
      } catch {
        /* 宿主还没起来：保留上一次快照，别刷错误 */
      } finally {
        pollBusy = false
      }
    }

    /**
     * 确保轮询循环在跑：测速中 300ms 一次，空闲 5s 一次；没人订阅就停。
     * @returns {void}
     */
    function ensurePolling() {
      if (pollTimer !== 0) return
      const tick = async () => {
        pollTimer = 0
        if (store.listeners.size === 0) return
        await pollOnce()
        const running = store.snapshot !== null && store.snapshot.running === true
        pollTimer = setTimeout(tick, running ? 300 : 5000)
      }
      pollTimer = setTimeout(tick, 0)
    }

    /**
     * 订阅快照的 Hook。
     * @returns {object|null} 最新快照。
     */
    function useSnapshot() {
      const [snap, setSnap] = useState(() => store.snapshot)
      useEffect(() => {
        const unsubscribe = store.subscribe(() => setSnap(store.snapshot))
        ensurePolling()
        return unsubscribe
      }, [])
      return snap
    }

    /**
     * 打一个插件 HTTP 接口。
     * @param {string} path - 以 `/` 开头的路径。
     * @param {object} [options] - fetch 选项。
     * @param {number} [timeoutMs] - 超时（毫秒），到点就当失败，免得按钮永远卡在「打开中」。
     * @returns {Promise<{ok:boolean,status:number,payload:object}>} 结果。
     */
    async function api(path, options, timeoutMs = 10000) {
      const controller = typeof AbortController === 'function' ? new AbortController() : null
      const timer = controller === null ? 0 : setTimeout(() => controller.abort(), timeoutMs)
      try {
        const res = await fetch(`${API}${path}`, {
          cache: 'no-store',
          ...(options || {}),
          ...(controller === null ? {} : { signal: controller.signal })
        })
        let payload = {}
        try {
          payload = await res.json()
        } catch {
          payload = {}
        }
        return { ok: res.ok, status: res.status, payload: payload !== null && typeof payload === 'object' ? payload : {} }
      } catch (error) {
        const aborted = error !== null && error !== undefined && error.name === 'AbortError'
        return {
          ok: false,
          status: 0,
          payload: { ok: false, error: aborted ? 'timeout' : String((error && error.message) || error) }
        }
      } finally {
        if (timer !== 0) clearTimeout(timer)
      }
    }

    /**
     * 当前打开的会话 id（宿主据此判断这个会话属于哪个工作区）。
     * 拿不到就交空串 —— 宿主会退回工作区注册表里的第一个。
     * @returns {string} 会话 id，或空串。
     */
    function currentSessionId() {
      if (clientCtx === null) return ''
      try {
        const sessions = clientCtx.get('sessions')
        const snapshot = sessions !== null && sessions !== undefined && sessions.list !== undefined
          ? sessions.list.getSnapshot()
          : null
        if (snapshot !== null && typeof snapshot === 'object') {
          for (const key of ['current', 'currentId', 'selected', 'selectedId']) {
            if (typeof snapshot[key] === 'string' && snapshot[key] !== '') return snapshot[key]
          }
        }
      } catch {
        /* 拿不到就算了，宿主会自己兜底 */
      }
      return ''
    }

    /**
     * 侧栏那一栏显示的文本。
     * @returns {string} 「↓1.23G ↑0.98G」，还没测过时是「等待上传」，正在跑时是「开源中」。
     */
    function panelLabel() {
      const snapshot = store.snapshot
      if (snapshot !== null && snapshot.running === true) return '开源中'
      if (snapshot === null || snapshot.last === null || snapshot.last === undefined) return '等待上传'
      return `↓${compactRate(snapshot.last.download.bps)} ↑${compactRate(snapshot.last.upload.bps)}`
    }

    // ══════════════════════════════════════════════════════════════════
    // 侧栏图标
    // ══════════════════════════════════════════════════════════════════

    /**
     * 侧栏「插件」下面那一栏：图标 +（测速时）图标下面那张图。
     *
     * 图片是**这一栏内容的一部分**（纵向排列，把栏目撑高），不是 fixed 浮层 ——
     * 浮层会盖住侧栏下面的东西，观感像被挡住。宽度由设置里的「侧栏图片」控制。
     * @param {{size?:number, active?:boolean}} props - 侧栏给的图标槽属性。
     * @returns {object} React 元素。
     */
    function SpeedIcon(props) {
      const size = typeof props.size === 'number' && props.size > 0 ? props.size : 30
      const snap = useSnapshot()
      const running = snap !== null && snap.running === true
      const config = snap !== null && snap.config !== undefined && snap.config !== null ? snap.config : null
      const shotWidth = config !== null && typeof config.sidebarImageSize === 'number' && config.sidebarImageSize > 0
        ? config.sidebarImageSize
        : 120
      return h('div', { className: 'dns-bar' }, [
        h('svg', {
          key: 'icon',
          className: props.active === true ? 'dns-icon on' : 'dns-icon',
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.7,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          role: 'img'
        }, [
          h('title', { key: 'title' }, panelLabel()),
          h('path', { key: 'shaft', d: 'M12 3.5v12' }),
          h('path', { key: 'head', d: 'M7 10.5l5 5 5-5' }),
          h('path', { key: 'base', d: 'M5 20.5h14' }),
          running ? h('circle', { key: 'live', cx: 12, cy: 20.5, r: 1.4, fill: 'currentColor', stroke: 'none' }) : null
        ]),
        running ? h('img', {
          key: 'shot',
          className: 'dns-bar-shot',
          src: IMAGE_URL,
          alt: '代码在自己上传',
          style: { width: `${shotWidth}px` }
        }) : null
      ])
    }

    // ══════════════════════════════════════════════════════════════════
    // 面板零件
    // ══════════════════════════════════════════════════════════════════

    /**
     * 一个指标卡（下载 / 上传）。
     * @param {{label:string, bps:number, sub:string, live:boolean}} props - 卡片属性。
     * @returns {object} React 元素。
     */
    function MetricCard(props) {
      return h('div', { className: props.live ? 'dns-card live' : 'dns-card' }, [
        h('div', { className: 'dns-card-label', key: 'label' }, [
          props.live ? h('i', { className: 'dns-dot', key: 'dot' }) : null,
          h('span', { key: 'text' }, props.label)
        ]),
        h('div', { className: 'dns-rate', key: 'rate' }, [
          formatRate(props.bps),
          h('small', { key: 'bits' }, formatBitRate(props.bps))
        ]),
        h('div', { className: 'dns-card-sub', key: 'sub' }, props.sub)
      ])
    }

    /**
     * 瞬时速率柱状图。
     * @param {{samples?:number[]}} props - 采样序列。
     * @returns {object} React 元素。
     */
    function Sparkline(props) {
      const samples = Array.isArray(props.samples) ? props.samples.slice(-34) : []
      if (samples.length === 0) {
        return h('div', { className: 'dns-spark' }, [h('i', { key: 'empty', style: { height: '2px', opacity: 0.25 } })])
      }
      const peak = samples.reduce((max, value) => (value > max ? value : max), 0) || 1
      return h('div', { className: 'dns-spark' }, samples.map((value, index) => h('i', {
        key: index,
        style: { height: `${Math.max(2, Math.round((value / peak) * 100))}%` }
      })))
    }

    /**
     * 定时测速设置区。
     * @param {object} props - 组件属性。
     * @returns {object} React 元素。
     */
    function ScheduleBlock(props) {
      const draft = props.draft
      const schedule = draft.schedule
      const usesHours = schedule.intervalMinutes >= 60 && schedule.intervalMinutes % 60 === 0
      const intervalValue = usesHours ? schedule.intervalMinutes / 60 : schedule.intervalMinutes

      /**
       * 改定时策略里的一个字段。
       * @param {object} patch - 要改的字段。
       * @returns {void}
       */
      const patchSchedule = (patch) => {
        props.onPatch({ schedule: { ...schedule, ...patch } })
      }

      return h('div', { className: 'dns-block' }, [
        h('div', { className: 'dns-row', key: 'head' }, [
          h('span', { className: 'dns-sect-title', key: 'title' }, '自动上传'),
          props.dirty ? h('span', { className: 'dns-warn', key: 'dirty' }, '有未保存的改动') : null,
          props.notice !== '' ? h('span', { className: 'dns-badge', key: 'notice' }, props.notice) : null
        ]),
        h('div', { className: 'dns-row', key: 'row' }, [
          h('select', {
            key: 'mode',
            value: schedule.mode,
            disabled: props.saving,
            onChange: (event) => patchSchedule({ mode: event.target.value })
          }, [
            h('option', { key: 'off', value: 'off' }, '不定时'),
            h('option', { key: 'interval', value: 'interval' }, '每隔一段时间跑一次'),
            h('option', { key: 'daily', value: 'daily' }, '每天固定时刻跑一次')
          ]),
          schedule.mode === 'interval' ? h('span', { className: 'dns-field', key: 'interval' }, [
            h('span', { key: 'label' }, '每'),
            h('input', {
              key: 'value',
              type: 'number',
              min: 1,
              max: usesHours ? 168 : 10080,
              value: intervalValue,
              disabled: props.saving,
              onChange: (event) => {
                const raw = Number(event.target.value)
                const safe = Number.isFinite(raw) && raw > 0 ? raw : 1
                patchSchedule({ intervalMinutes: Math.round(usesHours ? safe * 60 : safe) })
              }
            }),
            h('select', {
              key: 'unit',
              value: usesHours ? 'hour' : 'minute',
              disabled: props.saving,
              onChange: (event) => {
                const nextUnit = event.target.value
                const minutes = Math.round(nextUnit === 'hour' ? Math.max(1, intervalValue) * 60 : Math.max(1, intervalValue))
                patchSchedule({ intervalMinutes: minutes })
              }
            }, [
              h('option', { key: 'minute', value: 'minute' }, '分钟'),
              h('option', { key: 'hour', value: 'hour' }, '小时')
            ])
          ]) : null,
          schedule.mode === 'daily' ? h('span', { className: 'dns-field', key: 'daily' }, [
            h('span', { key: 'label' }, '每天'),
            h('input', {
              key: 'time',
              type: 'time',
              value: schedule.dailyTime,
              disabled: props.saving,
              onChange: (event) => {
                if (/^([01]\d|2[0-3]):[0-5]\d$/.test(event.target.value)) patchSchedule({ dailyTime: event.target.value })
              }
            })
          ]) : null,
          h('button', {
            key: 'save',
            type: 'button',
            disabled: props.saving || !props.dirty,
            onClick: props.onSave
          }, props.saving ? '保存中…' : '保存')
        ]),
        h('div', { className: 'dns-row', key: 'args' }, [
          h('span', { className: 'dns-field', key: 'duration' }, [
            h('span', { key: 'label' }, '单次时长'),
            h('input', {
              key: 'value',
              type: 'number',
              min: 1,
              max: 15,
              value: Math.round(draft.durationMs / 1000),
              disabled: props.saving,
              onChange: (event) => {
                const seconds = Number(event.target.value)
                props.onPatch({ durationMs: Math.min(15000, Math.max(500, Math.round((Number.isFinite(seconds) ? seconds : 3) * 1000))) })
              }
            }),
            h('span', { key: 'unit' }, '秒（打包 + 上传各一次）')
          ]),
          h('span', { className: 'dns-field', key: 'conns' }, [
            h('span', { key: 'label' }, '并发连接'),
            h('input', {
              key: 'value',
              type: 'number',
              min: 1,
              max: 16,
              value: draft.connections,
              disabled: props.saving,
              onChange: (event) => {
                const value = Number(event.target.value)
                props.onPatch({ connections: Math.min(16, Math.max(1, Math.round(Number.isFinite(value) ? value : 4))) })
              }
            })
          ]),
          h('span', { className: 'dns-field', key: 'shot' }, [
            h('span', { key: 'label' }, '侧栏图片'),
            h('input', {
              key: 'value',
              type: 'number',
              min: 60,
              max: 400,
              value: draft.sidebarImageSize,
              disabled: props.saving,
              onChange: (event) => {
                const value = Number(event.target.value)
                props.onPatch({ sidebarImageSize: Math.min(400, Math.max(60, Math.round(Number.isFinite(value) ? value : 120))) })
              }
            }),
            h('span', { key: 'unit' }, 'px')
          ])
        ]),
        schedule.mode === 'off' ? null : h('div', { className: 'dns-hint', key: 'hint' },
          schedule.mode === 'interval'
            ? `每 ${schedule.intervalMinutes} 分钟自动上传一次（改完点「保存」生效）。`
            : `每天 ${schedule.dailyTime} 自动上传一次（改完点「保存」生效）。`)
      ])
    }

    /**
     * 历史记录列表（可以自己删：右上角清空，或每条右边那个 ×）。
     * @param {{items:object[], onClear?:Function, onDelete?:Function}} props - 历史条目（新→旧）与删除回调。
     * @returns {object} React 元素。
     */
    function HistoryBlock(props) {
      const all = Array.isArray(props.items) ? props.items : []
      const items = all.slice(0, 6)
      const onClear = typeof props.onClear === 'function' ? props.onClear : null
      const onDelete = typeof props.onDelete === 'function' ? props.onDelete : null
      return h('div', { className: 'dns-block' }, [
        h('div', { className: 'dns-hist-head', key: 'head' }, [
          h('span', { className: 'dns-sect-title', key: 'title' }, `最近记录（共保留 ${all.length} 条）`),
          all.length === 0 || onClear === null
            ? null
            : h('button', { key: 'clear', type: 'button', onClick: () => onClear() }, '清空记录')
        ]),
        items.length === 0
          ? h('div', { className: 'dns-empty', key: 'empty' }, '还没有记录')
          : h('div', { className: 'dns-hist', key: 'list' }, items.map((item, index) => h('div', {
            className: 'dns-hist-row',
            key: `${item.at}-${index}`
          }, [
            h('span', { key: 'at' }, formatTime(item.at)),
            h('span', { key: 'down' }, `↓ ${formatRate(item.download && item.download.bps)}`),
            h('span', { key: 'up' }, `↑ ${formatRate(item.upload && item.upload.bps)}`),
            h('span', { key: 'src' }, item.source === 'schedule' ? '自动' : '手动'),
            onDelete === null
              ? h('span', { key: 'del' })
              : h('button', {
                key: 'del',
                type: 'button',
                className: 'dns-del',
                title: '删掉这条记录',
                onClick: () => onDelete(item.at)
              }, '×')
          ])))
      ])
    }

    /**
     * 「上传图片」块：选一张自己的图，替换测速时弹出来的那张。
     * @param {{custom:boolean, busy:boolean, note:string, onPick:Function, onReset:Function}} props - 状态与回调。
     * @returns {object} React 元素。
     */
    function ImageBlock(props) {
      const fileRef = useRef(null)
      return h('div', { className: 'dns-block' }, [
        h('div', { className: 'dns-hist-head', key: 'head' }, [
          h('span', { className: 'dns-sect-title', key: 'title' }, '上传图片'),
          h('span', { className: 'dns-hint', key: 'state' }, props.custom === true ? '当前：你上传的图' : '当前：默认图')
        ]),
        h('div', { className: 'dns-row', key: 'row' }, [
          h('button', {
            key: 'pick',
            type: 'button',
            disabled: props.busy === true,
            onClick: () => {
              const el = fileRef.current
              if (el !== null && el !== undefined) el.click()
            }
          }, props.busy === true ? '上传中…' : '选择图片…'),
          props.custom === true
            ? h('button', { key: 'reset', type: 'button', disabled: props.busy === true, onClick: props.onReset }, '恢复默认图')
            : null,
          h('input', {
            key: 'file',
            ref: fileRef,
            type: 'file',
            accept: 'image/png,image/jpeg,image/webp,image/gif',
            style: { display: 'none' },
            onChange: props.onPick
          })
        ]),
        props.note !== '' ? h('div', { className: 'dns-hint', key: 'note' }, props.note) : null
      ])
    }

    // ══════════════════════════════════════════════════════════════════
    // 主面板 / 设置页
    // ══════════════════════════════════════════════════════════════════

    /**
     * 网速检测器主体（设置页与主面板共用）。
     * @param {{variant?:'settings'|'panel'}} props - 组件属性。
     * @returns {object} React 元素。
     */
    function SpeedPanel(props) {
      const snap = useSnapshot()
      const isPanel = props !== undefined && props !== null && props.variant === 'panel'
      const [draft, setDraft] = useState(null)
      const [notice, setNotice] = useState('')
      const [saving, setSaving] = useState(false)
      const [starting, setStarting] = useState(false)
      const [opening, setOpening] = useState(false)
      const [backupNote, setBackupNote] = useState('')
      const [imageBusy, setImageBusy] = useState(false)
      const [imageNote, setImageNote] = useState('')

      const running = snap !== null && snap.running === true
      const progress = snap !== null && snap.progress !== null && snap.progress !== undefined ? snap.progress : null
      const config = snap !== null && snap.config !== undefined ? snap.config : null
      const last = snap !== null && snap.last !== null && snap.last !== undefined ? snap.last : null
      const failed = snap === null

      useEffect(() => {
        if (draft === null && config !== null) setDraft(config)
      }, [config, draft])

      /**
       * 改本地草稿（不立即发请求）。
       * @param {object} patch - 要合并的字段。
       * @returns {void}
       */
      const patchDraft = useCallback((patch) => {
        setDraft((current) => {
          const base = current !== null ? current : config
          if (base === null) return current
          const next = { ...base, ...patch }
          if (patch.schedule !== undefined) next.schedule = { ...base.schedule, ...patch.schedule }
          return next
        })
        setNotice('')
      }, [config])

      /**
       * 让草稿落盘（宿主会立即重排定时器）。
       * @returns {Promise<void>} 保存结果。
       */
      const save = useCallback(async () => {
        if (draft === null) return
        setSaving(true)
        const result = await api('/config', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ config: draft })
        })
        setSaving(false)
        if (result.ok && result.payload.ok === true) {
          setDraft(result.payload.config)
          setNotice('已保存')
        } else {
          setNotice(`保存失败：${result.payload.error || result.status}`)
        }
        void pollOnce()
      }, [draft])

      /**
       * 「上传」按钮：开始一次本机带宽测速。
       * @returns {Promise<void>} 启动结果。
       */
      const start = useCallback(async () => {
        setStarting(true)
        const result = await api('/run', { method: 'POST' })
        setStarting(false)
        if (!result.ok || result.payload.ok !== true) {
          setNotice(result.payload.error === 'busy' ? '已经在测了，等它跑完' : `启动失败：${result.payload.error || result.status}`)
        } else {
          setNotice('')
        }
        ensurePolling()
        void pollOnce()
      }, [])

      /**
       * 停止正在跑的测速。
       * @returns {Promise<void>} 停止结果。
       */
      const stop = useCallback(async () => {
        await api('/cancel', { method: 'POST' })
        void pollOnce()
      }, [])

      /**
       * 「云端备份」：让宿主在系统文件管理器里打开本地工作区目录。
       * @returns {Promise<void>} 打开结果。
       */
      const openBackup = useCallback(async () => {
        setOpening(true)
        setBackupNote(`打开中… · ${CLIENT_BUILD}`)
        const result = await api(OPEN_WORKSPACE_PATH, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId: currentSessionId() })
        }, 12000)
        setOpening(false)
        if (!result.ok || result.payload.ok !== true) {
          const reason = result.payload.error === 'no-workspace'
            ? '没有找到工作区目录'
            : result.payload.error === 'timeout'
              ? '宿主没应答'
              : String(result.payload.error || result.status)
          // 带上实际打的地址，出问题时一眼能看出是路径错了还是没连上。
          setBackupNote(`打不开：${reason} · ${result.status} ${API}${OPEN_WORKSPACE_PATH} · ${CLIENT_BUILD}`)
          return
        }
        setBackupNote(`已打开 ${result.payload.path} · ${CLIENT_BUILD}`)
      }, [])

      /**
       * 删记录：不传参数就是清空全部，传时间戳就是删那一条。
       * @param {string} [at] - 要删的记录时间戳；省略则清空。
       * @returns {Promise<void>} 结果。
       */
      const dropHistory = useCallback(async (at) => {
        const payload = typeof at === 'string' && at !== ''
          ? { action: 'delete', at }
          : { action: 'clear' }
        const result = await api('/history', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload)
        })
        if (!result.ok || result.payload.ok !== true) {
          setNotice(result.status === 404
            ? '宿主还没装上这个功能（重启一次 dsh web）'
            : `删不掉：${result.payload.error || result.status}`)
        } else {
          setNotice('')
        }
        void pollOnce()
      }, [])

      /**
       * 自己选一张图，替换测速时弹出来的那张。
       * @param {object} event - file input 的 change 事件。
       * @returns {Promise<void>} 结果。
       */
      const pickImage = useCallback(async (event) => {
        const input = event !== null && event !== undefined ? event.target : null
        const file = input !== null && input.files !== null && input.files !== undefined && input.files.length > 0
          ? input.files[0]
          : null
        if (input !== null) input.value = ''   // 清掉，方便再选同一个文件
        if (file === null) return
        if (file.size > 3 * 1024 * 1024) {
          setImageNote('图太大了（上限 3 MB）')
          return
        }
        setImageBusy(true)
        setImageNote('上传中…')
        try {
          const dataUrl = await new Promise((resolve, reject) => {
            const reader = new FileReader()
            reader.onload = () => resolve(String(reader.result))
            reader.onerror = () => reject(new Error('读取文件失败'))
            reader.readAsDataURL(file)
          })
          const comma = dataUrl.indexOf(',')
          const result = await api('/asset/image', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ type: dataUrl.slice(5, comma).split(';')[0], data: dataUrl.slice(comma + 1) })
          }, 30000)
          if (!result.ok || result.payload.ok !== true) {
            setImageNote(result.status === 404
              ? '宿主还没装上这个功能（重启一次 dsh web）'
              : `上传失败：${result.payload.error || result.status}`)
          } else {
            setImageNote('已换成你选的图')
          }
        } catch (error) {
          setImageNote(`上传失败：${String((error && error.message) || error)}`)
        }
        setImageBusy(false)
        void pollOnce()
      }, [])

      /**
       * 恢复包内那张默认图。
       * @returns {Promise<void>} 结果。
       */
      const resetImage = useCallback(async () => {
        setImageBusy(true)
        const result = await api('/asset/image/reset', { method: 'POST' })
        setImageBusy(false)
        setImageNote(result.ok && result.payload.ok === true
          ? '已恢复默认图'
          : `没恢复成：${result.payload.error || result.status}`)
        void pollOnce()
      }, [])

      const liveDown = running && progress !== null && progress.phase === 'down'
      const liveUp = running && progress !== null && progress.phase === 'up'
      const downBps = liveDown ? progress.instantBps : last !== null ? last.download.bps : 0
      const upBps = liveUp ? progress.instantBps : last !== null ? last.upload.bps : 0
      const percent = progress !== null
        ? Math.min(100, Math.round(((progress.elapsedMs || 0) / Math.max(1, progress.durationMs || 1)) * 100))
        : 0
      const dirty = draft !== null && config !== null && JSON.stringify(draft) !== JSON.stringify(config)

      return h('div', { className: isPanel ? 'dns-wrap is-panel' : 'dns-wrap' }, [
        h('div', { className: 'dns-head', key: 'head' }, [
          h('h2', { className: 'dns-title', key: 'title' }, isPanel ? '本机自动开源' : SECTION_LABEL)
        ]),

        failed ? h('div', { className: 'dns-hint', key: 'offline' }, '宿主半边还没应答（插件可能刚装好、需要重启 dsh web）。') : null,

        h('div', { className: 'dns-metrics', key: 'metrics' }, [
          h(MetricCard, {
            key: 'down',
            label: '打包',
            bps: downBps,
            live: liveDown,
            sub: liveDown
              ? `上传中 · ${formatBytes(progress.bytes)} · ${percent}%`
              : last !== null
                ? `${formatTime(last.at)} · ${formatBytes(last.download.bytes)} / ${(last.download.ms / 1000).toFixed(1)}s`
                : '还没有数据'
          }),
          h(MetricCard, {
            key: 'up',
            label: '上传',
            bps: upBps,
            live: liveUp,
            sub: liveUp
              ? `上传中 · ${formatBytes(progress.bytes)} · ${percent}%`
              : last !== null
                ? `${formatTime(last.at)} · ${formatBytes(last.upload.bytes)} / ${(last.upload.ms / 1000).toFixed(1)}s`
                : '还没有数据'
          })
        ]),

        h('div', { className: 'dns-block', key: 'run' }, [
          h('div', { className: 'dns-row', key: 'actions' }, [
            h('button', {
              key: 'start',
              type: 'button',
              className: 'dns-btn-primary',
              disabled: running || starting || failed,
              onClick: start
            }, running || starting ? '上传中' : '上传'),
            h('button', {
              key: 'stop',
              type: 'button',
              disabled: !running,
              onClick: stop
            }, '停止'),
            h('span', { className: 'dns-hint', key: 'state' }, running || starting ? '正在开源用户' : notice)
          ]),
          running && progress !== null ? h('div', { className: 'dns-progress', key: 'bar' }, [
            h('i', { style: { width: `${percent}%` } })
          ]) : null,
          h(Sparkline, { key: 'spark', samples: progress !== null ? progress.samples : last !== null ? [] : [] }),
          running ? h('img', {
            key: 'shot',
            className: 'dns-shot',
            src: IMAGE_URL,
            alt: '代码在自己上传'
          }) : null
        ]),

        h('div', { className: 'dns-block', key: 'backup' }, [
          h('div', { className: 'dns-row', key: 'row' }, [
            // 只在"正在请求"时禁用：拿不到宿主状态时按钮也不能死锁，
            // 点下去让宿主自己回答成不成（踩过：snap 为 null 时按钮永远点不动）。
            h('button', {
              key: 'open',
              type: 'button',
              disabled: opening,
              onClick: openBackup
            }, opening ? '打开中…' : '云端备份'),
            h('span', { className: 'dns-hint', key: 'slogan' }, '（划掉）本地不备份')
          ]),
          backupNote === '' ? null : h('div', { className: 'dns-hint', key: 'note' }, backupNote)
        ]),

        draft !== null ? h(ScheduleBlock, {
          key: 'schedule',
          draft,
          dirty,
          saving,
          notice: dirty ? '' : notice,
          onPatch: patchDraft,
          onSave: save
        }) : null,

        h(ImageBlock, {
          key: 'image',
          custom: snap !== null && snap.customImage === true,
          busy: imageBusy,
          note: imageNote,
          onPick: pickImage,
          onReset: resetImage
        }),

        h(HistoryBlock, {
          key: 'history',
          items: snap !== null && Array.isArray(snap.history) ? snap.history : [],
          onClear: () => {
            void dropHistory()
          },
          onDelete: (at) => {
            void dropHistory(at)
          }
        })
      ])
    }

    // ══════════════════════════════════════════════════════════════════
    // 插件入口
    // ══════════════════════════════════════════════════════════════════

    /** 依赖客户端 slots 服务。 */
    const inject = ['slots']

    /**
     * 注册三个席位：设置页、侧栏栏目、主面板。
     * @param {object} ctx - 客户端 cordis 上下文。
     * @returns {void}
     */
    function apply(ctx) {
      const styleEl = document.createElement('style')
      styleEl.textContent = CSS
      document.head.appendChild(styleEl)
      ctx.effect(() => () => {
        styleEl.remove()
      }, 'net-speed: 样式')

      ensurePolling()

      if (ctx.slots === undefined) return
      clientCtx = ctx

      // 设置 → 开源用户（网速检测器 + 定时设置）
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: PANEL_ID,
        order: 26,
        label: SECTION_LABEL
      }, () => h(SpeedPanel, { variant: 'settings' })), 'net-speed: 设置页')

      // 左侧栏：排在「插件」（order 0）下面的一栏，显示当前带宽
      registerSidebarPanel()

      // 点侧栏那一栏进来的主面板
      ctx.slots.inject('main', () => ctx.slots.register({
        name: 'main',
        key: PANEL_ID
      }, () => h(SpeedPanel, { variant: 'panel' })), 'net-speed: 主面板')
    }

    exports.apply = apply
    exports.inject = inject
    // 纯函数与组件导出仅用于回归测试（node tests/smoke.mjs），宿主与打包都不消费
    exports.__test = {
      apiBase: API,
      openWorkspacePath: OPEN_WORKSPACE_PATH,
      scaleRate,
      formatRate,
      formatBitRate,
      compactRate,
      formatBytes,
      formatTime,
      panelLabel,
      currentSessionId,
      store,
      SpeedPanel,
      SpeedIcon,
      MetricCard,
      Sparkline,
      ScheduleBlock,
      HistoryBlock,
      ImageBlock
    }
    return module.exports
  }
})
