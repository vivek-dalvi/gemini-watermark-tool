# v1.0.29 Post-Release Closeout

Date: 2026-07-09

## Summary

`v1.0.29` has been distributed to npm, GitHub Release, the hosted userscript, and the official website fallback extension download. The release addresses the video export regressions reported in issue #97 and the packaged npm CLI video path reported in issue #104.

Chrome Web Store is the only remaining waiting surface. At closeout time its update endpoint still reported `1.0.28`, so store propagation/review must be checked separately from the already published website and GitHub assets.

## Published Surfaces

| Surface | Result | Evidence |
|---|---|---|
| npm package | `1.0.29` | `pnpm view @pilio/gemini-watermark-remover version` |
| GitHub Release | `v1.0.29` | https://github.com/GargantuaX/gemini-watermark-remover/releases/tag/v1.0.29 |
| Release assets | complete | userscript, extension zip, checksum, `latest-extension.json`, npm tarball |
| Official website userscript | `1.0.29` | https://geminiwatermarkremover.io/userscript/gemini-watermark-remover.user.js |
| Official website extension metadata | `1.0.29` | https://geminiwatermarkremover.io/downloads/latest-extension.json |
| Official website extension zip | ok | sha256 `72891819454366cf5fc9f21e561bc6a0cf0179a34d57cb076e96aa2ae774ff31`, size `1092502` |
| Chrome Web Store | waiting | update endpoint still reported `1.0.28` |

## Website Deployment

The official website repository was synced to `1.0.29`, pushed, and deployed to Cloudflare Workers.

- Website repo commits:
  - `c69cfeb Sync Gemini remover 1.0.29 release assets`
  - `48adf88 Refresh GitHub stars snapshot`
- Cloudflare deployment version ID: `0a939ce6-448a-4d5c-b1aa-51beb3acddae`
- The website build and deploy completed successfully.

## Smoke Verification

Online smoke checks passed after deployment:

- `latest-extension.json`: HTTP 200, version `1.0.29`
- extension zip: HTTP 200, `1092502` bytes
- extension zip sha256: `72891819454366cf5fc9f21e561bc6a0cf0179a34d57cb076e96aa2ae774ff31`
- checksum text file: HTTP 200 and matches the zip hash
- userscript: HTTP 200, `@version 1.0.29`
- `/chrome-extension/` page: contains `1.0.29` and `gemini-watermark-remover-extension-v1.0.29.zip`

The final distribution report is `.artifacts/release-distribution/latest-report.md`:

- overall: `waiting`
- all non-store surfaces: `ok`
- `chrome-web-store-update`: `waiting`, actual `1.0.28`

## Issue Follow-Up

Issue #97 was commented and closed as completed after `v1.0.29` was published:

- Issue: https://github.com/GargantuaX/gemini-watermark-remover/issues/97
- Comment: https://github.com/GargantuaX/gemini-watermark-remover/issues/97#issuecomment-4923136353

Release notes were updated to mention the #97 follow-up:

- added BT.709 limited-range video export metadata
- added source-structure protection around video watermark cleanup
- recorded that website distribution smoke passed
- noted that Chrome Web Store propagation was still waiting

## Remaining Follow-Up

Re-run the distribution check after Chrome Web Store approves or propagates `1.0.29`:

```bash
pnpm release:distribution-check
```

The release can be considered fully complete when `chrome-web-store-update` reports `1.0.29` and the distribution report moves from `overall: waiting` to `overall: ok`.
