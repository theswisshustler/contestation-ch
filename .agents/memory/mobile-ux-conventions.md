---
name: Mobile UX conventions
description: CSS patterns and conventions for contestation.ch mobile UX
---

## Back buttons
All ← back buttons (36×36px) must include `display:flex;align-items:center;justify-content:center;flex:none;` to properly center the arrow character.

## Bottom CTA bars
Fixed/sticky bottom bars must have class `cc-cta-bar` → `padding-bottom: max(16px, env(safe-area-inset-bottom, 0px)) !important` for iPhone X+ safe area.

## Input focus ring
`input:focus, textarea:focus { border-color:#1B4965 !important; box-shadow:0 0 0 3.5px rgba(27,73,101,.14) !important; }` — !important needed to override inline border styles.

## Section padding
Landing sections use class `cc-section-pad`: 48px mobile, 72px desktop (via @media). Inline padding stays on element but is overridden by !important.

## Button tap feedback
`button { touch-action:manipulation; } button:active { opacity:.8; transform:scale(.985); }` — removes gray flash, adds tactile feel.

## Autocomplete
Step 9 has autocomplete="given-name/family-name/street-address/postal-code/address-level2/email". Steps 1, 2, and import-validation address fields also have autocomplete.

**Why:** Established in comprehensive mobile UX review. Baseline quality bar for all future screens.
