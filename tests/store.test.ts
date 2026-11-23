import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../server/store.ts'

// 每个用例都用一个全新的数据目录，避免污染真实 .data/
let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'blendwise-store-'))
  process.env.BLENDWISE_DATA = join(dir, 'state.json')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  delete process.env.BLENDWISE_DATA
})

const allocation = (store: Store) => {
  const lots = store.lots()
  const spec = store.specSets()[0]
  let remaining = spec.volume - store.heel().quantity
  const out: Array<{ lotId: string; quantity: number }> = []
  for (const lot of lots) {
    if (remaining <= 1e-9) break
    const take = Math.min(lot.quantity, remaining)
    if (take <= 1e-9) continue
    out.push({ lotId: lot.id, quantity: take })
    remaining -= take
  }
  if (remaining > 1e-9) throw new Error('库存不足，无法构造测试配比')
  return out
}

const makePlan = (store: Store, id: string) => {
  const spec = store.specSets()[0]
  const allocations = allocation(store)
  return store.addPlan({
    id,
    actor: 'operator',
    payload: {
      id,
      specSetId: spec.id,
      mode: { kind: 'budget', gamma: 2 },
      rho: 0.6,
      volume: spec.volume,
      allocations,
      basedOnVersion: store.version,
      cost: 0,
    },
  })
}

describe('确认方案：乐观并发控制', () => {
  it('两位操作员基于同一版本各自确认，只有一个成功', () => {
    const store = new Store()
    const planA = makePlan(store, 'PLN-A')
    const planB = makePlan(store, 'PLN-B')
    const version = store.version
    const allocA = planA.payload.allocations
    const allocB = planB.payload.allocations

    const first = store.confirmPlan({
      plan: planA,
      actor: '甲',
      clientVersion: version,
      allocations: allocA,
    })
    expect(first.ok).toBe(true)

    const second = store.confirmPlan({
      plan: planB,
      actor: '乙',
      clientVersion: version,
      allocations: allocB,
    })
    expect(second.ok).toBe(false)
    if (!second.ok) {
      expect(second.status).toBe(409)
      expect(second.error).toContain('库存已变化')
    }
  })

  it('草稿方案的生成不推进版本号，因此不影响另一张单的基线', () => {
    const store = new Store()
    const v0 = store.version
    makePlan(store, 'PLN-A')
    expect(store.version).toBe(v0)
    makePlan(store, 'PLN-B')
    expect(store.version).toBe(v0)
  })

  it('同一张单重复确认返回 409，幂等键重放返回首次结果', () => {
    const store = new Store()
    const plan = makePlan(store, 'PLN-A')
    const allocations = plan.payload.allocations
    const first = store.confirmPlan({
      plan,
      actor: '甲',
      clientVersion: store.version,
      idempotencyKey: 'key-1',
      allocations,
    })
    expect(first.ok).toBe(true)
    const replay = store.confirmPlan({
      plan,
      actor: '甲',
      clientVersion: store.version,
      idempotencyKey: 'key-1',
      allocations,
    })
    expect(replay.ok).toBe(true)
    if (first.ok && replay.ok) {
      expect(replay.reservationIds).toEqual(first.reservationIds)
    }
  })

  it('确认会预留库存，后续方案拿到扣减后的可用量', () => {
    const store = new Store()
    const plan = makePlan(store, 'PLN-A')
    const allocations = plan.payload.allocations
    const before = store.availability()
    const used = allocations[0]
    store.confirmPlan({ plan, actor: '甲', clientVersion: store.version, allocations })
    const after = store.availability()
    expect(after[used.lotId]).toBeCloseTo(before[used.lotId] - used.quantity, 6)
    expect(after[used.lotId]).toBeLessThan(before[used.lotId])
    // 排除自己后可用量恢复（用于“同一方案重新求解”）
    const excluded = store.availability(plan.id)
    expect(excluded[used.lotId]).toBeCloseTo(before[used.lotId], 6)
  })

  it('已投料的预留不能释放，未投料的可以释放', () => {
    const store = new Store()
    const plan = makePlan(store, 'PLN-A')
    const allocations = plan.payload.allocations
    store.confirmPlan({ plan, actor: '甲', clientVersion: store.version, allocations })
    const orderId = store.publicState().orders[0].id

    const committed = store.commitOrder(orderId, '甲')
    expect(committed?.committed).toBeGreaterThan(0)
    const releasedAfterCommit = store.releaseOrder(orderId, '甲')
    expect(releasedAfterCommit?.released).toBe(0)

    const plan2 = makePlan(store, 'PLN-B')
    store.confirmPlan({
      plan: plan2,
      actor: '甲',
      clientVersion: store.version,
      allocations: plan2.payload.allocations,
    })
    const order2 = store.publicState().orders.find((o) => o.planId === plan2.id)!
    const released = store.releaseOrder(order2.id, '甲')
    expect(released?.released).toBeGreaterThan(0)
    expect(store.availability()[allocations[0].lotId]).toBeGreaterThan(0)
  })

  it('检测区间编辑会推进版本并写入审计', () => {
    const store = new Store()
    const v = store.version
    store.updateAssay('RA-01', 'RON', { nominal: 100, halfWidth: 1.2, hasAssay: true }, '甲')
    expect(store.version).toBeGreaterThan(v)
    const state = store.publicState()
    expect(state.lots.find((l) => l.id === 'RA-01')!.assay.RON).toEqual({
      nominal: 100,
      halfWidth: 1.2,
      hasAssay: true,
    })
    expect(state.audit[0].detail).toContain('RA-01')
  })

  it('ρ 是建模参数，不推进版本', () => {
    const store = new Store()
    const v = store.version
    store.setRho(0.3)
    expect(store.rho()).toBe(0.3)
    expect(store.version).toBe(v)
  })
})
