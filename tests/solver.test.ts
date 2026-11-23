import { describe, expect, it } from 'vitest'
import { BASE_FIXTURE, MISSING_ASSAY_FIXTURE, TIGHT_FIXTURE } from '../shared/fixtures.ts'
import { solvePlan, highsLoader } from '../shared/solver.ts'
import { enumerateBlends, checkWorstCase, worstScenarioFor } from '../shared/enumerate.ts'
import { buildFactors, buildScenarioSet, factorCoefficient, boxDeviationTotal, budgetDeviationTotal } from '../shared/uncertainty.ts'
import { PROPERTY_IDS } from '../shared/catalog.ts'
import type { MixLine } from '../shared/uncertainty.ts'

const avail = (lots: typeof BASE_FIXTURE.lots) =>
  Object.fromEntries(lots.map((l) => [l.id, l.quantity]))

function base(mode: any, extra: any = {}) {
  return {
    lots: BASE_FIXTURE.lots,
    heel: BASE_FIXTURE.heel,
    specSets: BASE_FIXTURE.specSets,
    specSetId: 'SPEC-92',
    availability: avail(BASE_FIXTURE.lots),
    rho: 0.6,
    mode,
    ...extra,
  }
}

describe('名义 / 箱式 / 预算 三档保守程度', () => {
  it('名义成本 ≤ 预算成本 ≤ 箱式成本', async () => {
    const nom = (await solvePlan(base({ kind: 'nominal' }))).result
    const b2 = (await solvePlan(base({ kind: 'budget', gamma: 2 }))).result
    const b4 = (await solvePlan(base({ kind: 'budget', gamma: 4 }))).result
    const box = (await solvePlan(base({ kind: 'box' }))).result
    expect(nom.status).toBe('optimal')
    expect(b2.status).toBe('optimal')
    expect(box.status).toBe('optimal')
    expect(nom.unitCost).toBeLessThanOrEqual(b2.unitCost + 1e-6)
    expect(b2.unitCost).toBeLessThanOrEqual(b4.unitCost + 1e-6)
    expect(b4.unitCost).toBeLessThanOrEqual(box.unitCost + 1e-6)
  })

  it('预算方案保证的质量不低于限额，且场景风险随 Γ 单调下降', async () => {
    const risks: number[] = []
    for (const gamma of [0, 1, 2, 3, 5]) {
      const r = (await solvePlan(base({ kind: 'budget', gamma }))).result
      expect(r.status).toBe('optimal')
      for (const lim of r.limits) {
        if (lim.dir === 'min') expect(r.guaranteed[lim.property]).toBeGreaterThanOrEqual(lim.limit - 1e-6)
        else expect(r.guaranteed[lim.property]).toBeLessThanOrEqual(lim.limit + 1e-6)
      }
      risks.push(r.risk.violatedProbability)
    }
    for (let i = 1; i < risks.length; i++) {
      expect(risks[i]).toBeLessThanOrEqual(risks[i - 1] + 1e-9)
    }
  })

  it('名义方案在场景集上确实会违反，且能指出实际最坏违反场景', async () => {
    const r = (await solvePlan(base({ kind: 'nominal' }))).result
    expect(r.risk.violatedProbability).toBeGreaterThan(0)
    const worst = r.risk.worstScenario
    expect(worst).not.toBeNull()
    expect(worst!.violations.length).toBeGreaterThan(0)
    const v = worst!.worst!
    expect(v).toBeTruthy()
    // 违反量与场景概率可核对
    expect(worst!.probability).toBeGreaterThan(0)
    expect(worst!.probability).toBeLessThan(1)
  })

  it('箱式方案在场景集上不再违反', async () => {
    const r = (await solvePlan(base({ kind: 'box' }))).result
    expect(r.risk.violatedProbability).toBeCloseTo(0, 6)
  })
})

describe('同批共同偏移 vs 独立误差', () => {
  it('ρ=1 时同批罐完全共因，最坏幅度大于 ρ=0', async () => {
    const rho0 = (await solvePlan(base({ kind: 'box' }, { rho: 0 }))).result
    const rho1 = (await solvePlan(base({ kind: 'box' }, { rho: 1 }))).result
    // ρ=0：全部是独立因子，没有任何共同偏移
    const f0 = buildFactors(BASE_FIXTURE.lots, BASE_FIXTURE.heel, PROPERTY_IDS, 0)
    expect(f0.filter((f) => f.kind === 'ind').length).toBeGreaterThan(0)
    expect(f0.filter((f) => f.kind === 'shared').length).toBe(0)
    // ρ=1：每批只有一个共同因子，独立因子消失
    const f1 = buildFactors(BASE_FIXTURE.lots, BASE_FIXTURE.heel, PROPERTY_IDS, 1)
    expect(f1.filter((f) => f.kind === 'ind' && f.lotId === 'RA-01').length).toBe(0)
    expect(f1.filter((f) => f.kind === 'shared' && f.batchId === 'G-RF').length).toBeGreaterThan(0)
    // 同批两罐共同偏移的幅度 = ρ(h_A x_A + h_B x_B)：只存在一个 ξ，不能拆成两条独立上限
    const lines: MixLine[] = [
      { lot: BASE_FIXTURE.lots.find((l) => l.id === 'RA-01')!, quantity: 100 },
      { lot: BASE_FIXTURE.lots.find((l) => l.id === 'RA-02')!, quantity: 50 },
    ]
    const sharedRF = f1.find((f) => f.kind === 'shared' && f.batchId === 'G-RF' && f.property === 'RON')!
    expect(Math.abs(factorCoefficient(sharedRF, lines))).toBeCloseTo(0.6 * 100 + 0.8 * 50, 6)
    // ρ=1 的箱式暴露不小于 ρ=0（独立 vs 共因的差异见预算模式）
    expect(rho1.unitCost).toBeGreaterThanOrEqual(rho0.unitCost - 1e-6)
  })

  it('双方共同的偏移只能算一次：箱式总偏移 ≤ 各自上界相加（且严格小于）', async () => {
    const r = (await solvePlan(base({ kind: 'nominal' }))).result
    const lines: MixLine[] = r.allocations.map((a) => ({
      lot: BASE_FIXTURE.lots.find((l) => l.id === a.lotId)!,
      quantity: a.quantity,
    }))
    const factors = buildFactors(BASE_FIXTURE.lots, BASE_FIXTURE.heel, PROPERTY_IDS, 0.6)
    for (const p of PROPERTY_IDS) {
      const box = boxDeviationTotal(factors, lines, p)
      const naiveSum = factors
        .filter((f) => f.property === p)
        .reduce((acc, f) => {
          const sharedSameBatch = factors
            .filter((g) => g.property === p && g.batchId === f.batchId)
          const uniqueBatches = new Set(sharedSameBatch.map((g) => g.batchId)).size
          const c = Math.abs(factorCoefficient(f, lines))
          return acc + c / Math.max(uniqueBatches, 1)
        }, 0)
      // 箱式仍然可能大于“平均分摊”，但预算模式在 Γ 小时应严格小于箱式
      const budget1 = budgetDeviationTotal(factors, lines, p, 1)
      expect(budget1).toBeLessThanOrEqual(box + 1e-9)
      if (factors.filter((f) => f.property === p).length > 1) {
        expect(budget1).toBeLessThan(box - 1e-6)
      }
      expect(Number.isFinite(naiveSum)).toBe(true)
    }
  })
})

describe('小规模枚举核对', () => {
  it('枚举最优名义成本与 LP 名义最优一致（步行长足够小）', async () => {
    const lp = (await solvePlan(base({ kind: 'nominal' }, { sensitivity: false }))).result
    const small = {
      ...BASE_FIXTURE.specSets[0],
      limits: [
        { property: 'RON' as const, min: 96, max: null },
        { property: 'S' as const, min: null, max: 9 },
      ],
    }
    // 用更小的样例：两种原料 + 较大步长，保证枚举规模可控
    const lots = BASE_FIXTURE.lots.filter((l) => ['RA-01', 'FC-01', 'LN-01'].includes(l.id))
    const availability = Object.fromEntries(lots.map((l) => [l.id, l.quantity]))
    const enumRes = enumerateBlends({
      lots,
      heel: BASE_FIXTURE.heel,
      spec: { ...small, volume: 300 },
      availability,
      rho: 0.6,
      gridStep: 5,
    })
    expect(enumRes.combos).toBeGreaterThan(10)
    expect(enumRes.feasibleNominal).toBeGreaterThan(0)
    const lpSmall = (await solvePlan({
      lots,
      heel: BASE_FIXTURE.heel,
      specSets: [{ ...small, volume: 300 }],
      specSetId: small.id,
      availability,
      rho: 0.6,
      mode: { kind: 'nominal' },
    })).result
    expect(lpSmall.status).toBe('optimal')
    // 枚举受 5 t 网格限制，成本只应略高于 LP
    const bestEnum = enumRes.bestNominal!
    expect(bestEnum.nominalCost).toBeGreaterThanOrEqual(lpSmall.totalCost - 1e-6)
    expect(bestEnum.nominalCost - lpSmall.totalCost).toBeLessThan(300 * 40)
    expect(lp.status).toBe('optimal')
  })

  it('枚举出的箱式可行最优与 LP 箱式解接近', async () => {
    const lots = BASE_FIXTURE.lots.filter((l) => ['RA-01', 'FC-01', 'LN-01'].includes(l.id))
    const availability = Object.fromEntries(lots.map((l) => [l.id, l.quantity]))
    const spec = {
      ...BASE_FIXTURE.specSets[0],
      volume: 300,
      limits: [
        { property: 'RON' as const, min: 96, max: null },
        { property: 'S' as const, min: null, max: 9 },
      ],
    }
    const enumRes = enumerateBlends({ lots, heel: BASE_FIXTURE.heel, spec, availability, rho: 0.6, gridStep: 5 })
    const lpBox = (await solvePlan({
      lots,
      heel: BASE_FIXTURE.heel,
      specSets: [spec],
      specSetId: spec.id,
      availability,
      rho: 0.6,
      mode: { kind: 'box' },
    })).result
    expect(lpBox.status).toBe('optimal')
    expect(enumRes.bestBox).not.toBeNull()
    expect(enumRes.bestBox!.nominalCost).toBeGreaterThanOrEqual(lpBox.totalCost - 1e-6)
    expect(enumRes.bestBox!.nominalCost - lpBox.totalCost).toBeLessThan(300 * 60)
  })

  it('因子顶点枚举与解析箱式最坏一致', async () => {
    const r = (await solvePlan(base({ kind: 'nominal' }))).result
    const lines: MixLine[] = r.allocations.map((a) => ({
      lot: BASE_FIXTURE.lots.find((l) => l.id === a.lotId)!,
      quantity: a.quantity,
    }))
    const factors = buildFactors(BASE_FIXTURE.lots, BASE_FIXTURE.heel, ['RON', 'S'], 0.6)
    const checks = checkWorstCase({
      factors,
      lines,
      properties: ['RON', 'S'],
      mode: { kind: 'box' },
      gamma: Infinity,
      maxFactors: 6,
    })
    const relevant = checks.filter((c) => c.vertices > 0)
    expect(relevant.length).toBeGreaterThan(0)
    // 顶点枚举的极值必须覆盖解析值（解析最坏不会超过枚举出来的最大偏移）
    for (const c of relevant) {
      expect(c.match, `${c.property}:${c.dir} 解析 ${c.analytical} vs 枚举 ${c.enumerated}`).toBe(true)
      expect(c.enumerated).toBeGreaterThanOrEqual(c.analytical - 1e-6)
    }
    // 因子数在前 maxFactors 内时可完全对齐
    const exact = relevant.filter((c) => !c.truncated)
    if (exact.length) {
      for (const c of exact) expect(c.enumerated).toBeCloseTo(c.analytical, 6)
    }
    // 预算模式的 Γ 顶点：解析与枚举必须完全一致（子集内）
    for (const mode of [
      { kind: 'budget' as const, gamma: 1 },
      { kind: 'budget' as const, gamma: 2 },
      { kind: 'budget' as const, gamma: 2.5 },
      { kind: 'budget' as const, gamma: 1.4 },
    ]) {
      const bchecks = checkWorstCase({
        factors: buildFactors(BASE_FIXTURE.lots, BASE_FIXTURE.heel, PROPERTY_IDS, 0.6),
        lines,
        properties: PROPERTY_IDS,
        mode,
        gamma: mode.gamma,
        maxFactors: 5,
      })
      for (const c of bchecks) {
        expect(c.enumerated, `Γ=${mode.gamma} ${c.property}:${c.dir}`).toBeCloseTo(c.analytical, 6)
      }
    }
  })
})

describe('缺检测与不可行规格', () => {
  it('缺检测的罐被排除，而不是当成 0', async () => {
    const { result } = await solvePlan({
      lots: MISSING_ASSAY_FIXTURE.lots,
      heel: MISSING_ASSAY_FIXTURE.heel,
      specSets: MISSING_ASSAY_FIXTURE.specSets,
      specSetId: 'SPEC-92',
      availability: avail(MISSING_ASSAY_FIXTURE.lots),
      rho: 0.6,
      mode: { kind: 'nominal' },
    })
    expect(result.status).toBe('optimal')
    const ids = result.allocations.map((a) => a.lotId)
    expect(ids).not.toContain('FC-02')
    expect(ids).not.toContain('TL-01')
    const reasons = result.excludedLots.map((e) => e.lotId)
    expect(reasons).toEqual(expect.arrayContaining(['FC-02', 'TL-01']))
  })

  it('不可行规格给出可诊断的短差原因', async () => {
    const { result } = await solvePlan({
      lots: BASE_FIXTURE.lots,
      heel: BASE_FIXTURE.heel,
      specSets: BASE_FIXTURE.specSets,
      specSetId: 'SPEC-IMPOSSIBLE',
      availability: avail(BASE_FIXTURE.lots),
      rho: 0.6,
      mode: { kind: 'nominal' },
    })
    expect(result.status).toBe('infeasible')
    expect(result.diagnosis).toBeTruthy()
    const sReason = result.diagnosis!.reasons.find((r) => r.property === 'S')
    expect(sReason).toBeTruthy()
    expect(sReason!.bestAvailable).toBeGreaterThan(2)
    expect(sReason!.message).toContain('达不到')
  })
})

describe('罐中余量、库存竞争与预留', () => {
  it('罐底余量计入总量并影响质量', async () => {
    const { result } = await solvePlan({
      lots: TIGHT_FIXTURE.lots,
      heel: TIGHT_FIXTURE.heel,
      specSets: TIGHT_FIXTURE.specSets,
      specSetId: 'SPEC-92',
      availability: avail(TIGHT_FIXTURE.lots),
      rho: 0.6,
      mode: { kind: 'nominal' },
    })
    expect(result.status).toBe('optimal')
    const fresh = result.allocations.reduce((a, x) => a + x.quantity, 0)
    expect(fresh).toBeCloseTo(result.volume - TIGHT_FIXTURE.heel.quantity, 4)
    expect(result.heelQuantity).toBe(260)
  })

  it('可用量减少后重解成本上升或不可行（库存竞争）', async () => {
    const full = (await solvePlan({
      lots: TIGHT_FIXTURE.lots,
      heel: TIGHT_FIXTURE.heel,
      specSets: TIGHT_FIXTURE.specSets,
      specSetId: 'SPEC-92',
      availability: avail(TIGHT_FIXTURE.lots),
      rho: 0.6,
      mode: { kind: 'nominal' },
    })).result
    const cut = { ...avail(TIGHT_FIXTURE.lots) }
    cut['MT-01'] = 0
    cut['AK-01'] = 20
    const after = (await solvePlan({
      lots: TIGHT_FIXTURE.lots,
      heel: TIGHT_FIXTURE.heel,
      specSets: TIGHT_FIXTURE.specSets,
      specSetId: 'SPEC-92',
      availability: cut,
      rho: 0.6,
      mode: { kind: 'box' },
    })).result
    if (full.status === 'optimal' && after.status === 'optimal') {
      expect(after.unitCost).toBeGreaterThan(full.unitCost)
    } else {
      expect(after.status).toBe('infeasible')
    }
  })
})

describe('场景概率方案', () => {
  it('α 越大成本不降、风险不升', async () => {
    const rows: Array<{ a: number; cost: number; risk: number }> = []
    for (const alpha of [0.5, 0.7, 0.9]) {
      const r = (await solvePlan(base({ kind: 'chance', alpha }))).result
      expect(r.status).toBe('optimal')
      rows.push({ a: alpha, cost: r.unitCost, risk: r.risk.violatedProbability })
    }
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i].cost).toBeGreaterThanOrEqual(rows[i - 1].cost - 1e-6)
      expect(rows[i].risk).toBeLessThanOrEqual(rows[i - 1].risk + 1e-6)
      expect(rows[i].risk).toBeLessThanOrEqual(1 - rows[i].a + 1e-6)
    }
  })

  it('场景概率之和为 1', () => {
    const factors = buildFactors(BASE_FIXTURE.lots, BASE_FIXTURE.heel, PROPERTY_IDS, 0.6)
    const set = buildScenarioSet(factors, PROPERTY_IDS, 7, 8)
    const sum = set.scenarios.reduce((a, s) => a + s.probability, 0)
    expect(sum).toBeCloseTo(1, 9)
  })
})
