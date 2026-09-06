---
"@narumitw/pi-sync": minor
---

Replace automatic startup transfers with a cancellable background check in TUI and RPC. Pi no longer waits for remote storage or opens startup conflict dialogs; review differences through `/sync` before transferring. The existing `sync.automatic` setting now checks only at startup, while its sessions-enabled automatic shutdown push remains unchanged. Print and JSON modes skip startup checks.

Keep local recovery ahead of user operations, give foreground commands priority, and drain Git cache cleanup before releasing sync locks. Startup observations are advisory and revalidated before manual operations.
