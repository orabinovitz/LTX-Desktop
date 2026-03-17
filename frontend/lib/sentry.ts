import * as Sentry from '@sentry/react'

let initialized = false

export function initSentry(dsn: string, version: string): void {
  if (!dsn || initialized) return

  Sentry.init({
    dsn,
    release: `ltx-desktop@${version}`,
    sampleRate: 1.0,
    tracesSampleRate: 0.2,
  })
  initialized = true
}

export function captureException(error: unknown): void {
  if (!initialized) return
  Sentry.captureException(error)
}

export { Sentry }
