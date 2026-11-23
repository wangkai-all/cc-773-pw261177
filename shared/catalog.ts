import type { PropertyDef, PropertyId } from './types.ts'

export const PROPERTIES: PropertyDef[] = [
  { id: 'RON', name: '研究法辛烷值', short: 'RON', unit: '', decimals: 1, better: 'higher' },
  { id: 'S', name: '硫含量', short: 'S', unit: 'mg/kg', decimals: 1, better: 'lower' },
  { id: 'D', name: '20℃密度', short: 'D', unit: 'kg/m³', decimals: 0, better: 'window' },
  { id: 'BZ', name: '苯含量', short: 'BZ', unit: '%v', decimals: 2, better: 'lower' },
  { id: 'OLE', name: '烯烃含量', short: 'OLE', unit: '%v', decimals: 1, better: 'lower' },
]

export const PROPERTY_MAP: Record<string, PropertyDef> = Object.fromEntries(
  PROPERTIES.map((p) => [p.id, p]),
)

export const PROPERTY_IDS: PropertyId[] = PROPERTIES.map((p) => p.id)

export function property(id: PropertyId): PropertyDef {
  return PROPERTY_MAP[id]
}

export function fmtProperty(id: PropertyId, value: number, withUnit = true): string {
  const p = property(id)
  const v = value.toFixed(p.decimals)
  return withUnit && p.unit ? `${v} ${p.unit}` : v
}
