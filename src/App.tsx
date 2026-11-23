import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  AssayCell,
  FixtureId,
  PlanMode,
  PlanResult,
  PropertyId,
  PublicState,
} from '../shared/types.ts'
import { api, ApiError, modeLabel, type VerifyResponse } from './api.ts'
import { Controls, type LotEdit } from './components/Controls.tsx'
import { Results } from './components/Results.tsx'
import { ConcurrencyPanel } from './components/Concurrency.tsx'
import { AuditPanel, AvailabilityPanel, OrdersPanel } from './components/Orders.tsx'
import { VerifyPanel } from './components/VerifyPanel.tsx'
import { Card, Empty } from './components/ui.tsx'
import { money, pct } from './format.ts'

type Toast = { id: number; msg: string; tone: 'good' | 'bad' | 'info' }

const OPERATOR = '本机操作员'

export default function App() {
  const [state, setState] = useState<PublicState | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [specId, setSpecId] = useState<string>('')
  const [mode, setMode] = useState<PlanMode>({ kind: 'budget', gamma: 2 })
  const [gamma, setGamma] = useState(2)
  const [alpha, setAlpha] = useState(0.9)
  const [rho, setRho] = useState(0.6)
  const [edits, setEdits] = useState<Record<string, Partial<Record<PropertyId, AssayCell>>>>({})
  const [result, setResult] = useState<PlanResult | null>(null)
  const [resultEdits, setResultEdits] = useState<Record<string, Partial<Record<PropertyId, AssayCell>>>>({})
  const [solving, setSolving] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [verify, setVerify] = useState<VerifyResponse | null>(null)
  const [verifying, setVerifying] = useState(false)
  const [orderBusy, setOrderBusy] = useState<string | null>(null)
  const [toasts, setToasts] = useState<Toast[]>([])
  const toastId = useRef(0)

  const toast = useCallback((msg: string, tone: Toast['tone'] = 'info') => {
    const id = ++toastId.current
    setToasts((t) => [...t, { id, msg, tone }])
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 5200)
  }, [])

  const refresh = useCallback(async () => {
    try {
      const st = await api.state()
      setState(st)
      setSpecId((prev) => prev || st.activeSpecSetId)
      setRho((prev) => (prev === 0.6 ? st.rho : prev))
      setLoadError(null)
      return st
    } catch (e: any) {
      setLoadError(e?.message ?? '无法连接后端')
      return null
    }
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  const dirty = useMemo(() => {
    if (!result) return false
    return (
      JSON.stringify(edits) !== JSON.stringify(resultEdits) ||
      Math.abs(result.rho - rho) > 1e-9 ||
      result.specSetId !== specId ||
      JSON.stringify(result.mode) !== JSON.stringify(mode)
    )
  }, [result, resultEdits, edits, rho, specId, mode])

  const solve = useCallback(async () => {
    if (!state) return
    setSolving(true)
    setVerify(null)
    try {
      const res = await api.solve(
        {
          specSetId: specId || state.activeSpecSetId,
          mode,
          rho,
          lotOverrides: Object.keys(edits).length ? edits : undefined,
        },
        OPERATOR,
      )
      setResult(res.result)
      setResultEdits(edits)
      const st = await api.state()
      setState(st)
      if (res.result.status === 'optimal') {
        toast(`已求得 ${modeLabel(mode)} 方案，${money(res.result.totalCost)}`, 'good')
      } else {
        toast('该规格在当前条件下不可行，见诊断', 'bad')
      }
    } catch (e: any) {
      setResult(null)
      toast(e?.message ?? '求解失败', 'bad')
    } finally {
      setSolving(false)
    }
  }, [state, specId, mode, rho, edits, toast])

  const confirm = useCallback(async () => {
    if (!result || !state) return
    setConfirming(true)
    const idempotencyKey =
      typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : String(Date.now())
    try {
      const out = await api.confirm(result.id, { clientVersion: state.version, idempotencyKey }, OPERATOR)
      if (out.ok) {
        setState(out.state)
        toast(`确认成功：订单 ${out.orderId}，已预留 ${out.reservationIds.length} 条`, 'good')
        setResult(null)
      } else {
        toast(`确认失败（${out.status}）：${out.error}`, 'bad')
        if (out.state) setState(out.state)
        else await refresh()
      }
    } catch (e: any) {
      toast(e?.message ?? '确认请求失败', 'bad')
      await refresh()
    } finally {
      setConfirming(false)
    }
  }, [result, state, toast, refresh])

  const runVerify = useCallback(async () => {
    if (!result) return
    setVerifying(true)
    try {
      const data = await api.verify(result.id, 20)
      setVerify(data)
    } catch (e: any) {
      toast(e?.message ?? '核对失败', 'bad')
    } finally {
      setVerifying(false)
    }
  }, [result, toast])

  const changeEdit = useCallback(
    async (lotId: string, property: PropertyId, cell: LotEdit) => {
      const next = { ...edits, [lotId]: { ...(edits[lotId] ?? {}), [property]: cell } }
      setEdits(next)
      setVerify(null)
      // 同步写回服务器，保证其它操作员/重新求解看到同一区间
      try {
        const st = await api.updateAssay(lotId, property, cell, OPERATOR)
        setState(st)
      } catch (e: any) {
        toast(e?.message ?? '保存检测区间失败', 'bad')
      }
    },
    [edits, toast],
  )

  const resetEdit = useCallback(
    (lotId: string, property: PropertyId) => {
      const next = { ...edits }
      if (next[lotId]) {
        delete next[lotId][property]
        if (!Object.keys(next[lotId]).length) delete next[lotId]
      }
      setEdits(next)
      setVerify(null)
    },
    [edits],
  )

  const resetFixture = useCallback(
    async (fixture: FixtureId) => {
      if (!confirmReset(fixture)) return
      try {
        const st = await api.reset(fixture, OPERATOR)
        setState(st)
        setResult(null)
        setEdits({})
        setResultEdits({})
        setVerify(null)
        setSpecId(st.activeSpecSetId)
        toast('已切换罐区样例并清空预留', 'info')
      } catch (e: any) {
        toast(e?.message ?? '切换样例失败', 'bad')
      }
    },
    [toast],
  )

  const setRhoPersist = useCallback(
    (v: number) => {
      setRho(v)
      api.setRho(v).then(setState).catch((e) => toast(e?.message ?? '保存 ρ 失败', 'bad'))
    },
    [toast],
  )

  const releaseOrder = useCallback(
    async (orderId: string) => {
      setOrderBusy(orderId)
      try {
        const out = await api.release(orderId, OPERATOR)
        setState(out.state)
        toast(`已释放 ${out.released} 条未投料预留`, 'good')
      } catch (e: any) {
        toast(e?.message ?? '释放失败', 'bad')
      } finally {
        setOrderBusy(null)
      }
    },
    [toast],
  )

  const commitOrder = useCallback(
    async (orderId: string) => {
      setOrderBusy(orderId)
      try {
        const out = await api.commit(orderId, OPERATOR)
        setState(out.state)
        toast(`已标记投料，${out.committed} 条预留不可再释放`, 'info')
      } catch (e: any) {
        toast(e?.message ?? '标记投料失败', 'bad')
      } finally {
        setOrderBusy(null)
      }
    },
    [toast],
  )

  if (loadError) {
    return (
      <div className="app">
        <div className="topbar">
          <div className="brand">
            <h1>调和参谋</h1>
            <span className="sub">罐区混料分析</span>
          </div>
        </div>
        <div className="banner bad">
          <b>无法连接后端。</b> 请先启动服务：<code className="mono">npm run build && npm start</code>
          ，或开发时同时运行 <code className="mono">npm run dev:server</code> 与{' '}
          <code className="mono">npm run dev</code>。错误：{loadError}
        </div>
      </div>
    )
  }

  if (!state) {
    return (
      <div className="app">
        <div className="banner">正在载入罐区状态…</div>
      </div>
    )
  }

  const spec = state.specSets.find((s) => s.id === specId) ?? state.specSets[0]

  return (
    <div className="app">
      <div className="topbar">
        <div className="brand">
          <h1>调和参谋</h1>
          <span className="sub">罐区混料分析 · 虚构数据 · 不连接生产设备</span>
        </div>
        <span className="chip" title="状态版本：预留/检测变化时前进">
          v{state.version}
        </span>
        <span className="chip">{state.fixture === 'BASE' ? '基准' : state.fixture === 'MISSING' ? '缺检测' : '库存竞争'}</span>
        <span className="spacer" />
        <span className="small muted">
          {result ? `当前结果：${modeLabel(result.mode)}` : '尚未求解'}
        </span>
      </div>

      {!result ? (
        <div className="banner">
          选择规格与不确定度处理方式，然后求解。所有原料成分只有检测区间；
          名义方案可能在实际偏移下超限，箱式方案过于保守，预算/场景方案给出可权衡的中间选项。
        </div>
      ) : null}

      <div className="layout">
        <div>
          <Controls
            state={state}
            mode={mode}
            onMode={setMode}
            rho={rho}
            onRho={setRhoPersist}
            gamma={gamma}
            alpha={alpha}
            onGamma={setGamma}
            onAlpha={setAlpha}
            specId={spec.id}
            onSpec={(id) => {
              setSpecId(id)
              setResult(null)
              setVerify(null)
            }}
            edits={edits}
            onEdit={changeEdit}
            onResetEdit={resetEdit}
            onResetFixture={resetFixture}
            onSolve={solve}
            solving={solving}
            dirty={dirty}
          />
          <AvailabilityPanel state={state} />
          <AuditPanel state={state} />
        </div>

        <div>
          {result ? (
            <Results
              result={result}
              state={state}
              onConfirm={confirm}
              confirming={confirming}
              onVerify={runVerify}
              verified={Boolean(verify)}
            />
          ) : solving ? (
            <Card title="求解中">
              <Empty>HiGHS 正在求解鲁棒线性规划…</Empty>
            </Card>
          ) : (
            <Card title={`${spec.name}`} hint={`${spec.volume} t`}>
              <div className="small muted" style={{ marginBottom: 8 }}>
                {spec.note}
              </div>
              <div className="stack small">
                {spec.limits.map((l) => (
                  <div key={l.property} className="row">
                    <span style={{ minWidth: 150 }}>{l.property}</span>
                    <span className="mono">
                      {l.min != null ? `≥ ${l.min}` : ''}
                      {l.min != null && l.max != null ? ' 且 ' : ''}
                      {l.max != null ? `≤ ${l.max}` : ''}
                    </span>
                  </div>
                ))}
              </div>
              <div className="divider" />
              <Empty>点左侧「求解最低成本配比」开始。</Empty>
            </Card>
          )}

          <OrdersPanel
            state={state}
            onRelease={releaseOrder}
            onCommit={commitOrder}
            busy={orderBusy}
          />

          <ConcurrencyPanel
            state={state}
            specId={spec.id}
            rho={rho}
            onState={(s) => {
              setState(s)
              setResult(null)
            }}
            onToast={toast}
          />

          <Card title="说明" bodyClass="tight">
            <div className="small muted stack">
              <div>
                本应用使用虚构的罐区库存、检测区间与产品规格，仅用于演示鲁棒混料优化与并发控制，
                <b>不连接任何真实生产设备或系统</b>。
              </div>
              <div>
                指标口径：RON/硫/苯/烯烃按质量加权混合，密度为倒体积加权后的近似（演示用线性化）。
                所有质量的单位均为 t，成本单位为元。
              </div>
              <div>
                场景集：
                {result
                  ? result.status === 'optimal'
                    ? `${result.risk.scenarioCount} 个场景，满足概率 ${pct(result.risk.satisfiedProbability, 1)}`
                    : `${result.risk.scenarioCount} 个场景（当前方案不可行，未评估满足概率）`
                  : '求解后展示'}
                。核对面板可用小规模整数枚举复核最优成本与最坏场景。
              </div>
            </div>
          </Card>
        </div>
      </div>

      <VerifyPanel data={verify} state={state} onClose={() => setVerify(null)} />
      {verifying ? <div className="toast">正在枚举核对…</div> : null}

      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.tone === 'info' ? '' : t.tone}`}>
          {t.msg}
        </div>
      ))}
    </div>
  )
}

function confirmReset(fixture: FixtureId): boolean {
  if (fixture === 'BASE') return true
  const label = fixture === 'MISSING' ? '缺检测' : '库存竞争'
  const ok = typeof window !== 'undefined' ? window.confirm(`切换到「${label}」样例会清空当前预留与订单，继续？`) : true
  return ok
}
