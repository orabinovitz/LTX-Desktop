import { useState, useEffect } from 'react'
import { Loader2, AlertCircle } from 'lucide-react'
import { ProjectProvider, useProjects } from './contexts/ProjectContext'
import { useBackend } from './hooks/use-backend'
import { Home } from './views/Home'
import { Project } from './views/Project'
import { Playground } from './views/Playground'
import { FirstRunSetup } from './components/FirstRunSetup'
import { Button } from './components/ui/button'

function AppContent() {
  const { currentView } = useProjects()
  const { status, isLoading: backendLoading, error: backendError } = useBackend()
  const [isFirstRun, setIsFirstRun] = useState<boolean | null>(null)

  // Check for first run
  useEffect(() => {
    const checkFirstRun = async () => {
      try {
        const firstRun = await window.electronAPI.checkFirstRun()
        setIsFirstRun(firstRun)
      } catch (e) {
        console.error('Failed to check first run:', e)
        setIsFirstRun(false)
      }
    }
    checkFirstRun()
  }, [])

  // Show loading while checking first run
  if (isFirstRun === null) {
    return (
      <div className="h-screen bg-background flex items-center justify-center">
        <Loader2 className="h-8 w-8 text-primary animate-spin" />
      </div>
    )
  }

  // Show first run setup
  if (isFirstRun) {
    return <FirstRunSetup onComplete={() => setIsFirstRun(false)} />
  }

  // Show loading screen while connecting to backend
  if (backendLoading) {
    return (
      <div className="h-screen bg-background flex items-center justify-center">
        <div className="text-center">
          <Loader2 className="h-12 w-12 text-primary animate-spin mx-auto mb-4" />
          <h2 className="text-xl font-semibold text-foreground mb-2">Starting LTX Studio...</h2>
          <p className="text-muted-foreground">Initializing the inference engine</p>
        </div>
      </div>
    )
  }

  // Show error screen if backend failed
  if (backendError && !status.connected) {
    return (
      <div className="h-screen bg-background flex items-center justify-center">
        <div className="text-center max-w-md">
          <AlertCircle className="h-12 w-12 text-red-500 mx-auto mb-4" />
          <h2 className="text-xl font-semibold text-foreground mb-2">Connection Failed</h2>
          <p className="text-muted-foreground mb-4">{backendError}</p>
          <Button onClick={() => window.location.reload()}>Retry</Button>
        </div>
      </div>
    )
  }

  // Render the appropriate view
  switch (currentView) {
    case 'home':
      return <Home />
    case 'project':
      return <Project />
    case 'playground':
      return <Playground />
    default:
      return <Home />
  }
}

export default function App() {
  return (
    <ProjectProvider>
      <AppContent />
    </ProjectProvider>
  )
}
