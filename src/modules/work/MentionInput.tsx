import { forwardRef, useImperativeHandle, useMemo, useRef, useState, type ReactNode } from 'react'
import { usePeopleMap, type DirectoryPerson } from '@/api/core'
import { Avatar } from '@/ui'
import { cn } from '@/lib/utils'

export interface MentionInputHandle {
  focus: () => void
  clear: () => void
}

/** Textarea with @mention autocomplete from the people directory.
 *  Mentions are inserted as "@Full Name"; `mentionsIn(text)` resolves them back to ids. */
export const MentionInput = forwardRef<MentionInputHandle, {
  value: string
  onChange: (v: string) => void
  onSubmit?: () => void
  placeholder?: string
  disabled?: boolean
  rows?: number
  autoFocus?: boolean
}>(function MentionInput({ value, onChange, onSubmit, placeholder, disabled, rows = 3, autoFocus }, ref) {
  const { data } = usePeopleMap()
  const ta = useRef<HTMLTextAreaElement>(null)
  const [query, setQuery] = useState<{ q: string; start: number } | null>(null)
  const [active, setActive] = useState(0)
  useImperativeHandle(ref, () => ({ focus: () => ta.current?.focus(), clear: () => onChange('') }))

  const people = useMemo(() => (data ?? []).filter((p) => p.status === 'active'), [data])
  const matches = useMemo(() => {
    if (!query) return []
    const q = query.q.toLowerCase()
    return people.filter((p) => p.name.toLowerCase().split(/\s+/).some((w) => w.startsWith(q)) || p.name.toLowerCase().startsWith(q)).slice(0, 6)
  }, [people, query])

  const detect = (text: string, caret: number) => {
    const before = text.slice(0, caret)
    const m = before.match(/(^|\s)@([\p{L}.'-]{0,24})$/u)
    if (m) {
      setQuery({ q: m[2], start: caret - m[2].length - 1 })
      setActive(0)
    } else setQuery(null)
  }

  const pick = (p: DirectoryPerson) => {
    if (!query || !ta.current) return
    const caret = ta.current.selectionStart ?? value.length
    const next = value.slice(0, query.start) + '@' + p.name + ' ' + value.slice(caret)
    onChange(next)
    setQuery(null)
    const pos = query.start + p.name.length + 2
    requestAnimationFrame(() => {
      ta.current?.focus()
      ta.current?.setSelectionRange(pos, pos)
    })
  }

  return (
    <div className="relative">
      <textarea
        ref={ta}
        rows={rows}
        value={value}
        disabled={disabled}
        autoFocus={autoFocus}
        placeholder={placeholder}
        aria-label={placeholder ?? 'Comment'}
        onChange={(e) => {
          onChange(e.target.value)
          detect(e.target.value, e.target.selectionStart ?? e.target.value.length)
        }}
        onKeyDown={(e) => {
          if (query && matches.length) {
            if (e.key === 'ArrowDown') {
              e.preventDefault()
              setActive((a) => (a + 1) % matches.length)
              return
            }
            if (e.key === 'ArrowUp') {
              e.preventDefault()
              setActive((a) => (a - 1 + matches.length) % matches.length)
              return
            }
            if (e.key === 'Enter' || e.key === 'Tab') {
              e.preventDefault()
              pick(matches[active])
              return
            }
            if (e.key === 'Escape') {
              e.preventDefault()
              setQuery(null)
              return
            }
          }
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault()
            onSubmit?.()
          }
        }}
        onBlur={() => setTimeout(() => setQuery(null), 150)}
        className="block w-full resize-none rounded-md border border-line-strong/80 bg-surface px-3 py-2.5 text-[14px] leading-relaxed text-ink outline-none transition placeholder:text-ink-3 focus:border-brand focus:ring-[3px] focus:ring-brand/15 disabled:bg-surface-2"
      />
      {query && matches.length > 0 && (
        <div role="listbox" className="absolute bottom-full left-0 z-[70] mb-1 w-[min(300px,100%)] overflow-hidden rounded-lg border border-line bg-elevated p-1 shadow-lg animate-[fade_.12s_ease]">
          <div className="px-2.5 pb-1 pt-1.5 text-[12px] text-ink-3">Mention someone</div>
          {matches.map((p, i) => (
            <button
              key={p.id}
              type="button"
              role="option"
              aria-selected={i === active}
              onMouseDown={(e) => {
                e.preventDefault()
                pick(p)
              }}
              onMouseEnter={() => setActive(i)}
              className={cn('flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left', i === active && 'bg-surface-2')}
            >
              <Avatar name={p.name} hue={p.avatar_hue} size={24} />
              <span className="min-w-0">
                <span className="block truncate text-[13.5px] font-medium">{p.name}</span>
                <span className="block truncate text-[11.5px] text-ink-3">{p.title}</span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
})

export function mentionsIn(text: string, people: DirectoryPerson[]): string[] {
  return people.filter((p) => text.includes('@' + p.name)).map((p) => p.id)
}

/** Renders comment text with @Full Name mentions highlighted and links clickable. */
export function RichText({ text, names }: { text: string; names: string[] }) {
  const parts: ReactNode[] = []
  const sorted = [...names].sort((a, b) => b.length - a.length).map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  const re = new RegExp(`(${sorted.length ? sorted.map((n) => '@' + n).join('|') + '|' : ''}https?://\\S+)`, 'g')
  let last = 0
  let m: RegExpExecArray | null
  let k = 0
  while ((m = re.exec(text))) {
    if (m.index > last) parts.push(text.slice(last, m.index))
    const tok = m[0]
    if (tok.startsWith('@')) parts.push(<span key={k++} className="rounded bg-brand-soft px-1 font-semibold text-brand-text">{tok}</span>)
    else
      parts.push(
        <a key={k++} href={tok} target="_blank" rel="noreferrer" className="break-all font-medium text-brand-text underline underline-offset-2">
          {tok}
        </a>,
      )
    last = m.index + tok.length
  }
  if (last < text.length) parts.push(text.slice(last))
  return <span className="whitespace-pre-wrap break-words">{parts}</span>
}
