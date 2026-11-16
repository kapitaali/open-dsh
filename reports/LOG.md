# DSH — Work Reports Index

| Report | Task | One-line summary |
|---|---|---|
| RR-W22-20261116 | W22 adapter sync | Synced the dsh-checkout @ctxvm/dsh adapter to ctxvm HEAD 03d44a1 byte-for-byte (fold + undefined-content guard + Config factory); proved tracing with a fresh headless profile linking this copy: a 0600/0700 trace with validated schema and clean replay. Lint remains red on two committed errors in scripts/import-hermes-credentials.ts (not this change); typecheck and adapter-scoped lint green. |
