---
"@narumitw/pi-accounts": minor
---

Add a Set default account picker to `/accounts` for each provider. New sessions use the saved default, while current, resumed, and reloaded sessions retain their own account selections. Preserve unknown settings fields during saves and order asynchronous reads after queued writes.
