import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type {
  Allocation,
  AvailabilityRow,
  FixtureId,
  Lot,
  Order,
  PlanPayload,
  PublicState,
  Reservation,
  SpecSet,
} from '../shared/types.ts'
import { BASE_FIXTURE, FIXTURES } from '../shared/fixtures.ts'
import { RHO_DEFAULT } from '../shared/uncertainty.ts'

export interface StoredPlan {
  id: string
  payload: PlanPayload
  createdAt: string
  actor: string
  /** 确认成功后写入订单；草稿方案的 allocations 只是引用 */
  status: 'draft' | 'ordered'
  orderId?: string
}

export interface PersistedState {
  version: number
  fixtureId: FixtureId
  rho: number
  activeSpecSetId: string
  lots: Lot[]
  heel: typeof BASE_FIXTURE.heel
  specSets: SpecSet[]
  reservations: Reservation[]
  orders: Order[]
  plans: StoredPlan[]
  audit: Array<{ at: string; actor: string; action: string; detail: string }>
  /** 幂等键 -> 结果 */
  idempotency: Record<string, { reservationIds: string[]; at: string }>
}

/** 数据文件路径在每次构造 Store 时解析，测试可切换目录。 */
function dataFile(): string {
  const dir = process.env.BLENDWISE_DATA ?? join(process.cwd(), '.data')
  return join(dir, 'state.json')
}

function initialState(fixtureId: FixtureId = 'BASE'): PersistedState {
  const fixture = FIXTURES[fixtureId] ?? BASE_FIXTURE
  return {
    version: 1,
    fixtureId,
    rho: RHO_DEFAULT,
    activeSpecSetId: fixture.specSets[0].id,
    lots: JSON.parse(JSON.stringify(fixture.lots)),
    heel: JSON.parse(JSON.stringify(fixture.heel)),
    specSets: JSON.parse(JSON.stringify(fixture.specSets)),
    reservations: [],
    orders: [],
    plans: [],
    audit: [
      {
        at: new Date().toISOString(),
        actor: 'system',
        action: 'init',
        detail: `载入虚构罐区「${fixture.name}」`,
      },
    ],
    idempotency: {},
  }
}

export class Store {
  private state: PersistedState

  constructor() {
    this.state = this.load()
  }

  private load(): PersistedState {
    const file = dataFile()
    if (existsSync(file)) {
      try {
        const raw = JSON.parse(readFileSync(file, 'utf8')) as PersistedState
        if (raw && Array.isArray(raw.lots)) return raw
      } catch {
        // 损坏则回到初始状态
      }
    }
    return initialState()
  }

  private persist() {
    const file = dataFile()
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify(this.state, null, 2))
  }

  get version() {
    return this.state.version
  }

  private bump() {
    this.state.version += 1
  }

  audit(actor: string, action: string, detail: string) {
    this.state.audit.unshift({ at: new Date().toISOString(), actor, action, detail })
    if (this.state.audit.length > 200) this.state.audit.length = 200
  }

  availability(excludePlanId?: string): Record<string, number> {
    const used = new Map<string, number>()
    for (const r of this.state.reservations) {
      if (r.status !== 'active') continue
      if (excludePlanId && r.planId === excludePlanId) continue
      used.set(r.lotId, (used.get(r.lotId) ?? 0) + r.quantity)
    }
    const out: Record<string, number> = {}
    for (const lot of this.state.lots) {
      out[lot.id] = Math.max(0, lot.quantity - (used.get(lot.id) ?? 0))
    }
    return out
  }

  availabilityRows(): AvailabilityRow[] {
    const used = new Map<string, number>()
    const committed = new Map<string, number>()
    for (const r of this.state.reservations) {
      if (r.status === 'active') used.set(r.lotId, (used.get(r.lotId) ?? 0) + r.quantity)
      if (r.status === 'committed') committed.set(r.lotId, (committed.get(r.lotId) ?? 0) + r.quantity)
    }
    return this.state.lots.map((lot) => {
      const reserved = used.get(lot.id) ?? 0
      const com = committed.get(lot.id) ?? 0
      return {
        lotId: lot.id,
        quantity: lot.quantity,
        committed: com,
        reserved,
        available: Math.max(0, lot.quantity - reserved - com),
      }
    })
  }

  publicState(): PublicState {
    return {
      version: this.state.version,
      lots: this.state.lots,
      heel: this.state.heel,
      specSets: this.state.specSets,
      activeSpecSetId: this.state.activeSpecSetId,
      rho: this.state.rho,
      reservations: this.state.reservations,
      orders: this.state.orders,
      availability: this.availabilityRows(),
      audit: this.state.audit.slice(0, 40),
      fixture: this.state.fixtureId,
    }
  }

  rho() {
    return this.state.rho
  }

  setRho(rho: number) {
    // ρ 只是建模参数，不改变库存；方案确认的版本基线不应因此失效。
    this.state.rho = rho
    this.audit('operator', 'rho', `同批共同偏移份额 ρ 调整为 ${rho.toFixed(2)}`)
    this.persist()
  }

  specSets() {
    return this.state.specSets
  }

  lots() {
    return this.state.lots
  }

  heel() {
    return this.state.heel
  }

  activeSpecSetId() {
    return this.state.activeSpecSetId
  }

  setActiveSpecSet(id: string) {
    this.state.activeSpecSetId = id
    this.bump()
    this.persist()
  }

  updateAssay(
    lotId: string,
    property: string,
    cell: { nominal: number; halfWidth: number; hasAssay: boolean },
    actor: string,
  ) {
    const lot = this.state.lots.find((l) => l.id === lotId)
    if (!lot) throw new HttpError(404, `原料 ${lotId} 不存在`)
    lot.assay[property as keyof typeof lot.assay] = { ...cell }
    this.bump()
    this.audit(actor, 'assay', `${lotId} 的 ${property} 检测区间改为 ${cell.nominal} ± ${cell.halfWidth}${cell.hasAssay ? '' : '（标记缺检测）'}`)
    this.persist()
  }

  reset(fixtureId: FixtureId, actor: string) {
    const fixture = FIXTURES[fixtureId]
    if (!fixture) throw new HttpError(404, `未知样例 ${fixtureId}`)
    const keepVersion = this.state.version
    this.state = initialState(fixtureId)
    this.state.version = keepVersion + 1
    this.audit(actor, 'reset', `切换到样例「${fixture.name}」，清空预留与订单`)
    this.persist()
  }

  addPlan(plan: Omit<StoredPlan, 'createdAt' | 'status'>): StoredPlan {
    const stored: StoredPlan = {
      ...plan,
      createdAt: new Date().toISOString(),
      status: 'draft',
    }
    this.state.plans.unshift(stored)
    if (this.state.plans.length > 50) this.state.plans.length = 50
    // 注意：只生成草稿方案不动库存，因此不 bump 版本。
    // 版本只在库存/检测/预留等影响可用量的变化时前进，
    // 这样两位操作员各自求解的方案仍共享同一基线版本，先确认者成功。
    this.persist()
    return stored
  }

  getPlan(id: string) {
    return this.state.plans.find((p) => p.id === id)
  }

  /**
   * 确认方案：把草稿方案的配料写成预留。乐观并发控制。
   * 仅当基于的版本仍是最新、且库存仍足够时成功；两人同时确认只有一个成功。
   */
  confirmPlan(args: {
    plan: StoredPlan
    actor: string
    idempotencyKey?: string
    clientVersion: number
    allocations: Allocation[]
  }): { ok: true; state: PublicState; reservationIds: string[] } | { ok: false; status: number; error: string; detail?: any } {
    const { plan, actor, idempotencyKey, clientVersion, allocations } = args

    if (idempotencyKey && this.state.idempotency[idempotencyKey]) {
      return {
        ok: true,
        state: this.publicState(),
        reservationIds: this.state.idempotency[idempotencyKey].reservationIds,
      }
    }

    if (plan.status === 'ordered') {
      return {
        ok: false,
        status: 409,
        error: '该方案已确认，不能重复确认',
        detail: { orderId: plan.orderId },
      }
    }

    if (clientVersion !== this.state.version) {
      return {
        ok: false,
        status: 409,
        error: `方案基于版本 ${clientVersion}，但库存已变化（当前 v${this.state.version}）。请重新求解后再确认。`,
        detail: { version: this.state.version },
      }
    }

    // 以提交的配比为准，重算可用量并校验
    const availability = this.availability()
    const total = allocations.reduce((a, x) => a + x.quantity, 0)
    const freshNeed = plan.payload.volume - this.state.heel.quantity
    if (Math.abs(total - freshNeed) > 1e-3) {
      return {
        ok: false,
        status: 409,
        error: `配料合计 ${total.toFixed(2)} t 与所需新鲜量 ${freshNeed.toFixed(2)} t 不符，请重新求解`,
        detail: { total, freshNeed },
      }
    }
    const shortfalls = allocations
      .map((a) => ({ ...a, available: availability[a.lotId] ?? 0 }))
      .filter((a) => a.quantity > a.available + 1e-6)
    if (shortfalls.length > 0) {
      return {
        ok: false,
        status: 409,
        error: '库存不足以确认该方案，请重新求解',
        detail: {
          shortfalls: shortfalls.map((s) => ({
            lotId: s.lotId,
            requested: s.quantity,
            available: s.available,
          })),
          version: this.state.version,
        },
      }
    }

    const reservationIds: string[] = []
    for (const a of allocations) {
      if (a.quantity <= 1e-6) continue
      const r: Reservation = {
        id: `RSV-${randomUUID().slice(0, 8)}`,
        planId: plan.id,
        lotId: a.lotId,
        quantity: a.quantity,
        status: 'active',
        createdAt: new Date().toISOString(),
        operator: actor,
      }
      this.state.reservations.push(r)
      reservationIds.push(r.id)
    }
    const order: Order = {
      id: `ORD-${randomUUID().slice(0, 8)}`,
      planId: plan.id,
      specSetId: plan.payload.specSetId,
      volume: plan.payload.volume,
      allocations,
      createdAt: new Date().toISOString(),
      operator: actor,
    }
    this.state.orders.unshift(order)
    plan.status = 'ordered'
    plan.orderId = order.id
    this.bump()
    this.audit(actor, 'confirm', `确认方案 ${plan.id}，生成订单 ${order.id} 并预留 ${allocations.length} 个原料罐`)
    if (idempotencyKey) {
      this.state.idempotency[idempotencyKey] = { reservationIds, at: new Date().toISOString() }
    }
    this.persist()
    return { ok: true, state: this.publicState(), reservationIds }
  }

  /** 释放订单中尚未投料的预留；已投料的不能释放。 */
  releaseOrder(orderId: string, actor: string): { released: number; state: PublicState } | null {
    const order = this.state.orders.find((o) => o.id === orderId)
    if (!order) return null
    let released = 0
    for (const r of this.state.reservations) {
      if (r.planId !== order.planId) continue
      if (r.status !== 'active') continue
      r.status = 'released'
      r.releasedAt = new Date().toISOString()
      released += 1
    }
    const plan = this.state.plans.find((p) => p.id === order.planId)
    if (plan) plan.status = 'draft'
    this.bump()
    this.audit(actor, 'release', `释放订单 ${orderId} 的 ${released} 条未投料预留`)
    this.persist()
    return { released, state: this.publicState() }
  }

  /** 标记某订单已投料：预留转 committed（不可释放）。 */
  commitOrder(orderId: string, actor: string) {
    const order = this.state.orders.find((o) => o.id === orderId)
    if (!order) return null
    let committed = 0
    for (const r of this.state.reservations) {
      if (r.planId !== order.planId) continue
      if (r.status !== 'active') continue
      r.status = 'committed'
      committed += 1
    }
    this.bump()
    this.audit(actor, 'commit', `订单 ${orderId} 标记投料，${committed} 条预留转为已消耗`)
    this.persist()
    return { committed, state: this.publicState() }
  }
}

export class HttpError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}
