// Global assistant: a Sheet opened by useUI().openAI(prompt). It shares the conversation with /ai
// and auto-submits the prompt it was opened with.
import { useEffect, useRef } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { Maximize2, RotateCcw } from '@/ui/icons'
import { useUI } from '@/stores/ui'
import { useSession } from '@/stores/session'
import { useAiContext } from '@/api/reports'
import { Button, EmptyState, IconButton, Sheet, useCan } from '@/ui'
import { AI_NOTE, Composer, ConversationView, EngineBadge, useConversation } from './components/Conversation'
import { Sparkles } from '@/ui/icons'

export default function AIAssistantHost() {
  const { ai, closeAI } = useUI()
  const { user } = useSession()
  const c = useCan()
  const nav = useNavigate()
  const loc = useLocation()
  const allowed = !!user && !user.is_super_admin && c('ai.use')
  const ctx = useAiContext(allowed && ai.open)
  const { busy, send, stop, clear, messages } = useConversation()
  const lastPrompt = useRef<string | null>(null)
  const enabled = ctx.data?.enabled !== false

  useEffect(() => {
    if (!ai.open) {
      lastPrompt.current = null
      return
    }
    const p = ai.prompt?.trim()
    if (p && p !== lastPrompt.current && enabled && ctx.data) {
      lastPrompt.current = p
      void send(ai.context ? `${p}` : p)
    }
  }, [ai.open, ai.prompt, ai.context, send, enabled, ctx.data])

  // the studio page is the same conversation — close the sheet when navigating there
  useEffect(() => {
    if (loc.pathname === '/ai' && ai.open) closeAI()
  }, [loc.pathname, ai.open, closeAI])

  if (!allowed) return null
  return (
    <Sheet
      open={ai.open}
      onOpenChange={(o) => !o && closeAI()}
      width={640}
      title={
        <span>Ask Seereon AI</span>
      }
      subtitle={AI_NOTE}
      headerExtra={
        <div className="mt-2 flex items-center gap-1.5">
          <EngineBadge />
          <span className="flex-1" />
          {messages.length > 0 && (
            <Button size="xs" variant="ghost" icon={<RotateCcw className="size-3.5" />} onClick={clear} disabled={busy}>
              New chat
            </Button>
          )}
          <IconButton
            size="sm"
            label="Open full screen"
            onClick={() => {
              closeAI()
              nav('/ai')
            }}
          >
            <Maximize2 className="size-4" />
          </IconButton>
        </div>
      }
      footer={
        enabled ? (
          <div className="w-full">
            <Composer onSend={(q) => void send(q)} busy={busy} onStop={stop} autoFocus={!ai.prompt} />
          </div>
        ) : undefined
      }
    >
      {ctx.error ? (
        <EmptyState compact title="The assistant isn’t available" body={(ctx.error as Error).message} />
      ) : !enabled ? (
        <EmptyState compact icon={<Sparkles />} title="AI is turned off for this workspace" body="An admin can turn it on in Settings → Company → AI assistant." action={c('settings.edit') ? <Button onClick={() => (closeAI(), nav('/settings/company'))}>Open settings</Button> : undefined} />
      ) : (
        <ConversationView compact />
      )}
    </Sheet>
  )
}
