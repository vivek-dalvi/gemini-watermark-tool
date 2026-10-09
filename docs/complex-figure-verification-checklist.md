# Complex Figure Verification Checklist

## Why This Exists

Natural-photo samples are not enough.

Complex figures such as:

- paper figures
- infographics
- mixed text + photo layouts
- portrait-oriented composite images
- multi-image Gemini responses

can still fail even when ordinary photo samples pass.

Typical failure modes:

- canonical anchor replaced by weak drift candidate
- preview replacement bound to the wrong image node
- preview and download using different processed outputs
- tests passing because residual metrics look acceptable at the wrong location

## Required Verification Surface

Every release candidate that changes selector logic, preview replacement, or download handling should check all of the following:

1. local sample regressions
2. real-page preview visual mapping
3. real-page download output identity

## Local Regression Samples

Current known high-value samples:

- `src/assets/samples/debug1-source.png`
  - download residual / conservative fallback case
- `src/assets/samples/debug2-source.png`
  - portrait mixed text/photo figure case

Expectations:

- `debug1-source.png`
  - should keep canonical `48x48` anchor
  - should not fall back to weaker conservative candidate
- `debug2-source.png`
  - should keep canonical anchor
  - should not let local drift replace the canonical anchor on weak evidence

Run:

```bash
pnpm test
```

Key tests:

- `tests/core/watermarkProcessor.test.js`
- `tests/core/candidateSelector.test.js`
- `tests/regression/sampleAssetsRemoval.test.js`

## Real-Page Preview Checks

Target shape:

- open the Gemini page with multiple generated images
- include at least one portrait-oriented complex figure / infographic-like output

Verify:

- displayed preview reaches `data-gwr-page-image-state=ready`
- displayed preview has a `data-gwr-watermark-object-url`
- the current displayed image and the processed overlay still correspond to the same content

Red flags:

- preview shows another image's content
- preview keeps text/photo layout but watermark position is visibly shifted
- multiple ready images exist but only some of them have stable non-empty source bindings

## Real-Page Download Checks

Verify:

- clicking `下载完整尺寸的图片` triggers the expected native chain
- the final downloaded file matches the userscript's processed result, not an older cached blob
- the downloaded output still aligns with the same image shown in preview

Red flags:

- download hash differs from the userscript's processed blob hash for the same source
- preview looks fixed but download keeps an older wrong result
- target page uses `blob:`-only bindings with missing stable source mapping

## Hash/Identity Checks

When behavior is suspicious, compare:

1. original source hash
2. current displayed preview hash
3. processed overlay blob hash
4. userscript download-processed blob hash
5. final saved download file hash

If 3/4/5 diverge for the same action, treat that as a pipeline bug even if the page looks partially correct.

## Release Gate

Do not treat a selector or request-layer change as safe until:

- local regression samples stay green
- fixed profile userscript freshness is `fresh`
- at least one complex portrait figure passes preview and download verification
