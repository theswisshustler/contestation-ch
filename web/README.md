# web/ — contestation.ch front-end

Implementation of the `Contestation.dc.html` design (imported from Claude Design)
as a self-contained, runnable single-page app. No build step and no framework.

## Files

| File          | Role |
|---------------|------|
| `index.html`  | Page shell + the design markup, embedded verbatim inside `<template id="dc-template">`. |
| `support.js`  | Tiny runtime that renders the `.dc` template format (`sc-if`, `sc-for`, `{{ }}` interpolation, `onClick`/`onInput`/`ref` bindings) against a component's `renderVals()`. Reimplements the design's `support.js`. |
| `app.js`      | The component: full screen state-machine and the contestation ruleset (cantons, authorities, motifs, delays), ported verbatim from the design source. |

The ruleset in `app.js` mirrors `src/contestation-ruleset.ts` (the back-end source
of truth). If the TypeScript ruleset changes, update the ported logic here too.

## Run locally

```bash
python3 -m http.server 8123 --directory web
# open http://localhost:8123/index.html
```

Any static file server works — the app is pure client-side HTML/CSS/JS.

## Covered screens

Landing (with the free eligibility calculator) · parcours choice · manual
questionnaire (11 steps, VD & GE) · document import + simulated analysis ·
diagnostic · letter preview & offers · signature pad · checkout · success ·
tracking dashboard · CGV · privacy.

## Notes / next steps

The flows that stand in for back-end calls are simulated client-side exactly as
in the design prototype: the calculator, document analysis / OCR pre-fill, and
payment. Wiring these to the Supabase edge functions (`evaluate`,
`evaluate-baisse`, `extract-bail`, `generate-letter`, `create-checkout`,
`stripe-webhook`, …) is the natural follow-up and requires the project's
Supabase URL / keys.
