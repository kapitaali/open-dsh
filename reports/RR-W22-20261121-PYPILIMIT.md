# RR-W22-20261121-PYPILIMIT — PyPI wheel-size check used decimal MB instead of MiB

Date: 2026-11-21. Lane: dsh. No push by this lane. Attribution:
kapitaali <teppo@kapitaali.com>.

## Symptom

CI failed building the `linux-arm64` runtime wheel:

```
... is 100427197 bytes and exceeds the PyPI single-file limit of 100000000 bytes
```

## Root cause

`scripts/build-python-release.py::verify_wheel` compared against `100_000_000`
(decimal MB). PyPI's Warehouse defines `MAX_FILESIZE = 100 * ONE_MIB`
(`constants.py`: `ONE_MIB = 1024 * 1024`), i.e. **104,857,600 bytes**. The failing
wheel (100,427,197 bytes) is below the real upload limit. The published
`0.2.2rc2` arm64 wheel is 99,239,965 bytes — also below the real limit.

This is a verifier bug, not an oversized artifact. No payload trimming or
compression change was needed.

## Fix

- `scripts/build-python-release.py`: use `100 * 1024 * 1024` and name the byte
  value in the error message.
- `python/sdk/tests/test_release_version.py`: the oversized-artifact fixture now
  truncates to `100 * 1024 * 1024 + 1`.

## Verification

```
python3 -m pytest python/sdk/tests/test_release_version.py -q  → 18 passed
```

No model call, no spend, no secret or credential change.

## Claim ceiling

The wheel is under PyPI's documented limit; this does not claim that publishing,
downloading, or installing the wheel succeeded, nor any cost/model-quality fact.
