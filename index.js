/**
 * dsh-acp-orphan-adopter — 把「未分组（Ungrouped）」的孤儿会话归回工作区。
 *
 * 背景：ACP（PyCharm 等编辑器）用 `session.create({ cwd })` 建会话，这个入口只
 * 记录工作目录、**不登记工作区归属**（设计如此：会话可以只拥有目录、不加入项目）。
 * 于是这些会话在 GUI 侧栏落进「未分组」。dsh-workspace 自己的 `bootstrap()` 只在
 * 注册表**首次**初始化时按 cwd 归组一次，之后再产生的孤儿就一直挂着。
 *
 * 本插件补上这段收尾：在注册表所在进程（desktop profile）里定期扫描已持久化的
 * 会话头，把「没有归属、有可解析 cwd、且未被归档」的会话挂到该 cwd 的工作区
 * （工作区不存在就按 cwd 新建——`create()` 对同一规范路径是幂等的，不会重复建）。
 *
 * 安全性：
 * - 只做归属（workspace 记录 + sessionIds），**不移动、不改写、不删除任何会话文件**；
 * - 只碰「完全没有归属」的会话，已在任何工作区下的会话一律跳过；
 * - 归档会话跳过；cwd 缺失/失效的会话跳过并记日志，保持原样；
 * - 目录不存在时 `create()` 会抛错，此处捕获后仅告警，不重试写坏状态；
 * - 重名不会覆盖：同一规范路径只会复用既有工作区。
 *
 * 配置见 ./cordis.patch.yml（enabled / startupDelayMs / intervalMs / dryRun / onlyUnder / log）。
 *
 * @module index.js
 */

/** 稳定插件名。 */
export const name = 'acp-orphan-adopter'

/** 只依赖工作区注册表；缺它就什么都不做（例如 acp profile 里本来就没有工作区概念）。 */
export const inject = ['workspaceRegistry']

const DEFAULTS = {
  /** 总开关。 */
  enabled: true,
  /** 启动后第一次扫描的延迟（毫秒），给注册表 bootstrap 留出时间。 */
  startupDelayMs: 8000,
  /** 两次扫描的间隔（毫秒）；<= 0 表示只扫一次（启动那次）。 */
  intervalMs: 60000,
  /** 只报告不写入，用于先看一眼会影响哪些会话。 */
  dryRun: false,
  /** 可选白名单：只归入 cwd 以这些前缀开头的会话（空数组 = 不限制）。 */
  onlyUnder: [],
  /** 是否在每次真的归入了会话时打 info 日志。 */
  log: true
}

/**
 * 挂载插件。
 * @param ctx - 插件上下文。
 * @param config - 来自 cordis.patch.yml 的配置。
 */
export function apply(ctx, config) {
  const opts = { ...DEFAULTS, ...(config ?? {}) }
  if (!opts.enabled) return

  const registry = ctx.workspaceRegistry
  const log = ctx.logger ?? console
  const warn = (message) => {
    if (typeof log.warn === 'function') log.warn(message)
  }

  let running = false
  let stopped = false

  /**
   * 扫一遍并把孤儿会话挂进工作区。
   * @param trigger - 触发来源（startup/interval/manual），只用于日志。
   * @returns 本次结果摘要。
   */
  async function adoptOnce(trigger = 'manual') {
    if (stopped) return { skipped: 'stopped' }
    if (running) return { skipped: 'already-running' }
    running = true
    try {
      const headers = await registry.listStoredHeaders()
      const attached = new Set()
      for (const workspace of registry.list()) {
        for (const sessionId of workspace.sessionIds) attached.add(sessionId)
      }
      const archived = new Set(registry.archivedSessionIds ?? [])
      const prefixes = Array.isArray(opts.onlyUnder) ? opts.onlyUnder.filter((p) => typeof p === 'string' && p.length > 0) : []

      const adopted = []
      const failed = []
      for (const header of headers) {
        if (header === null || typeof header !== 'object') continue
        const sessionId = header.id
        if (typeof sessionId !== 'string' || sessionId.length === 0) continue
        if (attached.has(sessionId) || archived.has(sessionId)) continue
        const cwd = header.cwd
        if (typeof cwd !== 'string' || cwd.length === 0) continue
        if (prefixes.length > 0 && !prefixes.some((prefix) => cwd.toLowerCase().startsWith(prefix.toLowerCase()))) continue

        if (opts.dryRun) {
          adopted.push({ sessionId, cwd, dryRun: true })
          continue
        }
        try {
          const workspace = await registry.create(cwd)
          await workspace.attachSession(sessionId)
          adopted.push({ sessionId, cwd, workspaceId: workspace.id })
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error)
          failed.push({ sessionId, cwd, reason })
          warn(`[acp-orphan-adopter] 归入失败 session=${sessionId} cwd=${cwd}：${reason}`)
        }
      }

      if (adopted.length > 0 && opts.log) {
        const verb = opts.dryRun ? '试运行：可归入' : '已归入'
        const info = typeof log.info === 'function' ? log.info.bind(log) : undefined
        info?.(`[acp-orphan-adopter] ${trigger} ${verb} ${adopted.length} 个会话（库内共 ${headers.length} 个，原本已归属 ${attached.size} 个）`)
        for (const item of adopted) info?.(`  · ${item.sessionId} → ${item.workspaceId ?? item.cwd}`)
      }
      return { trigger, adopted, failed, storedCount: headers.length, attachedCount: attached.size }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      warn(`[acp-orphan-adopter] 扫描失败：${reason}`)
      return { error: reason }
    } finally {
      running = false
    }
  }

  const timers = []
  const schedule = (fn, ms) => {
    const handle = setTimeout(fn, ms)
    if (typeof handle?.unref === 'function') handle.unref()
    timers.push(handle)
    return handle
  }

  schedule(() => {
    void adoptOnce('startup')
    if (opts.intervalMs > 0) {
      const handle = setInterval(() => {
        void adoptOnce('interval')
      }, opts.intervalMs)
      if (typeof handle?.unref === 'function') handle.unref()
      timers.push(handle)
    }
  }, Math.max(0, opts.startupDelayMs))

  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => {
      stopped = true
      for (const handle of timers) clearTimeout(handle)
    }, 'acp-orphan-adopter.timers')
  }

  // 手动触发口：便于在 console/其他插件里立刻跑一次，不必等定时器。
  if (typeof ctx.provide === 'function') {
    ctx.provide('acpOrphanAdopter', { adoptOnce })
  }
}