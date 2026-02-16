import {
  Dialog,
  DialogSurface,
  DialogBody,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
} from '@fluentui/react-components'
import styles from './ConfirmDialog.module.css'

interface Props {
  title: string
  message: string
  confirmLabel?: string
  onConfirm: () => void
  secondaryLabel?: string
  onSecondary?: () => void
  onCancel: () => void
  destructive?: boolean
  secondaryDestructive?: boolean
}

export function ConfirmDialog({
  title,
  message,
  confirmLabel = 'Delete',
  onConfirm,
  secondaryLabel,
  onSecondary,
  onCancel,
  destructive = false,
  secondaryDestructive = false,
}: Props) {
  const showShiftHint = confirmLabel.toLowerCase() === 'delete'

  return (
    <Dialog open onOpenChange={(_, data) => { if (!data.open) onCancel() }}>
      <DialogSurface className={styles.surface}>
        <DialogBody>
          <DialogTitle>{title}</DialogTitle>
          <DialogContent>
            <div className={styles.message}>{message}</div>
            {showShiftHint && (
              <div className={styles.tip}>Tip: Hold Shift while deleting to skip this dialog</div>
            )}
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={onCancel}>Cancel</Button>
            {secondaryLabel && onSecondary && (
              <Button
                appearance="secondary"
                className={secondaryDestructive ? styles.destructiveBtn : undefined}
                onClick={onSecondary}
              >
                {secondaryLabel}
              </Button>
            )}
            <Button
              autoFocus
              appearance="primary"
              className={destructive ? styles.destructiveBtn : undefined}
              onClick={onConfirm}
            >
              {confirmLabel}
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  )
}
