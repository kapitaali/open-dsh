# RR-W22-20261126-OPENROUTERSECRET — real-API CI uses only OPENROUTER_API_KEY

Date: 2026-11-26. Lane: dsh. Workspace-staged; no checkout write, commit, push,
secret read/change, or model call.

## Symptom

Open-dsh real-API workflows failed with `AUTH 401: User not found` even though the
repository has `OPENROUTER_API_KEY` and `DEEPSEEK_API_KEY` secrets. The intended
budgeted key is `OPENROUTER_API_KEY`; the DeepSeek key has no budget.

## Change

Removed the multi-name fallback chain so the real-API lanes can only use the
intended OpenRouter secret:

- `.github/workflows/e2e.yml`: preflight and test step use
  `${{ secrets.OPENROUTER_API_KEY }}`.
- `.github/workflows/build-exe-for-python-sdk.yml`: reusable workflow declares
  only `OPENROUTER_API_KEY`; all POSIX/Windows preflight/test mappings use it.
- `.github/workflows/ci-master.yml` / `ci-python.yml`: pass only
  `OPENROUTER_API_KEY` to the reusable workflow.
- Error text now names `OPENROUTER_API_KEY`.

The free model remains `nvidia/nemotron-3.5-lightning:free` in both lanes.

## Verification

All four workflow files parse with the repository's `yaml` dependency. No secret
value was available to this lane and no live request was made.

## Next step / honest limit

Copy, push, and re-run. If the workflow still returns `401 User not found`, the
value stored in `OPENROUTER_API_KEY` is being rejected by OpenRouter and must be
rotated/re-entered; secret presence alone cannot prove validity.
