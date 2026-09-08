# usage-query

Verbatim copy of the provider-query layer from `packages/pi-usage` (`src/types.ts`,
`src/core.ts`, `src/query.ts`, `src/oauth-credential-source.ts`, `src/usage-targets.ts`,
`src/providers/*`), taken at repository commit `530b081e` (pi-usage 0.60.3).

The statusline renders subscription windows itself, so it needs the queries but not
pi-usage's status text, settings UI, or Codex reset commands. Extension packages may not
import one another, which is why the layer lives here. Do not edit these files in place;
re-sync them from `packages/pi-usage` and keep this note's commit current.
