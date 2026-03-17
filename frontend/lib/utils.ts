import { type ClassValue, clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function formatTimeRemaining(seconds: number): string {
  if (!seconds || !isFinite(seconds) || seconds <= 0) return '--'
  if (seconds < 60) return `${Math.round(seconds)}s`
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`
  return `${Math.round(seconds / 3600)}h ${Math.round((seconds % 3600) / 60)}m`
}

export function formatDuration(
  seconds: number,
  opts?: { pad?: boolean; decimals?: number },
): string {
  const pad = opts?.pad ?? true
  const decimals = opts?.decimals ?? 0
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  const mStr = pad ? String(m).padStart(2, '0') : String(m)
  if (decimals > 0) {
    return `${mStr}:${s.toFixed(decimals).padStart(3 + decimals, '0')}`
  }
  return `${mStr}:${String(Math.floor(s)).padStart(2, '0')}`
}
