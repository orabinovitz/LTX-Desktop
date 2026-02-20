import { spawn, ChildProcess } from 'child_process'
import path from 'path'
import fs from 'fs'
import { isDev, getCurrentDir, PYTHON_PORT } from './config'

let pythonProcess: ChildProcess | null = null

function getBackendPath(): string {
  if (isDev) {
    return path.join(getCurrentDir(), 'backend')
  }
  return path.join(process.resourcesPath, 'backend')
}

export function getPythonPath(): string {
  // In production, use bundled Python first
  if (!isDev) {
    const bundledPython = process.platform === 'win32'
      ? path.join(process.resourcesPath, 'python', 'python.exe')
      : path.join(process.resourcesPath, 'python', 'bin', 'python3')
    if (fs.existsSync(bundledPython)) {
      console.log(`Using bundled Python: ${bundledPython}`)
      return bundledPython
    }
  }

  // Check for venv in backend directory
  const backendPath = getBackendPath()
  const isWindows = process.platform === 'win32'
  const venvPython = isWindows
    ? path.join(backendPath, '.venv', 'Scripts', 'python.exe')
    : path.join(backendPath, '.venv', 'bin', 'python')

  if (fs.existsSync(venvPython)) {
    console.log(`Using venv Python: ${venvPython}`)
    return venvPython
  }

  if (isDev) {
    // In development, try common Python paths
    const pythonPaths = isWindows
      ? [
          'python',
          'python3',
          path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Python', 'Python311', 'python.exe'),
          path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Python', 'Python312', 'python.exe'),
        ]
      : [
          'python3',
          'python',
        ]

    for (const p of pythonPaths) {
      try {
        if (fs.existsSync(p)) {
          return p
        }
      } catch {
        continue
      }
    }
    return isWindows ? 'python' : 'python3'
  }

  // Fallback
  return 'python'
}

export async function startPythonBackend(): Promise<void> {
  return new Promise((resolve, reject) => {
    const pythonPath = getPythonPath()
    const backendPath = getBackendPath()
    const mainPy = path.join(backendPath, 'ltx2_server.py')

    console.log(`Starting Python backend: ${pythonPath} ${mainPy}`)

    pythonProcess = spawn(pythonPath, ['-u', mainPy], {
      cwd: backendPath,
      env: {
        ...process.env,
        PYTHONUNBUFFERED: '1',
        LTX_PORT: String(PYTHON_PORT),
      },
      stdio: ['ignore', 'pipe', 'pipe']
    })

    let started = false

    const checkStarted = (output: string) => {
      // Check if server has started
      if (!started && (output.includes('Server running on') || output.includes('Uvicorn running'))) {
        started = true
        resolve()
      }
    }

    pythonProcess.stdout?.on('data', (data: Buffer) => {
      const output = data.toString()
      console.log(`[Python] ${output}`)
      checkStarted(output)
    })

    pythonProcess.stderr?.on('data', (data: Buffer) => {
      const output = data.toString()
      console.error(`[Python Error] ${output}`)
      checkStarted(output)
    })

    pythonProcess.on('error', (error) => {
      console.error('Failed to start Python backend:', error)
      reject(error)
    })

    pythonProcess.on('exit', (code) => {
      console.log(`Python backend exited with code ${code}`)
      pythonProcess = null
    })

    // Timeout after 5 minutes (model loading can take a while on first run)
    setTimeout(() => {
      if (!started) {
        reject(new Error('Python backend failed to start within 5 minutes'))
      }
    }, 300000)
  })
}

export function stopPythonBackend(): void {
  if (pythonProcess) {
    console.log('Stopping Python backend...')
    pythonProcess.kill('SIGTERM')
    pythonProcess = null
  }
}
