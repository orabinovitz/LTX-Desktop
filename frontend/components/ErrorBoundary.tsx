import { Component, type ErrorInfo, type ReactNode } from 'react'
import { logger } from '../lib/logger'
import { captureException } from '../lib/sentry'

interface Props {
  children: ReactNode
}

interface State {
  hasError: boolean
  error: Error | null
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    captureException(error)
    logger.error(
      `Uncaught React error: ${error.message}\n${error.stack ?? ''}\nComponent stack: ${errorInfo.componentStack ?? ''}`,
    )
  }

  private handleReload = () => {
    window.location.reload()
  }

  render(): ReactNode {
    if (this.state.hasError) {
      return (
        <div className="flex h-screen w-screen items-center justify-center bg-zinc-950 p-6">
          <div className="w-full max-w-md rounded-xl border border-zinc-700 bg-zinc-900 p-6 text-center shadow-2xl">
            <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-red-500/10">
              <svg className="h-6 w-6 text-red-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            </div>
            <h2 className="text-lg font-semibold text-zinc-100">Something crashed</h2>
            <p className="mt-2 text-sm text-zinc-400">
              An unexpected error occurred. Your work has been saved automatically.
            </p>
            {this.state.error && (
              <pre className="mt-3 max-h-32 overflow-auto rounded-lg bg-zinc-800 p-3 text-left text-xs text-zinc-300">
                {this.state.error.message}
              </pre>
            )}
            <button
              onClick={this.handleReload}
              className="mt-4 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-500"
            >
              Reload Application
            </button>
          </div>
        </div>
      )
    }

    return this.props.children
  }
}
