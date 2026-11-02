/**
 * Host half: actual Platform-billed CNY cost, attributed to local Sessions.
 *
 * The Platform usage endpoint reports settled cost per API key, model and hour.
 * DSH's Session logs provide the hourly token weight and search-call count for
 * every Session, so each hour's actual cost can be split across the Sessions
 * active in that hour. A single active Session gets the exact hourly charge.
 * No price table, credential, or private billing field reaches the browser.
 */

const ROUTE = '/plugins/dsh-spend/state'
const HOUR_MS = 3_600_000
const DAY_MS = 86_400_000
const TZ_MS = 8 * HOUR_MS
const TTL = 30_000
const BALANCE_TTL = 60_000
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

/** Relative weights only; the Platform's own cost is authoritative. */
const WEIGHT = {
  flash: { miss: 2.0, hit: 0.04, output: 8.0 },
  pro: { miss: 9.0, hit: 0.30, output: 27.0 },
}
const ALIASES = {
  'deepseek-v4-flash': 'deepseek-flash',
  'deepseek-v4-flash-vision-exp': 'deepseek-flash',
  'deepseek-chat': 'deepseek-flash',
  'deepseek-reasoner': 'deepseek-v4-pro',
}

/** @type {Map<string, { next: number, inherited: number, hours: Map<number, { weight: number, weights: Map<string, number>, searches: number }>, updatedAt: number }>} */
const sessions = new Map()
/** @type {Map<number, { at: number, final: boolean, models: Map<string, Map<number, number>>, functions: Map<number, number> }>} */
const days = new Map()
const balance = { value: null, at: 0, inflight: null }
const platform = { token: null }

const hourOf = (time) => Math.floor(Number(time) / HOUR_MS) * HOUR_MS
const dayOf = (time) => Math.floor((Number(time) + TZ_MS) / DAY_MS) * DAY_MS - TZ_MS
const modelKey = (model) => {
  const key = String(model ?? '').trim().toLowerCase()
  return ALIASES[key] ?? (key || 'deepseek-flash')
}
const rates = (model) => (/pro|reasoner/i.test(modelKey(model)) ? WEIGHT.pro : WEIGHT.flash)
const emptyEntry = (inherited) => ({ next: inherited, inherited, hours: new Map(), updatedAt: 0, title: undefined })

function hourEntry(entry, time) {
  const hour = hourOf(time ?? Date.now())
  let value = entry.hours.get(hour)
  if (value === undefined) {
    value = { weight: 0, weights: new Map(), searches: 0 }
    entry.hours.set(hour, value)
  }
  return value
}

function addEvent(entry, event) {
  const time = event.time ?? Date.now()
  if (event.type === 'request/header') {
    const model = event.data?.header?.config?.model
    if (typeof model === 'string') entry.model = model
    return
  }
  if (event.type === 'session/title') {
    const title = event.data?.title
    if (typeof title === 'string' && title.trim().length > 0) entry.title = title.trim()
    return
  }
  if (event.type === 'assistant/attempt' || event.type === 'session/title-llm-request') {
    hourEntry(entry, time)
    return
  }
  if (event.type === 'web/deepseek-search-llm-request') {
    hourEntry(entry, time).searches += 1
    return
  }
  if (event.type !== 'assistant/message' && event.type !== 'compaction/summary') return
  const usage = event.data?.usage
  if (usage === undefined || usage === null) return
  const model = event.data?.message?.source?.model ?? event.data?.model ?? entry.model
  const table = rates(model)
  const miss = Math.max(0, Number(usage.inputTokens ?? 0) || 0)
  const hit = Math.max(0, Number(usage.cacheReadTokens ?? 0) + Number(usage.cacheWriteTokens ?? 0) || 0)
  const output = Math.max(0, Number(usage.outputTokens ?? 0) || 0)
  const weight = miss * table.miss + hit * table.hit + output * table.output
  const hour = hourEntry(entry, time)
  const key = modelKey(model)
  hour.weight += weight
  hour.weights.set(key, (hour.weights.get(key) ?? 0) + weight)
  if (typeof model === 'string') entry.model = model
}

function fold(events, inherited) {
  const entry = emptyEntry(inherited)
  for (const event of events ?? []) {
    if (event.seq < inherited) continue
    addEvent(entry, event)
    if (typeof event.seq === 'number' && event.seq >= entry.next) entry.next = event.seq + 1
  }
  return entry
}

async function scan(ctx, summary, signal) {
  const id = summary.sessionId
  const cached = sessions.get(id)
  const live = ctx.get('sessions')?.get?.(id)

  if (live !== undefined && typeof live.snapshotEvents === 'function') {
    const inherited = Number(live.inheritedEventCount ?? 0)
    const entry =
      cached !== undefined && cached.inherited === inherited && cached.next >= inherited && cached.next <= live.seq
        ? cached
        : emptyEntry(inherited)
    const from = Math.max(entry.next, inherited)
    for (const event of live.snapshotEvents(from, live.seq)) addEvent(entry, event)
    entry.next = live.seq
    entry.updatedAt = summary.updatedAt ?? entry.updatedAt
    sessions.set(id, entry)
    return entry
  }

  if (cached !== undefined && cached.updatedAt === summary.updatedAt) return cached

  const inspected = await ctx.get('sessionController')?.inspect?.(id, signal)
  const entry = fold(inspected?.events, Number(inspected?.inheritedEventCount ?? 0))
  entry.updatedAt = summary.updatedAt ?? 0
  sessions.set(id, entry)
  return entry
}

async function readPlatform(ctx) {
  let session = null
  try {
    session = await ctx.get('deepseekAccount')?.getPlatformSession?.()
  } catch {
    session = null
  }
  const token = session?.token ?? null
  if (platform.token !== token) {
    platform.token = token
    days.clear()
    balance.value = null
    balance.at = 0
  }
  return session
}

async function fetchDay(ctx, day, session) {
  const cached = days.get(day)
  if (cached !== undefined && (cached.final || Date.now() - cached.at < TTL)) {
    if (cached.error !== undefined) throw cached.error
    return cached
  }

  try {
    if (session === null || session === undefined) throw new Error('not signed in')
    const response = await fetch(
      `${session.origin}/api/v0/usage/by_api_key/cost?start=${Math.round(day / 1000)}&end=${Math.round(day / 1000) + 86_400}&tz=28800`,
      {
        headers: {
          accept: 'application/json',
          'x-dsh-auth-token': session.token,
          'x-client-platform': 'web',
          'x-client-bundle-id': '',
          'x-client-version': 'dsh-spend/1.0.0',
          'x-client-locale': 'zh_CN',
          'x-client-timezone-offset': '28800',
          ...(session.requestHeaders ?? {}),
        },
        redirect: 'error',
        signal: AbortSignal.timeout(20_000),
      },
    )
    if (!response.ok) throw new Error('cost endpoint responded ' + response.status)
    const payload = await response.json()
    if (payload?.code !== 0 || payload?.data?.biz_code !== 0) throw new Error('cost endpoint rejected')
    if (payload.data.biz_data?.bucket !== undefined && payload.data.biz_data.bucket !== 3_600) {
      throw new Error('unexpected cost bucket')
    }
    const groups = payload.data.biz_data?.data ?? []
    const group = groups.find((item) => item.currency === 'CNY') ?? groups[0]
    const models = new Map()
    const functions = new Map()
    const add = (map, bucket) => {
      const hour = Number(bucket.time) * 1000
      map.set(hour, (map.get(hour) ?? 0) + (Number(bucket.cost) || 0))
    }
    for (const series of group?.series ?? []) {
      if (series.api_key?.key_type !== undefined && series.api_key.key_type !== 'DSH') continue
      const key = modelKey(series.model)
      let buckets = models.get(key)
      if (buckets === undefined) {
        buckets = new Map()
        models.set(key, buckets)
      }
      for (const bucket of series.buckets ?? []) add(buckets, bucket)
    }
    for (const series of group?.function_series ?? []) {
      if (series.api_key?.key_type !== undefined && series.api_key.key_type !== 'DSH') continue
      for (const bucket of series.buckets ?? []) add(functions, bucket)
    }
    const value = { at: Date.now(), final: day + DAY_MS < Date.now() - 5 * 60_000, models, functions }
    days.set(day, value)
    return value
  } catch (error) {
    days.set(day, { at: Date.now(), final: false, models: new Map(), functions: new Map(), error })
    throw error
  }
}

async function snapshot(ctx) {
  const platformSession = await readPlatform(ctx)
  const controller = ctx.get('sessionController')
  if (controller === undefined || typeof controller.list !== 'function') {
    return { ok: true, generatedAt: Date.now(), balance: await readBalance(ctx), sessions: {}, workspaces: {} }
  }
  const signal = AbortSignal.timeout(20_000)
  const summaries = (await controller.list({}, signal)).items.filter((item) => item.blank !== true)
  const entries = await Promise.all(
    summaries.map((summary) => scan(ctx, summary, signal).catch(() => undefined)),
  )
  const rows = summaries.map((summary, index) => ({ summary, entry: entries[index] })).filter((row) => row.entry !== undefined)

  const dayStarts = new Set()
  for (const row of rows) for (const hour of row.entry.hours.keys()) dayStarts.add(dayOf(hour))

  const failedDays = new Set()
  const modelHours = new Map()
  const functionHours = new Map()
  if (dayStarts.size > 0) {
    const results = await Promise.all(
      [...dayStarts].map((day) =>
        fetchDay(ctx, day, platformSession)
          .then((value) => ({ day, value }))
          .catch(() => ({ day, error: true })),
      ),
    )
    for (const result of results) {
      if (result.error) {
        failedDays.add(result.day)
        continue
      }
      for (const [model, buckets] of result.value.models) {
        let target = modelHours.get(model)
        if (target === undefined) {
          target = new Map()
          modelHours.set(model, target)
        }
        for (const [hour, cost] of buckets) target.set(hour, (target.get(hour) ?? 0) + cost)
      }
      for (const [hour, cost] of result.value.functions) {
        functionHours.set(hour, (functionHours.get(hour) ?? 0) + cost)
      }
    }
  }

  const total = new Map()
  for (const [model, buckets] of modelHours) {
    for (const [hour, cost] of buckets) {
      const active = rows.filter((row) => row.entry.hours.get(hour)?.weights.has(model))
      const pool = active.length > 0 ? active : rows.filter((row) => row.entry.hours.has(hour))
      if (pool.length === 0) continue
      const byModel = active.length > 0
      const weight = pool.reduce((sum, row) => {
        const item = row.entry.hours.get(hour)
        return sum + (byModel ? item.weights.get(model) ?? 0 : item.weight)
      }, 0)
      for (const row of pool) {
        const item = row.entry.hours.get(hour)
        const own = byModel ? item.weights.get(model) ?? 0 : item.weight
        const share = weight > 0 ? own / weight : 1 / pool.length
        total.set(row.summary.sessionId, (total.get(row.summary.sessionId) ?? 0) + cost * share)
      }
    }
  }

  for (const [hour, cost] of functionHours) {
    const active = rows.filter((row) => row.entry.hours.has(hour))
    if (active.length === 0) continue
    const searches = active.reduce((sum, row) => sum + row.entry.hours.get(hour).searches, 0)
    for (const row of active) {
      const item = row.entry.hours.get(hour)
      const share = searches > 0 ? item.searches / searches : 1 / active.length
      total.set(row.summary.sessionId, (total.get(row.summary.sessionId) ?? 0) + cost * share)
    }
  }

  const titles = new Map(
    (ctx.get('workspaceRegistry')?.list?.() ?? []).map((workspace) => [workspace.path, workspace.title]),
  )
  const sessionMap = {}
  const workspaceMap = {}
  for (const row of rows) {
    const summary = row.summary
    const cwd = typeof summary.cwd === 'string' ? summary.cwd : ''
    const unavailable = [...row.entry.hours.keys()].some((hour) => failedDays.has(dayOf(hour)))
    const cost = unavailable ? null : total.get(summary.sessionId) ?? 0
    const projectedTitle = summary.projections?.values?.title
    const title = row.entry.title ?? (typeof projectedTitle === 'string' ? projectedTitle : undefined)
    sessionMap[summary.sessionId] = {
      cost,
      cwd,
      updatedAt: summary.updatedAt,
      visible: summary.origin !== 'subagent',
      title,
    }
    if (cwd !== '') {
      const workspace = workspaceMap[cwd] ?? (workspaceMap[cwd] = { cost: 0, title: titles.get(cwd) })
      workspace.cost = workspace.cost === null || cost === null ? null : workspace.cost + cost
    }
  }

  return { ok: true, generatedAt: Date.now(), balance: await readBalance(ctx), sessions: sessionMap, workspaces: workspaceMap }
}

async function readBalance(ctx) {
  if (balance.value !== null && Date.now() - balance.at < BALANCE_TTL) return balance.value
  if (balance.inflight !== null) return balance.inflight
  balance.inflight = (async () => {
    try {
      const account = ctx.get('deepseekAccount')
      const view = await account?.getBalance?.({
        version: 'dsh-spend/1.0.0',
        locale: 'zh_CN',
        timezoneOffsetSeconds: 28_800,
      })
      if (view?.status !== 'ready') return balance.value
      const wallets = [...(view.value ?? []), ...(view.bonusWallets ?? [])].filter((wallet) => wallet?.currency === 'CNY')
      if (wallets.length === 0) return balance.value
      const cents = wallets.reduce((sum, wallet) => sum + Math.round(Number(wallet.balance) * 100), 0)
      balance.value = (cents / 100).toFixed(2)
      balance.at = Date.now()
      return balance.value
    } catch {
      return balance.value
    } finally {
      if (balance.value === null) balance.at = Date.now()
      balance.inflight = null
    }
  })()
  return balance.inflight
}

const isLoopback = (req) => LOOPBACK.has(req.socket?.remoteAddress) || req.socket?.remoteAddress === undefined

const sendJson = (res, status, body) => {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  })
  res.end(text)
}

export const inject = ['webServer']

export function apply(ctx) {
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: ROUTE,
        async handler(req, res) {
          if (req.method !== 'GET') {
            res.writeHead(405, { allow: 'GET' })
            res.end()
            return
          }
          if (!isLoopback(req)) {
            sendJson(res, 403, { ok: false })
            return
          }
          let rejection
          try {
            rejection = ctx.get('connection')?.requestRejection?.({ headers: req.headers })
          } catch {
            rejection = 403
          }
          if (rejection !== undefined) {
            sendJson(res, rejection, { ok: false })
            return
          }
          try {
            sendJson(res, 200, await snapshot(ctx))
          } catch {
            sendJson(res, 500, { ok: false })
          }
        },
      }),
    'dsh-spend: state',
  )
}
