# RR-W22-20261121-WHEEL-LIVE — installed-wheel live smoke ported to OpenRouter free model

Date: 2026-11-21. Lane: dsh. No push by this lane. Attribution:
kapitaali <teppo@kapitaali.com>.

## Symptom

After secret plumbing was fixed, `CI master` failed at
`Run installed-wheel real API black-box test (POSIX)` on `node24-linux-arm64`
and `node24-macos-arm64`: the step still pointed the OpenRouter key at
`https://api.deepseek.com/anthropic` and used hardcoded model `deepseek-v4-flash`.

## Fix

- `scripts/smoke-python-runtime.py`: `smoke_sdk_live` now reads
  `DEEPSEEK_LIVE_MODEL` (default `deepseek-v4-flash`) and
  `DEEPSEEK_LIVE_REASONING_EFFORT` (default unset), passing the latter to
  `DeepSeekHarness`. Official DeepSeek behavior is unchanged by default.
- `.github/workflows/build-exe-for-python-sdk.yml`: both POSIX and Windows
  installed-wheel live steps now set `DEEPSEEK_BASE_URL=https://openrouter.ai/api`,
  `DEEPSEEK_LIVE_MODEL=nvidia/nemotron-3.5-lightning:free`, and
  `DEEPSEEK_LIVE_REASONING_EFFORT=off` (OpenRouter rejects `thinking.enabled`
  without `budget_tokens`; `off` omits that shape).

## Verification

```
python3 -m py_compile scripts/smoke-python-runtime.py  → rc=0
PYTHONPATH=python/sdk/src python3 -m pytest \
  python/sdk/tests/test_smoke_model.py python/sdk/tests/test_release_version.py -q
  → 85 passed
```

Live CI re-run owed after owner pushes. No key, spend, or credential change by
this lane.

## Claim ceiling

This closes endpoint/model/thinking configuration for the installed-wheel live
gate. No claim that the two-turn tool task passes until CI re-runs green.
