/** 领域模型：虚构罐区混料分析。所有数值仅用于演示，不连接真实生产设备。 */

export type PropertyId = 'RON' | 'S' | 'D' | 'BZ' | 'OLE'

export interface PropertyDef {
  id: PropertyId
  name: string
  short: string
  unit: string
  decimals: number
  /** higher: 越大越好（下限通常关键）；lower: 越小越好；window: 双向 */
  better: 'higher' | 'lower' | 'window'
}

export interface AssayCell {
  /** 检测中心值（报告值） */
  nominal: number
  /** 检测区间半宽：报告值 ± halfWidth */
  halfWidth: number
  /** 是否已完成该项检测；缺检测的原料不能用于含该指标的规格 */
  hasAssay: boolean
}

export type Assay = Partial<Record<PropertyId, AssayCell>>

export interface Lot {
  id: string
  material: string
  batchId: string
  tankId: string
  /** 库存量，t */
  quantity: number
  /** 到厂成本，元/t */
  cost: number
  assay: Assay
  note?: string
}

export interface Heel {
  tankId: string
  /** 罐底余量，t（计入产品总量，不参与决策） */
  quantity: number
  /** 余量视为独立批次，其成分同样只有检测区间 */
  batchId: string
  assay: Assay
  material: string
}

export interface SpecSet {
  id: string
  name: string
  /** 调和总量，t（含罐底余量） */
  volume: number
  limits: Array<{
    property: PropertyId
    min: number | null
    max: number | null
  }>
  note?: string
}

export type Dir = 'min' | 'max'

export interface ChanceMode {
  kind: 'chance'
  /** 要求场景集上满足的概率下限，例如 0.9 */
  alpha: number
}

export type FixtureId = 'BASE' | 'MISSING' | 'TIGHT'

export type PlanMode =
  | { kind: 'nominal' }
  | { kind: 'box' }
  | { kind: 'budget'; gamma: number }
  | ChanceMode

export interface Allocation {
  lotId: string
  quantity: number
}

export interface Reservation {
  id: string
  planId: string
  lotId: string
  quantity: number
  status: 'active' | 'released' | 'committed'
  createdAt: string
  operator: string
  releasedAt?: string
}

export interface Order {
  id: string
  planId: string
  specSetId: string
  volume: number
  allocations: Allocation[]
  createdAt: string
  operator: string
}

export interface Scenario {
  id: string
  /** 场景概率，场景集内总和为 1 */
  probability: number
  kind: 'uniform' | 'tail' | 'stress' | 'nominal'
  label: string
  /** factorKey -> ξ ∈ [-1,1] */
  factors: Record<string, number>
}

export interface ScenarioSet {
  id: string
  seed: number
  properties: PropertyId[]
  scenarios: Scenario[]
  note: string
}

export interface PlanPayload {
  id: string
  specSetId: string
  mode: PlanMode
  rho: number
  volume: number
  allocations: Allocation[]
  basedOnVersion: number
  /** 客户端报告的原料成本合计（元），服务端会重算校验 */
  cost: number
  operator?: string
}

export interface AvailabilityRow {
  lotId: string
  quantity: number
  committed: number
  reserved: number
  available: number
}

export interface PublicState {
  version: number
  lots: Lot[]
  heel: Heel
  specSets: SpecSet[]
  activeSpecSetId: string
  rho: number
  reservations: Reservation[]
  orders: Order[]
  availability: AvailabilityRow[]
  audit: Array<{ at: string; actor: string; action: string; detail: string }>
  fixture: string
}

export interface ViolationDetail {
  property: PropertyId
  dir: Dir
  limit: number
  value: number
  /** 归一化超出量（超出值 / |limit| 或给定的尺度） */
  excess: number
  excessAbs: number
}

export interface ScenarioEvaluation {
  scenario: Scenario
  qualities: Record<string, number>
  violations: ViolationDetail[]
  worst: ViolationDetail | null
}

export interface BindingInfo {
  /** 约束名称，例如 spec:RON:min */
  row: string
  property: PropertyId
  dir: Dir
  limit: number
  /** 影子价格：限额放宽 1 个指标单位对应的原料成本变化（元/吨产品）。负值表示放宽可降本 */
  shadowPerUnit: number
  /** 放宽 0.1 个指标单位的总成本变化（元，整罐） */
  shadowPerTenthTotal: number
  active: boolean
  nominalValue: number
  worstValue: number
  slackNominal: number
  slackWorst: number
}

export interface LotUsage {
  lotId: string
  quantity: number
  share: number
  cost: number
  available: number
  bindingCapacity: boolean
  capacityShadowPerTonne: number
  reducedCost: number
  usedUp: boolean
}

// ---------------------------------------------------------------------------
// 求解结果
// ---------------------------------------------------------------------------

export interface PlanAllocation {
  lotId: string
  material: string
  batchId: string
  tankId: string
  quantity: number
  shareOfFresh: number
  costPerTonne: number
  cost: number
}

export interface LimitReport {
  property: PropertyId
  dir: Dir
  limit: number
  nominal: number
  guaranteed: number
  ensembleWorst: number
  slackNominal: number
  slackGuaranteed: number
  marginUsedShare: number
  active: boolean
  /** 改变该限额 0.1 个指标单位时，整罐原料成本的变化（元）；正=放松可省钱 */
  costPerTenthTotal: number | null
  costPerTenthPerTonne: number | null
  /** 不可行诊断：在其余约束下该指标能做到的最好值 */
  bestAchievable: number | null
  bestAchievableFeasible: boolean | null
}

export interface LotReport {
  lotId: string
  quantity: number
  available: number
  usedUp: boolean
  costPerTonne: number
  /** 多 10 t 可用量的整罐成本变化（元），负=增加可用量可降本 */
  costPerTenTonnes: number | null
  /** 受限可用量约束的影子价格（元/t） */
  capacityValuePerTonne: number | null
}

export interface AdversarialFactor {
  key: string
  label: string
  property: PropertyId
  xi: number
  contribution: number
}

export interface ViolationReport {
  property: PropertyId
  dir: Dir
  limit: number
  value: number
  excessAbs: number
  excessNorm: number
}

export interface ScenarioViolation {
  scenarioId: string
  label: string
  kind: Scenario['kind']
  probability: number
  l1: number
  violations: ViolationReport[]
  worst: ViolationReport | null
}

export interface RiskReport {
  scenarioSetId: string
  scenarioCount: number
  evaluated: number
  satisfiedProbability: number
  violatedProbability: number
  perPropertyViolationProbability: Record<string, number>
  worstScenario: ScenarioViolation | null
  violations: ScenarioViolation[]
}

export interface InfeasibilityDiagnosis {
  headline: string
  reasons: Array<{
    property?: PropertyId
    dir?: Dir
    limit?: number
    bestAvailable?: number
    message: string
  }>
  candidateShortfall: number | null
}

export interface PlanResult {
  id: string
  specSetId: string
  specName: string
  mode: PlanMode
  gammaEffective: number
  chanceTarget: number | null
  rho: number
  volume: number
  freshVolume: number
  heelQuantity: number
  status: 'optimal' | 'infeasible'
  message?: string
  totalCost: number
  unitCost: number
  allocations: PlanAllocation[]
  nominal: Record<string, number>
  guaranteed: Record<string, number>
  ensembleWorst: Record<string, number>
  adversarial: {
    method: 'scenario' | 'box' | 'budget'
    gamma: number
    byProperty: Record<string, AdversarialFactor[]>
  }
  limits: LimitReport[]
  lots: LotReport[]
  risk: RiskReport
  premiumPerTonne: number
  premiumPct: number
  nominalUnitCost: number | null
  boxCornerProbability: number
  factorCount: number
  basedOnVersion: number
  solvedAt: string
  excludedLots: Array<{ lotId: string; reason: string }>
  scenarioSet: ScenarioSet
  diagnosis?: InfeasibilityDiagnosis
  availableMap: Record<string, number>
  solveMs: number
  /** 全部原料成本（元），等于 totalCost */
  fixedCost: number
  /** 各指标在名义/最坏方向上的总偏移（t·指标单位），用于“上限为什么不能相加”的说明 */
  reportTotals: {
    plus: Record<string, number>
    minus: Record<string, number>
    /** 箱式/预算两种参照下的最坏偏移（与当前所选模式无关），供解释表格使用 */
    budget: Record<string, number>
    budgetGamma: number
  }
  nominalStatus: 'Optimal' | 'Infeasible' | 'Other'
}

export interface SolveRequest {
  specSetId: string
  mode: PlanMode
  rho: number
  /** 不传则用罐区当前状态；传则排除该方案的预留后计算 */
  excludePlanId?: string
  /** 基线版本，用于确认时的乐观并发控制 */
  clientVersion?: number
  /** 可选：覆盖部分原料的检测区间（前端编辑） */
  lotOverrides?: Record<string, Partial<Record<PropertyId, AssayCell>>>
}
