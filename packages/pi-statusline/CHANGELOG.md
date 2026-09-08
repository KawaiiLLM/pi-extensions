# @narumitw/pi-statusline

## Unreleased (fork)

### Minor Changes

- Add Prism: preserve Mono's gray backgrounds and adapt approved field colors in OKLCH to 4:1 contrast. Model/thinking use #AA79F2, context #A1D9F3, subscription windows #FAB48C; other themes retain their text colors.
- Start a new row at every background-cycle boundary in all themes. Default order puts cost last in the first five-segment group, then branch and tokens first in the next group.
- Add `/usage` for current-account details and forced refresh, sharing the footer's account-scoped report. Keep model-specific limits separate and clear stale-account data.
- Migrate `/fast`, supported-model routing and request-scoped cost correction from pi-usage; persist `codexFastMode` in pi-statusline.json and mark effective Fast mode on the model segment. Reset redemption is not included.
- Render subscription usage windows as `five_hour` and `weekly` segments, alternating the reset countdown with the window's value at API prices and alerting at 80%.
  The provider queries are the ones pi-usage ships, carried in `src/usage-query`, so pi-usage no longer needs to run alongside.
- Report cost for today rather than for the session: `☉ $186.00 (93%)` is the current provider's spend since local midnight, read from every session on disk, beside today's share of a daily budget. The budget is the quota left in the weekly window at the start of today spread over the days left in it, computed in percent of the window so it survives a window nobody has used yet; the segment inverts its colors at 100%.
- Replace the emoji defaults with a geometric vocabulary and compact formats: `◔ 149K (40%)` for context, `§ ↑5.3K ↓259` for tokens, `☉ $186.00 (93%)` for cost, `⌁ 82%` for the latest response's cache hit rate, `⎇` for the branch, `✱` for the model, and `◈` for thinking.
  Claude ids collapse to family and version; every other id is shown as the provider names it.
- Context and subscription usage at or above 80%, and cache hit rate at or below 50%, trigger a single alert: invert the segment's foreground and background in every palette. Thresholds use unrounded percentages.
- Colors are assigned by a segment's position in its row from a ramp that cycles, replacing the fixed segment-to-block mapping; a custom `palette` is now an array in ramp order.
- Rows wrap by default (`"overflow": "wrap"`); the previous drop-by-priority behavior stays available as `"overflow": "drop"`.

## 0.50.0

### Minor Changes

- b87641b: Show when Pi is waiting for blocking extension UI input and restore the underlying activity after the prompt closes.
  
  Expose `waiting`, `$kind`, and `$title` through pi-starship's activity module.

### Patch Changes

- 36a5ad5: Honor Pi's effective terminal capabilities when rendering pull request hyperlinks and RGB footer colors.

## 0.49.15

### Patch Changes

- Updated dependencies [40182e5]
  - @narumitw/pi-tui-kit@0.59.0

## 0.49.14

### Patch Changes

- dc9802e: Keep Ctrl+C available as a hard-cancel input when configurable cancellation bindings are remapped.
- Updated dependencies [78276b0]
- Updated dependencies [dc9802e]
  - @narumitw/pi-tui-kit@0.58.1

## 0.49.13

### Patch Changes

- 3346683: Publish generated lazy chunks at the JavaScript paths referenced by each extension runtime so deferred menus and implementations load correctly through Pi's Jiti loader.
- Updated dependencies [b9eba3a]
  - @narumitw/pi-tui-kit@0.58.0

## 0.49.12

### Patch Changes

- Updated dependencies [6574232]
- Updated dependencies [cddc265]
  - @narumitw/pi-tui-kit@0.57.0

## 0.49.11

### Patch Changes

- e7ae16e: Load the extension from a generated split TypeScript runtime to reduce Jiti package startup work while preserving the lazy command boundary.

## 0.49.10

### Patch Changes

- 5f0ccd3: Load lightweight Pi TUI Kit helpers without evaluating the full menu runtime during extension startup.

## 0.49.9

### Patch Changes

- Updated dependencies [8bead31]
  - @narumitw/pi-tui-kit@0.56.0

## 0.49.8

### Patch Changes

- Updated dependencies [3176172]
  - @narumitw/pi-tui-kit@0.55.0

## 0.49.7

### Patch Changes

- d26be16: Reuse Pi TUI Kit's display-only terminal sanitizer for footer model, symbol, and path text.

## 0.49.6

### Patch Changes

- 247083f: Use Pi TUI Kit's published live-choice interaction for palette previews while preserving statusline-owned settings, rollback, and footer updates.
- Updated dependencies [4a0358b]
- Updated dependencies [93b507b]
  - @narumitw/pi-tui-kit@0.53.0
