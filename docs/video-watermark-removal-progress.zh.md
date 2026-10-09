# Gemini / Veo 视频去水印活文档

> 状态：持续更新  
> 最近更新：2026-06-12  
> 目标：在浏览器本地通过 WebCodecs + Mediabunny 实现 Gemini / Veo 视频可见水印移除，尽量学习 allenk 的 GeminiWatermarkTool / Veo 视频处理思路，同时避免引入 wasm ffmpeg。

## 活文档维护方式

这份文档是视频去水印工作的接手入口。后续每次推进时，优先更新以下部分：

- `当前结论`：只记录已经被样例、日志或测试支持的判断。
- `当前浏览器 MVP 实现`：记录已落地代码和默认行为。
- `当前最佳产物`：记录最值得用户直接查看的视频 / crop sheet。
- `Alpha Profile 研究记录`：记录 alpha map、profile、gain、相关性等可复现实验。
- `后续路线`：记录下一步要做什么，以及为什么不是继续盲调参数。
- `决策记录`：记录已经做过的技术取舍，避免反复回到同一个分叉口。

接手本任务时，先看本文件，再看：

- `src/video/videoWatermarkCatalog.js`
- `src/video/videoWatermarkDetector.js`
- `src/video/videoCleanupBackends.js`
- `src/video/videoExport.js`
- `src/video-app.js`
- `public/video-preview.html`
- `scripts/render-video-crop-sheet.js`
- `scripts/analyze-video-residual.js`
- `scripts/video-crop-benchmark.js`
- `scripts/video-crop-benchmark-manifest.json`
- `scripts/report-video-crop-benchmark.js`
- `scripts/run-video-frame-backend-lab.js`
- `scripts/report-video-frame-lab-sweep.js`
- `scripts/export-video-ui-preset.js`
- `scripts/create-video-light-polish-review-pack.js`
- `scripts/create-video-polish-sweep-review-pack.js`
- `scripts/create-video-delivery-dashboard.js`
- `scripts/create-video-goal-status-report.js`
- `scripts/create-video-delivery-bundle.js`
- `scripts/create-video-alpha-policy-evidence-report.js`
- `scripts/create-video-alpha-policy-review-pack.js`
- `scripts/create-video-review-index.js`
- `scripts/create-video-review-decision-report.js`
- `tests/video/*.test.js`

不要默认启动本地 dev server；如需浏览器验证，先提示用户由 VS Code 侧启动当前开发服务。

## 当前落地点

项目内已落地视频 MVP 文件：

- `src/video/videoWatermarkCatalog.js`
- `src/video/videoWatermarkDetector.js`
- `src/video/videoCleanupBackends.js`
- `src/video/videoExport.js`
- `src/video-app.js`
- `public/video-preview.html`
- `scripts/render-video-crop-sheet.js`
- `scripts/video-crop-benchmark.js`
- `scripts/video-crop-benchmark-manifest.json`
- `scripts/report-video-crop-benchmark.js`
- `scripts/run-video-frame-backend-lab.js`
- `scripts/report-video-frame-lab-sweep.js`
- `tests/video/videoWatermarkCatalog.test.js`
- `tests/video/videoWatermarkDetector.test.js`
- `tests/video/videoCleanupBackends.test.js`
- `tests/scripts/renderVideoCropSheet.test.js`
- `tests/scripts/videoCropBenchmark.test.js`
- `tests/scripts/videoCropBenchmarkReport.test.js`
- `tests/scripts/videoFrameBackendLab.test.js`
- `tests/scripts/videoFrameLabSweepReport.test.js`

构建入口已扩展：

- `build.js`：支持打包 `video-app.js` 和 `video-preview.html`。

当前工作区中这些视频 MVP 文件仍是新增/未跟踪状态；整理提交前不要误删，也不要回滚其它已有脏改动。

## 当前结论

- MVP 路线可行：浏览器本地逐帧解码、Canvas 处理、WebCodecs 编码、Mediabunny 封装 MP4 已跑通。
- allenk 的质量优势主要不在容器/编码，而在视频专用处理策略：
  - 固定或探测出的水印几何。
  - 视频 alpha profile / V2-large alpha。
  - per-shot alpha seed。
  - 帧级 skip / confidence gate。
  - NCNN / FDnCNN 风格的局部边缘去噪。
- 纯 Canvas 算法可以明显降低水印，但目前会在两个问题之间摇摆：
  - 残留 diamond 边线。
  - 过度修补造成低频平滑斑。
- 要达到 allenk 输出那种纹理自然度，下一阶段应把局部 ML / WebGPU / WebNN denoise 作为独立模块接入，而不是继续无限调传统 inpaint。

## 参考源码与线索

### GeminiWatermarkTool

本地参考目录：

- `.artifacts/external-repos/GeminiWatermarkTool`

关键源码/资源：

- `assets/embedded_assets.hpp`
  - `bg_48_png`
  - `bg_96_png`
  - `bg_b_36_png`
  - `bg_b_96_png`
- `src/core/blend_modes.cpp`
  - alpha 规则：`alpha = max(R,G,B) / 255`
  - 逆 alpha blend：`original = (watermarked - alpha * logo_value) / (1 - alpha)`
- `src/core/watermark_engine.cpp`
  - image 侧 detection / inpaint / Gaussian cleanup。
- `src/core/ai_denoise.cpp`
  - NCNN / FDnCNN 边缘去噪思路。
  - 使用 alpha gradient mask，只修复边缘/残留区域。

已确认：

- 当前项目 `getEmbeddedAlphaMap(96)` 与 GWT `bg_96_png` 对齐。
- 当前项目 `'96-20260520'` 与 GWT `bg_b_96_png` 高度接近。
- GWT public main 当前没有完整视频源码，但 README 明确描述了视频 pipeline；release video exe 也带有对应日志和行为。

### VeoWatermarkRemover

本地参考目录：

- `.artifacts/external-repos/VeoWatermarkRemover`

该 repo 主要是 demo/release README，不含完整 C++ 源码，但 README 对视频算法写得很清楚：

- 多帧探测，避免 intro/fade-in 误判。
- 12 帧采样。
- adaptive per-frame alpha via bisection feedback。
- per-shot seed + per-frame change cap。
- 720p-1 / 720p-2 variant。
- relocated watermark / bottom-right smart search。
- partial occlusion 三档处理。
- 1080p least-squares per-shot intensity。

## allenk v0.6.2 关键基线

样例：

- `${GWR_VIDEO_SAMPLE_ROOT}\4d420881-c144-497f-9a6e-43beda086580.mp4`

allenk 输出：

- `.artifacts/allenk-video/4d420881-allenk-v062.mp4`

allenk 日志：

- `.artifacts/allenk-video/4d420881-allenk-v062.log`

关键日志摘录：

```text
Locked region: 1080p standard (seed-only) -> (1740,900) 72x72 (NCC 0.96, alpha=V2-large x1.00 dyn)
Seed scale: x1.072 (dynamic seed median, tuple fallback x1.00; per-shot constant (seed-only))
Video: 1920x1080 24.0fps 10.0s 240 frames, audio=yes
NcnnDenoiser: sigma=75, strength=180%, roi=200x200, 5184 edge pixels
[Gemini-3.5 1920x1080 207/240 frames (33 skip) +dyn-alpha(x1.07) +audio +AI]
```

推导：

- 1080p standard anchor：`x=1740, y=900, size=72`
- right/bottom margin：`108`
- per-shot seed：约 `1.072`
- allenk 并非简单逐帧固定 alpha，而是 seed / gate / denoise 组合。
- `5184 edge pixels = 72 * 72`，说明视频 AI denoise 覆盖整个 diamond ROI 的有效残留区域，而不只是极窄边线。

## 当前浏览器 MVP 实现

主要文件：

- `src/video/videoWatermarkCatalog.js`
- `src/video/videoWatermarkDetector.js`
- `src/video/videoCleanupBackends.js`
- `src/video/videoExport.js`
- `src/video-app.js`
- `public/video-preview.html`
- `tests/video/videoWatermarkCatalog.test.js`
- `tests/video/videoWatermarkDetector.test.js`
- `tests/video/videoCleanupBackends.test.js`
- `build.js`

依赖：

- `mediabunny`
- WebCodecs
- Canvas / OffscreenCanvas

当前能力：

- 读取本地 MP4。
- 多帧抽样检测水印候选。
- 1080p standard / inset 候选。
- 720p-1 / 720p-2 候选。
- V2 alpha map resize 到视频水印尺寸。
- polarity-aware frame scoring：
  - `scoreVideoWatermarkFramePolarity`
  - `buildVideoWatermarkPolarityProbe`
  - `computeVideoBackgroundNormalizedAlphaContrast`
  - `classifyVideoWatermarkFramePolarity`
  - `summarizeVideoWatermarkFrameEvidence`
  - `classifyVideoWatermarkEvidenceSummary`
  - 这些 API 目前只作为检测/证据链能力，不改变导出 cleanup。
- per-shot alpha seed 估计。
- 帧级 confidence gate：
  - 高置信：可走 adaptive alpha。
  - 中低置信：使用 shot seed。
  - 极低置信：跳过。
- 逐帧 inverse alpha removal。
- 轻量边缘修复。
- cleanup 后端已从 `videoExport.js` 抽到 `src/video/videoCleanupBackends.js`：
  - `normalizeVideoCleanupOptions()` 统一默认值和 clamp。
  - `applyVideoResidualCleanup()` 作为后续 Canvas / WebGPU / WebNN / tiny-CNN 后端边界。
  - 当前默认仍是 `canvas-soft + cleanup150`，`highQualityCleanup=false`，`denoiseBackend=none`。
  - 旧 `textureRepair=true` 现在是 `denoiseBackend=canvas-texture-repair` 的兼容别名。
  - 当前可选 denoise backend：
    - `none`
    - `canvas-edge-denoise`
    - `canvas-edge-band-denoise`
    - `canvas-texture-repair`
- WebCodecs 输出 MP4。
- 离线批量 crop sheet 生成：
  - 使用本机 `ffmpeg` 抽取原始 / 当前 MVP / allenk 输出的同一时间点右下 ROI。
  - 默认按视频 catalog 推断 1080p / 720p crop，也可通过 `--crop x,y,w,h` 手动指定。
  - 输出 original、current MVP、allenk、original/current diff、current/allenk residual 五列对比。
- 视频 crop benchmark：
  - manifest：`scripts/video-crop-benchmark-manifest.json`
  - 命令：`rtk pnpm benchmark:video-crops`
  - 汇总：`.artifacts/video-crop-benchmark/latest-summary.json`
  - Markdown 报告：`.artifacts/video-crop-benchmark/latest-report.md`
  - crop sheet：`.artifacts/video-crop-benchmark/<case-id>.png`
  - `originalEvidence.classification` 会把原始 ROI 样例分为：
    - `positive-high-confidence`
    - `intermittent-low-visible`
    - `negative-or-gray-polarity`
    - `likely-absent-or-off-anchor`
    - `ambiguous`
  - crop sheet 标题会带短标签，例如 `positive-high`、`intermittent`、`negative-gray`。
  - `originalEvidence.frames[*].polarityProbe` 会输出：
    - `positiveScore`
    - `negativeScore`
    - `absSpatialScore`
    - `backgroundNormalizedScore`
    - `bestPolarity`
    - `polarityMargin`
    - `shouldProcessCandidate`
    - `reason`
  - benchmark 现在复用 `src/video/videoWatermarkDetector.js` 的 polarity-aware scoring / summary / classification API，不再在脚本内维护独立 detector 逻辑。
  - benchmark 现在也会在有 `current + reference` 时输出 `residualMetrics`：
    - `aggregate.active`
    - `aggregate.edge`
    - `aggregate.lowBody`
    - `aggregate.highBody`
    - `aggregate.nearZero`
- 当前 manifest 已登记 4 个本地样例。
  - manifest 现在携带 `currentProfile` / `referenceProfile`，用于记录算法、cleanup backend、denoise backend、allenk 版本和 denoise 参数。
  - `4d420881` 具备 current / allenk 对照，使用 standard anchor `1740,900,72`。
  - `deaee69b`、`e1997e6e` 已补 allenk v0.6.2 对照，allenk 锁到 relocated anchor `1704,864,72`；manifest 通过 `expected.anchor` 固定 residual 量测位置。
  - `095eddb6` 已补 current `cleanup150` 输出，但 allenk v0.6.2 auto mode 跳过该样例，仍无 reference residual。
  - summary 现在输出 `variantComparisons`，自动把 `tags` 含 `variant` 的 case 与同 original/reference/anchor 的 baseline 比较，给出 active/edge/lowBody/highBody 的 meanAbs/RMS delta 和 verdict。
- 视频 residual analyzer：
  - 命令：`rtk pnpm analyze:video-residual -- --current <current.mp4> --allenk <reference.mp4> --original <original.mp4> --output <report.json>`
  - 默认使用 video catalog 推断 crop 与水印位置，并复用生产 `getVideoAlphaMap()` 分桶。
  - 输出 `nearZero`、`edge`、`lowBody`、`highBody` 与 `active` 的亮度残差统计。
  - `active` 明确定义为 `alpha > 0.035` 的水印 footprint，且每帧会先扣除 `nearZero` 背景均值，避免全局编码/亮度漂移污染判断。
  - 默认临时帧目录现在按 output path 派生，避免并行 analyzer 互相删除 `frames-latest`。
  - 已登记脚本入口：`analyze:video-residual`。
- 视频后端分叉导出：
  - 命令：`rtk pnpm export:video-backend -- --input <video.mp4> --output <out.mp4> --denoise-backend <backend>`
  - 当前通过本地 `dist/video-preview.html` + Playwright 导出，不启动 dev server。
  - 支持 `--edge-denoise-strength <0..1>` 和 `--allow-low-confidence`。
- 单帧后端实验台：
  - 命令：`rtk pnpm lab:video-frames -- --denoise-backend canvas-edge-denoise --edge-denoise-strength 0.65`
  - 脚本：`scripts/run-video-frame-backend-lab.js`
  - 默认读取 benchmark manifest 中有 `current + reference` 且 `denoiseBackend=none` 的 baseline case。
  - 不重新编码整段视频，只抽取 crop PNG，再在 crop 上调用 `applyVideoResidualCleanup()`，适合快速测试后端、mask、强度参数。
  - 输出：
    - `.artifacts/video-frame-backend-lab/latest-report.json`
    - `.artifacts/video-frame-backend-lab/latest-report.md`
    - `.artifacts/video-frame-backend-lab/<case-id>-<backend>.png`
  - sheet 列包含 original、baseline、variant、reference、baseline/ref diff、variant/ref diff。
  - residual delta 复用 `analyze-video-residual.js` 的 active / edge / lowBody / highBody bucket。
- 单帧实验 sweep 报告：
  - 命令：`rtk pnpm report:video-frame-lab -- --reports <latest-report.json,...>`
  - 脚本：`scripts/report-video-frame-lab-sweep.js`
  - 输出：
    - `.artifacts/video-frame-backend-lab/latest-sweep-report.md`
    - `.artifacts/video-frame-backend-lab/latest-sweep-report.json`
  - 用途：把多个 lab report 汇总成强度/后端对比表，并给出“零回归优先”的稳定候选。

当前限制：

- 音频轨已接入 AAC 等 MP4 支持 codec 的 encoded packet 透传；无音频或不支持 codec 时会在 UI 状态中说明未保留原因。
- 当前编码依赖浏览器 H.264/AVC WebCodecs 支持。
- 传统 Canvas 修复仍不如 allenk 的 NCNN/FDnCNN 边缘去噪自然。
- 对非 1080p / 720p、竖屏 relocated watermark 还需要更多样例校准。

## 当前最佳产物

主路径推荐查看：

- `.artifacts/video-alpha-research/4d420881-gwr-video-mvp-edgeboost045-cleanup150.mp4`

对应对比图：

- `.artifacts/video-alpha-research/4d420881-output-crop-comparison-edgeboost045-cleanup150.png`

当前推荐用固定脚本重建对比图：

```powershell
rtk pnpm render:video-crops -- --original ${GWR_VIDEO_SAMPLE_ROOT}\4d420881-c144-497f-9a6e-43beda086580.mp4 --current .artifacts\video-alpha-research\4d420881-gwr-video-mvp-edgeboost045-cleanup150.mp4 --allenk .artifacts\allenk-video\4d420881-allenk-v062.mp4 --output .artifacts\video-crop-sheets\4d420881-edgeboost045-cleanup150.png --timestamps 1,3,5,7,9
```

当前 benchmark 主产物：

- `.artifacts/video-crop-benchmark/4d420881.png`
- `.artifacts/video-crop-benchmark/095eddb6.png`
- `.artifacts/video-crop-benchmark/deaee69b.png`
- `.artifacts/video-crop-benchmark/e1997e6e.png`
- `.artifacts/video-crop-benchmark/latest-summary.json`

当前视频交付总入口：

- `.artifacts/video-delivery-dashboard/latest-video-dashboard.html`
- `.artifacts/video-delivery-dashboard/latest-video-dashboard.json`
- `.artifacts/video-delivery-dashboard/latest-video-dashboard.png`
- `.artifacts/video-delivery-dashboard/latest-video-dashboard-screenshot.json`
- `.artifacts/video-goal-status/latest-report.json`
- `.artifacts/video-goal-status/latest-report.md`
- `.artifacts/video-delivery-bundle/latest-report.json`
- `.artifacts/video-delivery-bundle/latest-report.md`
- `.artifacts/video-alpha-policy-evidence/latest-report.json`
- `.artifacts/video-alpha-policy-evidence/latest-report.md`
- `.artifacts/video-alpha-policy035-review/review-pack/latest-review-pack.json`
- `.artifacts/video-alpha-policy035-review/review-pack/latest-review-index.html`
- `.artifacts/video-alpha-policy035-review/review-pack/latest-review-index.png`
- `.artifacts/video-alpha-policy035-review/review-pack/latest-review-index-screenshot.json`
- `.artifacts/video-alpha-policy035-review/temporal-residual/latest-report.json`
- `.artifacts/video-alpha-policy035-review/temporal-residual/latest-report.md`
- `.artifacts/video-alpha-policy035-review/review-pack/latest-alpha-policy-review-decision.pending.json`
- `.artifacts/video-alpha-policy035-review/review-pack/latest-alpha-policy-review-decision-report.json`
- `.artifacts/video-alpha-policy035-review/review-pack/latest-alpha-policy-review-decision-report.md`
- 该 dashboard 聚合：
  - 当前 `0.25` 默认复核候选。
  - `0.20` 轻 polish 备选。
  - `0.18 / 0.20 / 0.22 / 0.25` strength sweep。
  - `alphaEdgePolicy=standard045-inset035` 的 0.35 候选复核 lane。
  - 对应 review HTML、review pack、gate / delivery report、decision report。
- 0.35 候选说明：
  - 该候选已有 full / ROI 4-up MP4 和 3 条 temporal lab 残差图。
  - 当前 temporal lab 显示 matched jitter 未改善，因此暂不把匹配式 temporal reuse 作为默认增强；它已接入 dashboard 作为 review-only 待审候选，而不是默认替换项。

当前 relocated 人审预设产物：

- 可查看视频：
  - `.artifacts/video-temporal-match-delta-stabilize/match025-relocated-gated/ui-export/deaee69b-ui-preset.mp4`
  - `.artifacts/video-temporal-match-delta-stabilize/match025-relocated-gated/ui-export/e1997e6e-ui-preset.mp4`
  - `.artifacts/video-temporal-match-delta-stabilize/match025-relocated-gated/ui-preset-script/deaee69b-ui-preset-script.mp4`
  - `.artifacts/video-temporal-match-delta-stabilize/match025-relocated-gated/ui-preset-script/e1997e6e-ui-preset-script.mp4`
- 真实 UI 预设脚本报告：
  - `.artifacts/video-temporal-match-delta-stabilize/match025-relocated-gated/ui-preset-script/deaee69b-ui-preset-script-ui-preset-report.md`
  - `.artifacts/video-temporal-match-delta-stabilize/match025-relocated-gated/ui-preset-script/e1997e6e-ui-preset-script-ui-preset-report.md`
- 脚本化 benchmark / gate：
  - `.artifacts/video-temporal-match-delta-stabilize/match025-relocated-gated/ui-preset-script/benchmark/latest-report.md`
  - `.artifacts/video-temporal-match-delta-stabilize/match025-relocated-gated/ui-preset-script/benchmark/gate/latest-report.md`
- 脚本化 4-up 对比视频：
  - 全画面：
    - `.artifacts/video-temporal-match-delta-stabilize/match025-relocated-gated/ui-preset-script/comparison/deaee69b-full-4up.mp4`
    - `.artifacts/video-temporal-match-delta-stabilize/match025-relocated-gated/ui-preset-script/comparison/e1997e6e-full-4up.mp4`
  - 右下 ROI：
    - `.artifacts/video-temporal-match-delta-stabilize/match025-relocated-gated/ui-preset-script/comparison/deaee69b-roi-4up.mp4`
    - `.artifacts/video-temporal-match-delta-stabilize/match025-relocated-gated/ui-preset-script/comparison/e1997e6e-roi-4up.mp4`
- 音频保留验证输出：
  - `.artifacts/video-audio-preserve/deaee69b-ui-preset-audio.mp4`
  - `.artifacts/video-audio-preserve/e1997e6e-ui-preset-audio.mp4`
- 自动 relocated 直接导出验证输出：
  - `.artifacts/video-auto-relocated-preset/deaee69b-auto-export-v3.mp4`
  - `.artifacts/video-auto-relocated-preset/e1997e6e-auto-export-v1.mp4`
  - `.artifacts/video-auto-relocated-preset/4d420881-standard-auto-export-v1.mp4`
  - `.artifacts/video-auto-relocated-preset/benchmark/latest-report.md`
  - `.artifacts/video-auto-relocated-preset/benchmark/gate/latest-report.md`
- 自动 relocated 直接导出 4-up 对比视频：
  - 全画面：
    - `.artifacts/video-auto-relocated-preset/comparison/deaee69b-full-4up.mp4`
    - `.artifacts/video-auto-relocated-preset/comparison/e1997e6e-full-4up.mp4`
    - `.artifacts/video-auto-relocated-preset/comparison/4d420881-full-4up.mp4`
  - 右下 ROI：
    - `.artifacts/video-auto-relocated-preset/comparison/deaee69b-roi-4up.mp4`
    - `.artifacts/video-auto-relocated-preset/comparison/e1997e6e-roi-4up.mp4`
    - `.artifacts/video-auto-relocated-preset/comparison/4d420881-roi-4up.mp4`
- 边界梯度修复后重新导出的自动 preset 输出：
  - `.artifacts/video-boundary-gradient-auto/deaee69b-auto-boundary-gradient.mp4`
  - `.artifacts/video-boundary-gradient-auto/e1997e6e-auto-boundary-gradient.mp4`
  - `.artifacts/video-boundary-gradient-auto/4d420881-standard-boundary-gradient.mp4`
  - `.artifacts/video-boundary-gradient-auto/benchmark/latest-report.md`
  - `.artifacts/video-boundary-gradient-auto/benchmark/gate/latest-report.md`
  - `.artifacts/video-boundary-gradient-auto/delivery-gate/latest-delivery-report.md`
- 边界梯度修复后 4-up 对比视频：
  - 全画面：
    - `.artifacts/video-boundary-gradient-auto/comparison/deaee69b-full-4up.mp4`
    - `.artifacts/video-boundary-gradient-auto/comparison/e1997e6e-full-4up.mp4`
  - 右下 ROI：
    - `.artifacts/video-boundary-gradient-auto/comparison/deaee69b-roi-4up.mp4`
    - `.artifacts/video-boundary-gradient-auto/comparison/e1997e6e-roi-4up.mp4`
- 人工复核入口：
  - `.artifacts/video-boundary-gradient-auto/review-pack/latest-review-pack.md`
  - `.artifacts/video-boundary-gradient-auto/review-pack/latest-review-pack.json`
  - `.artifacts/video-boundary-gradient-auto/review-pack/latest-review-index.html`
  - `.artifacts/video-boundary-gradient-auto/review-pack/latest-review-index.png`
  - `.artifacts/video-boundary-gradient-auto/review-pack/latest-review-index-seek.png`
  - `.artifacts/video-boundary-gradient-auto/review-pack/latest-review-index-decision.png`
  - `.artifacts/video-boundary-gradient-auto/review-pack/latest-review-decision-sample.json`
  - `.artifacts/video-boundary-gradient-auto/review-pack/latest-review-decision-report.md`
  - `.artifacts/video-boundary-gradient-auto/review-pack/latest-review-decision-report.json`
- 人工复核静态快照：
  - `.artifacts/video-boundary-gradient-auto/review-snapshots/deaee69b-full-contact.png`
  - `.artifacts/video-boundary-gradient-auto/review-snapshots/deaee69b-roi-contact.png`
  - `.artifacts/video-boundary-gradient-auto/review-snapshots/e1997e6e-full-contact.png`
  - `.artifacts/video-boundary-gradient-auto/review-snapshots/e1997e6e-roi-contact.png`
- 人工复核时序残差：
  - `.artifacts/video-boundary-gradient-auto/temporal-residual/latest-report.md`
  - `.artifacts/video-boundary-gradient-auto/temporal-residual/latest-report.json`
  - `.artifacts/video-boundary-gradient-auto/temporal-residual/deaee69b-temporal-residual.png`
  - `.artifacts/video-boundary-gradient-auto/temporal-residual/deaee69b-auto-relocated-temporal-residual.png`
  - `.artifacts/video-boundary-gradient-auto/temporal-residual/e1997e6e-temporal-residual.png`
  - `.artifacts/video-boundary-gradient-auto/temporal-residual/e1997e6e-auto-relocated-temporal-residual.png`
- 轻量 polish `strength=0.20` 备选：
  - `.artifacts/video-light-polish-strength020/deaee69b-strength020.mp4`
  - `.artifacts/video-light-polish-strength020/e1997e6e-strength020.mp4`
  - `.artifacts/video-light-polish-strength020/benchmark/latest-report.md`
  - `.artifacts/video-light-polish-strength020/gate/latest-report.md`
  - `.artifacts/video-light-polish-strength020/temporal-residual/latest-report.md`
  - `.artifacts/video-light-polish-strength020/comparison/deaee69b-roi-4up.mp4`
  - `.artifacts/video-light-polish-strength020/comparison/e1997e6e-roi-4up.mp4`
  - `.artifacts/video-light-polish-strength020/comparison/deaee69b-full-4up.mp4`
  - `.artifacts/video-light-polish-strength020/comparison/e1997e6e-full-4up.mp4`
  - `.artifacts/video-light-polish-strength020/comparison/deaee69b-roi-contact.png`
  - `.artifacts/video-light-polish-strength020/comparison/e1997e6e-roi-contact.png`
  - `.artifacts/video-light-polish-strength020/review-pack/latest-polish-review-pack.json`
  - `.artifacts/video-light-polish-strength020/review-pack/latest-polish-review-index.html`
  - `.artifacts/video-light-polish-strength020/review-pack/latest-polish-review-index.png`
  - `.artifacts/video-light-polish-strength020/review-pack/latest-polish-review-decision-smoke.json`
  - `.artifacts/video-light-polish-sweep018022/deaee69b-strength018.mp4`
  - `.artifacts/video-light-polish-sweep018022/deaee69b-strength022.mp4`
  - `.artifacts/video-light-polish-sweep018022/e1997e6e-strength018.mp4`
  - `.artifacts/video-light-polish-sweep018022/e1997e6e-strength022.mp4`
  - `.artifacts/video-light-polish-sweep018022/benchmark/latest-report.md`
  - `.artifacts/video-light-polish-sweep018022/gate/latest-report.md`
  - `.artifacts/video-light-polish-sweep018022/temporal-residual/latest-report.md`
  - `.artifacts/video-light-polish-sweep018022/comparison/deaee69b-roi-strength-sweep-4up.mp4`
  - `.artifacts/video-light-polish-sweep018022/comparison/e1997e6e-roi-strength-sweep-4up.mp4`
  - `.artifacts/video-light-polish-sweep018022/review-pack/latest-sweep-review-pack.json`
  - `.artifacts/video-light-polish-sweep018022/review-pack/latest-sweep-review-index.html`
  - `.artifacts/video-light-polish-sweep018022/review-pack/latest-sweep-review-index.png`
  - `.artifacts/video-light-polish-sweep018022/review-pack/latest-sweep-review-decision-smoke.json`
  - `.artifacts/video-light-polish-sweep018022/review-pack/latest-sweep-review-decision-report.md`
  - `.artifacts/video-light-polish-sweep018022/review-pack/latest-sweep-review-decision-report.json`
- Release readiness:
  - `.artifacts/release-readiness/latest-report.md`
  - `.artifacts/release-readiness/latest-report.json`

当前 benchmark 摘要：

```json
{
  "total": 4,
  "rendered": 4,
  "renderedComparison": 4,
  "renderedOriginalOnly": 0,
  "skippedMissingOriginal": 0,
  "failed": 0,
  "missing": {
    "original": 0,
    "current": 0,
    "reference": 1
  }
}
```

当前 intake 观察：

- 4 条样例当前均为 `1920x1080`，默认 crop 仍覆盖 standard 与 relocated 两个 72px 候选：
  - standard anchor：`x=1740, y=900, size=72`
  - relocated/inset anchor：`x=1704, y=864, size=72`
  - 默认 crop：`left=1676, top=836, width=200, height=200`
- `095eddb6`：固定 anchor crop 内可见性随时间变化大；当前 score 只有 1/5 confident，后续处理必须依赖帧级 gate，不能盲目全帧固定处理。本轮已用 `allowLowConfidence` 导出 current；1 秒明显水印被处理，后续低可见帧没有一眼可见的大面积误修。
- `deaee69b`：allenk 锁到 relocated `1704,864,72`；按该 anchor 重新量测后是 `positive-high-confidence`，current 已处理正确位置，但相对 allenk 仍有明显平滑/发雾残影。
- `e1997e6e`：allenk 同样锁到 relocated `1704,864,72`；current 位置正确，主要差距仍是局部纹理自然度而非 anchor 选择。

当前 originalEvidence 分数摘要：

```json
{
  "4d420881": {
    "classification": "positive-high-confidence",
    "meanConfidence": 0.7223,
    "maxConfidence": 0.9297,
    "confidentFrames": 4,
    "likelyAbsentFrames": 1,
    "meanSpatial": 0.7394,
    "negativeSpatialFrames": 0
  },
  "095eddb6": {
    "classification": "intermittent-low-visible",
    "meanConfidence": 0.0425,
    "maxConfidence": 0.1689,
    "confidentFrames": 1,
    "likelyAbsentFrames": 4,
    "meanAbsSpatial": 0.1787,
    "negativeSpatialFrames": 2
  },
  "deaee69b": {
    "classification": "positive-high-confidence",
    "meanConfidence": 0.8180,
    "maxConfidence": 0.9273,
    "confidentFrames": 5,
    "likelyAbsentFrames": 0,
    "meanSpatial": 0.8159,
    "negativeSpatialFrames": 0
  },
  "e1997e6e": {
    "classification": "positive-high-confidence",
    "meanConfidence": 0.7982,
    "maxConfidence": 0.9209,
    "confidentFrames": 5,
    "likelyAbsentFrames": 0,
    "meanSpatial": 0.7139,
    "negativeSpatialFrames": 0
  }
}
```

当前 polarity probe 摘要：

```json
{
  "4d420881": {
    "bestPolarityCounts": {
      "positive": 4,
      "ambiguous": 1
    },
    "processCandidateFrames": 4,
    "reason": {
      "positive-score-confident": 4,
      "below-frame-threshold": 1
    }
  },
  "095eddb6": {
    "bestPolarityCounts": {
      "negative": 3,
      "ambiguous": 1,
      "positive": 1
    },
    "processCandidateFrames": 1,
    "reason": {
      "below-frame-threshold": 4,
      "positive-score-confident": 1
    }
  },
  "deaee69b": {
    "bestPolarityCounts": {
      "negative": 5
    },
    "processCandidateFrames": 3,
    "reason": {
      "negative-score-dominant": 3,
      "below-frame-threshold": 2
    }
  },
  "e1997e6e": {
    "bestPolarityCounts": {
      "negative": 4,
      "positive": 1
    },
    "processCandidateFrames": 3,
    "reason": {
      "negative-score-dominant": 2,
      "positive-score-confident": 1,
      "below-frame-threshold": 2
    }
  }
}
```

结论：

- `4d420881` 是标准正向高置信样例，现有正向 detector 能解释。
- `095eddb6` 是间歇/低可见样例，只有 1 帧建议作为候选处理，适合验证 frame gate。
- `deaee69b` / `e1997e6e` 的主要信号来自 negative polarity，而不是正向 confidence；下一步应研究 polarity-aware detection / dark-gray blend，而不是先调 cleanup。
- polarity probe 与多帧 evidence summary 已抽入 `src/video/videoWatermarkDetector.js`，后续生产 gate 可以直接复用这些 API；当前仍未接入 `videoExport` 的处理/cleanup 路径。

`4d420881` 当前 ROI 指标（5 帧，200x200 crop）：

```json
{
  "originalVsCurrent.meanAbsDeltaPerChannel": 3.9015,
  "currentVsReference.meanAbsDeltaPerChannel": 3.1528,
  "originalVsReference.meanAbsDeltaPerChannel": 4.9363
}
```

实验 bilateral 产物：

- `.artifacts/video-alpha-research/4d420881-gwr-video-mvp-hq-bilateral.mp4`
- `.artifacts/video-alpha-research/4d420881-output-crop-comparison-hq-bilateral.png`

实验结论：

- `edge-denoise-lite`：边线明显下降，但仍有轻微低频斑。
- `hq bilateral`：纹理保留更强，但 diamond 边线回来了，默认不启用。
- 当前主路径应保持 `edge-denoise-lite`，实验开关保留用于继续调参。

## Alpha Profile 研究记录

单帧反推：

- 使用 `original` 与 allenk 输出作为近似 clean 对，反推有效 alpha。
- 报告：
  - `.artifacts/video-alpha-research/4d420881-effective-alpha-report.json`
- 可视化：
  - `.artifacts/video-alpha-research/4d420881-effective-alpha-from-allenk.png`
  - `.artifacts/video-alpha-research/4d420881-alpha-diff-effective-template.png`
  - `.artifacts/video-alpha-research/4d420881-alpha-signed-diff-effective-template.png`

关键统计：

```json
{
  "leastSquaresGainEffectiveOverTemplate": 1.113,
  "corr": 0.978,
  "meanAbsOursVsAllenkClean": 3.54,
  "meanAbsOriginalVsAllenkClean": 34.35
}
```

多帧 profile 反推：

- 脚本：
  - `.artifacts/video-alpha-research/build-video-alpha-profile.mjs`
- 输出：
  - `.artifacts/video-alpha-research/4d420881-video-alpha-profile72.png`
  - `.artifacts/video-alpha-research/4d420881-video-alpha-profile72.json`

关键统计：

```json
{
  "leastSquaresGainVideoOverTemplate": 1.106,
  "corr": 0.9968,
  "meanAbsDiff": 0.0248
}
```

结论：

- 视频 alpha 与当前 V2 template 形状高度相关。
- 质量瓶颈不是单纯全局 gain 或 alpha 主形状。
- 关键差距仍是残留边缘的局部去噪 / 纹理重建。

## 验证命令

单元测试：

```powershell
rtk pnpm exec node --test tests/video/*.test.js
rtk pnpm exec node --test tests/scripts/renderVideoCropSheet.test.js
rtk pnpm exec node --test tests/scripts/videoCropBenchmark.test.js
rtk pnpm exec node --test tests/scripts/videoFrameBackendLab.test.js
rtk pnpm exec node --test tests/scripts/videoFrameLabSweepReport.test.js
```

生产构建：

```powershell
rtk pnpm build
```

当前验证状态：

- `tests/video/*.test.js` 通过。
- `tests/scripts/renderVideoCropSheet.test.js` 通过。
- `tests/scripts/videoCropBenchmark.test.js` 通过。
- `tests/scripts/videoFrameBackendLab.test.js` 通过。
- `tests/scripts/videoFrameLabSweepReport.test.js` 通过。
- `pnpm benchmark:video-crops` 通过：
  - rendered = 4
  - renderedComparison = 1
  - renderedOriginalOnly = 3
  - skippedMissingOriginal = 0
  - failed = 0
  - classifications:
    - `4d420881`: `positive-high-confidence`
    - `095eddb6`: `intermittent-low-visible`
    - `deaee69b`: `negative-or-gray-polarity`
    - `e1997e6e`: `negative-or-gray-polarity`
  - polarity probe:
    - `4d420881`: positive = 4, processCandidateFrames = 4
    - `095eddb6`: processCandidateFrames = 1
    - `deaee69b`: negative = 5, processCandidateFrames = 3
    - `e1997e6e`: negative = 4, positive = 1, processCandidateFrames = 3
- `pnpm build` 通过。

快速单帧后端实验：

```powershell
rtk pnpm lab:video-frames -- --cases 4d420881 --denoise-backend canvas-edge-denoise --edge-denoise-strength 0.65 --output-dir .artifacts/video-frame-backend-lab/edge065-smoke
rtk pnpm lab:video-frames -- --denoise-backend canvas-edge-denoise --edge-denoise-strength 0.65
rtk pnpm report:video-frame-lab -- --reports .artifacts/video-frame-backend-lab/edge035/latest-report.json,.artifacts/video-frame-backend-lab/edge050/latest-report.json,.artifacts/video-frame-backend-lab/latest-report.json,.artifacts/video-frame-backend-lab/edge080/latest-report.json,.artifacts/video-frame-backend-lab/edge100/latest-report.json
```

## 后续路线

### 近期

- 继续收集视频样例，按分辨率 / 横竖屏 / anchor / 背景类型分组。
- 补 `video` regression fixtures：
  - 1080p standard。
  - 720p-1。
  - 720p-2。
  - relocated portrait。
- 用 `scripts/render-video-crop-sheet.js` / `scripts/video-crop-benchmark.js` 给现有和新增样例统一生成 crop sheet，固定比较：
  - original
  - current MVP
  - allenk
  - original/current diff
  - current/allenk residual
- 给 `095eddb6`、`deaee69b`、`e1997e6e` 补 current MVP 输出；如果能跑 allenk，也补 reference 输出，再从 `rendered-original-only` 晋级到 `rendered-comparison`。
- 对 `095eddb6` 优先验证帧级 skip / confidence gate：它不是“每个采样点都明显有固定水印”的样例，可能暴露误处理风险。
- 对 `deaee69b` / `e1997e6e` 优先研究 detector polarity：肉眼可见但正向 confidence 偏低，下一步不应只调 cleanup；先确认视频水印是否存在 dark/gray blend、反相关 alpha profile 或背景归一化问题。
- polarity probe 当前已经确认 `deaee69b` / `e1997e6e` 主要是 negative polarity 证据；后续可以把这个结论转成生产 detection gate，但应继续保持 cleanup 不变，先验证误处理风险。
- 后续算法变化必须至少更新 `latest-summary.json` 中的 `currentVsReference.meanAbsDeltaPerChannel` 和对应 crop sheet，再判断是否优于当前 `edge-denoise-lite`。

### 中期

- 抽象 cleanup backend：
  - `canvas-lite`
  - `canvas-experimental`
  - `webgpu-denoise`
  - `webnn-denoise`
- 设计 ML denoise 接口：
  - 输入：padded ROI、alpha gradient mask、sigma / strength。
  - 输出：denoised ROI。
  - 只在本地运行，不上传。

### 高质量目标

- 对齐 allenk 的视频质量需要实现局部去噪器，而不是继续增强传统 inpaint。
- 可选技术路线：
  - WebGPU compute shader 实现轻量去噪。
  - WebNN / ONNX Runtime Web 加小模型。
  - 浏览器内 tiny CNN，只处理约 `200x200` ROI。

## 决策记录

- 采用 WebCodecs / Mediabunny 作为 MVP 主线。
- 暂不引入 wasm ffmpeg。
- allenk 的 `GeminiWatermarkTool` 仍是主参考；`VeoWatermarkRemover` README 补充视频算法描述。
- `hq bilateral` 实验开关保留但默认关闭，因为样例上比主路径更容易带回 diamond 边线。
- 当前推荐主路径：`edge-denoise-lite`。
## 2026-06-10 推进记录：视频 ROI 残影原因与窄边缘 cleanup

- 用户反馈全画面对比里 `current MVP` 的右下水印残影仍较明显，尤其在暗色车内面板上会形成稳定暗菱形。
- 复查历史产物后确认：`edge-denoise-lite` 能压掉白色主体，但会把 72x72 水印区域修成偏平滑暗斑；`hq-bilateral`、`gain 1.11`、`texture-inpaint` 都没有比该路线更稳。
- 本轮代码把 `src/video/videoExport.js` 的 cleanup mask 从“边缘 + alpha 内部兜底”改为更窄的 alpha 梯度边缘 mask：
  - 去掉中心 `alphaWeight` 兜底，避免整块 diamond 被 inpaint/blur。
  - dilation 从 `2px` 收到 `1px`。
  - mask blur sigma 从 `2` 收到约 `1.15`。
- 已验证 `narrow mask` 产物：
  - `.artifacts/video-alpha-research/4d420881-gwr-video-mvp-edge-narrow-mask.mp4`
  - `.artifacts/video-alpha-research/4d420881-output-crop-comparison-edge-narrow-mask.png`
  - `.artifacts/video-preview/4d420881-roi-comparison-narrow-mask.mp4`
- 与 allenk ROI 对齐的 ffmpeg SSIM 参考：
  - old `edge-denoise-lite`: `All ~= 0.975838`
  - `narrow mask`: `All ~= 0.982983`
  - `narrow mask + gain 1.11`: `All ~= 0.982876`
  - `narrow mask + adaptive`: `All ~= 0.983022`
- 结论：
  - 收窄 cleanup mask 有明确指标收益，并且减少大面积平滑。
  - 统一 alpha gain 与当前 adaptive alpha 对这条样例收益很小。
  - 低频亮度场修复实验没有产生肉眼级改善，已撤回，不进入主线。
- 下一步：
  - 不要继续盲目调强 cleanup。
  - 应优先研究视频 alpha edge profile / residual edge mask，或者引入真正的局部纹理 denoise 模块；当前纯 Canvas 修复距离 allenk 的 NCNN/FDnCNN 纹理自然度仍有差距。

### 2026-06-10 Edge Boost Sweep

- 在窄边缘 cleanup 基础上测试 `VIDEO_ALPHA_EDGE_BOOST`：
  - `0.000`: ROI SSIM vs allenk `All ~= 0.982770`
  - `0.035`: ROI SSIM vs allenk `All ~= 0.982983`
  - `0.045`: ROI SSIM vs allenk `All ~= 0.983044`
  - `0.070`: ROI SSIM vs allenk `All ~= 0.982933`
- 当前保留 `0.045`，收益很小但没有肉眼退化；这说明 edge boost 方向有轻微作用，但单靠线性 boost 不能解决暗色背景上的稳定 diamond 残影。
- 本轮新增可视化产物：
  - `.artifacts/video-alpha-research/4d420881-gwr-video-mvp-edgeboost045-narrow-mask.mp4`
  - `.artifacts/video-alpha-research/4d420881-output-crop-comparison-edgeboost045-narrow-mask.png`
  - `.artifacts/video-preview/4d420881-roi-comparison-edgeboost045.mp4`

### 2026-06-10 Usability Blur Pass

- 用户明确提出：视频输出首先保证可用，可以适当加一点模糊，不必追求完美反解。
- 本轮曾在 `edge boost 0.045 + narrow mask` 基础上加入轻量 cosmetic blur：
  - 根据 alpha footprint 生成低权重 blur mask。
  - 默认 `residualCleanupStrength=1.2` 时，最大混合权重约 `0.216`。
  - 只做局部浅模糊，用来弱化稳定 diamond 轮廓；不尝试恢复真实纹理。
- 评估：
  - `edgeboost045 narrow mask`: ROI SSIM vs allenk `All ~= 0.983044`
  - `edgeboost045 cosmetic blur @1.2`: ROI SSIM vs allenk `All ~= 0.983055`
  - `edgeboost045 cosmetic blur @1.8`: ROI SSIM vs allenk `All ~= 0.983045`
- 结论：
  - 轻量 blur 没有破坏 SSIM，但用户复评仍认为水印/残影明显，肉眼收益不足。
  - 强度 `1.8` 没有带来更好收益，也更容易让局部纹理显得糊。
  - 该方向已从主线代码撤回，仅保留产物作为失败参考；后续回到 alpha profile / residual mask 的数据驱动路线。
- 本轮新增可视化产物：
  - `.artifacts/video-alpha-research/4d420881-gwr-video-mvp-edgeboost045-cosmetic-blur.mp4`
  - `.artifacts/video-alpha-research/4d420881-output-crop-comparison-edgeboost045-cosmetic-blur.png`
  - `.artifacts/video-preview/4d420881-roi-comparison-cosmetic-blur.mp4`
  - `.artifacts/video-preview/4d420881-roi-comparison-cosmetic-blur-c180.mp4`

### 2026-06-10 Body Alpha Lift Probe / Darkening Guard

- 用户复评 blur 方向后反馈“效果还是不好”，因此本轮回到 alpha profile 诊断。
- 对 `edgeboost 0.045 + narrow mask` 与历史多帧反推 profile 做分区比较，发现当前 alpha 仍整体偏低，尤其是低梯度主体区：
  - `meanCurrent ~= 0.117489`
  - `meanProfile ~= 0.133524`
  - `meanDiff ~= -0.016035`
  - `meanAbsDiff ~= 0.017492`
  - `cosine ~= 0.996796`
  - `low-gradient-active.diff ~= -0.02451`
- 本轮新增 `VIDEO_ALPHA_BODY_LIFT = 0.018` 作为小幅实验：
  - 只提升 `alpha > 0.04` 且梯度较低的水印主体区。
  - 不扩张零 alpha 外缘，避免把处理范围扩大到背景。
  - 继续保留 `VIDEO_ALPHA_EDGE_BOOST = 0.045` 和窄边缘 cleanup。
- body lift 后 profile 贴合度：
  - `meanCurrent ~= 0.121681`
  - `meanProfile ~= 0.133524`
  - `meanDiff ~= -0.011842`
  - `meanAbsDiff ~= 0.013812`
  - `cosine ~= 0.997068`
- ROI SSIM vs allenk：
  - `edgeboost045 narrow mask`: `All ~= 0.983044`
  - `edgeboost045 bodylift018`: `All ~= 0.983079`
- 本轮新增可视化产物：
  - `.artifacts/video-alpha-research/4d420881-gwr-video-mvp-edgeboost045-bodylift018.mp4`
  - `.artifacts/video-alpha-research/4d420881-output-crop-comparison-edgeboost045-bodylift018.png`
  - `.artifacts/video-preview/4d420881-roi-comparison-bodylift018.mp4`
- 复评 / residual 结论：
  - body alpha lift 虽然略微提高 SSIM，但按 `current - allenk` 扣除低 alpha 背景偏移后，高 alpha 主体从 `edgeboost045` 的 `mean ~= +0.3177` 变成 `bodylift018` 的 `mean ~= -1.6719`，负残差占比升到 `~0.909`。
  - 这与用户肉眼看到的暗色 diamond 残影一致，说明 body lift 会加重暗化问题。
  - `VIDEO_ALPHA_BODY_LIFT` 已从主线代码撤回，body-lift 产物仅保留为失败参考。
- Edge/body residual 对比：
  - `edgeboost000`: high-body `mean ~= -3.2124`，主体明显偏暗。
  - `edgeboost045`: high-body `mean ~= +0.3177`，主体最均衡，但 edge `mean ~= -0.6723` 仍偏暗。
  - `edgeboost070`: high-body `mean ~= +0.6238`，edge `mean ~= -1.0097`，边缘暗化变重。
  - `bodylift018`: high-body `mean ~= -1.6719`，edge `mean ~= -1.3090`，整体暗残影变重。
- Darkening guard 失败探针：
  - 保留 `VIDEO_ALPHA_EDGE_BOOST = 0.045`。
  - 曾在 `src/video/videoExport.js` 的 cleanup 混合层加入两版暗化保护，尝试阻止边缘/主体被修成暗坑。
  - v1 过强：edge residual 从 `edgeboost045` 的 `mean ~= -0.6723` 被推到 `mean ~= +3.0910`，白色细边回来了。
  - v2 收窄成“暗坑地板”后，白边减少，但暗背景上出现更大范围烟雾状/偏色残影。
  - 两版 guard 均已从主线代码撤回，产物仅保留为失败参考：
    - `.artifacts/video-alpha-research/4d420881-gwr-video-mvp-edgeboost045-darkening-guard.mp4`
    - `.artifacts/video-alpha-research/4d420881-gwr-video-mvp-edgeboost045-darkening-guard-v2.mp4`
- 下一步：
  - 当前主线仍是 `edgeboost045 + narrow mask`，不要保留 body lift、cosmetic blur 或 darkening guard。
  - 暗残影不是简单亮度地板能解决的问题；下一步应继续研究 edge alpha profile / alpha feather，而不是在 cleanup 输出端做大范围亮度钳制。
  - 如果继续纯 Canvas 路线，优先做更窄、更贴 alpha gradient 的边缘 profile 修正；如果要接近 allenk，则仍需要局部纹理 denoise backend。

### 2026-06-10 Cleanup Strength / Edge Feather Probes

- cleanup 强度 sweep：
  - `cleanup 0.60`：edge RMS `~6.8186`，边缘残留明显回升，不能作为默认。
  - `cleanup 0.90`：edge `mean ~= -0.5443`、edge RMS `~2.0666`，比 `1.20` 的 edge 均值略好，但肉眼仍没有明显减少暗菱形。
  - `cleanup 1.20`：edge `mean ~= -0.6723`、edge RMS `~2.0552`，仍是当前稳定默认。
  - 结论：cleanup 默认强度不是主要瓶颈；过低会让白边回来，`0.90` 与 `1.20` 差异不足以解决用户反馈。
- edge feather v1：
  - 尝试只压低最高梯度轮廓上的 `VIDEO_ALPHA_EDGE_BOOST`，保留中间抗锯齿肩部 boost。
  - 产物：
    - `.artifacts/video-alpha-research/4d420881-gwr-video-mvp-edge-feather-v1.mp4`
    - `.artifacts/video-alpha-research/4d420881-output-crop-comparison-edge-feather-v1.png`
  - residual 对比：
    - baseline `edgeboost045`: all `mean ~= +0.0617`，edge `mean ~= -0.6723`，high-body `mean ~= +0.3177`
    - `edge-feather-v1`: all `mean ~= -1.0025`，edge `mean ~= -1.0045`，high-body `mean ~= -1.1034`
  - 结论：削最高梯度 boost 会破坏主体平衡，把输出整体推暗；已撤回，不进主线。
- 当前判断：
  - 单纯调 cleanup、body alpha、亮度保护、最高梯度 rolloff 都不能稳定改善。
  - 下一步更可能有效的是学习 allenk 的局部 denoise 行为，或从 `original/current/allenk` residual 中反推一个只作用于边缘残差的纹理修复/denoise mask，而不是继续调 alpha 标量。

### 2026-06-10 Residual Analyzer 固化

- 新增脚本：
  - `scripts/analyze-video-residual.js`
  - `tests/scripts/analyzeVideoResidual.test.js`
  - `package.json` 脚本：`analyze:video-residual`
- 首次用新脚本复跑当前基线：

```powershell
rtk pnpm analyze:video-residual -- --current .artifacts\video-alpha-research\4d420881-gwr-video-mvp-edgeboost045-narrow-mask.mp4 --allenk .artifacts\allenk-video\4d420881-allenk-v062.mp4 --original ${GWR_VIDEO_SAMPLE_ROOT}\4d420881-c144-497f-9a6e-43beda086580.mp4 --output .artifacts\video-residual\4d420881-edgeboost045-narrow-mask.json --timestamps 1,3,5,7,9
```

- 报告：
  - `.artifacts/video-residual/4d420881-edgeboost045-narrow-mask.json`
- 当前生产 alpha map 口径下的基线 residual：
  - `active`: `mean ~= 0.0225`, `meanAbs ~= 1.3562`, `rms ~= 2.0067`, `neg ~= 0.630`
  - `edge`: `mean ~= -0.7305`, `meanAbs ~= 1.4703`, `rms ~= 2.0968`, `neg ~= 0.795`
  - `lowBody`: `mean ~= -0.8451`, `meanAbs ~= 2.0011`, `rms ~= 3.0864`, `neg ~= 0.700`
  - `highBody`: `mean ~= 0.3274`, `meanAbs ~= 1.3073`, `rms ~= 1.9621`, `neg ~= 0.563`
- 解释：
  - 新脚本复用生产 `getVideoAlphaMap()`，所以与早先手写脚本使用 `.artifacts/video-alpha-research/4d420881-video-alpha-profile72.json` 分桶的数字不完全一致。
  - 结论保持一致：当前残影主要不是全局 alpha 标量问题，edge / lowBody 区域仍有偏暗残差。
  - 后续每个视频算法分叉都应先跑 `analyze:video-residual`，再判断是否值得保留。

### 2026-06-10 Benchmark 接入 Residual Metrics

- 更新 `scripts/video-crop-benchmark.js`：
  - 当 case 同时有 `currentPath` 与 `referencePath` 时，自动对每个 crop frame 计算 residual buckets。
  - 输出位置：`result.residualMetrics.aggregate` / `result.residualMetrics.frames`。
- 更新 `scripts/video-crop-benchmark-manifest.json`：
  - `4d420881.currentPath` 从旧 `edge-denoise-lite` 切到当前基线：
    - `.artifacts/video-alpha-research/4d420881-gwr-video-mvp-edgeboost045-narrow-mask.mp4`
- 已用 `rtk pnpm benchmark:video-crops -- --only 4d420881` 验证：
  - `rendered=1`
  - `comparison=1`
  - `failed=0`
  - 报告：`.artifacts/video-crop-benchmark/latest-summary.json`
- 当前 benchmark residual 与独立 analyzer 对齐：
  - `active.mean ~= 0.02245`
  - `edge.mean ~= -0.73053`
  - `lowBody.mean ~= -0.84508`
  - `highBody.mean ~= 0.32740`
- 结论：
  - 后续算法分叉不再只看 crop sheet 和 RGB mean diff。
  - 默认验收顺序应是：crop sheet 肉眼检查、`residualMetrics.edge/lowBody` 是否改善、再看是否引入白边/烟雾/偏色。

### 2026-06-10 Alpha Rebalance v1 失败探针

- 依据 benchmark residual：
  - `edge/lowBody` 偏暗。
  - `highBody` 略偏亮。
- 尝试：
  - `VIDEO_ALPHA_EDGE_BOOST` 从 `0.045` 收到 `0.035`。
  - 只对低梯度高 alpha 主体做极小 lift：`0.004`。
- 产物：
  - `.artifacts/video-alpha-research/4d420881-gwr-video-mvp-alpha-rebalance-v1.mp4`
  - `.artifacts/video-alpha-research/4d420881-output-crop-comparison-alpha-rebalance-v1.png`
  - `.artifacts/video-residual/4d420881-alpha-rebalance-v1.json`
- analyzer 结果：
  - `active.mean ~= -1.4056`, `active.neg ~= 0.893`
  - `edge.mean ~= -1.1027`, `edge.neg ~= 0.860`
  - `highBody.mean ~= -1.5351`, `highBody.neg ~= 0.907`
- 结论：
  - 该组合把当前输出整体推暗，暗色背景上更像烟雾状残影。
  - 已撤回代码，不进主线。
  - 这进一步说明：手动 alpha rebalancing 非常敏感，下一步应优先做局部 denoise / 纹理恢复实验，而不是继续微调 alpha 常量。

### 2026-06-10 Cleanup Backend 隔离实验

- 目的：确认用户看到的暗残影主要来自 inverse alpha 反解，还是 cleanup 后处理。
- 实验 A：纯 inverse alpha，不做 cleanup：
  - 参数：`residualCleanupStrength = 0`
  - 产物：
    - `.artifacts/video-alpha-research/4d420881-gwr-video-mvp-inverse-only-cleanup000.mp4`
    - `.artifacts/video-alpha-research/4d420881-output-crop-comparison-inverse-only-cleanup000.png`
    - `.artifacts/video-residual/4d420881-inverse-only-cleanup000.json`
  - residual：
    - `active.mean ~= -0.7515`, `active.rms ~= 9.5601`
    - `edge.mean ~= -2.5398`, `edge.rms ~= 16.3840`
    - `lowBody.mean ~= -8.8127`, `lowBody.rms ~= 12.3332`
  - 结论：纯反解会留下非常硬的黑色轮廓；不能移除 cleanup。
- 实验 B：当前 alpha + `highQualityCleanup=true` bilateral 分支：
  - 产物：
    - `.artifacts/video-alpha-research/4d420881-gwr-video-mvp-edgeboost045-hq-bilateral-current.mp4`
    - `.artifacts/video-alpha-research/4d420881-output-crop-comparison-edgeboost045-hq-bilateral-current.png`
    - `.artifacts/video-residual/4d420881-edgeboost045-hq-bilateral-current.json`
  - residual：
    - `active.mean ~= -0.4348`, `active.rms ~= 4.0566`
    - `edge.mean ~= -1.8966`, `edge.rms ~= 6.1155`
    - `lowBody.mean ~= -4.3928`, `lowBody.rms ~= 6.5922`
  - 结论：bilateral 分支比默认 cleanup 更容易保留黑色轮廓，不能作为默认替代。
- 对照：当前默认 `edgeboost045 + narrow mask + cleanup 1.2`：
  - `active.mean ~= 0.0225`, `active.rms ~= 2.0067`
  - `edge.mean ~= -0.7305`, `edge.rms ~= 2.0968`
  - `lowBody.mean ~= -0.8451`, `lowBody.rms ~= 3.0864`
- 当前判断：
  - 默认 cleanup 是传统 Canvas 路线里目前最稳的后处理，它大幅压低了纯反解硬边。
  - 剩余问题不是“去掉 cleanup”或“换成 bilateral”能解决。
  - 下一步应该在默认 cleanup 之后追加一个更局部、更证据驱动的 residual/texture repair，而不是替换现有 cleanup。

### 2026-06-10 Cleanup Strength 上限 Sweep / 候选默认

- 在确认 `cleanup=0` 与 `highQualityCleanup=true` 都不适合作为默认后，补测默认 cleanup 的更高强度：
  - `cleanup 1.50`
  - `cleanup 1.80`
- 产物：
  - `.artifacts/video-alpha-research/4d420881-gwr-video-mvp-edgeboost045-cleanup150.mp4`
  - `.artifacts/video-alpha-research/4d420881-output-crop-comparison-edgeboost045-cleanup150.png`
  - `.artifacts/video-residual/4d420881-edgeboost045-cleanup150.json`
  - `.artifacts/video-alpha-research/4d420881-gwr-video-mvp-edgeboost045-cleanup180.mp4`
  - `.artifacts/video-alpha-research/4d420881-output-crop-comparison-edgeboost045-cleanup180.png`
  - `.artifacts/video-residual/4d420881-edgeboost045-cleanup180.json`
- 对比当前旧默认 `cleanup 1.20`：
  - `cleanup 1.20`: `edge.mean ~= -0.7305`, `lowBody.mean ~= -0.8451`, `highBody.mean ~= 0.3274`
  - `cleanup 1.50`: `edge.mean ~= -0.2155`, `lowBody.mean ~= -0.1104`, `highBody.mean ~= 0.7124`
  - `cleanup 1.80`: `edge.mean ~= -0.3828`, `lowBody.mean ~= 0.0969`, `highBody.mean ~= 0.6304`
- 视觉观察：
  - `1.50` 没有明显白边回潮，也没有 darkening guard 那种烟雾状偏色。
  - `1.80` 没有比 `1.50` 更稳，略更糊且仍偏亮。
- 当前代码取舍：
  - `DEFAULT_RESIDUAL_CLEANUP_STRENGTH` 从 `1.2` 提到 `1.5`。
  - benchmark manifest 的 `4d420881.currentPath` 切到 `edgeboost045-cleanup150`。
- 风险：
  - 该默认值仍主要由 `4d420881` 这个有 allenk reference 的样例支持。
  - 后续必须给 `095eddb6`、`deaee69b`、`e1997e6e` 补 current/reference，确认 `1.50` 不会在低可见或 negative/gray polarity 样例上误修。

### 2026-06-10 其它样例补 Current Export

- 为验证 `cleanup150` 在非 4d 样例上的风险，已用本地 `dist/video-preview.html` 导出 3 个 current：
  - `.artifacts/video-alpha-research/095eddb6-gwr-video-mvp-edgeboost045-cleanup150.mp4`
  - `.artifacts/video-alpha-research/deaee69b-gwr-video-mvp-edgeboost045-cleanup150.mp4`
  - `.artifacts/video-alpha-research/e1997e6e-gwr-video-mvp-edgeboost045-cleanup150.mp4`
- 这些样例需要打开 `allowLowConfidence` 才能导出，因为 detector 对低可见或 negative/gray polarity 的置信度不足。
- 更新 manifest：
  - `095eddb6.currentPath` 指向 current export，`referencePath` 仍为 `null`。
  - `deaee69b.currentPath` 指向 current export，`referencePath` 仍为 `null`。
  - `e1997e6e.currentPath` 指向 current export，`referencePath` 仍为 `null`。
- 已跑全量 benchmark：
  - `rtk pnpm benchmark:video-crops`
  - rendered = 4
  - renderedComparison = 4
  - renderedOriginalOnly = 0
  - failed = 0
  - missing.reference = 3
- 新 crop sheet：
  - `.artifacts/video-crop-benchmark/095eddb6.png`
  - `.artifacts/video-crop-benchmark/deaee69b.png`
  - `.artifacts/video-crop-benchmark/e1997e6e.png`
- 肉眼观察：
  - `095eddb6`：1 秒明显水印被处理；后续低可见帧改动较小，没有明显大面积误修。
  - `deaee69b`：水印基本消失；局部平滑较明显，但比保留水印更可用。
  - `e1997e6e`：水印区域处理明显，低可见帧没有一眼灾难性误修。
- 下一步：
  - 仍需补 allenk/reference 输出，才能用 `residualMetrics` 定量判断这三个样例是否真的优于旧默认。
  - 当前只能说明 `cleanup150` 没有在这些样例的 crop sheet 上暴露明显失败。

### 2026-06-10 allenk Reference 补齐与 Relocated Anchor 结论

- 已探测 allenk v0.6.2 CLI：
  - `GeminiWatermarkTool-Video.exe --help` 确认支持 `--input` / `--output` / `--denoise ai` / `--sigma` / `--strength`。
  - 当前参照命令使用 `--denoise ai --sigma 75 --strength 180 --verbose`，与既有 `4d420881` allenk 日志一致。
- allenk 输出：
  - `.artifacts/allenk-video/deaee69b-allenk-v062.mp4`
  - `.artifacts/allenk-video/deaee69b-allenk-v062.log`
  - `.artifacts/allenk-video/e1997e6e-allenk-v062.mp4`
  - `.artifacts/allenk-video/e1997e6e-allenk-v062.log`
- allenk 日志结论：
  - `deaee69b`: `smart-search relocated 1080-class (seed-only) -> (1704,864) 72x72`, `Seed scale x0.997`, `240/240 frames +AI`
  - `e1997e6e`: `smart-search relocated 1080-class (seed-only) -> (1704,864) 72x72`, `Seed scale x1.027`, `240/240 frames +AI`
  - `095eddb6`: allenk auto mode 跳过，报 `no Gemini 3.5 diamond detected at 1920x1080`；`--force --region 1740,900,72,72` 与 `--threshold 0` 都不能绕过视频路径的 auto gate。
- 代码/manifest 更新：
  - `scripts/video-crop-benchmark.js` 新增 `resolveExpectedWatermarkCandidate()` / `resolveBenchmarkPrimaryCandidate()`，benchmark residual 和 originalEvidence 优先使用 manifest `expected.anchor`。
  - `scripts/video-crop-benchmark-manifest.json` 为 `deaee69b` / `e1997e6e` 指向 allenk reference，并写入 relocated `expected.anchor`。
  - `095eddb6` 保留 `referencePath: null`，并标记 `allenk-auto-skip`。
- 全量 benchmark：
  - `rtk pnpm benchmark:video-crops`
  - rendered = 4
  - failed = 0
  - missing.reference = 1
- 当前 `cleanup150` vs allenk residual：
  - `4d420881` standard：`active.meanAbs ~= 1.3183`, `active.rms ~= 2.0137`
  - `deaee69b` relocated：`active.meanAbs ~= 4.3948`, `active.rms ~= 7.3551`
  - `e1997e6e` relocated：`active.meanAbs ~= 3.8806`, `active.rms ~= 7.4384`
- 关键判断：
  - relocated 样例不是 anchor 没处理；当前 detector/export 会锁到 inset/relocated 并明显修改正确区域。
  - 差距主要是 cleanup 后的局部纹理自然度：current 更容易形成平滑/发雾斑块，allenk 的 AI cleanup 更能保留背景材质。

### 2026-06-10 Seed Boost / HQ Bilateral 失败复测

- Seed boost 实验：
  - 临时给自动 seed 加 `+0.04`，导出：
    - `.artifacts/video-alpha-research/4d420881-gwr-video-mvp-edgeboost045-cleanup150-seedboost040.mp4`
    - `.artifacts/video-alpha-research/deaee69b-gwr-video-mvp-edgeboost045-cleanup150-seedboost040.mp4`
    - `.artifacts/video-alpha-research/e1997e6e-gwr-video-mvp-edgeboost045-cleanup150-seedboost040.mp4`
  - residual 对比：
    - `4d420881` active meanAbs `1.3183 -> 1.6843`，退化。
    - `deaee69b` active meanAbs `4.3948 -> 3.8289`，局部改善。
    - `e1997e6e` active meanAbs `3.8806 -> 4.1061`，退化。
  - 结论：seed bias 不是稳定默认；已撤回代码。仅保留产物作为失败证据。
- HQ bilateral 复测：
  - 导出：
    - `.artifacts/video-alpha-research/deaee69b-gwr-video-mvp-edgeboost045-cleanup150-hqbilateral.mp4`
    - `.artifacts/video-alpha-research/e1997e6e-gwr-video-mvp-edgeboost045-cleanup150-hqbilateral.mp4`
  - residual 对比：
    - `deaee69b` active meanAbs `4.3948 -> 4.5316`，退化；edge/lowBody 明显偏暗。
    - `e1997e6e` active meanAbs `3.8806 -> 3.3382`，但 edge/lowBody 偏暗，视觉上黑色 diamond 轮廓回潮。
  - 结论：hq bilateral 仍不适合默认；它可能降低某些 RMS，但会带回黑色边线。
- 当前下一步：
  - 不要把 seed boost 或 hq bilateral 合入主线。
  - 纯 Canvas 下一步应做“边缘残差局部修补 + 纹理保留”的小模块，而不是继续调全局 alpha / cleanup 强度。
  - 如果追求 allenk 级自然度，仍应启动 WebGPU/WebNN/tiny-CNN denoise backend 设计。

### 2026-06-10 Texture Repair 默认关闭实验

- 本轮新增默认关闭的实验开关：
  - `src/video/videoExport.js`: `textureRepair` / `textureRepairStrength`
  - `src/video-app.js`: 将预览页 checkbox 透传到 `removeGeminiVideoWatermark()`
  - `public/video-preview.html`: `实验性纹理回填`
- 实现思路：
  - 仍保留默认 `edgeboost045 + cleanup150` 作为基础。
  - 在 cleanup 后，只对 alpha footprint / edge 权重区域尝试回填邻近非水印区域的高频纹理。
  - 目标是缓解平滑/发雾斑，而不是改变 alpha 反解。
- 产物：
  - `.artifacts/video-alpha-research/deaee69b-gwr-video-mvp-edgeboost045-cleanup150-texture-repair.mp4`
  - `.artifacts/video-alpha-research/e1997e6e-gwr-video-mvp-edgeboost045-cleanup150-texture-repair.mp4`
  - `.artifacts/video-alpha-research/deaee69b-gwr-video-mvp-edgeboost045-cleanup150-texture-repair085.mp4`
  - `.artifacts/video-alpha-research/e1997e6e-gwr-video-mvp-edgeboost045-cleanup150-texture-repair085.mp4`
- `textureRepairStrength = 0.45` 结论：
  - `deaee69b` active meanAbs `4.3948 -> 4.4706`，退化。
  - `e1997e6e` active meanAbs `3.8806 -> 3.8806`，RMS `7.4384 -> 7.2618`，只有轻微收益。
  - 视觉收益非常弱。
- `textureRepairStrength = 0.85` 结论：
  - `deaee69b` active meanAbs `4.3948 -> 4.4004`，基本持平；lowBody meanAbs 变差。
  - `e1997e6e` active meanAbs `3.8806 -> 3.7739`，RMS `7.4384 -> 7.1126`，edge meanAbs `5.8970 -> 5.6332`。
  - 肉眼没有明显新黑边，但改善仍偏弱，不足以默认启用。
- 当前取舍：
  - 保留为默认关闭的实验开关，方便继续做对照导出。
  - `DEFAULT_TEXTURE_REPAIR = false`，不会改变当前默认视频输出。
  - 下一步如果继续纯 Canvas，应改进纹理回填的 mask/采样策略；若目标是显著接近 allenk，仍应优先推进局部 denoise backend。

### 2026-06-10 Cleanup Backend 边界抽象

- 本轮重构：
  - 新增 `src/video/videoCleanupBackends.js`。
  - 将 soft cleanup、hq bilateral、texture repair weight map / repair 实现从 `src/video/videoExport.js` 抽离。
  - `src/video/videoExport.js` 只保留检测、alpha seed / adaptive alpha、逐帧编码与进度回调。
  - 新增 `normalizeVideoCleanupOptions()`，统一 cleanup 默认值和强度 clamp。
  - 新增 `applyVideoResidualCleanup()`，作为后续 WebGPU / WebNN / tiny-CNN 局部 denoise backend 的接入边界。
- 默认行为：
  - `DEFAULT_RESIDUAL_CLEANUP_STRENGTH = 1.5`
  - `DEFAULT_HIGH_QUALITY_CLEANUP = false`
  - `DEFAULT_DENOISE_BACKEND = none`
  - `DEFAULT_TEXTURE_REPAIR = false`
  - 修正导出函数省略 `highQualityCleanup` 时曾实际走 `true` 的不一致；现在与 UI / 文档一致，默认是 `false`。
- 测试：
  - 新增 `tests/video/videoCleanupBackends.test.js`。
  - 覆盖默认选项、clamp、gradient weight、texture repair weight、cleanup 关闭时不触碰 Canvas。
- 验证：
  - `rtk pnpm exec node --test tests/video/*.test.js tests/scripts/analyzeVideoResidual.test.js tests/scripts/renderVideoCropSheet.test.js tests/scripts/videoCropBenchmark.test.js tests/scripts/scriptEntrypoints.test.js`
    - 43 tests passed。
  - `rtk pnpm build` 通过。
  - `rtk pnpm benchmark:video-crops` 通过。
- benchmark 未改变当前默认指标：
  - `4d420881`: `active.meanAbs ~= 1.3183`
  - `deaee69b`: `active.meanAbs ~= 4.3948`
  - `e1997e6e`: `active.meanAbs ~= 3.8806`
- 下一步：
  - 以 `applyVideoResidualCleanup()` 为边界设计 `denoise backend` 接口。
  - 优先做“只吃 ROI + alpha/edge mask + 强度参数”的同步 Canvas baseline，再评估异步 WebGPU/WebNN/tiny-CNN 后端。
  - 继续保持默认输出稳定，新增后端先作为实验选项和 benchmark 分叉进入。

### 2026-06-10 Denoise Backend 命名入口

- 本轮把实验性纹理回填提升为命名 denoise backend：
  - 新增 `DEFAULT_DENOISE_BACKEND = 'none'`。
  - 新增 `VIDEO_DENOISE_BACKENDS`：
    - `none`
    - `canvas-texture-repair`
  - `normalizeVideoCleanupOptions()` 返回：
    - `cleanupBackend`
    - `denoiseBackend`
    - legacy `textureRepair`
- 兼容规则：
  - 显式 `denoiseBackend` 优先。
  - 未显式指定时，旧参数 `textureRepair=true` 会映射为 `denoiseBackend=canvas-texture-repair`。
  - `textureRepair=false` 且未指定 `denoiseBackend` 时保持 `none`。
- 导出结果：
  - `removeGeminiVideoWatermark()` 返回 payload 现在包含 `denoiseBackend`，方便后续产物/benchmark 记录具体后端。
- 验证：
  - `rtk pnpm exec node --test tests/video/*.test.js tests/scripts/analyzeVideoResidual.test.js tests/scripts/renderVideoCropSheet.test.js tests/scripts/videoCropBenchmark.test.js tests/scripts/scriptEntrypoints.test.js`
    - 44 tests passed。
  - `rtk pnpm build` 通过。
  - `rtk pnpm benchmark:video-crops` 通过。
  - 默认 benchmark 指标保持不变：
    - `4d420881`: `active.meanAbs ~= 1.3183`
    - `deaee69b`: `active.meanAbs ~= 4.3948`
    - `e1997e6e`: `active.meanAbs ~= 3.8806`
- 下一步：
  - export 产物命名继续加上后端字段，避免实验文件名继续靠人工约定。
  - 再接一个新的 `canvas-*` denoise 后端时，只改 `VIDEO_DENOISE_BACKENDS` 与 `applyVideoResidualCleanup()` 分派，不再触碰导出主流程。

### 2026-06-10 Benchmark Profile 元信息

- 本轮更新：
  - `scripts/video-crop-benchmark-manifest.json` 为 4 个样例补充 `currentProfile`。
  - 有 allenk reference 的样例补充 `referenceProfile`。
  - `scripts/video-crop-benchmark.js` 的 normalized case / summary result 保留这些 profile 字段。
- 当前 `currentProfile` 统一记录：
  - `algorithm = gwr-video-mvp`
  - `alphaProfile = edgeboost045`
  - `cleanupBackend = canvas-soft`
  - `residualCleanupStrength = 1.5`
  - `denoiseBackend = none`
  - 低置信样例额外记录 `allowLowConfidence = true`
- 当前 `referenceProfile` 记录：
  - `algorithm = allenk`
  - `version = 0.6.2`
  - `denoiseBackend = ncnn`
  - `sigma = 75`
  - `strengthPercent = 180`
- 验证：
  - `rtk pnpm exec node --test tests/video/*.test.js tests/scripts/analyzeVideoResidual.test.js tests/scripts/renderVideoCropSheet.test.js tests/scripts/videoCropBenchmark.test.js tests/scripts/scriptEntrypoints.test.js`
    - 44 tests passed。
  - `rtk pnpm build` 通过。
  - `rtk pnpm benchmark:video-crops` 通过。
  - `.artifacts/video-crop-benchmark/latest-summary.json` 已确认写入 profile：
    - `4d420881`: `current=gwr-video-mvp/none`, `reference=allenk`, `active.meanAbs ~= 1.3183`
    - `deaee69b`: `current=gwr-video-mvp/none`, `reference=allenk`, `active.meanAbs ~= 4.3948`
    - `e1997e6e`: `current=gwr-video-mvp/none`, `reference=allenk`, `active.meanAbs ~= 3.8806`
- 价值：
  - 后续比较 `canvas-texture-repair`、新 `canvas-*` 后端或 WebGPU/WebNN 后端时，summary 不再只依赖文件名推断算法参数。

### 2026-06-10 Canvas Edge Denoise Backend

- 本轮新增第二个命名 denoise backend：
  - `VIDEO_DENOISE_BACKENDS.CANVAS_EDGE_DENOISE = 'canvas-edge-denoise'`
  - `DEFAULT_EDGE_DENOISE_STRENGTH = 0.65`
- 实现位置：
  - `src/video/videoCleanupBackends.js`
- 处理方式：
  - 默认 soft cleanup 之后执行。
  - 只根据 `buildGradientWeightMap()` 得到的 alpha 边缘权重作用。
  - 在小 padding ROI 内做轻量 bilateral denoise，再按边缘权重低强度 blend 回原图。
  - 目标是提供一个比 texture repair 更保守的边缘残差去噪分叉；不追求默认启用。
- UI：
  - `public/video-preview.html` 新增 `后端去噪` select。
  - `src/video-app.js` 透传 `denoiseBackend` 到 `removeGeminiVideoWatermark()`。
  - 默认仍为 `none`。
- 导出结果：
  - payload 继续返回 `denoiseBackend`。
  - payload 新增 `edgeDenoiseStrength`。
- 测试：
  - `tests/video/videoCleanupBackends.test.js` 增加 `canvas-edge-denoise` 分派测试。
- 验证：
  - `rtk pnpm exec node --test tests/video/*.test.js tests/scripts/analyzeVideoResidual.test.js tests/scripts/renderVideoCropSheet.test.js tests/scripts/videoCropBenchmark.test.js tests/scripts/scriptEntrypoints.test.js`
    - 45 tests passed。
  - `rtk pnpm build` 通过。
  - `rtk pnpm benchmark:video-crops` 通过。
  - 默认 benchmark 指标仍未改变：
    - `4d420881`: `active.meanAbs ~= 1.3183`
    - `deaee69b`: `active.meanAbs ~= 4.3948`
    - `e1997e6e`: `active.meanAbs ~= 3.8806`
- 下一步：
  - 从预览页导出 `canvas-edge-denoise` 分叉视频，再写入 benchmark manifest 的新 case 或临时对比 manifest。
  - 重点观察 relocated 样例上是否降低 `edge.meanAbs`，以及是否带回黑色轮廓或增加平滑斑。

### 2026-06-10 Canvas Edge Denoise 分叉导出与 Benchmark

- 新增脚本：
  - `scripts/export-video-backend-variant.js`
  - `package.json`: `export:video-backend`
  - 用途：不启动 dev server，直接打开 `dist/video-preview.html`，通过 Playwright 导出指定 backend 的 MP4。
- 新增导出产物：
  - `.artifacts/video-alpha-research/deaee69b-gwr-video-mvp-edgeboost045-cleanup150-canvas-edge-denoise.mp4`
  - `.artifacts/video-alpha-research/e1997e6e-gwr-video-mvp-edgeboost045-cleanup150-canvas-edge-denoise.mp4`
  - `.artifacts/video-alpha-research/deaee69b-gwr-video-mvp-edgeboost045-cleanup150-canvas-edge-denoise100.mp4`
  - `.artifacts/video-alpha-research/e1997e6e-gwr-video-mvp-edgeboost045-cleanup150-canvas-edge-denoise100.mp4`
- UI / 导出参数：
  - `public/video-preview.html` 新增 `边缘去噪强度` range。
  - `src/video-app.js` 透传 `edgeDenoiseStrength`。
  - `scripts/export-video-backend-variant.js` 支持 `--edge-denoise-strength`。
- manifest：
  - `scripts/video-crop-benchmark-manifest.json` 新增 4 个 variant case：
    - `deaee69b-edge-denoise`
    - `deaee69b-edge-denoise100`
    - `e1997e6e-edge-denoise`
    - `e1997e6e-edge-denoise100`
- benchmark：
  - `rtk pnpm benchmark:video-crops`
  - rendered = 8
  - failed = 0
  - `.artifacts/video-crop-benchmark/latest-summary.json` 新增 `variantComparisons`。
- residual 结果：
  - `deaee69b`
    - baseline active meanAbs `4.3948`, edge `5.2647`, lowBody `4.1230`
    - edge-denoise `0.65`: active `4.3900`, edge `5.1850`, lowBody `3.9945`
    - edge-denoise `1.0`: active `4.5089`, edge `5.3367`, lowBody `4.1650`
  - `e1997e6e`
    - baseline active meanAbs `3.8806`, edge `5.8970`, lowBody `6.2071`
    - edge-denoise `0.65`: active `3.8468`, edge `5.6883`, lowBody `6.3071`
    - edge-denoise `1.0`: active `3.8967`, edge `5.7592`, lowBody `6.2940`
- 视觉观察：
  - `0.65` 没有明显黑边回潮，整体比默认只小幅变化。
  - `deaee69b` 仍有平滑/发雾斑，改善不明显。
  - `e1997e6e` edge 指标更好，但 lowBody 稍退。
  - `1.0` 在两个样例上都不如 `0.65` 稳，不能作为候选默认。
- 当前取舍：
  - 保留 `canvas-edge-denoise` 作为实验后端。
  - 默认仍保持 `denoiseBackend=none`。
  - 如果后续继续纯 Canvas，应围绕 `0.65` 强度微调 mask，而不是加大 strength。
  - 若目标是明显接近 allenk，仍应优先推进 ML/WebGPU/WebNN 局部 denoise。
- 额外修复：
  - `scripts/analyze-video-residual.js` 默认帧目录改为从 output path 派生，避免并行运行互相删除临时帧。

### 2026-06-10 Benchmark Variant Delta 自动化

- 本轮新增：
  - `scripts/video-crop-benchmark.js` 导出 `summarizeVideoBenchmarkVariants()`。
  - `runVideoCropBenchmark()` 的 summary report 顶层新增 `variantComparisons`。
- 配对规则：
  - baseline：同组中 `currentProfile.denoiseBackend = none` 且 `tags` 不含 `variant` 的 case。
  - variant：`tags` 包含 `variant` 且有 `residualMetrics.aggregate` 的 case。
  - 同组定义：`originalPath + referencePath + expected.anchor` 相同。
- 输出内容：
  - `baselineId`
  - `variantId`
  - `currentProfile`
  - `baselineProfile`
  - `deltas.active/edge/lowBody/highBody`
  - 每个 bucket 的 `meanAbsDelta` / `rmsDelta` / `meanDelta` / `verdict`
- 当前自动 delta 摘要：
  - `deaee69b-edge-denoise`: active `-0.0048 neutral`, edge `-0.0798 improved`, lowBody `-0.1286 improved`, highBody `+0.0258 regressed`
  - `deaee69b-edge-denoise100`: active `+0.1141 regressed`, edge `+0.0720 regressed`, lowBody `+0.0419 regressed`, highBody `+0.1313 regressed`
  - `e1997e6e-edge-denoise`: active `-0.0338 improved`, edge `-0.2087 improved`, lowBody `+0.1000 regressed`, highBody `+0.0353 regressed`
  - `e1997e6e-edge-denoise100`: active `+0.0161 neutral`, edge `-0.1378 improved`, lowBody `+0.0870 regressed`, highBody `+0.0771 regressed`
- 结论：
  - 之后新增后端或参数分叉时，只要标记 `tags: ["variant", ...]` 并写入 profile，就能自动拿到相对 baseline 的结构化 delta。
  - `canvas-edge-denoise 0.65` 仍是“弱候选”，`1.0` 应视为退化分叉。
- 验证：
  - `rtk pnpm exec node --test tests/video/*.test.js tests/scripts/analyzeVideoResidual.test.js tests/scripts/renderVideoCropSheet.test.js tests/scripts/videoCropBenchmark.test.js tests/scripts/scriptEntrypoints.test.js`
    - 46 tests passed。
  - `rtk pnpm build` 通过。
  - `rtk pnpm benchmark:video-crops` 通过。

### 2026-06-10 4d420881 Edge Denoise 补齐与 Markdown 报告

- 本轮补齐 standard anchor 样例的 edge denoise 分叉：
  - `.artifacts/video-alpha-research/4d420881-gwr-video-mvp-edgeboost045-cleanup150-canvas-edge-denoise.mp4`
  - `.artifacts/video-alpha-research/4d420881-gwr-video-mvp-edgeboost045-cleanup150-canvas-edge-denoise100.mp4`
- `scripts/video-crop-benchmark-manifest.json` 新增：
  - `4d420881-edge-denoise`
  - `4d420881-edge-denoise100`
- 新增 Markdown 报告脚本：
  - `scripts/report-video-crop-benchmark.js`
  - `package.json`: `report:video-crops`
  - 输出：`.artifacts/video-crop-benchmark/latest-report.md`
  - 测试：`tests/scripts/videoCropBenchmarkReport.test.js`
- 最新 benchmark：
  - `rtk pnpm benchmark:video-crops`
  - rendered = 10
  - failed = 0
  - missing.reference = 1（仍是 `095eddb6`，allenk auto skip）
- 最新 Markdown 报告：
  - `rtk pnpm report:video-crops`
  - `.artifacts/video-crop-benchmark/latest-report.md`
  - 自动建议：
    - `canvas-edge-denoise 0.65` 是弱实验候选：edge residual 有改善，但 body bucket 至少在一个样例上退化。
    - 默认应继续保持 `denoiseBackend=none`。
    - 下一步优先 mask refinement 或 ML/WebGPU/WebNN 局部 denoise。
- `4d420881` delta：
  - `0.65`: active `-0.0080 neutral`, edge `-0.0767 improved`, lowBody `+0.0359 regressed`, highBody `+0.0192 neutral`
  - `1.0`: active `+0.0124 neutral`, edge `-0.0128 neutral`, lowBody `+0.0855 regressed`, highBody `+0.0220 regressed`
- 跨样例判断：
  - `0.65` 在 `4d420881`、`deaee69b`、`e1997e6e` 上都能改善 edge bucket。
  - 但 active 多为 neutral/小幅 improved，body bucket 有退化。
  - `1.0` 不稳定，继续作为 rejected/diagnostic branch。
- 当前决策：
  - Canvas 后端仍可作为小修小补实验线保留，但不值得继续通过加大强度追求默认化。
  - 真正要缩小与 allenk 的差距，应转向更像 NCNN/FDnCNN 的局部 denoise：WebGPU/WebNN/tiny-CNN 原型优先级高于继续堆 Canvas 参数。
- 验证：
  - `rtk pnpm exec node --test tests/scripts/videoCropBenchmark.test.js tests/scripts/videoCropBenchmarkReport.test.js tests/scripts/scriptEntrypoints.test.js`
    - 17 tests passed。
  - `rtk pnpm build` 通过。
  - `rtk pnpm benchmark:video-crops` 通过。
  - `rtk pnpm report:video-crops` 通过。

### 2026-06-11 单帧后端实验台

- 新增脚本：
  - `scripts/run-video-frame-backend-lab.js`
  - `package.json`: `lab:video-frames`
  - 测试：`tests/scripts/videoFrameBackendLab.test.js`
- 设计目的：
  - 从 benchmark manifest 选择有 `current + reference` 的 baseline case。
  - 用 `renderVideoCropSheet(... keepFrames=true)` 抽取同一批 crop PNG。
  - 在 crop 上直接调用 `applyVideoResidualCleanup()`，跳过整段视频重导出。
  - 输出单帧对照 sheet 与 active / edge / lowBody / highBody delta，作为后续 Canvas / WebGPU / WebNN / tiny-CNN 后端的快速实验台。
- 当前输出：
  - `.artifacts/video-frame-backend-lab/latest-report.json`
  - `.artifacts/video-frame-backend-lab/latest-report.md`
  - `.artifacts/video-frame-backend-lab/4d420881-canvas-edge-denoise.png`
  - `.artifacts/video-frame-backend-lab/deaee69b-canvas-edge-denoise.png`
  - `.artifacts/video-frame-backend-lab/e1997e6e-canvas-edge-denoise.png`
- 本轮参数：
  - `denoiseBackend = canvas-edge-denoise`
  - `edgeDenoiseStrength = 0.65`
  - `residualCleanupStrength = 0`
- 单帧实验 delta：
  - `4d420881`: active `-0.0045 neutral`, edge `-0.0172 neutral`, lowBody `-0.1093 improved`, highBody `+0.0011 neutral`
  - `deaee69b`: active `+0.0046 neutral`, edge `-0.0201 improved`, lowBody `+0.0025 neutral`, highBody `+0.0145 neutral`
  - `e1997e6e`: active `+0.0003 neutral`, edge `-0.0267 improved`, lowBody `-0.0660 improved`, highBody `+0.0114 neutral`
- 判断：
  - 单帧实验台已经可用，能比重新导出整段视频更快地验证后端参数。
  - `canvas-edge-denoise 0.65` 在单帧后处理上仍只是轻微改善 edge / lowBody，不会明显缩小与 allenk AI denoise 的纹理自然度差距。
  - 下一步值得做的是在这个实验台上接入更强的 ROI 局部 denoise 原型，或先改进 edge/body mask；不建议继续通过加大 Canvas blur/denoise strength 追求默认启用。
- 验证：
  - `rtk pnpm exec node --test tests/scripts/videoFrameBackendLab.test.js tests/scripts/scriptEntrypoints.test.js`
    - 3 tests passed。
  - `rtk pnpm lab:video-frames -- --cases 4d420881 --denoise-backend canvas-edge-denoise --edge-denoise-strength 0.65 --output-dir .artifacts/video-frame-backend-lab/edge065-smoke` 通过。
  - `rtk pnpm lab:video-frames -- --denoise-backend canvas-edge-denoise --edge-denoise-strength 0.65` 通过。

### 2026-06-11 单帧 Edge Denoise 强度 Sweep

- 新增脚本：
  - `scripts/report-video-frame-lab-sweep.js`
  - `package.json`: `report:video-frame-lab`
  - 测试：`tests/scripts/videoFrameLabSweepReport.test.js`
- 本轮用单帧实验台跑了 `canvas-edge-denoise` 强度：
  - `0.35`
  - `0.50`
  - `0.65`
  - `0.80`
  - `1.00`
- 汇总产物：
  - `.artifacts/video-frame-backend-lab/latest-sweep-report.md`
  - `.artifacts/video-frame-backend-lab/latest-sweep-report.json`
- 自动汇总结论：
  - `0.50`：零 bucket 回归，自动推荐为最保守稳定 profile。
  - `0.65`：同样没有 bucket 级回归，edge gain 略高于 `0.50`，可视为当前更积极的稳定上限候选。
  - `0.80`：edge gain 明显增加，但 `deaee69b.lowBody` 和 `e1997e6e.highBody` 开始回归。
  - `1.00`：edge gain 更高，但 `deaee69b.lowBody/highBody` 与 `e1997e6e.highBody` 回归，继续作为 rejected/diagnostic 分叉。
  - `0.35`：太弱，且 `e1997e6e.lowBody` 回归，不值得作为默认候选。
- 当前决策：
  - 如果只追求保守可用，后续视频导出分叉可试 `edgeDenoiseStrength=0.50`。
  - 如果追求稍强 edge 修复，`0.65` 仍是可观察候选，但不能直接默认。
  - `0.80+` 不进入旧 `canvas-edge-denoise` 的默认候选；它说明“继续加大 denoise strength”会沿着 body regression 的方向走。
  - 下一步应改 mask / 后端能力，而不是继续调旧后端强度。
- 验证：
  - `rtk pnpm exec node --test tests/scripts/videoFrameLabSweepReport.test.js tests/scripts/scriptEntrypoints.test.js`
    - 3 tests passed。
  - `rtk pnpm report:video-frame-lab -- --reports .artifacts/video-frame-backend-lab/edge035/latest-report.json,.artifacts/video-frame-backend-lab/edge050/latest-report.json,.artifacts/video-frame-backend-lab/latest-report.json,.artifacts/video-frame-backend-lab/edge080/latest-report.json,.artifacts/video-frame-backend-lab/edge100/latest-report.json --output .artifacts/video-frame-backend-lab/latest-sweep-report.md --json .artifacts/video-frame-backend-lab/latest-sweep-report.json` 通过。

### 2026-06-11 Canvas Edge Band Denoise 原型

- 新增后端：
  - `VIDEO_DENOISE_BACKENDS.CANVAS_EDGE_BAND_DENOISE = 'canvas-edge-band-denoise'`
  - 实现位置：`src/video/videoCleanupBackends.js`
  - UI 入口：`public/video-preview.html` 的后端去噪 select。
- 设计：
  - 仍是同步 Canvas ROI 后端，不改默认导出路径。
  - 在 `canvas-edge-denoise` 的基础上新增 `buildEdgeBandDenoiseWeightMap()`。
  - 用真实 72px video alpha 的 high-alpha body 分布做 guard：
    - high body 约从 `alpha >= 0.22` 开始需要保护。
    - 只让强 edge core 穿透 guard。
    - 抑制 high-alpha body 中心被高强度 bilateral smoothing 误伤。
- 实验命令：
  - `rtk pnpm lab:video-frames -- --denoise-backend canvas-edge-band-denoise --edge-denoise-strength 0.50 --output-dir .artifacts/video-frame-backend-lab/band050`
  - `rtk pnpm lab:video-frames -- --denoise-backend canvas-edge-band-denoise --edge-denoise-strength 0.65 --output-dir .artifacts/video-frame-backend-lab/band065`
  - `rtk pnpm lab:video-frames -- --denoise-backend canvas-edge-band-denoise --edge-denoise-strength 0.80 --output-dir .artifacts/video-frame-backend-lab/band080`
  - `rtk pnpm lab:video-frames -- --denoise-backend canvas-edge-band-denoise --edge-denoise-strength 1.00 --output-dir .artifacts/video-frame-backend-lab/band100`
- 汇总产物：
  - `.artifacts/video-frame-backend-lab/latest-band-sweep-report.md`
  - `.artifacts/video-frame-backend-lab/latest-band-sweep-report.json`
  - `.artifacts/video-frame-backend-lab/band080/4d420881-canvas-edge-band-denoise.png`
  - `.artifacts/video-frame-backend-lab/band080/deaee69b-canvas-edge-band-denoise.png`
  - `.artifacts/video-frame-backend-lab/band080/e1997e6e-canvas-edge-band-denoise.png`
- 与旧 `canvas-edge-denoise` 的 0.50 / 0.65 基线对比：
  - `canvas-edge-denoise 0.50`: improved = 2, regressed = 0, edge gain `0.0589`, body regression `0.0231`, score `0.0206`
  - `canvas-edge-denoise 0.65`: improved = 4, regressed = 0, edge gain `0.0640`, body regression `0.0295`, score `0.0094`
  - `canvas-edge-band-denoise 0.50`: improved = 3, regressed = 0, edge gain `0.0586`, body regression `0.0067`, score `0.0590`
  - `canvas-edge-band-denoise 0.65`: improved = 3, regressed = 0, edge gain `0.0627`, body regression `0.0115`, score `0.0523`
  - `canvas-edge-band-denoise 0.80`: improved = 6, regressed = 0, edge gain `0.1602`, body regression `0.0264`, score `0.1462`
  - `canvas-edge-band-denoise 1.00`: improved = 6, regressed = 1, edge gain `0.2033`, body regression `0.2360`, score `-0.4668`
- `band 0.80` 单帧 delta：
  - `4d420881`: active `-0.0227 improved`, edge `-0.0808 improved`, lowBody `-0.1611 improved`, highBody `+0.0012 neutral`
  - `deaee69b`: active `-0.0053 neutral`, edge `-0.0341 improved`, lowBody `+0.0159 neutral`, highBody `+0.0061 neutral`
  - `e1997e6e`: active `-0.0108 neutral`, edge `-0.0453 improved`, lowBody `-0.0402 improved`, highBody `+0.0032 neutral`
- 判断：
  - `canvas-edge-band-denoise 0.80` 是目前单帧实验台上比旧 `canvas-edge-denoise 0.50/0.65` 更有信息量的候选：edge gain 更高，且没有 bucket 级回归。
  - `band 1.00` 仍会在 `deaee69b.lowBody` 回归，说明 body guard 不是无限加强的通行证。
  - 该结论仍是单帧 crop 实验，不等同于整段视频默认可启用；下一步应导出整段视频分叉，并写入 benchmark manifest 做视频级验证。
- 验证：
  - `rtk pnpm exec node --test tests/video/videoCleanupBackends.test.js`
    - 11 tests passed。
  - `rtk pnpm report:video-frame-lab -- --reports .artifacts/video-frame-backend-lab/edge050/latest-report.json,.artifacts/video-frame-backend-lab/latest-report.json,.artifacts/video-frame-backend-lab/band050/latest-report.json,.artifacts/video-frame-backend-lab/band065/latest-report.json,.artifacts/video-frame-backend-lab/band080/latest-report.json,.artifacts/video-frame-backend-lab/band100/latest-report.json --output .artifacts/video-frame-backend-lab/latest-band-sweep-report.md --json .artifacts/video-frame-backend-lab/latest-band-sweep-report.json` 通过。

### 2026-06-11 Edge Band Denoise 视频级复核失败

- 目的：
  - 验证单帧实验台推荐的 `canvas-edge-band-denoise 0.80` 是否能在整段视频重编码后仍优于旧 `canvas-edge-denoise 0.50/0.65`。
  - 追加保守强度 `0.50`，确认是否只是 `0.80` 太强。
- 新增整段导出产物：
  - `.artifacts/video-alpha-research/4d420881-gwr-video-mvp-edgeboost045-cleanup150-canvas-edge-band-denoise080.mp4`
  - `.artifacts/video-alpha-research/deaee69b-gwr-video-mvp-edgeboost045-cleanup150-canvas-edge-band-denoise080.mp4`
  - `.artifacts/video-alpha-research/e1997e6e-gwr-video-mvp-edgeboost045-cleanup150-canvas-edge-band-denoise080.mp4`
  - `.artifacts/video-alpha-research/4d420881-gwr-video-mvp-edgeboost045-cleanup150-canvas-edge-band-denoise050.mp4`
  - `.artifacts/video-alpha-research/deaee69b-gwr-video-mvp-edgeboost045-cleanup150-canvas-edge-band-denoise050.mp4`
  - `.artifacts/video-alpha-research/e1997e6e-gwr-video-mvp-edgeboost045-cleanup150-canvas-edge-band-denoise050.mp4`
- manifest 新增 case：
  - `4d420881-edge-band-denoise080`
  - `deaee69b-edge-band-denoise080`
  - `e1997e6e-edge-band-denoise080`
  - `4d420881-edge-band-denoise050`
  - `deaee69b-edge-band-denoise050`
  - `e1997e6e-edge-band-denoise050`
- 最新全量 benchmark：
  - `rtk pnpm benchmark:video-crops`
  - rendered = 16
  - failed = 0
  - missing.reference = 1（仍为 `095eddb6`）
  - `.artifacts/video-crop-benchmark/latest-summary.json`
  - `.artifacts/video-crop-benchmark/latest-report.md`
- 视频级 delta：
  - `4d420881-edge-band-denoise080`: active `+0.0768 regressed`, edge `+0.0461 regressed`, lowBody `+0.1129 regressed`, highBody `+0.0888 regressed`
  - `4d420881-edge-band-denoise050`: active `+0.0276 regressed`, edge `+0.0235 regressed`, lowBody `-0.1783 improved`, highBody `+0.0304 regressed`
  - `deaee69b-edge-band-denoise080`: active `+0.0250 regressed`, edge `-0.0422 improved`, lowBody `+0.0607 regressed`, highBody `+0.0516 regressed`
  - `deaee69b-edge-band-denoise050`: active `+0.0560 regressed`, edge `-0.0207 improved`, lowBody `+0.0939 regressed`, highBody `+0.0865 regressed`
  - `e1997e6e-edge-band-denoise080`: active `-0.0195 neutral`, edge `-0.1346 improved`, lowBody `+0.4568 regressed`, highBody `+0.0239 regressed`
  - `e1997e6e-edge-band-denoise050`: active `-0.0685 improved`, edge `-0.1282 improved`, lowBody `+0.0024 neutral`, highBody `-0.0450 improved`
- 判断：
  - 单帧 crop 实验对 `band 0.80` 的正向信号没有通过整段视频复核。
  - `band 0.50` 只在 `e1997e6e` 上表现好；在 `4d420881` 和 `deaee69b` 上仍出现 active/body 回归。
  - `canvas-edge-band-denoise` 保留为实验/诊断后端，但不进入默认候选，也不优于旧 `canvas-edge-denoise 0.65` 的视频级证据。
  - 后续必须把“整段视频重编码后的 benchmark”作为是否推进候选的硬门槛；单帧 lab 只作为快速筛选，不作为合格结论。
- 报告脚本更新：
  - `scripts/report-video-crop-benchmark.js` 的 recommendation 现在会识别 edge-band 分叉。
  - 当没有任一 edge-band strength 能跨 benchmark 样例零回归时，报告会明确标记：
    - `Canvas edge-band denoise did not survive video-level validation`
- 当前下一步：
  - 不继续沿 `edge-band` 加强。
  - 若继续 Canvas，应研究为什么整段导出相对单帧 lab 出现 codec-aware 回归。
  - 更有价值的方向仍是 ML/WebGPU/WebNN ROI denoise，或在视频级 benchmark 约束下重新设计 mask。

### 2026-06-11 单帧实验与视频导出差异定位

- 目的：
  - 解释为什么 `canvas-edge-band-denoise 0.80` 在单帧 PNG lab 中表现较好，但整段 MP4 导出后出现 active/body 回归。
- 新增能力：
  - `removeGeminiVideoWatermark()` 支持 `videoBitrate` 选项。
  - `public/video-preview.html` 增加“导出码率 Mbps”输入，留空仍使用 mediabunny `QUALITY_HIGH`。
  - `scripts/export-video-backend-variant.js` 增加 `--video-bitrate <bps>`。
- 诊断产物：
  - `.artifacts/video-frame-vs-export/band080-lab-export-diff.json`
  - `.artifacts/video-frame-vs-export/band080-high-bitrate-diagnostic.json`
  - `.artifacts/video-frame-vs-export/band080-high-bitrate-diagnostic.md`
  - `.artifacts/video-frame-vs-export/4d420881-band080-12mbps.png`
  - `.artifacts/video-frame-vs-export/deaee69b-band080-12mbps.png`
  - `.artifacts/video-frame-vs-export/e1997e6e-band080-12mbps.png`
- 定位结果：
  - `band080` 实验 PNG 与标准导出 MP4 解码帧之间存在明显像素漂移：
    - `4d420881`: avg meanAbs RGB `0.4834`, max `24`
    - `deaee69b`: avg meanAbs RGB `0.8526`, max `24`
    - `e1997e6e`: avg meanAbs RGB `0.9033`, max `24`
  - 标准导出的实际视频码率低于原视频：
    - `4d420881`: 原视频约 `6.36 Mbps`，标准导出约 `5.30 Mbps`
    - `deaee69b`: 原视频约 `7.49 Mbps`，标准导出约 `5.90 Mbps`
    - `e1997e6e`: 原视频约 `8.34 Mbps`，标准导出约 `5.90 Mbps`
  - 这会把单帧 lab 中很小的 residual 改善吞掉，尤其 body bucket。
- 12 Mbps 高码率复核：
  - 新导出：
    - `.artifacts/video-alpha-research/4d420881-gwr-video-mvp-edgeboost045-cleanup150-canvas-edge-band-denoise080-12mbps.mp4`
    - `.artifacts/video-alpha-research/deaee69b-gwr-video-mvp-edgeboost045-cleanup150-canvas-edge-band-denoise080-12mbps.mp4`
    - `.artifacts/video-alpha-research/e1997e6e-gwr-video-mvp-edgeboost045-cleanup150-canvas-edge-band-denoise080-12mbps.mp4`
  - 相对 baseline 的高码率 delta：
    - `4d420881`: active `-0.0344 improved`, edge `+0.0130 neutral`, lowBody `-0.0192 neutral`, highBody `-0.0533 improved`
    - `deaee69b`: active `-0.0781 improved`, edge `-0.0359 improved`, lowBody `+0.4136 regressed`, highBody `-0.0976 improved`
    - `e1997e6e`: active `-0.0514 improved`, edge `-0.0749 improved`, lowBody `-0.0301 improved`, highBody `-0.0421 improved`
- 判断：
  - 视频重编码质量是单帧 lab 与整段导出不一致的主要原因之一。
  - 高码率能显著缓解 `e1997e6e` 的标准导出回归，也改善 `4d420881`。
  - 但 `deaee69b.lowBody` 在 12 Mbps 仍显著回归，说明 `edge-band` mask/处理策略本身仍不稳定。
  - `videoBitrate` 可作为后续视频质量实验和用户可控输出质量参数保留；但 `canvas-edge-band-denoise` 仍不应进入默认。
- 当前下一步：
  - 默认仍保持 `denoiseBackend=none`。
  - 若继续 Canvas 路线，优先研究 `deaee69b` 这类 relocated/gray 样本的 low-body 误伤，而不是继续单纯提高码率或强度。
  - 后续候选必须同时通过：单帧 lab、整段标准码率、整段高码率三层证据。

### 2026-06-11 LowBody 误伤诊断与 band055 候选复核

- 新增诊断脚本：
  - `scripts/diagnose-video-lowbody-regression.js`
  - `package.json`: `diagnose:video-lowbody`
  - 用途：对齐 baseline / variant / reference 的裁剪帧目录，按 alpha bucket 定位 `lowBody` 中 variant 比 baseline 更差的像素，并输出热图 sheet。
- 关键诊断产物：
  - `.artifacts/video-lowbody-regression/deaee69b-band080-12mbps/latest.md`
  - `.artifacts/video-lowbody-regression/deaee69b-band080-12mbps-fair/latest.md`
  - `.artifacts/video-lowbody-regression/deaee69b-band-sweep-12mbps/latest.json`
  - `.artifacts/video-lowbody-regression/band055-standard/latest.json`
  - `.artifacts/video-lowbody-regression/band055-high-12mbps/latest.json`
- 诊断发现：
  - `deaee69b` 的 `lowBody` bucket 只有 `40` 个像素（5 帧，每帧 8 个）。
  - 这些像素全部集中在 alpha 约 `0.09~0.16`、normalized gradient `0` 的稀疏边界/角点。
  - 早先 12 Mbps 复核把 high-bitrate variant 与标准码率 baseline 对比，夸大了 `deaee69b.lowBody` 回归：
    - 混合码率对比：`+0.4136`
    - 公平 12 Mbps baseline 对比：`+0.1698`
  - 因此高码率 benchmark 必须使用同码率 baseline，不能直接拿高码率 variant 对标准码率 baseline 下结论。
- `deaee69b` 公平 12 Mbps edge-band 强度 sweep：
  - `band050`: active `+0.0230 regressed`, edge `+0.0318 regressed`, lowBody `-0.1296 improved`, highBody `+0.0203 regressed`
  - `band055`: active `-0.0418 improved`, edge `-0.0769 improved`, lowBody `-0.0630 improved`, highBody `-0.0276 improved`
  - `band060`: active `-0.0389 improved`, edge `+0.0138 neutral`, lowBody `+0.2126 regressed`, highBody `-0.0613 improved`
  - `band065`: active `-0.0377 improved`, edge `-0.0351 improved`, lowBody `+0.0959 regressed`, highBody `-0.0395 improved`
  - `band080`: active `-0.0677 improved`, edge `-0.0283 improved`, lowBody `+0.1698 regressed`, highBody `-0.0847 improved`
- `band055` 三层复核：
  - 单帧 lab：
    - 三个样本零 bucket 回归。
    - `4d420881.lowBody -0.0998 improved`
    - `e1997e6e.edge -0.0267 improved`
    - `e1997e6e.lowBody -0.0657 improved`
  - 标准码率视频：
    - `4d420881`: active `+0.0207 regressed`, edge `-0.0314 improved`, lowBody `-0.1809 improved`, highBody `+0.0425 regressed`
    - `deaee69b`: active `+0.0685 regressed`, edge `-0.0236 improved`, lowBody `-0.0137 neutral`, highBody `+0.1057 regressed`
    - `e1997e6e`: active `-0.0884 improved`, edge `-0.2040 improved`, lowBody `+0.4479 regressed`, highBody `-0.0451 improved`
  - 公平 12 Mbps 视频：
    - `4d420881`: active `+0.0094 neutral`, edge `-0.0270 improved`, lowBody `-0.1002 improved`, highBody `+0.0246 regressed`
    - `deaee69b`: active `-0.0418 improved`, edge `-0.0769 improved`, lowBody `-0.0630 improved`, highBody `-0.0276 improved`
    - `e1997e6e`: active `+0.0212 regressed`, edge `+0.0103 neutral`, lowBody `+0.2784 regressed`, highBody `+0.0242 regressed`
- 判断：
  - `band055` 是 `deaee69b` 上明显更稳的强度窗口，但没有跨三样本通过标准码率和高码率视频门槛。
  - `canvas-edge-band-denoise` 仍只能保留为实验后端，不应默认。
  - 下一轮应转向“按样本/帧风险动态 gate”或重新定义视频级质量比较方式；继续单一 strength sweep 的边际价值已经很低。

### 2026-06-11 Edge Core 与 Adaptive Alpha 复核

- 目的：
  - 针对 `band055` 在 `e1997e6e.lowBody` 上的视频级回归，验证两个更保守方向：
    - 收紧 denoise mask，只处理真实 alpha 边缘核心；
    - 不做 denoise，改用已有 `adaptiveAlpha` 逐帧 alpha 细化。
- 新增代码：
  - `src/video/videoCleanupBackends.js`
    - 增加实验后端 `canvas-edge-core-denoise`。
    - 该后端复用 `canvas-edge-band-denoise` 的基础权重，但用 raw alpha gradient 做二次 gate，避免模糊权重扩散到 normalized gradient 为 `0` 的 lowBody 稀疏点。
  - `public/video-preview.html`
    - 增加 `Canvas 边缘核心去噪` 调试选项。
  - `scripts/export-video-backend-variant.js`
    - 增加 `--alpha-gain`。
    - 增加 `--adaptive-alpha`。
  - `tests/video/videoCleanupBackends.test.js`
    - 增加 `canvas-edge-core-denoise` 路由测试。
- Edge core 单帧 lab：
  - 产物：
    - `.artifacts/video-frame-backend-lab/edge-core055/latest-report.md`
  - `canvas-edge-core-denoise 0.55`：
    - `4d420881`: active `-0.0045 neutral`, edge `-0.0158 neutral`, lowBody `+0.0001 neutral`, highBody `-0.0000 neutral`
    - `deaee69b`: active `-0.0056 neutral`, edge `-0.0180 neutral`, lowBody `+0.0002 neutral`, highBody `-0.0007 neutral`
    - `e1997e6e`: active `-0.0083 neutral`, edge `-0.0262 improved`, lowBody `+0.0001 neutral`, highBody `-0.0012 neutral`
  - 判断：
    - 单帧层面确实修掉了 lowBody 扩散，但收益明显比 `edge-band` 弱。
- Edge core 视频级复核：
  - 产物：
    - `.artifacts/video-crop-benchmark-edge-core055-standard/latest-report.md`
    - `.artifacts/video-crop-benchmark-edge-core055-12mbps/latest-report.md`
  - 标准码率：
    - `4d420881`: active `+0.0350 regressed`, edge `+0.0478 regressed`, lowBody `-0.0315 improved`, highBody `+0.0303 regressed`
    - `deaee69b`: active `+0.0904 regressed`, edge `+0.0123 neutral`, lowBody `+0.3297 regressed`, highBody `+0.1203 regressed`
    - `e1997e6e`: active `-0.0225 improved`, edge `-0.1173 improved`, lowBody `+0.0711 regressed`, highBody `+0.0148 neutral`
  - 12 Mbps：
    - `4d420881`: active `+0.0216 regressed`, edge `-0.0303 improved`, lowBody `+0.1589 regressed`, highBody `+0.0416 regressed`
    - `deaee69b`: active `-0.0297 improved`, edge `+0.0291 regressed`, lowBody `-0.2424 improved`, highBody `-0.0520 improved`
    - `e1997e6e`: active `+0.0625 regressed`, edge `+0.0694 regressed`, lowBody `+0.2684 regressed`, highBody `+0.0586 regressed`
  - 判断：
    - `edge-core 0.55` 没有通过视频级门槛。
    - 收紧 mask 能修掉单帧 lowBody，但视频编码后收益太小，仍会被 active/body 回归吞掉。
    - 保留为实验/诊断后端，不应默认，也不应作为当前推荐候选。
- Adaptive alpha 视频级复核：
  - 产物：
    - `.artifacts/video-crop-benchmark-adaptive-alpha-standard/latest-report.md`
    - `.artifacts/video-crop-benchmark-adaptive-alpha-12mbps/latest-report.md`
  - 标准码率：
    - `4d420881`: active `+0.7310 regressed`, edge `+0.4460 regressed`, lowBody `-0.0266 improved`, highBody `+0.8488 regressed`
    - `deaee69b`: active `+1.0744 regressed`, edge `+0.4517 regressed`, lowBody `+0.0236 regressed`, highBody `+1.3284 regressed`
    - `e1997e6e`: active `+5.8801 regressed`, edge `+2.2702 regressed`, lowBody `+0.1030 regressed`, highBody `+7.3508 regressed`
  - 12 Mbps：
    - `4d420881`: active `+0.8818 regressed`, edge `+0.4624 regressed`, lowBody `+0.1850 regressed`, highBody `+1.0528 regressed`
    - `deaee69b`: active `+1.1183 regressed`, edge `+0.5072 regressed`, lowBody `-0.1626 improved`, highBody `+1.3688 regressed`
    - `e1997e6e`: active `+6.0299 regressed`, edge `+2.4095 regressed`, lowBody `-0.0603 improved`, highBody `+7.5064 regressed`
  - 判断：
    - 当前 `adaptiveAlpha` 逻辑不适合作为视频默认或推荐开关。
    - 它会显著放大 highBody / active 残差，尤其在 relocated/gray 样本上非常危险。
    - 默认继续保持 `adaptiveAlpha=false`。
- 当前结论：
  - 现有 Canvas cleanup 线已经充分证明：单帧改善不等于视频可用。
  - 视频可用优先级应回到 alpha 模型/模板边缘 profile，而不是继续追加模糊、denoise 或逐帧 alpha 搜索。
  - 下一步更值得做：
    - 用原始帧拟合真实视频水印的边缘 alpha profile / antialiasing，而不是后处理残影；
    - 对 `deaee69b` / `e1997e6e` 做逐像素 alpha profile sweep，找是否存在比现有 `getVideoAlphaMap()` 更贴近视频水印的模板；
  - 若无法找到跨样本稳定 profile，则保持视频默认为当前 MVP：`denoiseBackend=none`、`adaptiveAlpha=false`，只保留 `videoBitrate` 作为用户可控质量参数。

### 2026-06-11 Inset Alpha Edge Policy 复核

- 目的：
  - 继续沿“拟合真实视频水印 alpha/边缘 profile”推进，而不是继续加 denoise。
  - 验证 `veo-1080p-inset`（72px、144px right/bottom margin）是否需要比 standard anchor 更弱的 edge boost。
- 新增能力：
  - `scripts/run-video-alpha-profile-lab.js`
  - `package.json`: `lab:video-alpha-profile`
  - 用途：在原始视频抽帧上替换 alpha profile 后直接执行同路径去水印，并相对 `current-edge045` 的 PNG lab 结果比较 bucket delta。
- Alpha profile lab：
  - 产物：
    - `.artifacts/video-alpha-profile-lab/current-three-cases/latest-report.md`
  - 修正后的比较口径：
    - profile delta 均相对同一 PNG lab 路径的 `current-edge045`。
    - 不再把 PNG 现场重算结果直接对比已重编码的 current MVP 视频。
  - 关键发现：
    - `4d420881`（standard 108px margin）仍最适合当前 `edge045`；降低 edge boost 会让 active/edge/highBody 回退。
    - `deaee69b` 与 `e1997e6e`（inset 144px margin）在 `edge035` 下均出现 profile-level 改善。
    - 这说明不是全局 profile 问题，而是候选簇差异：standard 与 inset 的边缘 alpha profile 不应完全相同。
- 实现的候选策略：
  - `src/video/videoWatermarkDetector.js`
    - 新增 `resolveVideoAlphaEdgeBoost(candidate)`。
    - `veo-1080p-inset` 使用 `0.035`。
    - 其他视频候选继续使用原 `0.045`。
  - `tests/video/videoWatermarkDetector.test.js`
    - 覆盖 standard/inset edge boost 分流。
- `policy035` 视频级复核：
  - 产物：
    - `.artifacts/video-crop-benchmark-alpha-policy035-standard/latest-report.md`
    - `.artifacts/video-crop-benchmark-alpha-policy035-12mbps/latest-report.md`
  - 标准码率：
    - `4d420881`: active/edge/lowBody/highBody 全 `0.0000 neutral`（不受 inset policy 影响）。
    - `deaee69b`: active `-0.2602 improved`, edge `+0.0232 regressed`, lowBody `+0.3058 regressed`, highBody `-0.3763 improved`
    - `e1997e6e`: active `-0.1148 improved`, edge `-0.1512 improved`, lowBody `-0.4337 improved`, highBody `-0.0986 improved`
  - 12 Mbps：
    - `4d420881`: active/edge/lowBody/highBody 全 `0.0000 neutral`
    - `deaee69b`: active `-0.4111 improved`, edge `-0.0587 improved`, lowBody `-0.0411 improved`, highBody `-0.5537 improved`
    - `e1997e6e`: active `-0.0833 improved`, edge `-0.0421 improved`, lowBody `-0.2340 improved`, highBody `-0.0989 improved`
  - 判断：
    - `policy035` 是目前第一条在 12 Mbps 公平视频 benchmark 上跨三样本零回归的候选。
    - 标准码率仍未完全通过，主要卡在 `deaee69b.lowBody`，但 active/highBody 明显改善。
- `policy020` / `policy030` 复核：
  - `policy020`：
    - 标准码率：`deaee69b.lowBody +0.2139 regressed`，`e1997e6e` 全改善。
    - 12 Mbps：`deaee69b.lowBody +0.1726 regressed`，`e1997e6e.edge +0.0279 regressed`。
  - `policy030`：
    - 标准码率：`deaee69b.lowBody +0.1136 regressed`，`e1997e6e.lowBody -0.0191 neutral`，其余改善。
    - 12 Mbps：`deaee69b.lowBody +0.0543 regressed`，`e1997e6e.edge +0.0500 regressed`。
  - 判断：
    - 继续降低 inset edge boost 会改善部分标准码率 lowBody，但会破坏 12 Mbps 的稳定性。
    - 因此当前保留 `0.035`，不采用 `0.020` 或 `0.030`。
- 当前结论：
  - `standard045 + inset035` 是目前最有希望的 alpha profile 候选，明显优于继续叠加 Canvas denoise。
  - 它尚不能宣称完整默认合格，因为标准码率 `deaee69b.lowBody` 仍有 bucket 回归。
  - 下一步应：
    - 肉眼检查 `.artifacts/video-crop-benchmark-alpha-policy035-standard/deaee69b-alpha-policy035.png` 中低体素回归是否可见；
    - 若不可见，考虑把 lowBody 小样本/低可见性回归降级为 warning；
    - 若可见，继续做更局部的 inset alpha edge profile，而不是改 denoise。

### 2026-06-11 Candidate-aware 评估口径与稀疏回归标注

- 问题：
  - 引入 `standard045 + inset035` 后，部分评估脚本仍调用 `getVideoAlphaMap(size)`，没有把 `candidate` 传进去。
  - 这会导致 inset 样本在 residual bucket 分类时仍按默认 `edge045` 模板评估，和生产处理口径不一致。
- 修正：
  - `src/video/videoWatermarkDetector.js`
    - `resolveVideoAlphaEdgeBoost(candidate)` 不再只依赖 catalog id。
    - 当 candidate 的 `marginRight / size` 与 `marginBottom / size` 接近 inset 几何（当前阈值 `>= 1.85`）时，也使用 inset edge boost。
    - 这样 manifest expected candidate（id 为 `expected-anchor`，但 margin 为 `144/72`）与生产 catalog candidate 都能走同一 alpha profile。
  - `scripts/video-crop-benchmark.js`
    - `scoreOriginalFrames()` 和 `calculateFrameDirResidualMetrics()` 改为 `getVideoAlphaMap(size, { candidate })`。
  - `scripts/run-video-frame-backend-lab.js`
    - 单帧 backend lab 改为 candidate-aware alpha map。
  - `scripts/run-video-alpha-profile-lab.js`
    - `current` profile 与 residual 评估改为使用 manifest expected candidate。
    - 避免 `renderVideoCropSheet()` 的默认 primary candidate（catalog 第一个）误用于 inset case。
- 新增 benchmark notes：
  - `scripts/video-crop-benchmark.js`
    - `summarizeVideoBenchmarkVariants()` 现在会输出 `riskNotes`。
    - `sparse-low-body-regression`：
      - lowBody 回归；
      - lowBody 像素数很少（当前阈值 `<=64` 且占 active `<=0.6%`）；
      - active 与 highBody 同时改善。
    - `marginal-edge-regression`：
      - edge 回归接近 neutral 阈值；
      - active 同时改善。
  - `scripts/report-video-crop-benchmark.js`
    - Variant Deltas 表新增 `Notes` 列。
  - 注意：
    - notes 不会改变 `verdict`；它只为“是否可用”提供上下文。
- expected-aware `policy035` 复核：
  - 产物：
    - `.artifacts/video-crop-benchmark-alpha-policy035-standard-expected-aware/latest-report.md`
    - `.artifacts/video-crop-benchmark-alpha-policy035-12mbps-expected-aware/latest-report.md`
  - 标准码率：
    - `4d420881`: 全 bucket `0.0000 neutral`
    - `deaee69b`: active `-0.2637 improved`, edge `+0.0168 neutral`, lowBody `+0.3094 regressed`, highBody `-0.3799 improved`
      - notes: `sparse-low-body-regression`
      - lowBody 只有 `40 / 10335` active pixels，约 `0.39%`
    - `e1997e6e`: active `-0.1121 improved`, edge `-0.1554 improved`, lowBody `-0.4365 improved`, highBody `-0.0929 improved`
  - 12 Mbps：
    - `4d420881`: 全 bucket `0.0000 neutral`
    - `deaee69b`: active `-0.4138 improved`, edge `-0.0649 improved`, lowBody `-0.0431 improved`, highBody `-0.5566 improved`
    - `e1997e6e`: active `-0.0812 improved`, edge `-0.0472 improved`, lowBody `-0.2335 improved`, highBody `-0.0941 improved`
- 当前判断：
  - `policy035` 仍是目前最佳候选。
  - 严格 bucket gate 下，标准码率仍不是“零回归通过”。
  - expected-aware 口径下，标准码率唯一失败点是 `deaee69b.lowBody` 的稀疏低体素 warning；edge 已回到 neutral。
  - 从 sheet 看没有大面积明显残影，下一步适合做人工可见性确认，而不是继续盲目 sweep。

### 2026-06-11 `deaee69b.lowBody` 可见性确认

- 目的：
  - 针对 expected-aware `policy035` 的唯一 strict regression 做人工可见性确认。
  - 避免因为 lowBody 小样本 bucket 的数值回归，误杀整体更可用的 alpha profile。
- 诊断输入：
  - 标准码率 benchmark 实际 crop：
    - `1676,836,200,200`
  - 诊断命令输出：
    - `.artifacts/video-lowbody-regression/deaee69b-alpha-policy035-standard-expected-aware-benchmark-crop/latest.md`
    - `.artifacts/video-lowbody-regression/deaee69b-alpha-policy035-standard-expected-aware-benchmark-crop/lowbody-delta-sheet.png`
- 诊断结果：
  - Aggregate：
    - lowBody count: `40`
    - baseline meanAbs: `4.1219`
    - variant meanAbs: `4.4313`
    - delta meanAbs: `+0.3094`
  - 这些 lowBody 像素全部落在 very-low-gradient 区间：
    - gradient `0.00-0.04`: count `40`
  - heatmap 观察：
    - delta sheet 里主要是零星红/青点。
    - 没有连续的星形边缘、大片残影或稳定块状伪影。
    - baseline / variant / reference 的视觉差异很小。
- 更新判断：
  - `deaee69b.lowBody` 应标注为 `sparse-low-body-regression` warning，而不是默认候选 blocker。
  - `policy035` 可以进入“可用候选”状态：
    - 标准码率：唯一 strict regression 是低可见、低占比 lowBody warning；active/highBody 明显改善，edge neutral。
    - 12 Mbps：三样本全 bucket 无 strict regression，且 inset 样本整体改善。
  - 仍不建议继续沿 Canvas denoise / 模糊方向追求完美反解；当前更稳的产品化路径是：
    - 采用 candidate-aware `standard045 + inset035` alpha profile；
    - 保留 `sparse-low-body-regression` 报告标注；
    - 给人工验收优先看 `lowbody-delta-sheet.png` 与 12 Mbps 对比视频。

### 2026-06-11 默认导出候选与验收视频

- 默认路径收口：
  - `scripts/export-video-backend-variant.js`
    - 默认 `denoiseBackend` 从旧实验值 `canvas-edge-denoise` 改为 `none`。
    - 命令行导出默认即走当前 MVP 主路径：candidate-aware `standard045 + inset035` alpha profile、`adaptiveAlpha=false`、不叠加 Canvas denoise。
  - 页面默认本来已来自 `DEFAULT_DENOISE_BACKEND=none`，保持一致。
- 新导出验收视频：
  - `.artifacts/video-policy035-default-review/deaee69b-policy035-default-12mbps.mp4`
  - `.artifacts/video-policy035-default-review/e1997e6e-policy035-default-12mbps.mp4`
  - 两个文件均已用 `ffprobe` 验证：
    - `1920x1080`
    - `10s`
    - `24fps`
    - `240` frames
  - 导出状态：
    - `denoiseBackend=none`
    - `adaptiveAlpha=false`
    - `videoBitrate=12000000`
- 三列验收对比视频：
  - `.artifacts/video-policy035-default-review/deaee69b-original-policy035-allenk-compare.mp4`
  - `.artifacts/video-policy035-default-review/e1997e6e-original-policy035-allenk-compare.mp4`
  - 列顺序：
    - `original`
    - `policy035 default`
    - `allenk v0.6.2`
  - 两个对比文件均已用 `ffprobe` 验证：
    - `1920x360`
    - `10s`
    - `24fps`
    - `240` frames
- 验证：
  - `rtk pnpm exec node --test tests/scripts/videoCropBenchmark.test.js tests/scripts/videoCropBenchmarkReport.test.js tests/video/videoWatermarkDetector.test.js tests/video/videoCleanupBackends.test.js tests/scripts/scriptEntrypoints.test.js`
    - `39` tests passed
  - `rtk pnpm build`
    - passed

### 2026-06-11 用户截图瑕疵复核

- 用户反馈：
  - `policy035 default` 仍有轻微局部瑕疵。
  - 截图显示两类问题：
    - `deaee69b` 约 `3.0s`，车灯/蓝色车漆区域仍有淡菱形残影。
    - `e1997e6e` 约 `4.0s`，深色斜条纹理区域仍有轻微残影/纹理扰动。
- 定位方式：
  - 对用户截图做模板匹配，反查到三列对比视频中的中间列 `policy035 default`。
  - 诊断产物：
    - `.artifacts/video-policy035-default-review/user-flaw-diagnostics/deaee69b-headlight-user-crop.png`
    - `.artifacts/video-policy035-default-review/user-flaw-diagnostics/e1997e6e-rail-user-crop.png`
    - `.artifacts/video-policy035-default-review/user-flaw-diagnostics/latest.json`
- 确认结果：
  - 这两处瑕疵都位于或覆盖水印 alpha ROI，不是纯播放器缩放错觉。
  - `deaee69b` 的残影更明显，属于淡菱形欠消除。
  - `e1997e6e` 更接近低可见度纹理扰动。
- 已测试但不采纳的方向：
  - 显式 `alphaGain=1.05`：
    - 产物：
      - `.artifacts/video-policy035-default-review/deaee69b-policy035-alpha105-12mbps.mp4`
      - `.artifacts/video-policy035-default-review/e1997e6e-policy035-alpha105-12mbps.mp4`
    - 诊断：
      - `.artifacts/video-policy035-default-review/user-flaw-diagnostics/deaee69b-alpha105-comparison.png`
      - `.artifacts/video-policy035-default-review/user-flaw-diagnostics/e1997e6e-alpha105-comparison.png`
    - 结果：没有明显压下残影，局部 meanAbs 还略升。
  - `canvas-texture-repair`：
    - 产物：
      - `.artifacts/video-policy035-default-review/deaee69b-policy035-texture-repair-12mbps.mp4`
      - `.artifacts/video-policy035-default-review/e1997e6e-policy035-texture-repair-12mbps.mp4`
    - 诊断：
      - `.artifacts/video-policy035-default-review/user-flaw-diagnostics/deaee69b-texture-repair-comparison.png`
      - `.artifacts/video-policy035-default-review/user-flaw-diagnostics/e1997e6e-texture-repair-comparison.png`
    - 结果：基本持平，视觉改善不足。
  - 旧 `edge045` 对比：
    - 诊断：
      - `.artifacts/video-policy035-default-review/user-flaw-diagnostics/deaee69b-edge045-vs-policy035.png`
      - `.artifacts/video-policy035-default-review/user-flaw-diagnostics/e1997e6e-edge045-vs-policy035.png`
    - 结果：`deaee69b` 明显不如 `policy035`，`e1997e6e` 略有不同但不能作为全局回退。
- 新增实验后端：
  - `canvas-footprint-polish`
  - 目的：只在 alpha 足迹内做轻量补面，测试能否比边缘/纹理后处理更针对淡菱形主体残影。
  - 产物：
    - `.artifacts/video-policy035-default-review/deaee69b-policy035-footprint-polish-12mbps.mp4`
    - `.artifacts/video-policy035-default-review/e1997e6e-policy035-footprint-polish-12mbps.mp4`
    - `.artifacts/video-policy035-default-review/deaee69b-policy035-footprint-polish100-12mbps.mp4`
    - `.artifacts/video-policy035-default-review/e1997e6e-policy035-footprint-polish100-12mbps.mp4`
  - 诊断：
    - `.artifacts/video-policy035-default-review/user-flaw-diagnostics/deaee69b-footprint-polish-comparison.png`
    - `.artifacts/video-policy035-default-review/user-flaw-diagnostics/e1997e6e-footprint-polish-comparison.png`
    - `.artifacts/video-policy035-default-review/user-flaw-diagnostics/deaee69b-footprint-polish100-comparison.png`
    - `.artifacts/video-policy035-default-review/user-flaw-diagnostics/e1997e6e-footprint-polish100-comparison.png`
  - 结果：
    - 默认强度与 `1.0` 强度都几乎打平。
    - 没有形成足够明显的视觉收益。
    - 保留为实验后端，不推荐默认启用。
- 更新判断：
  - 当前轻微瑕疵更像 alpha map 形状/局部 alpha profile 不匹配，而不是简单 alpha gain 或后处理问题。
  - 不应继续盲目加模糊、加 denoise 或加 footprint polish 强度。
  - 下一步更值得做：
    - 用 `original` 与 `allenk` 或当前最佳输出估计局部 residual alpha 形状；
    - 在 `deaee69b` 车灯/蓝车漆与 `e1997e6e` 深色斜条两个位置做 alpha shape fitting；
    - 目标是改模板，而不是抹掉输出。

### 2026-06-11 局部 Alpha Shape Fitting

- 新增脚本：
  - `scripts/fit-video-alpha-shape.js`
  - `package.json`: `fit:video-alpha-shape`
  - 目的：
    - 针对用户截图定位到的瑕疵帧/区域做局部 alpha shape sweep。
    - 从 `original` 与 `reference` 估计观测 alpha。
    - sweep 参数：
      - `edgeBoost`
      - 形状缩放 `shape scale`
      - 子像素偏移 `dx/dy`
      - `bodyScale`
      - `lowScale`
  - 输出：
    - `.artifacts/video-alpha-shape-fit/user-flaw-crops/latest-summary.json`
    - 每个 case 的 `best-fit-sheet.png`
- 初轮 fitting 结果：
  - `deaee69b-headlight`
    - current active meanAbs: `11.2709`
    - best: `edge0045-shape1.000-dx0-dy0-body1-low0.92`
    - best active meanAbs: `11.1178`
    - delta: `-0.1531`
    - 判断：有数值改善，但肉眼收益很弱。
  - `e1997e6e-rail`
    - current active meanAbs: `9.8537`
    - best: `edge0025-shape1.015-dx0-dy0-body1.06-low0.92`
    - best active meanAbs: `8.5885`
    - delta: `-1.2652`
    - 判断：局部拟合信号更强，但参数与 `deaee69b` 不一致。
- 共同趋势：
  - 两个局部 best 都包含 `lowScale=0.92`。
  - 因此新增实验导出参数：
    - `--alpha-low-scale <n>`
  - 该参数通过预览页隐藏实验入口 `window.__gwrVideoAlphaLowScale` 传入，不暴露给普通 UI。
  - 默认仍为 `1`，不影响当前 `policy035 default`。
- `low092` 视频导出：
  - `.artifacts/video-alpha-shape-fit/user-flaw-crops/4d420881-policy035-low092-12mbps.mp4`
  - `.artifacts/video-alpha-shape-fit/user-flaw-crops/deaee69b-policy035-low092-12mbps.mp4`
  - `.artifacts/video-alpha-shape-fit/user-flaw-crops/e1997e6e-policy035-low092-12mbps.mp4`
  - 局部可视化：
    - `.artifacts/video-alpha-shape-fit/user-flaw-crops/visual-compare/deaee69b-low092.png`
    - `.artifacts/video-alpha-shape-fit/user-flaw-crops/visual-compare/e1997e6e-low092.png`
- `low092` 视频级 benchmark：
  - manifest:
    - `.artifacts/video-alpha-shape-fit/user-flaw-crops/low092-benchmark-manifest.json`
  - report:
    - `.artifacts/video-alpha-shape-fit/user-flaw-crops/low092-benchmark/latest-report.md`
  - 结果：
    - `4d420881-low092-12mbps`
      - active `+0.0323 regressed`
      - edge `+0.2018 regressed`
      - lowBody `-0.0216 improved`
      - highBody `-0.0351 improved`
    - `deaee69b-low092-12mbps`
      - active `+0.0566 regressed`
      - edge `+0.0646 regressed`
      - lowBody `+0.2950 regressed`
      - highBody `+0.0520 regressed`
    - `e1997e6e-low092-12mbps`
      - active `+0.0684 regressed`
      - edge `+0.0751 regressed`
      - lowBody `+0.0545 regressed`
      - highBody `+0.0657 regressed`
- 更新判断：
  - `lowScale=0.92` 是局部拟合诱饵：对用户截图位置有微弱局部收益，但视频级明显不安全。
  - 不采纳为默认。
  - 下一步应避免全局 low-alpha dampening，改为更细的 alpha shape fitting：
    - 先聚类残影位置；
    - 再寻找只影响特定 alpha/gradient/局部象限的 shape 修正；
    - 每个候选必须先过视频级 benchmark，而不是只看单帧局部。

### 2026-06-11 局部象限 Shape 候选复核

- 扩展 fitting：
  - `scripts/fit-video-alpha-shape.js`
    - 保存完整候选结果：
      - `all-results.json`
    - 输出 `segmentStats`：
      - alpha band
      - gradient band
      - quadrant
      - 组合段
    - 新增局部候选：
      - `top` / `bottom` / `left` / `right`
      - `top-left` / `top-right` / `bottom-left` / `bottom-right`
      - 局部 `lowScale`
      - 局部 `bodyScale`
- 段统计发现：
  - 两个瑕疵点都有类似趋势：
    - `mid/low alpha` 多数为负 delta，说明模板局部偏强；
    - `high alpha edge` 多数为正 delta，说明主体/边缘又偏弱；
  - 这解释了为什么简单 `low092` 会局部略好，但视频级回归：它只动低 alpha，没有同时处理主体/边缘平衡。
- 完整候选 joint search：
  - `edge0045-shape1.000-dx0-dy0-body1-low0.92`
    - 两个用户瑕疵点均局部改善；
    - 但前一轮 `low092` 视频级已失败，不采纳。
  - `local-top-right-edge0045-body1.06`
    - fitting 上两个瑕疵点均局部改善；
    - 是最值得真实视频验证的局部象限候选。
- 新增隐藏实验参数：
  - `--alpha-edge-boost`
  - `--alpha-body-scale`
  - `--alpha-low-scale`
  - `--alpha-local-region`
  - `--alpha-local-low-scale`
  - `--alpha-local-body-scale`
  - 这些只用于实验导出，不暴露普通 UI，不改变默认。
- `local-top-right-body106` 视频导出：
  - `.artifacts/video-alpha-shape-fit/local-top-right-body106/4d420881.mp4`
  - `.artifacts/video-alpha-shape-fit/local-top-right-body106/deaee69b.mp4`
  - `.artifacts/video-alpha-shape-fit/local-top-right-body106/e1997e6e.mp4`
- 视频级 benchmark：
  - report:
    - `.artifacts/video-alpha-shape-fit/local-top-right-body106/benchmark/latest-report.md`
  - 结果：
    - `4d420881-local-12mbps`
      - active `+0.3682 regressed`
      - edge `+0.2849 regressed`
      - lowBody `-0.0370 improved`
      - highBody `+0.4035 regressed`
    - `deaee69b-local-12mbps`
      - active `+0.5248 regressed`
      - edge `+0.1000 regressed`
      - lowBody `+0.2054 regressed`
      - highBody `+0.6980 regressed`
    - `e1997e6e-local-12mbps`
      - active `+0.4008 regressed`
      - edge `+0.0456 regressed`
      - lowBody `+0.2308 regressed`
      - highBody `+0.5450 regressed`
- 更新判断：
  - 单帧局部 alpha fitting 很容易过拟合 `allenk/reference` 或该帧背景。
  - 局部象限手工缩放在真实视频上不安全。
  - 当前默认仍应保持 `policy035 default`。
  - 下一步如果继续质量优化，应转向“多帧一致性拟合”：
    - 同一个 candidate 参数必须在多个 timestamp 上同时降低残影；
    - 用 video benchmark bucket 做内环评分；
    - 不再让单帧局部 best 直接进入视频导出验证。

### 2026-06-11 Alpha Shape Candidate Gate

- 新增候选晋级脚本：
  - `scripts/gate-video-alpha-shape-candidates.js`
  - package script:
    - `pnpm gate:video-alpha-shape`
- 目的：
  - 读取 `fit-video-alpha-shape` 的完整候选结果；
  - 可选绑定一个真实视频 benchmark summary；
  - 防止“单帧局部拟合好看”直接被误认为可升默认。
- 当前 gate 规则：
  - 候选必须在共同 fitting case 上达到一致局部收益，才算 `fit-pass`；
  - 只有绑定到具体候选名的 benchmark 会作为该候选的视频 gate；
  - 未做视频验证的候选标为 `no-video-benchmark`，不能算晋级；
  - 任一视频 benchmark bucket 出现 material regression，则候选为 `rejected-video-regression`。
- 对 `local-top-right-body106` 的真实 gate：
  - command:
    - `pnpm gate:video-alpha-shape -- --fit-summary .artifacts/video-alpha-shape-fit/user-flaw-crops/latest-summary.json --benchmark-summary .artifacts/video-alpha-shape-fit/local-top-right-body106/benchmark/latest-summary.json --candidate local-top-right-edge0045-body1.06 --output-dir .artifacts/video-alpha-shape-candidate-gate/local-top-right-body106 --top 12`
  - 输出：
    - `.artifacts/video-alpha-shape-candidate-gate/local-top-right-body106/latest-report.json`
    - `.artifacts/video-alpha-shape-candidate-gate/local-top-right-body106/latest-report.md`
  - 结论：
    - `local-top-right-edge0045-body1.06`
      - fitting: `fit-pass`
      - mean delta: `-0.2075`
      - video gate: `rejected-video-regression`
      - video regressions: `11`
- 更新判断：
  - 这条工具链已经能把“局部拟合候选”和“视频级可用候选”分开。
  - 当前没有任何已验证 alpha-shape 候选能替代 `policy035 default`。
  - 后续再试候选时，应固定流程：
    - shape fitting 只负责产出候选；
    - 导出少量真实视频；
    - 跑 video crop benchmark；
    - 用 candidate gate 生成晋级/拒绝记录；
    - 只有 gate 通过后再做人工视觉复核。

### 2026-06-11 多帧一致性 Shape Gate

- 背景：
  - 用户反馈 `policy035 default` 仍有轻微局部瑕疵。
  - 单帧 fitting 已证明容易过拟合，因此本轮把同一候选扩展到多个 timestamp 上复核。
- 脚本更新：
  - `scripts/fit-video-alpha-shape.js`
    - 新增 `--preset user-flaw-multiframe`。
    - 保留默认 `user-flaw` 两帧行为。
    - 新 preset 覆盖 6 个局部 fitting case：
      - `deaee69b-headlight`: `2s / 3s / 4s`
      - `e1997e6e-rail`: `3s / 4s / 5s`
- 多帧 fitting 产物：
  - `.artifacts/video-alpha-shape-fit/user-flaw-multiframe/latest-summary.json`
  - `.artifacts/video-alpha-shape-candidate-gate/user-flaw-multiframe/latest-report.md`
- 多帧 fitting 结果：
  - `edge0045-shape1.000-dx0-dy0-body1-low0.92`
    - fit: `fit-pass`
    - mean delta: `-0.1931`
    - max regression: `-0.0702`
    - improved/regressed: `6/0`
  - `local-right-edge0045-low0.92`
    - fit: `fit-pass`
    - mean delta: `-0.1632`
    - max regression: `-0.0307`
    - improved/regressed: `6/0`
  - `local-bottom-edge0045-low0.92`
    - fit: `fit-pass`
    - mean delta: `-0.1610`
    - max regression: `-0.0299`
    - improved/regressed: `6/0`
- 绑定既有 `low092` 视频级 benchmark：
  - 输出：
    - `.artifacts/video-alpha-shape-candidate-gate/user-flaw-multiframe-low092-video/latest-report.md`
  - 结论：
    - `edge0045-shape1.000-dx0-dy0-body1-low0.92`
      - fitting: `fit-pass`
      - video gate: `rejected-video-regression`
      - video regressions: `10`
  - 判断：
    - 多帧局部一致改善仍不能替代整段视频 gate。
    - 全局 `low0.92` 继续保持拒绝。
- 新验证候选 `local-right-edge0045-low0.92`：
  - 导出视频：
    - `.artifacts/video-alpha-shape-fit/local-right-low092/4d420881.mp4`
    - `.artifacts/video-alpha-shape-fit/local-right-low092/deaee69b.mp4`
    - `.artifacts/video-alpha-shape-fit/local-right-low092/e1997e6e.mp4`
  - benchmark:
    - `.artifacts/video-alpha-shape-fit/local-right-low092/benchmark/latest-report.md`
    - `.artifacts/video-alpha-shape-fit/local-right-low092/benchmark/latest-summary.json`
  - gate:
    - `.artifacts/video-alpha-shape-candidate-gate/local-right-low092/latest-report.md`
  - 视频级结果：
    - `4d420881-local-right-low092-12mbps`
      - active `-0.1072 improved`
      - edge `+0.0474 regressed`
      - lowBody `-0.1311 improved`
      - highBody `-0.1687 improved`
    - `deaee69b-local-right-low092-12mbps`
      - active `+0.3947 regressed`
      - edge `+0.0914 regressed`
      - lowBody `+0.0155 neutral`
      - highBody `+0.5191 regressed`
    - `e1997e6e-local-right-low092-12mbps`
      - active `+0.1037 regressed`
      - edge `+0.1406 regressed`
      - lowBody `+0.0541 regressed`
      - highBody `+0.0891 regressed`
  - gate 结论：
    - `local-right-edge0045-low0.92`
      - fitting: `fit-pass`
      - video gate: `rejected-video-regression`
      - video regressions: `8`
- 验证：
  - `pnpm fit:video-alpha-shape -- --help`
  - `pnpm exec node --test tests/scripts/videoAlphaShapeCandidateGate.test.js tests/scripts/scriptEntrypoints.test.js`
    - `5` tests passed
- 更新判断：
  - 新的多帧 preset 有价值：它比单帧 fitting 更能筛掉偶然候选，也能更清楚地暴露“局部可改善但视频级不可用”的分叉。
  - `local-right-low092` 不应进入默认，也不建议继续沿 `low0.92` 局部缩放做小修小补。
  - 当前默认仍保持 `policy035 default`。
  - 下一步更值得做：
    - 把 video benchmark 的 bucket delta 纳入候选搜索内环，而不是 fitting 后再离线拒绝；
    - 或转向非 alpha shape 的局部时序一致性/轻量 ML denoise，因为仅靠 low-alpha 缩放已经连续失败。

### 2026-06-11 `low0.92` 家族统一拒绝报告

- 继续验证候选：
  - `local-bottom-edge0045-low0.92`
    - 多帧 fitting: `fit-pass`
    - mean delta: `-0.1610`
    - max regression: `-0.0299`
    - improved/regressed: `6/0`
- 导出视频：
  - `.artifacts/video-alpha-shape-fit/local-bottom-low092/4d420881.mp4`
  - `.artifacts/video-alpha-shape-fit/local-bottom-low092/deaee69b.mp4`
  - `.artifacts/video-alpha-shape-fit/local-bottom-low092/e1997e6e.mp4`
- benchmark:
  - `.artifacts/video-alpha-shape-fit/local-bottom-low092/benchmark/latest-report.md`
  - `.artifacts/video-alpha-shape-fit/local-bottom-low092/benchmark/latest-summary.json`
- 视频级结果：
  - `4d420881-local-bottom-low092-12mbps`
    - active `-0.0035 neutral`
    - edge `-0.0451 improved`
    - lowBody `+0.0656 regressed`
    - highBody `+0.0127 neutral`
  - `deaee69b-local-bottom-low092-12mbps`
    - active `+0.3690 regressed`
    - edge `+0.0371 regressed`
    - lowBody `-0.1185 improved`
    - highBody `+0.5056 regressed`
  - `e1997e6e-local-bottom-low092-12mbps`
    - active `+0.0826 regressed`
    - edge `+0.0220 regressed`
    - lowBody `-0.1058 improved`
    - highBody `+0.1080 regressed`
- gate:
  - `.artifacts/video-alpha-shape-candidate-gate/local-bottom-low092/latest-report.md`
  - 结论：
    - `local-bottom-edge0045-low0.92`
      - fitting: `fit-pass`
      - video gate: `rejected-video-regression`
      - video regressions: `7`
- gate 工具增强：
  - `scripts/gate-video-alpha-shape-candidates.js`
    - 新增 repeatable 参数：
      - `--candidate-benchmark <candidate>=<summary.json>`
    - 用途：
      - 在同一份 gate report 里绑定多个候选的真实视频 benchmark。
      - 显式绑定过视频证据的候选会固定显示在报告顶部，即使是 rejected。
    - 旧参数 `--benchmark-summary + --candidate` 保持兼容。
  - 新增测试覆盖：
    - 多个候选分别绑定不同 benchmark；
    - checked / rejected / unchecked 候选在同一 report 内区分展示。
- `low0.92` 家族统一报告：
  - `.artifacts/video-alpha-shape-candidate-gate/low092-family/latest-report.md`
  - 绑定候选：
    - `edge0045-shape1.000-dx0-dy0-body1-low0.92`
      - video gate: `rejected-video-regression`
      - video regressions: `10`
    - `local-right-edge0045-low0.92`
      - video gate: `rejected-video-regression`
      - video regressions: `8`
    - `local-bottom-edge0045-low0.92`
      - video gate: `rejected-video-regression`
      - video regressions: `7`
- 验证：
  - `pnpm exec node --test tests/scripts/videoAlphaShapeCandidateGate.test.js tests/scripts/scriptEntrypoints.test.js`
    - `6` tests passed
- 更新判断：
  - `low0.92` 相关的全局、右半区、下半区三条强候选都被视频级 gate 拒绝。
  - 后续不建议继续沿 `low0.92` 家族做局部象限微调。
  - alpha shape fitting 仍可作为诊断工具，但候选晋级必须依赖视频级 bucket gate。
  - 下一步优先级：
    - 把视频级 benchmark 反馈更前置到候选筛选；
    - 或转向时序一致性修复 / 轻量 ML denoise，而不是继续低 alpha 缩放。

### 2026-06-11 非 `low0.92` 局部 Body Scale 候选复核

- 目的：
  - 避免因为 `low0.92` 家族连续失败，就过早否定所有 alpha shape 方向。
  - 选取一个不缩放 low alpha、只局部增强 body alpha 的候选做真实视频验证。
- 候选：
  - `local-top-right-edge0025-body1.06`
  - 多帧 fitting:
    - verdict: `fit-warning`
    - mean delta: `-0.0543`
    - max regression: `+0.0117`
    - improved/regressed: `2/0`
  - 参数：
    - `alphaEdgeBoost=0.025`
    - `alphaLocalRegion=top-right`
    - `alphaLocalBodyScale=1.06`
    - 不使用 `alphaLowScale`
- 导出视频：
  - `.artifacts/video-alpha-shape-fit/local-top-right-edge0025-body106/4d420881.mp4`
  - `.artifacts/video-alpha-shape-fit/local-top-right-edge0025-body106/deaee69b.mp4`
  - `.artifacts/video-alpha-shape-fit/local-top-right-edge0025-body106/e1997e6e.mp4`
- benchmark:
  - `.artifacts/video-alpha-shape-fit/local-top-right-edge0025-body106/benchmark/latest-report.md`
  - `.artifacts/video-alpha-shape-fit/local-top-right-edge0025-body106/benchmark/latest-summary.json`
- 视频级结果：
  - `4d420881-local-top-right-edge0025-body106-12mbps`
    - active `+0.7110 regressed`
    - edge `+0.3378 regressed`
    - lowBody `+0.1044 regressed`
    - highBody `+0.8631 regressed`
  - `deaee69b-local-top-right-edge0025-body106-12mbps`
    - active `+0.0887 regressed`
    - edge `+0.0688 regressed`
    - lowBody `+0.0317 regressed`
    - highBody `+0.0970 regressed`
  - `e1997e6e-local-top-right-edge0025-body106-12mbps`
    - active `+0.3650 regressed`
    - edge `+0.0342 regressed`
    - lowBody `-0.0150 neutral`
    - highBody `+0.5006 regressed`
- gate:
  - `.artifacts/video-alpha-shape-candidate-gate/local-top-right-edge0025-body106/latest-report.md`
  - 结论：
    - fitting: `fit-warning`
    - video gate: `rejected-video-regression`
    - video regressions: `11`
- 统一人工 shape 验证报告：
  - `.artifacts/video-alpha-shape-candidate-gate/manual-shape-validated/latest-report.md`
  - 已绑定并拒绝：
    - `edge0045-shape1.000-dx0-dy0-body1-low0.92`: `10` regressions
    - `local-right-edge0045-low0.92`: `8` regressions
    - `local-bottom-edge0045-low0.92`: `7` regressions
    - `local-top-right-edge0025-body1.06`: `11` regressions
- 更新判断：
  - 不只是 `low0.92` 家族失败；局部 body-scale 手调同样没有通过视频级验证。
  - 当前 alpha shape 手工参数方向应降级为诊断工具，不再作为下一轮主要改进路径。
  - 默认继续保持 `policy035 default`。
  - 下一步应转向：
    - 以视频级 bucket 为内环的自动候选筛选；
    - 或局部时序一致性 / 轻量 ML denoise，用 mask 限定到 residual 区域，而不是继续改 alpha map。

### 2026-06-11 `canvas-temporal-stabilize` 时序稳定实验

- 背景：
  - 手工 alpha shape 候选连续被视频级 gate 拒绝。
  - 本轮转向时序一致性方向，测试是否能降低相邻帧 residual 闪烁，而不是继续改 alpha map。
- 实现：
  - `src/video/videoCleanupBackends.js`
    - 新增 denoise backend:
      - `canvas-temporal-stabilize`
  - `src/video/videoExport.js`
    - 在逐帧导出循环中维护 `previousTemporalRoi`。
    - 仅当后端为 `canvas-temporal-stabilize` 时启用。
    - 在 alpha ROI 内，对相邻帧亮度变化很小的像素做小权重时序混合。
    - 运动/亮度变化明显时自动降权，避免直接拖影。
  - `public/video-preview.html`
    - 后端去噪下拉框新增 `Canvas 时序稳定`。
  - `scripts/export-video-backend-variant.js`
    - help 文案新增 `canvas-temporal-stabilize`。
  - 默认仍为 `denoiseBackend=none`，不影响主路径。
- `temporal065` 导出：
  - `.artifacts/video-temporal-stabilize/temporal065/4d420881.mp4`
  - `.artifacts/video-temporal-stabilize/temporal065/deaee69b.mp4`
  - `.artifacts/video-temporal-stabilize/temporal065/e1997e6e.mp4`
- `temporal065` benchmark:
  - `.artifacts/video-temporal-stabilize/temporal065/benchmark/latest-report.md`
  - 结果：
    - `4d420881-temporal065-12mbps`
      - active `-0.0081 neutral`
      - edge `-0.0160 neutral`
      - lowBody `+0.0033 neutral`
      - highBody `-0.0050 neutral`
    - `deaee69b-temporal065-12mbps`
      - active `+0.0109 neutral`
      - edge `+0.0319 regressed`
      - lowBody `+0.5167 regressed`
      - highBody `-0.0004 neutral`
    - `e1997e6e-temporal065-12mbps`
      - active `+0.1079 regressed`
      - edge `+0.1075 regressed`
      - lowBody `+0.0943 regressed`
      - highBody `+0.1082 regressed`
- `temporal025` 导出：
  - `.artifacts/video-temporal-stabilize/temporal025/4d420881.mp4`
  - `.artifacts/video-temporal-stabilize/temporal025/deaee69b.mp4`
  - `.artifacts/video-temporal-stabilize/temporal025/e1997e6e.mp4`
- `temporal025` benchmark:
  - `.artifacts/video-temporal-stabilize/temporal025/benchmark/latest-report.md`
  - 结果：
    - `4d420881-temporal025-12mbps`
      - active `-0.0071 neutral`
      - edge `-0.0286 improved`
      - lowBody `+0.0638 regressed`
      - highBody `+0.0011 neutral`
    - `deaee69b-temporal025-12mbps`
      - active `+0.0580 regressed`
      - edge `+0.0181 neutral`
      - lowBody `-0.0830 improved`
      - highBody `+0.0749 regressed`
    - `e1997e6e-temporal025-12mbps`
      - active `+0.0825 regressed`
      - edge `+0.0373 regressed`
      - lowBody `-0.2803 improved`
      - highBody `+0.1027 regressed`
- 验证：
  - `pnpm exec node --test tests/video/videoCleanupBackends.test.js tests/scripts/scriptEntrypoints.test.js`
    - `15` tests passed
  - `pnpm build`
    - passed

### 2026-06-12 allenk 源码对齐：纯梯度 mask 与默认 AI 参数

- 触发原因：
  - 用户反馈“纹理重建效果还是不好”，并建议直接多看 allenk 源码；
  - 之前的 highpass 回灌 / clean-neighbor 纹理借用只能微调纹理，不能解释与 allenk 的根本差距。
- allenk 源码结论：
  - 核心文件：
    - `.artifacts/external-repos/GeminiWatermarkTool/src/core/ai_denoise.cpp`
    - `.artifacts/external-repos/GeminiWatermarkTool/src/core/watermark_engine.cpp`
  - FDnCNN pipeline 明确是：
    - 先 reverse alpha；
    - 对 alpha map resize 到实际 watermark region；
    - Sobel 梯度 -> normalize -> sqrt -> 5x5 ellipse dilate -> GaussianBlur sigma 2；
    - 再把 mask embed 到 padded ROI，并 blur sigma 1；
    - `result = weight * denoised + (1 - weight) * original`；
    - 注释明确：`only repair edge pixels`。
  - allenk 不是把水印主体整体交给 AI 修复；我们的旧实现额外加入 `footprintStrength`，导致水印主体/暗色纹理区域更容易被 FDnCNN 抹平。
- 本轮代码调整：
  - `src/core/allenkFdncnnDenoise.js`
    - `createAllenkGradientMask()` 去掉 footprint/body 权重；
    - 当传入 alpha map 与 ROI 尺寸不一致时，先 resize 到 ROI 尺寸，再计算梯度 mask；
    - 新增 resize 相关单测，防止 96px alpha 被当成 72px 左上角截读。
  - `src/video/videoCleanupBackends.js`
    - allenk FDnCNN patch 回到纯 mask blend；
    - 默认路径不再追加 `preserveHighpassStrength` 和 `borrowCleanHighpassTexture()`。
  - `src/video/videoPresetPolicy.js`
    - 自动 AI 预设从保守 `edgeDenoiseStrength=0.25` 调整为 `1.8`；
    - AI 自动预设的后置 residual cleanup 调整为 `0`，避免用软清理掩盖 AI 过度平滑。
- 约束发现：
  - allenk NCNN 路径可使用 `padding=32`；
  - 当前浏览器 ONNX 模型是固定 `104x104`，对应 72px watermark + 16px padding；
  - 尝试把浏览器 padding 改为 32 会失败：
    - `allenk FDnCNN ONNX runtime expected 104x104, got 136x136`
  - 因此浏览器默认仍保留 `allenkFdncnnPadding=16`，后续若要继续追 allenk，需要导出/接入动态 ROI 或 136/200 尺寸模型。
- 新证据：
  - 输出视频：
    - `.artifacts/browser-native-default-gate/4d420881-allenk-aligned-ai-after-1s.mp4`
  - 右下 ROI 对比图：
    - `.artifacts/browser-native-default-gate/4d420881-allenk-aligned-roi-compare.png`
- 视觉结论：
  - 新策略的水印主体压制明显强于旧保守 AI；
  - 仍能看到一块比 allenk 更平滑的暗斑；
  - 这更像是固定 104 ROI / ONNX 模型输入尺寸与 allenk 动态 NCNN 上下文不同造成的差距，而不是继续叠后处理能解决的问题。
- 验证：
  - `pnpm exec node --test tests/core/allenkFdncnnDenoise.test.js tests/video/videoCleanupBackends.test.js tests/video/videoPresetPolicy.test.js`
    - `39` tests passed
  - `pnpm build`
    - passed

### 2026-06-12 默认切换到 200x200 FDnCNN ONNX

- 用户决策：
  - 不再先试 `136x136`；
  - 直接使用接近 allenk 日志规格的 `200x200` ROI。
- 本轮代码调整：
  - 复制模型资产：
    - from `.artifacts/allenk-fdncnn/roi200/model_core_fp32_200.onnx`
    - to `public/models/allenk-fdncnn/model_core_fp32_200.onnx`
  - `src/video-app.js`
    - 模型 URL 改为 `./models/allenk-fdncnn/model_core_fp32_200.onnx`
    - 输入 shape 改为 `[1, 4, 200, 200]`
    - 输出 shape 改为 `[1, 3, 200, 200]`
    - `allenkFdncnnPadding` 改为 `64`，对应 `72px watermark + 64px*2 = 200px`
    - 手动切换到 AI backend 时，默认 strength 从旧的 `0.25` 改为 `1.8`
- 验证导出：
  - 命令：
    - `pnpm export:video-backend -- --input .artifacts/browser-native-default-gate/4d420881-source-1s.mp4 --output .artifacts/browser-native-default-gate/4d420881-ai-roi200-after-1s.mp4 --page http://127.0.0.1:4173/video-preview.html --denoise-backend allenk-fdncnn-browser-spike --edge-denoise-strength 1.8 --residual-cleanup-strength 0 --allow-low-confidence --timeout-ms 420000`
  - 输出：
    - `.artifacts/browser-native-default-gate/4d420881-ai-roi200-after-1s.mp4`
  - 结果：
    - `24` frames processed
    - 1s 样片耗时约 `51s`
    - `no-audio-track`
  - 对比图：
    - `.artifacts/browser-native-default-gate/4d420881-roi104-roi200-allenk-compare.png`
- 视觉判断：
  - `200x200` 已经真正加载到 dist bundle：
    - `dist/video-app.js` 包含 `model_core_fp32_200.onnx`
    - shape 为 `[1,4,200,200]`
    - padding 为 `64`
  - 与 `104x104` 相比，右下 ROI 视觉改善不明显；
  - 与 allenk 仍有纹理自然度差距；
  - 这说明剩余差距可能不只是 ROI 大小，还包括 allenk 的 NCNN 推理细节、视频编码/颜色路径、alpha profile 或候选锁定/seed scale 差异。
- 验证：
  - `pnpm build`
    - passed

### 2026-06-12 纹理重建复盘：后处理补纹理收益有限

- 用户反馈：
  - 默认 AI 输出仍偏“塑料糊”，纹理重建效果不好；
  - 目标从继续压残影转为确认纹理损失的真正来源。
- 本轮实现/调试能力：
  - `src/video/videoCleanupBackends.js`
    - 新增 `borrowCleanHighpassTexture()`；
    - 从低水印权重的干净邻域借高频纹理，不再从水印覆盖区直接回灌高频；
    - AI 后的本地 highpass 回灌从 `0.32` 降到 `0.12`，避免把水印自身高频带回来；
    - AI backend 的 `edgeDenoiseStrength` 归一化上限从 `1` 放宽到 `3`，用于对齐 allenk 日志中的 `strength=180%` 调试。
  - `src/core/allenkFdncnnDenoise.js`
    - `createAllenkGradientMask()` 默认 `footprintStrength` 从 `0.65` 降到 `0.32`；
    - 目的：减少 AI 对水印主体内部的平滑，更多保留 reverse-alpha 后的原始纹理。
  - `src/video-app.js`
    - 新增调试覆写：
      - `window.__gwrVideoOverrideEdgeDenoiseStrength`
      - `window.__gwrVideoOverrideResidualCleanupStrength`
    - 覆写发生在自动 preset 之后，避免调试参数被默认 preset 重置。
  - `scripts/export-video-backend-variant.js`
    - 隐藏控件可被脚本设置；
    - `--page` 支持 HTTP URL；
    - 新增 `--residual-cleanup-strength`；
    - AI backend 可测 `edgeDenoiseStrength > 1`。
- 实验结论：
  1. **纹理借用/合成 v1-v2：收益很小**
     - 输出：
       - `.artifacts/browser-native-default-gate/4d420881-texture-synth-v2-after-1s.mp4`
       - `.artifacts/browser-native-default-gate/deaee69b-texture-synth-v2-after-1s.mp4`
       - `.artifacts/browser-native-default-gate/e1997e6e-texture-synth-v2-after-1s.mp4`
     - 对比：
       - `.artifacts/browser-native-default-gate/4d420881-source-guard-v2-texture-synth-v2-allenk-compare.png`
       - `.artifacts/browser-native-default-gate/deaee69b-source-guard-v2-texture-synth-v2-allenk-compare.png`
       - `.artifacts/browser-native-default-gate/e1997e6e-source-guard-v2-texture-synth-v2-allenk-compare.png`
     - 视觉判断：
       - 没有明显假噪；
       - 但纹理恢复幅度太小，不能解决“塑料糊”。
  2. **AI strength 1.0 / 1.8：不是答案**
     - allenk 日志显示：
       - `sigma=75`
       - `strength=180%`
       - `roi=200x200`
     - 浏览器实测：
       - `.artifacts/browser-native-default-gate/4d420881-ai-strength100-v2-after-1s.mp4`
       - `.artifacts/browser-native-default-gate/e1997e6e-ai-strength100-v2-after-1s.mp4`
       - `.artifacts/browser-native-default-gate/4d420881-ai-strength180-after-1s.mp4`
       - `.artifacts/browser-native-default-gate/e1997e6e-ai-strength180-after-1s.mp4`
     - 对比：
       - `.artifacts/browser-native-default-gate/4d420881-strength025-vs-strength180-allenk-compare.png`
       - `.artifacts/browser-native-default-gate/e1997e6e-strength025-vs-strength180-allenk-compare.png`
     - 视觉判断：
       - 强度增大可以略压残影；
       - 但纹理更平滑，不能接近 allenk。
  3. **ROI200 + strength1.8：质量未显著改善，性能不可接受**
     - 命令：
       - `pnpm export:allenk-fdncnn-onnx-frame-video -- --manifest .artifacts/allenk-fdncnn/roi200/onnx-manifest.json --case 4d420881 --duration 1 --padding 64 --sigma 75 --strength 1.8 --crf 12 --preset medium --output-dir .artifacts/allenk-fdncnn/video-frame-export-4d420881-roi200-pad64-strength180-1s`
     - 输出：
       - `.artifacts/allenk-fdncnn/video-frame-export-4d420881-roi200-pad64-strength180-1s/4d420881-pad16-strength025.mp4`
     - avg runtime：`~1957.8ms/frame`
     - 对比：
       - `.artifacts/browser-native-default-gate/4d420881-strength025-vs-roi200-strength180-allenk-compare.png`
     - 判断：
       - 慢；
       - 仍不恢复 allenk 的颗粒质感；
       - 不进入默认。
  4. **residual cleanup 不能关，0.8 也不够稳**
     - `residualCleanupStrength=0`：
       - `.artifacts/browser-native-default-gate/4d420881-residual0-after-1s.mp4`
       - `.artifacts/browser-native-default-gate/e1997e6e-residual0-after-1s.mp4`
       - 对比：
         - `.artifacts/browser-native-default-gate/4d420881-body-light-vs-residual0-allenk-compare.png`
         - `.artifacts/browser-native-default-gate/e1997e6e-body-light-vs-residual0-allenk-compare.png`
       - 纹理略回，但星形轮廓明显回归，不可用。
     - `residualCleanupStrength=0.8`：
       - `.artifacts/browser-native-default-gate/4d420881-cleanup080-after-1s.mp4`
       - `.artifacts/browser-native-default-gate/e1997e6e-cleanup080-after-1s.mp4`
       - 对比：
         - `.artifacts/browser-native-default-gate/4d420881-cleanup150-vs-cleanup080-allenk-compare.png`
         - `.artifacts/browser-native-default-gate/e1997e6e-cleanup150-vs-cleanup080-allenk-compare.png`
       - 仍有明显轮廓残留，也不适合作为默认。
- 当前判断：
  - 纹理损失不是单纯“后处理强度”问题；
  - 后处理补纹理只能微调，不能真正学习 allenk；
  - allenk 更可能在 **reverse-alpha 主体保留 + 只对边缘/残影区域 denoise** 的边界选择上更准；
  - 下一步值得做：
    1. 从 allenk 输出反推其实际 denoise mask，而不是继续调全局 strength；
    2. 对比 `before -> allenk` 的修改区域，估算 allenk 哪些 alpha/gradient 区域没有动；
    3. 把我们的 AI mask 从 `alpha footprint + edge` 改为更接近 allenk 的“edge/residual-only mask”。
- 验证：
  - `pnpm exec node --test tests/video/videoCleanupBackends.test.js tests/core/allenkFdncnnDenoise.test.js tests/video/videoPresetPolicy.test.js tests/core/allenkFdncnnOnnxRuntime.test.js tests/scripts/scriptEntrypoints.test.js`
    - `41` tests passed
  - `pnpm build`
    - passed
- 更新判断：
  - 简单相邻帧 ROI 混合没有成为可用默认候选。
  - `0.65` 强度在 relocated 样例上回归明显。
  - `0.25` 强度虽然更温和，但仍出现 active/highBody 回归，收益不足以抵消风险。
  - 保留 `canvas-temporal-stabilize` 作为实验后端；默认继续保持 `none`。
  - 下一步若继续时序方向，应从“直接混合上一帧”升级为：
    - 只混合 residual 高频/低频分量，而不是 RGB 本体；
    - 使用 motion-aware / optical-flow-like 小窗口匹配；
    - 或在 reference-free residual 指标上建立时序稳定 gate，再进入整段导出。

### 2026-06-11 `canvas-temporal-delta-stabilize` Delta 时序稳定实验

- 背景：
  - `canvas-temporal-stabilize` 直接混合上一帧 RGB，会在 relocated 样例上引入 active/highBody 回归。
  - 本轮改为只稳定 removal delta：
    - 当前帧 delta = `processedRoi - originalRoi`
    - 上一帧 delta = `previousProcessedRoi - previousOriginalRoi`
    - 输出 = `currentOriginalRoi + blendedDelta`
  - 目标是减少去水印修补量的闪烁，而不是拖动背景本体。
- 实现：
  - `src/video/videoCleanupBackends.js`
    - 新增 denoise backend:
      - `canvas-temporal-delta-stabilize`
  - `src/video/videoExport.js`
    - 在逐帧导出循环中维护 `previousTemporalDeltaFrame`。
    - `processWatermarkRoi()` 保留当前帧原始 ROI，cleanup 后再计算 delta。
    - 只在 alpha ROI 内、原始帧局部变化小、delta jitter 较明显的位置做小权重混合。
  - `public/video-preview.html`
    - 后端去噪下拉框新增 `Canvas 时序 Delta 稳定`。
  - `scripts/export-video-backend-variant.js`
    - help 文案新增 `canvas-temporal-delta-stabilize`。
  - 默认仍为 `denoiseBackend=none`。
- `delta065` 导出：
  - `.artifacts/video-temporal-delta-stabilize/delta065/4d420881.mp4`
  - `.artifacts/video-temporal-delta-stabilize/delta065/deaee69b.mp4`
  - `.artifacts/video-temporal-delta-stabilize/delta065/e1997e6e.mp4`
- `delta065` benchmark:
  - `.artifacts/video-temporal-delta-stabilize/delta065/benchmark/latest-report.md`
  - 结果：
    - `4d420881-temporal-delta065-12mbps`
      - active `-0.0079 neutral`
      - edge `-0.0136 neutral`
      - lowBody `-0.0214 improved`
      - highBody `-0.0055 neutral`
    - `deaee69b-temporal-delta065-12mbps`
      - active `+0.0346 regressed`
      - edge `+0.0415 regressed`
      - lowBody `+0.1000 regressed`
      - highBody `+0.0314 regressed`
    - `e1997e6e-temporal-delta065-12mbps`
      - active `+0.0361 regressed`
      - edge `+0.0238 regressed`
      - lowBody `-0.0652 improved`
      - highBody `+0.0416 regressed`
- `delta025` 导出：
  - `.artifacts/video-temporal-delta-stabilize/delta025/4d420881.mp4`
  - `.artifacts/video-temporal-delta-stabilize/delta025/deaee69b.mp4`
  - `.artifacts/video-temporal-delta-stabilize/delta025/e1997e6e.mp4`
- `delta025` benchmark:
  - `.artifacts/video-temporal-delta-stabilize/delta025/benchmark/latest-report.md`
  - 结果：
    - `4d420881-temporal-delta025-12mbps`
      - active `+0.0101 neutral`
      - edge `-0.0047 neutral`
      - lowBody `-0.0241 improved`
      - highBody `+0.0162 neutral`
    - `deaee69b-temporal-delta025-12mbps`
      - active `+0.0009 neutral`
      - edge `-0.0091 neutral`
      - lowBody `+0.2110 regressed`
      - highBody `+0.0038 neutral`
    - `e1997e6e-temporal-delta025-12mbps`
      - active `+0.0399 regressed`
      - edge `-0.0053 neutral`
      - lowBody `-0.0204 improved`
      - highBody `+0.0585 regressed`
- `delta010` 导出：
  - `.artifacts/video-temporal-delta-stabilize/delta010/4d420881.mp4`
  - `.artifacts/video-temporal-delta-stabilize/delta010/deaee69b.mp4`
  - `.artifacts/video-temporal-delta-stabilize/delta010/e1997e6e.mp4`
- `delta010` benchmark:
  - `.artifacts/video-temporal-delta-stabilize/delta010/benchmark/latest-report.md`
  - 结果：
    - `4d420881-temporal-delta010-12mbps`
      - active `+0.0327 regressed`
      - edge `+0.0192 neutral`
      - lowBody `+0.1038 regressed`
      - highBody `+0.0377 regressed`
    - `deaee69b-temporal-delta010-12mbps`
      - active `+0.0219 regressed`
      - edge `+0.0379 regressed`
      - lowBody `-0.0348 improved`
      - highBody `+0.0158 neutral`
    - `e1997e6e-temporal-delta010-12mbps`
      - active `+0.0039 neutral`
      - edge `-0.0117 neutral`
      - lowBody `+0.0863 regressed`
      - highBody `+0.0097 neutral`
- 更新判断：
  - Delta-only 时序稳定比 RGB 直混更合理，也更接近可控，但三档强度都不能成为默认候选。
  - `delta025` 是三档里最接近可用的：
    - 标准样例全 neutral 或 lowBody improved。
    - `deaee69b` 只有 lowBody 明显回归。
    - `e1997e6e` active/highBody 仍回归。
  - 目前不采纳为默认，保留为实验后端。
  - 下一步若继续时序方向，不能只用同坐标上一帧 delta：
    - 需要小窗口匹配或运动补偿后再复用 delta；
    - 或把时序稳定约束放入单帧/多帧 lab，在导出整段视频前筛掉高风险帧段。

### 2026-06-11 `canvas-temporal-match-delta-stabilize` 小窗口匹配 Delta 实验

- 背景：
  - `canvas-temporal-delta-stabilize` 仍是同坐标上一帧 delta 复用。
  - 本轮实现 2px 小窗口局部匹配，先在上一帧 original ROI 中找最相似 patch，再复用对应位置的 removal delta。
  - 目标：
    - 降低运动/相机抖动下同坐标复用 delta 的错位风险。
- 实现：
  - `src/video/videoCleanupBackends.js`
    - 新增 denoise backend:
      - `canvas-temporal-match-delta-stabilize`
  - `src/video/videoExport.js`
    - 新增 `previousTemporalMatchDeltaFrame`。
    - 对 alpha ROI 内像素，在上一帧 original ROI 中搜索 `[-2,2]` 小窗口。
    - 使用 3x3 luma patch 平均差作为匹配 cost。
    - 只在 match cost 低、delta jitter 明显、alpha gate 通过时混合上一帧匹配位置 delta。
  - `public/video-preview.html`
    - 后端去噪下拉框新增 `Canvas 匹配 Delta 稳定`。
  - `scripts/export-video-backend-variant.js`
    - help 文案新增 `canvas-temporal-match-delta-stabilize`。
  - 默认仍为 `denoiseBackend=none`。
- `match025` 导出：
  - `.artifacts/video-temporal-match-delta-stabilize/match025/4d420881.mp4`
  - `.artifacts/video-temporal-match-delta-stabilize/match025/deaee69b.mp4`
  - `.artifacts/video-temporal-match-delta-stabilize/match025/e1997e6e.mp4`
- `match025` benchmark:
  - `.artifacts/video-temporal-match-delta-stabilize/match025/benchmark/latest-report.md`
  - 结果：
    - `4d420881-temporal-match-delta025-12mbps`
      - active `+0.0097 neutral`
      - edge `-0.0128 neutral`
      - lowBody `+0.1863 regressed`
      - highBody `+0.0177 neutral`
    - `deaee69b-temporal-match-delta025-12mbps`
      - active `+0.0459 regressed`
      - edge `+0.0161 neutral`
      - lowBody `+0.4815 regressed`
      - highBody `+0.0555 regressed`
    - `e1997e6e-temporal-match-delta025-12mbps`
      - active `-0.0136 neutral`
      - edge `-0.0141 neutral`
      - lowBody `+0.0330 regressed`
      - highBody `-0.0136 neutral`
- 验证：
  - `pnpm exec node --test tests/video/videoCleanupBackends.test.js tests/scripts/scriptEntrypoints.test.js`
    - `15` tests passed
  - `pnpm build`
    - passed
- 更新判断：
  - 小窗口匹配让 `e1997e6e` 的 active/highBody 比同坐标 delta 稳定更好，但代价是 lowBody 回归。
  - `deaee69b` 仍明显回归，说明仅靠 luma patch 匹配不够可靠。
  - 不采纳为默认，保留为实验后端。
  - 时序路线下一步不能继续只调 blend/gate，需要先建一个时序 residual lab：
    - 在 frame crop 上输出 delta jitter / matched offset / match cost heatmap；
    - 先确认哪些像素/帧段真的适合复用上一帧 delta；
    - 再考虑整段视频导出。

### 2026-06-11 Temporal Residual Lab 与 gated match025 实验

- 背景：
  - 用户截图指出 `deaee69b` 车灯区域、`e1997e6e` 斜向 rail/trim 区域仍有轻微瑕疵。
  - 上一轮 `canvas-temporal-match-delta-stabilize` 说明：单纯 2px 小窗口匹配并不可靠，尤其在 match cost 高的帧段会放大 delta jitter。
- 新增诊断工具：
  - `scripts/run-video-temporal-residual-lab.js`
  - `package.json`
    - 新增 `pnpm lab:video-temporal-residual`
  - `tests/scripts/videoTemporalResidualLab.test.js`
  - 输出内容：
    - same-coordinate delta jitter heatmap
    - matched delta jitter heatmap
    - match cost heatmap
    - case-level markdown/json report
- Lab 运行：
  - 命令：
    - `node scripts/run-video-temporal-residual-lab.js --cases 'deaee69b,e1997e6e' --timestamps '1,3,5,7,9' --output-dir .artifacts/video-temporal-residual-lab/match-analysis`
  - 报告：
    - `.artifacts/video-temporal-residual-lab/match-analysis/latest-report.md`
  - 可视化：
    - `.artifacts/video-temporal-residual-lab/match-analysis/deaee69b-temporal-residual.png`
    - `.artifacts/video-temporal-residual-lab/match-analysis/e1997e6e-temporal-residual.png`
- Lab 结论：
  - `deaee69b`
    - same jitter `9.1941`
    - matched jitter `10.3717`
    - improvement `-1.1775`
    - match cost `15.3689`
  - `e1997e6e`
    - same jitter `10.1547`
    - matched jitter `13.9169`
    - improvement `-3.7622`
    - match cost `20.6734`
  - 只有低 match cost 帧段，例如 `e1997e6e 3s -> 5s`，匹配 delta 才有轻微收益：
    - same `2.9916`
    - matched `2.7671`
    - improvement `+0.2246`
    - cost `2.1537`
  - 因此继续扩大搜索窗口或加大 blend 都不是正确方向；需要 evidence-gated temporal reuse。
- 实现调整：
  - `src/video/videoExport.js`
    - 收紧 `applyTemporalMatchedDeltaStabilization()`。
    - 只有同时满足以下条件才复用 matched delta：
      - matched delta jitter 明确低于同坐标上一帧 delta jitter；
      - `matchedAdvantage > 0.5`；
      - `bestCost <= 8`；
      - match gate / advantage gate / jitter gate / alpha gate 同时通过。
    - 最大 blend 从 `0.34` 降为 `0.24`。
  - 默认仍不启用该后端。
- `match025-gated` 导出：
  - `.artifacts/video-temporal-match-delta-stabilize/match025-gated/4d420881.mp4`
  - `.artifacts/video-temporal-match-delta-stabilize/match025-gated/deaee69b.mp4`
  - `.artifacts/video-temporal-match-delta-stabilize/match025-gated/e1997e6e.mp4`
- `match025-gated` benchmark:
  - `.artifacts/video-temporal-match-delta-stabilize/match025-gated/benchmark/latest-report.md`
  - 结果：
    - `4d420881-temporal-match-delta025-gated-12mbps`
      - active `-0.0296 improved`
      - edge `+0.0520 regressed`
      - lowBody `+0.3372 regressed`
      - highBody `-0.0642 improved`
      - note: sparse lowBody regression
    - `deaee69b-temporal-match-delta025-gated-12mbps`
      - active `-0.3889 improved`
      - edge `-0.0357 improved`
      - lowBody `+0.2034 regressed`
      - highBody `-0.5347 improved`
      - note: sparse lowBody regression
    - `e1997e6e-temporal-match-delta025-gated-12mbps`
      - active `-0.1473 improved`
      - edge `-0.1376 improved`
      - lowBody `-0.6208 improved`
      - highBody `-0.1486 improved`
- 可视化对比视频：
  - full 4-up:
    - `.artifacts/video-temporal-match-delta-stabilize/match025-gated/comparison/deaee69b-full-4up.mp4`
    - `.artifacts/video-temporal-match-delta-stabilize/match025-gated/comparison/e1997e6e-full-4up.mp4`
  - ROI 4-up:
    - `.artifacts/video-temporal-match-delta-stabilize/match025-gated/comparison/deaee69b-roi-4up.mp4`
    - `.artifacts/video-temporal-match-delta-stabilize/match025-gated/comparison/e1997e6e-roi-4up.mp4`
- 更新判断：
  - gated match025 是目前时序路线里第一个出现较可信正向信号的候选。
  - 但 `4d420881` 和 `deaee69b` 仍有 sparse lowBody regression，不能直接升为默认。
  - 下一步：
    - 人眼检查 ROI 4-up 视频里的稀疏 lowBody 回归是否可见；
    - 如果不可见，扩大到更多样例做 batch benchmark；
    - 如果可见，继续缩小触发区域，优先保护 lowBody/background texture。

### 2026-06-11 relocated-gated match025 与编码控制组复核

- 背景：
  - `match025-gated` 在 `e1997e6e` 四个 bucket 全改善，在 `deaee69b` 只剩 sparse lowBody warning。
  - 但标准样例 `4d420881` 出现 edge `+0.0520` material regression，导致 `gate-video-denoise-candidates` 判定 `reject`。
  - 需要确认这个 regression 是否真由时序算法造成。
- 实现收窄：
  - `src/video/videoExport.js`
    - 新增 `shouldApplyTemporalMatchedDelta()`。
    - `canvas-temporal-match-delta-stabilize` 只在 relocated anchor 上启用：
      - `marginRight >= position.width * 1.8`
      - 或 `marginBottom >= position.width * 1.8`
    - 标准 anchor 上不再应用 temporal matched delta，避免用实验时序逻辑扰动稳定样例。
- `match025-relocated-gated` 导出：
  - `.artifacts/video-temporal-match-delta-stabilize/match025-relocated-gated/4d420881.mp4`
  - `.artifacts/video-temporal-match-delta-stabilize/match025-relocated-gated/deaee69b.mp4`
  - `.artifacts/video-temporal-match-delta-stabilize/match025-relocated-gated/e1997e6e.mp4`
- benchmark:
  - `.artifacts/video-temporal-match-delta-stabilize/match025-relocated-gated/benchmark/latest-report.md`
  - 结果：
    - `4d420881-temporal-match-delta025-relocated-gated-12mbps`
      - active `-0.0212 improved`
      - edge `+0.0592 regressed`
      - lowBody `+0.2095 regressed`
      - highBody `-0.0546 improved`
      - note: sparse lowBody regression
    - `deaee69b-temporal-match-delta025-relocated-gated-12mbps`
      - active `-0.3889 improved`
      - edge `-0.0357 improved`
      - lowBody `+0.2034 regressed`
      - highBody `-0.5347 improved`
      - note: sparse lowBody regression
    - `e1997e6e-temporal-match-delta025-relocated-gated-12mbps`
      - active `-0.1473 improved`
      - edge `-0.1376 improved`
      - lowBody `-0.6208 improved`
      - highBody `-0.1486 improved`
- gate:
  - `.artifacts/video-temporal-match-delta-stabilize/match025-relocated-gated/gate/latest-report.md`
  - 当前仍为 `reject`：
    - material failure 来自 `4d420881.edge`。
- 编码控制组：
  - 目的：
    - 验证 `4d420881.edge` 回归是否来自 temporal matched delta，还是来自本轮 12Mbps 重新导出/编码差异。
  - 导出：
    - `.artifacts/video-temporal-match-delta-stabilize/encoding-control/4d420881-none-12mbps.mp4`
  - benchmark:
    - `.artifacts/video-temporal-match-delta-stabilize/encoding-control/benchmark/latest-report.md`
  - no-op 12Mbps 控制组结果：
    - active `-0.0212 improved`
    - edge `+0.0592 regressed`
    - lowBody `+0.2095 regressed`
    - highBody `-0.0546 improved`
  - 结论：
    - `4d420881` 的 material edge regression 与 `match025-relocated-gated` 完全一致。
    - 因此该 regression 不是 temporal matched delta 引入，而是重新导出/编码控制组噪声或旧 baseline 编码差异。
- lowBody 诊断：
  - `4d420881`
    - `.artifacts/video-temporal-match-delta-stabilize/match025-gated/lowbody-diagnosis/4d420881/latest.md`
    - lowBody 回归只覆盖 `40` 个样本点，集中在 alpha `0.09-0.16`、gradient `0` 的 diamond 尖角/低梯度点。
  - `deaee69b`
    - `.artifacts/video-temporal-match-delta-stabilize/match025-gated/lowbody-diagnosis/deaee69b/latest.md`
    - lowBody 回归同样只覆盖 `40` 个样本点，且 worsened/improved 各约一半。
- 更新判断：
  - `match025-relocated-gated` 不应按普通 gate 的 `reject` 直接否定，因为唯一 material failure 被 no-op encoding control 复现。
  - 当前更准确状态是：
    - relocated 问题样例上有实质改善；
    - 标准样例未启用 temporal matched delta；
    - 剩余风险主要是 sparse lowBody warning 与编码控制组噪声。
  - 下一步：
    - 已改进 `gate-video-denoise-candidates` 支持 encoding-control report；
    - 继续做人工 ROI 复核，如果视觉上不可见，把 `match025-relocated-gated` 保留为 human-review candidate，而不是默认。

### 2026-06-11 Gate with Encoding-Control Report

- 背景：
  - `match025-relocated-gated` 普通 gate 被判为 `reject`，但唯一 material failure 来自 `4d420881.edge`。
  - no-op `denoiseBackend=none` 的 12Mbps 控制组复现了同样的 `4d420881.edge +0.0592` 与 `lowBody +0.2095`。
  - 因此 gate 需要区分“算法新增回归”和“重新导出/编码控制组也会出现的回归”。
- 实现：
  - `scripts/gate-video-denoise-candidates.js`
    - 新增 `--control-reports <json>`。
    - 对候选每个 `case/bucket` 的回归，若 encoding-control report 中同一 `case/bucket` 也回归，且 control 的 `meanAbsDelta >= candidate meanAbsDelta - 0.005`，则记录为 `controlAdjustments`。
    - 被 `controlAdjustments` 覆盖的 bucket 不再计入 material regression。
  - `tests/scripts/videoDenoiseCandidateGate.test.js`
    - 新增 encoding-control 覆盖 material regression 的单测。
    - 新增 markdown 输出 control adjustment 的单测。
- 真实运行：
  - 命令：
    - `node scripts/gate-video-denoise-candidates.js --reports .artifacts/video-temporal-match-delta-stabilize/match025-relocated-gated/benchmark/latest-summary.json --control-reports .artifacts/video-temporal-match-delta-stabilize/encoding-control/benchmark/latest-summary.json --output .artifacts/video-temporal-match-delta-stabilize/match025-relocated-gated/gate-with-control/latest-report.json --markdown .artifacts/video-temporal-match-delta-stabilize/match025-relocated-gated/gate-with-control/latest-report.md`
  - 输出：
    - `.artifacts/video-temporal-match-delta-stabilize/match025-relocated-gated/gate-with-control/latest-report.json`
    - `.artifacts/video-temporal-match-delta-stabilize/match025-relocated-gated/gate-with-control/latest-report.md`
- gate-with-control 结果：
  - `canvas-temporal-match-delta-stabilize, strength=0.25`
    - decision: `human-review`
    - improved cases: `3`
    - material fail layers: `0`
    - warning layers: `1`
  - `4d420881`
    - edge `+0.0592` 被 `4d420881-none-12mbps-control +0.0592` 覆盖。
    - lowBody `+0.2095` 被 `4d420881-none-12mbps-control +0.2095` 覆盖。
  - `deaee69b`
    - active / edge / highBody 改善。
    - lowBody 仍是 sparse warning，需要人工 ROI 复核。
  - `e1997e6e`
    - active / edge / lowBody / highBody 全部改善。
  - 更新判断：
  - `match025-relocated-gated` 现在是明确的 `human-review candidate`，不是默认候选，也不是算法层面的 reject。
  - 当前离“可用交付”更近的一条路：
    - 保持默认 `denoiseBackend=none`。
    - 在视频实验 UI / 导出脚本中保留 `canvas-temporal-match-delta-stabilize` 作为 relocated 样例人工复核候选。
    - 下一步优先输出 ROI 4-up 复核视频，确认 `deaee69b` sparse lowBody 是否肉眼可见。
- 最新 ROI 4-up 复核视频：
  - `.artifacts/video-temporal-match-delta-stabilize/match025-relocated-gated/comparison/deaee69b-roi-4up.mp4`
  - `.artifacts/video-temporal-match-delta-stabilize/match025-relocated-gated/comparison/e1997e6e-roi-4up.mp4`

### 2026-06-11 match025-relocated-gated 视觉复核

- 背景：
  - gate-with-control 已将候选从 `reject` 修正为 `human-review`。
  - 剩余风险是 `deaee69b` 的 sparse lowBody warning。
- 新增复核 artifact：
  - `.artifacts/video-temporal-match-delta-stabilize/match025-relocated-gated/visual-review/roi4up-keyframes-sheet.png`
  - `.artifacts/video-temporal-match-delta-stabilize/match025-relocated-gated/visual-review/latest-report.md`
- 复核方式：
  - 从最新 ROI 4-up 视频抽取 `1s / 3s / 5s / 7s / 9s` 关键帧。
  - 每行四列：
    - original
    - current MVP
    - relocated-gated
    - allenk v0.6.2
- 视觉观察：
  - `deaee69b`
    - `relocated-gated` 相对 `current MVP` 没有出现成片的新斑点、halo 或边缘断裂。
    - sparse lowBody warning 更像少数低梯度 diamond 尖角像素的指标波动，而不是结构化可见残影。
  - `e1997e6e`
    - `relocated-gated` 与 `current MVP` 视觉上接近。
    - benchmark 中 active / edge / lowBody / highBody 全改善，视觉复核未发现新的明显损伤。
  - 更新判断：
  - 当前没有证据支持继续收紧 lowBody gate；继续调同一批 5 个时间点容易过拟合。
  - `match025-relocated-gated` 保持为 `human-review candidate`，不升默认。
  - 下一步优先：
    - 扩充更多带 reference 的样例；
    - 或接入实际 UI/导出路径，让用户能在实验选项里切换该候选并人工查看。
- UI / CLI 标注：
  - `public/video-preview.html`
    - 将 `canvas-temporal-match-delta-stabilize` 下拉选项标注为 `Canvas 匹配 Delta 稳定（迁移锚点复核）`。
    - 新增 `迁移锚点复核预设` 按钮：
      - 后端设为 `canvas-temporal-match-delta-stabilize`
      - `edgeDenoiseStrength = 0.25`
      - `videoBitrateMbps = 12`
      - `allowLowConfidence = true`
      - 状态栏提示该预设用于人工复核，不是默认策略。
  - `scripts/export-video-backend-variant.js`
    - help 文案说明 `canvas-temporal-match-delta-stabilize` 是 relocated-anchor human-review candidate，不是默认后端。
- UI 验证：
  - Playwright 打开 `dist/video-preview.html` 并点击 `迁移锚点复核预设`。
  - 状态验证：
    - `denoiseBackend = canvas-temporal-match-delta-stabilize`
    - `edgeDenoiseStrength = 0.25`
    - `videoBitrateMbps = 12`
    - `allowLowConfidence = true`
  - 截图：
    - `.artifacts/video-temporal-match-delta-stabilize/match025-relocated-gated/ui-review/video-preview-preset-after.png`

### 2026-06-11 真实 UI 预设导出复核

- 背景：
  - 上一轮只验证了预设按钮状态，仍需确认真实页面导出路径能产出同等候选结果。
- 运行方式：
  - Playwright 打开 `dist/video-preview.html`。
  - 上传：
    - `${GWR_VIDEO_SAMPLE_ROOT}\deaee69b-bd2f-481d-ba4d-bca20a1b4c8e.mp4`
  - 点击 `迁移锚点复核预设`。
  - 点击 `导出无水印视频`。
- 输出：
  - `.artifacts/video-temporal-match-delta-stabilize/match025-relocated-gated/ui-export/deaee69b-ui-preset.mp4`
  - `.artifacts/video-temporal-match-delta-stabilize/match025-relocated-gated/ui-export/latest-report.json`
  - `.artifacts/video-temporal-match-delta-stabilize/match025-relocated-gated/ui-export/latest-report.md`
  - `.artifacts/video-temporal-match-delta-stabilize/match025-relocated-gated/ui-export/before-export.png`
  - `.artifacts/video-temporal-match-delta-stabilize/match025-relocated-gated/ui-export/after-export.png`
- UI 状态验证：
  - `denoiseBackend = canvas-temporal-match-delta-stabilize`
  - `edgeDenoiseStrength = 0.25`
  - `videoBitrateMbps = 12`
  - `allowLowConfidence = true`
  - 页面状态（音频透传前的历史记录）：
    - `导出完成，已处理 240 帧，后端去噪：canvas-temporal-match-delta-stabilize。注意：MVP 暂不保留音频。`
- ffprobe:
  - `1920x1080`
  - `24fps`
  - `10.000000s`
  - bit rate 约 `11.74Mbps`
- UI 输出 benchmark:
  - `.artifacts/video-temporal-match-delta-stabilize/match025-relocated-gated/ui-export/benchmark/latest-report.md`
  - `deaee69b-ui-preset-relocated-gated`
    - active `-0.3889 improved`
    - edge `-0.0357 improved`
    - lowBody `+0.2034 regressed`
    - highBody `-0.5347 improved`
    - note: `sparse-low-body-regression`
- 更新判断：
  - 真实 UI 预设导出复现了脚本候选的指标形态。
  - 这说明 `迁移锚点复核预设` 已经是可操作的人审路径。
  - 仍不升默认；下一步需要更多 reference 样例或真实用户复核反馈。

### 2026-06-11 双样例真实 UI 预设导出复核

- 背景：
  - 上一轮真实 UI 只验证了 `deaee69b`。
  - 本轮补齐 `e1997e6e`，确认 UI 预设在两个 relocated 问题样例上都可用。
- 新增 UI 输出：
  - `.artifacts/video-temporal-match-delta-stabilize/match025-relocated-gated/ui-export/e1997e6e-ui-preset.mp4`
  - `.artifacts/video-temporal-match-delta-stabilize/match025-relocated-gated/ui-export/e1997e6e-latest-report.json`
  - `.artifacts/video-temporal-match-delta-stabilize/match025-relocated-gated/ui-export/e1997e6e-before-export.png`
  - `.artifacts/video-temporal-match-delta-stabilize/match025-relocated-gated/ui-export/e1997e6e-after-export.png`
- `e1997e6e` ffprobe:
  - `1920x1080`
  - `24fps`
  - `10.000000s`
  - bit rate 约 `11.73Mbps`
- 合并 benchmark:
  - `.artifacts/video-temporal-match-delta-stabilize/match025-relocated-gated/ui-export/combined-benchmark/latest-report.md`
  - `.artifacts/video-temporal-match-delta-stabilize/match025-relocated-gated/ui-export/combined-benchmark/latest-summary.json`
  - `deaee69b-ui-preset-relocated-gated`
    - active `-0.3889 improved`
    - edge `-0.0357 improved`
    - lowBody `+0.2034 regressed`
    - highBody `-0.5347 improved`
    - note: `sparse-low-body-regression`
  - `e1997e6e-ui-preset-relocated-gated`
    - active `-0.1473 improved`
    - edge `-0.1376 improved`
    - lowBody `-0.6208 improved`
    - highBody `-0.1486 improved`
- 合并 gate:
  - `.artifacts/video-temporal-match-delta-stabilize/match025-relocated-gated/ui-export/combined-benchmark/gate/latest-report.md`
  - decision: `human-review`
  - improved cases: `2`
  - material fail layers: `0`
  - warning layers: `1`
- 汇总报告：
  - `.artifacts/video-temporal-match-delta-stabilize/match025-relocated-gated/ui-export/combined-latest-report.md`
- 更新判断：
  - 真实 UI 预设路径已经覆盖两个主要 relocated 问题样例。
  - 两个样例均无 material regression。
  - `deaee69b` 仍保留 sparse lowBody warning，需人审；`e1997e6e` 四个 bucket 全改善。
  - 当前继续调参的收益很低，下一步更需要：
    - 新增更多带 reference 的视频样例；
    - 或收集用户对 UI 预设输出的人工反馈。

### 2026-06-11 脚本化真实 UI 预设导出

- 背景：
  - 前面的真实 UI 导出是 Playwright 手动片段，不方便复跑。
  - 本轮把“载入视频 -> 点击迁移锚点复核预设 -> 导出 -> 保存 MP4/报告/截图”沉淀为正式脚本，并复跑两个主要 relocated 样例。
- 新增脚本：
  - `scripts/export-video-ui-preset.js`
  - `package.json`
    - 新增 `pnpm export:video-ui-preset`
  - `tests/scripts/videoUiPresetExport.test.js`
- 脚本行为：
  - 打开 `dist/video-preview.html`。
  - 上传输入 MP4。
  - 点击真实 UI 按钮 `#relocatedReviewPresetBtn`。
  - 导出并保存页面 `downloadBtn` 对应 blob。
  - 写出 JSON / Markdown 报告。
  - 默认保存导出前后页面截图。
- 本轮复跑命令：

```powershell
pnpm export:video-ui-preset -- --input "${GWR_VIDEO_SAMPLE_ROOT}\deaee69b-bd2f-481d-ba4d-bca20a1b4c8e.mp4" --output ".artifacts\video-temporal-match-delta-stabilize\match025-relocated-gated\ui-preset-script\deaee69b-ui-preset-script.mp4" --timeout-ms 360000
pnpm export:video-ui-preset -- --input "${GWR_VIDEO_SAMPLE_ROOT}\e1997e6e-45d5-4895-ae81-a7361c05bc37.mp4" --output ".artifacts\video-temporal-match-delta-stabilize\match025-relocated-gated\ui-preset-script\e1997e6e-ui-preset-script.mp4" --timeout-ms 360000
```

- 输出：
  - `.artifacts/video-temporal-match-delta-stabilize/match025-relocated-gated/ui-preset-script/deaee69b-ui-preset-script.mp4`
  - `.artifacts/video-temporal-match-delta-stabilize/match025-relocated-gated/ui-preset-script/deaee69b-ui-preset-script-ui-preset-report.json`
  - `.artifacts/video-temporal-match-delta-stabilize/match025-relocated-gated/ui-preset-script/deaee69b-ui-preset-script-ui-preset-report.md`
  - `.artifacts/video-temporal-match-delta-stabilize/match025-relocated-gated/ui-preset-script/deaee69b-ui-preset-script-before-export.png`
  - `.artifacts/video-temporal-match-delta-stabilize/match025-relocated-gated/ui-preset-script/deaee69b-ui-preset-script-after-export.png`
  - `.artifacts/video-temporal-match-delta-stabilize/match025-relocated-gated/ui-preset-script/e1997e6e-ui-preset-script.mp4`
  - `.artifacts/video-temporal-match-delta-stabilize/match025-relocated-gated/ui-preset-script/e1997e6e-ui-preset-script-ui-preset-report.json`
  - `.artifacts/video-temporal-match-delta-stabilize/match025-relocated-gated/ui-preset-script/e1997e6e-ui-preset-script-ui-preset-report.md`
  - `.artifacts/video-temporal-match-delta-stabilize/match025-relocated-gated/ui-preset-script/e1997e6e-ui-preset-script-before-export.png`
  - `.artifacts/video-temporal-match-delta-stabilize/match025-relocated-gated/ui-preset-script/e1997e6e-ui-preset-script-after-export.png`
- UI 状态验证：
  - preset state:
    - `denoiseBackend = canvas-temporal-match-delta-stabilize`
    - `edgeDenoiseStrength = 0.25`
    - `videoBitrateMbps = 12`
    - `allowLowConfidence = true`
  - result state:
    - `success`
    - 音频透传前：`导出完成，已处理 240 帧，后端去噪：canvas-temporal-match-delta-stabilize。注意：MVP 暂不保留音频。`
    - 音频透传后见下方“视频导出音频透传”记录。
- ffprobe:
  - `deaee69b-ui-preset-script.mp4`
    - `1920x1080`
    - `24fps`
    - `10.000000s`
    - bit rate 约 `11.74Mbps`
  - `e1997e6e-ui-preset-script.mp4`
    - `1920x1080`
    - `24fps`
    - `10.000000s`
    - bit rate 约 `11.73Mbps`
- 脚本化 benchmark：
  - manifest:
    - `.artifacts/video-temporal-match-delta-stabilize/match025-relocated-gated/ui-preset-script/benchmark-manifest.json`
  - report:
    - `.artifacts/video-temporal-match-delta-stabilize/match025-relocated-gated/ui-preset-script/benchmark/latest-report.md`
  - `deaee69b-ui-preset-script` vs `deaee69b` baseline:
    - active `-0.3889 improved`
    - edge `-0.0357 improved`
    - lowBody `+0.2034 regressed`
    - highBody `-0.5347 improved`
    - note: `sparse-low-body-regression`
  - `e1997e6e-ui-preset-script` vs `e1997e6e` baseline:
    - active `-0.1473 improved`
    - edge `-0.1376 improved`
    - lowBody `-0.6208 improved`
    - highBody `-0.1486 improved`
- 脚本化 gate：
  - `.artifacts/video-temporal-match-delta-stabilize/match025-relocated-gated/ui-preset-script/benchmark/gate/latest-report.md`
  - decision: `human-review`
  - improved cases: `2`
  - material fail layers: `0`
  - warning layers: `1`
- 验证：
  - `pnpm build`
  - `pnpm exec node --test tests/scripts/scriptEntrypoints.test.js tests/scripts/videoUiPresetExport.test.js`
- 更新判断：
  - UI 预设现在有可复跑脚本，不再依赖临时 Playwright 片段。
  - 脚本产物复现了此前双样例真实 UI 导出的指标形态。
  - `canvas-temporal-match-delta-stabilize + 0.25` 仍保持 `human-review candidate`，不升默认。
  - 下一步应优先扩充 reference 视频或接入更强 ROI 级 denoise；继续围绕 `deaee69b` 单样例调参收益低。

### 2026-06-11 脚本化 UI 预设 4-up 视频对比

- 背景：
  - 目标是让用户能直接看对比视频，而不只看单路导出 MP4 或静态 crop sheet。
  - 之前的 4-up 产物来自早前候选路径；本轮对真实 UI 预设脚本导出重新生成全画面和 ROI 4-up。
- 新增脚本：
  - `scripts/render-video-comparison-grid.js`
  - `package.json`
    - 新增 `pnpm render:video-comparison-grid`
  - `tests/scripts/renderVideoComparisonGrid.test.js`
- 脚本能力：
  - 支持 2 到 4 个输入视频。
  - 输入格式：`--input label=path/to/video.mp4`。
  - 可选 `--crop x,y,width,height`，内部已兼容 PowerShell 把逗号参数传成空格的情况。
  - 使用本机 `ffmpeg` 生成带标签的 `xstack` 对比 MP4。
  - 同步输出 JSON / Markdown 报告。
- 本轮对比列：
  - `original`
  - `current MVP`
  - `UI preset`
  - `allenk`
- 产物：
  - 全画面：
    - `.artifacts/video-temporal-match-delta-stabilize/match025-relocated-gated/ui-preset-script/comparison/deaee69b-full-4up.mp4`
    - `.artifacts/video-temporal-match-delta-stabilize/match025-relocated-gated/ui-preset-script/comparison/e1997e6e-full-4up.mp4`
  - ROI:
    - `.artifacts/video-temporal-match-delta-stabilize/match025-relocated-gated/ui-preset-script/comparison/deaee69b-roi-4up.mp4`
    - `.artifacts/video-temporal-match-delta-stabilize/match025-relocated-gated/ui-preset-script/comparison/e1997e6e-roi-4up.mp4`
- ROI crop:
  - `1676,836,200,200`
  - 覆盖 standard 与 relocated 两个 72px anchor 的右下区域。
- ffprobe 验证：
  - full 4-up:
    - `1280x720`
    - `24fps`
    - `10.000000s`
  - ROI 4-up:
    - `640x640`
    - `24fps`
    - `10.000000s`
- 验证：
  - `pnpm exec node --test tests/scripts/renderVideoComparisonGrid.test.js tests/scripts/scriptEntrypoints.test.js`
- 更新判断：
  - 真实 UI 预设现在具备“导出 MP4 + 量化 benchmark/gate + 可观看 4-up 对比视频”的闭环证据。
  - 对用户复核，优先看 ROI 4-up；若 ROI 没有明显残影/边缘破坏，再看全画面对比确认没有全局观感异常。

### 2026-06-11 视频导出音频透传

- 背景：
  - 之前 MVP 导出只重新编码视频轨，输出 MP4 不保留原音频。
  - 这会影响“可用交付”，因为用户拿到的去水印视频会丢声。
- 实现：
  - `src/video/videoExport.js`
    - 引入 `EncodedAudioPacketSource` / `EncodedPacketSink`。
    - 默认读取 primary audio track。
    - 若音频 codec 被 `Mp4OutputFormat` 支持，则按 encoded packet 透传，不重编码音频。
    - 以视频起始时间为基准平移音频 packet timestamp。
    - 对起始时间之前的 priming packet：
      - 完全在起点前的 packet 会跳过；
      - 跨过起点的 packet 会裁到 `timestamp=0`。
    - 返回：
      - `audioCopied`
      - `audioPacketCount`
      - `audioCodec`
      - `audioSkipReason`
  - `src/video-app.js`
    - 成功状态显示音频是否保留，以及 codec / packet 数。
  - `public/video-preview.html`
    - 页面说明改为“视频轨重编码，兼容音频轨自动透传”。
- 新增测试：
  - `tests/video/videoAudioCopy.test.js`
    - `canCopyAudioCodecToMp4`
    - `normalizePacketTimestamp`
- 真实 UI 预设复跑：

```powershell
pnpm export:video-ui-preset -- --input "${GWR_VIDEO_SAMPLE_ROOT}\deaee69b-bd2f-481d-ba4d-bca20a1b4c8e.mp4" --output ".artifacts\video-audio-preserve\deaee69b-ui-preset-audio.mp4" --timeout-ms 360000
pnpm export:video-ui-preset -- --input "${GWR_VIDEO_SAMPLE_ROOT}\e1997e6e-45d5-4895-ae81-a7361c05bc37.mp4" --output ".artifacts\video-audio-preserve\e1997e6e-ui-preset-audio.mp4" --timeout-ms 360000
```

- UI 状态：
  - `deaee69b`
    - `导出完成，已处理 240 帧，后端去噪：canvas-temporal-match-delta-stabilize。音频已保留：aac，469 packets。`
  - `e1997e6e`
    - `导出完成，已处理 240 帧，后端去噪：canvas-temporal-match-delta-stabilize。音频已保留：aac，469 packets。`
- ffprobe:
  - `.artifacts/video-audio-preserve/deaee69b-ui-preset-audio.mp4`
    - video: `h264`, `1920x1080`, `24fps`, `10.000000s`
    - audio: `aac`, `48000Hz`, `2 channels`, `10.000000s`
    - size: `14855466`
  - `.artifacts/video-audio-preserve/e1997e6e-ui-preset-audio.mp4`
    - video: `h264`, `1920x1080`, `24fps`, `10.000000s`
    - audio: `aac`, `48000Hz`, `2 channels`, `10.000000s`
    - size: `14844239`
- 更新判断：
  - 浏览器 MVP 的“丢音频”交付缺口已关闭。
  - 仍保留 `preserveAudio: false` 作为内部可选项；无音频轨或不支持 codec 时不强行转码，先明确报告原因。
  - 下一步质量瓶颈重新回到 ROI 局部纹理自然度 / ML denoise，而不是容器封装能力。

### 2026-06-11 relocated 样例自动复核预设

- 背景：
  - `deaee69b` / `e1997e6e` 这类 relocated/inset 样例需要 `canvas-temporal-match-delta-stabilize + 0.25` 才达到当前最佳人审候选。
  - 只把它放在手动按钮里，用户容易直接用默认 `none` 导出，导致错过当前最可用路径。
- 实现：
  - 新增 `src/video/videoPresetPolicy.js`
    - `isRelocatedVideoWatermarkPosition()`
    - `shouldUseRelocatedReviewPreset()`
    - `getRelocatedReviewPresetConfig()`
  - `src/video-app.js`
    - 点击 `检测` 后，如果候选是 confident relocated/inset，且当前仍是默认后端，则自动应用复核预设。
    - 直接点击 `导出无水印视频` 时，若还没有检测结果，先做一次检测，再按同样策略自动应用复核预设并导出。
    - 如果用户已手动选择其它后端，不覆盖用户选择。
  - `scripts/export-video-backend-variant.js`
    - 返回 `actualDenoiseBackend` / `actualControls`，避免自动预设生效时只看到命令行请求的 `denoiseBackend=none`。
- 新增测试：
  - `tests/video/videoPresetPolicy.test.js`
  - `tests/scripts/videoBackendExport.test.js`
- 检测路径验证：
  - 输入：
    - `${GWR_VIDEO_SAMPLE_ROOT}\deaee69b-bd2f-481d-ba4d-bca20a1b4c8e.mp4`
  - 页面检测结果：
    - `1080p inset, 72px, margin 144`
    - position `1704,864`
    - mean score `0.781`
    - votes `12/12`
  - 自动套用后控件状态：
    - `denoiseBackend = canvas-temporal-match-delta-stabilize`
    - `edgeDenoiseStrength = 0.25`
    - `videoBitrateMbps = 12`
    - `allowLowConfidence = true`
  - 页面状态：
    - `检测到迁移锚点水印，已自动应用复核预设：匹配 Delta 0.25、12Mbps、保留音频。`
- 直接导出路径验证：
  - 命令：

```powershell
pnpm export:video-backend -- --input "${GWR_VIDEO_SAMPLE_ROOT}\deaee69b-bd2f-481d-ba4d-bca20a1b4c8e.mp4" --output ".artifacts\video-auto-relocated-preset\deaee69b-auto-export-v3.mp4" --timeout-ms 360000
pnpm export:video-backend -- --input "${GWR_VIDEO_SAMPLE_ROOT}\e1997e6e-45d5-4895-ae81-a7361c05bc37.mp4" --output ".artifacts\video-auto-relocated-preset\e1997e6e-auto-export-v1.mp4" --timeout-ms 360000
pnpm export:video-backend -- --input "${GWR_VIDEO_SAMPLE_ROOT}\4d420881-c144-497f-9a6e-43beda086580.mp4" --output ".artifacts\video-auto-relocated-preset\4d420881-standard-auto-export-v1.mp4" --timeout-ms 360000
```

  - 脚本返回：
    - requested `denoiseBackend = none`
    - `actualDenoiseBackend = canvas-temporal-match-delta-stabilize`
    - `actualControls.edgeDenoiseStrength = 0.25`
    - `actualControls.videoBitrateMbps = 12`
    - `actualControls.allowLowConfidence = true`
  - 页面状态：
    - `导出完成，已处理 240 帧，后端去噪：canvas-temporal-match-delta-stabilize。音频已保留：aac，469 packets。`
  - ffprobe:
    - `deaee69b-auto-export-v3.mp4`
      - video: `h264`, `1920x1080`, `24fps`, `10.000000s`
      - audio: `aac`, `48000Hz`, `2 channels`, `10.000000s`
    - `e1997e6e-auto-export-v1.mp4`
      - video: `h264`, `1920x1080`, `24fps`, `10.000000s`
      - audio: `aac`, `48000Hz`, `2 channels`, `10.000000s`
    - `4d420881-standard-auto-export-v1.mp4`
      - actual backend: `none`
      - video: `h264`, `1920x1080`, `24fps`, `10.000000s`
      - audio: `aac`, `48000Hz`, `2 channels`, `10.000000s`
  - 输出：
    - `.artifacts/video-auto-relocated-preset/deaee69b-auto-export-v3.mp4`
    - `.artifacts/video-auto-relocated-preset/e1997e6e-auto-export-v1.mp4`
    - `.artifacts/video-auto-relocated-preset/4d420881-standard-auto-export-v1.mp4`
- 自动路径可视化对比：
  - 生成脚本：
    - `pnpm render:video-comparison-grid`
  - full 4-up：
    - `.artifacts/video-auto-relocated-preset/comparison/deaee69b-full-4up.mp4`
    - `.artifacts/video-auto-relocated-preset/comparison/e1997e6e-full-4up.mp4`
    - `.artifacts/video-auto-relocated-preset/comparison/4d420881-full-4up.mp4`
    - ffprobe: `1280x720`, `24fps`, `10.000000s`
  - ROI 4-up：
    - `.artifacts/video-auto-relocated-preset/comparison/deaee69b-roi-4up.mp4`
    - `.artifacts/video-auto-relocated-preset/comparison/e1997e6e-roi-4up.mp4`
    - `.artifacts/video-auto-relocated-preset/comparison/4d420881-roi-4up.mp4`
    - crop: `left=1676, top=836, width=200, height=200`
    - ffprobe: `640x640`, `24fps`, `10.000000s`
  - 对比说明：
    - 这组对比视频使用自动导出输出，不再依赖手动 UI preset 产物。
    - `deaee69b` / `e1997e6e` 用于看 relocated/inset 水印残影与边缘瑕疵。
    - `4d420881` 用于确认标准锚点样例没有被误套 relocated 复核预设。
- `deaee69b` lowBody warning 诊断：
  - 输入：
    - baseline frames: `.artifacts/video-lowbody-regression/deaee69b-baseline-sheet-frames`
    - auto preset frames: `.artifacts/video-lowbody-regression/deaee69b-auto-sheet-frames`
    - reference frames: `.artifacts/video-lowbody-regression/deaee69b-auto-sheet-frames`
  - 输出：
    - `.artifacts/video-lowbody-regression/deaee69b-auto-vs-baseline/latest.md`
    - `.artifacts/video-lowbody-regression/deaee69b-auto-vs-baseline/latest.json`
    - `.artifacts/video-lowbody-regression/deaee69b-auto-vs-baseline/lowbody-delta-sheet.png`
  - 结果：
    - lowBody delta: `+0.2034`
    - aggregate: `40` 个低区采样点，worsened ratio `0.5000`，improved ratio `0.5000`
    - 回归集中在低梯度 `0.00-0.04`、alpha `0.120-0.160` 的稀疏星形边界采样点。
    - 可视热力图显示不是整块 ROI 纹理破坏；仍应保持 `human-review`，但不应把它误判为大面积画质失败。
- 自动路径 benchmark / gate：
  - manifest:
    - `.artifacts/video-auto-relocated-preset/benchmark-manifest.json`
  - report:
    - `.artifacts/video-auto-relocated-preset/benchmark/latest-report.md`
  - gate:
    - `.artifacts/video-auto-relocated-preset/benchmark/gate/latest-report.md`
  - `deaee69b-auto-relocated`
    - active `-0.3889 improved`
    - edge `-0.0357 improved`
    - lowBody `+0.2034 regressed`
    - highBody `-0.5347 improved`
    - note: `sparse-low-body-regression`
  - `e1997e6e-auto-relocated`
    - active `-0.1473 improved`
    - edge `-0.1376 improved`
    - lowBody `-0.6208 improved`
    - highBody `-0.1486 improved`
  - gate decision:
    - `human-review`
    - improved cases: `2`
    - material fail layers: `0`
    - warning layers: `1`
- 更新判断：
  - relocated/inset 样例现在不再依赖用户手动记住预设按钮。
  - 默认后端仍保持保守；自动应用只在检测证据指向 relocated/inset 且用户没有手动选择其它后端时触发。
  - 标准样例 `4d420881` 验证保持 `actualDenoiseBackend=none`，未误套 relocated 复核预设。
  - 这把“可用交付”的用户路径从“必须知道隐藏候选”推进到“检测/导出自动走当前最佳人审候选”。
  - 剩余的 `deaee69b` lowBody warning 已定位为稀疏边界采样问题；下一步质量突破应继续围绕 ROI 自然纹理 / ML denoise，而不是再加大 canvas 模糊。

### 2026-06-11 Video Crop Sheet CLI Robustness

- 背景：
  - Windows PowerShell 下未加引号的 `--crop 1676,836,200,200` / `--timestamps 1,3,5,7,9` 可能被传成空格分隔参数。
  - `render:video-comparison-grid` 已支持逗号或空白分隔；`render:video-crops` 之前只支持逗号分隔。
- 更新：
  - `scripts/render-video-crop-sheet.js`
    - `parseCropBox()` 现在接受逗号或空白分隔。
    - `parseTimestampList()` 现在接受逗号或空白分隔。
  - `tests/scripts/renderVideoCropSheet.test.js`
    - 补充空白分隔 crop / timestamp 用例。
- 验证：
  - `pnpm exec node --test tests/scripts/renderVideoCropSheet.test.js tests/scripts/renderVideoComparisonGrid.test.js tests/video/videoPresetPolicy.test.js tests/video/videoAudioCopy.test.js tests/scripts/videoBackendExport.test.js tests/scripts/scriptEntrypoints.test.js tests/scripts/videoDenoiseCandidateGate.test.js`
  - 结果：`29` tests passed。

### 2026-06-11 Boundary Gradient Residual Gate Fix

- 背景：
  - `deaee69b-auto-relocated` 原 gate 为 `human-review`，唯一 warning 是 lowBody `+0.2034 regressed`。
  - 进一步诊断发现 lowBody 热点都在 alpha ROI 的边界像素，例如 `x=0/71`、`y=0/71`。
  - 旧 `buildAlphaGradientMap()` 只计算 `1..width-2` / `1..height-2` 内部像素，导致边界上的真实星形边缘梯度为 `0`，被误分到 lowBody。
- 更新：
  - `scripts/analyze-video-residual.js`
    - `buildAlphaGradientMap()` 改为 clamped Sobel，边界像素也参与梯度计算。
  - `src/video/videoCleanupBackends.js`
    - `buildGradientWeightMap()` 与内部 raw gradient 同步改为 clamped Sobel。
    - 这让实际 cleanup 权重与评估口径一致，避免星形尖点落在 ROI 边界时权重缺失。
  - 测试：
    - `tests/scripts/analyzeVideoResidual.test.js`
    - `tests/video/videoCleanupBackends.test.js`
- 旧产物重评估：
  - lowBody 诊断：
    - `.artifacts/video-lowbody-regression/deaee69b-auto-vs-baseline-boundary-gradient/latest.md`
    - `.artifacts/video-lowbody-regression/deaee69b-auto-vs-baseline-boundary-gradient/lowbody-delta-sheet.png`
  - 结果：
    - lowBody delta 从 `+0.2034` 变为 `+0.0000`
    - lowBody count 从 `40` 变为 `0`
    - 说明此前 warning 是边界桶分类错误，不是主体低区真实大面积回归。
  - 重跑旧自动导出 benchmark/gate：
    - `.artifacts/video-auto-relocated-preset/benchmark-boundary-gradient/latest-report.md`
    - `.artifacts/video-auto-relocated-preset/benchmark-boundary-gradient/gate/latest-report.md`
    - gate: `promote-default-candidate`
    - `deaee69b-auto-relocated`: active `-0.3889 improved`, edge `-0.0506 improved`, lowBody `0.0000 neutral`, highBody `-0.5299 improved`
    - `e1997e6e-auto-relocated`: active `-0.1473 improved`, edge `-0.1526 improved`, lowBody `0.0000 neutral`, highBody `-0.1450 improved`
- 新构建重新导出：
  - 构建：
    - `pnpm build`
  - 输出：
    - `.artifacts/video-boundary-gradient-auto/deaee69b-auto-boundary-gradient.mp4`
    - `.artifacts/video-boundary-gradient-auto/e1997e6e-auto-boundary-gradient.mp4`
    - `.artifacts/video-boundary-gradient-auto/4d420881-standard-boundary-gradient.mp4`
  - 导出状态：
    - `deaee69b` / `e1997e6e`
      - requested backend: `none`
      - actual backend: `canvas-temporal-match-delta-stabilize`
      - strength: `0.25`
      - bitrate: `12Mbps`
      - audio: `aac`, `469 packets`
    - `4d420881`
      - actual backend: `none`
      - 用于确认标准锚点样例没有误套 relocated preset。
  - ffprobe:
    - 三条输出均为 video `h264`, `1920x1080`, `24fps`, `10.000000s`
    - 三条输出均保留 audio `aac`, `48000Hz`, `2 channels`, `10.000000s`
- 新产物 benchmark/gate：
  - manifest:
    - `.artifacts/video-boundary-gradient-auto/benchmark-manifest.json`
  - report:
    - `.artifacts/video-boundary-gradient-auto/benchmark/latest-report.md`
  - gate:
    - `.artifacts/video-boundary-gradient-auto/benchmark/gate/latest-report.md`
  - gate decision:
    - `promote-default-candidate`
    - improved cases: `2`
    - material fail layers: `0`
    - warning layers: `0`
  - 新产物 deltas:
    - `deaee69b-auto-relocated`
      - active `-0.3637 improved`
      - edge `-0.0180 neutral`
      - lowBody `0.0000 neutral`
      - highBody `-0.5078 improved`
    - `e1997e6e-auto-relocated`
      - active `-0.1478 improved`
      - edge `-0.0859 improved`
      - lowBody `0.0000 neutral`
      - highBody `-0.1736 improved`
- 新产物可视化对比：
  - full 4-up：
    - `.artifacts/video-boundary-gradient-auto/comparison/deaee69b-full-4up.mp4`
    - `.artifacts/video-boundary-gradient-auto/comparison/e1997e6e-full-4up.mp4`
    - ffprobe: `1280x720`, `24fps`, `10.000000s`
  - ROI 4-up：
    - `.artifacts/video-boundary-gradient-auto/comparison/deaee69b-roi-4up.mp4`
    - `.artifacts/video-boundary-gradient-auto/comparison/e1997e6e-roi-4up.mp4`
    - crop: `left=1676, top=836, width=200, height=200`
    - ffprobe: `640x640`, `24fps`, `10.000000s`
- 验证：
  - `pnpm exec node --test tests/scripts/analyzeVideoResidual.test.js tests/video/videoCleanupBackends.test.js tests/scripts/renderVideoCropSheet.test.js tests/scripts/renderVideoComparisonGrid.test.js tests/video/videoPresetPolicy.test.js tests/video/videoAudioCopy.test.js tests/scripts/videoBackendExport.test.js tests/scripts/scriptEntrypoints.test.js tests/scripts/videoCropBenchmark.test.js tests/scripts/videoCropBenchmarkReport.test.js tests/scripts/videoDenoiseCandidateGate.test.js`
  - 结果：`71` tests passed。
- 更新判断：
  - relocated 自动 preset 已从 `human-review` 推进为当前 benchmark 口径下的 `promote-default-candidate`。
  - 这不等于视频 V2 质量完全完成；仍需人工看新 4-up，并最好补一个更大样本集 / 控制组层后再把该 preset 视作正式默认策略。
  - 但“轻微瑕疵”中 lowBody warning 的主要疑点已经被证据排除，下一步应是 default promotion 审核与更大样本验证，而不是继续针对这个 warning 调参。

### 2026-06-11 Video Delivery Gate

- 背景：
  - `benchmark:video-crops`、`report:video-crops`、`gate:video-denoise` 已经能分别产出证据，但交付前需要一个单命令入口确认当前候选仍满足视频交付准入。
  - 上一节的 boundary-gradient 自动 preset 已达到 `promote-default-candidate`；这一步把该证据固化为可复跑交付检查。
- 新增：
  - `scripts/run-video-delivery-gate.js`
  - `package.json`
    - `pnpm gate:video-delivery`
  - `tests/scripts/videoDeliveryGate.test.js`
- 入口行为：
  - 读取视频 benchmark manifest。
  - 运行 `video-crop-benchmark`。
  - 生成 benchmark Markdown。
  - 运行 denoise candidate gate。
  - 生成最终 delivery report。
  - 默认要求候选决策达到 `promote-default-candidate`。
- 本轮实跑：

```powershell
pnpm gate:video-delivery -- --manifest ".artifacts\video-boundary-gradient-auto\benchmark-manifest.json" --output-dir ".artifacts\video-boundary-gradient-auto\delivery-gate"
```

  - 输出：
    - `.artifacts/video-boundary-gradient-auto/delivery-gate/latest-delivery-report.json`
    - `.artifacts/video-boundary-gradient-auto/delivery-gate/latest-delivery-report.md`
    - `.artifacts/video-boundary-gradient-auto/delivery-gate/benchmark/latest-summary.json`
    - `.artifacts/video-boundary-gradient-auto/delivery-gate/benchmark/latest-report.md`
    - `.artifacts/video-boundary-gradient-auto/delivery-gate/gate/latest-report.json`
    - `.artifacts/video-boundary-gradient-auto/delivery-gate/gate/latest-report.md`
  - 结果：
    - status: `ready-for-visual-review`
    - ready: `yes`
    - blockers: none
    - benchmark: total `4`, rendered `4`, comparisons `4`, failed `0`
    - best candidate: `canvas-temporal-match-delta-stabilize, strength=0.25`
    - decision: `promote-default-candidate`
    - improved cases: `2`
    - material fail layers: `0`
    - warning layers: `0`
- 验证：
  - `pnpm exec node --test tests/scripts/videoDeliveryGate.test.js tests/scripts/scriptEntrypoints.test.js tests/scripts/videoDenoiseCandidateGate.test.js tests/scripts/videoCropBenchmark.test.js tests/scripts/videoCropBenchmarkReport.test.js`
  - 结果：`31` tests passed。
- 更新判断：
  - 当前视频目标已有单命令交付准入，可复跑地证明 boundary-gradient 自动 preset 仍处于 `ready-for-visual-review`。
  - 下一步更像产品交付流程：人工看 `.artifacts/video-boundary-gradient-auto/comparison/*-4up.mp4`，若接受，再决定是否把 relocated 自动 preset 作为正式默认能力记录到 release readiness / release notes。

### 2026-06-11 Video Review Pack

- 背景：
  - delivery gate 已证明候选状态，但人工验收仍需要集中入口：哪些视频要看、视频规格是否正常、每个视频里四宫格分别代表什么、应该检查哪些风险。
- 新增：
  - `scripts/create-video-review-pack.js`
  - `package.json`
    - `pnpm report:video-review-pack`
  - `tests/scripts/videoReviewPack.test.js`
- 入口行为：
  - 默认读取：
    - `.artifacts/video-boundary-gradient-auto/delivery-gate/latest-delivery-report.json`
    - `.artifacts/video-boundary-gradient-auto/comparison/*.mp4.json`
  - 对每个 4-up MP4 跑 `ffprobe`。
  - 生成 Markdown / JSON review pack。
  - Markdown 中包含：
    - delivery/gate 状态
    - full / ROI 视频路径
    - 视频尺寸、帧率、时长
    - 每个 4-up 的输入来源
    - 人工复核 checklist
- 本轮实跑：

```powershell
pnpm report:video-review-pack
```

  - 输出：
    - `.artifacts/video-boundary-gradient-auto/review-pack/latest-review-pack.md`
    - `.artifacts/video-boundary-gradient-auto/review-pack/latest-review-pack.json`
  - 状态：
    - delivery status: `ready-for-visual-review`
    - ready: `yes`
    - blockers: none
    - best candidate: `canvas-temporal-match-delta-stabilize, strength=0.25`
  - 收录视频：
    - `.artifacts/video-boundary-gradient-auto/comparison/deaee69b-full-4up.mp4`
      - `1280x720`, `24fps`, `10.000s`
    - `.artifacts/video-boundary-gradient-auto/comparison/deaee69b-roi-4up.mp4`
      - `640x640`, `24fps`, `10.000s`
    - `.artifacts/video-boundary-gradient-auto/comparison/e1997e6e-full-4up.mp4`
      - `1280x720`, `24fps`, `10.000s`
    - `.artifacts/video-boundary-gradient-auto/comparison/e1997e6e-roi-4up.mp4`
      - `640x640`, `24fps`, `10.000s`
  - checklist:
    - ROI 4-up 检查 auto boundary 面板中是否仍有明显星形残影、亮/暗边框或突兀色块。
    - Full 4-up 检查水印区域外是否出现全局损伤或色彩跳变。
    - Temporal 检查 0s 到 10s 是否有闪烁、跳动或局部纹理呼吸。
    - Sentinel 确认标准锚点样例仍未误套 relocated preset。
- 验证：
  - `pnpm exec node --test tests/scripts/videoReviewPack.test.js tests/scripts/videoDeliveryGate.test.js tests/scripts/scriptEntrypoints.test.js tests/scripts/renderVideoComparisonGrid.test.js tests/scripts/videoDenoiseCandidateGate.test.js tests/scripts/videoCropBenchmark.test.js tests/scripts/videoCropBenchmarkReport.test.js`
  - 结果：`36` tests passed。
- 更新判断：
  - 当前任务已有“可看视频 + 可复跑 gate + 人工复核清单”闭环。
  - 如果人工看 ROI / full 4-up 接受，下一步可以进入 release readiness 集成；如果仍看到局部瑕疵，应按 review pack 中对应 case/frame 继续针对性诊断。

### 2026-06-11 Release Readiness Video Review Lane

- 背景：
  - review pack 已经证明“材料可看”，但总 release readiness 之前只能看到视频默认安全、视频 denoise gate、alpha-shape gate 等分散 lane。
  - 本轮把 delivery gate / review pack 接入总 readiness，作为独立 `video-review-delivery` lane。
- 新增/更新：
  - `scripts/create-release-readiness-report.js`
    - `DEFAULT_INPUTS.videoDeliveryGate`
      - `.artifacts/video-boundary-gradient-auto/delivery-gate/latest-delivery-report.json`
    - `DEFAULT_INPUTS.videoReviewPack`
      - `.artifacts/video-boundary-gradient-auto/review-pack/latest-review-pack.json`
    - 新增 `summarizeVideoReviewDelivery()`
    - capability decisions 新增 `video-review-delivery`
  - `tests/scripts/releaseReadinessReport.test.js`
    - 增加 delivery gate / review pack fixture。
    - 验证 `video-review-delivery` 为 `ready-for-visual-review`。
- 本轮实跑：

```powershell
pnpm release:readiness
```

  - 输出：
    - `.artifacts/release-readiness/latest-report.json`
    - `.artifacts/release-readiness/latest-report.md`
  - 总体 recommendation：
    - `rc-current-image-defaults-with-scoped-claims`
  - 视频相关 lane：
    - `video-production-defaults`
      - status: `safe-current-defaults`
      - releaseEligible: `true`
      - defaultDenoiseBackend: `none`
      - reviewPresetMarkedReviewOnly: `true`
    - `video-review-delivery`
      - status: `ready-for-visual-review`
      - releaseEligible: `true`
      - reviewComparisonCount: `4`
      - reviewViews: `full`, `roi`
      - best candidate: `canvas-temporal-match-delta-stabilize, strength=0.25`
      - decision: `promote-default-candidate`
      - material fail layers: `0`
      - warning layers: `0`
    - `video-denoise-v2`
      - status: `experiment-only`
      - releaseEligible: `false`
      - 仍阻断 broad/default denoise claim，因为旧多层 denoise gate 中没有 promoted default candidate，且旧 canvas 候选被 reject。
    - `video-alpha-shape`
      - status: `experiment-only`
      - releaseEligible: `false`
      - 仍阻断 alpha-shape default claim。
  - capability decisions：
    - `video-review-delivery`: `ready-for-visual-review`
    - `video-denoise-default`: `experiment-only`
    - `video-v2-allenk-parity`: `blocked`
- 验证：
  - `pnpm exec node --test tests/scripts/releaseReadinessReport.test.js tests/scripts/videoDeliveryGate.test.js tests/scripts/videoReviewPack.test.js tests/scripts/scriptEntrypoints.test.js`
  - 结果：`19` tests passed。
- 更新判断：
  - 视频候选现在已经进入总 readiness 视野：可明确区分“复核材料已就绪”和“尚不能宣称 allenk parity / 默认 denoise 正式发布”。
  - 下一步若人工视觉接受，应刷新或扩展视频 denoise gate 输入，让新的 boundary-gradient delivery gate 进入正式 release claim 流程；在此之前，release 文案仍应保持 scoped/review wording。

### 2026-06-11 Review Snapshot Contact Sheets

- 背景：
  - review pack 已列出 full / ROI 4-up MP4，但播放前仍需要快速扫关键帧。
  - 本轮从 4 个 boundary-gradient 4-up 视频抽取约 `0s/2s/4s/6s/8s` 帧，生成静态 contact sheet。
- 命令形态：
  - `ffmpeg -i <4up.mp4> -vf "fps=1/2,scale=320:-2,tile=5x1" -frames:v 1 <contact.png>`
- 输出：
  - `.artifacts/video-boundary-gradient-auto/review-snapshots/deaee69b-full-contact.png`
  - `.artifacts/video-boundary-gradient-auto/review-snapshots/deaee69b-roi-contact.png`
  - `.artifacts/video-boundary-gradient-auto/review-snapshots/e1997e6e-full-contact.png`
  - `.artifacts/video-boundary-gradient-auto/review-snapshots/e1997e6e-roi-contact.png`
- `report:video-review-pack` 更新：
  - `scripts/create-video-review-pack.js`
    - 自动扫描 `.artifacts/video-boundary-gradient-auto/review-snapshots/*-contact.png`
    - 在 review pack 的 Videos 表中列出 Snapshot 路径。
  - `tests/scripts/videoReviewPack.test.js`
    - 验证 Markdown 暴露 snapshot 路径。
- 快速视觉观察：
  - `deaee69b` ROI：
    - auto boundary 基本没有星形轮廓残留。
    - 与 allenk 相比没有明显整体压暗；边缘没有明显块状破坏。
  - `e1997e6e` ROI：
    - 星形残影基本不可见，纹理连续。
    - 第 1 帧仍有轻微柔化感，但未见明显亮边/暗边。
  - `deaee69b` full：
    - 未见水印区域外明显副作用。
    - auto boundary 与 baseline/allenk 的全局画面基本一致。
  - `e1997e6e` full：
    - 未见明显全局误伤或色彩跳变。
- 验证：
  - `pnpm report:video-review-pack`
  - `pnpm exec node --test tests/scripts/videoReviewPack.test.js tests/scripts/videoDeliveryGate.test.js tests/scripts/scriptEntrypoints.test.js tests/scripts/releaseReadinessReport.test.js`
  - 结果：`19` tests passed。
- 更新判断：
  - 静态关键帧检查未发现阻断交付的明显残影或画面外误伤。
  - 仍需要播放 ROI 4-up 做时间连续性确认；如果播放也通过，当前样例可进入人工接受 / 默认策略复核。

### 2026-06-11 Boundary Gradient Temporal Residual Review

- 背景：
  - 静态 contact sheet 已显示 boundary-gradient auto preset 在 `deaee69b` / `e1997e6e` 的 ROI 中明显降低星形残影。
  - 但视频交付还需要确认时间连续性，尤其是水印区域是否出现闪烁、跳动或局部纹理呼吸。
- 脚本更新：
  - `scripts/run-video-temporal-residual-lab.js`
    - 新增 `--include-variants`。
    - 默认仍只跑 baseline；只有显式开启时才纳入 `tags` 含 `variant` 的候选输出。
    - Markdown 报告现在记录 `Include variants`。
  - `tests/scripts/videoTemporalResidualLab.test.js`
    - 覆盖 `selectTemporalResidualCases()`，确认默认不含 variant、开启后才包含候选。
  - `scripts/create-video-review-pack.js`
    - 默认读取 `.artifacts/video-boundary-gradient-auto/temporal-residual/latest-report.json`。
    - 在 review pack 中新增 `Temporal Residual` 表和 evidence 链接。
  - `tests/scripts/videoReviewPack.test.js`
    - 验证 review pack 暴露 temporal report 与 jitter 摘要。
- 本轮命令：
  - `pnpm lab:video-temporal-residual -- --manifest .artifacts/video-boundary-gradient-auto/benchmark-manifest.json --output-dir .artifacts/video-boundary-gradient-auto/temporal-residual --cases 'deaee69b,deaee69b-auto-relocated,e1997e6e,e1997e6e-auto-relocated' --include-variants`
  - `pnpm report:video-review-pack`
- 输出：
  - `.artifacts/video-boundary-gradient-auto/temporal-residual/latest-report.md`
  - `.artifacts/video-boundary-gradient-auto/temporal-residual/latest-report.json`
  - `.artifacts/video-boundary-gradient-auto/temporal-residual/deaee69b-temporal-residual.png`
  - `.artifacts/video-boundary-gradient-auto/temporal-residual/deaee69b-auto-relocated-temporal-residual.png`
  - `.artifacts/video-boundary-gradient-auto/temporal-residual/e1997e6e-temporal-residual.png`
  - `.artifacts/video-boundary-gradient-auto/temporal-residual/e1997e6e-auto-relocated-temporal-residual.png`
  - `.artifacts/video-boundary-gradient-auto/review-pack/latest-review-pack.md`
  - `.artifacts/video-boundary-gradient-auto/review-pack/latest-review-pack.json`
- 指标摘要：

| Case | Same jitter | Matched jitter | Improvement | Improved/Worsened |
|---|---:|---:|---:|---:|
| `deaee69b` | `9.1941` | `10.3717` | `-1.1775` | `0.3163 / 0.4509` |
| `deaee69b-auto-relocated` | `9.3522` | `10.4506` | `-1.0984` | `0.3341 / 0.4274` |
| `e1997e6e` | `10.1547` | `13.9169` | `-3.7622` | `0.3275 / 0.4190` |
| `e1997e6e-auto-relocated` | `10.3201` | `13.9793` | `-3.6592` | `0.3453 / 0.4029` |

- 快速视觉观察：
  - `deaee69b-auto-relocated`：
    - temporal heatmap 的能量主要集中在 alpha 星形区域内。
    - 未见水印区域外大面积扩散型跳变。
  - `e1997e6e-auto-relocated`：
    - heatmap 同样集中在 mask 内，未见全 ROI 异常闪烁信号。
    - 同坐标 jitter 略高于 baseline，但 matched 后的负向幅度和 worsened ratio 略低。
- 更新判断：
  - temporal lab 没有给出“明显时序恶化”的阻断信号。
  - 但 matched jitter 不支持把当前候选直接判为最终通过；它更适合作为人工播放复核的辅助证据。
  - 当前最稳妥表述：
    - `boundary-gradient auto preset` 已具备可查看的 full / ROI 4-up 视频、静态快照、delivery gate、temporal residual 辅助证据。
    - 在用户播放 ROI 4-up 并接受轻微柔化/残影之前，仍保持 `ready-for-visual-review`，不宣称 allenk parity。
- 下一步：
  - 播放 `.artifacts/video-boundary-gradient-auto/comparison/*-roi-4up.mp4`，重点看 0s-10s 的水印区域是否有可感知闪烁或边缘跳动。
  - 若人工接受，刷新 release readiness 或扩展 video-denoise gate，让 boundary-gradient delivery gate 能进入更正式的 default/preset claim。
  - 若仍看到轻微瑕疵，优先做“mask 内低强度 temporal smoothing / confidence-gated polish”，不要重新追求完美反解。

### 2026-06-11 Delivery Gate Temporal Residual Integration

- 背景：
  - 上一节 temporal residual report 仍是辅助材料；delivery gate 只看 benchmark/gate 时，容易把“有时序证据”误读成“已纳入准入”。
  - 本轮把 temporal residual 转成 delivery gate 的正式检查层。
- 脚本更新：
  - `scripts/run-video-delivery-gate.js`
    - 新增 `summarizeTemporalResidualReadiness()`。
    - 新增 `--temporal-report <json>`，默认读取 `.artifacts/video-boundary-gradient-auto/temporal-residual/latest-report.json`。
    - 新增 `--no-temporal-report`，用于旧实验或无 temporal report 的场景。
    - delivery Markdown 新增 `Temporal Residual` 小节。
  - temporal gate 规则：
    - 以同一素材 baseline 为参照，而不是用绝对 jitter 阈值。
    - 当前候选通过 `*-auto-relocated` 推断 baseline id。
    - material blocker：
      - same jitter 增量超过 `max(1.0, baseline * 10%)`。
      - matched jitter 增量超过 `max(1.0, baseline * 10%)`。
      - worsened ratio 增量超过 `0.05`。
    - warning：
      - same/matched jitter 增量超过 `max(0.5, baseline * 5%)`。
      - worsened ratio 增量超过 `0.02`。
  - `scripts/create-release-readiness-report.js`
    - `video-review-delivery` evidence 现在透传：
      - `temporalStatus`
      - `temporalBlockers`
      - `temporalWarnings`
      - `temporalComparisons`
  - 测试：
    - `tests/scripts/videoDeliveryGate.test.js`
      - 覆盖 temporal pass、material regression block、Markdown 输出。
    - `tests/scripts/releaseReadinessReport.test.js`
      - 覆盖 readiness lane 中的 `temporalStatus` / `temporalComparisons`。
- 本轮命令：
  - `pnpm gate:video-delivery -- --manifest .artifacts/video-boundary-gradient-auto/benchmark-manifest.json --output-dir .artifacts/video-boundary-gradient-auto/delivery-gate`
  - `pnpm report:video-review-pack`
  - `pnpm release:readiness`
- 最新 delivery gate：
  - 输出：
    - `.artifacts/video-boundary-gradient-auto/delivery-gate/latest-delivery-report.md`
    - `.artifacts/video-boundary-gradient-auto/delivery-gate/latest-delivery-report.json`
  - 状态：
    - `status = ready-for-visual-review`
    - `ready = true`
    - `blockers = []`
    - `temporal.status = pass`
    - `temporal.blockers = []`
    - `temporal.warnings = []`
  - temporal delta：

| Candidate | Baseline | Same Δ | Matched Δ | Worsened Δ | Decision |
|---|---|---:|---:|---:|---|
| `deaee69b-auto-relocated` | `deaee69b` | `0.1581` | `0.0789` | `-0.0235` | `pass` |
| `e1997e6e-auto-relocated` | `e1997e6e` | `0.1655` | `0.0624` | `-0.0161` | `pass` |

- 最新 release readiness：
  - 输出：
    - `.artifacts/release-readiness/latest-report.md`
    - `.artifacts/release-readiness/latest-report.json`
  - recommendation：
    - `rc-current-image-defaults-with-scoped-claims`
  - `video-review-delivery` lane：
    - `status = ready-for-visual-review`
    - `releaseEligible = true`
    - `temporalStatus = pass`
    - `temporalComparisons = 2`
- 验证：
  - `pnpm exec node --test tests/scripts/videoDeliveryGate.test.js tests/scripts/videoReviewPack.test.js tests/scripts/videoTemporalResidualLab.test.js tests/scripts/releaseReadinessReport.test.js tests/scripts/scriptEntrypoints.test.js`
  - 结果：`25` tests passed。
- 更新判断：
  - 当前 boundary-gradient auto preset 的复核材料不再只是“视频 + 截图 + 辅助 temporal report”，而是 delivery gate 已正式检查 temporal regression。
  - 这将状态推进到更强的 `ready-for-visual-review`：
    - 单帧/多时间点 residual gate 通过。
    - temporal delta gate 通过。
    - full / ROI 4-up 视频和 contact sheet 已生成。
  - 仍不宣称 allenk parity，也不直接改成全局默认；最终进入默认策略前还需要用户播放接受 ROI 4-up 的轻微柔化/残影。

### 2026-06-11 Static Video Review Index

- 背景：
  - review pack 已列出视频路径，但在聊天/Markdown 中本地 MP4 渲染不一定稳定。
  - 为了让人工复核更顺手，本轮新增一个无需 dev server 的静态 HTML 页面，直接嵌入 full / ROI 4-up 视频、contact sheet、temporal gate 和 checklist。
- 新增脚本：
  - `scripts/create-video-review-index.js`
  - `package.json`
    - 新增 `pnpm report:video-review-index`
  - `tests/scripts/videoReviewIndex.test.js`
    - 验证 HTML 内嵌相对视频路径、snapshot 路径、temporal gate 与 checklist。
  - `tests/scripts/scriptEntrypoints.test.js`
    - 验证新脚本入口。
- 命令：
  - `pnpm report:video-review-index`
- 输出：
  - `.artifacts/video-boundary-gradient-auto/review-pack/latest-review-index.html`
- 生成结果：
  - `videos = 4`
  - `temporal = pass`
  - 页面提供同步复核控件：
    - `Play all`
    - `Pause`
    - `Reset`
    - `0s / 2s / 4s / 6s / 8s / 9.5s` 同步跳转
    - `Loop`
    - `Speed 0.5x / 1x / 1.5x / 2x`
  - 页面提供人工决策面板：
    - `Pending`
    - `Accept current preset`
    - `Needs light polish`
    - `Reject candidate`
    - 备注文本框。
    - checklist 状态与备注会保存在浏览器 `localStorage`。
    - `Export decision JSON` 可导出当前复核结论、备注、checklist、视频时间点、候选与 gate 状态。
  - 页面内嵌：
    - `../comparison/deaee69b-roi-4up.mp4`
    - `../comparison/deaee69b-full-4up.mp4`
    - `../comparison/e1997e6e-roi-4up.mp4`
    - `../comparison/e1997e6e-full-4up.mp4`
  - 页面使用相对路径，可以直接打开 HTML 文件复核，不需要启动本地开发服务。
- 浏览器验证：
  - 用 Playwright 打开 `file://` 页面，不启动 dev server。
  - DOM 检查：
    - `video.review-video = 4`
    - `roi videos = 2`
    - `full videos = 2`
    - playback controls 存在。
    - seek buttons = `6`。
    - 点击 `4s` 后四个视频都到 `4.00s`。
    - `Loop` / `Speed 2x` 可同步应用到四个视频。
    - Decision 面板可保存 `needs-polish` 草稿。
    - 导出 JSON 包含：
      - `decision`
      - `notes`
      - `checklist = 5`
      - `videos = 4`
      - `temporalStatus = pass`
      - 四个视频当前时间点均为 `4.00s`
    - `Temporal Gate` 存在，状态 `pass`。
  - 截图：
    - `.artifacts/video-boundary-gradient-auto/review-pack/latest-review-index.png`
    - `.artifacts/video-boundary-gradient-auto/review-pack/latest-review-index-seek.png`
    - `.artifacts/video-boundary-gradient-auto/review-pack/latest-review-index-decision.png`
  - 示例导出：
    - `.artifacts/video-boundary-gradient-auto/review-pack/latest-review-decision-sample.json`
- 更新判断：
  - 当前人工复核入口更完整：
    - HTML 播放页用于直接观看连续视频。
    - 同步播放控件用于同时扫 ROI / full-frame 连续性。
    - Decision 面板用于把人工复核结论转成可保存/可提交的 JSON 证据。
    - Markdown / JSON review pack 用于审计路径和证据。
    - delivery gate / release readiness 用于准入状态判断。
  - 下一步仍是人工播放 ROI 4-up；若接受，则可以把当前 boundary-gradient auto preset 进入默认策略复核，而不是继续盲目调残影参数。

### 2026-06-11 Video Review Decision Report

- 背景：
  - 静态 HTML 已能导出人工复核 decision JSON，但还需要一个项目内工具把它归一化为可审计状态。
  - 本轮新增 decision report，用于区分：
    - `accepted-for-default-review`
    - `prefer-current-default-candidate`
    - `prefer-light-polish-candidate`
    - `needs-polish`
    - `rejected`
    - `pending`
    - `invalid`
- 新增脚本：
  - `scripts/create-video-review-decision-report.js`
    - 输入：HTML 导出的 decision JSON。
    - 输出：标准 JSON + Markdown 报告。
    - 不接入 release gate，不改变生产默认，仅用于把人工复核结论转成 evidence。
  - `package.json`
    - 新增 `pnpm report:video-review-decision`
  - `tests/scripts/videoReviewDecisionReport.test.js`
    - 覆盖 full accept。
    - 覆盖 `needs-polish`。
    - 覆盖 accept 但 checklist 未完成时降级为 `needs-polish`。
    - 覆盖 `review-only` polish comparison：
      - `prefer-current` + checklist 全勾 -> `prefer-current-default-candidate`。
      - `prefer-light` + checklist 全勾 -> `prefer-light-polish-candidate`。
      - `prefer-light` 但 checklist 未完成 -> 降级为 `needs-polish`。
- 判定规则：
  - `deliveryStatus` 必须是 `ready-for-visual-review`。
  - `temporalStatus` 必须是 `pass`。
  - 必须有视频记录。
  - 同时具备 `roi` 和 `full` 视图时证据更完整。
  - `Accept current preset` 只有在 checklist 全部勾选时才进入 `accepted-for-default-review`。
  - checklist 未完成的 `accept` 会降级为 `needs-polish`，避免误升默认策略复核。
  - `review-only` polish comparison 是独立复核模式：
    - 允许 `deliveryStatus = review-only`。
    - 允许 `temporalStatus = available`。
    - 始终带 `review-only-polish-comparison` warning，避免把备选对比页误当默认发布 gate。
    - `prefer-current` 表示保留当前 `0.25`，进入默认策略复核。
    - `prefer-light` 表示 `0.20` 值得继续窄 sweep 或进入轻 polish 复核。
    - checklist 未完成的 `prefer-current` / `prefer-light` 仍会降级为 `needs-polish`。
- 本轮命令：
  - `node scripts/create-video-review-decision-report.js --decision .artifacts/video-boundary-gradient-auto/review-pack/latest-review-decision-sample.json --output .artifacts/video-boundary-gradient-auto/review-pack/latest-review-decision-report.json --markdown .artifacts/video-boundary-gradient-auto/review-pack/latest-review-decision-report.md`
- 输出：
  - `.artifacts/video-boundary-gradient-auto/review-pack/latest-review-decision-report.md`
  - `.artifacts/video-boundary-gradient-auto/review-pack/latest-review-decision-report.json`
- 样例报告结果：
  - 注意：这是自动化验证生成的 sample，不是最终人工接受结论。
  - `status = needs-polish`
  - `decision = needs-polish`
  - `nextAction = run-light-polish-pass-before-default-review`
  - `deliveryStatus = ready-for-visual-review`
  - `temporalStatus = pass`
  - `checklist = 1/5 checked`
  - `videos = 4 (full, roi)`
  - `warnings = decision-checklist-incomplete`
- 验证：
  - `pnpm exec node --test tests/scripts/videoReviewDecisionReport.test.js`
  - 结果：`6` tests passed。
- 更新判断：
  - 当前复核闭环进一步完整：
    - HTML 页面负责人工观看与导出 decision JSON。
    - decision report 负责把 JSON 标准化为可审计状态和下一步动作。
  - 一旦真实人工复核选择 `Accept current preset` 且 checklist 全部勾选，report 会给出 `accepted-for-default-review`，可作为后续默认策略复核的输入。
  - 当前 sample 仍是 `needs-polish`，因此 goal 仍不应标完成。

### 2026-06-11 Light Polish Strength 0.20 Candidate

- 背景：
  - sample decision report 给出的 next action 是 `run-light-polish-pass-before-default-review`。
  - 这不是用户真实最终复核结论，但可以作为一个窄实验：在当前 `strength=0.25` 附近尝试更轻的 `strength=0.20`，看是否减少柔化/边缘瑕疵。
- 导出参数：
  - `denoiseBackend = canvas-temporal-match-delta-stabilize`
  - `edgeDenoiseStrength = 0.20`
  - `videoBitrate = 12000000`
  - `allowLowConfidence = true`
- 导出命令形态：
  - `node scripts/export-video-backend-variant.js --input <sample.mp4> --output .artifacts/video-light-polish-strength020/<case>-strength020.mp4 --denoise-backend canvas-temporal-match-delta-stabilize --edge-denoise-strength 0.20 --video-bitrate 12000000 --allow-low-confidence`
- 输出：
  - `.artifacts/video-light-polish-strength020/deaee69b-strength020.mp4`
  - `.artifacts/video-light-polish-strength020/e1997e6e-strength020.mp4`
  - 两个输出均为 `1920x1080 / 24fps / 10s`，音频已保留。
- Benchmark / gate：
  - manifest：
    - `.artifacts/video-light-polish-strength020/benchmark-manifest.json`
  - benchmark：
    - `.artifacts/video-light-polish-strength020/benchmark/latest-summary.json`
    - `.artifacts/video-light-polish-strength020/benchmark/latest-report.md`
  - gate：
    - `.artifacts/video-light-polish-strength020/gate/latest-report.json`
    - `.artifacts/video-light-polish-strength020/gate/latest-report.md`
  - gate 结果：
    - `canvas-temporal-match-delta-stabilize, strength=0.2`: `promote-default-candidate`
    - `canvas-temporal-match-delta-stabilize, strength=0.25`: `promote-default-candidate`
    - 两者都只有单层 video benchmark 证据，因此仍是 visual-review 级别，不是 allenk parity 或默认发布证据。
- Variant delta 摘要：

| Case | Strength | Active Δ | Edge Δ | LowBody Δ | HighBody Δ |
|---|---:|---:|---:|---:|---:|
| `deaee69b` | `0.25` | `-0.3637` improved | `-0.0180` neutral | `0.0000` neutral | `-0.5078` improved |
| `deaee69b` | `0.20` | `-0.3665` improved | `-0.0480` improved | `0.0000` neutral | `-0.4992` improved |
| `e1997e6e` | `0.25` | `-0.1478` improved | `-0.0859` improved | `0.0000` neutral | `-0.1736` improved |
| `e1997e6e` | `0.20` | `-0.1553` improved | `-0.0637` improved | `0.0000` neutral | `-0.1934` improved |

- Temporal residual：
  - 输出：
    - `.artifacts/video-light-polish-strength020/temporal-residual/latest-report.md`
    - `.artifacts/video-light-polish-strength020/temporal-residual/latest-report.json`
  - 摘要：

| Case | Same jitter | Matched jitter | Worsened ratio |
|---|---:|---:|---:|
| `deaee69b` baseline | `9.1941` | `10.3717` | `0.4509` |
| `deaee69b` strength `0.25` | `9.3522` | `10.4506` | `0.4274` |
| `deaee69b` strength `0.20` | `9.3082` | `10.4262` | `0.4296` |
| `e1997e6e` baseline | `10.1547` | `13.9169` | `0.4190` |
| `e1997e6e` strength `0.25` | `10.3201` | `13.9793` | `0.4029` |
| `e1997e6e` strength `0.20` | `10.3203` | `13.9868` | `0.4048` |

- 可视对比：
  - `.artifacts/video-light-polish-strength020/comparison/deaee69b-roi-4up.mp4`
  - `.artifacts/video-light-polish-strength020/comparison/e1997e6e-roi-4up.mp4`
  - `.artifacts/video-light-polish-strength020/comparison/deaee69b-full-4up.mp4`
  - `.artifacts/video-light-polish-strength020/comparison/e1997e6e-full-4up.mp4`
  - contact sheet：
    - `.artifacts/video-light-polish-strength020/comparison/deaee69b-roi-contact.png`
    - `.artifacts/video-light-polish-strength020/comparison/e1997e6e-roi-contact.png`
  - 专用轻 polish 复核入口：
    - `.artifacts/video-light-polish-strength020/review-pack/latest-polish-review-pack.json`
    - `.artifacts/video-light-polish-strength020/review-pack/latest-polish-review-index.html`
    - `.artifacts/video-light-polish-strength020/review-pack/latest-polish-review-index.png`
    - `.artifacts/video-light-polish-strength020/review-pack/latest-polish-review-decision-smoke.json`
    - `.artifacts/video-light-polish-strength020/review-pack/latest-polish-review-decision-report.md`
    - `.artifacts/video-light-polish-strength020/review-pack/latest-polish-review-decision-report.json`
  - 复核入口现在可复现生成：
    - `pnpm report:video-light-polish-review-pack`
    - `pnpm report:video-review-index -- --review-pack .artifacts/video-light-polish-strength020/review-pack/latest-polish-review-pack.json --output .artifacts/video-light-polish-strength020/review-pack/latest-polish-review-index.html`
    - `pnpm report:video-review-decision -- --decision .artifacts/video-light-polish-strength020/review-pack/latest-polish-review-decision-smoke.json --output .artifacts/video-light-polish-strength020/review-pack/latest-polish-review-decision-report.json --markdown .artifacts/video-light-polish-strength020/review-pack/latest-polish-review-decision-report.md`
  - 新增脚本 / 测试：
    - `scripts/create-video-light-polish-review-pack.js`
    - `tests/scripts/videoLightPolishReviewPack.test.js`
    - `package.json`
      - `pnpm report:video-light-polish-review-pack`
    - `tests/scripts/scriptEntrypoints.test.js`
  - 该 HTML 页面将 `0.25` 当前候选与 `0.20` 备选并排审阅，decision 选项改为：
    - `Prefer current 0.25`
    - `Prefer lighter 0.20`
    - `Needs more polish`
    - `Reject both`
  - 浏览器 smoke 验证：
    - 页面标题：`Video Light Polish Review`
    - 视频数：`4`
    - `4s` seek 后四个视频均停在 `4.00s`
    - decision JSON 导出成功：
      - `.artifacts/video-light-polish-strength020/review-pack/latest-polish-review-decision-smoke.json`
    - 重建 pack 后再次 smoke：
      - `title = Video Light Polish Review`
      - `videoCount = 4`
      - `times = [4, 4, 4, 4]`
  - smoke decision report：
    - `.artifacts/video-light-polish-strength020/review-pack/latest-polish-review-decision-report.md`
    - `.artifacts/video-light-polish-strength020/review-pack/latest-polish-review-decision-report.json`
    - `status = needs-polish`
    - `decision = prefer-light`
    - `reviewMode = polish-comparison`
    - `nextAction = run-narrow-polish-sweep-before-default-review`
    - `warnings = review-only-polish-comparison, decision-checklist-incomplete, prefer-light-decision-with-incomplete-checklist`
    - 说明：这是自动 smoke 导出的 JSON，checklist 为 `0/5`，因此不会被误升为人工结论。
- 快速观察：
  - `deaee69b`：
    - `0.20` 的 edge 指标略好于 `0.25`。
    - ROI contact sheet 中肉眼差异很小，没有明显“解柔化”的跃迁。
  - `e1997e6e`：
    - `0.20` active / highBody 略好，但 edge 与 temporal matched jitter 略弱于 `0.25`。
    - ROI contact sheet 中 `0.20` 与 `0.25` 同样差异很小。
- 更新判断：
  - `strength=0.20` 是一个可保留的人审备选，但没有足够证据替换当前 `0.25`。
  - 当前默认复核候选仍保持 `0.25`：
    - 它已进入 delivery gate / review pack / temporal gate / review index。
    - `0.20` 的收益不够明确，不能仅凭单层 gate 和极小指标差异改 preset。
  - 下一步如果真实人工复核仍认为 `0.25` 太柔，应在 HTML 里直接对比 `0.20` 4-up，再决定是否做更窄的 `0.18~0.22` 微调；否则应保持 `0.25`，进入默认策略复核。

### 2026-06-11 Light Polish Narrow Strength Sweep 0.18 / 0.22

- 背景：
  - `0.20` 与当前默认复核候选 `0.25` 的指标和人眼差异都很小。
  - 为避免只围绕一个备选点做判断，本轮补了更窄 sweep：`0.18 / 0.20 / 0.22 / 0.25`。
- 导出脚本修复：
  - `scripts/export-video-backend-variant.js`
    - 新增 `setNumericInputValue()`。
    - 自动化导出时将 `#edgeDenoiseStrength` 的 `step` 临时设为 `any`，再写入精确小数。
    - 解决 range input 对 `0.18` / `0.22` 报 `Malformed value` 的问题。
  - `tests/scripts/videoBackendExport.test.js`
    - 覆盖 `setNumericInputValue` 和 `step: 'any'`。
- 导出参数：
  - `denoiseBackend = canvas-temporal-match-delta-stabilize`
  - `edgeDenoiseStrength = 0.18` / `0.22`
  - `videoBitrate = 12000000`
  - `allowLowConfidence = true`
- 输出：
  - `.artifacts/video-light-polish-sweep018022/deaee69b-strength018.mp4`
  - `.artifacts/video-light-polish-sweep018022/deaee69b-strength022.mp4`
  - `.artifacts/video-light-polish-sweep018022/e1997e6e-strength018.mp4`
  - `.artifacts/video-light-polish-sweep018022/e1997e6e-strength022.mp4`
  - 四个输出均完成 `240` 帧处理，`actualControls.edgeDenoiseStrength` 分别为 `0.18` / `0.22`，音频已保留：`aac, 469 packets`。
- Benchmark / gate：
  - manifest：
    - `.artifacts/video-light-polish-sweep018022/benchmark-manifest.json`
  - benchmark：
    - `.artifacts/video-light-polish-sweep018022/benchmark/latest-summary.json`
    - `.artifacts/video-light-polish-sweep018022/benchmark/latest-report.md`
    - `rendered = 10 / 10`
    - `failed = 0`
  - gate：
    - `.artifacts/video-light-polish-sweep018022/gate/latest-report.json`
    - `.artifacts/video-light-polish-sweep018022/gate/latest-report.md`
  - gate 结果：
    - `strength=0.18`: `promote-default-candidate`
    - `strength=0.20`: `promote-default-candidate`
    - `strength=0.22`: `promote-default-candidate`
    - `strength=0.25`: `promote-default-candidate`
    - 注意：这仍只有单层 video benchmark 证据，不能直接等价于默认发布结论。
- Variant delta 摘要：

| Case | Strength | Active Δ | Edge Δ | LowBody Δ | HighBody Δ |
|---|---:|---:|---:|---:|---:|
| `deaee69b` | `0.18` | `-0.3712` improved | `-0.0278` improved | `0.0000` neutral | `-0.5143` improved |
| `deaee69b` | `0.20` | `-0.3665` improved | `-0.0480` improved | `0.0000` neutral | `-0.4992` improved |
| `deaee69b` | `0.22` | `-0.3682` improved | `-0.0215` improved | `0.0000` neutral | `-0.5126` improved |
| `deaee69b` | `0.25` | `-0.3637` improved | `-0.0180` neutral | `0.0000` neutral | `-0.5078` improved |
| `e1997e6e` | `0.18` | `-0.1584` improved | `-0.0922` improved | `0.0000` neutral | `-0.1860` improved |
| `e1997e6e` | `0.20` | `-0.1553` improved | `-0.0637` improved | `0.0000` neutral | `-0.1934` improved |
| `e1997e6e` | `0.22` | `-0.1261` improved | `-0.0703` improved | `0.0000` neutral | `-0.1493` improved |
| `e1997e6e` | `0.25` | `-0.1478` improved | `-0.0859` improved | `0.0000` neutral | `-0.1736` improved |

- Temporal residual：
  - 输出：
    - `.artifacts/video-light-polish-sweep018022/temporal-residual/latest-report.md`
    - `.artifacts/video-light-polish-sweep018022/temporal-residual/latest-report.json`
  - 摘要：

| Case | Same jitter | Matched jitter | Worsened ratio |
|---|---:|---:|---:|
| `deaee69b` baseline | `9.1941` | `10.3717` | `0.4509` |
| `deaee69b` strength `0.25` | `9.3522` | `10.4506` | `0.4274` |
| `deaee69b` strength `0.18` | `9.3328` | `10.4565` | `0.4307` |
| `deaee69b` strength `0.20` | `9.3082` | `10.4262` | `0.4296` |
| `deaee69b` strength `0.22` | `9.2996` | `10.3963` | `0.4251` |
| `e1997e6e` baseline | `10.1547` | `13.9169` | `0.4190` |
| `e1997e6e` strength `0.25` | `10.3201` | `13.9793` | `0.4029` |
| `e1997e6e` strength `0.18` | `10.3378` | `14.0055` | `0.4049` |
| `e1997e6e` strength `0.20` | `10.3203` | `13.9868` | `0.4048` |
| `e1997e6e` strength `0.22` | `10.3566` | `14.0273` | `0.4020` |

- 可视对比：
  - strength-only 4-up：
    - `.artifacts/video-light-polish-sweep018022/comparison/deaee69b-roi-strength-sweep-4up.mp4`
    - `.artifacts/video-light-polish-sweep018022/comparison/deaee69b-full-strength-sweep-4up.mp4`
    - `.artifacts/video-light-polish-sweep018022/comparison/e1997e6e-roi-strength-sweep-4up.mp4`
    - `.artifacts/video-light-polish-sweep018022/comparison/e1997e6e-full-strength-sweep-4up.mp4`
  - 专用 sweep 复核入口：
    - `.artifacts/video-light-polish-sweep018022/review-pack/latest-sweep-review-pack.json`
    - `.artifacts/video-light-polish-sweep018022/review-pack/latest-sweep-review-index.html`
    - `.artifacts/video-light-polish-sweep018022/review-pack/latest-sweep-review-index.png`
    - `.artifacts/video-light-polish-sweep018022/review-pack/latest-sweep-review-decision-smoke.json`
    - `.artifacts/video-light-polish-sweep018022/review-pack/latest-sweep-review-decision-report.md`
    - `.artifacts/video-light-polish-sweep018022/review-pack/latest-sweep-review-decision-report.json`
  - 复核入口现在可复现生成：
    - `pnpm report:video-polish-sweep-review-pack`
    - `pnpm report:video-review-index -- --review-pack .artifacts/video-light-polish-sweep018022/review-pack/latest-sweep-review-pack.json --output .artifacts/video-light-polish-sweep018022/review-pack/latest-sweep-review-index.html`
    - `pnpm report:video-review-decision -- --decision .artifacts/video-light-polish-sweep018022/review-pack/latest-sweep-review-decision-smoke.json --output .artifacts/video-light-polish-sweep018022/review-pack/latest-sweep-review-decision-report.json --markdown .artifacts/video-light-polish-sweep018022/review-pack/latest-sweep-review-decision-report.md`
  - 新增脚本 / 测试：
    - `scripts/create-video-polish-sweep-review-pack.js`
    - `tests/scripts/videoPolishSweepReviewPack.test.js`
    - `package.json`
      - `pnpm report:video-polish-sweep-review-pack`
    - `tests/scripts/scriptEntrypoints.test.js`
  - 页面验证：
    - title：`Video Polish Strength Sweep Review`
    - videos：`4`
    - decision options：
      - `Prefer 0.18`
      - `Prefer 0.20`
      - `Prefer 0.22`
      - `Prefer current 0.25`
    - `4s` seek 后四个视频均停在 `4.00s`。
  - smoke decision report：
    - `.artifacts/video-light-polish-sweep018022/review-pack/latest-sweep-review-decision-report.md`
    - `.artifacts/video-light-polish-sweep018022/review-pack/latest-sweep-review-decision-report.json`
    - `status = needs-polish`
    - `decision = prefer-strength018`
    - `reviewMode = polish-comparison`
    - `nextAction = run-narrow-polish-sweep-before-default-review`
    - `warnings = review-only-polish-comparison, decision-checklist-incomplete, prefer-strength018-decision-with-incomplete-checklist`
    - 说明：这是自动 smoke 导出的 JSON，checklist 为 `0/5`，因此不会被误升为人工结论。
- Decision report 更新：
  - `scripts/create-video-review-decision-report.js`
    - 新增 `prefer-strength018` -> `prefer-strength018-polish-candidate`。
    - 新增 `prefer-strength022` -> `prefer-strength022-polish-candidate`。
  - `tests/scripts/videoReviewDecisionReport.test.js`
    - 覆盖 checked narrow sweep decisions。
- 验证：
  - `pnpm exec node --test tests/scripts/videoReviewDecisionReport.test.js tests/scripts/videoReviewIndex.test.js tests/scripts/videoBackendExport.test.js tests/scripts/videoLightPolishReviewPack.test.js tests/scripts/videoPolishSweepReviewPack.test.js tests/scripts/scriptEntrypoints.test.js`
  - 结果：`13` tests passed。
- 更新判断：
  - `0.18` 的静态残差指标更有吸引力：
    - `e1997e6e` 的 active / edge 都优于 `0.20` / `0.22` / `0.25`。
    - `deaee69b` 的 active / highBody 也略优。
  - 但 `0.18` 并没有在 temporal 上形成同样明确优势：
    - `deaee69b` 的 `0.22` temporal 更好。
    - `e1997e6e` 的 `0.25` / `0.22` worsened ratio 略好。
  - 因此当前仍不应自动把默认复核候选从 `0.25` 改为 `0.18`。
  - 下一步应以 `.artifacts/video-light-polish-sweep018022/review-pack/latest-sweep-review-index.html` 做人眼复核：
    - 如果 `0.18` 肉眼明显更干净且不闪，应将 `0.18` 提升为 polish review candidate。
    - 如果差异不明显或 `0.18` 更软/更闪，应继续保留 `0.25` 作为默认复核候选。

### 2026-06-11 Video Delivery Dashboard

- 背景：
  - 当前已经有三条可审路径：
    - `0.25` 当前默认复核候选。
    - `0.20` 轻 polish 备选。
    - `0.18 / 0.20 / 0.22 / 0.25` strength sweep。
  - 这些路径各自有 HTML、report、decision JSON 和截图；单独打开容易漏看，所以本轮新增统一 dashboard 作为交付总入口。
- 新增脚本：
  - `scripts/create-video-delivery-dashboard.js`
  - `tests/scripts/videoDeliveryDashboard.test.js`
  - `package.json`
    - `pnpm report:video-delivery-dashboard`
  - `tests/scripts/scriptEntrypoints.test.js`
- 生成命令：
  - `pnpm report:video-delivery-dashboard`
- 输出：
  - `.artifacts/video-delivery-dashboard/latest-video-dashboard.html`
  - `.artifacts/video-delivery-dashboard/latest-video-dashboard.json`
  - `.artifacts/video-delivery-dashboard/latest-video-dashboard.png`
- Dashboard 内容：
  - Lane 1：`Current Candidate 0.25`
    - status：`ready-for-visual-review`
    - temporal：`pass`
    - candidate：`canvas-temporal-match-delta-stabilize, strength=0.25`
  - Lane 2：`Light Polish 0.20`
    - status：`review-only`
    - temporal：`available`
    - candidate：`strength=0.20 backup compared with current strength=0.25`
  - Lane 3：`Strength Sweep`
    - status：`review-only`
    - temporal：`available`
    - candidate：`strength sweep 0.18 / 0.20 / 0.22 / 0.25`
  - 每条 lane 都链接到：
    - review HTML
    - review pack JSON
    - gate / delivery report
    - decision report
    - decision JSON
  - 页面底部保留 rebuild commands，方便复现主候选、`0.20`、sweep 三条 review path。
- 机器可读资产检查：
  - `.artifacts/video-delivery-dashboard/latest-video-dashboard.json`
  - lanes：`3`
  - ready lanes：`3`
  - missing assets：`0`
  - 每条 lane assets：`6`
  - 每条 lane 均检查：
    - review HTML
    - screenshot
    - review pack JSON
    - gate / delivery report
    - decision report
    - decision JSON
  - decision 状态：
    - `current025`
      - `reviewStatus = needs-polish`
      - `nextAction = run-light-polish-pass-before-default-review`
      - `checklist = 1/5`
    - `polish020`
      - `reviewStatus = needs-polish`
      - `nextAction = run-narrow-polish-sweep-before-default-review`
      - `checklist = 0/5`
    - `sweep018022`
      - `reviewStatus = needs-polish`
      - `nextAction = run-narrow-polish-sweep-before-default-review`
      - `checklist = 0/5`
- 浏览器 smoke：
  - title：`Video Delivery Dashboard`
  - lanes：`3`
  - links：`18`
  - images：`3`
  - missing links：`0`
  - review status rows：`3`
  - decision JSON links：`3`
  - lane titles：
    - `Current Candidate 0.25`
    - `Light Polish 0.20`
    - `Strength Sweep`
  - 顶部状态包含：`human acceptance pending`
- 验证：
  - `pnpm exec node --test tests/scripts/videoDeliveryDashboard.test.js tests/scripts/videoReviewDecisionReport.test.js tests/scripts/videoReviewIndex.test.js tests/scripts/videoBackendExport.test.js tests/scripts/videoLightPolishReviewPack.test.js tests/scripts/videoPolishSweepReviewPack.test.js tests/scripts/scriptEntrypoints.test.js`
  - 结果：`15` tests passed。
- 更新判断：
  - Dashboard 只聚合复核入口和证据，不改变生产默认，不把 `0.18` 或 `0.20` 自动升为默认。
  - 当前 goal 仍缺真实人眼复核结论：
    - `0.25` 接受并 checklist 全勾，或
    - sweep 明确偏向 `0.18` / `0.22` 并进入后续默认候选复核。

### 2026-06-11 Video Goal Status Report

- 背景：
  - Dashboard 已经能说明三条 lane 的资产和 decision 状态，但还需要一个固定的机器可读判定来回答：当前 video goal 是否可标完成。
  - 本轮新增视频专用 goal status report，不替代 Codex goal 状态，只作为当前工作树证据。
- 新增脚本：
  - `scripts/create-video-goal-status-report.js`
  - `tests/scripts/videoGoalStatusReport.test.js`
  - `package.json`
    - `pnpm report:video-goal-status`
  - `tests/scripts/scriptEntrypoints.test.js`
- 生成命令：
  - `pnpm report:video-goal-status`
- 输出：
  - `.artifacts/video-goal-status/latest-report.json`
  - `.artifacts/video-goal-status/latest-report.md`
- 当前 status：
  - `status = incomplete`
  - `nextAction = collect-human-review-acceptance`
  - blockers：
    - `human-review-acceptance-missing`
- Requirement 结果：
  - `viewable-review-artifacts = satisfied`
  - `current-candidate-ready-for-visual-review = satisfied`
  - `alternatives-available-for-human-review = satisfied`
  - `human-acceptance-recorded = unsatisfied`
  - `progress-documentation-synced = satisfied`
- Lane 摘要：
  - `current025`
    - status：`ready-for-visual-review`
    - temporal：`pass`
    - review：`needs-polish`
    - checklist：`1/5`
  - `polish020`
    - status：`review-only`
    - temporal：`available`
    - review：`needs-polish`
    - checklist：`0/5`
  - `sweep018022`
    - status：`review-only`
    - temporal：`available`
    - review：`needs-polish`
    - checklist：`0/5`
- 验证：
  - `pnpm exec node --test tests/scripts/videoGoalStatusReport.test.js tests/scripts/videoDeliveryDashboard.test.js tests/scripts/videoReviewDecisionReport.test.js tests/scripts/videoReviewIndex.test.js tests/scripts/videoBackendExport.test.js tests/scripts/videoLightPolishReviewPack.test.js tests/scripts/videoPolishSweepReviewPack.test.js tests/scripts/scriptEntrypoints.test.js`
  - 结果：`17` tests passed。
- 更新判断：
  - 视频 review 资产、默认候选 gate/temporal、备选 review path、进度文档都已经具备可审计证据。
  - 唯一阻塞完成的要求是人工接受结论：必须至少有一条 lane 的 accepted/prefer 状态并 checklist 全勾。
  - 因此当前 Codex goal 不应标记 complete。

### 2026-06-11 Video Delivery Bundle

- 背景：
  - 用户要求设置 goal 后，当前 Codex goal 已处于 active；仓库侧新增一个可复跑的 delivery bundle，作为这个 goal 的机器可读推进面板。
  - Bundle 会按顺序重建 dashboard，再重建 goal status，最后输出汇总 JSON / Markdown；它不改变算法默认值，也不自动把人审未完成的候选升为完成。
- 新增脚本：
  - `scripts/create-video-delivery-bundle.js`
  - `scripts/create-video-acceptance-quickstart.js`
  - `scripts/verify-video-delivery-bundle.js`
  - `tests/scripts/videoDeliveryBundle.test.js`
  - `tests/scripts/videoAcceptanceQuickstart.test.js`
  - `tests/scripts/videoDeliveryBundleVerification.test.js`
  - `package.json`
    - `pnpm report:video-delivery-bundle`
    - `pnpm report:video-acceptance-quickstart`
    - `pnpm verify:video-delivery-bundle`
  - `tests/scripts/scriptEntrypoints.test.js`
- 生成命令：
  - `pnpm report:video-delivery-bundle`
- 输出：
  - `.artifacts/video-delivery-bundle/latest-report.json`
  - `.artifacts/video-delivery-bundle/latest-report.md`
  - `.artifacts/video-delivery-bundle/latest-acceptance-quickstart.md`
  - `.artifacts/video-delivery-bundle/latest-acceptance-quickstart.json`
  - `.artifacts/video-delivery-bundle/latest-acceptance-quickstart.html`
  - `.artifacts/video-delivery-bundle/latest-acceptance-quickstart.png`
  - `.artifacts/video-delivery-bundle/latest-acceptance-quickstart-screenshot.json`
  - `.artifacts/video-delivery-bundle/latest-verification-report.json`
  - `.artifacts/video-delivery-bundle/latest-verification-report.md`
  - `.artifacts/video-delivery-bundle/decision-templates/current025.decision.template.json`
  - `.artifacts/video-delivery-bundle/decision-templates/polish020.decision.template.json`
  - `.artifacts/video-delivery-bundle/decision-templates/sweep018022.decision.template.json`
- 当前 bundle 结果：
  - `status = incomplete`
  - `nextAction = collect-human-review-acceptance`
  - blockers：
    - `human-review-acceptance-missing`
  - acceptance gate：
    - `status = pending-human-review`
    - 完成要求：至少一条 lane 的 decision report 进入 accepted/prefer 状态，且 `checklist.allChecked = true`
    - decision templates：`3`
      - 每个模板默认 `decision = pending`、`checklist.checked = false`，不会误触完成。
      - 人审后编辑 `decision` / `notes` / `checklist[].checked`，再运行 bundle 中给出的 `pnpm report:video-review-decision -- ...` 命令。
    - 每条 lane 会输出：
      - review HTML 路径。
      - pending decision template 路径。
      - 建议 decision 值。
      - 把模板或导出的 `<exported-review-decision.json>` 转成对应 lane decision report 的 `pnpm report:video-review-decision -- ...` 命令。
  - dashboard：`readyLanes = 3/3`，`missingAssets = 0`
  - 当时 goal status：`satisfiedRequirements = 4/5`
  - 当前 latest goal status 已接入 bundle verifier：`satisfiedRequirements = 5/6`，新增满足项为 `delivery-bundle-verified`，唯一未满足项仍是 `human-acceptance-recorded`。
  - lane 摘要：
    - `current025`：`ready-for-visual-review` / `pass` / `needs-polish` / checklist `1/5`
    - `polish020`：`review-only` / `available` / `needs-polish` / checklist `0/5`
    - `sweep018022`：`review-only` / `available` / `needs-polish` / checklist `0/5`
- 验证：
  - `pnpm exec node --test tests/scripts/videoDeliveryBundle.test.js tests/scripts/scriptEntrypoints.test.js`
  - 结果：`4` tests passed。
  - `pnpm report:video-delivery-bundle`
  - 结果：刷新 `.artifacts/video-delivery-dashboard/*`、`.artifacts/video-goal-status/*`、`.artifacts/video-delivery-bundle/*` 和 3 个 pending decision template，状态保持 `incomplete`。
  - 后续补 acceptance gate 后重新运行同一组测试，仍为 `4` tests passed。
- 更新判断：
  - 现在“goal 是否完成”不只依赖对话上下文；可以用 `pnpm report:video-delivery-bundle` 复建当前证据。
  - Bundle 已经给出从人审页面 / pending template 到 decision report 的确切落盘命令，下一次真实人审后可以直接刷新 goal status。
  - 下一步仍不是继续盲调参数，而是先基于 dashboard 完成人审接受记录；若人审认为现有候选不够可用，再回到视频 denoise / residual gate 继续推进。

### 2026-06-11 Alpha Policy 0.35 Evidence Report

- 背景：
  - 之前 `alphaEdgePolicy=standard045-inset035` 在 denoise candidate gate 中只有一层 `12mbps` video benchmark 证据，因此被标为 `insufficient-evidence`。
  - 当前 artifact 中其实已经存在 6 组 0.35 benchmark：standard / 12mbps，以及 raw / candidate-aware / expected-aware 三种量测口径。
  - 本轮新增只读 evidence report，把这些 benchmark 汇总成一个明确结论，避免它既被误升默认，也被误丢弃。
- 新增脚本：
  - `scripts/create-video-alpha-policy-evidence-report.js`
  - `scripts/create-video-alpha-policy-review-pack.js`
  - `tests/scripts/videoAlphaPolicyEvidenceReport.test.js`
  - `tests/scripts/videoAlphaPolicyReviewPack.test.js`
  - `package.json`
    - `pnpm report:video-alpha-policy-evidence`
    - `pnpm report:video-alpha-policy-review-pack`
  - `tests/scripts/scriptEntrypoints.test.js`
- 生成命令：
  - `pnpm report:video-alpha-policy-evidence`
  - `pnpm report:video-alpha-policy-review-pack`
  - `pnpm report:video-review-index -- --review-pack .artifacts/video-alpha-policy035-review/review-pack/latest-review-pack.json --output .artifacts/video-alpha-policy035-review/review-pack/latest-review-index.html`
- 输出：
  - `.artifacts/video-alpha-policy-evidence/latest-report.json`
  - `.artifacts/video-alpha-policy-evidence/latest-report.md`
  - `.artifacts/video-alpha-policy035-review/review-pack/latest-review-pack.json`
  - `.artifacts/video-alpha-policy035-review/review-pack/latest-review-index.html`
  - `.artifacts/video-alpha-policy035-review/comparison/4d420881-roi-policy035-4up.mp4`
  - `.artifacts/video-alpha-policy035-review/comparison/4d420881-full-policy035-4up.mp4`
  - `.artifacts/video-alpha-policy035-review/comparison/deaee69b-roi-policy035-4up.mp4`
  - `.artifacts/video-alpha-policy035-review/comparison/deaee69b-full-policy035-4up.mp4`
  - `.artifacts/video-alpha-policy035-review/comparison/e1997e6e-roi-policy035-4up.mp4`
  - `.artifacts/video-alpha-policy035-review/comparison/e1997e6e-full-policy035-4up.mp4`
- 当前 evidence 结果：
  - `decision = candidate-aware-human-review`
  - `reason = raw-benchmark-has-material-regression-but-aware-benchmarks-downgrade-or-clear-it`
  - 汇总：
    - reports：`6`
    - compared cases：`18`
    - improved cases：`12`
    - material regressions：`1`
    - warning regressions：`2`
  - 分层判断：
    - raw standard：`3` cases，`2` improved，`1` material regression。
    - raw 12mbps：`3` cases，`2` improved，`0` material regression。
    - candidate-aware standard：`3` cases，`2` improved，`0` material regression，`1` warning。
    - candidate-aware 12mbps：`3` cases，`2` improved，`0` material regression。
    - expected-aware standard：`3` cases，`2` improved，`0` material regression，`1` warning。
    - expected-aware 12mbps：`3` cases，`2` improved，`0` material regression。
- 验证：
  - `pnpm exec node --test tests/scripts/videoAlphaPolicyEvidenceReport.test.js tests/scripts/scriptEntrypoints.test.js`
  - 结果：`5` tests passed。
  - `pnpm exec node --test tests/scripts/videoAlphaPolicyReviewPack.test.js tests/scripts/renderVideoComparisonGrid.test.js tests/scripts/scriptEntrypoints.test.js`
  - 结果：`8` tests passed。
  - `pnpm report:video-alpha-policy-evidence`
  - 结果：生成最新 JSON / Markdown，决策为 `candidate-aware-human-review`。
  - `pnpm report:video-alpha-policy-review-pack`
  - 结果：生成 `6` 个 4-up MP4，`ready = true`。
  - `pnpm report:video-review-index -- --review-pack .artifacts/video-alpha-policy035-review/review-pack/latest-review-pack.json --output .artifacts/video-alpha-policy035-review/review-pack/latest-review-index.html`
  - 结果：HTML title 为 `Video Alpha Policy 0.35 Review`，videos：`6`。
- 更新判断：
  - 0.35 证据比先前 denoise gate 中表现得更完整：它不是单层证据，而是 raw / candidate-aware / expected-aware 共 6 层 crop benchmark。
  - 当前已补 `alpha-policy035` 的 MP4 review pack，可以从 HTML 中直接看 original / baseline edge045 / policy035 / allenk 的 full 和 ROI 4-up 对比。
  - 但该候选还没有 temporal gate，因此暂不接入当前三条 delivery dashboard lane，也不能自动替换默认 `0.25`。
  - 下一步若人眼认为 0.35 明显更可用，应先补 temporal residual，再把它作为正式 dashboard lane 进入 goal acceptance flow。

### 2026-06-12 Alpha Policy 0.35 Temporal Lab 接入

- 背景：
  - 0.35 候选已经有 6 层 crop benchmark 和 6 个 full / ROI 4-up MP4。
  - 缺口是 review pack 没有把时序残差证据放到同一个人工复核入口里，容易误以为 `policy035` 已经可以直接进入 dashboard lane。
- 本轮生成 temporal residual：

```powershell
node scripts/run-video-temporal-residual-lab.js --manifest .artifacts/video-alpha-policy-12mbps-manifest.json --output-dir .artifacts/video-alpha-policy035-review/temporal-residual --cases '4d420881-alpha-policy035-12mbps,deaee69b-alpha-policy035-12mbps,e1997e6e-alpha-policy035-12mbps' --include-variants
```

  - 输出：
    - `.artifacts/video-alpha-policy035-review/temporal-residual/latest-report.json`
    - `.artifacts/video-alpha-policy035-review/temporal-residual/latest-report.md`
    - `.artifacts/video-alpha-policy035-review/temporal-residual/4d420881-alpha-policy035-12mbps-temporal-residual.png`
    - `.artifacts/video-alpha-policy035-review/temporal-residual/deaee69b-alpha-policy035-12mbps-temporal-residual.png`
    - `.artifacts/video-alpha-policy035-review/temporal-residual/e1997e6e-alpha-policy035-12mbps-temporal-residual.png`
  - 结果摘要：
    - `4d420881-alpha-policy035-12mbps`: same jitter `17.4563`, matched jitter `21.6213`, improvement `-4.1650`, worsened ratio `0.4052`。
    - `deaee69b-alpha-policy035-12mbps`: same jitter `9.2151`, matched jitter `10.2993`, improvement `-1.0842`, worsened ratio `0.4211`。
    - `e1997e6e-alpha-policy035-12mbps`: same jitter `10.2947`, matched jitter `14.0352`, improvement `-3.7405`, worsened ratio `0.4065`。
- 接入 review pack：
  - `scripts/create-video-alpha-policy-review-pack.js`
    - 新增默认 temporal report 输入：`.artifacts/video-alpha-policy035-review/temporal-residual/latest-report.json`。
    - 新增 CLI 参数：`--temporal <latest-report.json>`。
    - review pack JSON 现在写入 `temporal.cases`，包含 `pairCount`、`pixelPairCount`、same/matched jitter、improvement、worsened ratio 和 sheet path。
  - `scripts/create-video-review-index.js`
    - CLI 输出现在能区分 delivery temporal gate 与 review-pack temporal lab。
    - 重新生成 alpha HTML 后显示：`temporal: 3 lab cases`。
- 本轮实跑：
  - `pnpm report:video-alpha-policy-review-pack`
    - 结果：`videos = 6`，`temporal cases = 3`，`ready = true`。
  - `pnpm report:video-review-index -- --review-pack .artifacts/video-alpha-policy035-review/review-pack/latest-review-pack.json --output .artifacts/video-alpha-policy035-review/review-pack/latest-review-index.html`
    - 结果：`videos = 6`，`temporal = 3 lab cases`。
- 验证：
  - `pnpm exec node --test tests/scripts/videoAlphaPolicyReviewPack.test.js tests/scripts/videoTemporalResidualLab.test.js tests/scripts/videoReviewIndex.test.js tests/scripts/renderVideoComparisonGrid.test.js tests/scripts/scriptEntrypoints.test.js`
  - 结果：`14` tests passed。
  - 扩展回归：
    - `pnpm exec node --test tests/scripts/videoAlphaPolicyReviewPack.test.js tests/scripts/videoAlphaPolicyEvidenceReport.test.js tests/scripts/videoTemporalResidualLab.test.js tests/scripts/renderVideoComparisonGrid.test.js tests/scripts/videoDeliveryBundle.test.js tests/scripts/videoGoalStatusReport.test.js tests/scripts/videoDeliveryDashboard.test.js tests/scripts/videoReviewDecisionReport.test.js tests/scripts/videoReviewIndex.test.js tests/scripts/videoBackendExport.test.js tests/scripts/videoLightPolishReviewPack.test.js tests/scripts/videoPolishSweepReviewPack.test.js tests/scripts/videoDenoiseCandidateGate.test.js tests/scripts/scriptEntrypoints.test.js`
    - 结果：`42` tests passed。
- 更新判断：
  - `policy035` 现在已经具备同屏人工复核材料：full / ROI 4-up MP4、6 层 benchmark evidence、3 条 temporal residual sheet。
  - temporal lab 的 matched jitter 对三条样例都不是改善，说明继续扩大匹配窗口或把 matched temporal reuse 默认开启不是正确方向。
  - `policy035` 仍可作为“水印残影更淡但需人眼权衡边缘/时序风险”的候选复核，不应自动替换当前 `0.25` 默认候选。
  - 接入 dashboard 前必须先补 pending decision report / acceptance template，而不是直接更改默认处理策略；该工作在下一小节完成。

### 2026-06-12 Alpha Policy 0.35 Dashboard Lane

- 背景：
  - 上一小节已经补齐 `policy035` 的 temporal lab，但它仍散落在独立 review pack 中。
  - 交付 goal 的真实缺口是“所有可选候选都进入统一 dashboard/bundle，并明确等待人工接受”，否则人审路径容易遗漏 0.35 候选。
- 新增：
  - `scripts/create-video-pending-review-decision.js`
    - 从 review pack 生成 pending decision seed。
    - 同步调用 `create-video-review-decision-report.js` 生成 pending decision report。
    - 默认路径指向 `alpha-policy035` review pack。
  - `package.json`
    - `pnpm report:video-pending-review-decision`
    - `pnpm report:video-review-screenshot`
    - `pnpm report:video-dashboard-screenshot`
  - `scripts/create-video-delivery-dashboard.js`
    - 默认 lanes 新增 `alphaPolicy035`。
    - 该 lane 指向：
      - `.artifacts/video-alpha-policy035-review/review-pack/latest-review-index.html`
      - `.artifacts/video-alpha-policy035-review/review-pack/latest-review-index.png`
      - `.artifacts/video-alpha-policy035-review/review-pack/latest-review-pack.json`
      - `.artifacts/video-alpha-policy-evidence/latest-report.md`
      - `.artifacts/video-alpha-policy035-review/review-pack/latest-alpha-policy-review-decision-report.json`
      - `.artifacts/video-alpha-policy035-review/review-pack/latest-alpha-policy-review-decision-report.md`
    - Rebuild Commands 新增 0.35 alpha review 重建命令。
    - Temporal Snapshot 不再截断前 `18` 行，避免 `alphaPolicy035` 的 temporal cases 被前面 lane 挤掉。
    - 每条 lane 现在暴露 `Decision template` 链接，dashboard JSON 也记录 `decisionTemplatePath`。
    - 每条 lane 现在暴露 `Decision command`，dashboard JSON 也记录 `decisionCommand`，可直接把 template 转成对应 decision report。
    - `Decision command` 现在以 `code + Copy` 按钮呈现，点击后复制完整命令；Clipboard API 不可用时退回 textarea copy。
  - `scripts/create-video-review-decision-report.js`
    - 新增 `prefer-alpha-policy035` 决策值。
    - checklist 全勾时输出 `prefer-alpha-policy035-candidate`。
    - checklist 未完成时降级为 `needs-polish`，并记录 `prefer-alpha-policy035-decision-with-incomplete-checklist`。
  - `scripts/create-video-goal-status-report.js`
    - `prefer-alpha-policy035-candidate` 现在计入可完成 goal 的人工接受状态。
  - `tests/scripts/videoPendingReviewDecision.test.js`
    - 验证 pending seed 和 pending decision report。
  - `scripts/create-video-review-screenshot.js`
    - 通过 Playwright 用 `file://` 打开本地 review HTML 并生成 dashboard thumbnail，不需要启动 dev server。
    - 默认输出 `.artifacts/video-alpha-policy035-review/review-pack/latest-review-index.png`。
  - `tests/scripts/videoReviewScreenshot.test.js`
    - 验证 screenshot 默认路径和 viewport 归一化。
- 本轮实跑：

```powershell
pnpm report:video-review-screenshot
pnpm report:video-pending-review-decision
pnpm report:video-delivery-bundle
```

  - screenshot 输出：
    - `.artifacts/video-alpha-policy035-review/review-pack/latest-review-index.png`
    - `.artifacts/video-alpha-policy035-review/review-pack/latest-review-index-screenshot.json`
    - viewport: `1440x1200`
    - fullPage: `true`
  - pending decision 输出：
    - `.artifacts/video-alpha-policy035-review/review-pack/latest-alpha-policy-review-decision.pending.json`
    - `.artifacts/video-alpha-policy035-review/review-pack/latest-alpha-policy-review-decision-report.json`
    - `.artifacts/video-alpha-policy035-review/review-pack/latest-alpha-policy-review-decision-report.md`
    - status: `pending`
    - warnings: `decision-pending`, `review-only-polish-comparison`, `decision-checklist-incomplete`
    - blockers: none
  - decision 语义：
    - alpha review pack 下拉现在使用 `prefer-alpha-policy035`，不再复用 `prefer-light`。
    - bundle 中 `alphaPolicy035` 的 suggested decision 为 `prefer-alpha-policy035`。
    - accepted statuses 包含 `prefer-alpha-policy035-candidate`。
    - pending decision template 现在写入 `laneId`、`suggestedDecision`、`suggestedDecisionOptions` 和 `acceptedStatuses`，模板本身可直接告诉人审应填哪个合法 decision 值。
  - dashboard / goal / bundle 刷新结果：
    - dashboard lane count: `4`
    - missing assets: `0`
    - dashboard HTML 中已出现 `4` 个 `Decision template` 链接。
    - dashboard HTML 中已出现 `4` 条 `Decision command`。
    - dashboard HTML 中已出现 `4` 个 `Copy` 按钮，覆盖四条 lane 的 decision command。
    - dashboard JSON 中 `current025` / `polish020` / `sweep018022` / `alphaPolicy035` 都写入 `decisionTemplatePath`，且 template asset exists。
    - dashboard JSON 中 `current025` / `polish020` / `sweep018022` / `alphaPolicy035` 都写入 `decisionCommand`。
    - dashboard HTML 的 temporal snapshot 中已出现 `3` 条 `alphaPolicy035` temporal rows；dashboard JSON 中对应 lane 记录 `temporalCases = 3`，并在机器可读 `temporalRows` 中输出总计 `23` 条 temporal rows，其中 `alphaPolicy035 = 3`：
      - `4d420881-alpha-policy035-12mbps`
      - `deaee69b-alpha-policy035-12mbps`
      - `e1997e6e-alpha-policy035-12mbps`
    - `alphaPolicy035`:
      - status: `review-only`
      - temporal: `available`
      - review: `pending`
      - ready: `true`
      - comparisons: `6`
      - temporal cases: `3`
      - screenshot asset: exists
    - goal status:
      - status: `incomplete`
      - 唯一 blocker: `human-review-acceptance-missing`
      - `viewable-review-artifacts`: satisfied
      - `current-candidate-ready-for-visual-review`: satisfied
      - `alternatives-available-for-human-review`: satisfied
      - `progress-documentation-synced`: satisfied
    - delivery bundle:
      - decision templates: `4`
      - acceptance lanes: `current025`, `polish020`, `sweep018022`, `alphaPolicy035`
      - dashboard screenshot path 已写入 bundle JSON / Markdown。
      - bundle 重建顺序已调整为：先生成 dashboard 读取 lane/reviewPack，写出 decision templates，再刷新最终 dashboard / goal status / screenshot，避免 template 链接被标记为 missing。
      - 四个 decision template 均写入 suggested decision：
        - `current025`: `accept`
        - `polish020`: `prefer-light`
        - `sweep018022`: `prefer-strength018`
        - `alphaPolicy035`: `prefer-alpha-policy035`
      - `sweep018022` 的多选语义保留在 `suggestedDecisionOptions`：
        - `prefer-strength018`
        - `prefer-strength022`
        - `prefer-light`
        - `prefer-current`
        - `needs-more-polish`
        - `reject-both`
      - `scripts/verify-video-delivery-bundle.js` 现在会自动读取四个 template 的 `suggestedDecisionOptions`，逐个填入真实 decision parser，并要求输出为非 `pending` / 非 `invalid` 状态。
      - 本轮重新运行 `pnpm report:video-delivery-bundle` 后，bundle 仍为 `status = incomplete`、`nextAction = collect-human-review-acceptance`、`missingAssets = 0`、`decision templates = 4`。
      - `scripts/create-video-delivery-dashboard.js` 现在会把 temporal snapshot 同步写入 dashboard JSON 的 `temporalRows`，避免后续自动验收只能解析 HTML。
      - `scripts/create-video-acceptance-quickstart.js` 新增一页式人审入口；`pnpm report:video-delivery-bundle` 会自动刷新：
        - `.artifacts/video-delivery-bundle/latest-acceptance-quickstart.md`
        - `.artifacts/video-delivery-bundle/latest-acceptance-quickstart.json`
        - `.artifacts/video-delivery-bundle/latest-acceptance-quickstart.html`
      - HTML quickstart 当前可直接打开，包含 dashboard screenshot、顶部 `Review Order`、顶部 `Suggested Review Actions`、顶部 `Human Acceptance Checklist`、顶部 `Review Playlist`、4 条 lane、每条 lane 的 review page / decision template 链接、模板里的 `full` / `roi` review MP4 直达链接、18 张从 `currentTime` 抽取的 review thumbnail PNG、单张 review thumbnail contact sheet 入口、`Copy` command 按钮，以及每个 suggested decision option 会生成的 report status / next action 预览。
      - 已用截图脚本渲染验证 HTML quickstart：
        - `.artifacts/video-delivery-bundle/latest-acceptance-quickstart.png`
        - `.artifacts/video-delivery-bundle/latest-acceptance-quickstart-screenshot.json`
        - viewport: `1440x1800`
        - documentSize: `1440x8858`, client: `1440x1800`
        - fullPage: `true`
        - 目视确认：截图已覆盖完整 quickstart 页面，从顶部 `Review Order`、`Suggested Review Actions`、`Human Acceptance Checklist`、`Review Playlist` 一直到页面底部四个 lane 卡片；`Review Order` 建议按 `current025 -> polish020 -> sweep018022 -> alphaPolicy035` 观看，每行都有 `Start video` 直达入口且优先指向 ROI 视频，并把 `alphaPolicy035` 的 `1 material / 2 warning` 风险标出；`Suggested Review Actions` 集中展示四条 lane 的推荐 decision / status / evidence / copy command；`Human Acceptance Checklist` 直接展示四条 lane 的 20 条模板 checklist 文本；`Review Playlist` 可直接看到四条 lane 的 18 个 review MP4 入口和 18 张关键帧 thumbnail；下面仍保留 `Decision Preview` 行、四条 lane 的 suggested/options、status / next action 预览；长 status 和 next action 已改为在卡片内换行，避免右侧裁切。
      - quickstart JSON 当前记录：
        - status: `incomplete`
        - acceptance: `pending-human-review`
        - ready lanes: `4/4`
        - review order: `current025 -> polish020 -> sweep018022 -> alphaPolicy035`
        - review order start videos: ROI-first direct links, including `alphaPolicy035 -> 4d420881-roi-policy035-4up.mp4`
        - decision previews: `17`, failed `0`
        - suggested review actions: `4`
        - human acceptance checklist items: `20`
        - review video links: `18`
        - review thumbnails: `18/18`
        - review thumbnail dir: `.artifacts/video-delivery-bundle/review-thumbnails`
        - review thumbnail sheet: `.artifacts/video-delivery-bundle/latest-review-thumbnail-sheet.png`
        - review thumbnail sheet JSON: `.artifacts/video-delivery-bundle/latest-review-thumbnail-sheet.json`
        - review thumbnail sheet size: `1144x1746`, thumbnails `18/18`, missing `0`
        - `current025`: suggested `accept`, videos `4`, temporal rows `4`
        - `polish020`: suggested `prefer-light`, videos `4`, temporal rows `6`
        - `sweep018022`: suggested `prefer-strength018`, videos `4`, temporal rows `10`
        - `alphaPolicy035`: suggested `prefer-alpha-policy035`, videos `6`, temporal rows `3`
      - `scripts/verify-video-delivery-bundle.js` 新增交付包完整性验证器，检查 bundle / dashboard / quickstart / decision templates / review pages / screenshots / lane commands 是否断链。
      - `pnpm report:video-delivery-bundle` 现在默认自动运行该验证器，并把 verification 状态写回 bundle JSON / Markdown；`pnpm verify:video-delivery-bundle` 仍保留为单独复核入口。
      - 当前 verification 结果：
        - status: `ready-for-human-review`
        - checks: `492/492`
        - review HTML reference verification: `18` checks, failed `0`
        - media verification: enabled, `18` video probes, failed `0`
        - review time verification: `18` checks, failed `0`
        - screenshot report readable verification: `2` checks, failed `0`
        - screenshot report HTML path verification: `2` checks, failed `0`
        - screenshot report output path verification: `2` checks, failed `0`
        - screenshot viewport verification: `2` checks, failed `0`
        - screenshot document-size verification: `2` checks, failed `0`
          - dashboard: documentSize `1440x4557`, client `1440x1200`, fullPage `true`
          - quickstart: documentSize `1440x8858`, client `1440x1800`, fullPage `true`
        - review thumbnail verification: enabled
          - completeness: `4` checks, failed `0`
          - HTML visibility: `4` checks, failed `0`
          - Markdown visibility: `4` checks, failed `0`
          - thumbnail file exists: `18` checks, failed `0`
          - thumbnail PNG signature: `18` checks, failed `0`
        - review thumbnail sheet verification: enabled
          - path: `1` check, failed `0`
          - JSON path: `1` check, failed `0`
          - PNG signature: `1` check, failed `0`
          - output path self-check: `1` check, failed `0`
          - thumbnail count: `1` check, failed `0`
          - quickstart HTML link: `1` check, failed `0`
          - quickstart Markdown link: `1` check, failed `0`
        - screenshot generatedAt verification: `2` checks, failed `0`
        - screenshot fullPage verification: `2` checks, failed `0`
        - decision option verification: `17` parser checks, failed `0`
        - decision template option-list verification: `4` checks, failed `0`
        - decision template suggested-decision verification: `4` checks, failed `0`
        - decision template path self-check: `4` checks, failed `0`
        - decision template review page self-check: `4` checks, failed `0`
        - decision template instructions self-check: `4` checks, failed `0`
        - decision template accepted-status coverage: `4` checks, failed `0`
        - decision template checklist self-check: `4` checks, failed `0`
        - acceptance dry-run suggested-decision goal compatibility: `4` checks, failed `0`
        - acceptance dry-run accepted-option availability: `4` checks, failed `0`
        - command script verification: `4` checks, failed `0`
        - command `--decision` path verification: `4` checks, failed `0`
        - command `--output` path verification: `4` checks, failed `0`
        - command `--markdown` path verification: `4` checks, failed `0`
        - quickstart decision preview verification: `17` JSON preview checks, failed `0`
        - quickstart preview presence verification: `4` checks, failed `0`
        - quickstart review order JSON/policy match verification: `1` check, failed `0`
        - quickstart HTML review order visibility verification: `1` check, failed `0`（包含每条 order 的 start-video filename）
        - quickstart Markdown review order visibility verification: `1` check, failed `0`（包含每条 order 的 start-video filename）
        - quickstart preview/parser status match verification: `17` checks, failed `0`
        - quickstart suggested action JSON/preview match verification: `4` checks, failed `0`
        - quickstart HTML suggested action visibility verification: `4` checks, failed `0`
        - quickstart Markdown suggested action visibility verification: `4` checks, failed `0`
        - quickstart acceptance checklist JSON/template match verification: `4` checks, failed `0`
        - quickstart HTML acceptance checklist visibility verification: `4` checks, failed `0`
        - quickstart Markdown acceptance checklist visibility verification: `4` checks, failed `0`
        - quickstart acceptance command verification: `17` checks, failed `0`
        - quickstart candidate evidence verification: `4` checks, failed `0`
        - quickstart candidate evidence stats verification: `4` checks, failed `0`
        - quickstart diagnostic link consistency verification: `4` checks, failed `0`
        - dashboard diagnostic path verification: `4` checks, failed `0`
        - quickstart HTML preview visibility verification: `17` checks, failed `0`
        - quickstart decision copy-target verification: `17` checks, failed `0`
        - quickstart acceptance command copy-target verification: `17` checks, failed `0`
        - quickstart HTML candidate evidence visibility verification: `4` checks, failed `0`
        - quickstart HTML candidate evidence stats visibility verification: `4` checks, failed `0`
        - quickstart HTML diagnostic link visibility verification: `4` checks, failed `0`
        - quickstart Markdown preview visibility verification: `17` checks, failed `0`
        - quickstart Markdown acceptance command visibility verification: `17` checks, failed `0`
        - quickstart Markdown candidate evidence visibility verification: `4` checks, failed `0`
        - quickstart Markdown candidate evidence stats visibility verification: `4` checks, failed `0`
        - quickstart Markdown diagnostic link visibility verification: `4` checks, failed `0`
        - quickstart review video JSON/template match verification: `4` checks, failed `0`
        - quickstart HTML review video visibility verification: `4` checks, failed `0`
        - quickstart Markdown review video visibility verification: `4` checks, failed `0`
        - quickstart HTML review playlist verification: `1` check, failed `0`
        - quickstart Markdown review playlist verification: `1` check, failed `0`
        - dashboard HTML diagnostic link visibility verification: `4` checks, failed `0`
        - 每条 lane 均验证包含 `full` 与 `roi` 两类 review 视频。
        - JSON: `.artifacts/video-delivery-bundle/latest-verification-report.json`
        - Markdown: `.artifacts/video-delivery-bundle/latest-verification-report.md`
        - 该状态证明交付包完整、review HTML 已引用模板中的对比 MP4、MP4 可被 `ffprobe` 读取、模板中的 `currentTime` 落在视频时长内，quickstart 还会为 18 个 review video 从 `currentTime` 抽取 18 张 PNG thumbnail 并在 JSON / HTML / Markdown 中暴露，同时把 18 张 thumbnail 合成单张 `1144x1746` contact sheet 供快速扫视；verifier 已验证 thumbnail 路径完整、文件存在、PNG 签名可读、contact sheet JSON 数量与 quickstart `18/18` 对齐，且 quickstart HTML / Markdown 都能打开该 sheet；dashboard / quickstart 截图 report 指向当前 HTML 和 PNG 且均为 fullPage 截图，并记录可验证的 `documentSize`（`scrollWidth` / `scrollHeight` / `clientWidth` / `clientHeight`）证明截图覆盖超过首屏的完整页面、推荐人审 decision 值可被真实 parser 接受，四条 lane 的 suggested decision 在 checklist 全勾时都会进入 goal 可识别的 accepted/prefer 状态，decision template 自身的 `templatePath` / `page` / `templateInstructions` / `acceptedStatuses` / `checklist` 与 bundle lane 保持一致，quickstart JSON / HTML / Markdown 都已展示这些 decision 的有效 preview 且 preview status 与 parser 输出一致，quickstart 还会按风险策略生成顶部 `Review Order` 并为每条 order 提供 ROI-first start-video 直达链接、把四条 lane 的 suggested decision 提炼为顶部 `Suggested Review Actions` 并提供 copy command、把四条 lane 的 20 条 template checklist 文本提炼为顶部 `Human Acceptance Checklist`，quickstart JSON / HTML / Markdown 也已暴露模板里的 18 个 review MP4 链接和 thumbnail，并在 HTML / Markdown 顶部提供 `Review Playlist` 总入口，dashboard 与 quickstart 同步展示每条 lane 的 candidate evidence decision（包括 `alphaPolicy035 = candidate-aware-human-review`）、evidence stats 和 diagnostic links，quickstart HTML 为 17 个 preview decision 都提供了 decision copy target 和 acceptance command copy target，每条 lane 的 `pnpm report:video-review-decision` 命令参数都指向对应 template / JSON report / Markdown report；不等同于 goal complete，仍需至少一条 lane 的人工接受 decision 与完整 checklist。
      - `scripts/create-video-review-decision-report.js` 现在支持人工验收后的显式覆盖参数：
        - `--set-decision <value>`
        - `--check-all`
        - `--notes <text>`
      - quickstart 的每个 decision preview 现在都会生成一条 acceptance command，例如 `--set-decision prefer-alpha-policy035 --check-all`，用于在人工看完对应 review video 后直接生成该 lane 的 decision report，减少手改 JSON 的出错面。
      - quickstart 顶部现在新增 `Suggested Review Actions`，把四条 lane 的 suggested decision 与对应 copy command 集中展示；HTML 里只显示短标签和 Copy 按钮，完整命令保存在 `data-copy-command` 与 Markdown 中，避免长命令撑坏页面。
      - quickstart 顶部现在新增 `Review Order`，按风险/证据排序建议先看默认候选，再看 polish tradeoff，最后看带诊断风险的 `alphaPolicy035`；该排序只服务人工复核，不改变算法默认策略。
      - `Review Order` 现在每行还提供 `Start video`，从该 lane 的 review videos 中优先选择 ROI 视频作为第一个打开入口，减少从 playlist 手动查找的步骤。
      - quickstart 顶部现在新增 `Human Acceptance Checklist`，直接读取四个 decision template 的 20 条 checklist 文本；用户不需要打开 JSON 模板就能逐项确认 ROI、full-frame、temporal、sentinel 和 notes 条件。
      - quickstart 现在还会从每条 lane 的 decision template 读取 `videos`，在 JSON / HTML / Markdown 中展示 `caseId + kind + mp4 filename + currentTime`，并把这 18 个入口集中放到顶部 `Review Playlist`，让人工验收可以从 quickstart 直接打开所有 full / ROI 对比视频，不必先进入 review index 再寻找 MP4。
      - `scripts/create-video-delivery-dashboard.js` 现在会把 review pack 的 `bestCandidate.decision` 输出为 dashboard JSON lane 的 `candidateDecision`；`scripts/create-video-acceptance-quickstart.js` 会把它显示成人审入口中的 `evidence` pill，并纳入 verifier。
      - dashboard / quickstart 现在也会展示候选 evidence stats，并提供 evidence report 链接，便于人工判断 alpha policy 的收益和风险；当前 `alphaPolicy035` 统计为 `reports=6`、`cases=18`、`improved=12`、`material=1`、`warning=2`。
      - `alphaPolicy035` 的 dashboard / quickstart 现在还会展示诊断入口：
        - `Known flaw diagnostics`: `.artifacts/video-policy035-default-review/user-flaw-diagnostics/latest.json`
        - `Headlight crop`: `.artifacts/video-policy035-default-review/user-flaw-diagnostics/deaee69b-headlight-user-crop.png`
        - `Rail crop`: `.artifacts/video-policy035-default-review/user-flaw-diagnostics/e1997e6e-rail-user-crop.png`
        - `Rejected shape gate`: `.artifacts/video-alpha-shape-candidate-gate/manual-shape-validated/latest-report.md`
      - 这些链接用于把“用户指出的轻微瑕疵”和“手工 alpha shape 候选为何被拒绝”直接带到人工验收入口，避免重复沿已失败的 shape/模糊方向调参。
      - evidence pill 的颜色语义已明确：
        - `promote-default-candidate` / `regression-free-human-review` 显示为绿色。
        - `human-review` / `candidate-aware-human-review` / `insufficient-evidence` 显示为黄色。
        - `reject` / `invalid` 显示为红色。
      - 当前 quickstart screenshot 已确认：
        - `current025`: `evidence promote-default-candidate` 为绿色。
        - `polish020` / `sweep018022`: `evidence human-review` 为黄色。
        - `alphaPolicy035`: `evidence candidate-aware-human-review` 为黄色。
      - 本轮对真实 `.artifacts/video-delivery-bundle/decision-templates/*.decision.template.json` 复核：
        - `current025`: `accept -> accepted-for-default-review`, `needs-polish -> needs-polish`, `reject -> rejected`
        - `polish020`: `prefer-light -> prefer-light-polish-candidate`, `prefer-current -> prefer-current-default-candidate`, `needs-more-polish -> needs-polish`, `reject-both -> rejected`
        - `sweep018022`: `prefer-strength018 -> prefer-strength018-polish-candidate`, `prefer-strength022 -> prefer-strength022-polish-candidate`, `prefer-light -> prefer-light-polish-candidate`, `prefer-current -> prefer-current-default-candidate`, `needs-more-polish -> needs-polish`, `reject-both -> rejected`
        - `alphaPolicy035`: `prefer-alpha-policy035 -> prefer-alpha-policy035-candidate`, `prefer-current -> prefer-current-default-candidate`, `needs-more-polish -> needs-polish`, `reject-both -> rejected`
  - dashboard screenshot 输出：
    - `.artifacts/video-delivery-dashboard/latest-video-dashboard.png`
    - `.artifacts/video-delivery-dashboard/latest-video-dashboard-screenshot.json`
    - viewport: `1440x1200`
    - 目视确认：总览 PNG 已包含 `Alpha Policy 0.35` 卡片、4-lane summary 和 temporal snapshot。
    - `pnpm report:video-delivery-bundle` 现在会自动刷新该截图；`pnpm report:video-dashboard-screenshot` 仍保留为单独重建入口。
- 验证：
  - `pnpm exec node --test tests/scripts/videoPendingReviewDecision.test.js tests/scripts/videoDeliveryDashboard.test.js tests/scripts/videoDeliveryBundle.test.js tests/scripts/videoGoalStatusReport.test.js tests/scripts/videoReviewDecisionReport.test.js tests/scripts/scriptEntrypoints.test.js`
  - 结果：`17` tests passed。
  - 截图脚本局部验证：
    - `pnpm exec node --test tests/scripts/videoReviewScreenshot.test.js tests/scripts/videoDeliveryDashboard.test.js tests/scripts/scriptEntrypoints.test.js`
    - 结果：`5` tests passed。
  - 扩展回归：
    - `pnpm exec node --test tests/scripts/videoAcceptanceQuickstart.test.js tests/scripts/videoDeliveryBundleVerification.test.js tests/scripts/videoAlphaPolicyReviewPack.test.js tests/scripts/videoAlphaPolicyEvidenceReport.test.js tests/scripts/videoTemporalResidualLab.test.js tests/scripts/videoPendingReviewDecision.test.js tests/scripts/videoReviewScreenshot.test.js tests/scripts/renderVideoComparisonGrid.test.js tests/scripts/videoDeliveryBundle.test.js tests/scripts/videoGoalStatusReport.test.js tests/scripts/videoDeliveryDashboard.test.js tests/scripts/videoReviewDecisionReport.test.js tests/scripts/videoReviewIndex.test.js tests/scripts/videoBackendExport.test.js tests/scripts/videoLightPolishReviewPack.test.js tests/scripts/videoPolishSweepReviewPack.test.js tests/scripts/videoDenoiseCandidateGate.test.js tests/scripts/scriptEntrypoints.test.js`
    - 结果：`59` tests passed。
- 更新判断：
  - `policy035` 已从独立候选升级为统一交付 dashboard 的 review-only lane。
  - `policy035` 的人工选择现在有独立 decision status，不会被误记成 `prefer-light-polish-candidate`。
  - 当前工程证据已经足够让人审在同一个 bundle 内比较四条路径；goal 仍不能标记 complete，因为还没有任何 lane 的人工接受决策与完整 checklist。
  - 下一步应由人工在 dashboard 内选择 `current025` / `polish020` / `sweep018022` / `alphaPolicy035` 中可接受的候选；如果都不可接受，再回到算法侧继续诊断残影/边缘/时序问题。

### 2026-06-11 Video Denoise Candidate Gate

- 背景：
  - 对比 `allenk/GeminiWatermarkTool` v0.6.2 后，确认我们的视频 V2 仍缺少真正的 ROI 级 AI / ML denoise 后端。
  - 旧的 `canvas-edge-denoise` / `canvas-edge-band-denoise` 在单帧或局部指标上会出现改善，但视频层容易产生 lowBody / highBody 回归，不能只凭单个报告升为默认。
- 新增准入工具：
  - `scripts/gate-video-denoise-candidates.js`
  - `package.json`
    - 新增 `pnpm gate:video-denoise`
  - `tests/scripts/videoDenoiseCandidateGate.test.js`
- Gate 输入：
  - 支持 `video-crop-benchmark` 的 summary report。
  - 支持 `run-video-frame-backend-lab` 的 frame lab report。
  - 支持 `--control-reports` 传入 no-op encoding-control benchmark，用来扣除控制组同样存在的编码/重新导出回归。
  - 按候选后端聚合证据：
    - denoise 后端用 `denoiseBackend + edgeDenoiseStrength` 聚合，忽略 alpha profile / bitrate 等旁路变量。
    - `denoiseBackend=none` 时保留 `alphaEdgePolicy`，用于非 denoise 的 alpha policy 候选。
- 判定规则：
  - 任一证据层出现 material regression，则候选 `reject`。
  - 证据层数量不足，则 `insufficient-evidence`。
  - 只有 warning regression 时进入 `human-review`。
  - 多层均通过且有改善，才允许 `promote-default-candidate`。
- 本轮真实 gate 运行：
  - 命令：
    - `pnpm gate:video-denoise -- --reports .artifacts/video-frame-backend-lab/latest-report.json,.artifacts/video-crop-benchmark/latest-summary.json,.artifacts/video-crop-benchmark-alpha-policy035-12mbps/latest-summary.json --output .artifacts/video-denoise-candidate-gate/latest-report.json --markdown .artifacts/video-denoise-candidate-gate/latest-report.md`
  - 输出：
    - `.artifacts/video-denoise-candidate-gate/latest-report.json`
    - `.artifacts/video-denoise-candidate-gate/latest-report.md`
  - 候选结论：
    - `canvas-edge-band-denoise, strength=0.5`: `reject`
    - `canvas-edge-band-denoise, strength=0.8`: `reject`
    - `canvas-edge-denoise, strength=0.65`: `reject`
      - 单帧 layer 通过，但 video benchmark layer fail。
    - `canvas-edge-denoise, strength=1`: `reject`
    - `none, alphaEdgePolicy=standard045-inset035`: `insufficient-evidence`
      - 目前只有 `12mbps` video benchmark 一层证据通过，缺标准码率 / 多样本 / 单帧层验证。
- alpha policy 当前补充复核：
  - 重新用六层 alpha policy evidence 输入运行通用 denoise gate：
    - standard raw
    - 12mbps raw
    - standard candidate-aware
    - 12mbps candidate-aware
    - standard expected-aware
    - 12mbps expected-aware
  - 输出：
    - `.artifacts/video-denoise-candidate-gate/alpha-policy035-current-evidence.json`
    - `.artifacts/video-denoise-candidate-gate/alpha-policy035-current-evidence.md`
  - 通用 denoise gate 结论：
    - `none, alphaEdgePolicy=standard045-inset035`: `reject`
    - required layers: `6`
    - improved cases: `12`
    - material fail layers: `1`
    - warning layers: `2`
    - 原因：standard raw 层的 `deaee69b` 仍有 `edge` / `lowBody` material regression。
  - 专门 alpha evidence report 仍为：
    - `.artifacts/video-alpha-policy-evidence/latest-report.json`
    - `.artifacts/video-alpha-policy-evidence/latest-report.md`
    - decision: `candidate-aware-human-review`
    - reason: `raw-benchmark-has-material-regression-but-aware-benchmarks-downgrade-or-clear-it`
  - 因此 `alphaPolicy035` 不应按 denoise 默认候选自动 promote，也不应从人工复核中移除；它的正确状态是 candidate-aware human review。
- 更新判断：
  - 这条 gate 解决的是“不要把单帧好看的假正向误升默认”的问题。
  - `alphaEdgePolicy=standard045-inset035` 是非 denoise 的 alpha policy 候选；通用 denoise gate 的 raw strict `reject` 用来防止自动 promote，专门 alpha evidence 的 `candidate-aware-human-review` 用来保留人工复核入口。
  - 当前不新增伪 AI 后端，也不把旧 canvas denoise 作为发版亮点。
  - 下一步的视频 V2 质量突破应基于此 gate 接入真正的 ROI denoise 候选，例如 WebGPU / WebNN / tiny-CNN 原型；候选必须先跨 frame lab 与 video benchmark 再进入人工视觉审阅。

### 2026-06-12 allenk FDnCNN Model Extraction

- 背景：
  - 用户复核视频对比后，确认当前 Canvas / alpha / temporal cleanup 路线仍会在右下角复杂纹理、车灯、格栅、深色塑料等区域留下明显水印残影。
  - 根本差距不是单个阈值，而是 allenk `GeminiWatermarkTool` 使用了 ROI 级 FDnCNN AI denoise 后端；我们当前浏览器 MVP 仍主要依赖解析式反混合和轻量 Canvas 清理。
- allenk 可复用信息：
  - upstream: `allenk/GeminiWatermarkTool`
  - license: MIT
  - 模型：`FDnCNN Color FP16`
  - runtime: NCNN
  - 输入：`[R, G, B, sigma]` CHW float32，RGB 归一化到 `0..1`，sigma map 为 `sigma / 255`
  - 输出：denoised RGB CHW float32
  - allenk blend 逻辑：对 watermark alpha mask 做 Sobel / gamma / dilate / blur 后，只在 ROI 内按权重混合 denoised 输出。
- 新增模型提取工具：
  - `scripts/extract-allenk-fdncnn-model.js`
  - `package.json`
    - 新增 `pnpm extract:allenk-fdncnn`
  - `tests/scripts/extractAllenkFdncnnModel.test.js`
  - 提取 manifest 现在包含 NCNN binary param 解析结果和每层权重偏移：
    - `21` layers / `21` blobs
    - `20` convolution layers
    - `19` ReLU convolution layers
    - input blob: `0`
    - output blob: `20`
    - channels: `4 -> 64 -> 3`
    - kernel: `3x3`
    - storage: `fp16-weights-fp32-bias`
- 新增 allenk 算法合约模块：
  - `src/core/allenkFdncnnDenoise.js`
  - `tests/core/allenkFdncnnDenoise.test.js`
  - 固化内容：
    - 模型元数据、blob id、默认 sigma / strength / padding
    - FDnCNN CHW 输入构造：RGB plane + uniform sigma plane
    - FDnCNN CHW 输出转 RGBA
    - allenk 风格 alpha gradient mask
    - padded ROI / inner rect 计算
    - ROI weight 嵌入 padded 坐标并做 sigma=1 过渡 blur
    - `result = weight * denoised + (1 - weight) * original` masked blend
- 新增 NCNN 模型解析模块：
  - `src/core/allenkFdncnnNcnnModel.js`
  - `tests/core/allenkFdncnnNcnnModel.test.js`
  - 能解析 allenk 生成的 binary param，校验每层 convolution 的 `weightDataSize`，并计算 FP16 weights / FP32 bias 在 bin 文件中的字节偏移。
- 新增 debug/reference runtime：
  - `src/core/allenkFdncnnReferenceRuntime.js`
  - `tests/core/allenkFdncnnReferenceRuntime.test.js`
  - 能在浏览器兼容 JS 中：
    - 解码 FP16 weights；
    - 执行 tiny model / tiny ROI 的 same-padding convolution + ReLU；
    - 通过 MAC 上限 fail-fast，避免误用于真实视频生产尺度；
    - 暴露 `denoiseImageData()`，供视频 ROI pipeline 注入验证。
- 新增 browser spike 报告：
  - `scripts/create-allenk-fdncnn-browser-spike-report.js`
  - `package.json`
    - 新增 `pnpm report:allenk-fdncnn-browser-spike`
  - `tests/scripts/allenkFdncnnBrowserSpikeReport.test.js`
  - 真实输出：
    - `.artifacts/allenk-fdncnn/browser-spike-report.json`
    - `.artifacts/allenk-fdncnn/browser-spike-report.md`
  - ROI 推理量级：
    - `72x72`: `3.46G` MAC
    - `96x96`: `6.15G` MAC
    - `200x200`: `26.70G` MAC
  - 报告结论：
    - 纯 JS 只能做 debug/reference，不适合生产视频处理。
    - 推荐下一步 spike：`onnxruntime-web-webgpu`
    - fallback 研究路径：`web-ncnn`
    - Canvas cleanup 继续保留为 fallback，不再作为 allenk 等价方案。
  - 本地限制：
    - `.artifacts/external-repos/GeminiWatermarkTool/external/ncnn/ncnn-20260113-src` 当前未提供可用源码/工具文件。
    - 因此本轮不能依赖本地 `ncnn2onnx` / ncnn tools 直接转换；已改为项目内最小 ONNX protobuf 写出器做固定 shape 导出。
- 新增 ONNX 导出原型：
  - `src/core/allenkFdncnnOnnxExport.js`
  - `scripts/export-allenk-fdncnn-onnx.js`
  - `package.json`
    - 新增 `pnpm export:allenk-fdncnn-onnx`
  - `tests/core/allenkFdncnnOnnxExport.test.js`
  - `tests/scripts/allenkFdncnnOnnxExport.test.js`
  - 导出策略：
    - 读取已提取的 NCNN binary param / bin；
    - 按 allenk weight layout 解码 FP16 weights；
    - bias 保持 FP32；
    - ONNX initializer 使用 `FLOAT` raw_data，优先兼容 ONNX Runtime Web / WebGPU；
    - 固定输入 shape：`[1, 4, 72, 72]`；
    - 固定输出 shape：`[1, 3, 72, 72]`；
    - graph: `20` Conv + `19` Relu，共 `39` nodes，`40` initializers。
  - 真实输出：
    - 命令：`pnpm export:allenk-fdncnn-onnx`
    - `.artifacts/allenk-fdncnn/model_core_fp32_72.onnx`
    - `.artifacts/allenk-fdncnn/onnx-manifest.json`
    - ONNX bytes: `2679703`
    - ONNX sha256: `c10b07da39b7e99ca385f9d0c30c03f939fe87b2cb8c896570aac4616971d6d8`
  - browser spike report 更新：
    - `scripts/create-allenk-fdncnn-browser-spike-report.js` 会读取 `.artifacts/allenk-fdncnn/onnx-manifest.json`；
    - ONNX 存在时，`onnxruntime-web-webgpu` 状态从 `needs-conversion` 升级为 `prototype-ready`；
    - runtime smoke 通过后，`onnxruntime-web-webgpu` 状态进一步升级为 `runtime-smoke-passed`；
    - 这只表示模型资产可交给浏览器运行时 spike，不表示真实视频质量已通过 gate。
- 新增 ONNX Runtime Web smoke：
  - dev dependency:
    - `onnxruntime-web`
  - `scripts/smoke-allenk-fdncnn-onnx-runtime.js`
  - `package.json`
    - 新增 `pnpm smoke:allenk-fdncnn-onnx-runtime`
  - `tests/scripts/allenkFdncnnOnnxRuntimeSmoke.test.js`
  - 真实输出：
    - 命令：`pnpm smoke:allenk-fdncnn-onnx-runtime`
    - `.artifacts/allenk-fdncnn/onnx-runtime-smoke.json`
  - 真实 runtime smoke：
    - execution provider: `wasm`
    - session input: `fdncnn_input`
    - session output: `fdncnn_output`
    - input shape: `[1, 4, 72, 72]`
    - output shape: `[1, 3, 72, 72]`
    - output length: `15552`
    - create: `~198ms`
    - zero-input inference: `~224ms`
  - 结论：
    - 导出的 ONNX 已被 `onnxruntime-web` 实际加载并执行；
    - WASM 速度只适合作为可执行性基线，真实视频逐帧处理仍需 WebGPU / ROI 调度 / 缓存 session；
    - 这一步仍未证明视觉质量超过当前 Canvas 方案，后续必须接入真实视频 ROI pipeline 并跑 frame/video gate。
- 新增 ONNX runtime adapter 与真实 frame gate：
  - `src/core/allenkFdncnnOnnxRuntime.js`
  - `tests/core/allenkFdncnnOnnxRuntime.test.js`
  - `src/video/videoCleanupBackends.js`
    - 新增 `applyVideoResidualCleanupAsync()`；
    - `allenk-fdncnn-browser-spike` 后端支持异步 `runtime.denoiseImageData()`；
    - 支持 `allenkFdncnnPadding`，便于固定 shape ONNX 先以 `padding=0` 跑真实 72px ROI；
    - runtime 结果记录 `denoiseRuntimeRunMs`。
  - `scripts/run-video-frame-backend-lab.js`
    - 支持注入 `allenkFdncnnRuntime` / `allenkFdncnnSigma` / `allenkFdncnnPadding`；
    - frame lab JSON/Markdown 记录每帧 runtime 状态、MAC、run time。
  - `scripts/run-allenk-fdncnn-onnx-frame-lab.js`
  - `package.json`
    - 新增 `pnpm lab:allenk-fdncnn-onnx-frames`
  - `tests/scripts/allenkFdncnnOnnxFrameLab.test.js`
  - 真实 frame lab：
    - 命令：`pnpm lab:allenk-fdncnn-onnx-frames -- --timestamps "1,3,5" --padding 0 --sigma 75 --strength 0.85`
    - 输出：
      - `.artifacts/allenk-fdncnn/onnx-frame-lab/latest-report.json`
      - `.artifacts/allenk-fdncnn/onnx-frame-lab/latest-report.md`
      - `.artifacts/allenk-fdncnn/onnx-frame-lab/*-allenk-fdncnn-browser-spike.png`
    - runtime：`allenk-fdncnn-onnx-wasm`
    - per-frame MAC：`3460755456`
    - avg run：
      - `4d420881`: `~249.3ms`
      - `deaee69b`: `~252.6ms`
      - `e1997e6e`: `~264.4ms`
    - frame lab deltas：
      - `4d420881`: active `+0.0350` regressed；edge `-0.0462` improved；highBody `+0.0684` regressed。
      - `deaee69b`: active `-0.0757` improved；edge `-0.2111` improved；highBody `-0.0192` neutral。
      - `e1997e6e`: active `+0.0060` neutral；edge `-0.4329` improved；highBody `+0.1889` regressed。
  - 真实 gate：
    - 命令：`pnpm gate:video-denoise -- --reports .artifacts/allenk-fdncnn/onnx-frame-lab/latest-report.json --output .artifacts/allenk-fdncnn/onnx-frame-lab/gate-report.json --markdown .artifacts/allenk-fdncnn/onnx-frame-lab/gate-report.md`
    - 输出：
      - `.artifacts/allenk-fdncnn/onnx-frame-lab/gate-report.json`
      - `.artifacts/allenk-fdncnn/onnx-frame-lab/gate-report.md`
    - 决策：`allenk-fdncnn-browser-spike, strength=0.85`: `reject`
    - 原因：`4d420881` active/highBody material regression，`e1997e6e` highBody material regression。
  - 结论：
    - 目标链路已经从 synthetic seam 推进到真实 frame lab + gate；
    - 当前 ONNX/WASM/padding=0 后端不能 promote；
    - 下一步优先尝试更贴近 allenk 的 padded ROI，例如导出 `104x104` ONNX 并以 `padding=16` 跑同一 gate，或直接进入 WebGPU provider 性能/质量 smoke。
- 新增 104x104 padded ROI sweep：
  - 背景：
    - `72x72 / padding=0 / strength=0.85` 能执行但 gate `reject`；
    - allenk 原始流程有 padded ROI 上下文，当前视频水印为 `72px`，按默认 `padding=16` 推导固定模型输入应为 `104x104`。
  - 104 ONNX 导出：
    - 命令：`pnpm export:allenk-fdncnn-onnx -- --roi-size 104 --output-dir .artifacts/allenk-fdncnn/roi104`
    - 输出：
      - `.artifacts/allenk-fdncnn/roi104/model_core_fp32_104.onnx`
      - `.artifacts/allenk-fdncnn/roi104/onnx-manifest.json`
    - ONNX sha256: `cdbea952c0cf864ca9937c25ce6be0553209d9810fb7438201b9fb6109de59b0`
  - 104 runtime smoke：
    - 命令：`pnpm smoke:allenk-fdncnn-onnx-runtime -- --manifest .artifacts/allenk-fdncnn/roi104/onnx-manifest.json --output .artifacts/allenk-fdncnn/roi104/onnx-runtime-smoke.json`
    - input shape: `[1, 4, 104, 104]`
    - output shape: `[1, 3, 104, 104]`
    - WASM zero-input inference: `~477ms`
  - 104 / padding=16 / strength sweep：
    - `strength=0.85`
      - 命令：`pnpm lab:allenk-fdncnn-onnx-frames -- --manifest .artifacts/allenk-fdncnn/roi104/onnx-manifest.json --output-dir .artifacts/allenk-fdncnn/onnx-frame-lab-pad16 --timestamps "1,3,5" --padding 16 --sigma 75 --strength 0.85`
      - gate：`reject`
      - active：三例均 improved；
      - highBody：`4d420881 +0.0272` regressed，`e1997e6e +0.1663` regressed。
    - `strength=0.65`
      - 输出：`.artifacts/allenk-fdncnn/onnx-frame-lab-pad16-strength065`
      - gate：`reject`
      - active：三例均 improved；
      - highBody：`e1997e6e +0.1256` regressed。
    - `strength=0.45`
      - 输出：`.artifacts/allenk-fdncnn/onnx-frame-lab-pad16-strength045`
      - gate：`reject`
      - active：三例均 improved；
      - highBody：`e1997e6e +0.0669` regressed。
    - `strength=0.25`
      - 命令：`pnpm lab:allenk-fdncnn-onnx-frames -- --manifest .artifacts/allenk-fdncnn/roi104/onnx-manifest.json --output-dir .artifacts/allenk-fdncnn/onnx-frame-lab-pad16-strength025 --timestamps "1,3,5" --padding 16 --sigma 75 --strength 0.25`
      - gate 命令：`pnpm gate:video-denoise -- --reports .artifacts/allenk-fdncnn/onnx-frame-lab-pad16-strength025/latest-report.json --output .artifacts/allenk-fdncnn/onnx-frame-lab-pad16-strength025/gate-report.json --markdown .artifacts/allenk-fdncnn/onnx-frame-lab-pad16-strength025/gate-report.md`
      - gate：`promote-default-candidate`
      - active：
        - `4d420881`: `-0.0104` neutral
        - `deaee69b`: `-0.0057` neutral
        - `e1997e6e`: `-0.0611` improved
      - edge：
        - `4d420881`: `-0.0384` improved
        - `deaee69b`: `-0.0360` improved
        - `e1997e6e`: `-0.2412` improved
      - highBody：
        - `4d420881`: `+0.0012` neutral
        - `deaee69b`: `+0.0069` neutral
        - `e1997e6e`: `+0.0139` neutral
      - runtime avg:
        - `4d420881`: `~453.2ms`
        - `deaee69b`: `~456.5ms`
        - `e1997e6e`: `~461.1ms`
  - 当前判断：
    - 104 padded ROI 明显比 72 direct ROI 稳；
    - 高 strength 会带来 highBody 内容扰动，不能作为默认；
    - `strength=0.25` 是目前第一个通过现有 frame denoise gate 的 ONNX/WASM allenk FDnCNN 候选；
    - 仍需视频级导出/性能验证和人工审阅，不应仅凭 3 timestamp frame gate 直接发为 UI 默认。
- 新增视频级导出与控制复核：
  - 背景：
    - 直接调用 `removeGeminiVideoWatermark()` 的 Node 导出脚本在当前环境被 `createRuntimeCanvas()` 阻断，错误为 `当前环境没有可用 Canvas`；这是 Node/WebCodecs 调试路径限制，不代表浏览器路径不可行。
    - 为先拿到真实视频证据，新增离线帧序列导出：从现有 `gwr-video-mvp` baseline MP4 抽 PNG 帧，逐帧在右下 ROI 上应用 ONNX/WASM FDnCNN cleanup，再用 ffmpeg 封装 MP4。
  - 新增/更新脚本：
    - `scripts/export-allenk-fdncnn-onnx-frame-video.js`
      - 新增 `--crf` / `--preset`，默认 `crf=12`、`preset=slow`，避免未记录的默认编码质量污染指标。
      - 新增 `--skip-denoise`，用于生成完全相同帧往返管线的 no-op 控制视频。
    - `scripts/create-allenk-fdncnn-onnx-video-evidence.js`
      - 根据导出 report 生成 baseline + candidate 的 video benchmark manifest。
  - `4d420881 / 3s / 72 frames / crf10` 导出：
    - 命令：`pnpm export:allenk-fdncnn-onnx-frame-video -- --case 4d420881 --duration 3 --crf 10 --preset slow --output-dir .artifacts/allenk-fdncnn/video-frame-export-4d420881-pad16-strength025-crf10`
    - 输出：
      - `.artifacts/allenk-fdncnn/video-frame-export-4d420881-pad16-strength025-crf10/4d420881-pad16-strength025.mp4`
      - `.artifacts/allenk-fdncnn/video-frame-export-4d420881-pad16-strength025-crf10/4d420881-pad16-strength025-report.json`
    - runtime：`72` frames applied，平均 `~467.5ms/frame`。
  - 视频级 gate：
    - candidate benchmark：
      - `.artifacts/allenk-fdncnn/video-frame-export-4d420881-pad16-strength025-crf10/benchmark/latest-summary.json`
    - 直接重编码控制：
      - `.artifacts/allenk-fdncnn/video-frame-export-4d420881-pad16-strength025-crf10/encoding-control-benchmark/latest-summary.json`
      - 结论：CRF10 direct reencode 近似 neutral，不能解释 candidate 指标回归。
    - PNG 帧往返控制：
      - `.artifacts/allenk-fdncnn/video-frame-export-4d420881-pad16-strength025-crf10/png-roundtrip-control-benchmark/latest-summary.json`
      - 结论：仅 `video -> PNG frames -> MP4` 就会造成 active `+0.1372`、edge `+0.1051`、highBody `+0.1504` 的 apparent regression。
    - 综合控制 gate：
      - 命令：`pnpm gate:video-denoise -- --reports .artifacts/allenk-fdncnn/video-frame-export-4d420881-pad16-strength025-crf10/benchmark/latest-summary.json --control-reports '.artifacts/allenk-fdncnn/video-frame-export-4d420881-pad16-strength025-crf10/encoding-control-benchmark/latest-summary.json,.artifacts/allenk-fdncnn/video-frame-export-4d420881-pad16-strength025-crf10/png-roundtrip-control-benchmark/latest-summary.json' --output .artifacts/allenk-fdncnn/video-frame-export-4d420881-pad16-strength025-crf10/benchmark/gate-with-controls-report.json --markdown .artifacts/allenk-fdncnn/video-frame-export-4d420881-pad16-strength025-crf10/benchmark/gate-with-controls-report.md`
      - 决策：`insufficient-improvement`
      - 解释：candidate 的 apparent regressions 被 PNG roundtrip control 覆盖，但视频层没有留下足够正向收益，因此不能 promote。
  - `1,2` 早段 frame lab 复核：
    - 命令：`pnpm lab:allenk-fdncnn-onnx-frames -- --manifest .artifacts/allenk-fdncnn/roi104/onnx-manifest.json --output-dir .artifacts/allenk-fdncnn/onnx-frame-lab-pad16-strength025-t12 --timestamps "1,2" --padding 16 --sigma 75 --strength 0.25`
    - gate：`promote-default-candidate`
    - 结果：
      - `4d420881`: active `-0.0135` neutral，edge `-0.0492` improved
      - `deaee69b`: active `-0.0533` improved，edge `-0.1715` improved
      - `e1997e6e`: active `-0.0398` improved，edge `-0.1464` improved
  - 更新判断：
    - allenk FDnCNN ONNX 候选在 PNG 单帧层面是有效的，不是“完全学错”；
    - 当前视频级瓶颈转为 frame roundtrip / MP4 encode pipeline 对局部 residual 指标的破坏；
    - 在解决视频封装路径前，不能把 `allenk-fdncnn-browser-spike` 暴露为默认 UI 能力；
    - 下一步优先级应从继续调 strength 转为：
      - 让浏览器端原生视频导出路径直接接 async ROI runtime，减少离线 PNG roundtrip 伪影；
      - 或研究更接近 allenk 的视频编码/帧缓存方式，再重跑同一 video gate。
- 视频 ROI pipeline 触点：
  - `src/video/videoCleanupBackends.js`
    - 新增实验候选后端：`allenk-fdncnn-browser-spike`
  - 现阶段不暴露到 UI 下拉，不做假 AI 处理。
  - 当该后端被显式传入时：
    - normalize 接受该后端；
    - 未传 runtime 时返回 `denoiseRuntimeStatus=unavailable`，cleanup 阶段 fail-closed/no-op，不读取或写入 canvas；
    - 传入 `allenkFdncnnRuntime` 时会按 allenk padded ROI / alpha gradient mask / masked blend 调用 `runtime.denoiseImageData()` 并写回 canvas；
    - 后续 WebGPU/ONNX 或 Web NCNN runtime 应接入这个分支，替代 pure-js reference。
- 新增 runtime seam 证据：
  - `scripts/create-allenk-fdncnn-runtime-seam-report.js`
  - `package.json`
    - 新增 `pnpm report:allenk-fdncnn-runtime-seam`
  - `tests/scripts/allenkFdncnnRuntimeSeamReport.test.js`
  - 真实输出：
    - `.artifacts/allenk-fdncnn/runtime-seam/latest-report.json`
    - `.artifacts/allenk-fdncnn/runtime-seam/latest-report.md`
    - `.artifacts/allenk-fdncnn/runtime-seam/comparison-sheet.png`
  - 证据性质：
    - 小型合成 ROI；
    - 注入 `allenk-fdncnn-runtime-seam-fixture`；
    - 输出 frame-lab 兼容 report；
    - 可视 sheet 展示 baseline / allenk runtime seam / reference；
    - 用于证明 runtime seam 和 ROI pipeline 可运行，不用于证明真实视频默认可用。
- gate 更新：
  - `scripts/gate-video-denoise-candidates.js`
  - `tests/scripts/videoDenoiseCandidateGate.test.js`
  - 如果证据层标记 `syntheticSeamFixture=true`，候选决策降级为 `synthetic-seam-evidence-only`，避免把合成 seam 误判为 `promote-default-candidate`。
  - 本轮真实 gate：
    - 命令：`pnpm gate:video-denoise -- --reports .artifacts/allenk-fdncnn/runtime-seam/latest-report.json --output .artifacts/allenk-fdncnn/runtime-seam/gate-report.json --markdown .artifacts/allenk-fdncnn/runtime-seam/gate-report.md`
    - 输出：
      - `.artifacts/allenk-fdncnn/runtime-seam/gate-report.json`
      - `.artifacts/allenk-fdncnn/runtime-seam/gate-report.md`
    - 决策：`allenk-fdncnn-browser-spike, strength=1`: `synthetic-seam-evidence-only`
    - synthetic case 指标：
      - active meanAbs delta: `-30.0023`
      - edge meanAbs delta: `-30.0023`
      - lowBody / highBody: neutral
- 真实提取结果：
  - 命令：`pnpm extract:allenk-fdncnn`
  - 输出：
    - `.artifacts/allenk-fdncnn/model_core_fp16.param.bin`
    - `.artifacts/allenk-fdncnn/model_core_fp16.bin`
    - `.artifacts/allenk-fdncnn/manifest.json`
  - manifest 记录：
    - param bytes: `1464`
    - param sha256: `18a3a214fb25cdf3e68c05656e48f18cb83a0ee5499385caeecb79e591244b0c`
    - bin bytes: `1340124`
    - bin sha256: `e4cbf3ee91969c72d1e984a7c10afbf54f4f491cca064a4545ed3b3cb88007f5`
- 验证：
  - `pnpm exec node --test tests/scripts/extractAllenkFdncnnModel.test.js tests/scripts/scriptEntrypoints.test.js`
  - 结果：`5` tests passed。
  - `pnpm exec node --test tests/core/allenkFdncnnDenoise.test.js tests/scripts/extractAllenkFdncnnModel.test.js tests/scripts/scriptEntrypoints.test.js`
  - 结果：`13` tests passed。
  - `pnpm exec node --test tests/core/allenkFdncnnDenoise.test.js tests/core/allenkFdncnnNcnnModel.test.js tests/scripts/extractAllenkFdncnnModel.test.js tests/scripts/allenkFdncnnBrowserSpikeReport.test.js tests/scripts/scriptEntrypoints.test.js`
  - 结果：`22` tests passed。
  - `pnpm exec node --test tests/video/videoCleanupBackends.test.js tests/core/allenkFdncnnDenoise.test.js tests/core/allenkFdncnnNcnnModel.test.js tests/scripts/extractAllenkFdncnnModel.test.js tests/scripts/allenkFdncnnBrowserSpikeReport.test.js tests/scripts/scriptEntrypoints.test.js`
  - 结果：`40` tests passed。
  - `pnpm exec node --test tests/core/allenkFdncnnReferenceRuntime.test.js tests/core/allenkFdncnnDenoise.test.js tests/core/allenkFdncnnNcnnModel.test.js tests/video/videoCleanupBackends.test.js`
  - 结果：`37` tests passed。
  - `pnpm exec node --test tests/scripts/videoDenoiseCandidateGate.test.js tests/scripts/allenkFdncnnRuntimeSeamReport.test.js tests/scripts/scriptEntrypoints.test.js`
  - 结果：`10` tests passed。
  - `pnpm report:allenk-fdncnn-runtime-seam`
  - 结果：runtime seam frame-lab report 和 comparison sheet 已生成。
  - `pnpm extract:allenk-fdncnn`
  - 结果：真实模型 manifest 已重生，包含结构摘要和 `20` 个权重段。
  - `pnpm report:allenk-fdncnn-browser-spike`
  - 结果：真实 browser spike report 已生成。
  - `pnpm exec node --test tests/core/allenkFdncnnOnnxExport.test.js tests/scripts/allenkFdncnnOnnxExport.test.js tests/scripts/allenkFdncnnBrowserSpikeReport.test.js tests/scripts/scriptEntrypoints.test.js`
  - 结果：`11` tests passed。
  - `pnpm export:allenk-fdncnn-onnx`
  - 结果：真实 ONNX FP32 72 ROI 模型已生成。
  - `pnpm smoke:allenk-fdncnn-onnx-runtime`
  - 结果：`onnxruntime-web` WASM backend 可加载并执行真实 72 ROI ONNX。
  - `pnpm exec node --test tests/scripts/allenkFdncnnOnnxRuntimeSmoke.test.js tests/scripts/allenkFdncnnOnnxExport.test.js tests/core/allenkFdncnnOnnxExport.test.js tests/scripts/scriptEntrypoints.test.js`
  - 结果：`8` tests passed。
  - `pnpm exec node --test tests/core/allenkFdncnnOnnxRuntime.test.js tests/video/videoCleanupBackends.test.js tests/scripts/allenkFdncnnOnnxFrameLab.test.js tests/scripts/scriptEntrypoints.test.js`
  - 结果：`25` tests passed。
  - `pnpm lab:allenk-fdncnn-onnx-frames -- --timestamps "1,3,5" --padding 0 --sigma 75 --strength 0.85`
  - 结果：真实 ONNX/WASM frame lab 已生成，3 个 baseline case 均成功应用 runtime。
  - `pnpm gate:video-denoise -- --reports .artifacts/allenk-fdncnn/onnx-frame-lab/latest-report.json --output .artifacts/allenk-fdncnn/onnx-frame-lab/gate-report.json --markdown .artifacts/allenk-fdncnn/onnx-frame-lab/gate-report.md`
  - 结果：`allenk-fdncnn-browser-spike, strength=0.85` 被 gate `reject`，不允许 promote。
  - `pnpm export:allenk-fdncnn-onnx -- --roi-size 104 --output-dir .artifacts/allenk-fdncnn/roi104`
  - 结果：真实 ONNX FP32 104 padded ROI 模型已生成。
  - `pnpm smoke:allenk-fdncnn-onnx-runtime -- --manifest .artifacts/allenk-fdncnn/roi104/onnx-manifest.json --output .artifacts/allenk-fdncnn/roi104/onnx-runtime-smoke.json`
  - 结果：`onnxruntime-web` WASM backend 可加载并执行真实 104 ROI ONNX。
  - `pnpm lab:allenk-fdncnn-onnx-frames -- --manifest .artifacts/allenk-fdncnn/roi104/onnx-manifest.json --output-dir .artifacts/allenk-fdncnn/onnx-frame-lab-pad16-strength025 --timestamps "1,3,5" --padding 16 --sigma 75 --strength 0.25`
  - 结果：真实 104/padding16/strength025 frame lab 已生成。
  - `pnpm gate:video-denoise -- --reports .artifacts/allenk-fdncnn/onnx-frame-lab-pad16-strength025/latest-report.json --output .artifacts/allenk-fdncnn/onnx-frame-lab-pad16-strength025/gate-report.json --markdown .artifacts/allenk-fdncnn/onnx-frame-lab-pad16-strength025/gate-report.md`
  - 结果：`allenk-fdncnn-browser-spike, strength=0.25` 通过 frame gate，决策为 `promote-default-candidate`。
  - `pnpm export:allenk-fdncnn-onnx-frame-video -- --case 4d420881 --duration 3 --crf 10 --preset slow --output-dir .artifacts/allenk-fdncnn/video-frame-export-4d420881-pad16-strength025-crf10`
  - 结果：`4d420881` 3s/72-frame ONNX/WASM video export 已生成，平均 `~467.5ms/frame`。
  - `pnpm benchmark:video-crops -- --manifest .artifacts/allenk-fdncnn/video-frame-export-4d420881-pad16-strength025-crf10/benchmark-manifest.json --output-dir .artifacts/allenk-fdncnn/video-frame-export-4d420881-pad16-strength025-crf10/benchmark --summary .artifacts/allenk-fdncnn/video-frame-export-4d420881-pad16-strength025-crf10/benchmark/latest-summary.json`
  - 结果：candidate video benchmark 已生成。
  - `pnpm gate:video-denoise -- --reports .artifacts/allenk-fdncnn/video-frame-export-4d420881-pad16-strength025-crf10/benchmark/latest-summary.json --control-reports '.artifacts/allenk-fdncnn/video-frame-export-4d420881-pad16-strength025-crf10/encoding-control-benchmark/latest-summary.json,.artifacts/allenk-fdncnn/video-frame-export-4d420881-pad16-strength025-crf10/png-roundtrip-control-benchmark/latest-summary.json' --output .artifacts/allenk-fdncnn/video-frame-export-4d420881-pad16-strength025-crf10/benchmark/gate-with-controls-report.json --markdown .artifacts/allenk-fdncnn/video-frame-export-4d420881-pad16-strength025-crf10/benchmark/gate-with-controls-report.md`
  - 结果：视频级决策为 `insufficient-improvement`，不允许默认启用。
  - `pnpm exec node --test tests/scripts/allenkFdncnnOnnxFrameVideoExport.test.js tests/scripts/scriptEntrypoints.test.js tests/video/videoCleanupBackends.test.js tests/core/allenkFdncnnOnnxRuntime.test.js`
  - 结果：`25` tests passed。
  - `pnpm build`
  - 结果：build passed。
- 更新判断：
  - “直接学习 allenk”在工程上应拆成两层：
    - 算法层：复刻 ROI mask 构造、FDnCNN 输入输出、sigma / strength / padding / blend 策略。
    - 运行时层：已生成固定 72 ROI 和 104 padded ROI ONNX FP32 资产，并用 `onnxruntime-web` WASM 完成可执行性 smoke；已接入 async video ROI pipeline 并产生真实 frame gate。当前 frame 级可通过 gate 的候选是 `104x104 / padding=16 / strength=0.25`。
  - 不应继续把纯 Canvas 去噪伪装成 allenk 等价能力；它只能保留为 fallback。
  - 视频级复核后，该候选暂定为 `insufficient-improvement`：算法在单帧 ROI 上有效，但当前离线帧往返导出会吞掉收益；下一步应优先修浏览器视频导出接入 async ROI runtime / 编码链路，而不是继续微调 FDnCNN strength。

### 2026-06-12 浏览器端 AI 后端接入 smoke

- 目标：
  - 把已导出的 `104x104 / padding=16 / strength=0.25` allenk FDnCNN ONNX 候选接到真实 `video-preview.html` 导出流程；
  - 先作为高级/调试后端可选，不默认启用；
  - 验证页面上传视频后能在浏览器内懒加载模型、逐帧处理并导出 MP4。
- 代码接入：
  - `src/core/allenkFdncnnOnnxRuntime.js`
    - runtime import 改为 `onnxruntime-web/wasm`；
    - 支持传入 `wasmPaths`，浏览器端固定走 WASM EP；
    - `numThreads` 默认 `1`，`proxy=false`，避免调试页 worker/proxy 复杂性。
  - `src/video-app.js`
    - 新增模型路径：`./models/allenk-fdncnn/model_core_fp32_104.onnx`；
    - 新增 WASM runtime 路径：`./onnxruntime/ort-wasm-simd-threaded.js` / `.wasm`；
    - 导出时如果选择 `allenk-fdncnn-browser-spike`：
      - 保留用户手选的调试后端，不被自动 preset 覆盖；
      - 自动设置 `edgeDenoiseStrength=0.25`；
      - 懒加载 ONNX runtime；
      - 向 `removeGeminiVideoWatermark()` 传入 `allenkFdncnnRuntime`、`allenkFdncnnSigma=75`、`allenkFdncnnPadding=16`。
  - `public/video-preview.html`
    - 后端去噪下拉新增 `AI FDnCNN ONNX（调试）`。
  - `build.js`
    - 静态服务 MIME 增加 `.mjs`、`.onnx`、`.wasm`。
- 新增静态资产：
  - `public/models/allenk-fdncnn/model_core_fp32_104.onnx`
    - bytes: `2679703`
  - `public/onnxruntime/ort-wasm-simd-threaded.js`
    - bytes: `24180`
  - `public/onnxruntime/ort-wasm-simd-threaded.mjs`
    - bytes: `24180`
  - `public/onnxruntime/ort-wasm-simd-threaded.wasm`
    - bytes: `13022405`
- 验证：
  - 单元/脚本：
    - `pnpm exec node --test tests/core/allenkFdncnnOnnxRuntime.test.js tests/video/videoCleanupBackends.test.js tests/scripts/scriptEntrypoints.test.js`
    - 结果：`24` tests passed。
  - 构建：
    - `pnpm build`
    - 结果：build passed。
  - 页面静态资源：
    - `http://127.0.0.1:4173/video-preview.html` 可访问；
    - 调试下拉存在 `AI FDnCNN ONNX（调试）`；
    - ONNX 模型 fetch 成功，bytes `2679703`。
  - 浏览器真实导出 smoke：
    - 输入：
      - `.artifacts/allenk-fdncnn/browser-ai-smoke-025s-source.mp4`
      - 从 `${GWR_VIDEO_SAMPLE_ROOT}\4d420881-c144-497f-9a6e-43beda086580.mp4` 截取 `0.25s`。
    - 页面参数：
      - `sampleCount=4`
      - `allowLowConfidence=true`
      - `denoiseBackend=allenk-fdncnn-browser-spike`
      - `edgeDenoiseStrength=0.25`
    - 页面结果：
      - `导出完成，已处理 6 帧，后端去噪：allenk-fdncnn-browser-spike。音频未保留：no-audio-track。`
    - 导出：
      - `.artifacts/allenk-fdncnn/browser-ai-smoke-025s-after.mp4`
    - 对比视频：
      - `.artifacts/allenk-fdncnn/browser-ai-smoke-025s-compare.mp4`
    - 对比首帧：
      - `.artifacts/allenk-fdncnn/browser-ai-smoke-025s-compare.png`
  - 浏览器真实导出 1s smoke：
    - 输入：
      - `.artifacts/allenk-fdncnn/browser-ai-smoke-1s-source.mp4`
    - 页面结果：
      - `导出完成，已处理 24 帧，后端去噪：allenk-fdncnn-browser-spike。音频未保留：no-audio-track。`
    - 导出：
      - `.artifacts/allenk-fdncnn/browser-ai-smoke-1s-after.mp4`
      - bytes: `750231`
    - 对比视频：
      - `.artifacts/allenk-fdncnn/browser-ai-smoke-1s-compare.mp4`
    - 对比首帧：
      - `.artifacts/allenk-fdncnn/browser-ai-smoke-1s-compare.png`
    - 视觉结论：
      - 星形水印主体明显被压低；
      - 残留主要转为暗部轻微块状/纹理扰动；
      - 已足够用于页面调试和人工复核，但仍需要多样本 browser-native gate 才能默认启用。
- 已知小问题：
  - 当前 VS Code 中已启动的本地 dev server 可能还没吃到 `build.js` 的新 MIME 表；
  - 在旧 server 上 `.wasm` 会触发一次 `wasm streaming compile failed ... Incorrect response MIME type`，随后 `onnxruntime-web` 会 fallback 到 ArrayBuffer 实例化，实测仍可成功导出；
  - 重启本地 dev server 后应使用新的 `.wasm = application/wasm` MIME，消除该 warning。
- 当前判断：
  - 浏览器端 AI 后端已经从“脚本验证”推进到“页面可试用”；
  - 0.25s smoke 的右下角 ROI 视觉上能明显压掉 Gemini 星形水印主体；
  - 仍不默认启用，原因是此前视频级 gate 仍为 `insufficient-improvement`，需要更多浏览器原生导出样本验证稳定收益；
  - 下一步应做更长片段 / 多样本 browser-native gate，而不是继续只看离线 PNG roundtrip。

### 2026-06-12 产品化调整：默认 AI，隐藏内部参数

- 用户判断：
  - 先保证可用；
  - 默认就开启 AI 方案；
  - 调试页不需要展示 Alpha、后端、去噪强度、抽帧数等内部参数。
- 本轮调整：
  - `src/video/videoPresetPolicy.js`
    - `standard-auto` 默认改为 `allenk-fdncnn-browser-spike`；
    - `edgeDenoiseStrength` 固定为 `0.25`；
    - 迁移锚点检测也保留在 AI 路径，不再自动切回 Canvas 时序匹配；
    - 文案统一为 `AI 自动处理`。
  - `public/video-preview.html`
    - 移除可见的 `高级参数` 面板；
    - Alpha / 自适应 Alpha / 实验边缘去噪 / 后端去噪 / 迁移锚点按钮 / 边缘强度 / 边缘软清理 / 抽帧数 / 码率 / 允许低置信等控件改为隐藏内部控件；
    - 可见主流程只保留选择文件、检测、重置、自动导出、下载、视频信息、检测结果。
  - `src/video-app.js`
    - 初始化时直接套用 `getAutomaticVideoPresetConfig()`，页面默认值即 AI 后端；
    - 导出完成文案改为 `AI 去水印已完成`，不暴露 `allenk-fdncnn-browser-spike` 工程名；
    - 选择/自动套 preset 时不再弹出调试后端提示。
- 验证：
  - `pnpm exec node --test tests/video/videoPresetPolicy.test.js tests/video/videoCleanupBackends.test.js tests/core/allenkFdncnnOnnxRuntime.test.js tests/scripts/scriptEntrypoints.test.js`
  - 结果：`29` tests passed。
  - `pnpm build`
  - 结果：build passed。
  - 浏览器 UI smoke：
    - 页面可见文本不再包含 `高级参数` / `后端去噪`；
    - 默认隐藏值：
      - `denoiseBackend = allenk-fdncnn-browser-spike`
      - `edgeDenoiseStrength = 0.25`
  - 浏览器默认导出 smoke：
    - 不手动选择任何参数；
    - 输入 `.artifacts/allenk-fdncnn/browser-ai-smoke-025s-source.mp4`；
    - 输出状态：`AI 去水印已完成，已处理 6 帧。音频未保留：no-audio-track。`
    - 下载按钮可用。

### 2026-06-12 allenk 学习深化：AI 先行，残影收尾

- 背景：
  - 用户要求充分学习 allenk，不只是把 AI 后端设为默认。
  - 本轮重新对照现有 allenk ONNX 实验脚本，发现离线 frame/video 导出都是 `residualCleanupStrength=0`，即模型路径本身不依赖旧的前置 soft cleanup。
- 实验结论：
  - 浏览器默认导出改成纯 AI-only 后：
    - 输出：`.artifacts/allenk-fdncnn/browser-ai-only-default-1s-after.mp4`
    - 对比：`.artifacts/allenk-fdncnn/browser-ai-only-default-1s-compare.mp4`
    - 视觉问题：保留了更多纹理，但水印星形轮廓明显回归。
  - 因此不能简单删除 residual cleanup。
  - 更合理的 allenk 学习方向是：
    - 先执行 FDnCNN ONNX；
    - 再用 mask 约束的 residual cleanup 只做残影收尾；
    - 避免旧流程里“先 soft cleanup 糊一遍，再让 AI 接手”的顺序。
- 代码调整：
  - `src/video/videoCleanupBackends.js`
    - 对 `allenk-fdncnn-browser-spike` 特殊处理 cleanup 顺序；
    - 同步 / 异步路径都改成：
      - `applyAllenkFdncnnRuntime(...)`
      - 然后 `applySoftResidualCleanup(...)`
    - 非 AI 后端仍保持旧顺序，避免影响 Canvas 实验后端。
  - `tests/video/videoCleanupBackends.test.js`
    - 新增顺序测试：
      - `get-ai-roi`
      - `runtime`
      - `put-ai-roi`
      - `get-polish-roi`
      - `put-polish-roi`
  - `src/video/videoPresetPolicy.js`
    - 默认仍保留 `residualCleanupStrength=1.5`，但现在它是 AI 后的残影收尾，不再是前置糊化。
- 新 browser-native 证据：
  - 默认导出：
    - `.artifacts/allenk-fdncnn/browser-ai-postpolish-default-1s-after.mp4`
    - status：`AI 去水印已完成，已处理 24 帧。音频未保留：no-audio-track。`
  - 四列对比：
    - `.artifacts/allenk-fdncnn/browser-ai-postpolish-default-1s-compare.mp4`
    - `.artifacts/allenk-fdncnn/browser-ai-postpolish-default-1s-compare.png`
  - 视觉判断：
    - `ai-only` 轮廓明显，不适合作为默认；
    - `ai-post-polish` 压住轮廓，同时保留了“AI 先处理”的更合理流水线；
    - 后续如果继续学习 allenk，应优化 AI blend/mask，而不是回到先糊后 AI。
- 验证：
  - `pnpm exec node --test tests/video/videoCleanupBackends.test.js tests/video/videoPresetPolicy.test.js tests/core/allenkFdncnnOnnxRuntime.test.js`
  - 结果：`29` tests passed。

### 2026-06-12 allenk 学习深化：FDnCNN blend 覆盖 alpha footprint

- allenk 日志线索：
  - `NcnnDenoiser: sigma=75, strength=180%, roi=200x200, 5184 edge pixels`
  - `5184 = 72 * 72`
  - 这说明 allenk 的 denoise 有效像素覆盖整个 72px 水印 footprint，而不是只处理窄边线。
- 当前差距：
  - 旧 `createAllenkGradientMask()` 主要是 alpha gradient 边缘权重；
  - 即使接入 FDnCNN，模型也只在边缘附近参与混合；
  - 这会让 AI 后端过度依赖后续 polish 来压掉主体残影。
- 本轮调整：
  - `src/core/allenkFdncnnDenoise.js`
    - `createAllenkGradientMask()` 保留边缘优先；
    - 新增 alpha footprint 低权重覆盖：
      - `footprintStrength = 0.65`
      - `footprintGamma = 0.65`
    - 最终权重为 `max(edgeWeight, footprintWeight)`；
    - 保持默认 `strength=0.25` 时，边缘仍更强，主体内部也有非零 AI blend。
  - `tests/core/allenkFdncnnDenoise.test.js`
    - 新增断言：alpha footprint 中心必须有非零权重；
    - 仍保持 edge weight 大于 center weight。
- browser-native 证据：
  - 默认导出：
    - `.artifacts/allenk-fdncnn/browser-ai-footprint-mask-1s-after.mp4`
    - status：`AI 去水印已完成，已处理 24 帧。音频未保留：no-audio-track。`
  - 对比：
    - `.artifacts/allenk-fdncnn/browser-ai-footprint-mask-1s-compare.mp4`
    - `.artifacts/allenk-fdncnn/browser-ai-footprint-mask-1s-compare.png`
  - 视觉判断：
    - 没有复现 `ai-only` 的明显星形轮廓回归；
    - 相比上一版 `post-polish`，暗部中心残影略更平顺；
    - 可保留为默认 AI blend 改进。
- frame lab / gate：
  - 命令：
    - `pnpm lab:allenk-fdncnn-onnx-frames -- --manifest .artifacts/allenk-fdncnn/roi104/onnx-manifest.json --output-dir .artifacts/allenk-fdncnn/onnx-frame-lab-footprint-mask-t12 --timestamps "1,2" --padding 16 --sigma 75 --strength 0.25`
  - 结果：
    - `4d420881`: active `-0.0296` improved，edge `-0.0492` improved，highBody `-0.0215` improved
    - `deaee69b`: active `-0.0890` improved，edge `-0.1715` improved，highBody `-0.0546` improved
    - `e1997e6e`: active `-0.0608` improved，edge `-0.1464` improved，highBody `-0.0251` improved
  - gate：
    - `pnpm gate:video-denoise -- --reports .artifacts/allenk-fdncnn/onnx-frame-lab-footprint-mask-t12/latest-report.json --output .artifacts/allenk-fdncnn/onnx-frame-lab-footprint-mask-t12/gate-report.json --markdown .artifacts/allenk-fdncnn/onnx-frame-lab-footprint-mask-t12/gate-report.md`
    - 决策：`allenk-fdncnn-browser-spike, strength=0.25` -> `promote-default-candidate`
    - improved cases: `3`
    - material fail layers: `0`

### 2026-06-12 allenk 学习深化：ROI 200 与纹理保留

- ROI 200 对齐实验：
  - allenk 日志显示 `roi=200x200`；
  - 本轮导出固定 shape ONNX：
    - `pnpm export:allenk-fdncnn-onnx -- --roi-size 200 --output-dir .artifacts/allenk-fdncnn/roi200`
    - 输出：`.artifacts/allenk-fdncnn/roi200/model_core_fp32_200.onnx`
    - bytes: `2679707`
  - WASM smoke：
    - `pnpm smoke:allenk-fdncnn-onnx-runtime -- --manifest .artifacts/allenk-fdncnn/roi200/onnx-manifest.json --output .artifacts/allenk-fdncnn/roi200/onnx-runtime-smoke.json`
    - shape：`[1,4,200,200] -> [1,3,200,200]`
    - run：`~1754.9ms/frame`
  - 全帧 1s 导出：
    - `pnpm export:allenk-fdncnn-onnx-frame-video -- --manifest .artifacts/allenk-fdncnn/roi200/onnx-manifest.json --case 4d420881 --duration 1 --padding 64 --sigma 75 --strength 0.25 --crf 12 --preset medium --output-dir .artifacts/allenk-fdncnn/video-frame-export-4d420881-roi200-pad64-strength025-1s`
    - frames：`24`
    - avg runtime：`~1754.7ms/frame`
  - 对比：
    - `.artifacts/allenk-fdncnn/roi104-vs-roi200-vs-allenk-1s-compare.mp4`
    - `.artifacts/allenk-fdncnn/roi104-vs-roi200-vs-allenk-1s-compare.png`
  - 判断：
    - ROI 200 更贴近 allenk 的输入上下文；
    - 但 WASM 性能约为 ROI 104 的 `3.8x` 慢；
    - 1s 视觉没有肉眼级超越 ROI 104；
    - 暂不进入浏览器默认，保留为高质量/未来 WebGPU 候选。
- 纹理保留实验：
  - 观察：
    - allenk 参考更能保留皮革/塑料颗粒；
    - 我们的 104/200 AI 输出仍偏平滑暗斑。
  - 本轮调整：
    - `src/core/allenkFdncnnDenoise.js`
      - `blendAllenkDenoisedRoi()` 新增可选局部 highpass 保留；
      - 使用原始 ROI 的 `3x3` 局部高频；
      - 单通道 highpass 限制在 `[-14,14]`；
      - 视频 AI path 使用 `preserveHighpassStrength=0.32`；
      - 目标是轻微恢复材质颗粒，不重引入水印轮廓。
    - `tests/core/allenkFdncnnDenoise.test.js`
      - 新增 highpass texture preserve 单测。
  - browser-native 证据：
    - 默认导出：
      - `.artifacts/allenk-fdncnn/browser-ai-texture-preserve-1s-after.mp4`
    - 对比：
      - `.artifacts/allenk-fdncnn/browser-ai-texture-preserve-1s-compare.mp4`
      - `.artifacts/allenk-fdncnn/browser-ai-texture-preserve-1s-compare.png`
  - frame lab：
    - `pnpm lab:allenk-fdncnn-onnx-frames -- --manifest .artifacts/allenk-fdncnn/roi104/onnx-manifest.json --output-dir .artifacts/allenk-fdncnn/onnx-frame-lab-texture-preserve-t12 --timestamps "1,2" --padding 16 --sigma 75 --strength 0.25`
    - `4d420881`: active `-0.0291` improved，edge `-0.0470` improved
    - `deaee69b`: active `-0.0918` improved，edge `-0.1723` improved
    - `e1997e6e`: active `-0.0569` improved，edge `-0.1407` improved
  - gate：
    - `pnpm gate:video-denoise -- --reports .artifacts/allenk-fdncnn/onnx-frame-lab-texture-preserve-t12/latest-report.json --output .artifacts/allenk-fdncnn/onnx-frame-lab-texture-preserve-t12/gate-report.json --markdown .artifacts/allenk-fdncnn/onnx-frame-lab-texture-preserve-t12/gate-report.md`
    - 决策：`promote-default-candidate`
    - improved cases：`3`
    - material fail layers：`0`
  - 判断：
    - highpass 回灌没有带回明显星形轮廓；
    - 对纹理自然度是细微补偿，不是决定性跃迁；
    - 保留，但后续仍要继续寻找更接近 allenk 的纹理建模或 WebGPU 路径。

### 2026-06-12 browser-native 默认 AI 三样本验证与结构保护 v2

- 背景：
  - 用户反馈默认 AI 方案仍能看到明显水印/残影；
  - 本轮目标不是继续暴露更多参数，而是保持“默认自动处理”前提下，缩小与 allenk 的视觉差距。
- browser-native 默认导出基线：
  - 页面：`http://127.0.0.1:4173/video-preview.html`
  - 输入 1s 样本：
    - `.artifacts/browser-native-default-gate/4d420881-source-1s.mp4`
    - `.artifacts/browser-native-default-gate/deaee69b-source-1s.mp4`
    - `.artifacts/browser-native-default-gate/e1997e6e-source-1s.mp4`
  - 默认 AI 输出：
    - `.artifacts/browser-native-default-gate/4d420881-default-ai-after-1s.mp4`
    - `.artifacts/browser-native-default-gate/deaee69b-default-ai-after-1s.mp4`
    - `.artifacts/browser-native-default-gate/e1997e6e-default-ai-after-1s.mp4`
  - 观察：
    - `4d420881` / `deaee69b`：水印主体基本压下去，仍比 allenk 更平滑；
    - `e1997e6e`：斜向亮边区域有灰雾/抹脏，说明 AI 后的 residual cleanup 会误伤真实结构。
- 本轮代码调整：
  - `src/video/videoCleanupBackends.js`
    - 新增 `buildLumaStructureGuard()`，从当前 ROI 亮度 Sobel 梯度构建真实结构保护权重；
    - 仅在 allenk FDnCNN AI 后置 residual cleanup 中启用；
    - v1 直接保护强结构，导致 `4d420881` / `deaee69b` 的菱形水印边缘也被保护，出现轮廓回归；
    - v2 加入 alpha 模板边缘退让：
      - cleanup 权重越像水印模板边缘，结构保护越弱；
      - 与水印模板不一致的真实斜线/高光边缘才继续保护。
  - `scripts/export-video-backend-variant.js`
    - 兼容隐藏高级控件；
    - `--page` 支持直接传 HTTP URL，避免 `file://dist` 下 ONNX/WASM fetch 失败。
  - `tests/video/videoCleanupBackends.test.js`
    - 新增 `buildLumaStructureGuard should protect strong image edges`。
- v2 browser-native 证据：
  - 输出：
    - `.artifacts/browser-native-default-gate/4d420881-structure-guard-v2-after-1s.mp4`
    - `.artifacts/browser-native-default-gate/deaee69b-structure-guard-v2-after-1s.mp4`
    - `.artifacts/browser-native-default-gate/e1997e6e-structure-guard-v2-after-1s.mp4`
  - 对比图：
    - `.artifacts/browser-native-default-gate/4d420881-source-old-guard-v2-allenk-compare.png`
    - `.artifacts/browser-native-default-gate/deaee69b-source-old-guard-v2-allenk-compare.png`
    - `.artifacts/browser-native-default-gate/e1997e6e-source-old-guard-v2-allenk-compare.png`
  - 对比视频：
    - `.artifacts/browser-native-default-gate/4d420881-source-old-guard-v2-allenk-compare.mp4`
    - `.artifacts/browser-native-default-gate/deaee69b-source-old-guard-v2-allenk-compare.mp4`
    - `.artifacts/browser-native-default-gate/e1997e6e-source-old-guard-v2-allenk-compare.mp4`
- 视觉结论：
  - `4d420881`：v2 没有复现 v1 的菱形轮廓回归，整体与旧默认接近；
  - `deaee69b`：v2 没有明显新增轮廓，轮胎/轮毂区域保持可用；
  - `e1997e6e`：v2 仍未完全追平 allenk，但旧默认的灰雾和亮边污染有所减轻；
  - 结构保护 v2 可保留为默认 AI 后处理改进。
- 验证：
  - `pnpm exec node --test tests/video/videoCleanupBackends.test.js tests/core/allenkFdncnnDenoise.test.js tests/video/videoPresetPolicy.test.js tests/core/allenkFdncnnOnnxRuntime.test.js tests/scripts/scriptEntrypoints.test.js`
    - `40` tests passed
  - `pnpm build`
    - passed

## 2026-06-12 alpha profile 与动态 alpha 复核

- 新增 `--alpha-profile` 调试入口，可从 `pnpm export:video-backend` 透传到浏览器页的检测与导出流程；默认仍保持 `96-20260520`，避免把未经验证的 alpha profile 生产化。
- 试验 `alphaProfile=96 + ROI200 + allenk FDnCNN` 后，右下 ROI 视觉残影没有改善；相对 allenk 的 residual 指标明显变差：active RMS 约 `4.2194`，而默认 ROI200 相对 allenk 的 active RMS 约 `0.0006`。
- 试验 `adaptive-alpha + ROI200 + allenk FDnCNN` 后，视觉结果与固定 seed 版本基本一致，说明当前差距不主要来自 per-frame seed scale。
- 复核 allenk 源码的通道顺序与归一化：BGR ROI -> RGB float `[0,1]` -> `[R,G,B,sigma/255]` CHW -> RGB output -> BGR uint8。浏览器 ONNX 路径的 RGBA -> `[R,G,B,sigma/255]` 与其一致，未发现明显通道错配。
- 当前判断：不要把 `96` profile 或 adaptive alpha 升为默认。下一步更值得做的是扩大样片覆盖，检查用户当前页面是否确实加载了最新 `dist`/200x200 模型，以及把“默认 ROI200 vs allenk”作为主要验收对照。

Artifacts:

- `.artifacts/browser-native-default-gate/4d420881-ai-roi200-alpha96-after-1s.mp4`
- `.artifacts/browser-native-default-gate/4d420881-ai-roi200-adaptive-after-1s.mp4`
- `.artifacts/browser-native-default-gate/4d420881-roi200-alpha96-allenk-compare.png`
- `.artifacts/browser-native-default-gate/4d420881-roi200-adaptive-alpha96-allenk-compare.png`
- `.artifacts/browser-native-default-gate/4d420881-roi200-vs-allenk-residual.json`
- `.artifacts/browser-native-default-gate/4d420881-alpha96-vs-allenk-residual.json`

## 2026-06-12 ROI200 后置 cleanup 0.4 复核

- 触发原因：
  - `alphaProfile=96` 和 `adaptive-alpha` 均未带来收益；
  - `e1997e6e` 在 `ROI200 + residualCleanup=0` 下仍有轻微暗部残点；
  - 之前 `0.8` / `1.5` 强度容易过软或误伤结构，因此改试更温和的 `0.4`。
- 本轮输出：
  - `.artifacts/browser-native-default-gate/4d420881-ai-roi200-cleanup040-after-1s.mp4`
  - `.artifacts/browser-native-default-gate/deaee69b-ai-roi200-cleanup040-after-1s.mp4`
  - `.artifacts/browser-native-default-gate/e1997e6e-ai-roi200-cleanup040-after-1s.mp4`
- 对比证据：
  - `.artifacts/browser-native-default-gate/4d420881-roi200-cleanup040-allenk-compare.png`
  - `.artifacts/browser-native-default-gate/deaee69b-roi200-cleanup040-compare.png`
  - `.artifacts/browser-native-default-gate/e1997e6e-roi200-cleanup040-compare.png`
- 视觉判断：
  - `4d420881`：`cleanup=0.4` 比 `0` 略接近 allenk，未出现明显新污点；
  - `deaee69b`：与 `0` 基本接近，没有明显轮胎/轮毂结构回退；
  - `e1997e6e`：暗部残点略有改善，亮边没有恢复到早期强 cleanup 的明显抹脏。
- 代码调整：
  - `src/video/videoPresetPolicy.js`
    - 默认 AI 自动预设的 `residualCleanupStrength` 从 `0` 调整为 `0.4`；
    - 继续保留 `allenk-fdncnn-browser-spike`、`edgeDenoiseStrength=1.8`、`ROI200` 模型路线。
  - `src/video-app.js`
    - 修复隐藏高级 range 控件初始化时 label 不同步的问题；
    - 修复 `edgeDenoiseStrength=1.8` 被旧 `max=1` range 夹成 `1.0` 的问题，真实页面默认现在会扩展 max 并应用 `1.8`。
- 当前判断：
  - `0.4` 是比 `0` 更稳的默认候选；
  - 它不是完美追平 allenk，但在三条样片上比继续调 alpha 更有实际收益；
  - 下一步应围绕“确认用户页面实际加载最新 dist + 增加多样片 ROI 审核”收尾，而不是继续扩大参数面板。
- 验证：
  - `pnpm exec node --test tests/video/videoPresetPolicy.test.js tests/video/videoCleanupBackends.test.js tests/video/videoWatermarkDetector.test.js`
    - `38` tests passed
  - `pnpm build`
    - passed
  - Playwright 复查 `http://127.0.0.1:4173/video-preview.html`
    - `denoiseBackend=allenk-fdncnn-browser-spike`
    - `edgeDenoiseStrength=1.8`
    - `residualCleanup=0.4`
    - `controlsHidden=true`
    - active JS contains `model_core_fp32_200.onnx`, `1,4,200,200`, `allenkFdncnnPadding:64`

## 2026-06-12 视频 AI 路径性能复核

- 触发原因：
  - 用户反馈 `ROI200 + allenk FDnCNN` 效果明显变好，但导出速度太慢。
- 浏览器实测环境：
  - URL：`http://localhost:4173/video-preview.html`
  - 样片：`.artifacts/browser-native-default-gate/4d420881-source-1s.mp4`
  - 当前服务环境：
    - `navigator.gpu = true`
    - `crossOriginIsolated = false`
    - `SharedArrayBuffer = false`
    - `./onnxruntime/ort-wasm-simd-threaded.jsep.mjs` 被服务为 `application/octet-stream`
    - `.wasm` 也未按 `application/wasm` 服务，浏览器只能走 ArrayBuffer fallback
- 性能结论：
  - 真正瓶颈是每帧 `200x200` FDnCNN ONNX 推理；
  - WebGPU 已接入但被当前静态服务 MIME 阻断；
  - WASM threads 需要 COOP/COEP，当前页面未满足。
- 代码调整：
  - `src/core/allenkFdncnnOnnxRuntime.js`
    - 修复 WebGPU 失败后 WASM fallback 执行时仍引用空 `ort` 参数的问题；
    - WebGPU runtime 改为必须显式注入，避免失败路径污染默认 WASM。
  - `src/video-app.js`
    - WebGPU runtime 加入 `.mjs` MIME 预检；
    - 默认先尝试 WebGPU，不满足时安全降级 WASM；
    - 慢速 WASM 下自动启用相邻帧 AI 结果复用，不暴露为普通用户配置。
  - `src/video/videoCleanupBackends.js` / `src/video/videoExport.js`
    - 增加 FDnCNN 相邻帧 ROI 变化检测；
    - ROI 亮度变化低于阈值时复用上一帧 AI 输出，变化大时重新推理；
    - 导出进度与完成状态显示 `AI 推理 N 帧，复用 M 帧`。
  - `build.js`
    - 开发静态服务补齐 `.mjs`、`.wasm` MIME；
    - 为项目 dev server 增加 COOP/COEP/CORP 响应头，以便后续 WebGPU/JSEP 和 WASM threads 正常工作。
- 实测结果：
  - 修复前慢速路径：`1s / 24 帧` 样片约 `90s`。
  - 相邻帧复用后，在同一个仍未启用 WebGPU 的服务环境下：
    - 耗时约 `20.6s`
    - `AI 推理 8 帧，复用 16 帧`
    - 输出：`.artifacts/browser-speed-reuse/4d420881-ai-reuse.mp4`
    - 报告：`.artifacts/browser-speed-reuse/latest-benchmark.json`
- 下一步：
  - 需要让实际调试服务重新加载当前 `build.js` 静态服务配置，确保 `.mjs` / `.wasm` MIME 和 COOP/COEP 生效；
  - WebGPU 启动后应重新测同一条 1 秒样片，目标是优先恢复逐帧 AI，同时把耗时压到可交互范围。
