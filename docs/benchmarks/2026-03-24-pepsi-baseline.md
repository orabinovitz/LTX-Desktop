# Pepsi Baseline Benchmark

## Prompt
`i want to create a pepsi video advertisement for the 2026 world cup, write a concept, then create the images, do visual identity research, create videos and edit a timeline - so the entire process, it should be 30 seconds long`

## Live Planner Baseline
Live run against the local authenticated backend on `2026-03-24` produced this top-level DAG:

1. `task-1` creative: write concept and script
2. `task-2` creative: visual identity bible
3. `task-3` creative: concrete visual style
4. `task-4` execution: generate all shots from the shot list
5. `task-5` execution: create timeline, add clips in script order

Observed problem: there is still no dedicated structured review or correction stage before the timeline pass for this prompt shape.

## Live Script Baseline
The live `advertising-screenwriter` run saved this concept/script:

```markdown
# Concept: The Catalyst Drop

## Script

Shot 1 (8s): Extreme close-up of an ice-cold Pepsi can in a moody, neon-lit tunnel. Condensation builds. A single drop rolls down the aluminum. Match cut to a footballer's intense eyes in a massive, roaring stadium, a drop of sweat rolling down their brow as they line up a game-winning free kick.

Shot 2 (6s): The condensation drop hits the surface below. Instantly, a hand cracks open the Pepsi can with a sharp, explosive burst of fizz. Simultaneously, the footballer's boot strikes the ball with immense power, sending dirt and grass flying into the air.

Shot 3 (8s): The football rockets past the diving goalkeeper into the top corner of the net. The stadium erupts in a massive, chaotic wave of cheering fans and blue confetti. Match cut to dark, sparkling Pepsi liquid pouring over ice in a glass, splashing with high energy.

Shot 4 (8s): The goal-scoring footballer slides on the grass in a triumphant celebration, roaring at the camera. Cut to a passionate fan in the stands throwing their head back, taking a deeply refreshing gulp of Pepsi. The screen wipes to the Pepsi globe logo and the 2026 World Cup emblem. Text overlay: "THIRSTY FOR GREATNESS."
```

## Benchmark Scorecard
Profile: `brand_cinematic`

- `shot_count`: `4`
- `total_planned_seconds`: `30`
- `average_shot_seconds`: `7.5`
- `generated_shot_count`: `4`
- `final_timeline_clip_count`: `4`
- `meaningful_edit_operations`: `0` in the known failed run shape

Failures:

- `under_covered`: planned only `4` shots; current benchmark floor is `6` for a 30-second cinematic brand ad.
- `no_real_edit`: the known failed run shape produced a linear assembly of generated shots with no meaningful editorial operations beyond placement.

## Why This Baseline Matters
- The failure is reproducible before any edits to the system.
- The planner and screenwriter still normalize a four-shot 30-second ad.
- The benchmark now has a concrete baseline to beat in later phases.
