# Open House — app

Turn phone photos of a home into a walkable 3D tour with golden-hour edits.

This app was built by **Gemini 4 Argon in Google AI Studio** (Build mode) at the Gemini 4 Argon SF Hackathon, Oct 25 2026. It is a thin UI: the pipeline it runs is the Open House harness, loaded from GitHub at a pinned commit — not copied into this repo:

- `https://cdn.jsdelivr.net/gh/icomppower/open-house@3f38f72/src/…` (harness, Gemini adapter, 3D viewer, report, export)
- Harness repo: https://github.com/icomppower/open-house

**Live app:** https://open-house-ai.ai.studio · **Demo video:** https://youtu.be/hjP61BlFWkM

## What it does

Upload photos → six steps run on Gemini 4 Argon (`gemini-4-argon`) with a checkpoint after each:
prepare → ingest (rooms, materials, objects) → layout (rooms in metres, doors, furniture, one camera per photo) → enhance (golden-hour edit plans; edits by the image model) → judge (scores every edit and tour stop, redoes weak edits) → narrate.
Every step's answer is checked by the harness validators; failed steps can be resumed; "How it was made" is rebuilt only from the call trace. "Load saved run" replays a saved run state with no model calls.

Thinking levels used: `ingest: 'medium'`, `layout: 'low'`, `narrate: 'low'` (layout at `'high'` exceeded a 300-second per-call limit on 8+ rooms).

## Hackathon run (10 photos, run `run_mvo7ujv7_12cgat`)

55 calls (41 Argon + 14 image edits) · 1 validator retry · 4 edits redone (2 rose from 3/5 to 5/5, 2 flagged) · judge mean 4.2/5 · tour mean 2.5/5 · ~17 min model time.
Note: in this run the layout step is a hand-drawn stand-in (0 layout calls in the report) after Argon's layout hit the time limit at high thinking and failed validation at low thinking.

## Run locally

Prerequisites: Node.js.

1. `npm install`
2. Put your own `GEMINI_API_KEY` in `.env.local` (see `.env.example`; never commit it)
3. `npm run dev`

All rights reserved.
