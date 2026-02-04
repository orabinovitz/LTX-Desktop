import React from 'react'
import { Select } from './ui/select'

export interface GenerationSettings {
  model: 'fast' | 'pro'
  duration: number
  resolution: string
  fps: number
  audio: boolean
  cameraMotion: string
}

interface SettingsPanelProps {
  settings: GenerationSettings
  onSettingsChange: (settings: GenerationSettings) => void
  disabled?: boolean
}

export function SettingsPanel({ settings, onSettingsChange, disabled }: SettingsPanelProps) {
  const handleChange = (key: keyof GenerationSettings, value: string | number | boolean) => {
    // If switching to Pro and duration is 20, reset to 10
    if (key === 'model' && value === 'pro' && settings.duration === 20) {
      onSettingsChange({ ...settings, [key]: value, duration: 10 })
      return
    }
    onSettingsChange({ ...settings, [key]: value })
  }

  const isPro = settings.model === 'pro'

  return (
    <div className="space-y-4">
      {/* Model Selection */}
      <div>
        <Select
          label="Model"
          value={settings.model}
          onChange={(e) => handleChange('model', e.target.value)}
          disabled={disabled}
        >
          <option value="fast">Fast - Optimized for speed</option>
          <option value="pro">Pro - Balanced for quality and speed</option>
        </Select>
        {settings.model === 'pro' && (
          <p className="text-[10px] text-zinc-500 mt-1">
            First generation with Pro may take longer to load
          </p>
        )}
      </div>

      {/* Duration, Resolution, FPS Row */}
      <div className="grid grid-cols-3 gap-3">
        <Select
          label="Duration"
          value={settings.duration}
          onChange={(e) => handleChange('duration', parseInt(e.target.value))}
          disabled={disabled}
        >
          <option value={6}>6 sec</option>
          <option value={8}>8 sec</option>
          <option value={10}>10 sec</option>
          <option value={20} disabled={isPro} className={isPro ? 'text-muted-foreground/50' : ''}>
            20 sec
          </option>
        </Select>

        <Select
          label="Resolution"
          value={settings.resolution}
          onChange={(e) => handleChange('resolution', e.target.value)}
          disabled={disabled}
        >
          <option value="1080p">1080p</option>
          <option value="720p">720p</option>
          <option value="480p">480p</option>
        </Select>

        <Select
          label="FPS"
          value={settings.fps}
          onChange={(e) => handleChange('fps', parseInt(e.target.value))}
          disabled={disabled}
        >
          <option value={25}>25</option>
          <option value={24}>24</option>
          <option value={16}>16</option>
        </Select>
      </div>

      {/* Audio and Camera Motion Row */}
      <div className="flex gap-3">
        <div className="w-[140px] flex-shrink-0">
          <Select
            label="Audio"
            badge="PREVIEW"
            value={settings.audio ? 'on' : 'off'}
            onChange={(e) => handleChange('audio', e.target.value === 'on')}
            disabled={disabled}
          >
            <option value="on">On</option>
            <option value="off">Off</option>
          </Select>
        </div>

        <div className="flex-1">
          <Select
            label="Camera Motion"
            value={settings.cameraMotion}
            onChange={(e) => handleChange('cameraMotion', e.target.value)}
            disabled={disabled}
          >
            <option value="none">None</option>
            <option value="static">Static</option>
            <option value="focus_shift">Focus Shift</option>
            <option value="dolly_in">Dolly In</option>
            <option value="dolly_out">Dolly Out</option>
            <option value="dolly_left">Dolly Left</option>
            <option value="dolly_right">Dolly Right</option>
            <option value="jib_up">Jib Up</option>
            <option value="jib_down">Jib Down</option>
          </Select>
        </div>
      </div>
    </div>
  )
}
