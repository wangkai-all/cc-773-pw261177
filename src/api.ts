import type {
  AssayCell,
  FixtureId,
  PlanMode,
  PlanResult,
  PropertyId,
  PublicState,
  SolveRequest,
} from '../shared/types.ts'
import type { EnumerationResult, WorstCaseCheck } from '../shared/enumerate.ts'

/** HTTP 头只允许 ISO-8859-1，中文操作员名需要百分号编码；服务端会解码。 */
export function encodeHeader(v: string): string {
  return encodeURIComponent(v)
}

export class ApiError extends Error {
  status: number
  body: any
  constructor(status: number, message: string, body: any) {
    super(message)
    this.status = status
    this.body = body
  }
}

async function request<T>(
  path: string,
  init: RequestInit & { operator?: string } = {},
): Promise<T> {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (init.operator) headers['x-operator'] = encodeHeader(init.operator)
  if (init.headers) Object.assign(headers, init.headers as Record<string, string>)
  const res = await fetch(path, { ...init, headers })
  const text = await res.text()
  let body: any = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = { error: text }
  }
  if (!res.ok) {
    throw new ApiError(res.status, body?.error ?? `请求失败 (${res.status})`, body)
  }
  return body as T
}

export interface SolveResponse {
  result: PlanResult
  excluded: Array<{ lotId: string; reason: string }>
  elapsedMs: number
}

export interface ConfirmSuccess {
  ok: true
  orderId: string
  reservationIds: string[]
  state: PublicState
}

export interface ConfirmFailure {
  ok: false
  status: number
  error: string
  detail?: any
  state?: PublicState
}

export interface VerifyResponse {
  planId: string
  method: 'box' | 'budget' | 'none'
  gamma: number
  checks: WorstCaseCheck[]
  enumeration: EnumerationResult
  lp: { totalCost: number; unitCost: number; feasibleLots: string[] }
  availableAtSolve: Record<string, number>
  notes: string[]
}

export const api = {
  state: () => request<PublicState>('/api/state'),

  solve: (body: SolveRequest, operator: string) =>
    request<SolveResponse>('/api/solve', {
      method: 'POST',
      body: JSON.stringify(body),
      operator,
    }),

  confirm: async (
    planId: string,
    body: { clientVersion: number; idempotencyKey?: string },
    operator: string,
  ): Promise<ConfirmSuccess | ConfirmFailure> => {
    const res = await fetch(`/api/plans/${planId}/confirm`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-operator': encodeHeader(operator),
        ...(body.idempotencyKey ? { 'idempotency-key': body.idempotencyKey } : {}),
      },
      body: JSON.stringify({ clientVersion: body.clientVersion }),
    })
    const json = await res.json().catch(() => ({}))
    if (res.ok) return { ok: true, ...json }
    return { ok: false, status: res.status, ...json }
  },

  release: (orderId: string, operator: string) =>
    request<{ released: number; state: PublicState }>(`/api/orders/${orderId}/release`, {
      method: 'POST',
      operator,
    }),

  commit: (orderId: string, operator: string) =>
    request<{ committed: number; state: PublicState }>(`/api/orders/${orderId}/commit`, {
      method: 'POST',
      operator,
    }),

  updateAssay: (lotId: string, property: PropertyId, cell: AssayCell, operator: string) =>
    request<PublicState>('/api/assay', {
      method: 'POST',
      body: JSON.stringify({ lotId, property, cell }),
      operator,
    }),

  setRho: (rho: number) =>
    request<PublicState>('/api/rho', { method: 'POST', body: JSON.stringify({ rho }) }),

  reset: (fixture: FixtureId, operator: string) =>
    request<PublicState>('/api/reset', {
      method: 'POST',
      body: JSON.stringify({ fixture }),
      operator,
    }),

  verify: (planId: string, gridStep: number) =>
    request<VerifyResponse>('/api/verify', {
      method: 'POST',
      body: JSON.stringify({ planId, gridStep }),
    }),
}

export const modeKey = (mode: PlanMode): string => {
  if (mode.kind === 'budget') return `budget:${mode.gamma.toFixed(2)}`
  if (mode.kind === 'chance') return `chance:${mode.alpha.toFixed(3)}`
  return mode.kind
}

export const modeLabel = (mode: PlanMode): string => {
  if (mode.kind === 'nominal') return '名义'
  if (mode.kind === 'box') return '箱式最坏'
  if (mode.kind === 'budget') return `预算 Γ=${mode.gamma}`
  return `场景概率 α=${(mode.alpha * 100).toFixed(0)}%`
}
