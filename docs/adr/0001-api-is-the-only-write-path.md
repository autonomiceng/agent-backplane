---
status: accepted
date: 2026-09-14
---
# The API is the only write path

The headline claim is that every row, message, blob and schema change is attributed to a Principal and a Run. That claim is only true if nothing can write around the server. So no login role with write access exists outside the backplane server, operators write through the dashboard or a stamped CLI path, and the server binds Run context once per transaction in a protected registry that audit writers read (ADR-0017). We chose this over the weaker claim "provenance for changes made through the API" because the weaker claim is what every competitor can already make.
