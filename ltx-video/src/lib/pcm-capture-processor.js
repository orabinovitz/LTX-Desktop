/**
 * AudioWorklet processor that captures mic input and downsamples to 16kHz
 * mono PCM Int16 for the Gemini Live API.
 *
 * Loaded via `audioContext.audioWorklet.addModule(url)`.
 * Communicates with the main thread by posting Int16Array buffers.
 */

const TARGET_SAMPLE_RATE = 16000

class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this._buffer = new Float32Array(0)
  }

  process(inputs) {
    const input = inputs[0]
    if (!input || input.length === 0) return true

    const channelData = input[0]
    if (!channelData || channelData.length === 0) return true

    const ratio = sampleRate / TARGET_SAMPLE_RATE
    const combined = new Float32Array(this._buffer.length + channelData.length)
    combined.set(this._buffer)
    combined.set(channelData, this._buffer.length)

    const outputLength = Math.floor(combined.length / ratio)
    if (outputLength === 0) {
      this._buffer = combined
      return true
    }

    const pcm16 = new Int16Array(outputLength)
    for (let i = 0; i < outputLength; i++) {
      const srcIndex = Math.floor(i * ratio)
      const sample = Math.max(-1, Math.min(1, combined[srcIndex]))
      pcm16[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff
    }

    const consumed = Math.floor(outputLength * ratio)
    this._buffer = combined.slice(consumed)

    this.port.postMessage(pcm16.buffer, [pcm16.buffer])
    return true
  }
}

registerProcessor('pcm-capture-processor', PcmCaptureProcessor)
