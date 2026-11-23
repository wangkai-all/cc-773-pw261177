import type { Assay, Lot, PropertyId, Scenario, ScenarioSet } from './types.ts'

export const RHO_DEFAULT = 0.6

export interface HeelInput {
  quantity: number
  batchId: string
  assay: Assay
  material?: string
}

/**
 * 一个不确定因子 ξ ∈ [−1, 1]：
 *   指标总量（t·指标单位）的偏移 = constant + Σ perTonne_lot * x_lot
 *
 * 独立因子：每罐一套，perTonne = (1−ρ)·半宽
 * 共同因子：同批共用一套，perTonne = ρ·半宽（同批各罐的偏移叠加到同一个 ξ）
 */
export interface FactorDef {
  key: string
  kind: 'ind' | 'shared'
  property: PropertyId
  batchId: string
  lotId?: string
  label: string
  constant: number
  perTonne: Array<{ lotId: string; value: number }>
}

export interface MixLine {
  lot: Lot
  quantity: number
}

function cell(lot: Lot, p: PropertyId) {
  return lot.assay[p]
}

export function halfWidth(lot: Lot, p: PropertyId): number {
  const c = cell(lot, p)
  return c && c.hasAssay ? c.halfWidth : 0
}

export function nominal(lot: Lot, p: PropertyId): number {
  const c = cell(lot, p)
  return c && c.hasAssay ? c.nominal : NaN
}

export function hasAssay(lot: Lot, p: PropertyId): boolean {
  const c = cell(lot, p)
  return !!c && c.hasAssay
}

export function heelHasAssay(heel: HeelInput, p: PropertyId): boolean {
  const c = heel.assay[p]
  return !!c && c.hasAssay
}

export function heelNominal(heel: HeelInput, p: PropertyId): number {
  const c = heel.assay[p]
  return c && c.hasAssay ? c.nominal : NaN
}

export function heelHalfWidth(heel: HeelInput, p: PropertyId): number {
  const c = heel.assay[p]
  return c && c.hasAssay ? c.halfWidth : 0
}

export function buildFactors(
  lots: Lot[],
  heel: HeelInput,
  properties: PropertyId[],
  rho: number,
): FactorDef[] {
  const factors: FactorDef[] = []
  const batches = new Map<string, Lot[]>()
  for (const lot of lots) {
    if (!batches.has(lot.batchId)) batches.set(lot.batchId, [])
    batches.get(lot.batchId)!.push(lot)
  }
  const batchesWithHeel = new Set([...batches.keys()])
  batchesWithHeel.add(heel.batchId)

  for (const p of properties) {
    for (const lot of lots) {
      const h = halfWidth(lot, p)
      if (h <= 0 || rho >= 1) continue
      factors.push({
        key: `I|${lot.id}|${p}`,
        kind: 'ind',
        property: p,
        batchId: lot.batchId,
        lotId: lot.id,
        label: `${lot.id} 独立误差`,
        constant: 0,
        perTonne: [{ lotId: lot.id, value: (1 - rho) * h }],
      })
    }
    for (const [batchId, group] of batches) {
      const terms = group
        .filter((l) => halfWidth(l, p) > 0)
        .map((l) => ({ lotId: l.id, value: rho * halfWidth(l, p) }))
      if (terms.length === 0 || rho <= 0) continue
      factors.push({
        key: `S|${batchId}|${p}`,
        kind: 'shared',
        property: p,
        batchId,
        label: `批次 ${batchId} 共同偏移`,
        constant: 0,
        perTonne: terms,
      })
    }
    if (heel.quantity > 0 && heelHasAssay(heel, p)) {
      const h = heelHalfWidth(heel, p)
      if (rho < 1) {
        factors.push({
          key: `I|${heel.batchId}|${p}`,
          kind: 'ind',
          property: p,
          batchId: heel.batchId,
          label: '罐底余量 独立误差',
          constant: (1 - rho) * h * heel.quantity,
          perTonne: [],
        })
      }
      if (rho > 0) {
        factors.push({
          key: `S|${heel.batchId}|${p}`,
          kind: 'shared',
          property: p,
          batchId: heel.batchId,
          label: '罐底余量 共同偏移',
          constant: rho * h * heel.quantity,
          perTonne: [],
        })
      }
    }
  }
  return factors
}

/** 因子在给定配比下的系数（t·指标单位）。 */
export function factorCoefficient(f: FactorDef, lines: MixLine[]): number {
  let c = f.constant
  for (const t of f.perTonne) {
    const line = lines.find((l) => l.lot.id === t.lotId)
    if (line) c += t.value * line.quantity
  }
  return c
}

/** 因子系数对某罐投入量 x_l 的偏导（即 LP 中的系数），与投入量无关。 */
export function factorPartial(f: FactorDef, lotId: string): number {
  for (const t of f.perTonne) if (t.lotId === lotId) return t.value
  return 0
}

export function baseQualityTotal(
  lines: MixLine[],
  heel: HeelInput,
  p: PropertyId,
): number {
  let total = 0
  if (heel.quantity > 0) total += heelNominal(heel, p) * heel.quantity
  for (const line of lines) {
    const v = nominal(line.lot, p)
    if (Number.isFinite(v)) total += v * line.quantity
  }
  return total
}

export function nominalQuality(
  lines: MixLine[],
  heel: HeelInput,
  volume: number,
  properties: PropertyId[],
): Record<string, number> {
  const out: Record<string, number> = {}
  for (const p of properties) out[p] = baseQualityTotal(lines, heel, p) / volume
  return out
}

export function deviationForScenario(
  factors: FactorDef[],
  lines: MixLine[],
  scenario: Scenario,
): Record<string, number> {
  const out: Record<string, number> = {}
  for (const f of factors) {
    const xi = scenario.factors[f.key]
    if (!xi) continue
    out[f.property] = (out[f.property] ?? 0) + factorCoefficient(f, lines) * xi
  }
  return out
}

export function factorsByProperty(factors: FactorDef[], p: PropertyId): FactorDef[] {
  return factors.filter((f) => f.property === p)
}

/** 箱式最坏：每个因子独立取端点，偏移量 = Σ|系数|。 */
export function boxDeviationTotal(
  factors: FactorDef[],
  lines: MixLine[],
  p: PropertyId,
): number {
  let s = 0
  for (const f of factors) if (f.property === p) s += Math.abs(factorCoefficient(f, lines))
  return s
}

/** 预算不确定集 {|ξ|≤1, Σ|ξ|≤Γ} 下的最坏偏移。 */
export function budgetDeviationTotal(
  factors: FactorDef[],
  lines: MixLine[],
  p: PropertyId,
  gamma: number,
): number {
  const mags = factors
    .filter((f) => f.property === p)
    .map((f) => Math.abs(factorCoefficient(f, lines)))
    .sort((a, b) => b - a)
  return sumLargest(mags, gamma)
}

export function sumLargest(sortedDesc: number[], gamma: number): number {
  if (gamma <= 0) return 0
  if (!Number.isFinite(gamma)) return sortedDesc.reduce((a, b) => a + b, 0)
  let rem = gamma
  let total = 0
  for (const v of sortedDesc) {
    if (rem <= 1e-12) break
    const take = Math.min(1, rem)
    total += v * take
    rem -= take
  }
  return total
}

export function boxCornerProbability(factors: FactorDef[]): number {
  const n = factors.length
  if (n === 0) return 1
  return Math.pow(2, -n)
}

function mulberry32(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * 场景集：显式离散概率分布。
 * 概率来自权重归一化，尾差归到最后一个场景，保证总和恰为 1。
 */
export function buildScenarioSet(
  factors: FactorDef[],
  properties: PropertyId[],
  seed = 20261124,
  uniformCount = 20,
): ScenarioSet {
  const rnd = mulberry32(seed)
  const rows: Array<{ kind: Scenario['kind']; label: string; factors: Record<string, number>; weight: number }> = []
  const zero = () => {
    const o: Record<string, number> = {}
    for (const f of factors) o[f.key] = 0
    return o
  }
  const batches = [...new Set(factors.map((f) => f.batchId))]
  const lotsWithFactors = [...new Set(factors.filter((f) => f.lotId).map((f) => f.lotId!))]

  rows.push({ kind: 'nominal', label: '名义：所有检测值', factors: zero(), weight: 0.16 })

  const cornerPlus = zero()
  for (const f of factors) cornerPlus[f.key] = 1
  rows.push({ kind: 'stress', label: '全部误差同时偏正（箱式上角点）', factors: cornerPlus, weight: 0.002 })
  const cornerMinus = zero()
  for (const f of factors) cornerMinus[f.key] = -1
  rows.push({ kind: 'stress', label: '全部误差同时偏负（箱式下角点）', factors: cornerMinus, weight: 0.002 })

  const driftPlus = zero()
  for (const f of factors) if (f.kind === 'shared') driftPlus[f.key] = 1
  rows.push({ kind: 'stress', label: '全批共同偏移 +1（同批共因）', factors: driftPlus, weight: 0.01 })
  const driftMinus = zero()
  for (const f of factors) if (f.kind === 'shared') driftMinus[f.key] = -1
  rows.push({ kind: 'stress', label: '全批共同偏移 −1（同批共因）', factors: driftMinus, weight: 0.01 })

  for (const p of properties) {
    for (const sign of [1, -1] as const) {
      const v = zero()
      for (const f of factors) if (f.property === p) v[f.key] = sign
      rows.push({
        kind: 'stress',
        label: `${p} 相关误差整体${sign > 0 ? '偏正' : '偏负'}`,
        factors: v,
        weight: 0.008,
      })
    }
  }

  for (const batchId of batches.slice(0, 2)) {
    for (const sign of [1, -1] as const) {
      const v = zero()
      for (const f of factors) if (f.batchId === batchId) v[f.key] = sign
      rows.push({
        kind: 'stress',
        label: `批次 ${batchId} 整体${sign > 0 ? '偏正' : '偏负'}`,
        factors: v,
        weight: 0.006,
      })
    }
  }

  for (const lotId of lotsWithFactors.slice(0, 4)) {
    const v = zero()
    for (const f of factors) if (f.lotId === lotId) v[f.key] = 1
    rows.push({ kind: 'tail', label: `${lotId} 单罐离群 +1`, factors: v, weight: 0.004 })
    const w = zero()
    for (const f of factors) if (f.lotId === lotId) w[f.key] = -1
    rows.push({ kind: 'tail', label: `${lotId} 单罐离群 −1`, factors: w, weight: 0.004 })
  }

  const uniformWeight = 0.72
  for (let i = 0; i < uniformCount; i++) {
    const v: Record<string, number> = {}
    for (const f of factors) v[f.key] = rnd() * 2 - 1
    rows.push({
      kind: 'uniform',
      label: `均匀抽样 #${i + 1}`,
      factors: v,
      weight: uniformWeight / uniformCount,
    })
  }

  const total = rows.reduce((a, r) => a + r.weight, 0)
  const scenarios: Scenario[] = rows.map((r, i) => ({
    id: `S${i + 1}`,
    kind: r.kind,
    label: r.label,
    factors: r.factors,
    probability:
      i === rows.length - 1
        ? round12(1 - rows.slice(0, -1).reduce((a, x) => a + x.weight / total, 0))
        : round12(r.weight / total),
  }))

  return {
    id: `ENS-${seed}`,
    seed,
    properties,
    scenarios,
    note:
      '显式离散场景表：命名极值场景、单罐离群与均匀抽样；概率按权重归一化。' +
      '该分布为演示用虚构数据，不代表真实装置统计，也不用于连接生产控制系统。',
  }
}

function round12(x: number) {
  return Math.round(x * 1e12) / 1e12
}
