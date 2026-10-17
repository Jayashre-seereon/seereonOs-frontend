import React from 'react'
import ReactDOM from 'react-dom/client'
import { QueryClientProvider } from '@tanstack/react-query'
import { Toaster } from 'sonner'
import './index.css'
import { queryClient } from '@/api/query'
import { AppRouter } from '@/app/routes'
import { ConfirmProvider, TooltipProvider } from '@/ui'
import { applyTheme } from '@/theme/theme'
import { DEFAULT_THEME } from '@/mock/seed'
import { useSession } from '@/stores/session'
import { SEEREON_EMBLEM } from '@/assets/brand'

{
  const link = document.createElement('link')
  link.rel = 'icon'
  link.type = 'image/png'
  link.href = SEEREON_EMBLEM
  document.head.appendChild(link)
}

// Paint the tenant theme before the first render to avoid a flash.
const s = useSession.getState()
applyTheme(s.tenant?.theme ?? DEFAULT_THEME, s.user?.prefs?.theme_mode)

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <ConfirmProvider>
          <AppRouter />
          <Toaster
            position={window.matchMedia?.('(min-width: 1024px)').matches ? 'bottom-right' : 'top-center'}
            offset={16}
            toastOptions={{
              classNames: {
                toast: '!rounded-lg !border !border-line !bg-elevated !text-ink !shadow-lg !font-sans',
                description: '!text-ink-3',
                title: '!font-semibold',
              },
            }}
          />
        </ConfirmProvider>
      </TooltipProvider>
    </QueryClientProvider>
  </React.StrictMode>,
)
