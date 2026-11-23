import type { Assay, Heel, Lot, PropertyId, SpecSet } from './types.ts'
import { RHO_DEFAULT } from './uncertainty.ts'

const assay = (
  nominal: Partial<Record<PropertyId, number>>,
  half: Partial<Record<PropertyId, number>>,
  missing: PropertyId[] = [],
): Assay => {
  const out: Assay = {}
  for (const [k, v] of Object.entries(nominal)) {
    const p = k as PropertyId
    out[p] = {
      nominal: v as number,
      halfWidth: half[p] ?? 0,
      hasAssay: !missing.includes(p),
    }
  }
  return out
}

export interface Fixture {
  id: string
  name: string
  description: string
  lots: Lot[]
  heel: Heel
  specSets: SpecSet[]
}

const baseLots: Lot[] = [
  {
    id: 'RA-01',
    material: '重整生成油',
    batchId: 'G-RF',
    tankId: 'T-101',
    quantity: 300,
    cost: 6980,
    assay: assay(
      { RON: 101.5, S: 1.5, D: 775, BZ: 0.6, OLE: 2.0 },
      { RON: 0.6, S: 0.4, D: 2.0, BZ: 0.1, OLE: 0.4 },
    ),
    note: '高辛烷值、低硫；苯偏高，做苯受限牌号时用量需谨慎。',
  },
  {
    id: 'RA-02',
    material: '重整生成油',
    batchId: 'G-RF',
    tankId: 'T-102',
    quantity: 220,
    cost: 6980,
    assay: assay(
      { RON: 101.0, S: 1.4, D: 774, BZ: 0.58, OLE: 2.2 },
      { RON: 0.8, S: 0.5, D: 2.2, BZ: 0.12, OLE: 0.5 },
    ),
    note: '与 RA-01 同批检测：两者检测误差存在共同偏移（ρ 份额）。',
  },
  {
    id: 'FC-01',
    material: '催化裂化汽油',
    batchId: 'G-FC',
    tankId: 'T-201',
    quantity: 520,
    cost: 6320,
    assay: assay(
      { RON: 91.5, S: 22, D: 735, BZ: 0.85, OLE: 28 },
      { RON: 0.7, S: 2.4, D: 2.0, BZ: 0.1, OLE: 2.5 },
    ),
    note: '便宜但硫、苯、烯烃都高，是典型“把上限一起吃满”的风险源。',
  },
  {
    id: 'FC-02',
    material: '催化裂化汽油',
    batchId: 'G-FC',
    tankId: 'T-202',
    quantity: 300,
    cost: 6320,
    assay: assay(
      { RON: 90.8, S: 27, D: 738, BZ: 0.95, OLE: 32 },
      { RON: 0.9, S: 2.8, D: 2.2, BZ: 0.14, OLE: 3.0 },
    ),
    note: '与 FC-01 同批：共同偏移会同时抬高两罐的硫/烯烃。',
  },
  {
    id: 'AK-01',
    material: '烷基化油',
    batchId: 'G-AK',
    tankId: 'T-301',
    quantity: 340,
    cost: 7620,
    assay: assay(
      { RON: 96.5, S: 1.0, D: 700, BZ: 0.1, OLE: 1.0 },
      { RON: 0.5, S: 0.5, D: 2.0, BZ: 0.04, OLE: 0.4 },
    ),
    note: '低硫低烯烃，但密度低，会拖低密度下限。',
  },
  {
    id: 'MT-01',
    material: 'MTBE',
    batchId: 'G-MT',
    tankId: 'T-401',
    quantity: 160,
    cost: 8480,
    assay: assay(
      { RON: 118, S: 0, D: 745, BZ: 0, OLE: 0 },
      { RON: 0.6, S: 0, D: 1.0, BZ: 0, OLE: 0 },
    ),
    note: '调辛烷值最有效，但单价最高、库存有限，是典型的“稀缺高价值”原料。',
  },
  {
    id: 'TL-01',
    material: '甲苯',
    batchId: 'G-TL',
    tankId: 'T-402',
    quantity: 140,
    cost: 6650,
    assay: assay(
      { RON: 112, S: 1.0, D: 866, BZ: 0, OLE: 0 },
      { RON: 0.6, S: 0.3, D: 2.0, BZ: 0, OLE: 0 },
    ),
    note: '密度极高：可托住密度下限，但会顶到密度上限。',
  },
  {
    id: 'LN-01',
    material: '轻石脑油',
    batchId: 'G-LN',
    tankId: 'T-501',
    quantity: 260,
    cost: 5850,
    assay: assay(
      { RON: 68, S: 15, D: 650, BZ: 0.2, OLE: 1.5 },
      { RON: 1.2, S: 1.5, D: 3.0, BZ: 0.1, OLE: 0.6 },
    ),
    note: '最便宜的稀释剂，但辛烷值低、密度低。',
  },
]

const baseHeel: Heel = {
  tankId: 'TK-BLEND',
  material: '上一批调和余量',
  batchId: 'G-HEEL',
  quantity: 140,
  assay: assay(
    { RON: 93.5, S: 9, D: 742, BZ: 0.35, OLE: 20 },
    { RON: 0.5, S: 1.5, D: 1.5, BZ: 0.08, OLE: 1.5 },
  ),
}

const specSets: SpecSet[] = [
  {
    id: 'SPEC-92',
    name: '92# 车用汽油（国VIB）',
    volume: 1000,
    limits: [
      { property: 'RON', min: 95.5, max: null },
      { property: 'S', min: null, max: 9.0 },
      { property: 'D', min: 720, max: 775 },
      { property: 'BZ', min: null, max: 0.8 },
      { property: 'OLE', min: null, max: 18 },
    ],
    note: 'RON 留 3.5 个余量（标称 92 加安全余量）；密度为窗口约束，两侧都可能限制。',
  },
  {
    id: 'SPEC-95',
    name: '95# 车用汽油（tight S）',
    volume: 1000,
    limits: [
      { property: 'RON', min: 97.0, max: null },
      { property: 'S', min: null, max: 6.0 },
      { property: 'D', min: 720, max: 775 },
      { property: 'BZ', min: null, max: 0.8 },
      { property: 'OLE', min: null, max: 18 },
    ],
    note: '同罐区、更严的硫上限；用于演示“库存竞争”下两个牌号抢同一批原料。',
  },
  {
    id: 'SPEC-IMPOSSIBLE',
    name: '不可行牌号（硫 2 mg/kg）',
    volume: 1000,
    limits: [
      { property: 'RON', min: 95.5, max: null },
      { property: 'S', min: null, max: 2.0 },
      { property: 'D', min: 720, max: 775 },
      { property: 'BZ', min: null, max: 0.8 },
    ],
    note: '故意设置超出所有可用原料能力的硫上限，用来看不可行诊断。',
  },
]

export const BASE_FIXTURE: Fixture = {
  id: 'BASE',
  name: '基准罐区（虚构）',
  description:
    '8 罐新鲜原料 + 140 t 罐底余量，目标 1000 t 产品。数据全部虚构，仅用于演示，不连接真实生产设备。',
  lots: baseLots,
  heel: baseHeel,
  specSets,
}

function clone<T>(x: T): T {
  return JSON.parse(JSON.stringify(x))
}

const missingAssayLots: Lot[] = clone(baseLots)
for (const lot of missingAssayLots) {
  if (lot.id === 'FC-02') {
    lot.assay.OLE = { nominal: 0, halfWidth: 0, hasAssay: false }
    lot.note = 'OLE 检测缺失：含烯烃上限的牌号不能使用该罐。'
  }
  if (lot.id === 'TL-01') {
    lot.assay.S = { nominal: 0, halfWidth: 0, hasAssay: false }
    lot.note = '硫检测缺失（检测仪故障），含硫上限的牌号会排除该罐。'
  }
}

export const MISSING_ASSAY_FIXTURE: Fixture = {
  id: 'MISSING',
  name: '缺检测（虚构）',
  description:
    'FC-02 缺烯烃检测、TL-01 缺硫检测。求解器必须把这些罐从相应牌号的候选集中剔除，而不是把缺失当成 0。',
  lots: missingAssayLots,
  heel: baseHeel,
  specSets: clone(specSets),
}

const tightLots: Lot[] = clone(baseLots)
for (const lot of tightLots) {
  if (lot.id === 'FC-01') lot.quantity = 120
  if (lot.id === 'FC-02') lot.quantity = 60
  if (lot.id === 'AK-01') lot.quantity = 90
  if (lot.id === 'MT-01') lot.quantity = 45
  if (lot.id === 'RA-02') lot.quantity = 80
}
const tightHeel: Heel = clone(baseHeel)
tightHeel.quantity = 260
tightHeel.assay = assay(
  { RON: 92.0, S: 14, D: 748, BZ: 0.45, OLE: 22 },
  { RON: 0.7, S: 1.8, D: 1.5, BZ: 0.1, OLE: 1.8 },
)

export const TIGHT_FIXTURE: Fixture = {
  id: 'TIGHT',
  name: '库存竞争（虚构）',
  description:
    '余量 260 t、可用新鲜原料大幅压缩。两个牌号同时求方案时会争夺同一批 MTBE / 烷基化油；方案确认后会预留库存，另一张单必须重解。',
  lots: tightLots,
  heel: tightHeel,
  specSets: clone(specSets),
}

export const FIXTURES: Record<string, Fixture> = {
  BASE: BASE_FIXTURE,
  MISSING: MISSING_ASSAY_FIXTURE,
  TIGHT: TIGHT_FIXTURE,
}

export const DEFAULT_RHO = RHO_DEFAULT
