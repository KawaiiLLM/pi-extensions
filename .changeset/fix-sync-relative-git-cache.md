---
"@narumitw/pi-sync": patch
---

Resolve the Git cache root to an absolute path so snapshot publication works when the cache path is relative and payload hashing changes the subprocess working directory.
