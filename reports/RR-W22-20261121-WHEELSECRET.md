# RR-W22-20261121-WHEELSECRET — reusable Python wheel workflow could not see OpenRouter secret names

Date: 2026-11-21. Lane: dsh. No push by this lane. Attribution:
kapitaali <teppo@kapitaali.com>.

## Symptom

After the E2E port was green on `45280f66ec`, `CI master` still failed on
`node24-linux-arm64` at `Preflight installed-wheel real API test (POSIX)`:

```
DEEPSEEK_API_KEY_EXTERNAL is empty; the installed-wheel real API test cannot self-skip.
```

## Root cause

`build-exe-for-python-sdk.yml` is a reusable workflow. Its `on.workflow_call.secrets`
declared only `DEEPSEEK_API_KEY_EXTERNAL`, and both callers (`ci-master.yml`,
`ci-python.yml`) passed only that one name. The four-name fallback chain added
earlier inside the preflight steps could never see an OpenRouter key configured
under a different repo-secret name — those secrets were never passed into the
called workflow, so they were always empty.

## Fix

- `build-exe-for-python-sdk.yml`: declare four optional `workflow_call` secrets
  (`OPENROUTER_API_KEY_EXTERNAL`, `OPENROUTER_API_KEY`,
  `DEEPSEEK_API_KEY_EXTERNAL`, `DEEPSEEK_API_KEY`); update stale error text.
- `ci-master.yml`, `ci-python.yml`: pass all four through the `secrets:` block.

The preflight steps and E2E workflow already use the same four-name fallback.

## Verification

Workflow YAML diff checked (`git diff --check`); CI re-run owed after owner pushes.
No model call, spend, or credential change by this lane.

## Claim ceiling

This closes the secret-plumbing gap; it does not claim the installed-wheel real
API test passes, nor any publish/download/install outcome.
