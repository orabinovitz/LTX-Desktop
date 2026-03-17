import * as Sentry from '@sentry/electron/main'
import { app } from 'electron'

const dsn = process.env.SENTRY_DSN ?? ''

export function initSentry(): void {
  if (!dsn) return

  Sentry.init({
    dsn,
    release: `ltx-desktop@${app.getVersion()}`,
    environment: app.isPackaged ? 'production' : 'development',
    sampleRate: 1.0,
    tracesSampleRate: 0.2,
    beforeSend(event) {
      if (!app.isPackaged) return null
      return event
    },
  })
}

export function captureException(error: unknown): void {
  if (!dsn) return
  Sentry.captureException(error)
}
