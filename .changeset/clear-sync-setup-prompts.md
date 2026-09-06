---
"@narumitw/pi-sync": patch
---

Simplify initial setup to one name across storage backends. Show input examples, explanations, and blank-to-accept defaults directly in Pi's dialogs without treating example endpoints or credentials as defaults. Default all new storage paths to the repository, WebDAV collection, or bucket root, without literal dot prefixes or changes to existing settings. New Git destinations use main, with existing branch safety checks preserved. Require a different path or Git branch before reviewing an additional setup when its chosen location is already configured. Preserve valid literal angle brackets in WebDAV input and edit defaults.
