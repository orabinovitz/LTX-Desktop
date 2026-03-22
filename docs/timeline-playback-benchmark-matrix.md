# Timeline Playback Benchmark Matrix

This matrix is the reproducible playback target for timeline preview audio work. The goal is to make audio continuity the protected resource: under stress, the system should degrade video fidelity, warmed decode breadth, and secondary effects before it allows audible crackle, underruns, or missing micro-segments.

## Hardware tiers

| Tier | Example profile | Target behavior |
| --- | --- | --- |
| `low-end` | older laptop CPU, integrated GPU, constrained thermals | Preview stays continuous by dropping to `audio-priority` or `proxy-required` mode under load |
| `mid-range` | modern laptop CPU, integrated or entry GPU | `balanced` mode should hold for most multi-track edits |
| `high-end` | desktop or workstation GPU/CPU | `full` mode should hold on all but pathological timelines |

## Codec classes

| Class | Examples | Risk |
| --- | --- | --- |
| `editing-friendly` | ProRes, DNxHR, intraframe mezzanine | Lowest decode contention |
| `consumer-long-gop` | H.264, H.265/HEVC | High decode cost and seek churn risk |
| `audio-light` | AAC stereo, WAV mono/stereo | Baseline audio decode |
| `audio-heavy` | long clips, stacked music/SFX/VO, VBR | Higher overlap and buffering pressure |

## Benchmark scenarios

| Scenario | Purpose | Stressors | Expected tier on low-end |
| --- | --- | --- | --- |
| `single-clip-baseline` | Baseline sanity check for 1x playback | Single visible clip, single audible source | `full` |
| `many-cuts` | Measures seek churn and decoder restart pressure | High cut density, frequent clip boundaries | `balanced` |
| `audio-overlap-stack` | Protects audio continuity under mix pressure | 4-8 simultaneous audible clips, music + SFX + VO | `audio-priority` |
| `dissolve-composite` | Measures visual complexity without audio regressions | Dissolves, opacity stacks, compositing | `balanced` |
| `low-end-stress` | Worst-case regression gate | Overlaps + compositing + heavy cuts + long timeline | `proxy-required` |

## Run matrix

Run every scenario against:

| Hardware | Codec | Notes |
| --- | --- | --- |
| `low-end` | `consumer-long-gop` + `audio-heavy` | Primary regression gate |
| `low-end` | `editing-friendly` + `audio-heavy` | Distinguishes decode starvation from audio scheduling issues |
| `mid-range` | `consumer-long-gop` + `audio-heavy` | Should remain usable without audible breakup |
| `high-end` | `consumer-long-gop` + `audio-heavy` | Ensures fixes do not over-degrade capable machines |

## Metrics to capture

- `p95` preview drift in seconds
- audio hard seeks per minute
- video hard seeks per minute
- play retries per minute
- underruns per run
- active audible sources
- active video sources
- long tasks over `50ms`
- selected performance tier
- selected decode-window policy

## Pass criteria

- `single-clip-baseline`: no underruns, no audible crackle, no hard seeks after warm-up
- `many-cuts`: cut churn does not produce audible clicks or gaps
- `audio-overlap-stack`: audio remains continuous, master gain prevents harsh clipping
- `dissolve-composite`: visual degradation is acceptable if audio continuity is preserved
- `low-end-stress`: system may drop resolution/proxy aggressively, but audible playback must remain stable
