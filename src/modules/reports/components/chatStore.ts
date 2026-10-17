// Conversation state shared by the AI studio page and the global assistant sheet, so a question
// asked in one continues in the other. Kept in memory for the session (per tenant + role scope).
import { create } from 'zustand'
import type { AiAnswer } from '@/api/reports'

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  status?: 'pending' | 'done' | 'error' | 'stopped'
  statusText?: string
  source?: 'llm' | 'rules'
  answer?: AiAnswer | null
  tools?: string[]
  note?: string
  at: number
}
interface ChatState {
  scope: string
  messages: ChatMessage[]
  busy: boolean
  setScope: (s: string) => void
  push: (m: ChatMessage) => void
  patch: (id: string, p: Partial<ChatMessage>) => void
  setBusy: (b: boolean) => void
  clear: () => void
}
export const useChat = create<ChatState>((set, get) => ({
  scope: '',
  messages: [],
  busy: false,
  setScope: (s) => {
    if (get().scope !== s) set({ scope: s, messages: [], busy: false })
  },
  push: (m) => set((st) => ({ messages: [...st.messages, m] })),
  patch: (id, p) => set((st) => ({ messages: st.messages.map((m) => (m.id === id ? { ...m, ...p } : m)) })),
  setBusy: (busy) => set({ busy }),
  clear: () => set({ messages: [], busy: false }),
}))
let n = 0
export const mid = () => `m${Date.now().toString(36)}${(++n).toString(36)}`
