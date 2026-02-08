import { useState, useEffect } from 'react'

interface FirstRunSetupProps {
  onComplete: () => void
}

interface GpuInfo {
  available: boolean
  name?: string
  vram?: number
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

// Model tiers
const MODEL_TIERS = {
  ultimate: {
    name: 'Ultimate',
    specs: 'Maximum fidelity • 24GB+ VRAM',
    size: '~65 GB',
    minVram: 24,
  },
  pro: {
    name: 'Pro', 
    specs: 'Balanced quality & speed • 16GB VRAM',
    size: '~45 GB',
    minVram: 16,
  },
  light: {
    name: 'Light',
    specs: 'Fast drafts • 12GB VRAM', 
    size: '~28 GB',
    minVram: 12,
  },
}

// Fun loading messages
const INSTALL_MESSAGES = [
  "Downloading model weights...",
  "Teaching AI to dream in 4K...",
  "Loading neural pathways...",
  "Calibrating inference engine...",
  "Almost there...",
  "Unpacking the magic...",
  "Configuring parameters...",
  "Finalizing installation..."
]

export function FirstRunSetup({ onComplete }: FirstRunSetupProps) {
  const [currentStep, setCurrentStep] = useState(1)
  const [selectedModel, setSelectedModel] = useState<'ultimate' | 'pro' | 'light'>('ultimate')
  const [installPath, setInstallPath] = useState('')
  const [gpuInfo, setGpuInfo] = useState<GpuInfo | null>(null)
  const [downloadProgress, setDownloadProgress] = useState<DownloadProgress | null>(null)
  const [installMessage, setInstallMessage] = useState(INSTALL_MESSAGES[0])
  const [availableSpace, setAvailableSpace] = useState('...')
  const [videoPath, setVideoPath] = useState('/splash/splash.mp4')

  // Get recommended model based on VRAM
  const getRecommendedModel = (vram?: number): 'ultimate' | 'pro' | 'light' => {
    if (!vram) return 'light'
    if (vram >= 24) return 'ultimate'
    if (vram >= 16) return 'pro'
    return 'light'
  }

  // Format bytes to human readable
  const formatBytes = (bytes: number): string => {
    if (bytes === 0) return '0 B'
    const k = 1024
    const sizes = ['B', 'KB', 'MB', 'GB']
    const i = Math.floor(Math.log(bytes) / Math.log(k))
    return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`
  }

  // Format time remaining
  const formatTimeRemaining = (seconds: number): string => {
    if (!seconds || !isFinite(seconds) || seconds <= 0) return '--'
    if (seconds < 60) return `${Math.round(seconds)}s`
    if (seconds < 3600) return `${Math.round(seconds / 60)}m`
    return `${Math.round(seconds / 3600)}h ${Math.round((seconds % 3600) / 60)}m`
  }

  // Calculate ETA based on speed and remaining bytes
  const getTimeRemaining = (): string => {
    if (!downloadProgress || downloadProgress.speedMbps <= 0) return '--'
    const remainingBytes = downloadProgress.totalBytes - downloadProgress.downloadedBytes
    if (remainingBytes <= 0) return '--'
    const speedBytesPerSec = downloadProgress.speedMbps * 1024 * 1024
    const secondsRemaining = remainingBytes / speedBytesPerSec
    return formatTimeRemaining(secondsRemaining)
  }

  // Initialize
  useEffect(() => {
    const init = async () => {
      try {
        // Get GPU info
        const gpu = await window.electronAPI.checkGpu()
        setGpuInfo(gpu)
        
        // Set recommended model
        const recommended = getRecommendedModel(gpu.vram)
        setSelectedModel(recommended)

        // Get video path for production (unpacked from asar)
        try {
          const resourcePath = await window.electronAPI.getResourcePath?.()
          if (resourcePath) {
            // Production: video is unpacked at app.asar.unpacked
            setVideoPath(`file://${resourcePath}/app.asar.unpacked/dist/splash/splash.mp4`)
          }
        } catch {
          // Dev mode: use relative path
          setVideoPath('/splash/splash.mp4')
        }
        
        // Get models path from backend
        try {
          const backendUrl = await window.electronAPI.getBackendUrl()
          const response = await fetch(`${backendUrl}/api/models/status`)
          if (response.ok) {
            const data = await response.json()
            if (data.models_path) {
              setInstallPath(data.models_path)
            }
          }
        } catch (e) {
          console.error('Failed to get models path:', e)
        }
        
        // TODO: Get actual available space
        setAvailableSpace('1.8 TB')
      } catch (e) {
        console.error('Init error:', e)
      }
    }
    init()
  }, [])

  // Cycle install messages
  useEffect(() => {
    if (currentStep !== 3) return
    let index = 0
    const interval = setInterval(() => {
      index = (index + 1) % INSTALL_MESSAGES.length
      setInstallMessage(INSTALL_MESSAGES[index])
    }, 4000)
    return () => clearInterval(interval)
  }, [currentStep])

  // Poll download progress during installation
  useEffect(() => {
    if (currentStep !== 3) return
    
    const pollProgress = async () => {
      try {
        const progress = await window.electronAPI.getModelDownloadProgress()
        setDownloadProgress(progress)
        
        if (progress.status === 'complete') {
          setTimeout(() => setCurrentStep(4), 600)
        }
      } catch (e) {
        console.error('Progress poll error:', e)
      }
    }
    
    pollProgress()
    const interval = setInterval(pollProgress, 500)
    return () => clearInterval(interval)
  }, [currentStep])

  // Start installation
  const startInstallation = async () => {
    setCurrentStep(3)
    try {
      await window.electronAPI.startModelDownload()
    } catch (e) {
      console.error('Download start error:', e)
    }
  }

  // Handle next button
  const handleNext = () => {
    if (currentStep === 1) {
      setCurrentStep(2)
    } else if (currentStep === 2) {
      startInstallation()
    } else if (currentStep === 4) {
      handleFinish()
    }
  }

  // Handle back button
  const handleBack = () => {
    if (currentStep > 1 && currentStep < 3) {
      setCurrentStep(currentStep - 1)
    }
  }

  // Handle cancel/finish
  const handleCancel = async () => {
    await window.electronAPI.completeSetup()
    onComplete()
  }

  const handleFinish = async () => {
    await window.electronAPI.completeSetup()
    onComplete()
  }

  // Get button text
  const getNextButtonText = () => {
    if (currentStep === 2) return 'Install'
    if (currentStep === 4) return 'Finish'
    return 'Continue'
  }

  return (
    <div className="h-screen flex flex-col" style={{ 
      background: '#000000',
      fontFamily: 'Arial, Helvetica, sans-serif',
      color: '#ffffff'
    }}>
      {/* Custom Title Bar */}
      <div style={{
        height: 32,
        background: '#000000',
        display: 'flex',
        alignItems: 'center',
        paddingLeft: 80,
        borderBottom: '1px solid #1a1a1a',
        // @ts-expect-error - Electron-specific CSS property
        WebkitAppRegion: 'drag'
      }}>
        <span style={{ fontSize: 13, color: '#a0a0a0' }}>LTX Video Studio</span>
      </div>

      {/* Main Container */}
      <div style={{ 
        display: 'flex', 
        flexDirection: 'column', 
        flex: 1,
        // @ts-expect-error - Electron-specific CSS property
        WebkitAppRegion: 'no-drag'
      }}>
        {/* Header */}
        <div style={{
          padding: currentStep === 3 ? '12px 32px' : '16px 32px',
          borderBottom: '1px solid #1a1a1a'
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            {/* LTX Logo */}
            <svg style={{ height: 24, width: 'auto' }} viewBox="0 0 75 32" xmlns="http://www.w3.org/2000/svg" fill="none">
              <path d="M0 30.0087V7.50057C0 7.09765 0.154254 6.69973 0.460162 6.43869C0.708822 6.22729 0.987356 6.12029 1.29316 6.12029H8.2339C8.63671 6.12029 9.03463 6.26205 9.31316 6.55308C9.53944 6.79174 9.65133 7.07777 9.65133 7.41345V23.198C9.65133 23.6108 9.98462 23.944 10.3974 23.944H21.4638C21.8666 23.944 22.267 24.0858 22.5431 24.3767C22.7668 24.6155 22.8812 24.9015 22.8812 25.2372V30.5856C22.8812 31.0457 22.6823 31.4982 22.3018 31.7569C22.078 31.9086 21.8244 31.9832 21.5383 31.9832L1.99199 31.9956C0.890348 31.9981 0 31.1078 0 30.0087Z" fill="white"/>
              <path d="M36.5888 31.9926C34.4062 31.9876 32.492 31.6543 30.8413 30.9878C29.1906 30.3214 27.9104 29.2346 26.9981 27.7227C26.0856 26.2132 25.6333 24.2137 25.6382 21.7269L25.6532 13.7194L21.7016 13.7119C21.3486 13.7119 21.0528 13.5876 20.8116 13.3365C20.5705 13.0853 20.4512 12.7819 20.4537 12.4164L20.4636 7.39299C20.4636 7.02744 20.5854 6.72154 20.8265 6.47288C21.0677 6.22422 21.3635 6.09983 21.7165 6.10233L25.6681 6.10983L25.6779 1.29066C25.6779 0.925114 25.7998 0.619208 26.041 0.370548C26.2821 0.121887 26.5779 0 26.9309 0L33.9065 0.0124913C34.2595 0.0124913 34.5554 0.136772 34.7965 0.387931C35.0376 0.639089 35.1569 0.944995 35.1545 1.30805L35.1445 6.12721L41.2078 6.13959C41.5608 6.13959 41.8566 6.26398 42.0977 6.51514C42.3389 6.76629 42.4582 7.0722 42.4557 7.43525L42.4458 12.4586C42.4458 12.8242 42.3239 13.1301 42.0829 13.3787C41.8417 13.6274 41.5434 13.7518 41.1928 13.7493L35.1296 13.7368L35.1171 20.8988C35.1171 21.8613 35.3061 22.6148 35.6914 23.1618C36.0767 23.7089 36.6833 23.985 37.5186 23.985L41.5608 23.9925C41.9138 23.9925 42.2096 24.1168 42.4507 24.368C42.6919 24.6192 42.8113 24.9251 42.8088 25.2881L42.7988 30.7093C42.7988 31.075 42.677 31.3808 42.4358 31.6294C42.1947 31.8782 41.8963 32.0025 41.5459 32L36.5913 31.9901L36.5888 31.9926Z" fill="white"/>
              <path d="M47.5486 31.9851C47.2282 31.9851 46.965 31.8682 46.7589 31.6369C46.5503 31.4056 46.4485 31.1395 46.4485 30.841C46.4485 30.7416 46.4634 30.6248 46.4957 30.4929C46.5279 30.3611 46.5926 30.2268 46.6869 30.0951L54.3506 18.9342C54.4648 18.7675 54.4673 18.5463 54.3556 18.3771L47.4543 8.01457C47.3896 7.91517 47.335 7.79827 47.2854 7.6664C47.2382 7.53463 47.2133 7.40036 47.2133 7.26859C47.2133 6.97017 47.3251 6.70403 47.5486 6.47275C47.7722 6.24147 48.0279 6.12458 48.316 6.12458H55.6444C56.0914 6.12458 56.4267 6.23158 56.6501 6.44787C56.8737 6.66426 57.0327 6.85328 57.1295 7.01993L60.3082 11.8169C60.5043 12.1128 60.939 12.1128 61.1352 11.8169L64.3139 7.01993C64.4405 6.85328 64.6094 6.66426 64.8156 6.44787C65.0216 6.23158 65.3494 6.12458 65.7964 6.12458H72.7896C73.0778 6.12458 73.331 6.24147 73.557 6.47275C73.7805 6.70403 73.8922 6.95268 73.8922 7.21883C73.8922 7.38547 73.8748 7.53463 73.8451 7.6664C73.8128 7.79827 73.7482 7.91517 73.6539 8.01457L66.6159 18.3747C66.4992 18.5463 66.5017 18.77 66.6209 18.9392L74.4212 30.0975C74.5181 30.2293 74.5801 30.3636 74.6124 30.4954C74.6448 30.6273 74.6596 30.744 74.6596 30.8435C74.6596 31.142 74.5479 31.4081 74.3244 31.6394C74.1008 31.8707 73.8451 31.9874 73.557 31.9874H65.8934C65.4786 31.9874 65.1756 31.888 64.9844 31.689C64.7932 31.4901 64.6317 31.3086 64.5051 31.142L60.9886 25.9544C60.7924 25.671 60.3753 25.6685 60.1766 25.9471L56.4118 31.1395C56.3149 31.3061 56.1634 31.4876 55.9573 31.6865C55.7488 31.8855 55.4383 31.9851 55.0236 31.9851H47.5486Z" fill="white"/>
            </svg>
            <span style={{ 
              fontSize: 13, 
              color: '#a0a0a0', 
              paddingLeft: 12, 
              borderLeft: '1px solid #333' 
            }}>
              Video Studio
            </span>
          </div>
        </div>

        {/* Content Area */}
        <div style={{ 
          flex: 1, 
          padding: currentStep === 3 ? 0 : '28px 32px',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden'
        }}>
          {/* Step 1: Choose Quality */}
          {currentStep === 1 && (
            <div style={{ animation: 'fadeIn 0.25s ease' }}>
              <h2 style={{ 
                fontFamily: "'Miriam Libre', serif", 
                fontSize: 24, 
                fontWeight: 700, 
                marginBottom: 6 
              }}>
                Choose Quality
              </h2>
              <p style={{ color: '#a0a0a0', fontSize: 14, marginBottom: 24 }}>
                Based on your hardware, we suggest {MODEL_TIERS[getRecommendedModel(gpuInfo?.vram)].name}.
              </p>

              {/* GPU Detected Banner */}
              {gpuInfo?.available && (
                <div style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  padding: '12px 16px',
                  background: '#2e3445',
                  borderRadius: 10,
                  fontSize: 13,
                  color: '#a0a0a0',
                  marginBottom: 12
                }}>
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#76b900" strokeWidth="2">
                    <rect x="4" y="4" width="16" height="16" rx="2"/>
                    <rect x="8" y="8" width="8" height="8" rx="1"/>
                  </svg>
                  <span>Detected: <strong style={{ color: '#ffffff' }}>{gpuInfo.name}</strong></span>
                </div>
              )}

              {/* Model Options */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {(Object.keys(MODEL_TIERS) as Array<keyof typeof MODEL_TIERS>).map((key) => {
                  const model = MODEL_TIERS[key]
                  const isSelected = selectedModel === key
                  const isRecommended = key === getRecommendedModel(gpuInfo?.vram)
                  
                  return (
                    <div
                      key={key}
                      onClick={() => setSelectedModel(key)}
                      style={{
                        background: '#2e3445',
                        borderRadius: 12,
                        padding: '14px 18px',
                        display: 'flex',
                        alignItems: 'center',
                        gap: 14,
                        cursor: 'pointer',
                        transition: 'background 0.15s ease'
                      }}
                      onMouseEnter={(e) => e.currentTarget.style.background = '#3a4155'}
                      onMouseLeave={(e) => e.currentTarget.style.background = '#2e3445'}
                    >
                      {/* Radio Button */}
                      <div style={{
                        width: 20,
                        height: 20,
                        border: `2px solid ${isSelected ? '#6D28D9' : '#555'}`,
                        borderRadius: '50%',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        background: isSelected ? '#6D28D9' : 'transparent',
                        flexShrink: 0,
                        transition: 'all 0.15s ease'
                      }}>
                        {isSelected && (
                          <div style={{
                            width: 8,
                            height: 8,
                            background: 'white',
                            borderRadius: '50%'
                          }} />
                        )}
                      </div>

                      {/* Model Details */}
                      <div style={{ flex: 1 }}>
                        <div style={{ 
                          fontFamily: "'Miriam Libre', serif",
                          fontSize: 16,
                          fontWeight: 700,
                          display: 'flex',
                          alignItems: 'center',
                          gap: 10
                        }}>
                          {model.name}
                          {isRecommended && (
                            <span style={{
                              background: 'linear-gradient(125deg, #A98BD9, #6D28D9)',
                              color: '#fff',
                              padding: '2px 8px',
                              borderRadius: 4,
                              fontSize: 10,
                              fontWeight: 600,
                              fontFamily: 'Arial, sans-serif'
                            }}>
                              Best match
                            </span>
                          )}
                        </div>
                        <div style={{ color: '#a0a0a0', fontSize: 12, marginTop: 3 }}>
                          {model.specs}
                        </div>
                      </div>

                      {/* Size */}
                      <div style={{ 
                        color: '#666', 
                        fontSize: 11, 
                        textAlign: 'right',
                        flexShrink: 0
                      }}>
                        {model.size}
                      </div>
                    </div>
                  )
                })}
              </div>

              <p style={{ fontSize: 12, color: '#666', marginTop: 12 }}>
                You can switch versions anytime.
              </p>
            </div>
          )}

          {/* Step 2: Choose Location */}
          {currentStep === 2 && (
            <div style={{ animation: 'fadeIn 0.25s ease' }}>
              <h2 style={{ 
                fontFamily: "'Miriam Libre', serif", 
                fontSize: 24, 
                fontWeight: 700, 
                marginBottom: 6 
              }}>
                Choose Location
              </h2>
              <p style={{ color: '#a0a0a0', fontSize: 14, marginBottom: 24 }}>
                Select where to install the model files.
              </p>

              <div style={{
                background: '#2e3445',
                borderRadius: 12,
                padding: '14px 18px'
              }}>
                <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
                  <input
                    type="text"
                    value={installPath}
                    readOnly
                    style={{
                      flex: 1,
                      background: '#1a1a1a',
                      border: '1px solid #333',
                      borderRadius: 8,
                      padding: '12px 14px',
                      color: '#ffffff',
                      fontSize: 13,
                      fontFamily: "'Consolas', 'Monaco', monospace"
                    }}
                  />
                  <button
                    onClick={async () => {
                      // Would open folder dialog in real implementation
                    }}
                    style={{
                      padding: '10px 28px',
                      borderRadius: 9999,
                      fontSize: 13,
                      fontWeight: 600,
                      cursor: 'pointer',
                      background: 'transparent',
                      border: '1px solid #444',
                      color: '#ffffff',
                      transition: 'all 0.2s ease'
                    }}
                  >
                    Browse
                  </button>
                </div>

                <div style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  fontSize: 12,
                  color: '#a0a0a0',
                  marginTop: 10
                }}>
                  <span>Required: <strong style={{ color: '#fff' }}>{MODEL_TIERS[selectedModel].size}</strong></span>
                  <span>Available: <strong style={{ color: '#fff' }}>{availableSpace}</strong></span>
                </div>
              </div>
            </div>
          )}

          {/* Step 3: Installing */}
          {currentStep === 3 && (
            <div style={{ 
              position: 'relative',
              height: '100%',
              animation: 'fadeIn 0.25s ease'
            }}>
              {/* Video Section - fills container but leaves room for progress */}
              <div style={{
                position: 'absolute',
                top: 0,
                left: 0,
                right: 0,
                bottom: 140,
                background: '#0a0a0a',
                overflow: 'hidden'
              }}>
                {/* Splash Video */}
                <video
                  key={videoPath}
                  autoPlay
                  loop
                  muted
                  playsInline
                  style={{
                    width: '100%',
                    height: '100%',
                    objectFit: 'cover',
                    display: 'block'
                  }}
                >
                  <source src={videoPath} type="video/mp4" />
                </video>

                {/* Video Credit */}
                <div style={{
                  position: 'absolute',
                  bottom: 20,
                  left: 24,
                  fontFamily: "'Miriam Libre', serif",
                  fontSize: 13,
                  color: 'rgba(255,255,255,0.75)',
                  textShadow: '0 1px 4px rgba(0,0,0,0.9)',
                  zIndex: 10
                }}>
                  Generated by PongFlongo
                </div>
              </div>

              {/* Progress Section - fixed at bottom */}
              <div style={{
                position: 'absolute',
                left: 0,
                right: 0,
                bottom: 0,
                height: 140,
                background: '#0d0d0d',
                padding: '16px 24px',
                borderTop: '1px solid #2a2a2a'
              }}>
                {/* Header row with status and percentage */}
                <div style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  marginBottom: 8
                }}>
                  <span style={{ fontSize: 13, fontWeight: 500 }}>
                    {(downloadProgress?.totalProgress || 0) > 85 ? 'Installing...' : 'Downloading...'}
                  </span>
                  <span style={{ fontSize: 13, color: '#A98BD9', fontWeight: 600 }}>
                    {downloadProgress?.totalProgress || 0}%
                  </span>
                </div>

                {/* Progress Bar */}
                <div style={{
                  height: 6,
                  background: '#1a1a1a',
                  borderRadius: 3,
                  overflow: 'hidden'
                }}>
                  <div style={{
                    height: '100%',
                    background: 'linear-gradient(125deg, #A98BD9, #6D28D9, #194DF9)',
                    backgroundSize: '200% 200%',
                    animation: 'gradientShift 3s ease infinite',
                    borderRadius: 3,
                    width: `${downloadProgress?.totalProgress || 0}%`,
                    transition: 'width 0.3s ease'
                  }} />
                </div>

                {/* Download stats row */}
                <div style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  marginTop: 10,
                  fontSize: 12,
                  color: '#a0a0a0'
                }}>
                  {/* Current file */}
                  <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {downloadProgress?.currentFile || installMessage}
                  </span>
                  
                  {/* Speed and ETA */}
                  <div style={{ display: 'flex', gap: 16, marginLeft: 16, flexShrink: 0 }}>
                    {downloadProgress && downloadProgress.speedMbps > 0 && (
                      <span style={{ color: '#6D28D9', fontWeight: 500 }}>
                        {downloadProgress.speedMbps.toFixed(1)} MB/s
                      </span>
                    )}
                    {downloadProgress && downloadProgress.totalBytes > 0 && (
                      <span>
                        {formatBytes(downloadProgress.downloadedBytes)} / {formatBytes(downloadProgress.totalBytes)}
                      </span>
                    )}
                    {downloadProgress && downloadProgress.speedMbps > 0 && (
                      <span>
                        ETA: {getTimeRemaining()}
                      </span>
                    )}
                  </div>
                </div>

                {/* Files progress */}
                {downloadProgress && downloadProgress.totalFiles > 0 && (
                  <div style={{
                    marginTop: 6,
                    fontSize: 11,
                    color: '#666'
                  }}>
                    File {downloadProgress.filesCompleted + 1} of {downloadProgress.totalFiles}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Step 4: Complete */}
          {currentStep === 4 && (
            <div style={{ 
              flex: 1,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              textAlign: 'center',
              animation: 'fadeIn 0.25s ease'
            }}>
              {/* Success Icon */}
              <div style={{
                width: 72,
                height: 72,
                background: 'linear-gradient(125deg, #A98BD9, #6D28D9, #194DF9)',
                borderRadius: '50%',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                marginBottom: 20
              }}>
                <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5">
                  <polyline points="20 6 9 17 4 12"/>
                </svg>
              </div>

              <h2 style={{ 
                fontFamily: "'Miriam Libre', serif",
                fontSize: 26,
                fontWeight: 700,
                marginBottom: 8
              }}>
                Ready to Create
              </h2>
              <p style={{ color: '#a0a0a0', fontSize: 14, maxWidth: 320 }}>
                LTX Video is installed. Start generating.
              </p>

              {/* Install Summary */}
              <div style={{
                background: '#2e3445',
                borderRadius: 12,
                padding: '16px 28px',
                marginTop: 20,
                textAlign: 'left',
                minWidth: 260
              }}>
                <div style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  padding: '8px 0',
                  fontSize: 13,
                  borderBottom: '1px solid #3a4155'
                }}>
                  <span style={{ color: '#a0a0a0' }}>Model</span>
                  <span style={{ fontWeight: 500 }}>{MODEL_TIERS[selectedModel].name}</span>
                </div>
                <div style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  padding: '8px 0',
                  fontSize: 13
                }}>
                  <span style={{ color: '#a0a0a0' }}>Location</span>
                  <span style={{ fontWeight: 500, maxWidth: 150, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {installPath.split('\\').pop() || installPath}
                  </span>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div style={{
          padding: currentStep === 3 ? '12px 24px' : '16px 32px',
          borderTop: '1px solid #1a1a1a',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center'
        }}>
          <div style={{ fontSize: 11, color: '#666' }}>© 2026 Lightricks</div>
          
          <div style={{ display: 'flex', gap: 10 }}>
            {/* Back Button */}
            {currentStep === 2 && (
              <button
                onClick={handleBack}
                style={{
                  padding: '10px 28px',
                  borderRadius: 9999,
                  fontSize: 13,
                  fontWeight: 600,
                  cursor: 'pointer',
                  background: 'transparent',
                  border: '1px solid #444',
                  color: '#ffffff',
                  transition: 'all 0.2s ease'
                }}
              >
                Back
              </button>
            )}

            {/* Cancel Button */}
            {currentStep < 4 && (
              <button
                onClick={handleCancel}
                style={{
                  padding: '10px 28px',
                  borderRadius: 9999,
                  fontSize: 13,
                  fontWeight: 600,
                  cursor: 'pointer',
                  background: 'transparent',
                  border: '1px solid #444',
                  color: '#ffffff',
                  transition: 'all 0.2s ease'
                }}
              >
                Cancel
              </button>
            )}

            {/* Next/Install/Finish Button */}
            {currentStep !== 3 && (
              <button
                onClick={handleNext}
                style={{
                  padding: '10px 28px',
                  borderRadius: 9999,
                  fontSize: 13,
                  fontWeight: 700,
                  cursor: 'pointer',
                  background: '#ffffff',
                  border: 'none',
                  color: '#000000',
                  transition: 'all 0.2s ease'
                }}
              >
                {getNextButtonText()}
              </button>
            )}
          </div>
        </div>
      </div>

      {/* CSS Animations */}
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Miriam+Libre:wght@400;700&display=swap');
        
        @keyframes fadeIn {
          from { opacity: 0; }
          to { opacity: 1; }
        }
        
        @keyframes gradientShift {
          0% { background-position: 0% 50%; }
          50% { background-position: 100% 50%; }
          100% { background-position: 0% 50%; }
        }
        
        @keyframes gradientBg {
          0% { background-position: 0% 50%; }
          50% { background-position: 100% 50%; }
          100% { background-position: 0% 50%; }
        }
        
        @keyframes pulse {
          0%, 100% { transform: scale(1); opacity: 1; }
          50% { transform: scale(1.05); opacity: 0.9; }
        }
      `}</style>
    </div>
  )
}
