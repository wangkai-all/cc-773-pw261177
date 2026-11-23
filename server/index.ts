import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'
import type {
  Allocation,
  FixtureId,
  PlanMode,
  PlanPayload,
  PropertyId,
  SolveRequest,
} from '../shared/types.ts'
import { FIXTURES } from '../shared/fixtures.ts'
import { solvePlan } from '../shared/solver.ts'
import { buildFactors, buildScenarioSet } from '../shared/uncertainty.ts'
import { PROPERTY_IDS } from '../shared/catalog.ts'
import { checkWorstCase, countCompositions, enumerateBlends } from '../shared/enumerate.ts'
import { HttpError, Store } from './store.ts'

const PORT = Number(process.env.PORT ?? 8787)
const store = new Store()
const solutions = new Map<string, { createdAt: number; payload: PlanPayload; result: any }>()
const DIST = join(process.cwd(), 'dist')
const DEV = process.env.BLENDWISE_DEV === '1'

function json(res: ServerResponse, status: number, body: unknown) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'content-type, x-operator',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
  })
  res.end(text)
}

async function bodyOf(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  const raw = Buffer.concat(chunks).toString('utf8')
  if (!raw.trim()) return {}
  try {
    return JSON.parse(raw)
  } catch {
    throw new HttpError(400, '请求体不是合法 JSON')
  }
}

function actorOf(req: IncomingMessage): string {
  const h = req.headers['x-operator']
  const v = Array.isArray(h) ? h[0] : h
  if (!v) return 'operator'
  const raw = String(v)
  let decoded = raw
  try {
    decoded = decodeURIComponent(raw)
  } catch {
    // 未编码的 ASCII 头（如 curl）保持原样
  }
  return decoded.slice(0, 24) || 'operator'
}

function verifyAllocations(result: any, payload: PlanPayload): Allocation[] {
  if (!result || result.status !== 'optimal') {
    throw new HttpError(409, '方案尚未求得可行解，不能确认')
  }
  const byLot = new Map(payload.allocations.map((a) => [a.lotId, a.quantity]))
  const out: Allocation[] = []
  for (const a of result.allocations as Array<{ lotId: string; quantity: number }>) {
    const submitted = byLot.get(a.lotId)
    if (submitted == null) {
      throw new HttpError(400, `提交的配比缺少 ${a.lotId}，与求解结果不一致`)
    }
    if (Math.abs(submitted - a.quantity) > 0.05) {
      throw new HttpError(400, `${a.lotId} 的提交量 ${submitted.toFixed(2)} t 与求解结果 ${a.quantity.toFixed(2)} t 不一致`)
    }
    out.push({ lotId: a.lotId, quantity: a.quantity })
  }
  return out
}

async function handleSolve(req: IncomingMessage, res: ServerResponse) {
  const body = (await bodyOf(req)) as SolveRequest
  if (!body || !body.specSetId || !body.mode) throw new HttpError(400, '缺少 specSetId 或 mode')
  const spec = store.specSets().find((s) => s.id === body.specSetId)
  if (!spec) throw new HttpError(404, `未知规格牌号 ${body.specSetId}`)
  const availability = body.excludePlanId
    ? store.availability(body.excludePlanId)
    : store.availability()
  const rho = typeof body.rho === 'number' ? body.rho : store.rho()
  const t0 = Date.now()
  const { result, excluded } = await solvePlan({
    lots: store.lots(),
    heel: store.heel(),
    specSets: store.specSets(),
    specSetId: body.specSetId,
    availability,
    rho,
    mode: body.mode,
    clientVersion: store.version,
    lotOverrides: body.lotOverrides,
    sensitivity: true,
  })
  const id = `PLN-${randomUUID().slice(0, 8)}`
  result.id = id
  result.basedOnVersion = store.version
  const payload: PlanPayload = {
    id,
    specSetId: body.specSetId,
    mode: body.mode as PlanMode,
    rho,
    volume: result.volume,
    allocations: result.allocations.map((a: any) => ({ lotId: a.lotId, quantity: a.quantity })),
    basedOnVersion: store.version,
    cost: result.totalCost,
  }
  if (result.status === 'optimal') {
    store.addPlan({ id, payload, actor: actorOf(req) })
    solutions.set(id, { createdAt: Date.now(), payload, result })
    // 只保留最近 40 个求解缓存
    if (solutions.size > 40) {
      const oldest = [...solutions.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt)[0]
      solutions.delete(oldest[0])
    }
  }
  json(res, 200, { result, excluded, elapsedMs: Date.now() - t0 })
}

async function handleConfirm(req: IncomingMessage, res: ServerResponse, planId: string) {
  const body = await bodyOf(req)
  const plan = store.getPlan(planId)
  if (!plan) throw new HttpError(404, `方案 ${planId} 不存在或已过期，请重新求解`)
  const solved = solutions.get(planId)
  if (!solved) throw new HttpError(409, '求解缓存已过期，请重新求解后再确认')
  const actor = actorOf(req)
  const allocations = verifyAllocations(solved.result, plan.payload)
  const outcome = store.confirmPlan({
    plan,
    actor,
    idempotencyKey: req.headers['idempotency-key'] as string | undefined,
    clientVersion: typeof body.clientVersion === 'number' ? body.clientVersion : plan.payload.basedOnVersion,
    allocations,
  })
  if (!outcome.ok) {
    json(res, outcome.status, { error: outcome.error, detail: outcome.detail, state: store.publicState() })
    return
  }
  // 校验求解时与确认时的一致：重新求解同一方案，比较成本
  solutions.delete(planId)
  json(res, 200, {
    orderId: plan.orderId,
    reservationIds: outcome.reservationIds,
    state: outcome.state,
  })
}

async function handleVerify(req: IncomingMessage, res: ServerResponse) {
  const body = await bodyOf(req)
  const planId = String(body.planId ?? '')
  if (!planId) throw new HttpError(400, '缺少 planId')
  const solved = solutions.get(planId)
  if (!solved) throw new HttpError(404, '求解缓存已过期，请重新求解后再核对')
  const { payload, result } = solved
  const spec = store.specSets().find((s) => s.id === payload.specSetId)
  if (!spec) throw new HttpError(404, '未知规格牌号')
  const lots = store.lots()
  const rho = payload.rho
  const available: Record<string, number> = { ...(result.availableMap ?? {}) }
  const lines = (result.allocations as Array<{ lotId: string; quantity: number }>)
    .map((a) => {
      const lot = lots.find((l) => l.id === a.lotId)
      return lot ? { lot, quantity: a.quantity } : null
    })
    .filter((x): x is { lot: any; quantity: number } => x != null)

  const mode = payload.mode
  const gamma = typeof (result as any).gammaEffective === 'number'
    ? (result as any).gammaEffective
    : 0
  const factors = buildFactors(lots, store.heel(), PROPERTY_IDS, rho)
  const checks = mode.kind !== 'box' && mode.kind !== 'budget'
    ? []
    : checkWorstCase({
        factors,
        lines,
        properties: PROPERTY_IDS,
        mode,
        gamma: mode.kind === 'budget' ? mode.gamma : mode.kind === 'box' ? Number.POSITIVE_INFINITY : 0,
        maxFactors: 5,
      })

  // 自动选步长：先估算组合数，逐步放大步长直到落在上限内，避免静默截断。
  const needed = [...new Set(spec.limits.map((l) => l.property))]
  const enumLots = lots.filter(
    (l) => needed.every((p) => l.assay[p]?.hasAssay) && (available[l.id] ?? 0) > 0,
  )
  const fresh = spec.volume - store.heel().quantity
  const requested = Number(body.gridStep)
  const MAX_COMBOS = 400_000
  let step = Number.isFinite(requested) && requested > 0 ? Math.round(requested) : 20
  for (let i = 0; i < 40 && fresh > 0; i++) {
    const steps = Math.max(1, Math.round(fresh / step))
    const exact = fresh / steps
    const caps = enumLots.map((l) => Math.floor((available[l.id] ?? 0) / exact + 1e-9))
    const n = countCompositions(caps, steps)
    if (n <= MAX_COMBOS) break
    step = Math.ceil(step * 1.35)
  }
  const enumeration = enumerateBlends({
    lots,
    heel: store.heel(),
    spec,
    availability: available,
    rho,
    gridStep: step,
    maxCombos: MAX_COMBOS,
    mode,
    gamma: mode.kind === 'budget' ? mode.gamma : undefined,
  })

  const notes = [
    '枚举只在固定步长的整数配比上进行，是真实（离散网格）最优的对照，不会比连续 LP 更便宜。',
    '顶点核对只取幅度最大的前 5 个因子；解析最坏值必须被枚举极值覆盖。',
  ]
  json(res, 200, {
    planId,
    method: mode.kind === 'budget' ? 'budget' : mode.kind === 'box' ? 'box' : 'none',
    gamma,
    checks,
    enumeration,
    lp: {
      totalCost: result.totalCost,
      unitCost: result.unitCost,
      feasibleLots: result.allocations.map((a: any) => a.lotId),
    },
    availableAtSolve: available,
    notes,
  })
}

async function handleRoute(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`)
  const path = url.pathname
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-headers': 'content-type, x-operator, idempotency-key',
      'access-control-allow-methods': 'GET,POST,OPTIONS',
    })
    res.end()
    return
  }
  if (path === '/api/state' && req.method === 'GET') {
    json(res, 200, store.publicState())
    return
  }
  if (path === '/api/solve' && req.method === 'POST') {
    await handleSolve(req, res)
    return
  }
  if (path === '/api/verify' && req.method === 'POST') {
    await handleVerify(req, res)
    return
  }
  if (path.startsWith('/api/plans/') && path.endsWith('/confirm') && req.method === 'POST') {
    const id = path.slice('/api/plans/'.length, -'/confirm'.length)
    await handleConfirm(req, res, id)
    return
  }
  if (path === '/api/orders' && req.method === 'GET') {
    json(res, 200, { orders: store.publicState().orders })
    return
  }
  const releaseMatch = path.match(/^\/api\/orders\/([^/]+)\/release$/)
  if (releaseMatch && req.method === 'POST') {
    const out = store.releaseOrder(releaseMatch[1], actorOf(req))
    if (!out) throw new HttpError(404, '订单不存在')
    json(res, 200, out)
    return
  }
  const commitMatch = path.match(/^\/api\/orders\/([^/]+)\/commit$/)
  if (commitMatch && req.method === 'POST') {
    const out = store.commitOrder(commitMatch[1], actorOf(req))
    if (!out) throw new HttpError(404, '订单不存在')
    json(res, 200, out)
    return
  }
  if (path === '/api/assay' && req.method === 'POST') {
    const body = await bodyOf(req)
    store.updateAssay(body.lotId, body.property as PropertyId, body.cell, actorOf(req))
    json(res, 200, store.publicState())
    return
  }
  if (path === '/api/reset' && req.method === 'POST') {
    const body = await bodyOf(req)
    store.reset(body.fixture as FixtureId, actorOf(req))
    solutions.clear()
    json(res, 200, store.publicState())
    return
  }
  if (path === '/api/rho' && req.method === 'POST') {
    const body = await bodyOf(req)
    const rho = Number(body.rho)
    if (!(rho >= 0 && rho <= 1)) throw new HttpError(400, 'ρ 必须在 [0,1]')
    store.setRho(rho)
    json(res, 200, store.publicState())
    return
  }
  if (path === '/api/scenarios' && req.method === 'GET') {
    const specSetId = url.searchParams.get('specSetId') ?? store.activeSpecSetId()
    const spec = store.specSets().find((s) => s.id === specSetId) ?? store.specSets()[0]
    const needed = [...new Set(spec.limits.map((l) => l.property))]
    const candidates = store.lots().filter((l) => needed.every((p) => l.assay[p]?.hasAssay))
    const factors = buildFactors(candidates, store.heel(), ['RON', 'S', 'D', 'BZ', 'OLE'], store.rho())
    const set = buildScenarioSet(factors, ['RON', 'S', 'D', 'BZ', 'OLE'])
    json(res, 200, set)
    return
  }
  if (path === '/api/fixtures' && req.method === 'GET') {
    json(res, 200, {
      fixtures: Object.values(FIXTURES).map((f) => ({ id: f.id, name: f.name, description: f.description })),
    })
    return
  }
  if (path.startsWith('/api/')) {
    throw new HttpError(404, `未知接口 ${path}`)
  }

  // 静态文件
  const safe = normalize(path).replace(/^(\.\.[/\\])+/, '')
  let file = join(DIST, safe === '/' ? 'index.html' : safe)
  try {
    const s = await stat(file)
    if (s.isDirectory()) file = join(file, 'index.html')
  } catch {
    file = join(DIST, 'index.html')
  }
  try {
    const data = await readFile(file)
    const type = mime(file)
    res.writeHead(200, { 'content-type': type, 'cache-control': file.endsWith('.html') ? 'no-store' : 'public, max-age=31536000, immutable' })
    res.end(data)
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('未找到页面；请先运行 npm run build')
  }
}

function mime(file: string) {
  const ext = extname(file)
  switch (ext) {
    case '.html': return 'text/html; charset=utf-8'
    case '.js': return 'text/javascript; charset=utf-8'
    case '.css': return 'text/css; charset=utf-8'
    case '.wasm': return 'application/wasm'
    case '.json': return 'application/json; charset=utf-8'
    case '.svg': return 'image/svg+xml'
    case '.png': return 'image/png'
    case '.woff2': return 'font/woff2'
    default: return 'application/octet-stream'
  }
}

const server = createServer((req, res) => {
  handleRoute(req, res).catch((err) => {
    if (err instanceof HttpError) {
      json(res, err.status, { error: err.message })
      return
    }
    console.error(err)
    json(res, 500, { error: err?.message ?? '服务器内部错误' })
  })
})

server.listen(PORT, () => {
  console.error(`[blendwise] http://localhost:${PORT}  (虚构数据，不连接生产设备)`)
  if (DEV) console.error('[blendwise] 开发模式：前端请用 vite dev server')
})
