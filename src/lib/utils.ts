import { clsx, type ClassValue } from 'clsx'

export function cn(...v: ClassValue[]) {
  return clsx(v)
}

export function initials(name: string) {
  const p = name.trim().split(/\s+/)
  return ((p[0]?.[0] ?? '') + (p.length > 1 ? p[p.length - 1][0] : '')).toUpperCase()
}

export function plural(n: number, one: string, many = one + 's') {
  return `${n} ${n === 1 ? one : many}`
}

export function groupBy<T, K extends string | number>(arr: T[], key: (t: T) => K): Record<K, T[]> {
  const out = {} as Record<K, T[]>
  for (const x of arr) (out[key(x)] ??= []).push(x)
  return out
}

export function sumBy<T>(arr: T[], f: (t: T) => number) {
  return arr.reduce((s, x) => s + (f(x) || 0), 0)
}

export function uniq<T>(arr: T[]) {
  return [...new Set(arr)]
}

export function debounce<A extends unknown[]>(fn: (...a: A) => void, ms: number) {
  let t: ReturnType<typeof setTimeout>
  return (...a: A) => {
    clearTimeout(t)
    t = setTimeout(() => fn(...a), ms)
  }
}

/** Save a generated file. Inside the hosted preview the `downloads` capability asks the viewer;
 *  in the real app (or when unavailable) a normal browser download is used. */
export async function saveFile(filename: string, data: Blob | string, mime = 'application/octet-stream'): Promise<'saved' | 'declined' | 'failed'> {
  const blob = typeof data === 'string' ? new Blob([data], { type: mime }) : data
  const w = window as unknown as { claude?: { use?: (n: string) => Promise<unknown> } }
  if (w.claude?.use && window.parent !== window) {
    try {
      const dl = (await Promise.race([w.claude.use('downloads'), new Promise((r) => setTimeout(() => r(null), 4000))])) as { save: (r: { filename: string; data: Blob }) => Promise<unknown> } | null
      if (dl) {
        await dl.save({ filename, data: blob })
        return 'saved'
      }
    } catch (e) {
      const code = (e as { code?: string })?.code
      if (code === 'declined') return 'declined'
    }
  }
  try {
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 4000)
    return 'saved'
  } catch {
    return 'failed'
  }
}

export function toCSV(rows: (string | number | boolean | null | undefined)[][]): string {
  return rows
    .map((r) =>
      r
        .map((c) => {
          const s = c === null || c === undefined ? '' : String(c)
          return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
        })
        .join(','),
    )
    .join('\n')
}

export function parseCSV(text: string): string[][] {
  const out: string[][] = []
  let row: string[] = []
  let cell = ''
  let q = false
  const sep = text.includes('\t') && !text.includes(',') ? '\t' : ','
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (q) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"'
        i++
      } else if (ch === '"') q = false
      else cell += ch
    } else if (ch === '"') q = true
    else if (ch === sep) {
      row.push(cell)
      cell = ''
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++
      row.push(cell)
      out.push(row)
      row = []
      cell = ''
    } else cell += ch
  }
  if (cell || row.length) {
    row.push(cell)
    out.push(row)
  }
  return out.filter((r) => r.some((c) => c.trim() !== ''))
}

export function readFileAsDataURL(f: File): Promise<string> {
  return new Promise((res, rej) => {
    const r = new FileReader()
    r.onload = () => res(String(r.result))
    r.onerror = () => rej(r.error)
    r.readAsDataURL(f)
  })
}
export function readFileAsText(f: File): Promise<string> {
  return new Promise((res, rej) => {
    const r = new FileReader()
    r.onload = () => res(String(r.result))
    r.onerror = () => rej(r.error)
    r.readAsText(f)
  })
}
