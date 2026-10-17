// Upload validation for files that travel as data: URLs inside JSON bodies (logos, attachments, documents, receipts,
// resumes, contracts…). Applied centrally by the router to every write request (src/mock/server.ts dispatch), so the
// browser demo and the API enforce the same rules:
//  - only base64 data URLs with a syntactically valid media type;
//  - active content is refused (HTML, XHTML, JavaScript, XML that is not SVG, SVG with scripts / event handlers /
//    javascript: links / foreignObject / external references);
//  - the content must match the declared type for formats with a signature (PNG, JPEG, GIF, WebP, PDF, ZIP-based
//    Office files, legacy Office), so a script cannot be smuggled in as "image/png";
//  - decoded size ≤ 20 MB per file (the server's body limit of 15 MB applies first), and a declared size field next to
//    the data URL (size_bytes / size) may not understate the real size (routes check the declared size against their
//    own per-route caps).
// Files are only ever downloaded (`<a download>`), never rendered as documents on the app origin; the CSP blocks
// scripts from data:/blob: anyway — this is defence in depth (ASVS 12.1–12.5).

export const FILE_MAX_BYTES = 20 * 1024 * 1024

export interface FileProblem {
  message: string
  field?: string
}

const ACTIVE = /^(text\/html|application\/xhtml\+xml|application\/(x-)?javascript|text\/javascript|application\/ecmascript|text\/ecmascript|application\/x-sh|application\/x-msdownload|application\/hta|text\/xml|application\/xml)$/i

function decodeHead(b64: string, bytes: number): Uint8Array {
  const chunk = b64.slice(0, Math.ceil(bytes / 3) * 4).replace(/[^A-Za-z0-9+/]/g, '')
  try {
    const bin = atob(chunk.slice(0, chunk.length - (chunk.length % 4)))
    const out = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
    return out
  } catch {
    return new Uint8Array(0)
  }
}
const startsWith = (b: Uint8Array, sig: number[], at = 0) => sig.every((x, i) => b[at + i] === x)
const ascii = (s: string) => Array.from(s, (c) => c.charCodeAt(0))

type Kind = 'png' | 'jpeg' | 'gif' | 'webp' | 'pdf' | 'zip' | 'ole' | 'html' | 'svg' | 'xml'

/** what the bytes really are (null = no known signature: plain text, CSV, unknown binary…) */
export function sniff(head: Uint8Array): Kind | null {
  if (startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png'
  if (startsWith(head, [0xff, 0xd8, 0xff])) return 'jpeg'
  if (startsWith(head, ascii('GIF87a')) || startsWith(head, ascii('GIF89a'))) return 'gif'
  if (startsWith(head, ascii('RIFF')) && startsWith(head, ascii('WEBP'), 8)) return 'webp'
  if (startsWith(head, ascii('%PDF-'))) return 'pdf'
  if (startsWith(head, [0x50, 0x4b, 0x03, 0x04]) || startsWith(head, [0x50, 0x4b, 0x05, 0x06])) return 'zip'
  if (startsWith(head, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) return 'ole'
  const text = new TextDecoder('latin1').decode(head).replace(/^\uFEFF|^\xEF\xBB\xBF/, '').trimStart().slice(0, 1024).toLowerCase()
  if (/^<!doctype\s+html|^<(html|head|body|script|iframe|meta|object|embed)\b/.test(text)) return 'html'
  if (/^(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!doctype\s+svg[^>]*>\s*)?<svg\b/.test(text)) return 'svg'
  if (/<script\b/.test(text)) return 'html'
  if (/^<\?xml\b/.test(text)) return 'xml'
  return null
}

/** which sniffed kinds a declared media type may contain */
function allowedKinds(mime: string): Kind[] | 'any' {
  if (mime === 'image/png') return ['png']
  if (mime === 'image/jpeg' || mime === 'image/jpg' || mime === 'image/pjpeg') return ['jpeg']
  if (mime === 'image/gif') return ['gif']
  if (mime === 'image/webp') return ['webp']
  if (mime === 'image/svg+xml') return ['svg', 'xml']
  if (mime === 'application/pdf') return ['pdf']
  if (mime.startsWith('application/vnd.openxmlformats-officedocument.') || mime === 'application/zip' || mime === 'application/x-zip-compressed' || mime.startsWith('application/vnd.oasis.opendocument.')) return ['zip']
  if (mime === 'application/msword' || mime === 'application/vnd.ms-excel' || mime === 'application/vnd.ms-powerpoint') return ['ole', 'zip']
  if (/^text\/(plain|markdown|csv|x-markdown)$/.test(mime)) return 'any' // shown/downloaded as text, never rendered
  if (mime.startsWith('image/')) return ['png', 'jpeg', 'gif', 'webp']
  return ['png', 'jpeg', 'gif', 'webp', 'pdf', 'zip', 'ole'] // other / unknown binary: anything except markup
}

const SVG_BAD = /<\s*script\b|<\s*foreignObject\b|\bon[a-z]+\s*=|javascript\s*:|vbscript\s*:|data\s*:\s*text\/html|<!ENTITY|<\s*(iframe|embed|object)\b|(href|xlink:href|src)\s*=\s*["']?\s*(https?:|\/\/|data:)|@import|url\s*\(\s*["']?\s*(https?:|\/\/|javascript:)/i

/** Validates one data URL; null when acceptable. */
export function checkDataUrl(v: string, declaredSize?: unknown): FileProblem | null {
  const comma = v.indexOf(',')
  const head = comma > 0 ? v.slice(5, comma) : ''
  const m = /^([a-z0-9][\w.+-]*\/[\w.+-]+)?((?:;[\w.+-]+=[\w.+"-]+)*);base64$/i.exec(head)
  if (comma < 0 || !m) return { message: 'The file could not be read. Choose it again.' }
  const mime = (m[1] || 'application/octet-stream').toLowerCase()
  const b64 = v.slice(comma + 1)
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64.length > 4096 ? b64.slice(0, 2048) + b64.slice(-2048) : b64)) return { message: 'The file could not be read. Choose it again.' }
  const size = Math.floor((b64.length * 3) / 4) - (b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0)
  if (size > FILE_MAX_BYTES) return { message: 'The file is larger than 20 MB.' }
  const declared = Number(declaredSize)
  if (declaredSize !== undefined && declaredSize !== null && Number.isFinite(declared) && declared >= 0 && size > declared + 1024)
    return { message: 'The file size does not match its contents. Choose the file again.' }
  if (ACTIVE.test(mime)) return { message: 'This file type is not allowed (web pages and scripts can’t be uploaded).' }
  const kind = sniff(decodeHead(b64, 4096))
  const allowed = allowedKinds(mime)
  if (kind !== null && allowed !== 'any' && !allowed.includes(kind)) return { message: 'The file’s contents don’t match its type. Choose the original file again.' }
  if (mime === 'image/svg+xml' || kind === 'svg') {
    const text = new TextDecoder().decode(decodeHead(b64, Math.min(size, 2 * 1024 * 1024)))
    if (SVG_BAD.test(text)) return { message: 'This SVG contains scripts or external links. Export it again as a plain SVG or use PNG.' }
  }
  return null
}

/**
 * Walks a request body and validates every data: URL string (depth ≤ 8, objects/arrays). The declared size is taken
 * from a sibling `size_bytes` / `size` field of the object that holds the data URL.
 */
export function findFileProblem(body: unknown): FileProblem | null {
  let found: FileProblem | null = null
  const walk = (v: unknown, path: string, depth: number) => {
    if (found || depth > 8 || v === null || typeof v !== 'object') return
    if (Array.isArray(v)) {
      v.forEach((x, i) => walk(x, path ? `${path}.${i}` : String(i), depth + 1))
      return
    }
    const o = v as Record<string, unknown>
    for (const [k, x] of Object.entries(o)) {
      if (found) return
      if (typeof x === 'string' && x.startsWith('data:')) {
        const declaredType = typeof o.mime === 'string' ? o.mime : typeof o.type === 'string' ? o.type : ''
        const p = ACTIVE.test(declaredType.trim()) ? { message: 'This file type is not allowed (web pages and scripts can’t be uploaded).' } : checkDataUrl(x, o.size_bytes ?? o.size)
        if (p) found = path ? { ...p, field: path.split('.')[0] } : p
      } else if (x && typeof x === 'object') walk(x, path ? `${path}.${k}` : k, depth + 1)
    }
  }
  walk(body, '', 0)
  return found
}
