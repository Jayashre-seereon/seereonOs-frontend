// Module C — in-app notifications (UI-14). Each user sees only their own rows.
import { err, find, nowISO, paginate, persist, rows, type Router } from '../server'

export function register(r: Router) {
  r.get('/notifications', ({ ctx, query }) => {
    const mine = rows(ctx, 'notifications')
      .filter((n) => n.user_id === ctx.user.id)
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
    const unread = mine.filter((n) => !n.read_at).length
    const list = query.filter === 'unread' ? mine.filter((n) => !n.read_at) : mine
    const limit = Math.min(200, Math.max(1, Number(query.limit ?? 50)))
    const page = paginate(list, { page: query.page, page_size: limit })
    return { ...page, unread }
  })

  r.post('/notifications/:id/read', ({ ctx, params }) => {
    const n = find(ctx, 'notifications', params.id, 'Notification')
    if (n.user_id !== ctx.user.id) err(404, 'NOT_FOUND', 'Notification not found.')
    if (!n.read_at) {
      n.read_at = nowISO()
      persist()
    }
    return n
  }, { allowViewAsWrite: true })

  r.post('/notifications/read-all', ({ ctx }) => {
    const t = nowISO()
    let n = 0
    for (const x of rows(ctx, 'notifications')) if (x.user_id === ctx.user.id && !x.read_at) {
      x.read_at = t
      n++
    }
    persist()
    return { updated: n }
  }, { allowViewAsWrite: true })
}
