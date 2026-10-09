# 核心水印去除算法调研与重构方案

日期：2026-06-08

## 背景

这次 `20260608` 样例暴露的问题不是单张图的偶发参数，而是算法架构正在偏离原始数学模型：

- 水印去除本质上是已知白色 logo 与 alpha map 的反向 alpha composite。
- 如果位置、尺寸、alphaMap、alphaGain 都正确，理论上不需要 inpainting、edge cleanup、background cleanup 等后处理。
- 如果位置或 alpha 错了，后处理会把错误候选伪装成“残差较低”，反而污染候选排序。

因此下一轮重构目标是：主流程回到 `位置候选 + alpha 候选 + 反解评分 + 早退`，把后处理从默认核心链路中移除或关停。

补充决策：当前阶段放弃自动搜索。默认主流程只尝试固定组合表里的位置/尺寸/alpha 组合；不命中就跳过，不用 preview/adaptive/local/size sweep 去兜底。

## 外部调研结论

### 1. 同类 Gemini 项目的主线都是 reverse alpha

`remove-ai-watermarks` 明确描述 Gemini / Nano Banana sparkle 使用：

```text
watermarked = alpha * logo + (1 - alpha) * original
original = (watermarked - alpha * logo) / (1 - alpha)
```

它的核心点有三个：从纯黑背景提取 alpha map、用 NCC 检测位置和尺度、对 Gemini sparkle 适配不同 opacity。它也有 residual inpaint，但文档把它定位为边缘残留清理，而不是主算法。参考：[remove-ai-watermarks README](https://github.com/wiltodelta/remove-ai-watermarks)。

`GeminiWatermarkTool` 也采用同样的确定性反解，并将 Gemini 3.5 的变化抽象为 profile 变化：alpha map 与位置公式改变，数学不变。它的检测部分是三阶段 NCC：spatial NCC、gradient NCC、statistical variance，并有 confidence threshold 来跳过非水印图。它也提供 inpaint / denoise，但文档说明这是 resized / recompressed 场景下的残留补救。参考：[GeminiWatermarkTool README](https://github.com/allenk/GeminiWatermarkTool)。

Rust crate `gemini-watermark-removal` 的公开说明同样很简洁：通过 calibrated `48x48` 和 `96x96` alpha masks 做 visible Gemini watermark 的 reverse alpha blending，并明确不能去除 SynthID。参考：[docs.rs gemini-watermark-removal](https://docs.rs/crate/gemini-watermark-removal/0.1.1)。

结论：同类 Gemini 项目的共识是，Gemini 可见水印应优先建模为确定性 alpha composite 问题。后处理可以存在，但不应成为默认成功路径。

### 2. 学术方向也支持“先定位与 matte，再恢复”

Google Research / CVPR 2017 的 `On the Effectiveness of Visible Watermarks` 把一致水印去除建模为 multi-image matting：估计 watermark foreground、alpha matte 和原图背景。它强调一致性水印可被高精度估计和恢复，并明确区分“反转水印过程”与“inpaint 合成猜测”。论文还指出，非常小的 watermark / alpha 误差都会在恢复中变成可见 artifact。参考：[项目页](https://watermark-cvpr17.github.io/) 与 [CVPR PDF](https://openaccess.thecvf.com/content_cvpr_2017/papers/Dekel_On_the_Effectiveness_CVPR_2017_paper.pdf)。

深度学习类可见水印去除，例如 `Split then Refine`、`WDNet`、`FE-WRNet`，通常用于未知水印、复杂水印、多域泛化。它们共同强调 localization / mask / decomposition，而不是直接全图 repaint。参考：

- [Split then Refine / deep-blind-watermark-removal](https://github.com/vinthony/deep-blind-watermark-removal)
- [Visible Watermark Removal via Self-calibrated Localization and Background Refinement](https://arxiv.org/abs/2108.03581)
- [WDNet: Watermark-Decomposition Network](https://arxiv.org/abs/2012.07616)
- [FE-WRNet](https://www.mdpi.com/2076-3417/15/22/12216)

结论：对于未知水印，神经网络/后处理有价值；对于 Gemini 这种已知形状、已知颜色、候选位置有限的水印，核心应是准确定位和 alpha 反解。

### 3. 原始导出与二次压缩要分层处理

AuraTuner 的技术说明把边界讲得比较清楚：deterministic restoration 最适合原始导出、固定透明 overlay；截图、缩放、转发、重压缩会破坏像素级反解。参考：[Inverse Alpha Watermark Cleanup](https://auratuner.com/blog/inverse-alpha-watermark-restoration)。

这对本项目的含义是：

- Gemini 原始下载图：默认应走核心反解，目标接近完美。
- 不支持截图、缩放、转发、重压缩等降级输入作为默认目标。
- 如果输入不是原始 Gemini 导出，算法可以返回 `no-watermark-detected` 或 `unsupported-degraded-input`，而不是为了“看起来去掉”进入后处理。
- 如果将来需要处理降级输入，应作为独立 profile 或单独产品能力，而不是混入默认核心。

## 我们当前算法核心回顾

### 1. 已经正确的核心

`src/core/blendModes.js` 是正确的数学核心：

```js
original = (watermarked - alpha * LOGO_VALUE) / (1 - alpha)
```

它支持 `alphaGain`，并对低 alpha 噪声、接近 1 的 alpha 做安全限制。这部分应保留为唯一像素恢复核心。

`src/core/geminiSizeCatalog.js` 已经把 Gemini 尺寸和水印配置做成 catalog，这是正确方向。它比简单 `width > 1024` 规则更符合 Gemini 离散尺寸输出。

`src/core/candidateSelector.js` 里已经有有用的指标：

- `originalSpatialScore`
- `originalGradientScore`
- `processedSpatialScore`
- `processedGradientScore`
- `nearBlackIncrease`
- `texturePenalty`

这些指标应该继续保留，但要重新分层：原始证据用于选 anchor，处理后残差用于选 alpha / 验证，损伤指标用于拒绝候选。

### 2. 当前架构问题

当前候选选择把 detection 和 restoration 混在一起：

- `pickBetterCandidate()` 同时处理 catalog、preview-anchor、local shift、validationCost、improvement。
- `validationCost` 里包含处理后残差、near black、texturePenalty，这些适合判断某个 alpha 是否好，但不适合让弱位置候选抢掉强 anchor。
- `source.includes(...)` 字符串判断太多，业务语义藏在 source 拼接里，不如 `provenance` 稳定。
- 为修样例不断增加局部 veto，例如保护 `48px + 96px margin` catalog，这说明排序模型不统一。

`src/core/watermarkProcessor.js` 里后处理链路过重：

- alpha recalibration
- over-subtraction recalibration
- catalog dark fine tune
- weak alpha fine tune
- preview background cleanup
- preview edge cleanup
- subpixel outline refine
- small preview refinement

其中 alpha recalibration / fine tune 属于核心参数搜索，可以保留并统一；background cleanup、edge cleanup、outline refine、small preview refinement 更像视觉补丁，应从默认主流程移走。

### 3. 历史算法债务

从 `f9f6ae9` 的历史版本看，之前还存在大量 `alphaGain > 1` 候选和 multipass 链路：

- `1.05` 到 `2.60` 的强 alpha 候选会把“重复处理/过扣”引入搜索空间。
- `removeRepeatedWatermarkLayers` 代表把同一区域反复剥离，但如果原图只有一次 alpha composite，多次反解没有数学依据。

这部分近期已经被压缩，但文档上要明确：默认核心不再接受大范围强 alpha sweep 和 multipass。`alphaGain > 1` 可以作为受控的标准候选升级路径，但必须由原始水印证据和损伤指标门控，不能恢复历史上 `1.05` 到 `2.60` 的宽扫。

## 新核心架构

### 总流程

```text
buildPositionCandidates(image)
  -> 按先验频率排序
  -> 对每个 position candidate:
       scoreOriginalEvidence(candidate)
       如果原始证据明显不足，跳过或降级
       for alphaGain in prioritizedAlphaGains(candidate):
           inverseAlphaRemove()
           scoreResidualAndDamage()
           如果 earlyAccept(candidate, alphaGain):
               return result
       对当前位置做局部 alpha fine tune
  -> 如果没有早退，按分层 rankingKey 选最优
```

核心原则：

- 不同位置候选之间，先比较 `originalEvidenceTier`，再比较 processed residual。
- 同一位置候选内部，才让 alphaGain 和 residual 决定胜负。
- 后处理不参与默认评分，不修改像素，不改变候选排名。
- 固定组合优先于自动识别：Gemini 不太可能无限增加水印布局，优先维护一个小而高频的有限候选集。
- 有限尝试保护性能：候选枚举必须有硬上限，不能为了追求极端自动识别而扫大范围位置、尺寸、alpha。

### 位置候选排序

位置候选应该显式分组并带 `sourcePriority`：

| 优先级 | 候选族 | 说明 |
|---:|---|---|
| 0 | exact official catalog current | 精确 Gemini 尺寸当前配置 |
| 1 | known current variants | 已确认高频变体，如 `48px + 96px margin` |
| 2 | exact official legacy | 旧 `96px + 64px margin`，证据门控 |
| 3 | confirmed exception catalog | 如 `2816x1536 -> 96px + 192px margin` |
| 4 | near-official projected catalog | 近似官方尺寸的缩放投影 |
| 5 | fixed preview-sized variants | 已确认 preview 小尺寸组合，但必须来自固定表 |
| 6 | local shift around strong seed | 当前默认关闭，只作为历史/实验路径 |
| 7 | size jitter around strong seed | 当前默认关闭，只作为历史/实验路径 |
| 8 | preview-anchor fallback | 当前默认关闭，不参与生产主链路 |
| 9 | adaptive fallback | 当前默认关闭，不参与生产主链路 |

注意：`preview-anchor` 不能再因为 processed residual 轻微优势压过强 catalog。

候选数量应受控。推荐默认只尝试：

- catalog exact/current 组合
- catalog confirmed variants
- legacy / exception 组合
- 围绕强证据候选的小范围 local shift
- 最后才是有限 preview-anchor fallback

不做全图滑窗，不做大范围尺寸搜索，不做无限 alpha sweep。当前生产目标是固定组合链路，而不是自动发现未知位置。

### Alpha 候选排序

全局候选保持小而有序：

```js
[0.6, 1, 1.15, 1.3, 0.7, 0.85, 0.55]
```

原因：

- `0.6` 是 202606 新链路高频弱 alpha。
- `1` 是标准 alpha。
- `1.15 / 1.3` 是强 alpha 标准候选的受控升级路径，只在候选验证和残留升级阶段发挥作用，不进入初始优先 alpha。
- `0.7 / 0.85 / 0.55` 是弱 alpha 附近的离散备选。
- `0.9` 不应放全局；它应从 `1` 过扣后的局部 fine tune 自然出现。

局部 fine tune 规则：

```text
bestAlpha around +/- 0.02 / +/- 0.04
只在同一 anchor 内执行
只改变 alphaGain，不改变位置
```

位置和 alpha 是组合搜索，数量增长很快。因此 alpha 搜索也必须有限：

- 高频 alpha 放前面，命中早退就结束。
- 只有强位置证据的候选才允许局部 fine tune。
- 弱 fallback 候选不做细扫，避免错误 anchor 靠 alpha 微调混入最优结果。

### 评分分层

不要再用单个 `validationCost` 决定所有事情。建议拆成四个结构化评分。

#### 1. originalEvidence

用于判断该位置是否真的有水印。

输入：

- `originalSpatialScore`
- `originalGradientScore`
- alpha-band luminance signature
- alphaMap 梯度结构匹配

输出：

```js
{
  tier: 'strong' | 'medium' | 'weak' | 'none',
  spatial,
  gradient,
  score
}
```

建议门槛：

- `strong`: spatial >= 0.3 且 gradient >= 0.12，或 gradient 极强。
- `medium`: spatial / gradient 任一有明显正信号，但不足 direct match。
- `weak`: 只有轻微信号。
- `none`: 跳过或只作为 fallback。

#### 2. residual

用于判断 alpha 反解后水印是否消失。

输入：

- `abs(processedSpatialScore)`
- `max(0, processedGradientScore)`
- `suppressionGain`
- alpha-band halo visibility
- before/after delta map 与水印模板的关系

输出：

```js
{
  cleared: boolean,
  spatialResidual,
  gradientResidual,
  suppressionGain,
  score
}
```

#### before/after 差异图的使用方式

可以引入 `delta = before - after`，但它不能单独作为“水印已去除”的证明。

原因是：只要我们按某个候选执行反解，差异图天然会带有该候选 alphaMap 的形状；错误 anchor 也可能产生“看起来符合候选模板”的 delta。因此 delta 更适合作为辅助指标：

1. **修改范围约束**：主要差异应集中在 alphaMap 有效区域，alpha 很低的外圈不应出现大量改动。
2. **方向约束**：白色水印去除通常让像素变暗，`before - after` 应多数为非负；大量反向变化说明候选或 alpha 异常。
3. **幅度一致性**：对给定 alphaGain，理论改变量近似为：

```text
expectedDelta = alpha * (255 - before) / (1 - alpha)
```

实际 `before - after` 应与 expectedDelta 在 alpha 有效区域保持一致。
4. **残差联合判断**：最终仍必须看 after 图上的残余水印相关性，尤其是 `processedSpatialScore` 和 `processedGradientScore`。

更合理的判断不是“差异越小越好”，而是：

```text
原图有水印证据
反解产生了符合 alpha composite 的差异
反解后图像不再有水印形状相关性
反解没有明显伤图
```

2026-06-08 实验结论：

- `recompose(after + watermark) ~= before` 不能作为主评分。因为 `after` 是用同一组 alpha 反解出来的，同 alpha 重合成在数学上天然接近 `before`，无法区分 `alpha 0.65 / 0.7 / 0.74` 这类视觉差异。
- `diffTemplateCorrelation` 和 `diffGradientCorrelation` 也不能单独排序。实际样例中它们在多个 alpha 候选间几乎恒定，只能说明“差异形状来自该 alpha”，不能证明 after 已干净。
- 更有用的是 diff 派生的 artifact 指标：after 图上的 `spatial / gradient residual`、alpha band 的暗/亮 halo、以及 newly clipped pixel ratio。
- 当前代码已在 `src/core/restorationMetrics.js` 落地 `assessRemovalDiffArtifacts()`，用于把这些指标归一到 alpha 候选视觉成本；它是候选评分的一部分，不是唯一判据。

#### 3. damage

用于拒绝过扣或伤图。

输入：

- `nearBlackIncrease`
- `texturePenalty`
- `tooDark`
- `tooFlat`
- `negative residual / sign flip`

输出：

```js
{
  safe: boolean,
  penalty,
  reason
}
```

#### 4. rankingKey

候选排序用分层 key，而不是加权混合：

```js
[
  sourcePriority,
  -originalEvidenceTier,
  damageSafe ? 0 : 1,
  residualScore,
  alphaPriorityIndex,
  damagePenalty
]
```

这里的关键是：`sourcePriority` 和 `originalEvidenceTier` 在前，避免错误位置被微小 residual 优势带飞。

### 早退条件

早退必须同时满足：

```text
sourcePriority 足够高
originalEvidenceTier >= strong
residual.cleared === true
damage.safe === true
```

建议初始阈值：

```text
abs(processedSpatialScore) <= 0.04
max(0, processedGradientScore) <= 0.12
suppressionGain >= 0.25
nearBlackIncrease <= 0.03
texturePenalty 不触发 hardReject
```

自动 fallback 候选当前默认不进入主流程。即使将来重新开启，也不能直接早退，除非固定 catalog / standard 全部无有效证据。

早退同样是性能保护机制。固定高频组合如果通过阈值，应立即返回；不要为了寻找理论上更低的 residual 继续搜索低频候选。

## 与现有代码的映射

建议新增或重构为以下模块：

```text
src/core/watermarkCandidatePipeline.js
  buildPositionCandidates()
  buildAlphaCandidates()
  evaluateCoreCandidate()
  rankCoreCandidates()
  selectBestCoreCandidate()

src/core/watermarkScoring.js
  scoreOriginalEvidence()
  scoreResidual()
  scoreDamage()
  shouldEarlyAccept()

src/core/watermarkProcessor.js
  只负责协调 pipeline、生成 meta、保留 public API
```

现有模块保留：

- `blendModes.js`: 核心反解。
- `geminiSizeCatalog.js`: 候选先验。
- `adaptiveDetector.js`: spatial / gradient correlation 和 alphaMap resize/warp 工具。
- `restorationMetrics.js`: damage / texture / halo 指标，但不要让它直接驱动 anchor 抢占。

后处理函数处理方式：

- 先保留代码但默认不调用。
- 增加显式 debug / experimental flag 才能打开。
- 新核心稳定后删除 dead code。

## 测试策略

### 样例回归

必须覆盖：

- `20260607.png`
- `20260607-2.png`
- `20260608-2.png`
- `20260608-3.png`
- `20260608-4.png`
- `20260608-5.png`
- `2816x1536` known exception
- 官方尺寸 0.5K / 1K / 2K / 4K 合成 fixture

每个样例断言：

- selected anchor family
- `position`
- `alphaGain`
- `sourcePriority`
- `originalEvidenceTier`
- `earlyExit` 是否发生
- residual / damage 指标

### 反例测试

必须覆盖：

- 干净图不应处理。
- 白色高亮图案不应被误判为 watermark。
- 弱 preview-anchor 不应压过强 catalog。
- 错误位置 residual 偶然较低也不能胜出。
- `alphaGain > 1` 不能做大范围 sweep，也不能绕过原始证据和损伤门控。
- multipass 默认不进入主流程。

### 可视化输出

继续保留 `.artifacts` contact sheet，但它只能作为人工验证，不作为算法排名依据。

## 实施顺序

1. 抽出 `watermarkScoring.js`，把 original / residual / damage 分开。
2. 默认关闭自动搜索：preview-anchor sweep、adaptive、local shift、size jitter、template warp 都不参与主链路。
3. 抽出候选对象和 `rankingKey`，替换 `pickBetterCandidate()` 的局部 veto 链。
4. 把 alpha search 固定在每个 anchor 内部执行。
5. 增加 before/after delta 辅助评分，但只作为 residual / damage 的组成部分，不作为唯一判据。
6. 关停默认后处理：background cleanup、edge cleanup、subpixel outline、small preview refine。
7. 设置候选数量上限和早退阈值，保护页面实时处理性能。
8. 用现有样例重跑，校准 early accept 阈值。
9. 再决定删除哪些后处理死代码。

## 当前结论

新方向不是“少做一点”，而是更严格：

- 只相信数学反解。
- 只让 alpha 搜索修 alpha。
- 只让候选排序选位置。
- 只让后处理作为显式降级工具，不参与默认核心。
- 只支持原始 Gemini 导出图，不为降级输入牺牲主流程简洁性。
- 只做有限候选尝试，用高频固定组合和早退保护性能。

这能让未来 Gemini 改位置、改 alpha、改尺寸时，我们增加候选和先验，而不是继续叠视觉补丁。

## 2026-06-08 重构复盘

这次重构确认了一个核心事实：失败样例不应该用后处理逐张修，而应该回到水印模型本身。Gemini 可见水印仍然更像一个固定 logo、固定 alpha map、有限位置和有限 alpha gain 的反向 alpha composite 问题。

### 已确认的发现

1. Gemini 链路确实存在变化。

   `20260607` 和 `20260608` 样例说明，水印位置、边距和有效 alpha gain 都可能随 Gemini 链路变化。问题不是单纯位置偏移，也不是单纯 alpha 强度变化，而是不同输出尺寸和生成链路会落到不同固定组合。

2. `maxPasses` 与 alpha gain 候选重复。

   多次去水印本质上是在模拟更强 alpha，但它比显式枚举 alpha gain 更难解释、更难评分，也更容易制造暗边和纹理损伤。即使真实存在重复水印，多 pass 也不能保证完美反解，因此不应作为默认主链路。

3. 后处理不应作为成功路径。

   background cleanup、edge cleanup、subpixel outline、残影修补等逻辑容易把错误候选伪装成较低残留，污染评分。对于原始 Gemini 导出图，只要位置和 alpha 正确，核心反解应接近完美；如果不完美，优先怀疑候选和评分，而不是追加修图补丁。

4. 固定组合优先是合理假设。

   Gemini 不太可能引入无限位置和无限 alpha。更可维护的策略是维护一个高频固定组合表，把最常见的 `position + alpha` 放前面，低频组合必须有证据门控。自动搜索、二分查找和大范围 sweep 暂时放弃。

5. 评分算法比候选数量更关键。

   候选可以保持有限，但评分必须能区分“水印残留”和“过度扣除”。之前的问题往往不是没有候选，而是局部残留、暗 halo、背景纹理和裁剪像素没有被统一建模，导致个别样例选错 alpha 或 anchor。

6. before/after diff 有价值，但不能朴素使用。

   实验确认，`after + watermark ~= before` 的重合成误差在多个 alpha 候选上都可能很小，区分度不足。`before - after` 与模板的相关性也会随 alpha 近似等比例变化，不能单独决定胜负。更有用的是从 diff 中派生视觉伪影指标，例如暗 halo、新增裁剪像素、残留梯度和局部纹理异常。

### 当前代码落地

当前代码已把 diff 思路落为 `assessRemovalDiffArtifacts()`，但它不是唯一判据，而是为候选评分提供一组辅助指标：

- `recomposeError`: 诊断用，说明候选是否符合 alpha composite 形状。
- `diffTemplateCorrelation`: 诊断用，说明被移除区域是否像水印模板。
- `diffGradientCorrelation`: 诊断用，辅助观察差异边界。
- `negativeDiffRatio`: 观察是否出现反向差异。
- `newlyClippedRatio`: 衡量反解是否制造新的黑/白裁剪。
- `halo`: 衡量 alpha band 周边是否出现暗边或亮边。
- `visualArtifactCost`: 综合伪影成本，参与 alpha 微调排序。

这条线的结论是：diff 可以帮助发现“去掉了什么”和“是否过度去除”，但不能替代 residual score 和候选先验。

### 当前样例状态

本轮固定核心样例输出在：

```text
.artifacts/fixed-core-sample-check/processed
.artifacts/fixed-core-sample-check/contact-sheet.png
.artifacts/fixed-core-sample-check/summary.json
```

关键样例当前结果：

- `20260608-3.png`: `48px / r96 b96 / alpha 0.7`
- `20260608-4.png`: `48px / r96 b96 / alpha 0.95`
- `20260608-5.png`: `48px / r96 b96 / alpha 0.64`
- `20260520-3.png`: 使用 legacy 96 alpha map，避免被新版 alpha 误判。
- `5-4.png`: 已恢复为支持样例，依赖固定核心强证据和 near-black 窄例外。

已通过验证：

```text
pnpm test
pnpm build
git diff --check
```

其中 `git diff --check` 只有 Windows 换行提示，没有空白错误。

## 2026-06-09 样本复盘：残留瑕疵与根因方向

样本来源：`${GWR_DOWNLOAD_SAMPLE_ROOT}`，本轮离线分析输出位于 `.artifacts/download-samples-20260609/`。

### 观察到的问题

- 样本总数 `62`，当前处理结果为 `applied = 62`、`skipped = 0`，说明主要问题不是漏检，而是少量处理后仍有可见细边、弧线或弱 halo。
- 残留集中在新的 `48px` 锚点族，包含 `48/96/96`、`48/32/32` 以及少量固定局部偏移候选。
- `ss3aov...` 这类平滑背景样本最能暴露问题：大块黑边可以被压低，但仍残留非常窄的星形边缘细线。
- `21odi...`、`ok1gtc...`、`scp8zr...` 这类复杂纹理样本中，残留轮廓会和背景裂纹、高光、图案边缘混在一起，指标上仍高，但肉眼风险主要是局部轮廓没有完全消失。
- 暗底和近黑背景存在大量 `possibleResiduals` 指标假阳性，不能把 `possibleResiduals = 0` 作为现实目标。

### 对“完美反解为何仍有瑕疵”的结论

反向 alpha blending 的数学反解本身没有问题，但完美反解成立需要真实前向模型完全已知：

```text
watermarked = alpha * logo + (1 - alpha) * original
```

本轮证据说明真实 Gemini 渲染不完全等同于当前假设的 `position + alphaMap + alphaGain`：

- 更可能的主因是位置、alpha 边缘形状、抗锯齿采样、亚像素和边缘亮度行为的组合偏差。
- 没有证据支持“PNG 轻微压缩/重编码”是主因。残留呈稳定星形边缘结构，不像随机压缩噪声。
- 简单 `linear/gamma` 反解不能统一改善，多数样本会产生更强暗边或过扣。
- 简单 alpha 膨胀、blur、dilate+blur 也不能统一改善。有些样本指标下降，但肉眼边缘更硬。
- subpixel 搜索容易把残留变成更硬的弧线，当前不应作为默认生产路径。

### 本轮已验证的生产修正

当前可接受的方向是保守收尾，而不是强行重建背景：

- 对已知 `48px` 锚点族增加 residual edge cleanup。
- 对强正残留扩展 fine-alpha 搜索到 `0.95 / 1.0`。
- 对低纹理平滑背景启用受限 `flat-fill`，最多两次，只在残留梯度改善且空间漂移安全时触发。
- 对复杂纹理使用 `luma-edge` 小幅亮度边缘校正，只调整亮度 delta，不重绘颜色。

当前验证结果：

```text
rtk pnpm exec node --test tests/core/watermarkProcessor.test.js
29 pass / 1 skip

rtk pnpm benchmark:samples
25 pass / 0 fail

rtk pnpm test
616 pass / 5 skip / 0 fail

rtk git diff --check
通过；仅有 Windows 换行提示
```

这些修正可以降低部分残留，但不能宣称根因已解决。尤其是 `ss3aov...`，`flat-fill` 已明显淡化黑边，但仍有细线，继续增强填充会产生补丁风险。

### 已验证但暂不推进的方向

本轮新增探针：

- `.artifacts/probe-render-model-variants.mjs`
- `.artifacts/probe-known48-subpixel.mjs`
- `.artifacts/probe-preview-only-render-model.mjs`

关键产物：

- `.artifacts/download-samples-20260609/render-model-probe/render-model-variants.png`
- `.artifacts/download-samples-20260609/known48-subpixel-probe/known48-subpixel.png`
- `.artifacts/download-samples-20260609/preview-only-render-model-probe/preview-only-render-model.png`
- `.artifacts/download-samples-20260609/preview-only-render-model-probe/summary.json`

结论：

- `preview-only` / 邻域 prior 渲染模型在部分复杂纹理样本上能降低残留，例如 `ok1gtc...`、`scp8zr...`、`t83mbq...`。
- 但它在 `ss3aov...` 平滑背景上明显变坏，细弧线更重；`u8tu...` 也比当前生产输出差。
- 快验结果中多数最优参数选择 `alphaBlurRadius = 0`、`compositeBlurRadius = 0`，没有证明存在一个统一额外 blur/gamma 模型。
- 该方向目前适合作为离线诊断工具，不适合直接进入生产主流程。

### 下一步改进方向

后续应围绕真实水印模型学习，而不是继续叠加视觉后处理：

1. 按残留类型聚类样本：
   - 平滑背景细弧线。
   - 复杂纹理白边/黑边。
   - 暗底指标假阳性。
   - 局部偏移 `45px ~ 52px` fixed-local 候选。

2. 学习真实 alpha 边缘模板：
   - 比较标准 `bg_48.png` alpha 与残留边缘的局部方向差异。
   - 单独估计 alpha 外圈低值区域是否存在抗锯齿漏差。
   - 用样本簇学习有限的 alpha profile，而不是用无限位置/blur 搜索。

3. 把生产修正保持为 evidence-gated：
   - `flat-fill` 仅允许低纹理背景。
   - `luma-edge` 仅允许小幅亮度修正。
   - 不把 preview-only prior、强 inpaint、强 subpixel 搜索作为默认路径。

4. 增强观测工具：
   - 为 `62` 张真实样本保留完整报告和人工目测标记。
   - 记录每个样本的 anchor、alpha gain、调整阶段、before/after residual。
   - 增加按残留类型分组的 contact sheet，避免只看全量拼图。

### 当前决策

- 当前生产改动可以保留，属于低风险收残留。
- 暂不扩大 `flat-fill`、`luma-edge` 的触发面。
- 暂不把 preview-only 渲染模型、邻域 prior 或强 inpaint 放入生产路径。
- 下一轮若继续提升质量，应优先做“真实 alpha 边缘模板学习 + 样本聚类”，而不是继续调阈值。

## 2026-06-09 追加：`${GWR_SAMPLE_ROOT}` 的 96px 新 margin 修复

样本来源：`${GWR_SAMPLE_ROOT}`，本轮复测输出位于 `.artifacts/sample-files-gemini-watermark-20260609/`。

### 现象

- 批量样本 `102` 张。
- 修复前统计为 `applied = 62`、`skipped = 40`。
- 修复后统计为 `applied = 64`、`skipped = 38`。
- 新增命中的两张是：
  - `2026-06-09/2064208514779189248-source.png`
  - `2026-06-09/2064208722623729664-source.png`

### 根因

这两张不是找不到水印位置。真实候选是 `96/192/192`，且应使用 `bg_96_20260520` alpha variant。

生产路径漏掉它的原因有两层：

1. 诊断报告会枚举 catalog candidates，但生产选择器在某些路径下只把 `standardTrial` / `adaptiveTrial` 交给最终 validated fallback，其他已通过验证的 `standardTrials` 可能没有机会进入最终选择。
2. 对平滑蓝底样本，`alphaGain = 1` 的反解残留最低，但会触发 texture hard reject；较弱 alpha 虽然不触发 hard reject，却留下明显水印残留，随后又被 fixed-core strict gate 拒绝。

### 本轮修复

- `src/core/candidateSelector.js`
  - 当 canonical standard candidate 未 accepted 且仍需升级搜索时，允许展开 catalog rescue。
  - 最终 validated fallback 改为考虑全部 `standardTrials`，对齐诊断报告和生产路径。
  - 对 `96/192/192/20260520` 增加极窄 hard-reject override：
    - 原始 spatial / gradient 证据强。
    - `alphaGain = 1`。
    - 反解后 spatial / gradient 残留低。
    - gradient drop 足够大。
    - near-black increase 很小。
    - texture penalty 很小。
  - override 只影响该候选在 ranking 中的 damage safe 判断，不把全局 hard reject 放宽。
- `src/core/watermarkProcessor.js`
  - 对 `96/192/192/20260520` 且 `alphaGain = 1` 的平滑背景，增加一次受限 flat-fill。
  - 触发条件包含背景 std、gradient improvement、spatial drift、最大 residual 约束。
  - 当前 102 张批量样本中仅触发 `2` 张，即上述蓝底同簇样本。

### 目测和指标

聚焦目测图：

- `.artifacts/sample-files-gemini-watermark-20260609/focused/new-margin-fix-triptych.png`

两张蓝底样本最终为：

- `source = standard+flat-fill`
- `alphaGain = 1`
- `processedSpatial ~= -0.002`
- `processedGradient ~= 0.098`

肉眼上完整星标已消失，只剩很淡的点状边缘；这说明方向正确，但真实 alpha 边缘 / 抗锯齿模型仍不完全等于当前模板。

### 仍未解决

剩余高置信 skipped 仍集中在：

- `2048x2048`
- `1792x2400`
- `2064208700704296960-source.png` 这类 `2816x1536`
- `2064099442818027520-source.png` 这类旧 `2752x1536`

这些样本不应通过全局放宽 hard reject、强 inpaint 或广泛 alpha gain sweep 解决。下一步应单独比较它们的真实 96px alpha 边缘、暗边模型和局部背景类型。

## 2026-06-09 追加：剩余高置信 skipped 的候选网格探针

探针输出：

- `.artifacts/sample-files-gemini-watermark-20260609/remaining-high-confidence-skipped/analysis.md`
- `.artifacts/sample-files-gemini-watermark-20260609/remaining-high-confidence-skipped/latest.json`
- `.artifacts/sample-files-gemini-watermark-20260609/remaining-high-confidence-skipped/candidate-grid.png`

探针对象是修复后仍 skipped、且原始 watermark evidence 很高的 `15` 张：

- `2048x2048`: `8`
- `1792x2400`: `5`
- `2752x1536`: `1`
- `2816x1536`: `1`

探针强制比较了：

- `96/64/64`
- `96/192/192`
- `96/192/192 + bg_96_20260520`
- `48/32/32`
- `48/96/96`
- catalog entries
- 多个 alpha gain：`0.45 ~ 1.3`

### 结论

分类结果：

- `alpha-or-position-model-mismatch`: `10`
- `borderline-template-or-safety-tradeoff`: `3`
- `safety-gate-hard-reject`: `2`

重要观察：

- 多数 `2048x2048` / `1792x2400` 的“最佳 soft candidate”其实是 `48/96/96` 或 `56px` 弱候选，只能压一部分中心结构，`processedGradient` 仍约 `0.39 ~ 0.49`，肉眼仍能看到完整星标。不要把这当作可生产修复。
- 后续 size sweep 证明这些样本的原始证据峰值是 `96px`，不是 `48px`。
- `2064099442818027520-source.png` 的最佳候选是 `96/192/192 + bg_96_20260520 + alphaGain ~= 0.98`，指标低，但 `texturePenalty ~= 0.729`，暗化风险远高于本轮蓝底样本，不适合直接套用 hard-reject override。
- `2064116378469666816-source.png` 的最佳候选是 `96/64/64 + alphaGain ~= 0.98`，指标几乎清零，但 `texturePenalty ~= 0.535`，属于明显安全门保护场景。
- `2064208700704296960-source.png` 的候选存在较大 near-black increase / negative residual，视觉和指标都提示过扣风险，不应靠放宽 gates 处理。

### Size sweep 修正

追加探针：

- `.artifacts/sample-files-gemini-watermark-20260609/size-sweep-high-confidence/analysis.md`
- `.artifacts/sample-files-gemini-watermark-20260609/size-sweep-high-confidence/latest.json`
- `.artifacts/sample-files-gemini-watermark-20260609/size-sweep-high-confidence/size-sweep-grid.png`

探针按固定中心扫 `48 ~ 128px`，同时记录“原始证据峰值”和“最佳反解候选”。结论：

- `2048x2048`：原始证据峰值稳定在 `96/64/64`。
- `1792x2400`：原始证据峰值稳定在 `96/64/64`。
- 旧 `2752x1536`：原始证据峰值是 `96/192/192`。
- 剩余 `2816x1536`：原始证据峰值是 `96/192/192`。

因此这些样本的第一性问题是：水印尺寸应按原始证据锁定为 `96px`；当前 restoration ranking 会被 `48/56px` 小尺寸候选误导，因为小尺寸只改中心，看起来 damage 更低，但肉眼明显保留外圈星标。

后续报告和算法都应把两类信号分开：

- `size / anchor evidence`：先决定真实水印几何，不能被小尺寸低 damage 候选覆盖。
- `restoration safety`：在正确几何上解决 alpha profile / gain / hardReject。

### 下一步

下一步优先级应是生成/收集新的 `96px` alpha 捕获样本，而不是继续调生产阈值：

1. 针对 `2048x2048` 和 `1792x2400` 分别生成纯色背景样本：
   - 纯黑 `#000000`
   - 中灰 `#808080`
   - 亮灰 `#d0d0d0`
   - 蓝底 / 暗绿底这类接近失败样本的平滑背景
2. 每个尺寸至少 `2 ~ 3` 张，避免单图偶然性。
3. 用这些样本提取或拟合新的 `96px` alpha edge profile。
4. 新 profile 只能作为 catalog alpha variant 进入候选验证，不能全局替换 `bg_96`。

## 2026-06-09 追加：学习 `allenk/GeminiWatermarkTool` 的非 AI 部分

本轮研究对象：

- 仓库：[allenk/GeminiWatermarkTool](https://github.com/allenk/GeminiWatermarkTool)
- 本地研究快照：`.artifacts/external/GeminiWatermarkTool`
- commit：`632348868da0653d5c1e99680d2c448f4d8505eb`

当前决策：

- 暂不在前端引入 AI / FDnCNN / NCNN。
- 优先吸收它的确定性经验：profile 分层、标准位置检测、窄范围 snap、多尺度模板偏置、alpha 梯度残留 mask。
- AI denoise 只作为未来 CLI / 离线高级能力候选，不进入实时 Gemini 页面默认路径。

### 可直接学习的点

1. `profile` 抽象

`GeminiWatermarkTool` 把旧水印和新水印拆成 `V1` / `V2` profile，数学公式不变，只替换位置公式和 alpha map。这一点适合本项目继续扩展 catalog：新的 Gemini 水印变化应先进入 evidence-gated profile / alpha variant，而不是全局改阈值。

2. 标准位置 cheap detection

它在标准候选位置上先做三阶段评分：

- spatial NCC
- gradient NCC
- variance dampening

并用 spatial 低分熔断明显非水印图。这和我们现有 `adaptiveDetector` 的评分结构一致，但它的执行顺序更强调“先用标准位置快速证明或拒绝，再进入更贵的搜索”。

3. 窄范围 snap

它对可信标准几何只做小范围位移吸收，而不是直接扩大搜索空间。这个思想适合我们后续整理 `fixed-local` / `preview-anchor`：catalog 命中强时，优先做低成本局部校正；只有证据不足时才进入 adaptive。

4. 多尺度 size bias

它指出 NCC 会偏爱小模板，因此对小尺寸模板做 size-adjusted score。它使用 `cbrt(size / 96)`，比 `sqrt(size / 96)` 更温和，能避免 preview-tier 真实小水印被过度压低。本项目已将 adaptive coarse ranking 的 size penalty 调整为 cube-root，并用 `computeSizeAdjustedConfidence` 单测固定行为。

### 瑕疵处理可吸收的点

`GeminiWatermarkTool` 的后处理不是全图修图，而是：

1. 从 alpha map 计算 Sobel gradient。
2. 对 gradient 做归一化、sqrt、dilate、Gaussian blur。
3. 用该 mask 只修 alpha 边缘残留。

这和我们当前 `edge-cleanup`、`flat-fill`、`luma-edge` 的方向一致。下一步可以把这些路径收敛到统一的 alpha-gradient mask builder，减少每条路径各自维护边缘判定的分歧。

本轮已完成第一步收敛：

- 新增 `src/core/alphaGradientMask.js`，统一实现 alpha Sobel gradient、gamma 扩弱边、椭圆膨胀和 Gaussian feather。
- `edge-cleanup`、`flat-fill`、`luma-edge` 的实际混合强度接入同一个 alpha-gradient 权重。
- 保留原有 alpha band、背景平滑度、残留改善和 safety scoring；新 mask 只收敛作用范围，不扩大触发面。
- 对已验证的 `96/192/192/20260520` 平滑背景 flat-fill 保留较高 floor，避免把已证实有效的补救压得过弱。

### 暂不照搬的点

- 不直接采用它的 `V2 small = 36x36` 和 `large margin = 192` 作为全局规则；这些必须由我们的样本 catalog 验证。
- 不把 FDnCNN / NCNN 带入前端默认路径。
- 不把 `NS` / `TELEA` / 强 inpaint 作为默认补救。后处理只允许在“水印几何已经可信、数学反解已明显降低残留、仅剩边缘瑕疵”时 evidence-gated 触发。

## 后续演进方向

下一阶段不建议继续逐图微调，而应把固定组合链路做成可观测、可维护、可回归的系统。

### P0: Candidate ranking report

为每张样例输出 top N 候选，而不是只输出最终结果。每个候选至少记录：

- watermark size
- right / bottom margin
- alpha gain
- alpha map profile
- original evidence
- residual score
- diff artifact cost
- damage / halo / clipping 指标
- 是否 early accept
- 失败或胜出的主要原因

目标是让失败定位变成可解释问题：

- 候选没覆盖：补 catalog。
- 候选覆盖但排序错：改评分。
- 候选和评分都对但视觉仍差：检查 alpha map 或输入是否降级。

### P1: 人工 gold set manifest

为样例目录增加人工标注，记录：

- 是否应该处理。
- 是否已知不支持。
- 期望 anchor family。
- 期望 alpha gain 范围。
- 是否允许弱残留。
- 是否是特殊背景风险样例。

这能把“测试当前代码行为”升级为“测试人类视觉预期”。新增 Gemini 链路样例时，应先进入 gold set，再调整 catalog 或评分。

### P2: Catalog 显式知识库

把尺寸、位置、alpha、alpha map profile 和来源说明组织成更显式的 catalog：

- 高频组合排前。
- 低频组合必须 evidence-gated。
- 每个组合记录来源样例或 Gemini 链路。
- 新增组合必须附带回归样例。
- 不让 local shift、size jitter、adaptive sweep 抢占固定 catalog。

Gemini 未来变化时，主要更新 catalog，而不是改核心算法。

### P3: 评分分层

评分应拆成三类，避免一个综合分吞掉所有语义：

- `originalEvidence`: 原图中是否真的有 Gemini 水印。
- `residualScore`: 处理后是否还有水印形状。
- `artifactCost`: 是否制造了暗边、裁剪、纹理坍塌或局部异常。

最终排序可以使用统一 ranking key，但 debug meta 必须保留分项指标，便于判断是残留问题还是损伤问题。

当前落地状态：

- `src/core/watermarkScoring.js` 已抽出 `scoreOriginalEvidence()`、`scoreResidual()`、`scoreDamage()`、`buildRankingKey()` 和 `shouldEarlyAccept()`。
- `evaluateRestorationCandidate()` 已在候选对象上输出 `sourcePriority`、`alphaPriorityIndex`、`rankingKey`、`earlyAccept`、`originalEvidence`、`residual` 和 `damage`。
- `selectionDebug` 已保留上述分项评分，便于从运行 meta 判断候选胜出原因。
- 生产默认 alpha 候选保持为 `[0.6, 1, 1.15, 1.3, 0.7, 0.85, 0.55]`；其中 `1.15 / 1.3` 不进入初始 standard priority，只作为强证据候选的受控升级路径。额外保守 alpha 仍只作为扫描 / 报告诊断候选，不能进入默认主流程。
- `sample-benchmark` 的 `candidateRankings` 已输出 `earlyAccept` 与分层 ranking 诊断。
- `pickBetterCandidate()` 已在同一固定 anchor 内优先使用 `rankingKey` 比较局部候选，主要覆盖 alpha / warp 这类同位置选择。
- preview-anchor fallback 仍排除在这轮 ranking 迁移之外，避免自动 fallback 通过局部 residual / damage 优势改变既有保护路径。
- `sample-benchmark` 已在顶层 summary 输出 candidate ranking 健康度。当前样例集结果：selected anchor 在 top list 内为 `25/25`，top accepted 匹配 selected anchor 为 `21/25`，selected exact alpha 在 top list 内为 `21/25`，top accepted 精确匹配 selected alpha 为 `9/25`。
- `sample-benchmark` 还新增了独立的 `selectedCandidateDiagnostic`，用于记录实际最终输出，包括 fine-alpha 后的评分。当前 `selectedFinalDiagnosticCount = 25/25`，且 selected final 对 gold anchor / alpha 的匹配均为 `25/25`。
- `selectedCandidateDiagnostic` 已增加 `fineAlphaNeighborhood`，对最终 anchor 枚举离散 alpha、暗 catalog alpha、以及 selected alpha 附近 `±0.02 / ±0.04` 的评分。当前 `selectedFinalFineAlphaNeighborhoodCount = 25/25`，但 selected final alpha 在该邻域排序第一只有 `4/25`。
- `selectedCandidateDiagnostic` 现在输出 `fineAlphaSelectedRank` 和 `fineAlphaTopAlphaGain`，summary 记录 rank 分布与非 top-1 样例。当前 rank 分布为 `1:4, 2:1, 3:6, 4:3, 5:3, 6:2, 7:2, 8:1, 11:3`；这说明报告 rankingKey 仍明显偏向局部微调 alpha，需要继续对齐生产 fine-alpha 判据。
- `selectedCandidateDiagnostic` 进一步输出 `fineAlphaSelectionReason`、`fineAlphaSelectedAlphaType`、`fineAlphaTopAlphaType` 和 `fineAlphaTopDelta`。summary 会按原因、是否经过生产 alpha 调整、selected alpha 类型聚合非 top-1 样例，避免只看 rank 数字误判生产选择。
- 最新分类结果：`production-kept-standard-alpha = 18`、`dark-catalog-fine-alpha = 1`、`weak-positive-residual-fine-alpha = 3`、`direct-discrete-alpha = 3`。非 top-1 样例中 `18` 个没有生产 alpha 调整，主要是生产保留离散 alpha，而报告 rankingKey 偏好 `±0.02 / ±0.04` 的局部微调或暗 catalog 候选；另有 `3` 个经过生产 alpha 调整后仍非 top。
- summary 还按 `fineAlphaTopDeltaBucket` 聚合 report top 与生产 selected alpha 的差值。当前非 top-1 分布为 `micro-lower = 13`、`small-lower = 3`、`medium-lower = 1`、`large-lower = 1`、`large-higher = 1`、`medium-higher = 1`、`small-higher = 1`。这说明大多数偏差只是报告侧更偏保守的微小 alpha drift；真正需要单独分析的是 medium / large bucket 样例。
- summary 已单列 `selectedFinalFineAlphaSignificantDeltaSamples`，并附带 selected/top residual、damage 与 `significantDeltaConcern`。当前 significant delta 共 `4` 个：`20260608-2.png` 和 `20260608-4.png` 属于 `report-top-worse-residual`，`21-9.png` 属于 `report-top-damage-risk`，`20260520-3.png` 属于 `direct-match-standard-alpha-priority`。其中 `20260520-3.png` 已确认 report 需要从 `initialConfig` 继承 `alphaVariant = 20260520`，避免误用 current 96 alpha map；修正后 report top 从错误的 `0.45` 收敛为 `0.85`，剩余差异是生产 direct-match 保持标准 alpha 与 artifact-aware report 排序之间的口径分歧。
- `processWatermarkImageData()` 已在 meta 输出 `alphaAdjustmentStages`，记录生产实际触发的 alpha 调整阶段、前后 alpha、前后 residual 和 cost；`sample-benchmark` 已把这条生产链路带入 `selectedCandidateDiagnostic` 与 summary。当前 `selectedFinalAlphaAdjustmentCount = 4/25`，阶段分布为 `dark-catalog-fine-alpha = 1`、`weak-positive-residual-fine-alpha = 3`；对应样例为 `20260608-4.png`，以及 `20260608-5.png` / `3-2.png` / `9-16.png`。
- 这些数据说明跨 anchor 的生产选择逻辑仍不能整体替换为 `rankingKey` 排序；离散候选 top-N 与最终 fine-alpha 之间仍存在观测差异，fine-alpha 的生产判据也尚未完全由当前 rankingKey 表达。当前仍保留既有 catalog / local / preview 保护规则；下一步应继续把 fine-alpha 生产判据拆出来复用到报告，或只做更小范围的局部迁移。

### P4: 可视化调试页

在 contact sheet 之外，增加可展开的候选排序视图：

- 原图 / 最终图。
- top N 候选缩略图。
- 每个候选的评分表。
- alpha band halo 可视化。
- before/after diff 可视化。
- residual heatmap。

这会显著降低之后调参和判断失败样例的成本。

### P5: 质量型发版

固定核心、ranking report、gold set 和 catalog 稳定后，再做一次质量型版本发布。发版前应固定流程：

```text
pnpm test
pnpm build
生成 sample artifact
人工检查 contact sheet
检查 candidate ranking report
更新 changelog
打包 release
```

## 长期原则

- 不支持降级输入作为默认目标。
- 不恢复默认 multipass。
- 不恢复默认后处理。
- 不做无限自动搜索。
- 不用单一 diff 指标决定胜负。
- 新位置和新 alpha 必须通过样例进入 catalog。
- 算法核心保持透明水印反解，复杂度转移到 catalog、评分和观测工具。

## 2026-06-09 追加：96px fixed-core 轻微负残留放行

本轮针对 `${GWR_SAMPLE_ROOT}` 剩余高置信 skipped 继续拆因：

- 用户新生成的 7 张黑底 alpha 捕获经阈值 bbox 测量后，实际都是 `48x48` 星标捕获，不是剩余失败样本需要的 `96x96` 捕获。其中一部分是 `48/96/96`，一部分是 `48/32/32`，所以不能用于修复 96px 样本。
- 对代表样本 `2064116984391405568-source.png` 逐项评估后，发现 `96/64/64 + bg_96 + alphaGain=1` 已经通过候选验证，残留为轻微负向 overshoot：`processedSpatial ~= -0.487`、`processedGradient ~= 0.119`，纹理风险低；真正阻断它的是 fixed-core 额外 strict 门槛 `abs(processedSpatial) <= 0.45`。
- 因此新增了窄条件放行：仅对 `96px` 标准锚点、非 local/size/preview 候选、原始 evidence 极强、去除后 gradient 大幅下降、`hardReject=false`、低 near-black/texture 风险、且负向 residual 不超过 `0.52` 的候选放行。
- 该改动不放行 2048x2048 类样本；这些样本用当前 `bg_96` 去除后改善很小，仍更像 alpha/render profile 不匹配，而不是 strict 门槛问题。

当前 102 张样本重算结果：

- 上一轮：`applied=64`、`skipped=38`
- 本轮：`applied=67`、`skipped=35`
- 新增命中：
  - `2026-06-08/2064116984391405568-source.png`
  - `2026-06-08/2064117288960790528-source.png`
  - `2026-06-09/2064198757053894656-source.png`

验证：

- `pnpm exec node --test tests/core/watermarkProcessor.test.js`: `31 pass / 1 skip`
- `pnpm test`: `618 pass / 5 skip`

## 2026-06-09 追加：从失败样本自估 96px alpha 的结论

由于用户新生成的黑底捕获均为 `48x48` 水印，本轮改为直接从剩余高置信 skipped 样本中估计 `96px` alpha/render profile。方法：

1. 固定当前检测到的 96px 几何位置。
2. 用水印区域外圈做快速边界插值，估计局部无水印背景 prior。
3. 根据 `observed = alpha * 255 + (1 - alpha) * prior` 反推每个像素的 alpha。
4. 分别测试单图自估 alpha 和按尺寸/锚点聚合后的 alpha。

产物：

- `.artifacts/probe-96-alpha-self-estimation.mjs`
- `.artifacts/sample-files-gemini-watermark-20260609/alpha-self-estimation-96/latest.json`
- `.artifacts/sample-files-gemini-watermark-20260609/alpha-self-estimation-96/comparison-sheet.png`
- `.artifacts/sample-files-gemini-watermark-20260609/alpha-self-estimation-96/aggregate-comparison-sheet.png`

结果：

- 共评估 `11` 张 96px 高置信 skipped。
- `2048x2048:96/64/64/default` 聚合组有 `7` 张，聚合 alpha 按离线 cost 改善 `5/7`。
- `1792x2400:96/64/64/default` 聚合组有 `2` 张，聚合 alpha 按离线 cost 改善 `2/2`。
- 但目测显示，自估/聚合 alpha 经常把中心压下去的同时留下更硬的细边，尤其在肤色、棕色和暗色复杂背景上明显。

结论：

- 剩余 96px 问题不能简单归因于“当前 alpha 太弱”，也不能直接把自估 alpha 作为生产模板。
- 当前证据更像真实渲染模型偏差：alpha 边缘形状、抗锯齿 / composite blur、局部背景 prior 与内容边缘共同造成残留。
- 后续如果要进入生产，应优先做受限的 96px edge-profile / residual-edge cleanup，并要求：
  - 只在 `96px` 几何证据极强时触发。
  - 不允许小尺寸候选抢占 96px。
  - 必须通过 before/after/diff 目测 fixture。
  - 不把 per-image self-estimated alpha 直接加入 catalog。

收尾决策：

- 暂停继续投入 96px 边缘残留案例；当前收益不足以抵消继续调参和误伤风险。
- 保留本轮 `applied=67/102` 的窄修复和离线证据，但不继续推进新的 96px 自估 alpha、edge-profile 或 cleanup 生产化。
- 后续只有在出现大量同类 96px 失败样本、或能稳定取得真实 96px 黑底捕获时，再重启该方向。
- 当前优先级回到主流程稳定性、真实 Gemini 页面链路、性能和更常见的 48px / catalog 回归。

## 2026-06-10 追加：allenk V2 alpha 与可见残留观测活文档

本节是当前 allenk 学习线的活文档入口。后续继续研究 `allenk/GeminiWatermarkTool`、V2 36px 小水印、alpha map、去水印后瑕疵处理时，优先更新这里。

### 当前决策

- 暂不在前端引入 AI / FDnCNN / NCNN。
- 继续吸收 allenk 的确定性策略：profile 分层、V2 alpha map、V2 small 位置公式、窄范围 snap、alpha-gradient mask、证据门控后处理。
- 不把强 inpaint / TELEA / NS / preview-only prior 作为默认生产补救。
- 当相关性指标和肉眼观察冲突时，以可见残留观测为准，先补观测指标，再决定算法修复。

### allenk V1 / V2 alpha map 结论

本地研究快照：

- `.artifacts/external/GeminiWatermarkTool`
- commit：`632348868da0653d5c1e99680d2c448f4d8505eb`

alpha map 对比产物：

- `.artifacts/alpha-map-comparison-allenk-20260610/alpha-map-summary.json`
- `.artifacts/alpha-map-comparison-allenk-20260610/alpha-map-sheet.png`
- `.artifacts/alpha-map-comparison-allenk-20260610/bg_48_png.png`
- `.artifacts/alpha-map-comparison-allenk-20260610/bg_96_png.png`
- `.artifacts/alpha-map-comparison-allenk-20260610/bg_b_36_png.png`
- `.artifacts/alpha-map-comparison-allenk-20260610/bg_b_96_png.png`

已确认：

- allenk V1 `bg_48` 与本项目 `src/assets/bg_48.png` 字节一致。
- allenk V1 `bg_96` 与本项目 `src/assets/bg_96.png` 字节一致。
- allenk V2 `bg_b_96` 接近本项目 `src/assets/bg_96_20260520.png`，但不完全一致，allenk 略强。
- allenk V2 `bg_b_36` 是当前项目之前缺失的重要 alpha map。
- `bg_b_36` 近似 `bg_b_96` 高质量下采样，但生产中使用精确嵌入的 `36-v2`，避免运行时插值差异。

### 已落地的 V2 36px 小水印支持

核心代码：

- `src/core/embeddedAlphaMaps.js`
  - 新增 `36-v2` embedded alpha map。
- `src/core/watermarkEngine.js`
  - 预加载并支持 `getAlphaMap('36-v2')`。
- `src/core/geminiSizeCatalog.js`
  - 新增 `gemini-v2-small` catalog entry。
  - 仅对 Gemini 3.x official 1K 输出加入 V2 36 候选。
  - V2 small margin 采用 allenk 的 aspect-aware 公式：
    - `1024x1024` -> `36 / 71 / 71 / v2`
    - `1376x768` -> `36 / 96 / 96 / v2`
- `src/core/candidateSelector.js`
  - 支持非 96px alpha variant，例如 `36-v2`。
  - V2 small catalog 使用 `evidenceGate: 'medium'`，要求原始 evidence 至少满足：
    - `originalSpatial >= 0.15`
    - 或 `originalGradient >= 0.08`
  - 该门控用于阻止弱证据 `1408x768` 被错误接受。
- `src/core/watermarkProcessor.js`
  - meta config 保留 `alphaVariant`，便于调试和报告。
  - 新增 V2 36 edge cleanup 窄门控：
    - `logoSize === 36`
    - `alphaVariant === 'v2'`
    - `catalogFamily === 'gemini-v2-small'`
    - source 包含 catalog
    - `abs(processedSpatial) <= 0.08`
    - `processedGradient >= 0.22`
  - cleanup 使用既有 alpha-gradient edge cleanup 执行器，不新增强 inpaint。

相关测试 / fixture：

- `tests/core/embeddedAlphaMaps.test.js`
- `tests/core/geminiSizeCatalog.test.js`
- `tests/core/watermarkProcessor.test.js`
- `tests/fixtures/gemini-v2-36-small-watermark.png`

### V2 36px 真实样本结果

代表样本：

- `${GWR_SAMPLE_ROOT}/2026-06-09/2064246191004061696-source.png`
- 尺寸：`1024x1024`
- 选中配置：`36 / 71 / 71 / v2`

加入 V2 36 edge cleanup 前：

- `source = standard+catalog+validated`
- `processedSpatial ~= -0.0368`
- `processedGradient ~= 0.4241`
- 传统分类：residual

加入 V2 36 edge cleanup 后：

- `source = standard+catalog+validated+v2-small-edge-cleanup`
- `processedSpatial ~= 0.0580`
- `processedGradient ~= -0.0513`
- 传统分类：pass
- 额外耗时约 `18ms` 级别，单图总处理约 `45ms`。

可视化产物：

- `.artifacts/v2-36-cleanup-preview-20260610/before-after-crop.png`
- `.artifacts/v2-36-cleanup-preview-20260610/variant-sheet.png`
- `.artifacts/v2-36-cleanup-preview-20260610/outside-inpaint-variant-sheet.png`
- `.artifacts/v2-36-cleanup-preview-20260610/extreme-inpaint-variant-sheet.png`

重要观察：

- 相关性指标明显改善，但肉眼仍能看到星形中心灰影。
- center weak fill、outside-only inpaint、强 outside inpaint 都不能安全解决中心灰影。
- 强 inpaint 会产生矩形块状瑕疵，不能进入生产默认路径。
- 当前 V2 36 edge cleanup 只能视为边缘残留改善，不等于视觉完全去除。

### 新增可见残留指标 `residualVisibility`

问题背景：

- 之前 `processedSpatialScore` / `processedGradientScore` 能判断水印形状相关性，但不能稳定捕捉“alpha 区域仍比周围亮”的灰影。
- V2 36 样本中，edge cleanup 后 `processedGradientScore ~= -0.0513`，但 alpha core band 仍比外圈亮约 `9` luminance，肉眼仍能看到星形。

新增指标：

- `src/core/restorationMetrics.js`
  - `assessWatermarkResidualVisibility()`
- `src/core/watermarkProcessor.js`
  - 最终 meta 写入 `meta.detection.residualVisibility`
- `src/sdk/index.d.ts`
  - 新增 `WatermarkResidualVisibilityMeta`
- `scripts/sample-benchmark.js`
  - 每条 benchmark record 输出 `residualVisibility`

字段语义：

- `visible`
- `positiveHaloLum`
- `haloVisibility`
- `spatialResidual`
- `gradientResidual`
- `visiblePositiveHalo`
- `visibleGradientResidual`
- `visibleSpatialResidual`
- `halo`

当前阈值：

- `positiveHaloLum >= 6` -> `visiblePositiveHalo`
- `gradientResidual >= 0.22` -> `visibleGradientResidual`
- `spatialResidual >= 0.18` -> `visibleSpatialResidual`

注意：

- 这是诊断指标，不是当前生产硬拒绝条件。
- 它用于把“传统 metric pass 但肉眼仍有残影”的样本捞出来。
- 后续如果要纳入 pass/fail，应先建立人工 gold set / crop sheet，而不是直接改分类。

### 外部样本复测快照

样本目录：

- `${GWR_SAMPLE_ROOT}`

V2 36 cleanup 复测报告：

- `.artifacts/sample-files-gemini-watermark-v2-36-cleanup-20260610/summary.json`

结果：

- `total = 189`
- `applied = 152`
- `skipped = 37`
- `pass = 66`
- `residual = 86`
- `v2Selected = 1`
- `v2Cleanup = 1`

结论：

- V2 36 只命中 1 张真实样本。
- 命中的样本从 residual 变为 pass。
- 之前弱证据 `1408x768` 没有被 V2 36 错误接受。

可见残留复测报告：

- `.artifacts/sample-files-gemini-watermark-residual-visibility-20260610/summary.json`

结果：

- `total = 189`
- `applied = 152`
- `skipped = 37`
- 传统 `metricPass = 66`
- 传统 `metricResidual = 86`
- 新指标 `visibleResidual = 83`
- 传统 pass 但仍可见残留：`metricPassVisible = 6`
- `v2Visible = 1`
- visible reason 分布：
  - `visibleGradientResidual = 30`
  - `visibleSpatialResidual = 50`
  - `visiblePositiveHalo = 37`

当前解读：

- `residualVisibility` 能成功暴露“传统指标 pass 但肉眼仍可见”的样本。
- 这说明后续修复不应继续只优化 spatial / gradient correlation。
- 下一阶段应围绕 visible residual 样本做人工 crop sheet 分组。

### 当前验证状态

最近一次完整验证：

```powershell
pnpm test
pnpm benchmark:samples
pnpm build
```

结果：

- `pnpm test`: `633 pass / 5 skip`
- `pnpm benchmark:samples`: `25 pass / 0 fail`
- `pnpm build`: 通过

### 暂停 / 不做

- 不把 AI denoise 引入前端实时路径。
- 不把 allenk FDnCNN / NCNN 移植进当前默认 pipeline。
- 不把强 inpaint / outside inpaint / TELEA / NS 放入默认生产。
- 不根据单张 V2 36 样本继续调强 cleanup。
- 不把 `residualVisibility` 立刻作为硬 fail，因为缺少人工 gold set。

### 下一步队列

P0：生成 visible residual crop sheet

- 输入：`.artifacts/sample-files-gemini-watermark-residual-visibility-20260610/summary.json`
- 目标：
  - 输出 `metricPassVisible` 的 before/after crop sheet。
  - 输出 `visibleTop` 的 before/after crop sheet。
  - 按原因分组：
    - positive halo
    - gradient residual
    - spatial residual
  - 人工判断哪些是真残影，哪些是背景结构误报。

P0 已完成产物：

- 脚本：`scripts/render-visible-residual-crops.js`
- 报告：`.artifacts/visible-residual-crops/latest/summary.json`
- 总览 sheet：
  - `.artifacts/visible-residual-crops/latest/metricPassVisible.png`
  - `.artifacts/visible-residual-crops/latest/visibleTop.png`
  - `.artifacts/visible-residual-crops/latest/positiveHalo.png`
  - `.artifacts/visible-residual-crops/latest/gradientResidual.png`
  - `.artifacts/visible-residual-crops/latest/spatialResidual.png`
- sheet 布局已改为人工审阅版：
  - `before context`
  - `after context`
  - `after ROI raw`
  - `after contrast`
  - `ROI diff x5`
  - context 只用角标定位，避免遮挡残影本体。
- 当前渲染数量：
  - `metricPassVisible = 6`
  - `visibleTop = 30`
  - `positiveHalo = 30`
  - `gradientResidual = 30`
  - `spatialResidual = 30`

初步目测：

- `metricPassVisible` 中确实存在传统 pass 但肉眼仍可见灰影的案例，`residualVisibility` 方向成立。
- V2 36 样本仍是中心灰影问题，不应继续靠增强 edge cleanup 解决。
- 部分 96px / 48px 大边距样本的 positive halo 与背景结构贴得很近，下一步需要人工 gold 标注区分真残影和背景误报。

P1：把 `residualVisibility` 纳入样本 gold manifest

- gold 字段建议：
  - `allowVisibleResidual`
  - `maxPositiveHaloLum`
  - `maxGradientResidual`
  - `maxSpatialResidual`
  - `notes`
- 不同背景复杂度可以有不同容忍阈值。

P1 预备步骤已完成：先生成 review manifest，不直接写入正式 gold。

- 脚本：`scripts/create-visible-residual-review-manifest.js`
- 队列渲染脚本：`scripts/render-visible-residual-review-queues.js`
- 分组报告脚本：`scripts/create-visible-residual-cluster-report.js`
- 产物：`.artifacts/visible-residual-crops/latest/review-manifest.json`
- 分组报告：`.artifacts/visible-residual-crops/latest/review-clusters.json`
- 队列图：
  - `.artifacts/visible-residual-crops/latest/review-queues/modelInvestigation.png`
  - `.artifacts/visible-residual-crops/latest/review-queues/goldToleranceDiscussion.png`
  - `.artifacts/visible-residual-crops/latest/review-queues/humanReviewNext.png`
- 来源：`.artifacts/visible-residual-crops/latest/summary.json`
- 预审状态：
  - `metricPassVisibleReviewed = 6`
  - `visibleTopPending = 27`
  - `trueVisibleResidual = 2`
  - `needsModelInvestigation = 1`
  - `contentCollision = 3`
- 自动队列：
  - `modelInvestigation = 3`
  - `goldToleranceDiscussion = 3`
  - `humanReviewNext = 10`
- pending 聚合：
  - profile 分布：`48px-large-margin = 11`、`45px-other = 7`、`48px-standard-margin = 4`、`46px-other = 2`、`96px-large-margin = 2`、`47px-other = 1`
  - reason 分布：`positiveHalo = 27`、`gradientResidual = 15`、`spatialResidual = 14`

当前预填判断：

- `样本2/Gemini_Generated_Image_a1d2x6a1d2x6a1d2.png`
  - `trueVisibleResidual`
  - `48px-large-margin`
  - 下一步：调查 `48px` 大边距 alpha/profile。
- `样本2/Gemini_Generated_Image_6mry9p6mry9p6mry.png`
  - `trueVisibleResidual`
  - `48px-large-margin`
  - 下一步：调查 `48px` 大边距 alpha/profile。
- `2026-06-09/2064246191004061696-source.png`
  - `needsModelInvestigation`
  - `36px-v2-small`
  - 下一步：调查 V2 36 forward render / 中心灰影模型。
- `2026-06-08/2064131568774942720-source.png`
  - `contentCollision`
  - `96px-standard`
  - 下一步：先讨论 gold 容忍度，不直接推动算法调整。
- `2026-06-08/2064131957880524800-source.png`
  - `contentCollision`
  - `96px-standard`
  - 下一步：先讨论 gold 容忍度，不直接推动算法调整。
- `2026-06-09/2064190955333881856-source.png`
  - `contentCollision`
  - `192px-scaled-anchor`
  - 下一步：先讨论 gold 容忍度，不直接推动算法调整。

注意：`review-manifest.json` 中 `codex-initial-pass` 是预填判断，不是正式 gold。进入 `gold-manifest.json` 前需要人工确认。

review cluster 报告：

```powershell
rtk pnpm visible-residual:cluster-report
rtk node scripts/create-visible-residual-cluster-report.js
```

- 分组键：`sourceSet + profileLine + sorted visibleReasons`
- Markdown worksheet：`.artifacts/visible-residual-crops/latest/human-review-pack/cluster-review-worksheet.md`
- cluster sheet：`.artifacts/visible-residual-crops/latest/human-review-pack/by-cluster/*.png`
- cluster worksheet 的 `Provenance` 段记录当前 `reviewManifestSha256`、`validationReportSha256` 与 `reviewClusterSha256`，避免旧分组审阅入口被误认为来自当前 manifest / validation / cluster report。
- 当前 `totalRecords = 33`
- 当前 `clusterTotal = 16`
- 当前 `clusterSheetCount = 16`
- 覆盖 `visibleTopPending = 27` 与 `metricPassVisible = 6`
- 当前 `unconfirmedCount = 33`
- `inputs.reviewManifestSha256` 与当前 `review-manifest.json` 内容一致。
- `inputs.validationReportSha256` 与当前 `validation-report.json` 内容一致。
- 生成入口会先校验 `validation-report.json.reviewManifestSha256` 等于当前 `review-manifest.json` 内容 hash；若缺失或不一致，会以 `validation-report-missing-review-manifest-hash` / `validation-report-review-manifest-hash-mismatch` fail-closed，并且不写 `review-clusters.json`、cluster worksheet 或 cluster sheets。
- `readOnly = true`
- 不写正式 gold，不改生产算法。

用途：把人工审阅、gold candidate 和后续算法 profile 候选固定到同一组 cluster 上，避免后续只按单张图片或临时阈值推进。

### 模型队列 alphaGain sweep 探针

脚本：

- `scripts/probe-visible-residual-alpha-sweep.js`

产物：

- `.artifacts/visible-residual-crops/latest/alpha-sweep/model-investigation-alpha-sweep.json`

探针范围：

- 只跑 `review-manifest.json` 的 `workQueues.modelInvestigation`。
- 固定当前候选几何和 alpha map。
- 扫 `alphaGain = 0.5 ~ 1.35` 的有限集合。
- 只作为离线诊断，不改变生产路径。

结果：

- `total = 3`
- `directAlphaGainCouldClearVisible = 0`
- `hardRejectBestCount = 0`

单样本结论：

- `样本2/Gemini_Generated_Image_a1d2x6a1d2x6a1d2.png`
  - best severity: `alphaGain = 0.75`，但仍 `visible = true`
  - best halo: `alphaGain = 0.95` 可把 positive halo 压到 `0`，但 gradient / spatial residual 明显变坏。
- `样本2/Gemini_Generated_Image_6mry9p6mry9p6mry.png`
  - best severity: `alphaGain = 0.85`，但仍 `visible = true`
  - best halo: `alphaGain = 1.3` 可把 positive halo 压到 `0`，但 gradient / spatial residual 明显变坏。
- `2026-06-09/2064246191004061696-source.png`
  - best severity: `alphaGain = 0.5`，但仍 `visible = true`
  - best halo: `alphaGain = 1.05` 可把 positive halo 压到 `0`，但 gradient residual 明显变坏。

结论：

- 这些模型队列样本不能靠单纯加强/减弱 alphaGain 解决。
- “压低 positive halo” 和 “保持形状残留低”之间存在冲突，说明问题更像 alpha/profile/render model 差异。
- 下一步若继续算法研究，应优先比较 alpha 边缘 / 中心 profile 或 forward render model，不应把宽 alpha sweep 加回生产主链路。

### 模型队列 alpha profile 探针

脚本：

- `scripts/probe-visible-residual-alpha-profile.js`
- `scripts/render-visible-residual-alpha-profile-sheet.js`

产物：

- `.artifacts/visible-residual-crops/latest/alpha-profile/model-investigation-alpha-profile.json`
- `.artifacts/visible-residual-crops/latest/alpha-profile/model-investigation-alpha-profile.png`

探针范围：

- 只跑 `workQueues.modelInvestigation`。
- 固定当前候选几何。
- 比较有限 profile 变体：`mid/core/edge boost`、`power`、`blur-mix`、`sharpen`。
- 每个 profile 只扫有限 alphaGain，用于诊断，不用于生产选择。

结果：

- `total = 3`
- `profileCouldClearVisible = 2`
- best profile name：
  - `48px-large-margin / a1d2x6...`: `power-0.94` 是 best severity；`mid-boost-1.24 + alphaGain=0.7` 可达到指标 `visible=false`。
  - `48px-large-margin / 6mry9p...`: `blur-mix-0.25` 是 best severity；`mid-boost-1.24 + alphaGain=0.8` 可达到指标 `visible=false`。
  - `36px-v2-small / 206424619...`: 没有任何有限 profile 变体能达到 `visible=false`。

目测结论：

- 两个 `48px-large-margin` 样本中，`mid-boost-1.24` 确实能压淡中心灰影，但仍不是完美复原。
- V2 36 中心灰影没有被这些 alpha profile 变体解决，继续应转向 V2 36 forward render model / composite 差异，而不是沿用 48px profile 思路。
- `mid-boost-1.24` 目前只能视为候选假设，需要先扩到更多 `48px-large-margin` visibleTop 样本做泛化检查，不能直接生产化。

### 48px large-margin profile 泛化检查

脚本：

- `scripts/probe-48-large-margin-profile-candidate.js`
- `scripts/render-48-large-margin-profile-candidate-sheet.js`

产物：

- `.artifacts/visible-residual-crops/latest/alpha-profile/large-margin-48-profile-candidate.json`
- `.artifacts/visible-residual-crops/latest/alpha-profile/large-margin-48-profile-candidate.png`

探针范围：

- 从 review manifest 中抽取所有 `48/96/96/default` 可见残留样本。
- 包含 `metricPassVisible` 已预审样本和 `visibleTopPending` 样本。
- 固定测试 `mid-boost-1.24`，有限 alphaGain：`0.65 / 0.7 / 0.75 / 0.8 / 0.85 / 0.9`。

结果：

- `total = 13`
- `improvedSeverity = 7`
- `clearedVisible = 4`
- `hardRejectBest = 0`
- verdict 分布：
  - `pending = 11`
  - `trueVisibleResidual = 2`
- best alphaGain 分布：
  - `0.9 = 7`
  - `0.65 = 2`
  - `0.85 = 2`
  - `0.7 = 1`
  - `0.8 = 1`

解读：

- `mid-boost-1.24` 对 `48px-large-margin` 有真实信号：部分样本 positive halo 明显下降，少数样本指标达到 `visible=false`。
- 但它不是稳定通用解：若强行作为默认 alpha profile，部分 pending 样本会出现 spatial / gradient residual 变坏或 texturePenalty 升高。
- 两个已预审 `trueVisibleResidual` 样本虽然被打到 `visible=false`，但 severity 反而高于当前 production 记录；这说明当前 severity 仍不能完全表达肉眼“中心灰影变淡”的收益。
- 目测 13 样本 sheet 后，结论更保守：
  - 部分平滑/浅色背景中，`mid-boost-1.24` 的确能淡化中心灰影。
  - 高纹理、强边缘和强高光背景中，它容易把残影变成更硬的暗星形或放大内容边缘。
  - 因此它只能证明“48px 大边距残影与 alpha profile 有关”，不能作为生产 profile。
- 该方向下一步应是：
  - 再把 `positive halo 改善` 与 `shape residual 变坏` 分开建模。
  - 根据背景/texture 分组判断是否存在窄门控 profile，而不是全局替换。
  - 不把 `mid-boost-1.24` 直接放入生产 catalog。

### Gold 候选与算法准入闭环

脚本：

- `scripts/create-visible-residual-gold-proposal.js`
- `scripts/verify-visible-residual-loop.js`
- `scripts/create-visible-residual-human-review-pack.js`
- `scripts/validate-visible-residual-human-review.js`
- `scripts/report-visible-residual-review-progress.js`
- `scripts/apply-visible-residual-focused-review-batch.js`
- `scripts/create-visible-residual-review-worksheet.js`
- `scripts/create-visible-residual-admission-report.js`
- `scripts/create-visible-residual-goal-audit-report.js`
- `scripts/create-visible-residual-cluster-report.js`
- `scripts/create-visible-residual-gold-manifest.js`
- `scripts/run-visible-residual-loop.js`

产物：

- `.artifacts/visible-residual-crops/latest/gold-proposal.json`
- `.artifacts/visible-residual-crops/latest/human-review-pack/summary.json`
- `.artifacts/visible-residual-crops/latest/human-review-pack/README.md`
- `.artifacts/visible-residual-crops/latest/human-review-pack/all-pending.png`
- `.artifacts/visible-residual-crops/latest/human-review-pack/gold-candidates.png`
- `.artifacts/visible-residual-crops/latest/human-review-pack/review-decisions.template.json`
- `.artifacts/visible-residual-crops/latest/human-review-pack/review-decisions.json`
- `.artifacts/visible-residual-crops/latest/human-review-pack/gold-candidate-confirmations.template.json`
- `.artifacts/visible-residual-crops/latest/human-review-pack/gold-candidate-confirmations.json`
- `.artifacts/visible-residual-crops/latest/human-review-pack/validation-report.json`
- `.artifacts/visible-residual-crops/latest/human-review-pack/review-worksheet.md`
- `.artifacts/visible-residual-crops/latest/human-review-pack/review-table.csv`
- `.artifacts/visible-residual-crops/latest/human-review-pack/review-progress-report.json`
- `.artifacts/visible-residual-crops/latest/human-review-pack/review-checkpoint.json`
- `.artifacts/visible-residual-crops/latest/human-review-pack/review-focused-batch.json`
- `.artifacts/visible-residual-crops/latest/human-review-pack/review-handoff.md`
- `.artifacts/visible-residual-crops/latest/human-review-pack/cluster-review-worksheet.md`
- `.artifacts/visible-residual-crops/latest/human-review-pack/by-cluster/*.png`
- `.artifacts/visible-residual-crops/latest/algorithm-admission-report.json`
- `.artifacts/visible-residual-crops/latest/goal-audit-report.json`
- `.artifacts/visible-residual-crops/latest/review-clusters.json`
- `.artifacts/visible-residual-crops/latest/human-review-pack/by-profile/*.png`
- `.artifacts/visible-residual-crops/latest/gold-manifest.json`：仅当 `readyForGoldMigration = true` 时才允许生成；当前必须不存在。

`gold-proposal.json` 当前策略：

- `writesFormalGoldManifest = false`
- `writesProductionAlgorithm = false`
- `requiresHumanConfirmationBeforeGoldMigration = true`
- `requiresHumanConfirmationBeforeProductionProfile = true`
- alpha sweep / alpha profile / profile generalization 观测报告都会在 `inputs.reviewManifestSha256` 中记录当前 `review-manifest.json` 内容 hash。
- `gold-proposal.json.inputs` 记录 `reviewManifestSha256`、`alphaSweepSha256`、`profileReportSha256`、`profileGeneralizationSha256`，以及三个 alpha/profile 观测报告内部的 `*ReviewManifestSha256`，让 proposal 可追溯到当前 review / alpha / profile 观测产物。
- gold proposal 生成入口会校验三个 alpha/profile 观测报告的 `inputs.reviewManifestSha256` 都等于当前 review manifest hash；若缺失或不一致，会以 `alpha-sweep-review-manifest-hash-mismatch` / `profile-report-review-manifest-hash-mismatch` / `profile-generalization-review-manifest-hash-mismatch` fail-closed，不写 proposal。
- 每个 proposal candidate 都保留 `sourceSet`、`clusterId` 和 `visibleReasons`；`clusterId` 由 `sourceSet + profileLine + sorted visibleReasons` 生成，和 review manifest / cluster report 的分组键一致。
- 后续 admission 与 formal gold 迁移不会只信 proposal 自带字段；会从当前 `review-manifest.json` 重新推导候选集合，并比对 candidate count、`file`、`sourceSet`、`clusterId`。

gold 候选摘要：

- `readyForHumanConfirmation = 6`
- `pendingHumanReview = 27`
- ready verdict：
  - `contentCollision = 3`
  - `trueVisibleResidual = 2`
  - `needsModelInvestigation = 1`
- pending profile：
  - `48px-large-margin = 11`
  - `45px-other = 7`
  - `48px-standard-margin = 4`
  - `46px-other = 2`
  - `96px-large-margin = 2`
  - `47px-other = 1`

人工审阅包：

- 覆盖 `visibleTopPending = 27` 全量样本。
- 覆盖 `metricPassVisible = 6` gold 候选确认样本。
- `all-pending.png` 拼接全部 pending crop row。
- `gold-candidates.png` 拼接全部 Codex 预审 gold candidate crop row。
- `by-profile/*.png` 按 profile 分组：
  - `48px-large-margin = 11`
  - `45px-other = 7`
  - `48px-standard-margin = 4`
  - `46px-other = 2`
  - `96px-large-margin = 2`
  - `47px-other = 1`
- `review-decisions.template.json` 为每条 pending 样本预留：
  - `humanVerdict`
  - `humanConfidence`
  - `humanNotes`
- `review-decisions.json` 是人工填写输入文件；runner 只在文件不存在时创建，后续重建闭环会保留已有人工填写内容。
- `gold-candidate-confirmations.template.json` 为每条 Codex 预审 gold 候选预留同样的人工确认字段，并保留 `suggestedVerdict` / `suggestedConfidence` 作为参考。
- `gold-candidate-confirmations.json` 是 gold candidate 人工确认输入文件；runner 同样只在文件不存在时创建。
- 两个 template 当前都保持未确认状态，不作为正式 gold；验证默认读取非 template 的人工输入文件。

人工审阅验证：

```powershell
rtk pnpm visible-residual:validate-human-review
rtk node scripts/validate-visible-residual-human-review.js
```

当前结果：

- `readyForGoldMigration = false`
- `pendingTotal = 27`
- `goldCandidateTotal = 6`
- `decisionTotal = 27`
- `candidateDecisionTotal = 6`
- `unconfirmedCount = 33`
- `pendingUnconfirmedCount = 27`
- `goldCandidateUnconfirmedCount = 6`
- `structuralErrorCount = 0`
- `readyDecisionCount = 0`

含义：

- template 结构有效，所有 pending 样本都有对应 entry。
- gold candidate confirmation template 结构有效，所有 Codex 预审候选都有对应 entry。
- 人工输入文件与 template 分离：`review-decisions.json` / `gold-candidate-confirmations.json` 可被人工填写并跨 loop 保留。
- 尚无人工填写的 `humanVerdict` / `humanConfidence`，因此不能迁移正式 gold。
- 该验证脚本只读 review manifest 和 decisions template，只写 validation report，不写正式 gold，也不改生产算法。

人工审阅状态查看：

```powershell
rtk pnpm visible-residual:review-status
rtk node scripts/report-visible-residual-review-progress.js
rtk node scripts/report-visible-residual-review-progress.js --output .artifacts/visible-residual-crops/latest/human-review-pack/review-progress-report.json
rtk node scripts/report-visible-residual-review-progress.js --output .artifacts/visible-residual-crops/latest/human-review-pack/review-progress-report.json --checkpoint-output .artifacts/visible-residual-crops/latest/human-review-pack/review-checkpoint.json
rtk node scripts/report-visible-residual-review-progress.js --output .artifacts/visible-residual-crops/latest/human-review-pack/review-progress-report.json --checkpoint-output .artifacts/visible-residual-crops/latest/human-review-pack/review-checkpoint.json --focused-batch-output .artifacts/visible-residual-crops/latest/human-review-pack/review-focused-batch.json
rtk node scripts/report-visible-residual-review-progress.js --output .artifacts/visible-residual-crops/latest/human-review-pack/review-progress-report.json --checkpoint-output .artifacts/visible-residual-crops/latest/human-review-pack/review-checkpoint.json --focused-batch-output .artifacts/visible-residual-crops/latest/human-review-pack/review-focused-batch.json --handoff-output .artifacts/visible-residual-crops/latest/human-review-pack/review-handoff.md
```

当前输出含义：

- 只读 stdout，不写 artifact，不改正式 gold，不改生产算法。
- 汇总 `readyDecisionCount`、`unconfirmedCount`、`structuralErrorCount`、`completionRatio`。
- 按 `sourceSet` / `profileLine` / `problem` 聚合未完成项。
- 读取 `review-clusters.json`，输出 `clusterSummary`、`counts.incompleteByCluster` 和 `nextReviewClusters`。
- 在 `inputs` 中记录 `validationReportSha256`、`reviewManifestSha256`、`reviewClusterSha256`，用于发现进度报告没有随 validation / manifest / cluster artifact 刷新的情况。
- review progress 生成入口会校验 `review-clusters.json` 的 manifest / validation 输入 hash；若 cluster report 与当前 manifest / validation 不一致，会 fail-closed，不写 progress report。
- `nextReviewClusters` 按 `incompleteCount` 降序列出最该先审的分组，并给出 `clusterId`、`profileLine`、`visibleReasons`、`sheetPath`、首个 `file` / `cropPath`。
- 输出 `nextReviewBatch`，固定指向当前 top cluster，并列出该 cluster 的下一批 `file` / `cropPath`。
- 输出 `reviewBatches`，把所有未完成 cluster 都转成稳定批次，每批记录 `sheetPath`、`totalIncompleteInCluster`、`firstDecisionJsonPath` 与批次内 JSON locator，便于按组持续完成 33 个确认。
- 输出 `goldCandidateReviewBatches` / `nextGoldCandidateReviewBatch`，把 `metricPassVisible` 的 gold 候选确认单独列出，确保正式 gold 迁移前的 6 个 candidate confirmation 不被普通 pending 审阅淹没。
- 输出 `nextReviewItems`，同样按 `nextReviewClusters` 的 cluster 优先级排序；第一条必须和 top cluster 对齐，用于人工审阅时逐条定位 `file` / `cropPath`。
- `review-checkpoint.json` 是更短的当前人审执行入口：记录下一批普通 visible residual、下一批 gold candidate confirmation、两个人审输入路径、整批 `decisionTargets`、填完后的验证命令，以及 `write-formal-gold-manifest` / `productionize-alpha-profile-variant` 的阻断状态；它不写正式 gold，也不允许生产化 alpha/profile。
- `review-focused-batch.json` 是当前批次的小型人工填写文件，只包含下一批普通 visible residual 和下一批 gold candidate confirmation；人工只填 `humanVerdict` / `humanConfidence` / `humanNotes`，`humanVerdict` 只能取 `trueVisibleResidual` / `backgroundStructure` / `contentCollision` / `acceptableResidual` / `needsModelInvestigation`，`humanConfidence` 只能取 `high` / `medium` / `low`，且 `trueVisibleResidual` / `needsModelInvestigation` 必须填写 `humanNotes`。编辑后先运行 `rtk pnpm visible-residual:apply-focused-batch --dry-run` 预检 hash、字段、必填 notes 和定位目标，再运行 `rtk pnpm visible-residual:apply-focused-batch` 合并回正式人审输入。
- `review-handoff.md` 会把当前 visible residual 批次和 gold candidate 批次的 cluster sheet 作为 Markdown 图片直接嵌入，并为每条 focused decision 嵌入单独的 crop preview；人工打开交接页即可先看整组视觉证据，再逐条看 crop，最后按表格里的 `decisionJsonPath` 回填 focused batch。
- `review-handoff.md` 是当前批次的人类可读交接页：记录当前 gate 数量、validation / manifest / cluster hash、focused batch 路径、apply / validate / loop 命令、visible residual 批次表、gold candidate 批次表，以及 no-gold / no-production / no-alpha-profile-production 策略；它由 verifier 和 goal audit 校验，避免交接说明变成 stale 文档。
- `apply-visible-residual-focused-review-batch.js` 会校验 focused batch 的 validation / review manifest / cluster hash、每条 `decisionInputPath` / `decisionArrayIndex` / `decisionJsonPath` / `file` / `clusterId` locator，以及 verdict/confidence/notes；focused batch 未填完整、hash 过期、同一目标重复出现、`decisionJsonPath` 与 `decisionArrayIndex` 不一致，或出现 alpha/profile 字段时都会 `skippedWrite=true`，不写正式 gold，不改生产算法；dry-run / apply 回执会记录 `batchSha256`、两个人审输入的 before/after sha256 和 `changedTargets`，让人工批次合并本身也可审计。
- `validation-report.json`、`review-progress-report.json`、`review-checkpoint.json`、`review-focused-batch.json`、`review-handoff.md`、worksheet 和 CSV 都暴露 `decisionInputPath` / `decisionJsonPath` / `decisionArrayIndex` / `decisionIndex`，人工确认时可以直接回填对应 `decisions[n]`，避免只靠文件名搜索 JSON。

人工审阅 worksheet：

```powershell
rtk pnpm visible-residual:review-worksheet
rtk node scripts/create-visible-residual-review-worksheet.js
rtk node scripts/create-visible-residual-review-worksheet.js --clusters .artifacts/visible-residual-crops/latest/review-clusters.json
```

输出：

- `.artifacts/visible-residual-crops/latest/human-review-pack/review-worksheet.md`
- `.artifacts/visible-residual-crops/latest/human-review-pack/review-table.csv`
- `.artifacts/visible-residual-crops/latest/human-review-pack/cluster-review-worksheet.md`
- Markdown 表格列出待确认项的 `sourceSet` / `clusterId` / `decisionInputPath + decisionJsonPath` / `profileLine` / `file` / `cropPath` / `suggested` / `missing`。
- CSV 表格列出同一批待确认项，并包含 `decisionInputPath` / `decisionJsonPath` / `decisionArrayIndex` / `decisionIndex`，便于用表格工具按 `clusterId` / `sourceSet` / `profileLine` / `missingProblems` 排序筛选后准确回填 JSON。
- worksheet 的 `Provenance` 段与 CSV 每行都会记录 `validationReportSha256` / `reviewManifestSha256` / `reviewClusterSha256`，用于识别 stale worksheet/table。
- worksheet / CSV 生成入口会校验 `review-clusters.json` 的 manifest / validation 输入 hash；若 cluster report 与当前 manifest / validation 不一致，会 fail-closed，不写 worksheet/table。
- worksheet / CSV 默认读取 `review-clusters.json`，按 `nextReviewClusters` 同款优先级排序；CSV 第一行应和当前 top cluster 对齐。
- worksheet 在全量 `Review Items` 前额外写出 `Next Review Batch`：固定当前最高优先级 cluster 的 `clusterId`、cluster sheet 路径、批次内 JSON locator 与剩余数量，便于先按组图完成一小批确认。
- worksheet 还会写出 `Review Batches` 索引表：覆盖所有未完成 cluster，记录 `reviewBatchCount`、`totalIncompleteDecisions`、每批 `sheetPath` 和首个 `decisionJsonPath`，用于连续审完所有批次。
- worksheet 还会写出 `Gold Candidate Review Batches` 索引表：只列 `metricPassVisible` 候选确认批次，记录 `goldCandidateReviewBatchCount`、`goldCandidateIncompleteDecisions` 和首个 `gold-candidate-confirmations.json decisions[n]`。
- `review-decisions.template.json` 与 `gold-candidate-confirmations.template.json` 暴露稳定 `clusterId`，生成规则和 review cluster report 一致：`sourceSet + profileLine + sorted visibleReasons`。
- human review pack summary、decision templates、实际人工输入 JSON 和 validation report 都记录当前 `review-manifest.json` 的 `reviewManifestSha256`，用于证明这些产物来自同一份 manifest；summary 还会写入 `artifactHashes`，绑定 README、decision templates、两个人审输入 JSON、review input contract、总览 sheet、gold candidate sheet 和每个 profile sheet 的当前 sha256。
- human review pack 还会生成 `review-input-contract.json`，机器可读地声明 allowed `humanVerdict` / `humanConfidence`、需要 `humanNotes` 的 blocking verdict、可编辑字段、不可编辑字段、两套 decision input 路径与 expected count。
- human review validation 会把人审 JSON 输入 schema 汇总到 `decisionSchemaGate`：只允许模板声明的 decision 字段，拒绝 `alphaGain`、`profileVariant`、`renderProfile` 等 alpha/profile 变体字段与未知字段；命中时以 `decision-alpha-profile-variant-fields-present` / `decision-unknown-fields-present` 计入 structural error，保持 `readyForGoldMigration = false`。
- `decisionSchemaGate` 同时校验 `review-decisions.json` / `gold-candidate-confirmations.json` 的根级输入 schema：只允许 `schemaVersion`、`reviewManifestSha256`、`instructions`、`decisions`，若在根级 metadata 或 `instructions` 中塞入 `profileVariant` / `renderProfile` 等 alpha/profile 变体或未知根字段，会以 `decision-input-alpha-profile-variant-fields-present` / `decision-input-unknown-root-fields-present` fail-closed。
- algorithm admission report 与正式 gold manifest 迁移也会要求 validation report 携带完整且 `ok = true` 的新版 `decisionSchemaGate`；缺失旧 gate 或缺少根级输入字段约束时，会以 `validation-decision-schema-gate-*` 阻断，避免旧 validation report 被直接拿来绕过人审输入 schema。
- algorithm admission report 与正式 gold manifest 迁移也不会只信 `review-input-contract.json` 的 hash：末端会确认 contract 声明了根级输入字段、核心 decision 字段和 forbidden alpha/profile 字段；若 contract 被同步 hash 但删掉 `humanVerdict` / `humanConfidence` / `profileVariant` 等约束，会以 `validation-review-input-contract-*-missing` 阻断。
- 末端还会扫描 contract 的 allowed list 自身：如果 `allowedDecisionFields` / `allowedDecisionInputRootFields` 反而声明允许 `alphaGain`、`profileVariant`、`renderProfile` 等字段，会以 `validation-review-input-contract-allows-alpha-profile-*` 阻断。
- algorithm admission 若声明 `productionChangeAllowed = true`，还必须在 `productionChangeGate` 中同时保留 `human-confirmed-gold-manifest` 与已接受生产决策标记（例如 `accepted-alpha-profile-decision`）；只写任意非空 gate 或 manual override 会以 `algorithm-admission-*-gate-missing` 阻断。
- admission artifact 的 `algorithmAdmissionIntegrity` 会结构化写出 `requiredProductionChangeGateMarkers`、`approvedProductionChangeGateMarkers` 与当前 gate 命中状态，verifier 直接检查这些字段，避免生产准入规则只停留在源码隐含逻辑里。
- goal audit 的 `algorithm-admission-human-gated` 要求上述 production gate contract 字段存在且语义一致；旧版或手工删减过的 admission report 会降级为 `missing-evidence`，不能证明 objective 级准入闭环成立。
- `visible-residual:loop` 会在 `.artifacts/visible-residual-crops/latest/loop-summary.json` 持久化最终 goal 仪表盘：包括 `readyForGoldMigration`、`unconfirmedCount`、`productionProfileAllowed`、`productionGateContractReady`、`productionHitCount`、`productionArtifactHitCount`、`packageScriptGateReady`、`visibleResidualPackageScriptCount`、`forbiddenVisibleResidualPackageScriptCount`、`unclassifiedVisibleResidualPackageScriptCount`、`goldManifestWriteAllowed`、`goldManifestExists`、`goalAuditStatus` 与 blockers；同时暴露 `inputHashes`，绑定 source/render summary、review manifest、validation report、review cluster、human review pack summary、review worksheet、review table、cluster worksheet、review progress、review checkpoint、focused review batch、review handoff、human review README、review input contract、两个人审输入、`package.json`、admission report 和 goal audit report 的当前 hash；同时暴露 `completionAudit`，从 `goal-audit-report.json` 汇总 `goalAchieved`、requirement counts、每个 requirement 的 `status` / blockers、`unsatisfiedRequirementIds` 与 `humanReviewBlocked`，确保续跑时能直接看到 `formal-gold-migration` 仍被人工审阅阻塞，而 `no-alpha-profile-production-before-human-confirmation` 仍为 satisfied；同时暴露 `humanReviewGuidance`，指向当前 `summary.json`、`review-worksheet.md`、`review-table.csv`、`cluster-review-worksheet.md`、`review-progress-report.json`、`review-checkpoint.json`、`review-focused-batch.json`、`review-handoff.md`、human review README、两个待填写人审 JSON、`reviewBatchCount` / `reviewBatchTotal` / `remainingClusterCount`、`goldCandidateUnconfirmedCount` / `goldCandidateReviewBatchCount` / `goldCandidateReviewBatchTotal`、top `nextReviewCluster`、下一批首个 `decisionJsonPath` 与下一条 gold candidate confirmation；还会写出机器可读的 `nextActions` / `blockedActions`，明确当前必须先完成普通 visible residual 批次、gold candidate confirmation 和人审校验，且每条审阅动作直接携带首个 `file`、`firstCropPath`、cluster `sheetPath` 与整批 `decisionTargets`（每条含 `decisionInputPath` / `decisionJsonPath` / `cropPath` / `clusterId` / suggested verdict / 当前 problems），并带 `policy.requiresHumanJudgement`、`reviewCheckpointPath`、`focusedReviewBatchPath`、`writesFormalGoldManifest=false`、`writesProductionAlgorithm=false` 和 `allowsAlphaProfileProduction=false`，避免续跑时脱离视觉证据或误把审阅动作当成生产准入；blocked actions 也会记录 `gateEvidence` 与 `requiresHumanConfirmationBeforeWrite`，其中 `productionize-alpha-profile-variant` 会同步记录 production scan 和 package script gate 结果，并在 `readyForGoldMigration=false` 时阻断 `write-formal-gold-manifest` 与 `productionize-alpha-profile-variant`；loop 运行期间还会写出临时 `loop-run-state.json`，外部 `visible-residual:verify` 检测到该状态时会 fail-fast 并提示等待 loop 完成，只有 loop 内部 final verifier 使用 `--allow-active-loop-state` 放行，避免并发读取半刷新 artifacts；final verifier 也会校验该摘要、pack summary、worksheet/table、cluster worksheet、checkpoint、focused batch、handoff、README 和当前 artifacts 一致。
- human review pack 的 README 也会提示不要新增 `alphaGain` / `profileVariant` / `renderProfile` / `cleanupMode` 这类 decision 字段，避免人工审阅时误把实验策略写进确认输入。
- active loop guard 同样覆盖外部 `visible-residual:validate-human-review`、`visible-residual:cluster-report`、`visible-residual:review-worksheet`、`visible-residual:review-status`、`visible-residual:apply-focused-batch`、`visible-residual:admission-report`、`visible-residual:goal-audit` 与 `visible-residual:create-gold-manifest`：检测到 `loop-run-state.json` 时这些入口会 fail-fast 且 `skippedWrite=true`，避免 loop 正在刷新 artifacts 时读取半刷新输入、覆盖人审/聚类/准入/目标审计报告，或写出正式 `gold-manifest.json`；loop 内部 validation / cluster / worksheet / status / admission / goal audit / final verifier 通过 `--allow-active-loop-state` 放行。
- human review pack 的 README 还会写出 `Review Workflow`：提示先打开 `review-handoff.md` 查看当前 cluster sheets 和逐条 crop previews，再用 `review-focused-batch.json` 小批次填写 `humanVerdict` / `humanConfidence` / `humanNotes`，先运行 `rtk pnpm visible-residual:apply-focused-batch --dry-run` 预检，再合并回 `review-decisions.json` / `gold-candidate-confirmations.json` 并运行 validation；同时说明 `reviewBatches` / `goldCandidateReviewBatches` 是当前批次入口。
- validation report 会记录 `reviewInputContractSha256`，并校验 contract 的 manifest hash、allowed values、policy、decision set count 与 input path；若 contract stale 或与当前模板/输入不一致，会以 `review-input-contract-*` 结构错误 fail-closed。
- 生成 review pack 时，若旧版人工输入 JSON 缺少 `reviewManifestSha256`，会在保留 `humanVerdict` / `humanConfidence` / `humanNotes` 的同时补上当前 hash。
- 若人工输入 JSON 带有过期 `reviewManifestSha256` 但没有任何人工填写字段，生成入口会用当前模板重建，避免空模板阻塞后续可复现产物刷新；若已有人工填写字段，则保留旧文件并交给 validation fail-closed，避免覆盖人工判断。
- validation 会从 `review-manifest.json` 重新推导 `sourceSet` / `clusterId`；人工输入 JSON 若显式带了过期或错误的 `sourceSet` / `clusterId`，会被标记为结构错误，防止表格和 JSON 对不上时继续迁移。
- validation 会校验每条人工输入的显式 `index` 必须等于实际 `decisions[n]` 数组位置；若表格工具或手工编辑导致错位，会触发 `decision-index-mismatch` 结构错误。
- 人工输入 JSON 若显式带了过期 `reviewManifestSha256`，validation 会触发 `review-manifest-sha256-mismatch` 结构错误，防止旧审阅输入套到新 manifest 上。
- cluster worksheet 按 cluster 列出 `clusterId` / 数量 / 组图 / 首个样本 / 首个 crop，便于按组审阅。
- by-cluster sheets 为每个 cluster 生成一张纵向 crop sheet，当前 `16` 个 cluster 对应 `16` 张图。
- worksheet 可重建，不作为人工输入源；人工仍填写 `review-decisions.json` / `gold-candidate-confirmations.json`。
- worksheet / CSV 都不写 `gold-manifest.json`，不改生产算法。

正式 gold manifest 生成入口：

```powershell
rtk pnpm visible-residual:create-gold-manifest
rtk node scripts/create-visible-residual-gold-manifest.js
rtk node scripts/create-visible-residual-gold-manifest.js --manifest .artifacts/visible-residual-crops/latest/review-manifest.json
```

当前结果：

- 命令必须失败退出。
- `skippedWrite = true`
- `problems` 必须包含 `validation-report-not-ready-for-gold-migration`。
- `.artifacts/visible-residual-crops/latest/gold-manifest.json` 必须不存在。
- 只有当 `pending` 与 `gold candidate` 两套人工确认都完成后，该脚本才允许生成 artifact gold manifest。
- 该脚本只写 `.artifacts/visible-residual-crops/latest/gold-manifest.json`，不写 `src/assets/samples/gold-manifest.json`，也不改生产算法。
- 正式 gold manifest 迁移要求每个 ready decision 都带稳定 `clusterId`，并把该字段写入样本与 tags，避免人工确认后的 gold 样本丢失分组来源。
- 正式 gold manifest 迁移会读取当前 `review-manifest.json` 并计算 hash；若 validation report 中的 `reviewManifestSha256` 与当前 manifest 内容不一致，会触发 `validation-review-manifest-hash-mismatch`，防止 ready validation 套到旧 manifest 上。
- 正式 gold manifest 迁移还要求 `gold-proposal.json` 的 `inputs.reviewManifestSha256` 与当前 manifest 内容一致；否则触发 `gold-proposal-review-manifest-hash-mismatch`，防止旧 proposal 参与正式 gold 迁移。
- 正式 gold manifest 迁移会读取 `gold-proposal.json` 中记录的 alpha sweep / alpha profile / profile generalization 输入路径并重新计算 hash；若与 proposal 记录不一致，会触发 `gold-proposal-alpha-sweep-hash-mismatch` / `gold-proposal-profile-report-hash-mismatch` / `gold-proposal-profile-generalization-hash-mismatch`，防止 stale alpha/profile 观测产物参与正式 gold 迁移。
- 正式 gold manifest 迁移还会读取这些 alpha/profile 观测报告内部的 `inputs.reviewManifestSha256`，要求它们与 proposal 中的 `*ReviewManifestSha256` 以及当前 review manifest hash 一致；否则触发对应 `gold-proposal-*-review-manifest-hash-mismatch`。
- 正式 gold manifest 迁移不会只信 `readyForGoldMigration = true`；还要求 `structuralErrorCount = 0`、`unconfirmedCount = 0`、`readyDecisionCount` 与 `readyDecisions.length` 一致，并覆盖 `pendingTotal + goldCandidateTotal`。
- 正式 gold manifest 迁移要求 ready decisions 的 `file` 唯一；重复时触发 `validation-ready-decisions-duplicate-files`，防止按文件名写入 samples 时发生静默覆盖。
- 正式 gold manifest 迁移要求每个 ready decision 都能在 `gold-proposal.json` 中找到对应候选；缺失时触发 `validation-ready-decisions-missing-gold-proposal-candidate`，防止新 validation 套到旧 proposal 上。
- 正式 gold manifest 迁移要求 `gold-proposal.json` 候选 `file` 唯一；重复时触发 `gold-proposal-duplicate-candidate-files`。
- 正式 gold manifest 迁移会从当前 `review-manifest.json` 重新推导应有 proposal candidate 集合；若 proposal 数量、文件、`sourceSet` 或 `clusterId` 与 manifest 不一致，会触发 `gold-proposal-candidate-count-mismatch` / `gold-proposal-candidate-unknown-review-manifest-file` / `gold-proposal-candidate-missing-review-manifest-file` / `gold-proposal-candidate-sourceSet-mismatch` / `gold-proposal-candidate-clusterId-mismatch`。
- 当 validation 已 ready 时，正式 gold manifest 迁移要求 `gold-proposal.json` 中不存在未被 ready decisions 覆盖的候选；否则触发 `gold-proposal-candidates-without-ready-decision`。
- 正式 gold manifest 会记录 `reviewManifestPath`、`reviewManifestSha256`、`validationReportSha256`、`goldProposalSha256`，以及 alpha sweep / alpha profile / profile generalization 的输入路径和 hash，让人工确认后的 gold artifact 能直接追溯到生成时使用的 review manifest、validation report、proposal 和 alpha/profile 观测内容。

算法准入结论：

- `alphaGainSweep.decision = reject-production-wide-alpha-sweep`
  - 证据：`directAlphaGainCouldClearVisible = 0 / 3`
- `alphaProfileMidBoost124.decision = reject-production-default-profile`
  - 证据：`13` 张 `48px-large-margin` 泛化样本中 `improvedSeverity = 7`、`clearedVisible = 4`
  - 泛化不足，且部分样本 shape / texture 风险变坏。
- `productionChangeAllowed = false`

算法准入汇总报告：

```powershell
rtk pnpm visible-residual:admission-report
rtk node scripts/create-visible-residual-admission-report.js
```

输出：

- `.artifacts/visible-residual-crops/latest/algorithm-admission-report.json`
- `policy.reportOnly = true`
- `writesFormalGoldManifest = false`
- `writesProductionAlgorithm = false`
- `inputs.validationReportSha256` 与当前 `validation-report.json` 内容一致。
- `inputs.goldProposalSha256` 与当前 `gold-proposal.json` 内容一致。
- `proposalInputIntegrity.ok = true`，并记录当前 alpha sweep / alpha profile / profile generalization 的实际 hash 与这些 report 内部的 `reviewManifestSha256`；若 proposal 输入缺失、不可读、hash 不一致，或 alpha/profile report provenance 与当前 review manifest 不一致，会把 `algorithm-admission-stale-proposal-inputs` 加入 `productionProfileAdmission.blockedReasons`。
- `validationReadinessIntegrity.ok = true` 要求 validation 在 `readyForGoldMigration = true` 时同时满足 `unconfirmedCount = 0`、`structuralErrorCount = 0`、`readyDecisionCount = readyDecisions.length`，并覆盖 `pendingTotal + goldCandidateTotal`；若 validation 被手工伪造成 ready 但缺少 ready decisions，会以 `human-review-readiness-integrity-incomplete` 阻断准入。
- `proposalCandidateProvenance.ok = true` 要求 admission report 能重读 proposal 绑定的 `review-manifest.json`，并从 `groups.metricPassVisible` / `groups.visibleTopPending` 反推候选集合，确认候选数量、`file`、`sourceSet`、`clusterId` 与当前 manifest 推导结果一致；若 manifest 缺少候选 groups、数量为 0 但 proposal 有候选，或任一字段不一致，会以 `gold-proposal-candidate-*` 问题阻断准入。
- `proposalValidationCoverage.ok = true` 要求 proposal candidate count、manifest 反推 candidate count、`summary.readyForHumanConfirmation`、`summary.pendingHumanReview` 都覆盖 validation 的 `goldCandidateTotal + pendingTotal`；即使 proposal 与 manifest 内部“空得一致”，只要不能覆盖 validation 总量，也会以 `gold-proposal-candidates-do-not-cover-validation-set` 阻断准入。
- 即使 human validation、proposal 和算法 admission 都已满足，`productionProfileAdmission.allowed` 仍要求正式 `.artifacts/visible-residual-crops/latest/gold-manifest.json` 已经生成且完整性可验证；若缺失，会以 `formal-gold-manifest-missing` 阻断 production review；若存在但 validation / review manifest / proposal / alpha/profile hash、policy、sample set 或 ready decision 对不齐，会以 `formal-gold-manifest-integrity-incomplete` 阻断。
- 当前 `humanGate.readyForGoldMigration = false`
- 当前 `productionProfileAdmission.allowed = false`
- 当前阻断原因：
  - `human-review-not-ready-for-gold-migration`
  - `human-review-unconfirmed-decisions`
  - `algorithm-admission-production-change-blocked`

闭环验证：

```powershell
rtk pnpm visible-residual:verify
rtk node scripts/verify-visible-residual-loop.js
```

一键重建闭环：

```powershell
rtk pnpm visible-residual:loop
rtk node scripts/run-visible-residual-loop.js
```

默认输入：

- `.artifacts/sample-files-gemini-watermark-residual-visibility-20260610/summary.json`

默认输出：

- `.artifacts/visible-residual-crops/latest`

runner 顺序：

1. 生成 visible residual crop sheets。
2. 生成 review manifest。
3. 生成 review queue sheets。
4. 运行 alphaGain sweep 探针。
5. 运行 alpha profile 探针。
6. 生成 profile 对比图。
7. 运行 `48px-large-margin` profile 泛化检查。
8. 生成 `48px-large-margin` 泛化图。
9. 生成 gold proposal。
10. 生成 human review pack。
11. 验证 human review decisions。
12. 生成 review cluster report。
13. 生成 algorithm admission report。
14. 生成 human review worksheet / CSV table。
15. 输出只读 human review progress，包含 `nextReviewClusters`。
16. 生成 goal audit report，汇总目标级完成状态与 blocker。
17. 运行 loop verifier。

注意：runner 只重建观测 / proposal / validation / audit / verifier 产物；review progress 只写 stdout；不写正式 gold，不改生产算法。

当前结果：

- `ok = true`
- `totalChecks = 119`
- `failedChecks = 0`

验证覆盖：

- P0 sheet 产物完整。
- review manifest 数量与队列完整；`review-manifest.json.inputs.renderSummarySha256` 必须等于当前 `.artifacts/visible-residual-crops/latest/summary.json` 内容 hash，避免旧 manifest 套到新 render summary 上。
- review queue summary 必须记录当前 `review-manifest.json` 的 `reviewManifestSha256`，避免 stale queue / worksheet 从旧 manifest 派生。
- alpha sweep / alpha profile / 48px 泛化报告存在且关键数字匹配。
- gold proposal 仍是 proposal-only，未写正式 gold。
- gold proposal 的 review / alpha / profile 输入 hash 必须与当前 artifact 内容一致；alpha/profile 观测报告自身也必须声明来自当前 review manifest；正式 gold 迁移也会拒绝 stale review manifest 与 stale alpha/profile proposal hashes。
- gold proposal 的每个候选必须携带稳定 `sourceSet`、`clusterId` 和 `visibleReasons`；admission report 与正式 gold 迁移都会重读当前 review manifest 并反推候选集合，确认 candidate count、`file`、`sourceSet`、`clusterId` 完全对齐，防止同文件但不同审阅分组的错配或旧 proposal 混入。
- gold proposal 生成入口会把 `proposedGoldFields` schema 约束汇总到 `proposedGoldSchemaGate`：只允许判定、阈值和备注字段，拒绝 alpha/profile 变体字段与未知字段；若生成器自身即将写出不符合 schema 的 proposal，会以 `skippedWrite = true` fail-closed。
- algorithm admission report 的 validation / proposal 输入 hash 必须与当前 artifact 内容一致；admission report 自身也会重算 proposal 记录的 alpha/profile 输入 hash，并校验 alpha/profile report 内部的 review manifest provenance，stale proposal inputs 会阻断 production profile admission；goal audit 不会只信旧 admission report 的 gate 字段。
- algorithm admission report 还会重读 validation report 绑定的 `review-input-contract.json`，校验 contract hash、manifest hash、decision set count 与 input path；若 contract stale，会把 `human-review-stale-input-contract` 加入阻断理由。
- algorithm admission report 不会只信 `productionChangeAllowed = true`：若 alpha/profile 决策仍包含 `reject-production*`，或没有任何 `accept-production*` 决策支撑，会以 `algorithm-admission-production-decision-incomplete` 阻断 production review。
- algorithm admission report 校验正式 gold manifest 时，会扫描样本 `visibleResidual` 字段；若出现 `alphaGain`、`alpha_profile`、`profile-variant` 等 alpha/profile 变体字段，会先归一化字段名再以 `gold-manifest-alpha-profile-variant-fields-present` 阻断。
- algorithm admission report 还会对白名单外的正式 `visibleResidual` 顶层字段 fail-closed；例如把 `cleanupMode`、`renderProfile` 一类未纳入 gold schema 的字段塞进正式 manifest，会触发 `gold-manifest-unknown-visible-residual-field-present`，并在 `unknownVisibleResidualFieldPaths` 中记录具体样本字段路径，避免借“元数据”名义把 alpha/profile 或清理策略变体带进 production review。
- algorithm admission report 会把上述正式 gold schema 约束汇总到 `goldSchemaGate`：包括允许的正式 `visibleResidual` 字段、禁止的 alpha/profile 归一化字段、fail-closed 问题码和当前命中的字段路径；goal audit 要求该 gate 已启用且为 `ok = true`，否则 `algorithm-admission-human-gated` 不算完整。
- 正式 gold manifest 迁移会要求 gold proposal 仍保持 proposal-only/read-only policy：`writesFormalGoldManifest = false`、`writesProductionAlgorithm = false`、`requiresHumanConfirmationBeforeGoldMigration = true`；若 proposal 被改成可写 policy，会以 `gold-proposal-policy-*` 问题 fail-closed。
- 正式 gold manifest 迁移还要求 proposal 自带 `proposedGoldSchemaGate` 且 `ok = true`；缺失或非 ready 时触发 `gold-proposal-schema-gate-missing` / `gold-proposal-schema-gate-not-ready`，防止旧 proposal 或手工删 gate 的 proposal 进入正式迁移。
- 正式 gold manifest 迁移还会拒绝 proposal candidate 的 `proposedGoldFields` 携带 alpha/profile 变体字段，字段名同样会归一化以覆盖 snake_case / kebab-case / camelCase，避免 `gold-manifest.json` 在 `containsAlphaProfileVariants = false` 的 policy 下实际写入变体。
- 正式 gold manifest 迁移同时对白名单外的 `proposedGoldFields` 顶层字段 fail-closed；未知字段触发 `gold-proposal-unknown-gold-field-present` 并保持 `skippedWrite = true`，失败输出的 `proposalRejectedFieldPaths.unknownGoldFieldPaths` 会指出具体候选字段，因此 proposal 阶段只能迁移判定、阈值和备注类 gold 字段。
- human review pack 覆盖全部 `27` 条 pending，且 decision template / input 都结构完整。
- human review pack 覆盖全部 `6` 条 Codex 预审 gold 候选，且 confirmation template / input 都结构完整。
- 脚本测试覆盖 human review pack 重建时保留 `review-decisions.json` / `gold-candidate-confirmations.json` 中已有人工输入。
- 脚本测试覆盖只读 review status 报告的 source/profile/blocker 汇总，以及 cluster-aware `nextReviewClusters` / `nextReviewBatch` 指引。
- 脚本测试覆盖 review cluster report 的 read-only policy、输入 hash、稳定分组键和全量记录覆盖，并覆盖 stale validation manifest hash 会在写任何 cluster artifact 前 fail-closed。
- verifier 覆盖 review status 的 cluster 输入与 `nextReviewClusters` / `nextReviewBatch` / `incompleteByCluster` 输出入口。
- verifier 会实际执行只读 review status 脚本并解析 stdout，确认其 input hashes、`summary`、`clusterSummary`、`incompleteByCluster`、top `nextReviewClusters` 与当前 validation、manifest、cluster artifact 一致，并确认 `nextReviewBatch` 与第一条 `nextReviewItems` 都对齐 top cluster。
- goal audit 的 `clustered-review-queue` 会校验 `review-clusters.json` 的 manifest / validation 输入 hash，并确认 `cluster-review-worksheet.md` 记录当前 manifest / validation / cluster report hash，避免 stale cluster report 或 stale cluster worksheet 被当成当前分组依据。
- goal audit 的 `reproducible-review-artifacts` 会校验普通 `review-worksheet.md` 与 `review-table.csv` 绑定当前 validation / manifest / cluster report hash，并要求 human review pack summary 的 `artifactHashes` 与当前 README、模板、输入 JSON、contract 和 sheet 文件内容一致，避免 stale review worksheet/table 或 stale review pack summary 被当成当前人工审阅入口。
- goal audit 的 `proposal-only-gold-candidates` 会校验 `gold-proposal.json` 的 review manifest / alpha sweep / alpha profile / profile generalization 输入 hash，并要求 admission report 的 `proposalCandidateProvenance` 与 `proposalValidationCoverage` 都通过，避免 stale proposal、错配候选或空候选集合被当成当前 gold 候选依据。
- goal audit 的 `next-review-guidance-is-reproducible` 也会校验已落盘 `review-progress-report.json` 的 input hashes、top cluster、`reviewBatchCount` / `reviewBatchTotal`、`goldCandidateReviewBatchCount` / `goldCandidateReviewBatchTotal`、`nextGoldCandidateReviewCluster` 和首个 gold candidate `decisionJsonPath`；同时记录并校验 `review-focused-batch.json` 的 `focusedReviewBatchSha256`、`focusedBatchReady`、focused batch 决策数量、visible/gold candidate 分批数量、与 progress report 的批次匹配布尔值，以及 `writesFormalGoldManifest=false` / `writesProductionAlgorithm=false` / `allowsAlphaProfileProduction=false` 策略；还会校验 `review-handoff.md` 的 `reviewHandoffSha256`、当前 validation / manifest / cluster hash、focused batch 路径、dry-run / apply / validate 命令、可编辑字段、合法 verdict/confidence、必填 notes 规则、当前批次 cluster sheet 图片预览、所有 focused decision 的 crop preview 和 no-gold / no-production 策略；并记录 `humanReviewReadmeSha256` / `humanReviewReadmeReady`，要求 README 指向 handoff、focused batch、可编辑字段、dry-run 和未确认前不生成 gold / 不写 alpha/profile 字段，避免 stale progress report、缺失 gold 候选批次或脱离目标审计的 focused batch / handoff / README 被当成当前人工审阅指引。
- verifier 会额外校验 `review-checkpoint.json` 与当前 progress / validation / manifest / cluster hashes 一致，且 checkpoint 中的 visible residual batch、gold candidate batch、视觉 crop/sheet 路径和 blocked actions 都保持当前态。
- verifier 会校验 `review-focused-batch.json` 只包含当前批次的人工字段，绑定当前 hashes，并显式暴露 dry-run、合法 verdict/confidence、必填 notes 规则，且 `visible-residual:apply-focused-batch` 入口存在并保持 fail-closed / no-gold / no-production 策略。
- verifier 会校验 `review-handoff.md` 包含当前 validation / manifest / cluster hash、focused batch 路径、下一批 `decisionJsonPath`、apply / validate 命令、当前批次 cluster sheet 图片、所有 focused decision 的 crop preview，以及 no-gold / no-production / no-alpha-profile-production 策略；loop summary 也会记录 `reviewHandoffSha256` / `reviewHandoffPath` 和 `humanReviewReadmeSha256` / `humanReviewReadmePath`。
- goal audit report 汇总 objective 级要求：可复现审阅、分组队列、proposal-only gold 候选、human-gated admission、下一步审阅指引、review manifest provenance、未人工确认前不生产化。
- `package.json` 的 `visible-residual:*` 入口现在也纳入 no-production 证据：goal audit 会记录 allowlist、未分类入口、生产化关键词命中与 forbidden 脚本数量；verifier 会用当前 `package.json` 重新计算并对比报告，防止新增 `productionize` / `promote` / `apply-alpha-profile` / `mid-boost-1.24` 一类入口绕过人工确认。
- goal audit report 在 `readyForGoldMigration = true` 后不会只接受 `gold-manifest.json` 存在；还会校验正式 gold manifest 的 policy、validation/proposal 输入 hash、样本数量、ready decisions 覆盖、`clusterId` 一致性以及无额外样本。
- verifier 覆盖 goal audit 当前状态为 `human-gated-incomplete`，并确认 `formal-gold-migration` 被 `human-review-not-complete` 阻断。
- verifier 覆盖 goal audit 中 `reproducible-review-artifacts` 的 review worksheet / CSV provenance 必须与当前 artifacts 对齐。
- verifier 覆盖 review worksheet / CSV 生成入口会在 stale cluster report 时拒绝写 artifact。
- verifier 覆盖 review progress 生成入口会在 stale cluster report 时拒绝写 artifact。
- verifier 覆盖 review cluster report 生成入口会在 validation report 缺失或不匹配当前 review manifest hash 时拒绝写 artifact。
- verifier 覆盖 alpha/profile observation reports 的 `inputs.reviewManifestSha256` 必须与当前 `review-manifest.json` 内容 hash 对齐。
- verifier 覆盖 goal audit 中 `clustered-review-queue` 的 cluster worksheet provenance 必须与当前 `review-clusters.json` 内容 hash 对齐。
- verifier 覆盖 goal audit 中 `proposal-only-gold-candidates` 的 proposal input hashes 必须与当前 alpha / profile artifacts 内容一致，且 goal audit 必须记录 `proposedGoldSchemaGate.ok = true`、`admissionProposalCandidateProvenanceReady = true` 与 `admissionProposalValidationCoverageReady = true`；gold proposal 生成入口会拒绝 stale alpha/profile report provenance。
- verifier 覆盖 algorithm admission 只有在正式 gold manifest 存在且完整性通过后才可能进入 production review；缺失时必须以 `formal-gold-manifest-missing` 阻断，validation / review manifest / proposal / alpha/profile hash、policy、sample set 或 ready decision 不一致时必须以 `formal-gold-manifest-integrity-incomplete` 阻断。
- verifier 覆盖 algorithm admission 的 `productionChangeAllowed` 必须与 alpha/profile 决策一致；手工把布尔值改成 true 但仍无 `accept-production*` 决策，或仍有 `reject-production*` 决策时，必须阻断。
- verifier 覆盖 admission 与正式 gold manifest 迁移都会拒绝 alpha/profile variant fields，并要求字段名归一化逻辑存在，不允许这些字段通过 proposal 或 formal gold manifest 进入 production review。
- verifier 覆盖 admission 与正式 gold manifest 迁移都必须存在 gold schema allowlist 和未知字段 fail-closed 问题码，避免 proposal 或 formal gold manifest 通过新增字段绕过“未人工确认前不生产化”的约束。
- verifier 覆盖每个 cluster 都有一张 visual sheet，且 sheet 行数等于 cluster 样本数。
- verifier 覆盖 review manifest、decision template/input、cluster report、review progress report 引用的 visual crop / sheet 路径都真实存在；若路径断链，会在失败详情里列出 `source` / `file` / `pathKind` / `resolvedPath` 示例。
- verifier 覆盖 review manifest 必须绑定当前 render summary hash，review queue summary 必须绑定当前 review manifest hash。
- verifier 覆盖 `review-input-contract.json` 必须与当前 review manifest、decision templates、validation report 和实际 decision input path/count 对齐；validation 会拒绝 stale input contract。
- verifier 覆盖 algorithm admission / formal gold manifest 迁移都会重新核验 validation 绑定的 `review-input-contract.json`；即使 validation report 被手工拼成 ready，stale contract hash/count/path 也会阻断 admission 或正式 gold 写入。
- verifier 覆盖 human review pack 的 `README.md` 必须是可读中文，并说明可编辑字段、`review-handoff.md` 视觉入口、focused batch、dry-run、contract gate 和未确认前不生成 `gold-manifest.json`；常见 mojibake 片段会触发失败。
- verifier 覆盖 gold proposal 候选必须完整保留 `sourceSet`、`clusterId`、`visibleReasons`，admission report 必须报告 proposal candidate provenance ready，且正式 gold manifest 迁移脚本必须拒绝 proposal/ready decision 的 cluster 或 sourceSet mismatch。
- verifier 覆盖 decision template、validation report、cluster worksheet、worksheet / CSV 都暴露稳定 `clusterId`；cluster worksheet 还必须带当前 manifest / validation / cluster report 输入 hash。validation / progress / worksheet / CSV 都带当前输入 hash 与 JSON decision locator；CSV 第一行还必须与当前 top cluster 对齐，worksheet 的 `Next Review Batch` 也必须指向同一 top cluster / sheet / decision locator，`Review Batches` 还必须覆盖当前所有未完成 cluster 与未确认总数，`Gold Candidate Review Batches` 必须覆盖当前所有 gold candidate 未确认项，让人工审阅和填写 JSON 可以按同一分组键与同一 `decisions[n]` 对齐。
- verifier 覆盖 human review pack summary、validation report、templates 和实际人工输入 JSON 的 `reviewManifestSha256` 必须等于当前 `review-manifest.json` 内容 hash；同时重算 summary 中 `artifactHashes` 指向的 README、模板、输入 JSON、contract、总览 sheet、gold candidate sheet 和 profile sheet 内容 hash，任何 stale 或手工替换过的审阅材料都会失败。
- verifier 覆盖 human review validation 会拒绝过期或错误的 `sourceSet` / `clusterId` / `index`。
- verifier 覆盖正式 gold manifest 迁移必须保留稳定 `clusterId`，缺失时 fail-closed。
- verifier 覆盖正式 gold manifest 迁移必须拒绝内部计数不自洽的 validation report。
- verifier 覆盖正式 gold manifest 迁移必须拒绝重复 ready decision file。
- verifier 覆盖正式 gold manifest 迁移必须确认 ready decisions 被 proposal 候选覆盖。
- verifier 覆盖正式 gold manifest 迁移必须拒绝重复 proposal candidate file 和未被 ready decisions 覆盖的 proposal candidate。
- verifier 覆盖正式 gold manifest 迁移会保留 review manifest path、review manifest / validation / proposal / alpha-profile 输入 hash 与 alpha/profile report 的 review manifest provenance，并拒绝 stale ready validation manifest hash、stale gold proposal manifest hash、stale alpha/profile proposal hash、stale alpha/profile provenance，以及被篡改成可写的 proposal policy。
- 脚本测试覆盖 gold proposal 会记录 alpha/profile report 的 review manifest provenance，并在 stale alpha/profile report provenance 时 fail-closed。
- 脚本测试覆盖正式 gold manifest 迁移入口会拒绝 stale alpha sweep / alpha profile / profile generalization proposal hashes，并拒绝不再保持 proposal-only/read-only 的 gold proposal policy。
- 脚本测试覆盖 Markdown review worksheet 的待审项表格、CSV review table 和 policy 提示。
- 脚本测试覆盖 algorithm admission report 的 report-only policy、human gate 镜像、production profile 阻断，以及 stale alpha/profile proposal inputs、stale alpha/profile provenance、伪 ready validation 缺少 ready decisions、正式 gold manifest 缺失、stale review manifest hash 或其它完整性不通过、proposal candidate provenance mismatch、缺失 review manifest candidate groups，或 proposal/manifest 内部一致但不能覆盖 validation 总量时会阻断准入；同时覆盖只有正式 gold manifest hash / policy / sample set / ready decision 全部对齐后才允许进入 production review。
- 脚本测试覆盖 algorithm admission report 会拒绝 `productionChangeAllowed=true` 但 alpha/profile 决策仍为 reject 或缺少 accept 证据的 proposal，避免单独篡改布尔开关绕过算法准入。
- 脚本测试覆盖 algorithm admission report 会拒绝 formal gold manifest 中的 alpha/profile variant fields；正式 gold manifest 迁移入口也会在 proposal candidate 阶段拒绝这些字段并保持 `skippedWrite=true`。
- 脚本测试覆盖 formal gold manifest 中的未知 `visibleResidual` 字段会阻断 admission，proposal candidate 中的未知 `proposedGoldFields` 字段会阻断正式 gold 迁移并保持 `skippedWrite=true`。
- verifier 覆盖一键 loop 的关键顺序：validation 之后生成 cluster report，cluster report 之后刷新 review worksheet / review progress，review worksheet / review progress / admission report 之后生成 goal audit，最后才运行 verifier。
- verifier 覆盖一键 loop 会在最终 verifier 前输出只读 human review progress / `nextReviewClusters` 指引。
- human review validation 明确阻止 gold 迁移，直到全部 pending 和 gold candidate 都被人工确认。
- fail-closed gold manifest 生成入口存在；当前验证未 ready 时不会写 `.artifacts/visible-residual-crops/latest/gold-manifest.json`。
- 算法准入明确阻止生产变更。
- `mid-boost` / `power` / `blur-mix` 等实验 profile 没有进入 `src/core`、`src/sdk`、`src/runtime`、`src/shared`、`src/userscript` 或当前活跃构建/调试发布面 `dist`。
- goal audit 的 no-production evidence 会记录 `productionScanDirs` 和 `productionScanFilePattern`；当前要求扫描范围包含 `dist`，且覆盖 JS / TS / HTML / JSON 发布产物，避免只凭空命中列表判断准入范围。
- `visible-residual` 审阅产物、`gold-proposal.json`、`review-manifest.json`、`review-clusters.json`、`human-review`、`algorithm-admission-report.json`、`goal-audit-report.json` 等 artifact 侧引用没有进入生产源码。

当前闭环状态：

- 可复现审阅：已建立。
- 分组队列：已建立。
- gold 候选：已生成 proposal，但需要人工确认。
- 算法准入：已建立，并明确拒绝当前 alphaGain sweep / `mid-boost-1.24` 默认生产化。
- 目标尚未完成：当前 filtered review manifest 中 `visibleTopPending = 24`，`metricPassVisible = 6` gold 候选仍未人工审阅，正式 `gold-manifest.json` 未迁移。
- 2026-06-11 复查 `2026-06-09/2064204960823775232-source.png`：旧审阅图显示 `48/96/96` 小框只覆盖星标中心，属于候选几何错选。当前处理应保留强 evidence 的 canonical `96/64/64` 标准锚点，生成的 visible residual crop 使用当前 processing metadata 重绘 ROI；若当前结果已不再 `visible=true`，不再混入 human review queue。
- 2026-06-11 继续复查 `2026-06-09/2064229579895083008-source.png`：旧结果同样被弱 `48/96/96` 小框抢占，实际 `96/64/64` 全框 evidence 更强。当前处理保留 `96/64/64 + alphaGain=0.85`，`residualVisibility.visible=false`，因此该样本从 `48px-large-margin` pending 队列移除。
- 新增 `pnpm visible-residual:geometry-audit`：从当前 `review-manifest.json` 的 `visibleTopPending` 生成 geometry audit JSON、Markdown 和 overlay sheet，当前输出位于 `.artifacts/visible-residual-crops/latest/geometry-audit/`。该脚本只写诊断 artifact，不写正式 gold，不改 alpha/profile 生产策略。
- 2026-06-11 最新 geometry audit 复核：`highCount = 0`，`trueGeometryMismatchCandidateCount = 0`，`localGeometrySafetyTradeoffCount = 7`。原先 7 条 high hints 被重新分类为 `local-profile-safety-tradeoff`：catalog `48/32/32` 或 `48/96/96` 的原始 evidence 更强，但安全恢复后的 residual cost 明显高于当前 45/46px 本地候选，低 residual 往往需要进入 near-black / clipping 风险区。因此这些样本当前不应继续用“放宽 geometry 选择”修复，下一步应调查实际 alpha edge profile / antialiasing 模型差异。
- 新增窄口径 alpha/profile 调研脚本 `scripts/probe-geometry-safety-tradeoff-alpha-profile.js` 与 sheet 渲染脚本 `scripts/render-geometry-safety-tradeoff-alpha-profile-sheet.js`，输入为最新 geometry audit 中的 `local-profile-safety-tradeoff` 样本，输出 `.artifacts/visible-residual-crops/latest/alpha-profile/geometry-safety-tradeoff-alpha-profile.json` 与 `.png`。脚本 policy 明确 `diagnosticOnly=true`、不写正式 gold、不写生产算法、不允许 alpha profile production。
- 2026-06-11 调研结果：7 条样本中 `catalogBeatsSelected = 3`、`catalogClearedSafely = 2`、`selectedClearedSafely = 0`。两个可安全 clear 的样本都落在 `48/96/96` 大边距 catalog，最佳组合均为 `power-0.88 + alphaGain=0.55`；`48/32/32` 小边距组仅 1 条明显改善，其余仍有边缘/形状残留。因此下一步候选应先聚焦 `48/96/96` 大边距 profile，而不是生产化全局 48px alpha profile 或继续放宽 45/46px local geometry。
- 新增固定候选准入矩阵 `scripts/gate-48-large-margin-power-profile-candidate.js`，强制评估 `48/96/96 + power-0.88 + alphaGain=0.55` 在当前 `metricPassVisible + visibleTopPending` 的 30 条记录上的目标/非目标表现，输出 `.artifacts/visible-residual-crops/latest/alpha-profile/large-margin-48-power088-gate.json`。配套 `scripts/render-48-large-margin-power-profile-gate-sheet.js` 输出 `.artifacts/visible-residual-crops/latest/alpha-profile/large-margin-48-power088-gate.png`，用于人工查看 applicable、cleared、unsafe 和非目标命中。两个脚本同样是 diagnostic-only，不写 gold，不写生产。
- 2026-06-11 准入矩阵结论：固定候选必须继续 `reject-production-candidate`。在现有 `48px-large-margin` profileLine 目标组中 `total = 10`、`applicable = 10`，但 `clearedVisible = 0`、`unsafe = 3`，没有达到 `requiredTargetClearRatio = 0.7`；在非目标组中仍有 `applicable = 8`、`applicableImprovedSeverity = 3`、`clearedVisible = 2`，且这两条分别是当前标记为 `45px-other` / `46px-other`、但在 `48/96/96` 位置具有极强原始证据的样本。Sheet 把这两条排在前两行，能直观看到它们确实属于 `48/96/96` 几何信号。这说明候选边界不是“只适用于当前 `48px-large-margin` profileLine”，而是更接近“需要 evidence-gated 的 `48/96/96` 几何族”；在人工审阅和更强反例验证前，不能据此生产化 profile，也不能把 45/46 local geometry 放宽为默认路径。
- 新增 geometry-family sweep `scripts/probe-48-96-96-geometry-family-alpha-profile.js` 与配套 sheet `scripts/render-48-96-96-geometry-family-alpha-profile-sheet.js`，从同一份 `review-manifest.json` 强制使用 `48/96/96` 位置，把 `spatial >= 0.3` 或 `gradient >= 0.12` 作为 family applicable 证据门，再对 `base` / `power` / `mid-boost` / `blur-mix` / `sharpen` 等 profile 与 alphaGain 网格做只读诊断。输出为 `.artifacts/visible-residual-crops/latest/alpha-profile/geometry-family-48-96-96-alpha-profile.json`、`.artifacts/visible-residual-crops/latest/alpha-profile/geometry-family-48-96-96-alpha-profile.png` 和 sheet JSON；policy 继续固定 `diagnosticOnly=true`、不写正式 gold、不写生产算法、不允许 alpha/profile production。
- 2026-06-11 geometry-family sweep 结论：30 条记录里 forced `48/96/96` evidence applicable = 18，profileLine 分布为 `48px-large-margin = 10`、`45px-other = 4`、`192px-scaled-anchor = 1`、`36px-v2-small = 1`、`46px-other = 1`、`96px-standard = 1`。参考候选 `power-0.88 + alphaGain=0.55` 在 family 内 `clearedVisible = 2/18`、`unsafe = 6`、`visibleAfter = 15`、平均 severity delta 为 `-7.5571`，清掉的 2 条仍是 `45px-other` 与 `46px-other`；family 外 `clearedVisible = 0`，说明这个候选很窄，但不是 `48px-large-margin` 标签专属。
- 2026-06-11 网格排序没有找到可作为下一阶段生产候选的安全变体：`bestHumanReviewOnly = null`，也就是不存在“family 内至少清掉 1 条、family unsafe = 0、family 外 cleared = 0”的组合。排序靠前的 `mid-boost-1.24 + 0.85`、`mid-boost-1.16 + 0.85` 等虽然也能清掉 2 条，但 `unsafe = 8`，且主要清掉当前 `48px-large-margin` 的另外两条，不能替代参考候选。当前可采纳结论是：`48/96/96` 几何族确实存在 alpha edge/profile 差异信号，但现有 profile/gain 网格只足够支持“继续调查 antialiasing / render model”，不支持写 gold、不支持生产化、不支持放宽 45/46px local geometry。
- 新增 reference boundary 扫描 `scripts/probe-48-96-96-reference-boundary.js` 与散点图 `scripts/render-48-96-96-reference-boundary-scatter.js`，输入为 geometry-family sweep 报告，只围绕参考候选 `power-0.88 + alphaGain=0.55` 扫描 spatial / gradient 的单阈值、AND、OR、min/max evidence 规则。输出 `.artifacts/visible-residual-crops/latest/alpha-profile/geometry-family-48-96-96-reference-boundary.json`、`.artifacts/visible-residual-crops/latest/alpha-profile/geometry-family-48-96-96-reference-boundary.png` 和 sheet JSON；继续保持 diagnostic-only / no-gold / no-production policy。
- 2026-06-11 boundary 结论：在 18 条 forced `48/96/96` applicable 记录中，参考候选 clear 总数为 2，但 `cleanIsolationRuleCount = 0`。最佳“保留全部 clear”的证据门是 `gradient >= 0.93`，会选中 3 条：2 条 clear（`45px-other` / `46px-other`）加 1 条 `45px-other` 的 `visible-after` 反例（`spatial = 0.9998`、`gradient = 0.9998`）。因此即便把 evidence 阈值拉到接近满分，也不能把 `power-0.88 + 0.55` 的成功样本和失败样本干净分开；该候选不能通过 evidence threshold 成为准入策略，只能作为 alpha edge/profile 差异的诊断线索。
- 2026-06-11 verifier 已纳入上述 goal-specific artifact：`scripts/verify-visible-residual-loop.js` 现在要求 geometry-family sweep / boundary scan 的 JSON、PNG、sheet JSON 均存在，并校验 policy 仍是 diagnostic-only / no-gold / no-production、输入 manifest hash 与当前 `review-manifest.json` 对齐、family 结论保持 `reference-candidate-rejected-unsafe-within-family`、boundary 结论保持 `reference-candidate-has-no-clean-evidence-boundary`。当前 `rtk pnpm visible-residual:verify` 结果为 `ok = true`、`totalChecks = 131`、`failedChecks = 0`。
- 新增目标级完成审计 `scripts/create-48-96-96-alpha-profile-goal-audit.js`，输出 `.artifacts/visible-residual-crops/latest/alpha-profile/geometry-family-48-96-96-goal-audit.json`。该审计只评估本轮窄口径 objective，不把 broader visible residual human review / formal gold migration 作为完成前置条件；当前 `goalAchieved = true`、`conclusion = achieved-as-diagnostic-rejection`、`unsatisfiedRequirementIds = []`，最终结论为 `48/96/96 + power-0.88 + alphaGain=0.55` 已收敛为 diagnostic-only rejection：不是 `48px-large-margin` 标签专属，不能生产化，后续只允许继续 alpha edge / antialiasing / render-model 诊断。

## 2026-06-11 追加：发版准入总表

新增顶层发版准入报告：

- `scripts/create-allenk-v2-comparison-report.js`
- `scripts/create-release-readiness-report.js`
- `pnpm compare:allenk-v2`
- `pnpm release:readiness`
- `pnpm release:quality-gate`
- 输出：
  - `.artifacts/allenk-v2-comparison/latest-report.json`
  - `.artifacts/allenk-v2-comparison/latest-report.md`
  - `.artifacts/release-readiness/latest-report.json`
  - `.artifacts/release-readiness/latest-report.md`

该报告只汇总当前已有 evidence，不重跑重型导出，不启动本地服务。当前纳入的 release lanes：

- release artifact：校验 `package.json`、`release/latest-extension.json`、extension zip 和 sha256。
- release claim scope：扫描 `README.md`、`README_zh.md`、`CHANGELOG.md`、`CHANGELOG_zh.md`、`RELEASE.md`、`RELEASE_zh.md`、`package.json`、`release/latest-extension.json`，阻断公开文案中未过 gate 的视频 parity / 默认视频后端 claim。
- userscript artifact：校验 `dist/userscript/gemini-watermark-remover.user.js` 的 `@version`、`@downloadURL`、`@updateURL` 和关键 request-layer runtime markers。
- image visible residual / alpha profile admission：读取 `loop-summary.json`、`goal-audit-report.json`、`algorithm-admission-report.json`。
- image V2 36px profile：读取 `sample-files-gemini-watermark-v2-36-cleanup-20260610/summary.json`。
- video V2 denoise parity：读取 `video-denoise-candidate-gate/latest-report.json`。
- video alpha shape/profile candidates：汇总 `video-alpha-shape-candidate-gate/*/latest-report.json`。
- allenk reference：校验 `.artifacts/external-repos/GeminiWatermarkTool` 的本地 HEAD 与 GitHub remote HEAD。
- allenk V2 comparison：读取 `.artifacts/allenk-v2-comparison/latest-report.json`，把图片 V2 36、视频 crop benchmark、denoise gate、alpha-shape gate 与 allenk HEAD 汇成独立差距账本；readiness 还会校验 comparison artifact 不早于这些源 artifact、重算 comparison 记录的 source artifact sha256，并确认 comparison 记录的 allenk local / remote HEAD 与当前 allenk reference lane 一致，避免 gate 更新、内容替换或 allenk 参考变更后继续使用 stale comparison。

当前真实运行结果：

- `recommendation = rc-current-image-defaults-with-scoped-claims`
- `currentImageCapabilityReady = true`
- `canReleaseCurrentImageDefaults = true`
- `canClaimVideoV2Parity = false`
- blocked claims：
  - `video-v2-allenk-parity`
  - `new-visible-residual-alpha-profile-productionization`
  - `new-video-denoise-default`
  - `new-video-alpha-shape-default`

当前 lane 结论：

- Release artifact：`ready`
  - 当前存在 dirty release build inputs，包括 `build.js`、`package.json`、`pnpm-lock.yaml`、`src/core/*`、`src/assets/alpha/*`、`src/video*` 等。
  - 已重新运行 `pnpm build` 与 `pnpm package:extension`，并通过 `pnpm release:quality-gate` 串联刷新 allenk V2 comparison 与 readiness；当前 zip 时间为 `2026-06-11T06:58:54.709Z`，最新 dirty build input 时间为 `2026-06-11T06:53:06.708Z`，`dirtyBuildInputsNewerThanZip = false`。
  - zip integrity 已通过：`actualSize = metadataSize = 759470`，`actualSha256 = metadataSha256 = sha256 file hash = 032087b60b07481cdf9f55b3944ed59602bb217289191108b4886a4525e943d5`，`.sha256.txt` 中的文件名也匹配当前 zip。
  - 因此现有 zip 可作为 scoped RC 待发包；若后续继续修改构建输入，需要重新 `pnpm build` / `pnpm package:extension` 并刷新 readiness。
- Release claim scope：`clean`
  - 已扫描 8 个公开发版文件：`README.md`、`README_zh.md`、`CHANGELOG.md`、`CHANGELOG_zh.md`、`RELEASE.md`、`RELEASE_zh.md`、`package.json`、`release/latest-extension.json`。
  - `violationCount = 0`，没有公开宣称 `video-v2-allenk-parity`、`new-video-denoise-default` 或 `new-video-alpha-shape-default`。
- Release version docs：`ready`
  - 中英文 release checklist 已要求发布前运行 `pnpm release:quality-gate`。
  - `release:quality-gate` 固定执行顺序：先 `pnpm compare:allenk-v2`，再 `pnpm release:readiness`。
  - readiness 会校验 `releaseEnMentionsAllenkV2Comparison`、`releaseZhMentionsAllenkV2Comparison`、`releaseEnMentionsReadinessGate`、`releaseZhMentionsReadinessGate`、`releaseEnMentionsQualityGate`、`releaseZhMentionsQualityGate`，避免发版流程绕过 allenk V2 comparison 与总准入报告。
- Release script integrity：`ready`
  - readiness 会直接校验 `package.json` 中 `compare:allenk-v2`、`release:readiness`、`release:quality-gate` 三个脚本的精确命令。
  - `release:quality-gate` 必须保持为 `pnpm compare:allenk-v2 && pnpm release:readiness`；如果顺序被改成先 readiness 后 comparison，会触发 `release-quality-gate-script-missing` 阻断。
- Userscript artifact：`ready`
  - `dist/userscript/gemini-watermark-remover.user.js` 存在，`@version = 1.0.20`，与 `package.json` 一致。
  - `@downloadURL` / `@updateURL` 均指向 GitHub latest userscript asset。
  - 必需 marker 均存在：`getActionContextFromIntentGate(intentGate = null, candidate = null)`、`downloadStickyUntil`、`DEFAULT_DOWNLOAD_STICKY_WINDOW_MS`。
- Image visible residual / alpha profile admission：`safe-to-release-current-defaults`
  - 当前默认图片路径可继续发版。
  - 但 `readyForGoldMigration = false`、`unconfirmedCount = 30`，不能把 visible residual alpha/profile 候选升为生产默认。
- Image V2 36px profile：`guarded-release`
  - 189 张样本中 `v2Selected = 1`、`v2Cleanup = 1`。
  - 只按 evidence-gated 小水印 profile 发布，不宣传为全量 V2 覆盖；中心灰影仍归入后续 render/composite 模型研究。
- Video V2 denoise parity：`experiment-only`
  - `video-denoise` gate 中 5 个候选没有 promoted default；旧 Canvas denoise 候选被拒绝。
  - 不能宣称接近 allenk v0.6.2 的视频 denoise 质量。
- Video alpha shape/profile candidates：`experiment-only`
  - `promotedCount = 0`，存在 video regression 或缺少 video benchmark。
  - fit 层改善不能替代视频级准入。
- allenk reference：`current`
  - 本地与 remote HEAD 均为 `632348868da0653d5c1e99680d2c448f4d8505eb`。
- allenk V2 comparison：`current-gap-known`
  - `.artifacts/allenk-v2-comparison/latest-report.json` 已把 allenk HEAD、图片 V2 36 cleanup、视频 crop benchmark、denoise gate、alpha-shape gate 汇成一份可复跑对比报告。
  - `comparisonEvidenceReady = true`，`canClaimImageV2SmallGuarded = true`，`canClaimBroadImageV2Coverage = false`，`canClaimVideoAllenkParity = false`。
  - freshness gate 通过：`comparisonMtimeUtc = 2026-06-11T06:40:02.755Z`，`newestSourceInputMtimeUtc = 2026-06-11T06:15:10.495Z`，`stale = false`。
  - provenance hash gate 通过：`recordedCount = 11`，`missingCount = 0`，`mismatchCount = 0`，`ok = true`。
  - allenk reference head gate 通过：comparison 与当前 readiness 看到的 `localHead` / `remoteHead` 均为 `632348868da0653d5c1e99680d2c448f4d8505eb`，`localHeadMatches = true`，`remoteHeadMatches = true`。
  - 视频 allenk 对照：`videoAllenkCaseCount = 15`，`videoRenderedComparisonCount = 15`，`videoMeanCurrentVsAllenkMeanAbs ~= 2.9875`，`videoMeanOriginalVsAllenkMeanAbs ~= 5.2736`。
  - 当前输出相对原始更接近 allenk，但 denoise / alpha-shape gate 仍没有 promoted default，因此只能说明差距被量化，不能说明 parity 达成。

发版判断：

- 可以发一个 scope 清晰的 RC：图片默认能力、evidence-gated V2 36 支持、当前 extension release artifact。
- 不应在发版文案中宣称：
  - 视频 V2 与 allenk v0.6.2 质量接近；
  - 新视频 denoise 后端已经可默认启用；
  - visible residual alpha/profile 新候选已经生产化。
- 后续每次发版前先跑 `pnpm release:quality-gate`；如果 allenk remote HEAD 变化、video gate 出现 promoted candidate，或 visible residual human review 完成，再更新此处结论。

P2：V2 36 render / alpha model 继续验证

- 当前 V2 36 的主要问题不是边缘，而是中心灰影。
- 需要验证：
  - V2 36 是否真是纯白 alpha composite。
  - `bg_b_36` alpha 是否覆盖实际 Gemini 生成图的中心亮度。
  - 是否存在 composite blur / antialiasing / gamma 差异。
  - 是否需要一个 V2 36 专用 forward render model，而不是强行 inpaint。

P3：96px 剩余失败样本继续保持暂停

- 只有当获得真实 96px 黑底捕获，或 visible residual crop sheet 显示大量同类、同 profile 的稳定模式时，再重启。
- 不再从单图自估 alpha 直接生产化。

### 更新规则

后续继续该方向时：

1. 先更新报告路径和样本集规模。
2. 再记录候选几何 / alpha profile / cleanup 的证据变化。
3. 每次改生产逻辑都必须给出：
   - 代表样本 before/after crop
   - 批量 summary
   - 单测或 fixture
   - 是否影响 `pnpm test` / `pnpm benchmark:samples` / `pnpm build`
4. 如果肉眼和指标冲突，先扩展观测指标或 gold manifest，不直接加重后处理。
