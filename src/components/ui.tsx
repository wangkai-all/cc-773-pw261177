import type { ReactNode } from 'react'

export function Card(props: {
  title: ReactNode
  hint?: ReactNode
  actions?: ReactNode
  bodyClass?: string
  children: ReactNode
}) {
  return (
    <section className="card">
      <header>
        <h2>{props.title}</h2>
        {props.hint ? <span className="hint">{props.hint}</span> : null}
        <span className="spacer" />
        {props.actions}
      </header>
      <div className={`body${props.bodyClass ? ` ${props.bodyClass}` : ''}`}>{props.children}</div>
    </section>
  )
}

export function Kpi(props: {
  label: ReactNode
  value: ReactNode
  unit?: string
  note?: ReactNode
  tone?: 'good' | 'warn' | 'bad'
}) {
  return (
    <div className={`kpi${props.tone ? ` ${props.tone}` : ''}`}>
      <div className="label">{props.label}</div>
      <div className="value">
        {props.value}
        {props.unit ? <small>{props.unit}</small> : null}
      </div>
      {props.note ? <div className="note">{props.note}</div> : null}
    </div>
  )
}

export function Pill(props: { tone: 'good' | 'warn' | 'bad' | 'neutral'; children: ReactNode }) {
  return <span className={`pill ${props.tone}`}>{props.children}</span>
}

export function Bar(props: { value: number; tone?: 'good' | 'warn' | 'bad'; title?: string }) {
  const v = Math.max(0, Math.min(1, props.value))
  return (
    <div className={`bar${props.tone ? ` ${props.tone}` : ''}`} title={props.title}>
      <span style={{ width: `${(v * 100).toFixed(1)}%` }} />
    </div>
  )
}

export function Seg<T extends string | number>(props: {
  options: Array<{ value: T; label: ReactNode; title?: string }>
  value: T
  onChange: (v: T) => void
  ariaLabel?: string
}) {
  return (
    <div className="seg" role="group" aria-label={props.ariaLabel}>
      {props.options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          aria-pressed={o.value === props.value}
          title={o.title}
          onClick={() => props.onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

export function Empty(props: { children: ReactNode }) {
  return <div className="muted small" style={{ padding: '10px 0' }}>{props.children}</div>
}
