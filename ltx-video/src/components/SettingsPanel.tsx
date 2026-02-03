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
    onSettingsChange({ ...settings, [key]: value })
  }

  return (
    <div className="space-y-4">
      {/* Model Selection */}
      <Select
        label="Model"
        value={settings.model}
        onChange={(e) => handleChange('model', e.target.value)}
        disabled={disabled}
      >
        <option value="fast">Fast (Distilled)</option>
        <option value="pro">Pro</option>
      </Select>

      {/* Duration, Resolution, FPS Row */}
      <div className="grid grid-cols-3 gap-3">
        <Select
          label="Duration"
          value={settings.duration}
          onChange={(e) => handleChange('duration', parseInt(e.target.value))}
          disabled={disabled}
        >
          <option value={5}>5 sec</option>
          <option value={8}>8 sec</option>
          <option value={10}>10 sec</option>
        </Select>

        <Select
          label="Resolution"
          value={settings.resolution}
          onChange={(e) => handleChange('resolution', e.target.value)}
          disabled={disabled}
        >
          <option value="512p">512p (768x512) - Fast</option>
          <option value="720p">720p (1216x704) - Standard</option>
          <option value="1080p">1080p (1920x1088) - High Quality</option>
        </Select>

        <Select
          label="FPS"
          value={settings.fps}
          onChange={(e) => handleChange('fps', parseInt(e.target.value))}
          disabled={disabled}
        >
          <option value={24}>24</option>
          <option value={25}>25</option>
          <option value={30}>30</option>
        </Select>
      </div>

      {/* Audio and Camera Motion Row */}
      <div className="grid grid-cols-2 gap-3">
        <Select
          label="Audio"
          value={settings.audio ? 'on' : 'off'}
          onChange={(e) => handleChange('audio', e.target.value === 'on')}
          disabled={disabled}
        >
          <option value="on">On</option>
          <option value="off">Off</option>
        </Select>

        <Select
          label="Camera Motion"
          value={settings.cameraMotion}
          onChange={(e) => handleChange('cameraMotion', e.target.value)}
          disabled={disabled}
        >
          <option value="none">None</option>
          <option value="dolly_in">Dolly In</option>
          <option value="dolly_out">Dolly Out</option>
          <option value="jib_up">Jib Up</option>
          <option value="jib_down">Jib Down</option>
          <option value="static">Static</option>
        </Select>
      </div>
    </div>
  )
}
