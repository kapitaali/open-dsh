# DSH — Work Reports Index

| Report | Task | One-line summary |
|---|---|---|
| RR-W22-20261116 | W22 adapter sync | Synced the dsh-checkout @ctxvm/dsh adapter to ctxvm HEAD 03d44a1 byte-for-byte (fold + undefined-content guard + Config factory); proved tracing with a fresh headless profile linking this copy: a 0600/0700 trace with validated schema and clean replay. Lint remains red on two committed errors in scripts/import-hermes-credentials.ts (not this change); typecheck and adapter-scoped lint green. |
| RR-W22-20261116-PLANA | W22-envelope-sync | Synced Plan A envelope fix from ctxvm a2669c9 into the DSH checkout (eventData helper, deferred identity with buffered replay, envelope fixtures and four assertions); all 16 adapter files byte-match, suite 15/14/0/1, typecheck rc=0, adapter lint 0/0. Live verification and trace evidence in ctxvm RR-W22-20261116-06. Plans B/C/D untouched; no trace bytes or credentials committed; no push. |
