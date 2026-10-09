# Issue #103 平面/矢量图残留调查记录

日期：2026-07-07

## 结论

Issue #103 的样本不是定位错误。当前检测能命中 `2048x2048` 图像中的 `96x96` 水印，位置为 `x=1760, y=1760`，右/下边距均为 `192px`，并使用 `alphaVariant=20260520`。问题出在去水印后的可见残留仍然明显，而且损伤门判定为不安全。

已落地的生产修复是 fail-closed：当 `20260520` 的 `96px / 192px` 新边距候选在处理后仍有可见残留，且损伤评估不安全时，流水线返回 `applied=false` 与 `skipReason=visible-residual-unsafe-damage`，避免输出一张带明显鬼影或新增损伤的图片。

第二阶段调查显示，暂时不应把 palette snap、局部区域平滑、MRF 类视觉修补直接放进生产路径。它们在单样本上可以降低部分梯度指标，但没有清除可见残留，并且会在硬边界、细线、局部图形上引入错误重建。

## 复现样本

本地样本：

- `.artifacts/issue-103/issue-103-input.png`
- sha256: `09f83c1dcf29f6be88f7bc28dbfb8c2412dd427f038b02e14be051a8313ed6ff`

修复前 CLI 处理结果：

- `applied=true`
- `source=standard+located-aggressive`
- `position={ x:1760, y:1760, width:96, height:96 }`
- `config={ logoSize:96, marginRight:192, marginBottom:192, alphaVariant:"20260520" }`
- `residualVisibility.visible=true`
- `visibleGradientResidual=true`
- `visibleSpatialResidual=true`
- `damage.safe=false`
- `damage.reason=texture`

修复后 CLI 处理结果：

- `applied=false`
- `skipReason=visible-residual-unsafe-damage`
- 保留检测位置、配置、分数、残留可见性与 decision path，便于 UI/CLI/后续调试展示原因。

## 调查证据

### Alpha / profile / localization 扫描

相关产物：

- `.artifacts/issue-103/alpha-profile-small-sweep.json`
- `.artifacts/issue-103/localization-small-sweep.json`
- `.artifacts/issue-103/logo-value-sweep.json`
- `.artifacts/issue-103/channel-logo-sweep.json`

结论：

- 扫描 alpha gain、局部 profile、轻微位移/缩放、logo value 与 RGB logo value 后，没有找到 `visible=false` 且安全的候选。
- 最佳候选仍保留明显残留，只是在不同策略下把残留从亮边、暗边或局部纹理之间转移。

### 合成模型检查

相关产物：

- `.artifacts/issue-103/compositing-model-fit.json`

结论：

- sRGB 正向叠加拟合明显优于 linear RGB。
- sRGB RMSE 约 `2.9393`，linear RGB RMSE 约 `48.6116`。
- 该样本不是线性合成假设导致的失败；当前水印更像是 sRGB alpha 模型下的背景重建问题。

### 视觉修补实验

相关产物：

- `.artifacts/issue-103/flat-nearest-repair-report.json`
- `.artifacts/issue-103/palette-repair-report.json`
- `.artifacts/issue-103/model-fit-palette-repair-report.json`
- `.artifacts/issue-103/model-fit-threshold-sweep.json`
- `.artifacts/issue-103/inverse-palette-snap-report.json`
- `.artifacts/issue-103/palette-mrf-repair-report.json`

结论：

- `inverse-palette-snap` 是目前单样本上指标最好的简单修补，但仍然 `visible=true`。
- 其最佳结果约为 `severity=21.40704`、`gradientResidual=0.2578`、`spatialResidual=0.26759`，仍超过可见阈值。
- MRF/区域平滑可进一步压低梯度残留，但会增加空间残留与区域化错误，不适合直接上线。

### 合成 hard/vector 基准

相关产物：

- `.artifacts/issue-103/synthetic-vector-benchmark/benchmark.json`
- `.artifacts/issue-103/synthetic-vector-benchmark/comparison-sheet.png`
- `.artifacts/issue-103/vector-repair-fixture-pack/report.json`
- `.artifacts/issue-103/vector-repair-fixture-pack/comparison-sheet.png`

该基准使用已知 ground truth 的平面/矢量图，并故意制造 alpha gain 偏差。结果显示：

- 在大块纯色背景中，palette snap 有时能接近真值。
- 在局部形状只出现在水印区域内部时，即便使用 oracle alpha gain，palette snap 也无法恢复隐藏形状。
- `nested-shapes` case 中 palette snap 的 RMSE 约 `15.46`，明显差于简单反解。

这说明单图 palette/区域重建存在不可观测信息：如果被水印遮住的颜色或形状没有在外圈出现，算法无法可靠知道真实底色。

新增的 `vector-repair-fixture-pack` 把这个风险改成了可重复的准入门槛：

- `large-blocks-recoverable`：外圈存在大块连通颜色，理论上属于可修复样例。
- `nested-shapes-protected`：水印区域内存在外圈不可观测的局部圆形、竖条与色块，必须保护。
- `mixed-safe-component-protected`：同一个 ROI 内同时存在可由外圈证明的大块连通区域，以及必须保护的内部孤立组件。
- `thin-stripes-protected`：细线/条纹不应被修补算法压平成调色板块。
- `diagonal-edge-protected`：硬边界穿越水印区域时不应引入边缘错位。

当前 naive `palette-snap-repair` 的 fixture pack 结果为：

- `productionReady=false`
- `repairable-improved=1`
- `protected-regression=1`
- `protected-not-worse=3`
- blockers: `protected-regression`

新增的 `gated-palette-repair` 研究原型使用 ROI 场景标签的连通组件判别：从普通反解图出发，只对面积足够、与边界连通、且近似矩形的组件局部采用 palette repair；复杂组件仍回退到普通反解。它在当前 fixture pack 上的结果为：

- `productionReady=true`
- `repairable-improved=1`
- `protected-not-worse=4`
- blockers: none

这说明下一阶段的 gated vector repair 有一个可继续验证的方向：在 `large-blocks-recoverable` 上相对反解有显著收益，在 `mixed-safe-component-protected` 上能局部采用安全组件，并且在 `nested-shapes-protected` 等不可观测局部结构上不能比普通反解更差。

真实 #103 样本的离线组件级复核结果：

- 复跑命令：`node scripts/create-issue103-real-component-gated-review.js`
- 产物：`.artifacts/issue-103/real-component-gated-vector-review/report.json`
- 对比图：`.artifacts/issue-103/real-component-gated-vector-review/comparison-sheet.png`
- 组件图：`.artifacts/issue-103/real-component-gated-vector-review/component-map-4x.png`
- `gatedAdopted=false`
- `componentCount=13`
- 所有组件的 `safeForRepair=false`
- rejected reasons: `too-many-components`, `internal-component`, `small-component`, `non-rectangular-component`

这意味着当前组件级 gate 没有在真实 #103 上误采纳，但也没有改善真实输出。它仍是研究原型，不能直接进入生产路径。

真实 #103 的组件 gate 阈值 sweep：

- 复跑命令：`node scripts/create-issue103-component-gate-sweep.js`
- 产物：`.artifacts/issue-103/component-gate-sweep/report.json`
- 对比图：`.artifacts/issue-103/component-gate-sweep/comparison-sheet.png`
- `strict-a256-fill084-boundary` 与 `mid-a128-fill060-boundary` 均 `changedPixels=0`
- `loose-a64-fill040-boundary` 仅 `changedPixels=33`
- `loose-a64-fill040-anywhere` 仅 `changedPixels=98`
- `very-loose-a64-fill030-anywhere` 跳到 `changedPixels=2709`

该 sweep 显示，轻微放宽几乎没有实际视觉收益；极度放宽才会大量采纳组件，但会进入星形、弧线、纹理交界等高风险区域。因此不支持为了 #103 在生产路径放宽组件 gate。

### 继续推进后的新增实验

相关产物：

- `.artifacts/issue-103/em-palette-alpha/report.json`
- `.artifacts/issue-103/em-palette-alpha/best-crop-3x.png`
- `.artifacts/issue-103/blend-balance/report.json`
- `.artifacts/issue-103/confident-palette-repair/report.json`
- `.artifacts/issue-103/allenk-reference/metrics-with-ai.json`
- `.artifacts/issue-103/allenk-reference/reference-ai-sheet.png`

新增结论：

- 分段 alpha + 调色板 EM 仍然 `visible=true`，最佳结果约为 `severity=23.3063`、`spatialResidual=0.29947`、`gradientResidual=0.17873`。它会把黄绿色弧线附近重建成块状区域。
- 在原图与反解图之间做模板相关平衡仍然 `visible=true`，最佳结果约为 `spatialResidual=0.18016`、`gradientResidual=0.30617`，暗鬼影仍可见。
- 高置信调色板局部修补只改动约 `162` 个像素，结构风险较低，但覆盖不足，仍然 `visible=true`。
- allenk/GeminiWatermarkTool 的 `plain`、`server-aggressive`、`soft`、`telea`、`ns`、`ai`/FDnCNN 参考输出全部仍为 `visible=true`。AI/FDnCNN 参考的空间残留约 `0.35552 ~ 0.36230`，比当前 fail-closed 前的反解残留更高。

这些结果把问题从“参数没调好”推进到了“单张图缺少可观测背景真值”的层面。对于 hard/vector 内容，自动修补只有在被遮挡区域的颜色类别能由外圈连通区域证明时才有生产化空间；否则会在隐藏局部形状、硬边界和细线处重建错误内容。

## 处理建议

短期：

- 保留当前 fail-closed 行为，避免生产输出明显残留或损伤。
- 在 CLI/UI 上将 `visible-residual-unsafe-damage` 解释为“检测到水印，但当前样本属于不安全残留，已保留原图”。
- 不要为了 #103 单样本放宽安全门或上线视觉修补。

中期：

- 请求 issue reporter 提供更多同类 flat/vector 样本，至少覆盖不同背景颜色、局部形状、细线、文字/图标与不同 1K/2K/4K 尺寸。
- 建立 hard/vector 类 fixture 集合，用 before/after crop sheet 与 ground truth/synthetic benchmark 一起评估。
- 将 `.artifacts/issue-103/vector-repair-fixture-pack/report.json` 的 `gatedSummary` 作为 gated vector repair 的准入报告：只有当 `gatedSummary.productionReady=true` 且人工检查 `comparison-sheet.png` 无结构回归时，才考虑进入生产路径。
- 若继续研究修补，应优先做“可证明安全的局部常量区域识别”：只在被遮挡区域与外圈连通、且颜色类别可由外圈证明时修复；遇到孤立局部形状、硬边界穿越或覆盖率不足时仍 fail-closed。
- 下一阶段不应从单张 #103 样本直接改生产路径；应先用更多 flat/vector 样本验证当前连通组件 gate 的假阳性/假阴性，再决定是否允许 gated vector repair 接入生产流水线。

## 不建议的方向

- 直接降低残留可见性阈值。
- 把 palette snap、nearest fill、MRF smoothing 作为通用后处理上线。
- 把 allenk 的 software inpaint 或 AI/FDnCNN 清理作为该类样本的默认兜底。
- 从单张 #103 样本泛化 96px / 192px 新边距水印的修复策略。
