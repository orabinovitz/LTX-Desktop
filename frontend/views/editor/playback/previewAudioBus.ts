import { logger } from '../../../lib/logger'

interface ManagedAudioNode {
  element: HTMLAudioElement
  source: MediaElementAudioSourceNode
  gain: GainNode
}

export class PreviewAudioBus {
  private audioContext: AudioContext | null = null

  private compressor: DynamicsCompressorNode | null = null

  private readonly nodes = new Map<string, ManagedAudioNode>()

  private ensureContext(): AudioContext | null {
    if (this.audioContext) return this.audioContext

    const AudioContextCtor = window.AudioContext || (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!AudioContextCtor) {
      return null
    }

    const context = new AudioContextCtor()
    const compressor = context.createDynamicsCompressor()
    compressor.threshold.value = -18
    compressor.knee.value = 12
    compressor.ratio.value = 4
    compressor.attack.value = 0.003
    compressor.release.value = 0.12

    const masterGain = context.createGain()
    masterGain.gain.value = 0.85

    compressor.connect(masterGain)
    masterGain.connect(context.destination)

    this.audioContext = context
    this.compressor = compressor
    return context
  }

  async ensureReady(): Promise<boolean> {
    const context = this.ensureContext()
    if (!context) return false

    if (context.state === 'suspended') {
      try {
        await context.resume()
      } catch (error) {
        logger.warn(`[preview-audio-bus] Failed to resume audio context: ${String(error)}`)
      }
    }

    return context.state === 'running'
  }

  isReady(): boolean {
    return this.audioContext?.state === 'running'
  }

  private ensureNode(clipId: string, element: HTMLAudioElement): ManagedAudioNode | null {
    const context = this.ensureContext()
    const compressor = this.compressor
    if (!context || !compressor) return null

    const existing = this.nodes.get(clipId)
    if (existing && existing.element === element) {
      return existing
    }

    if (existing) {
      try {
        existing.source.disconnect()
        existing.gain.disconnect()
      } catch {
        // ignore disconnect failures on partially-connected nodes
      }
      this.nodes.delete(clipId)
    }

    try {
      const source = context.createMediaElementSource(element)
      const gain = context.createGain()
      gain.gain.value = 0
      source.connect(gain)
      gain.connect(compressor)
      const managedNode = { element, source, gain }
      this.nodes.set(clipId, managedNode)
      return managedNode
    } catch (error) {
      logger.warn(`[preview-audio-bus] Failed to route clip ${clipId} through Web Audio: ${String(error)}`)
      return null
    }
  }

  syncClip(clipId: string, element: HTMLAudioElement, targetGain: number): boolean {
    const node = this.ensureNode(clipId, element)
    const context = this.audioContext
    if (!node || !context) return false

    const now = context.currentTime
    const currentGain = node.gain.gain.value
    node.gain.gain.cancelScheduledValues(now)
    node.gain.gain.setValueAtTime(currentGain, now)
    node.gain.gain.linearRampToValueAtTime(targetGain, now + 0.015)
    return true
  }

  muteInactive(activeClipIds: Set<string>): void {
    const context = this.audioContext
    if (!context) return

    const now = context.currentTime
    for (const [clipId, node] of this.nodes) {
      if (activeClipIds.has(clipId)) continue
      const currentGain = node.gain.gain.value
      node.gain.gain.cancelScheduledValues(now)
      node.gain.gain.setValueAtTime(currentGain, now)
      node.gain.gain.linearRampToValueAtTime(0, now + 0.02)
    }
  }

  getElementCurrentTime(clipId: string): number | null {
    return this.nodes.get(clipId)?.element.currentTime ?? null
  }

  disconnectAll(): void {
    for (const node of this.nodes.values()) {
      try {
        node.source.disconnect()
        node.gain.disconnect()
      } catch {
        // ignore disconnect failures during teardown
      }
    }
    this.nodes.clear()
  }

  async destroy(): Promise<void> {
    this.disconnectAll()
    if (this.audioContext && this.audioContext.state !== 'closed') {
      await this.audioContext.close()
    }
    this.audioContext = null
    this.compressor = null
  }
}
