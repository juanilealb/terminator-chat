import { useEffect, useRef } from 'react'
import {
  Toaster,
  useToastController,
  useId,
  Toast,
  ToastTitle,
  type ToastIntent,
} from '@fluentui/react-components'
import { useAppStore } from '../../store/app-store'

export function ToastContainer() {
  const toasterId = useId('toaster')
  const { dispatchToast } = useToastController(toasterId)
  const toasts = useAppStore((s) => s.toasts)
  const dismissToast = useAppStore((s) => s.dismissToast)
  const dispatched = useRef(new Set<string>())

  useEffect(() => {
    for (const t of toasts) {
      if (dispatched.current.has(t.id)) continue
      dispatched.current.add(t.id)

      const intent: ToastIntent = t.type === 'error' ? 'error' : t.type === 'success' ? 'success' : 'info'
      dispatchToast(
        <Toast>
          <ToastTitle>{t.message}</ToastTitle>
        </Toast>,
        {
          intent,
          timeout: 5000,
          onStatusChange: (_e, data) => {
            if (data.status === 'dismissed') {
              dismissToast(t.id)
              dispatched.current.delete(t.id)
            }
          },
        },
      )
    }
  }, [toasts, dispatchToast, dismissToast])

  // Clean up dispatched set when toasts are removed externally
  useEffect(() => {
    const currentIds = new Set(toasts.map((t) => t.id))
    for (const id of dispatched.current) {
      if (!currentIds.has(id)) dispatched.current.delete(id)
    }
  }, [toasts])

  return <Toaster toasterId={toasterId} position="bottom-end" />
}
