import { useState } from 'react'
import { ArrowLeft, Sparkles, Film, Settings, FileText } from 'lucide-react'
import { useProjects } from '../contexts/ProjectContext'
import { LtxLogo } from '../components/LtxLogo'
import { Button } from '../components/ui/button'
import { GenSpace } from './GenSpace'
import { VideoEditor } from './VideoEditor'
import type { ProjectTab } from '../types/project'

export function Project() {
  const { currentProject, currentTab, setCurrentTab, goHome } = useProjects()
  const [isSettingsOpen, setIsSettingsOpen] = useState(false)
  
  if (!currentProject) {
    return (
      <div className="h-screen bg-background flex items-center justify-center">
        <div className="text-center">
          <p className="text-zinc-400 mb-4">Project not found</p>
          <Button onClick={goHome}>Go Home</Button>
        </div>
      </div>
    )
  }
  
  const tabs: { id: ProjectTab; label: string; icon: React.ReactNode }[] = [
    { id: 'gen-space', label: 'Gen Space', icon: <Sparkles className="h-4 w-4" /> },
    { id: 'video-editor', label: 'Video Editor', icon: <Film className="h-4 w-4" /> },
  ]
  
  return (
    <div className="h-screen bg-background flex flex-col">
      {/* Header */}
      <header className="flex items-center justify-between px-4 py-3 border-b border-zinc-800">
        <div className="flex items-center gap-4">
          {/* Back button and logo */}
          <button 
            onClick={goHome}
            className="p-2 rounded-lg hover:bg-zinc-800 transition-colors"
          >
            <ArrowLeft className="h-5 w-5 text-zinc-400" />
          </button>
          
          <LtxLogo className="h-5 w-auto text-white" />
          
          {/* Project name */}
          <span className="text-white font-medium">{currentProject.name}</span>
        </div>
        
        {/* Center - Tabs */}
        <div className="flex items-center gap-1 bg-zinc-900 rounded-lg p-1">
          {tabs.map(tab => (
            <button
              key={tab.id}
              onClick={() => setCurrentTab(tab.id)}
              className={`flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium transition-colors ${
                currentTab === tab.id
                  ? 'bg-zinc-800 text-white'
                  : 'text-zinc-400 hover:text-white'
              }`}
            >
              {tab.icon}
              {tab.label}
            </button>
          ))}
        </div>
        
        {/* Right - Actions */}
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setIsSettingsOpen(true)}
            className="h-8 w-8 text-zinc-400 hover:text-white hover:bg-zinc-800"
            title="Settings"
          >
            <Settings className="h-4 w-4" />
          </Button>
        </div>
      </header>
      
      {/* Main Content - both views stay mounted to preserve state */}
      <main className="flex-1 overflow-hidden relative">
        <div className={`absolute inset-0 ${currentTab === 'gen-space' ? '' : 'invisible pointer-events-none'}`}>
          <GenSpace />
        </div>
        <div className={`absolute inset-0 ${currentTab === 'video-editor' ? '' : 'invisible pointer-events-none'}`}>
          <VideoEditor />
        </div>
      </main>
    </div>
  )
}
