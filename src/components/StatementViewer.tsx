import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Share, X } from 'lucide-react'

// The statement, shown INSIDE the app.
//
// 🚨 WHY THIS EXISTS. The whole premise of the design was that one
// downloaded file covers every view, on the phone and on the laptop.
// On iOS that premise is false: a saved .html opens in
// the Files app's Quick Look preview, which renders the markup but does
// NOT run scripts — so the controls appear and nothing else does — and as
// of 2026 iOS no longer offers "open in Safari" for a local HTML file
// (Adam, 2026-09-24, first UAT round). There is no viewer on the device
// that will run it.
//
// So the app itself is the viewer. The SAME template and the SAME payload
// are rendered in an `srcdoc` iframe, where scripts run normally, which
// means there is still exactly one renderer and one set of figures. The
// downloaded file is unchanged and still matters: the laptop, printing to
// A4, and keeping a copy.
//
// 🚨 Do not "simplify" this into a React re-implementation of the
// statement. Two renderers is precisely the thing this whole design was
// built to avoid — see statement.ts's header.

export interface StatementViewerProps {
  /** The rendered statement — the exact bytes the downloaded file contains. */
  html: string
  filename: string
  onClose: () => void
  onShare: () => Promise<void> | void
}

export function StatementViewer({ html, filename, onClose, onShare }: StatementViewerProps) {
  const frameRef = useRef<HTMLIFrameElement>(null)
  const [sharing, setSharing] = useState(false)

  // Escape closes it on a laptop; the X closes it everywhere.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return createPortal(
    <div className="fixed inset-0 z-[700] flex flex-col" style={{ background: 'var(--color-bg)' }}>
      <div
        className="flex items-center gap-2 px-3 py-2 shrink-0"
        style={{ background: 'var(--color-surface)', paddingTop: 'calc(0.5rem + env(safe-area-inset-top))' }}
      >
        <button onClick={onClose} aria-label="Close statement" className="p-2 rounded-full" style={{ background: 'var(--color-bg-elevated)' }}>
          <X size={16} />
        </button>
        <p className="flex-1 text-xs text-[var(--color-ink-muted)] truncate">{filename}</p>
        <button
          onClick={async () => {
            setSharing(true)
            try {
              await onShare()
            } finally {
              setSharing(false)
            }
          }}
          disabled={sharing}
          className="flex items-center gap-1.5 px-3 py-2 rounded-full text-xs font-semibold text-white"
          style={{ background: 'var(--color-coral)', opacity: sharing ? 0.6 : 1 }}
        >
          <Share size={14} />
          {sharing ? 'Saving…' : 'Save a copy'}
        </button>
      </div>
      {/*
        `srcdoc`, not a blob URL: a blob URL is a separate document the
        Files app would be involved in again, and the point here is to
        stay inside the app. Scripts run in an srcdoc iframe; the sandbox
        attribute is deliberately NOT set, because setting it without
        `allow-scripts` would reproduce the exact Quick Look failure this
        component exists to fix. The document is one this app generated
        from its own data a moment ago — there is no third-party content
        in it, and it makes no network requests of its own.
      */}
      <iframe ref={frameRef} srcDoc={html} title="Cycle statement" className="flex-1 w-full border-0" />
    </div>,
    document.body,
  )
}
