---
name: Template re-render jitter
description: Why full-rebuild template engines replay CSS enter-animations and how to suppress them reliably
---

The in-house template engine rebuilds the whole DOM (`replaceChildren`) on every state change. Any inline CSS enter-animation (e.g. `animation:fadeUp .3s`) replays on every rebuild — including data-only re-renders triggered by field blur — producing a visible "jitter" (content fades out/in mid-typing).

**Rule:** suppress enter-animations at BUILD time (strip the declaration from the inline style before the node is created) when step/screen is unchanged. Do NOT try to patch animations after DOM insertion (`style.animationDuration = '0.001s'` post-`replaceChildren`) — that approach failed in practice.

**Why:** post-insertion patches proved unreliable (user video showed the 300ms fade still replaying); build-time stripping is deterministic.

**How to apply:** any new enter-animation added to a screen managed by the template engine must go through the same suppression path, or it will replay on every field blur. Debugging tip: user bug videos in attached_assets can be frame-extracted with ffmpeg + `compare -metric AE` to localize visual jumps.
