import { useState, useEffect } from 'react'
import { CheckCircle2, XCircle, Loader2, HardDrive, Download, Clock, ChevronRight } from 'lucide-react'
import { LtxLogo } from './LtxLogo'

interface FirstRunSetupProps {
  onComplete: () => void
}

interface SystemCheck {
  name: string
  status: 'checking' | 'pass' | 'fail' | 'warning'
  message: string
  detail?: string
}

interface ModelInfo {
  name: string
  description: string
  downloaded: boolean
  size: number
  expected_size: number
}

interface ModelsStatus {
  models: ModelInfo[]
  all_downloaded: boolean
  total_size_gb: number
  downloaded_size_gb: number
}

interface DownloadProgress {
  status: 'idle' | 'downloading' | 'complete' | 'error'
  currentFile: string
  currentFileProgress: number
  totalProgress: number
  downloadedBytes: number
  totalBytes: number
  filesCompleted: number
  totalFiles: number
  error: string | null
  speedMbps: number
}

// Fun loading messages
const LOADING_MESSAGES = [
  "Teaching AI to dream in 4K...",
  "Loading neural pathways...",
  "Calibrating inference engine...",
  "Unpacking the magic...",
  "Configuring parameters...",
  "Almost there...",
]

export function FirstRunSetup({ onComplete }: FirstRunSetupProps) {
  const [step, setStep] = useState<'welcome' | 'checking' | 'models' | 'downloading' | 'ready' | 'error'>('welcome')
  const [checks, setChecks] = useState<SystemCheck[]>([])
  const [modelsPath, setModelsPath] = useState<string>('')
  const [, setGpuInfo] = useState<{ available: boolean; name?: string; vram?: number } | null>(null)
  const [modelsStatus, setModelsStatus] = useState<ModelsStatus | null>(null)
  const [downloadProgress, setDownloadProgress] = useState<DownloadProgress | null>(null)
  const [loadingMessage, setLoadingMessage] = useState(LOADING_MESSAGES[0])

  // Cycle through loading messages
  useEffect(() => {
    if (step !== 'downloading') return
    let index = 0
    const interval = setInterval(() => {
      index = (index + 1) % LOADING_MESSAGES.length
      setLoadingMessage(LOADING_MESSAGES[index])
    }, 4000)
    return () => clearInterval(interval)
  }, [step])

  const updateCheck = (name: string, status: SystemCheck['status'], message: string, detail?: string) => {
    setChecks(prev => prev.map(check => 
      check.name === name ? { ...check, status, message, detail } : check
    ))
  }

  const runSystemChecks = async () => {
    setStep('checking')
    
    const initialChecks: SystemCheck[] = [
      { name: 'NVIDIA GPU', status: 'checking', message: 'Checking GPU...' },
      { name: 'VRAM', status: 'checking', message: 'Checking memory...' },
      { name: 'Storage', status: 'checking', message: 'Checking storage...' },
      { name: 'Backend', status: 'checking', message: 'Starting backend...' },
    ]
    setChecks(initialChecks)

    // Simulate sequential checks with delays for visual effect
    await new Promise(r => setTimeout(r, 500))

    // Check GPU
    try {
      const gpu = await window.electronAPI.checkGpu()
      setGpuInfo(gpu)
      
      if (gpu.available) {
        updateCheck('NVIDIA GPU', 'pass', gpu.name || 'NVIDIA GPU detected')
        await new Promise(r => setTimeout(r, 300))
        
        if (gpu.vram && gpu.vram >= 12) {
          updateCheck('VRAM', 'pass', `${gpu.vram} GB available`)
        } else if (gpu.vram && gpu.vram >= 8) {
          updateCheck('VRAM', 'warning', `${gpu.vram} GB (minimum)`)
        } else {
          updateCheck('VRAM', 'fail', 'Insufficient VRAM (need 8GB+)')
        }
      } else {
        updateCheck('NVIDIA GPU', 'fail', 'No NVIDIA GPU detected')
        updateCheck('VRAM', 'fail', 'GPU required')
      }
    } catch (e) {
      updateCheck('NVIDIA GPU', 'fail', 'Failed to detect GPU')
      updateCheck('VRAM', 'fail', 'GPU check failed')
    }

    await new Promise(r => setTimeout(r, 300))

    // Check storage
    try {
      const path = await window.electronAPI.getModelsPath()
      setModelsPath(path)
      updateCheck('Storage', 'pass', 'Storage ready')
    } catch {
      updateCheck('Storage', 'fail', 'Storage error')
    }

    await new Promise(r => setTimeout(r, 300))

    // Check backend
    try {
      const healthy = await window.electronAPI.checkBackendHealth()
      if (healthy) {
        updateCheck('Backend', 'pass', 'Backend running')
        
        // Fetch models status
        const status = await window.electronAPI.getModelsStatus()
        setModelsStatus(status)
        
        await new Promise(r => setTimeout(r, 500))
        
        // Proceed based on GPU check
        const gpuFailed = checks.find(c => c.name === 'NVIDIA GPU')?.status === 'fail'
        if (gpuFailed) {
          setStep('error')
        } else {
          setStep('models')
        }
      } else {
        updateCheck('Backend', 'fail', 'Backend not responding')
        setStep('error')
      }
    } catch {
      updateCheck('Backend', 'fail', 'Backend failed to start')
      setStep('error')
    }
  }

  const startDownload = async () => {
    setStep('downloading')
    try {
      await window.electronAPI.startModelDownload()
    } catch (e) {
      console.error('Failed to start download:', e)
    }
  }

  const skipDownload = async () => {
    await window.electronAPI.completeSetup()
    onComplete()
  }

  // Poll download progress
  useEffect(() => {
    if (step !== 'downloading') return
    
    const pollProgress = async () => {
      try {
        const progress = await window.electronAPI.getModelDownloadProgress()
        setDownloadProgress(progress)
        
        if (progress.status === 'complete') {
          const status = await window.electronAPI.getModelsStatus()
          setModelsStatus(status)
          setStep('ready')
        }
      } catch (e) {
        console.error('Failed to poll progress:', e)
      }
    }
    
    pollProgress()
    const interval = setInterval(pollProgress, 500)
    return () => clearInterval(interval)
  }, [step])

  const completeSetup = async () => {
    await window.electronAPI.completeSetup()
    onComplete()
  }

  const openModelsFolder = async () => {
    if (modelsPath) {
      await window.electronAPI.openFolder(modelsPath)
    }
  }

  // Format bytes
  const formatBytes = (bytes: number): string => {
    if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`
    if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(0)} MB`
    return `${(bytes / 1e3).toFixed(0)} KB`
  }

  // Format time remaining
  const formatTime = (bytes: number, speed: number): string => {
    if (speed <= 0) return '...'
    const seconds = (bytes / 1e6) / speed
    if (seconds < 60) return `${Math.ceil(seconds)}s`
    if (seconds < 3600) return `${Math.ceil(seconds / 60)}m`
    return `${(seconds / 3600).toFixed(1)}h`
  }

  return (
    <div className="h-screen bg-black text-white flex flex-col">
      {/* Title Bar */}
      <div className="h-8 flex items-center px-20 border-b border-zinc-900">
        <span className="text-xs text-zinc-500">LTX Video Studio</span>
      </div>

      {/* Header */}
      <div className="px-8 py-4 border-b border-zinc-900">
        <div className="flex items-center gap-3">
          <LtxLogo className="h-6 w-auto text-white" />
          <span className="text-sm text-zinc-500 pl-3 border-l border-zinc-700">Setup</span>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Welcome Step */}
        {step === 'welcome' && (
          <div className="flex-1 flex flex-col items-center justify-center px-8 animate-fadeIn">
            <div className="w-20 h-20 rounded-full bg-gradient-to-br from-violet-500 via-purple-500 to-blue-500 flex items-center justify-center mb-6">
              <LtxLogo className="h-10 w-auto text-white" />
            </div>
            <h1 className="text-3xl font-bold mb-3" style={{ fontFamily: "'Miriam Libre', serif" }}>
              Welcome to LTX Video
            </h1>
            <p className="text-zinc-400 text-center max-w-md mb-8">
              Transform text and images into stunning videos with AI. Let's get you set up.
            </p>
            <button
              onClick={runSystemChecks}
              className="px-8 py-3 bg-white text-black font-semibold rounded-full hover:bg-zinc-200 transition-all hover:-translate-y-0.5"
            >
              Get Started
            </button>
          </div>
        )}

        {/* Checking Step */}
        {step === 'checking' && (
          <div className="flex-1 flex flex-col px-8 py-6 animate-fadeIn">
            <h2 className="text-2xl font-bold mb-2" style={{ fontFamily: "'Miriam Libre', serif" }}>
              Checking System
            </h2>
            <p className="text-zinc-400 mb-6">Verifying your system meets the requirements.</p>
            
            <div className="space-y-3 max-w-lg">
              {checks.map((check) => (
                <div 
                  key={check.name}
                  className="bg-zinc-900 rounded-xl p-4 flex items-center gap-4"
                >
                  {check.status === 'checking' && (
                    <Loader2 className="h-5 w-5 text-violet-400 animate-spin flex-shrink-0" />
                  )}
                  {check.status === 'pass' && (
                    <CheckCircle2 className="h-5 w-5 text-green-500 flex-shrink-0" />
                  )}
                  {check.status === 'warning' && (
                    <CheckCircle2 className="h-5 w-5 text-yellow-500 flex-shrink-0" />
                  )}
                  {check.status === 'fail' && (
                    <XCircle className="h-5 w-5 text-red-500 flex-shrink-0" />
                  )}
                  
                  <div className="flex-1">
                    <div className="font-medium">{check.name}</div>
                    <div className={`text-sm ${
                      check.status === 'pass' ? 'text-green-400' :
                      check.status === 'warning' ? 'text-yellow-400' :
                      check.status === 'fail' ? 'text-red-400' :
                      'text-zinc-500'
                    }`}>
                      {check.message}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Models Step */}
        {step === 'models' && modelsStatus && (
          <div className="flex-1 flex flex-col px-8 py-6 animate-fadeIn">
            <h2 className="text-2xl font-bold mb-2" style={{ fontFamily: "'Miriam Libre', serif" }}>
              AI Models Required
            </h2>
            <p className="text-zinc-400 mb-6">
              Download the AI models to start generating videos.
            </p>

            {/* Storage Info Card */}
            <div className="bg-zinc-900 rounded-xl p-4 flex items-center gap-4 mb-4 max-w-lg">
              <HardDrive className="h-5 w-5 text-zinc-500" />
              <div className="flex-1">
                <div className="text-sm text-zinc-400">Storage Location</div>
                <div className="text-sm font-mono text-zinc-300 truncate">{modelsPath}</div>
              </div>
              <button
                onClick={openModelsFolder}
                className="text-xs text-violet-400 hover:text-violet-300"
              >
                Open
              </button>
            </div>

            {/* Models List */}
            <div className="space-y-2 max-w-lg mb-6">
              {modelsStatus.models.map((model) => (
                <div 
                  key={model.name}
                  className="bg-zinc-900 rounded-xl p-4 flex items-center gap-4"
                >
                  {model.downloaded ? (
                    <CheckCircle2 className="h-5 w-5 text-green-500 flex-shrink-0" />
                  ) : (
                    <Download className="h-5 w-5 text-zinc-600 flex-shrink-0" />
                  )}
                  
                  <div className="flex-1 min-w-0">
                    <div className="font-medium truncate">{model.name}</div>
                    <div className="text-xs text-zinc-500 truncate">{model.description}</div>
                  </div>
                  
                  <div className="text-right">
                    <div className={`text-xs ${model.downloaded ? 'text-green-400' : 'text-zinc-500'}`}>
                      {model.downloaded ? 'Ready' : 'Needed'}
                    </div>
                    <div className="text-xs text-zinc-600">
                      {formatBytes(model.expected_size)}
                    </div>
                  </div>
                </div>
              ))}
            </div>

            {/* Size Summary */}
            <div className="text-sm text-zinc-500 mb-6 max-w-lg">
              Total size: <span className="text-white font-medium">{modelsStatus.total_size_gb.toFixed(1)} GB</span>
              {modelsStatus.downloaded_size_gb > 0 && (
                <span className="text-green-400 ml-2">
                  ({modelsStatus.downloaded_size_gb.toFixed(1)} GB already downloaded)
                </span>
              )}
            </div>
          </div>
        )}

        {/* Downloading Step */}
        {step === 'downloading' && (
          <div className="flex-1 flex flex-col animate-fadeIn">
            {/* Video Section (placeholder) */}
            <div className="flex-1 bg-zinc-950 flex items-center justify-center relative">
              <div className="text-center">
                <div className="w-24 h-24 rounded-full bg-gradient-to-br from-violet-500 via-purple-500 to-blue-500 flex items-center justify-center mx-auto mb-6 animate-pulse">
                  <Download className="h-10 w-10 text-white" />
                </div>
                <div className="text-zinc-400 italic">{loadingMessage}</div>
              </div>
            </div>

            {/* Progress Section */}
            <div className="bg-black p-6 border-t border-zinc-900">
              <div className="flex items-center justify-between mb-3">
                <span className="text-sm font-medium">
                  {downloadProgress?.status === 'downloading' ? 'Downloading...' : 
                   downloadProgress?.status === 'error' ? 'Error' : 'Preparing...'}
                </span>
                <span className="text-sm text-violet-400 font-semibold">
                  {downloadProgress?.totalProgress || 0}%
                </span>
              </div>
              
              {/* Progress Bar */}
              <div className="h-2 bg-zinc-900 rounded-full overflow-hidden mb-3">
                <div 
                  className="h-full bg-gradient-to-r from-violet-500 via-purple-500 to-blue-500 transition-all duration-300"
                  style={{ 
                    width: `${downloadProgress?.totalProgress || 0}%`,
                    backgroundSize: '200% 200%',
                    animation: 'gradient-shift 3s ease infinite'
                  }}
                />
              </div>
              
              <div className="flex items-center justify-between text-xs text-zinc-500">
                <span className="truncate flex-1 mr-4">
                  {downloadProgress?.currentFile || 'Starting...'}
                </span>
                <div className="flex items-center gap-4">
                  {downloadProgress?.speedMbps ? (
                    <span>{downloadProgress.speedMbps.toFixed(1)} MB/s</span>
                  ) : null}
                  {downloadProgress && downloadProgress.totalBytes > 0 && (
                    <div className="flex items-center gap-1">
                      <Clock className="h-3 w-3" />
                      <span>
                        {formatTime(
                          downloadProgress.totalBytes - downloadProgress.downloadedBytes,
                          downloadProgress.speedMbps
                        )} remaining
                      </span>
                    </div>
                  )}
                </div>
              </div>
              
              {downloadProgress?.filesCompleted !== undefined && (
                <div className="text-xs text-zinc-600 mt-2">
                  {downloadProgress.filesCompleted} / {downloadProgress.totalFiles} files complete
                </div>
              )}

              {downloadProgress?.error && (
                <div className="mt-3 p-3 bg-red-500/10 border border-red-500/20 rounded-lg">
                  <div className="text-sm text-red-400">{downloadProgress.error}</div>
                  <button
                    onClick={startDownload}
                    className="mt-2 text-xs text-red-300 hover:text-red-200 underline"
                  >
                    Retry
                  </button>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Ready Step */}
        {step === 'ready' && (
          <div className="flex-1 flex flex-col items-center justify-center px-8 animate-fadeIn">
            <div className="w-20 h-20 rounded-full bg-gradient-to-br from-violet-500 via-purple-500 to-blue-500 flex items-center justify-center mb-6">
              <CheckCircle2 className="h-10 w-10 text-white" />
            </div>
            <h1 className="text-3xl font-bold mb-3" style={{ fontFamily: "'Miriam Libre', serif" }}>
              Ready to Create
            </h1>
            <p className="text-zinc-400 text-center max-w-md mb-8">
              All models are downloaded and ready. Start generating amazing videos.
            </p>

            {/* Summary Card */}
            <div className="bg-zinc-900 rounded-xl p-6 min-w-[280px] mb-8">
              <div className="flex justify-between py-2 border-b border-zinc-800">
                <span className="text-zinc-500">Models</span>
                <span className="font-medium">{modelsStatus?.models.length || 0} installed</span>
              </div>
              <div className="flex justify-between py-2">
                <span className="text-zinc-500">Storage</span>
                <span className="font-medium">{modelsStatus?.total_size_gb.toFixed(1)} GB</span>
              </div>
            </div>

            <button
              onClick={completeSetup}
              className="px-8 py-3 bg-white text-black font-semibold rounded-full hover:bg-zinc-200 transition-all hover:-translate-y-0.5 flex items-center gap-2"
            >
              Start Creating
              <ChevronRight className="h-5 w-5" />
            </button>
          </div>
        )}

        {/* Error Step */}
        {step === 'error' && (
          <div className="flex-1 flex flex-col items-center justify-center px-8 animate-fadeIn">
            <div className="w-20 h-20 rounded-full bg-red-500/20 flex items-center justify-center mb-6">
              <XCircle className="h-10 w-10 text-red-500" />
            </div>
            <h1 className="text-3xl font-bold mb-3" style={{ fontFamily: "'Miriam Libre', serif" }}>
              Setup Failed
            </h1>
            <p className="text-zinc-400 text-center max-w-md mb-8">
              Some requirements were not met. Please check the issues above and try again.
            </p>

            <div className="space-y-3 max-w-lg w-full mb-8">
              {checks.filter(c => c.status === 'fail').map((check) => (
                <div 
                  key={check.name}
                  className="bg-red-500/10 border border-red-500/20 rounded-xl p-4 flex items-center gap-4"
                >
                  <XCircle className="h-5 w-5 text-red-500 flex-shrink-0" />
                  <div>
                    <div className="font-medium text-red-400">{check.name}</div>
                    <div className="text-sm text-red-300/70">{check.message}</div>
                  </div>
                </div>
              ))}
            </div>

            <div className="flex gap-3">
              <button
                onClick={runSystemChecks}
                className="px-6 py-2.5 border border-zinc-700 text-white font-medium rounded-full hover:bg-zinc-800 transition-all"
              >
                Retry
              </button>
              <button
                onClick={completeSetup}
                className="px-6 py-2.5 bg-zinc-800 text-white font-medium rounded-full hover:bg-zinc-700 transition-all"
              >
                Continue Anyway
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="px-8 py-4 border-t border-zinc-900 flex items-center justify-between">
        <div className="text-xs text-zinc-600">© 2026 Lightricks</div>
        
        {step === 'models' && (
          <div className="flex gap-3">
            <button
              onClick={skipDownload}
              className="px-6 py-2 border border-zinc-700 text-white text-sm font-medium rounded-full hover:bg-zinc-800 transition-all"
            >
              Skip for now
            </button>
            <button
              onClick={startDownload}
              className="px-6 py-2 bg-white text-black text-sm font-semibold rounded-full hover:bg-zinc-200 transition-all"
            >
              Download Models
            </button>
          </div>
        )}

        {step === 'downloading' && (
          <button
            onClick={skipDownload}
            className="px-6 py-2 border border-zinc-700 text-white text-sm font-medium rounded-full hover:bg-zinc-800 transition-all"
          >
            Continue in Background
          </button>
        )}
      </div>

      {/* CSS for animations */}
      <style>{`
        @keyframes fadeIn {
          from { opacity: 0; transform: translateY(8px); }
          to { opacity: 1; transform: translateY(0); }
        }
        .animate-fadeIn {
          animation: fadeIn 0.3s ease-out;
        }
        @keyframes gradient-shift {
          0% { background-position: 0% 50%; }
          50% { background-position: 100% 50%; }
          100% { background-position: 0% 50%; }
        }
      `}</style>
    </div>
  )
}
