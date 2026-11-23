import { property } from '../shared/catalog.ts'
import type { Dir, PropertyId } from '../shared/types.ts'

export const money = (v: number, digits = 0) =>
  `¥${v.toLocaleString('zh-CN', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`

export const pct = (v: number, digits = 1) => `${(v * 100).toFixed(digits)}%`

export const qty = (v: number, digits = 1) =>
  `${v.toLocaleString('zh-CN', { minimumFractionDigits: digits, maximumFractionDigits: digits })} t`

export function propValue(id: PropertyId, v: number | null | undefined, withUnit = true): string {
  if (v == null || !Number.isFinite(v)) return '—'
  const p = property(id)
  return `${v.toFixed(p.decimals)}${withUnit && p.unit ? ` ${p.unit}` : ''}`
}

export function propLabel(id: PropertyId): string {
  const p = property(id)
  return p.unit ? `${p.name} ${p.short}（${p.unit}）` : `${p.name} ${p.short}`
}

export const dirLabel = (d: Dir) => (d === 'min' ? '下限' : '上限')

export function signed(v: number, digits = 2): string {
  if (!Number.isFinite(v)) return '—'
  const s = v.toFixed(digits)
  return v > 0 ? `+${s}` : s
}
