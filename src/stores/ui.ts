import { create } from 'zustand'
import { todayISO, weekStart } from '@/domain/calendar'

/** Global UI state shared across modules (task drawer, AI assistant, command palette). */
interface UIState {
  taskId: string | null
  openTask: (id: string | null) => void
  ai: { open: boolean; prompt: string | null; context: string | null }
  openAI: (prompt?: string | null, context?: string | null) => void
  closeAI: () => void
  command: boolean
  setCommand: (v: boolean) => void
  more: boolean
  setMore: (v: boolean) => void
  sidebarCollapsed: boolean
  toggleSidebar: () => void
  /** The week being viewed (Monday, ISO) — the header week switcher drives dashboards, timesheet, scorecard and approvals. */
  week: string
  setWeek: (mondayISO: string) => void
}
export const useUI = create<UIState>((set) => ({
  taskId: null,
  openTask: (taskId) => set({ taskId }),
  ai: { open: false, prompt: null, context: null },
  openAI: (prompt = null, context = null) => set({ ai: { open: true, prompt, context } }),
  closeAI: () => set((s) => ({ ai: { ...s.ai, open: false } })),
  command: false,
  setCommand: (command) => set({ command }),
  more: false,
  setMore: (more) => set({ more }),
  sidebarCollapsed: false,
  toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
  week: weekStart(todayISO()),
  setWeek: (d) => set({ week: weekStart(d) }),
}))
/** The viewed week (Monday ISO) from the header switcher. */
export const useWeek = () => useUI((s) => s.week)
