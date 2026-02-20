import { execSync } from 'child_process'
import { BACKEND_BASE_URL } from './config'
import { getPythonPath } from './python-backend'

// Check if NVIDIA GPU is available
export async function checkGPU(): Promise<{ available: boolean; name?: string; vram?: number }> {
  try {
    // Try to get GPU info from the backend API first (more reliable)
    const response = await fetch(`${BACKEND_BASE_URL}/api/gpu-info`, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
    })

    if (response.ok) {
      const data = await response.json()
      return {
        available: data.cuda_available ?? false,
        name: data.gpu_name,
        vram: data.vram_gb
      }
    }
  } catch (error) {
    console.log('Backend GPU check failed, trying direct check:', error)
  }

  // Fallback: try direct Python check
  try {
    const pythonPath = getPythonPath()
    const result = execSync(`"${pythonPath}" -c "import torch; print(torch.cuda.is_available()); print(torch.cuda.get_device_name(0) if torch.cuda.is_available() else ''); print(torch.cuda.get_device_properties(0).total_memory // (1024**3) if torch.cuda.is_available() else 0)"`, {
      encoding: 'utf-8',
      timeout: 30000,
      windowsHide: true
    }).trim().split('\n')

    return {
      available: result[0] === 'True',
      name: result[1] || undefined,
      vram: parseInt(result[2]) || undefined
    }
  } catch (error) {
    console.error('Direct GPU check also failed:', error)
    return { available: false }
  }
}
