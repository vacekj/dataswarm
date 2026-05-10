type Props = {
  open: boolean
  message: string
}

export function BusyOverlay({ open, message }: Props) {
  if (!open) return null
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div className="flex flex-col items-center gap-3 rounded-md border bg-background p-6 shadow-lg">
        <div className="h-10 w-10 animate-spin rounded-full border-2 border-muted-foreground border-t-transparent" />
        <p className="max-w-xs text-center text-sm text-muted-foreground">{message || 'Working…'}</p>
      </div>
    </div>
  )
}
