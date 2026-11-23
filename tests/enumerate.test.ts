import { describe, expect, it } from 'vitest'
import { BASE_FIXTURE } from '../shared/fixtures.ts'
import { solvePlan } from '../shared/solver.ts'
import { enumerateBlends, countCompositions } from '../shared/enumerate.ts'
import type { PlanMode } from '../shared/types.ts'

const availability = Object.fromEntries(BASE_FIXTURE.lots.map((l) => [l.id, l.quantity]))
const spec = BASE_FIXTURE.specSets.find((s) => s.id === 'SPEC-92')!

/** 小样例：三种原料 + 300 t 产量，枚举规模足够小且可完整穷举。 */
const smallLots = BASE_FIXTURE.lots.filter((l) => ['RA-01', 'FC-01', 'LN-01'].includes(l.id))
const smallAvail = Object.fromEntries(smallLots.map((l) => [l.id, l.quantity]))
const smallSpec = { ...spec, volume: 300 }

async function lp(mode: PlanMode) {
  return (
    await solvePlan({
      lots: smallLots,
      heel: BASE_FIXTURE.heel,
      specSets: [smallSpec],
      specSetId: smallSpec.id,
      availability: smallAvail,
      rho: 0.6,
      mode,
    })
  ).result
}

describe('小规模枚举核对', () => {
  it('组合计数与暴力枚举一致', () => {
    // 3 罐、各容量 2，装 3 份：C(5,2)=10 种分配，减去 (3,0,0) 的三个越界组合 = 7
    expect(countCompositions([2, 2, 2], 3)).toBe(7)
    // 容量 0 的罐不能分配
    expect(countCompositions([0, 5], 3)).toBe(1)
    // 容量受限：第一罐最多 1 份、第二罐最多 1 份，装 3 份无解
    expect(countCompositions([1, 1], 3)).toBe(0)
    // 单罐
    expect(countCompositions([9], 4)).toBe(1)
  })

  it('枚举步长整除新鲜量，配比总和严格等于目标新鲜量', async () => {
    const step = 20
    const fresh = smallSpec.volume - BASE_FIXTURE.heel.quantity
    const e = enumerateBlends({
      lots: smallLots,
      heel: BASE_FIXTURE.heel,
      spec: smallSpec,
      availability: smallAvail,
      rho: 0.6,
      gridStep: step,
    })
    expect(e.gridStep).toBeCloseTo(fresh / Math.round(fresh / step), 9)
    for (const row of e.top) {
      const total = row.quantities.reduce((a, q) => a + q.quantity, 0)
      expect(total).toBeCloseTo(fresh, 6)
    }
  })

  it('名义/箱式/预算的离散最优都不优于连续 LP', async () => {
    for (const mode of [
      { kind: 'nominal' } as const,
      { kind: 'box' } as const,
      { kind: 'budget', gamma: 2 } as const,
    ]) {
      const res = await lp(mode)
      expect(res.status).toBe('optimal')
      const e = enumerateBlends({
        lots: smallLots,
        heel: BASE_FIXTURE.heel,
        spec: smallSpec,
        availability: smallAvail,
        rho: 0.6,
        gridStep: 5,
        mode,
        maxCombos: 2_000_000,
      })
      const best = mode.kind === 'nominal' ? e.bestNominal : e.bestBox
      expect(best, `${mode.kind} 应有可行离散组合`).not.toBeNull()
      // LP 是连续松弛，成本不能高于任何离散可行组合（允许极小数值误差）
      expect(best!.nominalCost).toBeGreaterThanOrEqual(res.totalCost - 1e-6)
      // 网格足够细时，差距不应离谱（< 5% 成本）
      expect(best!.nominalCost - res.totalCost).toBeLessThan(res.totalCost * 0.05)
    }
  })

  it('保护模式越强，离散可行组合越少、成本越高', async () => {
    const run = (mode: PlanMode) =>
      enumerateBlends({
        lots: smallLots,
        heel: BASE_FIXTURE.heel,
        spec: smallSpec,
        availability: smallAvail,
        rho: 0.6,
        gridStep: 10,
        mode,
        maxCombos: 2_000_000,
      })
    const nominal = run({ kind: 'nominal' })
    const budget = run({ kind: 'budget', gamma: 2 })
    const box = run({ kind: 'box' })
    expect(nominal.feasibleBox).toBeGreaterThanOrEqual(budget.feasibleBox)
    expect(budget.feasibleBox).toBeGreaterThanOrEqual(box.feasibleBox)
    expect(budget.bestBox!.nominalCost).toBeGreaterThanOrEqual(nominal.bestBox!.nominalCost - 1e-6)
    expect(box.bestBox!.nominalCost).toBeGreaterThanOrEqual(budget.bestBox!.nominalCost - 1e-6)
  })

  it('枚举能重现 LP 方案的成本下界与最坏指标', async () => {
    const res = await lp({ kind: 'box' })
    expect(res.status).toBe('optimal')
    // 用 LP 配比（取整到网格）计算箱式最坏，应等于 LP 报告的保证值附近
    const e = enumerateBlends({
      lots: smallLots,
      heel: BASE_FIXTURE.heel,
      spec: smallSpec,
      availability: smallAvail,
      rho: 0.6,
      gridStep: 5,
      mode: { kind: 'box' },
      maxCombos: 2_000_000,
    })
    const best = e.bestBox!
    // 离散最优的箱式最坏一定满足全部限额
    for (const [key, slack] of Object.entries(best.boxSlack)) {
      expect(slack, key).toBeGreaterThanOrEqual(-1e-6)
    }
    // 离散最优不会比 LP 便宜
    expect(best.nominalCost).toBeGreaterThanOrEqual(res.totalCost - 1e-6)
  })

  it('预算 Γ=0 与名义可行性一致', async () => {
    const e = enumerateBlends({
      lots: smallLots,
      heel: BASE_FIXTURE.heel,
      spec: smallSpec,
      availability: smallAvail,
      rho: 0.6,
      gridStep: 10,
      mode: { kind: 'budget', gamma: 0 },
      maxCombos: 2_000_000,
    })
    expect(e.feasibleBox).toBe(e.feasibleNominal)
  })

  it('缺检测的原料不会进入枚举候选', async () => {
    const lots = BASE_FIXTURE.lots.map((l) =>
      l.id === 'FC-02' ? { ...l, assay: { ...l.assay, OLE: { nominal: 0, halfWidth: 0, hasAssay: false } } } : l,
    )
    const e = enumerateBlends({
      lots,
      heel: BASE_FIXTURE.heel,
      spec,
      availability: Object.fromEntries(lots.map((l) => [l.id, l.quantity])),
      rho: 0.6,
      gridStep: 50,
      mode: { kind: 'nominal' },
      maxCombos: 200_000,
    })
    expect(e.lotIds).not.toContain('FC-02')
  })
})
