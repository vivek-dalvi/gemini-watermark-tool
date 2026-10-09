# 图片水印去除分层重构活文档

更新时间：2026-06-25

## Phase 1 状态

状态：已完成。

本轮完成内容：

- 在 `src/core/candidateEvaluation.js` 中新增轻量候选路径结构和 adapter：
  - `DetectionCandidate`
  - `AlphaTrial`
  - `RepairTrial`
  - `CandidateEvaluation`
  - `createAcceptedDecisionPath(...)`
  - `createRejectedDecisionPath(...)`
- 在 `src/core/watermarkProcessor.js` 的 meta 中新增 `decisionPath`。
- skipped 路径现在输出 `decisionPath.decision = "reject"`，并记录 `blockedGate = "no-watermark-detected"`。
- accepted 路径现在从现有 `selectedTrial` 包装出 detection / alpha / repair / evaluation 结构。
- `scripts/run-external-gemini-watermark-sample-benchmark.js` 和 `scripts/sample-benchmark.js` 会把 `meta.decisionPath` 写入 JSON report。

验证证据：

- 核心测试：
  - `rtk pnpm exec node --test tests/core/candidateEvaluation.test.js tests/core/candidateSelector.test.js tests/core/watermarkProcessor.test.js`
  - 结果：`pass=93`，`fail=0`，`skipped=3`
- build：
  - `rtk pnpm build`
  - 结果：通过
- 1000 张 online sample benchmark：
  - report：`.artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase1-decision-path.json`
  - markdown：`.artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase1-decision-path.md`
  - 结果：`978/1000 = 97.80%`
  - `newlyPassing=29`
  - `newlyFailing=0`
  - `decisionPath` 覆盖：`1000/1000`
- gate：
  - `rtk pnpm benchmark:online-sample:gate -- --report .artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase1-decision-path.json --min-newly-passing 29`
  - 结果：通过

## Phase 2 状态

状态：已完成主体迁移。Alpha trial 已收口，Phase 3 Repair trial 已启动。

已完成的第一步：

- `new-margin-96-variant` 已在 `decisionPath.alphaTrial` 中标记为独立 AlphaTrial strategy。
- 对应字段：
  - `decisionPath.alphaTrial.strategy = "new-margin-96-variant"`
  - `decisionPath.alphaTrial.migrationStage = "phase2-alpha-trial"`
  - `decisionPath.alphaTrial.alphaShape.variant = "20260520"`
  - `decisionPath.alphaTrial.alphaShape.stages` 包含 `new-margin-96-variant-rescue`
- 这一步只改变结构化记录，不改变像素处理顺序。

验证证据：

- `rtk pnpm exec node --test tests/core/candidateEvaluation.test.js`
  - 结果：`pass=7`，`fail=0`
- `rtk pnpm exec node --test tests/core/watermarkProcessor.test.js --test-name-pattern "new-margin residuals with the variant alpha profile|run in Node without asset imports|interpolate adaptive alpha maps"`
  - 当前 Node 参数传递下实际跑完整 `watermarkProcessor.test.js`
  - 结果：`pass=61`，`fail=0`，`skipped=3`
- `rtk pnpm build`
  - 结果：通过
- 线上 new-margin 样本轻量 meta 检查：
  - `2026-06-23/2069440104052559872-source.png`
  - `2026-06-23/2069496562140057600-source.png`
  - 两者均输出 `strategy = "new-margin-96-variant"`，`migrationStage = "phase2-alpha-trial"`，`variant = "20260520"`。

已完成的第二步：

- `known-48-power-profile` 和 `known-48-positive-residual-rebalance` 已在 `decisionPath.alphaTrial` 中标记为 Phase2 AlphaTrial strategy。
- 对应字段：
  - `decisionPath.alphaTrial.strategy = "known-48-power-profile"` 或 `"known-48-positive-residual-rebalance"`
  - `decisionPath.alphaTrial.migrationStage = "phase2-alpha-trial"`
  - `decisionPath.alphaTrial.alphaShape.profileStages` 记录：
    - `stage`
    - `alphaStrategy`
    - `fromAlphaGain`
    - `toAlphaGain`
    - `beforeSpatialScore`
    - `beforeGradientScore`
    - `afterSpatialScore`
    - `afterGradientScore`
    - `suppressionGain`
    - `profileExponent`
    - `cost`
- 这一步只改变结构化记录，不改变像素处理顺序。

验证证据：

- `rtk pnpm exec node --test tests/core/candidateEvaluation.test.js`
  - 结果：`pass=8`，`fail=0`
- `rtk pnpm exec node --test tests/core/watermarkProcessor.test.js`
  - 结果：`pass=61`，`fail=0`，`skipped=3`
- `rtk pnpm build`
  - 结果：通过
- 线上 48px alpha profile / residual rebalance 样本轻量 meta 检查：
  - `2026-06-23/2069367634989682688-source.png`
    - 输出 `strategy = "known-48-power-profile"`，`migrationStage = "phase2-alpha-trial"`，`profileExponent = 0.88`
  - `2026-06-23/2069466327243821056-source.png`
    - 输出 `strategy = "known-48-positive-residual-rebalance"`，`migrationStage = "phase2-alpha-trial"`，并记录 before/after 分数与 suppressionGain。

已完成的第三步：

- `located-aggressive-alpha` 已开始从隐式后续强清理迁移为可解释 AlphaTrial event。
- 当前保持原有像素处理顺序不变，但会把 located-aggressive 的接受/拒绝写入 `decisionPath.alphaTrial`：
  - 接受事件写入 `acceptedStrategies`
  - 拒绝事件写入 `rejectedStrategies`
  - 拒绝会记录 `blockedGate`，例如 `passable-spatial-drift` 或 `insufficient-balanced-gain`
  - 事件会记录 alphaGain、repeatCount、edgeCleanup、before/after 分数、spatialDrift、cost 等关键指标
- 这一步的重点不是让 located-aggressive 成为主策略，而是让评估层能看见它为什么被采用或被挡住。

验证证据：

- `rtk pnpm exec node --test tests/core/candidateEvaluation.test.js`
  - 结果：`pass=9`，`fail=0`
- `rtk pnpm exec node --test tests/core/watermarkProcessor.test.js`
  - 结果：通过
- `rtk pnpm build`
  - 结果：通过
- 线上样本轻量 meta 检查：
  - `2026-06-24/2069619955514478592-source.png`
    - 输出 `rejectedStrategies[0].strategy = "located-aggressive-alpha"`
    - 输出 `blockedGate = "passable-spatial-drift"`
    - 未输出 accepted located-aggressive event
  - `2026-06-23/2069440104052559872-source.png`
    - 输出 accepted located-aggressive event
    - 主策略仍为 `new-margin-96-variant`
    - 最终检测分数约为 `processedSpatialScore = -0.0470`，`processedGradientScore = 0.0264`

已完成的第四步：

- `over-subtraction-fine-alpha` 已从宽泛 `fine-alpha` 归类中拆出，覆盖：
  - `over-subtraction-recalibration`
  - `weak-positive-residual-fine-alpha`
- 当前仍保持像素处理顺序不变，只增强结构化记录：
  - `decisionPath.alphaTrial.strategy = "over-subtraction-fine-alpha"`
  - `decisionPath.alphaTrial.migrationStage = "phase2-alpha-trial"`
  - `decisionPath.alphaTrial.alphaShape.profileStages[*].alphaStrategy = "over-subtraction-fine-alpha"`
  - 接受事件写入 `acceptedStrategies`
- `dark-catalog-fine-alpha` 已先从泛化 fine-alpha 中单独识别出来，但尚未作为 Phase2 strategy 迁移，留到下一步处理。

验证证据：

- `rtk pnpm exec node --test tests/core/candidateEvaluation.test.js`
  - 结果：通过
- `rtk pnpm exec node --test tests/core/watermarkProcessor.test.js`
  - 结果：通过
- `rtk pnpm build`
  - 结果：通过
- fine-alpha 样本轻量 meta 检查：
  - `样本/Gemini_Generated_Image_n79y30n79y30n79y.png`
    - 输出 `strategy = "over-subtraction-fine-alpha"`
    - 输出 `migrationStage = "phase2-alpha-trial"`
    - accepted event stage 为 `weak-positive-residual-fine-alpha`
    - 最终检测分数约为 `processedSpatialScore = 0.1392`，`processedGradientScore = -0.0093`

已完成的第五步：

- `dark-catalog-fine-alpha` 已迁移为独立 Phase2 AlphaTrial strategy。
- 当前仍保持像素处理顺序不变，只增强结构化记录：
  - `decisionPath.alphaTrial.strategy = "dark-catalog-fine-alpha"`
  - `decisionPath.alphaTrial.migrationStage = "phase2-alpha-trial"`
  - `decisionPath.alphaTrial.alphaShape.profileStages[*].alphaStrategy = "dark-catalog-fine-alpha"`
  - 接受事件写入 `acceptedStrategies`

验证证据：

- `rtk pnpm exec node --test tests/core/candidateEvaluation.test.js`
  - 结果：通过
- `rtk pnpm exec node --test tests/core/watermarkProcessor.test.js`
  - 结果：通过
- `rtk pnpm build`
  - 结果：通过
- 暗底 catalog 样本轻量 meta 检查：
  - `src/assets/samples/20260608-4.png`
    - 输出 `strategy = "dark-catalog-fine-alpha"`
    - 输出 `migrationStage = "phase2-alpha-trial"`
    - accepted event stage 为 `dark-catalog-fine-alpha`
    - 最终检测分数约为 `processedSpatialScore = -0.0902`，`processedGradientScore = 0.0535`

Phase 2 alpha trial full benchmark：

- report：`.artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase2-alpha-trial.json`
- markdown：`.artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase2-alpha-trial.md`
- 结果：`978/1000 = 97.80%`
- 相对 `latest-report-after-rebalance.json`：
  - `newlyPassing=0`
  - `newlyFailing=0`
- `decisionPath` 覆盖：`1000/1000`
- alpha trial event：
  - accepted event：`504`
  - rejected event：`26`
- strategy 分布 Top：
  - `selected-alpha=513`
  - `located-aggressive-alpha=326`
  - `over-subtraction-fine-alpha=107`
  - `alpha-variant=21`
  - `known-48-positive-residual-rebalance=9`
  - `known-48-power-profile=3`
  - `dark-catalog-fine-alpha=3`
  - `new-margin-96-variant=2`
- gate：
  - `rtk pnpm benchmark:online-sample:gate -- --report .artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase2-alpha-trial.json --min-newly-passing 0`
  - 结果：通过
  - 说明：这里使用 `--min-newly-passing 0`，因为本轮 Phase 2 是相对 `after-rebalance` 的行为等价结构迁移，不以新增通过数为目标。

## 当前结论

## Phase 3 状态

状态：已完成主体迁移。Repair trial 已收口，下一步进入 Phase 4 执行壳瘦身。

已完成的第一步：

- `edge-cleanup` / `luma-edge` 已进入 `decisionPath.repairTrial`。
- 当前仍保持像素处理顺序不变，只增强结构化记录：
  - `known-48-edge-cleanup` 现在会写入 repair stage。
  - `known-48-luma-edge-correction` 会标记 `repairStrategy = "luma-edge"`。
  - `repairTrial.params[*]` 记录：
    - `stage`
    - `repairStrategy`
    - `fromAlphaGain`
    - `toAlphaGain`
    - `beforeSpatialScore`
    - `beforeGradientScore`
    - `afterSpatialScore`
    - `afterGradientScore`
    - `suppressionGain`
    - `cost`
  - `repairTrial.gates.stages` 记录参与 repair 的 stage 名单。
- 这一步修复了一个观测缺口：普通 edge cleanup 以前只体现在 `source` 字符串里，没有独立 stage 记录。

验证证据：

- `rtk pnpm exec node --test tests/core/candidateEvaluation.test.js`
  - 结果：通过
- `rtk pnpm exec node --test tests/core/watermarkProcessor.test.js`
  - 结果：通过
- `rtk pnpm build`
  - 结果：通过
- fixture 轻量 meta 检查：
  - `src/assets/samples/4-3.png`
  - `src/assets/samples/9-16.png`
  - 两者均输出 `repairTrial.params` 包含 `known-48-edge-cleanup` / `repairStrategy = "edge-cleanup"`
- full benchmark：
  - report：`.artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase3-repair-trial-edge.json`
  - markdown：`.artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase3-repair-trial-edge.md`
  - 结果：`978/1000 = 97.80%`
  - `newlyPassing=0`
  - `newlyFailing=0`
  - `decisionPath` 覆盖：`1000/1000`
  - `repairApplied=175`
  - repair strategy 计数：
    - `edge-cleanup=132`
    - `luma-edge=70`
    - `flat-fill=23`
    - `estimated-prior=5`
    - `quantized-body-correction=4`
    - `halo-repair=3`
    - `mid-core-bias-correction=1`
- gate：
  - `rtk pnpm benchmark:online-sample:gate -- --report .artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase3-repair-trial-edge.json --min-newly-passing 0`
  - 结果：通过

已完成的第二步：

- `flat-fill` 已拆成明确 repair strategy：
  - `known-48-flat-fill`
  - `new-margin-96-flat-fill`
- 当前仍保持像素处理顺序不变，只增强结构化记录：
  - `known-48-flat-background-fill` 标记 `repairStrategy = "known-48-flat-fill"`
  - `new-margin-96-flat-background-fill` 标记 `repairStrategy = "new-margin-96-flat-fill"`
  - `decisionPath.repairTrial.params[*]` 保留 before/after 分数、suppressionGain 和 cost。

验证证据：

- `rtk pnpm exec node --test tests/core/candidateEvaluation.test.js`
  - 结果：通过
- `rtk pnpm exec node --test tests/core/watermarkProcessor.test.js`
  - 结果：通过
- `rtk pnpm build`
  - 结果：通过
- flat-fill 轻量 meta 检查：
  - synthetic known-48 flat-fill 样本输出 `repairStrategy = "known-48-flat-fill"`
  - `2026-06-09/2064208514779189248-source.png` 输出 `repairStrategy = "new-margin-96-flat-fill"`
- full benchmark：
  - report：`.artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase3-repair-trial-flat-fill.json`
  - markdown：`.artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase3-repair-trial-flat-fill.md`
  - 结果：`978/1000 = 97.80%`
  - `newlyPassing=0`
  - `newlyFailing=0`
  - `decisionPath` 覆盖：`1000/1000`
  - `repairApplied=175`
  - repair strategy 计数：
    - `edge-cleanup=132`
    - `luma-edge=70`
    - `known-48-flat-fill=19`
    - `estimated-prior=5`
    - `quantized-body-correction=4`
    - `new-margin-96-flat-fill=4`
    - `halo-repair=3`
    - `mid-core-bias-correction=1`
- gate：
  - `rtk pnpm benchmark:online-sample:gate -- --report .artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase3-repair-trial-flat-fill.json --min-newly-passing 0`
  - 结果：通过

已完成的第三步：

- `estimated-prior` 已拆成明确 repair strategy：
  - `smooth-located-prior`
  - `small-margin-prior`
  - `small-located-prior`
- 当前仍保持像素处理顺序不变，只增强结构化记录：
  - `smooth-located-estimated-prior` 标记 `repairStrategy = "smooth-located-prior"`
  - `known-48-small-margin-prior-repair` 标记 `repairStrategy = "small-margin-prior"`
  - `small-located-prior-repair` 标记 `repairStrategy = "small-located-prior"`
  - `decisionPath.repairTrial.params[*]` 继续保留 before/after 分数、suppressionGain 和 cost。

验证证据：

- `pnpm exec node --test tests/core/candidateEvaluation.test.js`
  - 结果：通过
- `pnpm exec node --test tests/core/watermarkProcessor.test.js`
  - 结果：通过
- `pnpm build`
  - 结果：通过
- prior 轻量 meta 检查：
  - `2026-06-09/2064239698053697536-source.png` 输出 `repairStrategy = "smooth-located-prior"`
  - `2026-06-23/2069451544700391424-source.jpg` 输出 `repairStrategy = "small-margin-prior"`
  - `2026-06-23/2069527813160964096-source.jpg` 输出 `repairStrategy = "small-located-prior"`
- full benchmark：
  - report：`.artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase3-repair-trial-estimated-prior.json`
  - markdown：`.artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase3-repair-trial-estimated-prior.md`
  - 结果：`978/1000 = 97.80%`
  - `newlyPassing=0`
  - `newlyFailing=0`
  - `decisionPath` 覆盖：`1000/1000`
  - `repairApplied=175`
  - repair strategy 计数：
    - `edge-cleanup=132`
    - `luma-edge=70`
    - `known-48-flat-fill=19`
    - `quantized-body-correction=4`
    - `new-margin-96-flat-fill=4`
    - `small-located-prior=3`
    - `halo-repair=3`
    - `small-margin-prior=2`
    - `mid-core-bias-correction=1`
- gate：
  - `pnpm benchmark:online-sample:gate -- --report .artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase3-repair-trial-estimated-prior.json --min-newly-passing 0`
  - 结果：通过
- 环境备注：
  - 当前本机 pnpm 为 `11.7.0`，已不读取 `package.json#pnpm.onlyBuiltDependencies`。
  - 为恢复非交互 build scripts approval，本轮新增 `pnpm-workspace.yaml`，其中 `allowBuilds` 允许 `esbuild`、`protobufjs`、`sharp`。

已完成的第四步：

- `halo-repair` / `quantized-body-correction` 已进一步结构化：
  - `dark-halo-low-logo-rescue` 标记 `repairStrategy = "dark-halo-repair"`
  - `canonical-96-positive-halo-rescue` 标记 `repairStrategy = "canonical-96-positive-halo-repair"`
  - `quantized-body-correction` 标记 `repairStrategy = "quantized-body-correction"`
- 当前仍保持像素处理顺序不变，只增强结构化记录。

验证证据：

- `pnpm exec node --test tests/core/candidateEvaluation.test.js`
  - 结果：通过
- `pnpm exec node --test tests/core/watermarkProcessor.test.js`
  - 结果：通过
- `pnpm build`
  - 结果：通过
- halo / quantized 轻量 meta 检查：
  - `样本/Gemini_Generated_Image_wn0cz5wn0cz5wn0c.png` 输出 `repairStrategy = "quantized-body-correction"`
  - `样本/Gemini_Generated_Image_9eao4b9eao4b9eao.png` 输出 `repairStrategy = "dark-halo-repair"`
  - `tests/fixtures/issue93-canonical96-positive-halo.png` 输出 `repairStrategy = "canonical-96-positive-halo-repair"`
- full benchmark：
  - report：`.artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase3-repair-trial-halo-quantized.json`
  - markdown：`.artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase3-repair-trial-halo-quantized.md`
  - 结果：`978/1000 = 97.80%`
  - `newlyPassing=0`
  - `newlyFailing=0`
  - `decisionPath` 覆盖：`1000/1000`
  - `repairApplied=175`
  - repair strategy 计数：
    - `edge-cleanup=132`
    - `luma-edge=70`
    - `known-48-flat-fill=19`
    - `quantized-body-correction=4`
    - `new-margin-96-flat-fill=4`
    - `small-located-prior=3`
    - `dark-halo-repair=3`
    - `small-margin-prior=2`
    - `mid-core-bias-correction=1`
- gate：
  - `pnpm benchmark:online-sample:gate -- --report .artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase3-repair-trial-halo-quantized.json --min-newly-passing 0`
  - 结果：通过

已完成的第五步：Phase 3 收口

- `boundary-repair` / `mid-core-bias-correction` 已补显式 `repairStrategy`：
  - `known-48-boundary-repair-rescue` 标记 `repairStrategy = "boundary-repair"`
  - `known-48-mid-core-bias-correction` 标记 `repairStrategy = "mid-core-bias-correction"`
- 最新 full benchmark report 中无泛化 repair strategy 残留：
  - `genericCount=0`
  - 未发现 `repair` / `halo-repair` / `estimated-prior` / `flat-fill` / missing strategy

验证证据：

- `pnpm exec node --test tests/core/candidateEvaluation.test.js`
  - 结果：通过
- `pnpm exec node --test tests/core/watermarkProcessor.test.js`
  - 结果：通过
- `pnpm build`
  - 结果：通过
- boundary / mid-core 轻量 meta 检查：
  - `样本/Gemini_Generated_Image_hoac1lhoac1lhoac.png` 输出 `repairStrategy = "boundary-repair"`
  - `src/assets/samples/4-3.png` 输出 `repairStrategy = "mid-core-bias-correction"`
- full benchmark：
  - report：`.artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase3-repair-trial-closure.json`
  - markdown：`.artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase3-repair-trial-closure.md`
  - 结果：`978/1000 = 97.80%`
  - `newlyPassing=0`
  - `newlyFailing=0`
  - `decisionPath` 覆盖：`1000/1000`
  - `repairApplied=175`
  - repair strategy 计数：
    - `edge-cleanup=132`
    - `luma-edge=70`
    - `known-48-flat-fill=19`
    - `quantized-body-correction=4`
    - `new-margin-96-flat-fill=4`
    - `small-located-prior=3`
    - `dark-halo-repair=3`
    - `small-margin-prior=2`
    - `mid-core-bias-correction=1`
- gate：
  - `pnpm benchmark:online-sample:gate -- --report .artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase3-repair-trial-closure.json --min-newly-passing 0`
  - 结果：通过

下一步：

1. 进入 Phase 4：执行壳瘦身。
2. 先把 `processWatermarkImageData` 内的 stage 记录与 meta 汇总逻辑抽成小 helper，不改任何像素路径。
3. 再逐步把 detection / alpha / repair 的候选生成入口迁到独立模块，继续用 full benchmark / gate 检查 `newlyFailing=0`。

## Phase 4 状态

状态：进行中。执行壳瘦身第一刀已完成。

已完成的第一步：

- 新增 `src/core/pipelineTrace.js`：
  - `createPipelineTraceRecorder()`
  - 统一管理 `alphaAdjustmentStages`
  - 统一管理 `alphaTrialEvents`
  - 统一提供 `recordAlphaAdjustmentStage(...)`
  - 统一提供 `recordAlphaTrialEvent(...)`
- `src/core/watermarkProcessor.js` 不再内联 stage/event 记录器，改为使用 `createPipelineTraceRecorder()`。
- 这一步只移动 meta/trace 记录逻辑，不改变候选选择、alpha 计算、repair 执行或输出像素。

验证证据：

- `pnpm exec node --test tests/core/pipelineTrace.test.js tests/core/candidateEvaluation.test.js`
  - 结果：通过
- `pnpm exec node --test tests/core/watermarkProcessor.test.js`
  - 结果：通过
- `pnpm build`
  - 结果：通过
- quantized body 样本轻量 meta 检查：
  - `样本/Gemini_Generated_Image_wn0cz5wn0cz5wn0c.png`
  - 输出 `repairStrategy = "quantized-body-correction"`
  - 输出 `alphaTrial.acceptedStrategies.length = 1`
  - 输出 `repairTrial.params` 保持完整
- full benchmark：
  - report：`.artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase4-pipeline-trace.json`
  - markdown：`.artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase4-pipeline-trace.md`
  - 结果：`978/1000 = 97.80%`
  - `newlyPassing=0`
  - `newlyFailing=0`
  - `decisionPath` 覆盖：`1000/1000`
  - `alphaStageRows=188`
  - `acceptedEventCount=504`
  - `rejectedEventCount=26`
  - `repairApplied=175`
- gate：
  - `pnpm benchmark:online-sample:gate -- --report .artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase4-pipeline-trace.json --min-newly-passing 0`
  - 结果：通过

已完成的第二步：

- 新增 `src/core/pipelineMeta.js`：
  - `createWatermarkMeta(...)`
  - `createAcceptedWatermarkMeta(...)`
- `src/core/watermarkProcessor.js` 不再内联 final meta 规范化函数。
- accepted path 的 `decisionPath + createWatermarkMeta` 汇总从处理器末尾迁入 `createAcceptedWatermarkMeta(...)`。
- skipped path 仍显式创建 `createRejectedDecisionPath(...)`，保持拒绝分支可读，后续再决定是否抽取。
- 这一步只移动 final meta / accepted decisionPath 汇总逻辑，不改变候选选择、alpha 计算、repair 执行或输出像素。

验证证据：

- `pnpm exec node --test tests/core/pipelineMeta.test.js tests/core/pipelineTrace.test.js tests/core/candidateEvaluation.test.js`
  - 结果：通过
- `pnpm exec node --test tests/core/watermarkProcessor.test.js`
  - 结果：通过
- `pnpm build`
  - 结果：通过
- small-margin prior 样本轻量 meta 检查：
  - `2026-06-23/2069451544700391424-source.jpg`
  - 输出 `decision = "accept"`
  - 输出 `repairType = "small-margin-prior"`
  - 输出 detection / repairTrial params 保持完整
- full benchmark：
  - report：`.artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase4-pipeline-meta.json`
  - markdown：`.artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase4-pipeline-meta.md`
  - 结果：`978/1000 = 97.80%`
  - `newlyPassing=0`
  - `newlyFailing=0`
  - `decisionPath` 覆盖：`1000/1000`
  - accepted decision：`984`
  - rejected decision：`16`
  - `repairApplied=175`
- gate：
  - `pnpm benchmark:online-sample:gate -- --report .artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase4-pipeline-meta.json --min-newly-passing 0`
  - 结果：通过

已完成的第三步：

- `src/core/pipelineMeta.js` 新增 `createRejectedWatermarkMeta(...)`。
- skipped / rejected path 的 `createWatermarkMeta + createRejectedDecisionPath` 汇总从 `src/core/watermarkProcessor.js` 迁入 `pipelineMeta.js`。
- `src/core/watermarkProcessor.js` 不再直接依赖 `createRejectedDecisionPath(...)`，accepted / rejected 两条 final meta 汇总都由 `pipelineMeta.js` 承接。
- 这一步只移动 rejected meta / rejected decisionPath 汇总逻辑，不改变候选选择、alpha 计算、repair 执行或输出像素。

验证证据：

- `node --check src/core/pipelineMeta.js`
  - 结果：通过
- `node --check src/core/watermarkProcessor.js`
  - 结果：通过
- `pnpm exec node --test tests/core/pipelineMeta.test.js tests/core/pipelineTrace.test.js tests/core/candidateEvaluation.test.js`
  - 结果：通过
- `pnpm exec node --test tests/core/watermarkProcessor.test.js`
  - 结果：`pass=61`，`fail=0`，`skipped=3`
- `pnpm build`
  - 结果：通过
- 无水印 synthetic skipped 轻量 meta 检查：
  - 输出 `applied = false`
  - 输出 `skipReason = "no-watermark-detected"`
  - 输出 `decision = "reject"`
  - 输出 `blockedGate = "no-watermark-detected"`
- full benchmark：
  - report：`.artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase4-rejected-meta.json`
  - markdown：`.artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase4-rejected-meta.md`
  - 结果：`978/1000 = 97.80%`
  - `newlyPassing=0`
  - `newlyFailing=0`
  - `decisionPath` 覆盖：`1000/1000`
  - accepted decision：`984`
  - rejected decision：`16`
  - `repairApplied=175`
- gate：
  - `pnpm benchmark:online-sample:gate -- --report .artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase4-rejected-meta.json --min-newly-passing 0`
  - 结果：通过

已完成的第四步：

- 新增 `src/core/pipelineInitialSelection.js`：
  - `selectInitialWatermarkCandidate(...)`
- `src/core/watermarkProcessor.js` 不再内联“标准初始选择 + aggressive located fallback”分支。
- 该 helper 仍使用原有 `src/core/candidateSelector.js#selectInitialCandidate(...)`，只封装调用顺序和 fallback source 标记。
- 这一步是 detection / alpha 候选入口的第一层外壳迁移，不改变候选评分、fallback 开关、alphaGain 候选、或输出像素。

验证证据：

- `node --check src/core/pipelineInitialSelection.js`
  - 结果：通过
- `node --check src/core/watermarkProcessor.js`
  - 结果：通过
- `pnpm exec node --test tests/core/pipelineInitialSelection.test.js tests/core/pipelineMeta.test.js tests/core/pipelineTrace.test.js tests/core/candidateEvaluation.test.js`
  - 结果：通过
- `pnpm exec node --test tests/core/watermarkProcessor.test.js`
  - 结果：`pass=61`，`fail=0`，`skipped=3`
- `pnpm build`
  - 结果：通过
- full benchmark：
  - report：`.artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase4-initial-selection.json`
  - markdown：`.artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase4-initial-selection.md`
  - 结果：`978/1000 = 97.80%`
  - `newlyPassing=0`
  - `newlyFailing=0`
  - `decisionPath` 覆盖：`1000/1000`
  - accepted decision：`984`
  - rejected decision：`16`
  - `repairApplied=175`
- gate：
  - `pnpm benchmark:online-sample:gate -- --report .artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase4-initial-selection.json --min-newly-passing 0`
  - 结果：通过

已完成的第五步：

- 新增 `src/core/pipelineMetrics.js`：
  - `shouldStopAfterFirstPass(...)`
  - `createFirstPassMetrics(...)`
- `src/core/watermarkProcessor.js` 不再内联首轮 pass 的 spatial / gradient / nearBlack 指标计算、`passes[0]` 组装、以及 `residual-low` / `single-pass` stop reason 判断。
- 这一步只迁移首轮 metrics 汇总逻辑，不改变检测候选、alpha 计算、repair 执行、pass 策略或输出像素。

验证证据：

- `node --check src/core/pipelineMetrics.js`
  - 结果：通过
- `node --check src/core/watermarkProcessor.js`
  - 结果：通过
- `pnpm exec node --test tests/core/pipelineMetrics.test.js tests/core/pipelineInitialSelection.test.js tests/core/pipelineMeta.test.js tests/core/pipelineTrace.test.js tests/core/candidateEvaluation.test.js`
  - 结果：通过
- `pnpm exec node --test tests/core/watermarkProcessor.test.js`
  - 结果：`pass=61`，`fail=0`，`skipped=3`
- `pnpm build`
  - 结果：通过
- full benchmark：
  - report：`.artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase4-pipeline-metrics.json`
  - markdown：`.artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase4-pipeline-metrics.md`
  - 结果：`978/1000 = 97.80%`
  - `newlyPassing=0`
  - `newlyFailing=0`
  - `decisionPath` 覆盖：`1000/1000`
  - accepted decision：`984`
  - rejected decision：`16`
  - `repairApplied=175`
- gate：
  - `pnpm benchmark:online-sample:gate -- --report .artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase4-pipeline-metrics.json --min-newly-passing 0`
  - 结果：通过

已完成的第六步：

- 新增 `src/core/pipelineState.js`：
  - `createPipelineStateCommit(...)`
- `src/core/watermarkProcessor.js` 新增局部 `readPipelineState()` / `applyPipelineState(...)` 桥接现有执行壳变量。
- `over-subtraction-recalibration`、`dark-catalog-fine-alpha`、`weak-positive-residual-fine-alpha` 三个 alpha fine-tune 分支已改为通过 `createPipelineStateCommit(...)` 提交已接受 trial 结果。
- 这一步只迁移“已接受结果如何写回当前处理状态”的重复赋值逻辑，不改变 alpha trial 生成、stage/event 记录、repair 执行或输出像素。

验证证据：

- `node --check src/core/pipelineState.js`
  - 结果：通过
- `node --check src/core/watermarkProcessor.js`
  - 结果：通过
- `pnpm exec node --test tests/core/pipelineState.test.js tests/core/pipelineMetrics.test.js tests/core/pipelineInitialSelection.test.js tests/core/pipelineMeta.test.js tests/core/pipelineTrace.test.js tests/core/candidateEvaluation.test.js`
  - 结果：通过
- `pnpm exec node --test tests/core/watermarkProcessor.test.js`
  - 结果：`pass=61`，`fail=0`，`skipped=3`
- `pnpm build`
  - 结果：通过
- full benchmark：
  - report：`.artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase4-pipeline-state.json`
  - markdown：`.artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase4-pipeline-state.md`
  - 结果：`978/1000 = 97.80%`
  - `newlyPassing=0`
  - `newlyFailing=0`
  - `decisionPath` 覆盖：`1000/1000`
  - accepted decision：`984`
  - rejected decision：`16`
  - `repairApplied=175`
- gate：
  - `pnpm benchmark:online-sample:gate -- --report .artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase4-pipeline-state.json --min-newly-passing 0`
  - 结果：通过

已完成的第七步：

- `createPipelineStateCommit(...)` 已扩展到第一批低风险 repair / cleanup 写回块：
  - `preview-background-cleanup`
  - `preview-edge-cleanup` / `known-48-edge-cleanup` / `v2-small-edge-cleanup`
  - `known-48-flat-background-fill`
  - `known-48-luma-edge-correction`
  - `new-margin-96-flat-background-fill`
- 这些分支的安全判断、stage 记录、repair 策略标记都保持原位，只把通过后的 image / score / source 写回改成统一状态提交。
- 这一步继续收束执行壳中的重复赋值逻辑，不改变 repair 候选生成、接受条件、stage/event 记录或输出像素。

验证证据：

- `node --check src/core/watermarkProcessor.js`
  - 结果：通过
- `node --check src/core/pipelineState.js`
  - 结果：通过
- `pnpm exec node --test tests/core/pipelineState.test.js tests/core/pipelineMetrics.test.js tests/core/pipelineInitialSelection.test.js tests/core/pipelineMeta.test.js tests/core/pipelineTrace.test.js tests/core/candidateEvaluation.test.js`
  - 结果：通过
- `pnpm exec node --test tests/core/watermarkProcessor.test.js`
  - 结果：`pass=61`，`fail=0`，`skipped=3`
- `pnpm build`
  - 结果：通过
- full benchmark：
  - report：`.artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase4-repair-state.json`
  - markdown：`.artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase4-repair-state.md`
  - 结果：`978/1000 = 97.80%`
  - `newlyPassing=0`
  - `newlyFailing=0`
  - `decisionPath` 覆盖：`1000/1000`
  - accepted decision：`984`
  - rejected decision：`16`
  - `repairApplied=175`
- gate：
  - `pnpm benchmark:online-sample:gate -- --report .artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase4-repair-state.json --min-newly-passing 0`
  - 结果：通过

已完成的第八步：

- `createPipelineStateCommit(...)` 已扩展到几何类 alpha / repair 写回块：
  - `small-preview-refinement`
  - `small-fixed-local-anchor-relocation`
  - `canonical-96-positive-halo-rescue`
  - `new-margin-96-variant-rescue`
  - `known-48-anti-template-rescue`
  - `known-48-power-profile-rescue`
  - `known-48-positive-residual-rebalance`
  - `known-48-small-margin-prior-repair`
  - `small-located-prior-repair`
- 这些分支可能更新 `alphaMap` / `position` / `config` / `originalSpatialScore` / `originalGradientScore`，现在统一通过 `pipelineState` 写回。
- 安全判断、stage/event 记录、source 后缀、pass 计数和输出像素保持行为等价。

验证证据：

- `node --check src/core/watermarkProcessor.js`
  - 结果：通过
- `node --check src/core/pipelineState.js`
  - 结果：通过
- `pnpm exec node --test tests/core/pipelineState.test.js tests/core/pipelineMetrics.test.js tests/core/pipelineInitialSelection.test.js tests/core/pipelineMeta.test.js tests/core/pipelineTrace.test.js tests/core/candidateEvaluation.test.js`
  - 结果：通过
- `pnpm exec node --test tests/core/watermarkProcessor.test.js`
  - 结果：`pass=61`，`fail=0`，`skipped=3`
- `pnpm build`
  - 结果：通过
- full benchmark：
  - report：`.artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase4-geometry-state.json`
  - markdown：`.artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase4-geometry-state.md`
  - 结果：`978/1000 = 97.80%`
  - `newlyPassing=0`
  - `newlyFailing=0`
  - `decisionPath` 覆盖：`1000/1000`
  - accepted decision：`984`
  - rejected decision：`16`
  - `repairApplied=175`
- gate：
  - `pnpm benchmark:online-sample:gate -- --report .artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase4-geometry-state.json --min-newly-passing 0`
  - 结果：通过

已完成的第九步：

- `createPipelineStateCommit(...)` 已扩展到后段 repair 写回块：
  - `known-48-boundary-repair-rescue`
  - `dark-halo-low-logo-rescue`
  - `quantized-body-correction`
  - `known-48-mid-core-bias-correction`
- 这些分支位于执行壳尾段，之前仍手写 `finalImageData` / score / `source` / geometry 更新；现在统一通过 `pipelineState` 写回。
- 安全判断、stage 记录、repair 策略标记、debug timing、final meta 输出保持行为等价。

验证证据：

- `node --check src/core/watermarkProcessor.js`
  - 结果：通过
- `node --check src/core/pipelineState.js`
  - 结果：通过
- `pnpm exec node --test tests/core/pipelineState.test.js tests/core/pipelineMetrics.test.js tests/core/pipelineInitialSelection.test.js tests/core/pipelineMeta.test.js tests/core/pipelineTrace.test.js tests/core/candidateEvaluation.test.js`
  - 结果：通过
- `pnpm exec node --test tests/core/watermarkProcessor.test.js`
  - 结果：`pass=61`，`fail=0`，`skipped=3`
- `pnpm build`
  - 结果：通过
- full benchmark：
  - report：`.artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase4-tail-repair-state.json`
  - markdown：`.artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase4-tail-repair-state.md`
  - 结果：`978/1000 = 97.80%`
  - `newlyPassing=0`
  - `newlyFailing=0`
  - `decisionPath` 覆盖：`1000/1000`
  - accepted decision：`984`
  - rejected decision：`16`
  - `repairApplied=175`
- gate：
  - `pnpm benchmark:online-sample:gate -- --report .artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase4-tail-repair-state.json --min-newly-passing 0`
  - 结果：通过

已完成的第十步：状态提交层收口

- `recalibration`、`subpixel-outline-refinement`、`located-aggressive-removal`、`smooth-located-estimated-prior` 的状态写回已迁入 `createPipelineStateCommit(...)`。
- `subpixelShift`、`passes.push(...)`、`passCount`、`attemptedPassCount`、`passStopReason` 等非状态提交副作用仍保持原位。
- 对 `src/core/watermarkProcessor.js` 的剩余写回点审计显示：
  - 主流程剩余直接赋值集中在初始化、初始 selection 接入、以及 `applyPipelineState(...)` 内部。
  - 已接受 trial / repair 结果的 image / alpha / geometry / score / source 写回已统一通过 `pipelineState`。
- 这一步标志 Phase 4 的状态提交层基本收口；后续应转向更高层的 alpha / repair 执行段模块边界，而不是继续拆单个赋值语句。

验证证据：

- `node --check src/core/watermarkProcessor.js`
  - 结果：通过
- `node --check src/core/pipelineState.js`
  - 结果：通过
- `pnpm exec node --test tests/core/pipelineState.test.js tests/core/pipelineMetrics.test.js tests/core/pipelineInitialSelection.test.js tests/core/pipelineMeta.test.js tests/core/pipelineTrace.test.js tests/core/candidateEvaluation.test.js`
  - 结果：通过
- `pnpm exec node --test tests/core/watermarkProcessor.test.js`
  - 结果：`pass=61`，`fail=0`，`skipped=3`
- `pnpm build`
  - 结果：通过
- full benchmark：
  - report：`.artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase4-state-closure.json`
  - markdown：`.artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase4-state-closure.md`
  - 结果：`978/1000 = 97.80%`
  - `newlyPassing=0`
  - `newlyFailing=0`
  - `decisionPath` 覆盖：`1000/1000`
  - accepted decision：`984`
  - rejected decision：`16`
  - `repairApplied=175`
- gate：
  - `pnpm benchmark:online-sample:gate -- --report .artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase4-state-closure.json --min-newly-passing 0`
  - 结果：通过

已完成的第十一步：

- 新增 `src/core/pipelineState.js#createAcceptedPipelineState(...)`。
- accepted `initialSelection` 进入 alpha / repair 执行段前的 seed 组装已迁入 `pipelineState`：
  - `config`
  - `position`
  - `alphaMap`
  - `source`
  - `adaptiveConfidence`
  - `templateWarp`
  - `alphaGain`
  - `decisionTier`
  - `finalImageData`
  - `originalSpatialScore`
  - `originalGradientScore`
- `src/core/watermarkProcessor.js` 现在通过 accepted pipeline seed 进入后续执行段，为后续 `runAlphaRepairPipeline(...)` 提供更清晰的输入边界。
- 这一步只迁移 accepted seed 的状态组装，不改变初始候选选择、alpha / repair 执行顺序、stage/event 记录或输出像素。

验证证据：

- `node --check src/core/pipelineState.js`
  - 结果：通过
- `node --check src/core/watermarkProcessor.js`
  - 结果：通过
- `pnpm exec node --test tests/core/pipelineState.test.js tests/core/pipelineMetrics.test.js tests/core/pipelineInitialSelection.test.js tests/core/pipelineMeta.test.js tests/core/pipelineTrace.test.js tests/core/candidateEvaluation.test.js`
  - 结果：通过
- `pnpm exec node --test tests/core/watermarkProcessor.test.js`
  - 结果：`pass=61`，`fail=0`，`skipped=3`
- `pnpm build`
  - 结果：通过
- full benchmark：
  - report：`.artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase4-accepted-state-seed.json`
  - markdown：`.artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase4-accepted-state-seed.md`
  - 结果：`978/1000 = 97.80%`
  - `newlyPassing=0`
  - `newlyFailing=0`
  - `decisionPath` 覆盖：`1000/1000`
  - accepted decision：`984`
  - rejected decision：`16`
  - `repairApplied=175`
- gate：
  - `pnpm benchmark:online-sample:gate -- --report .artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase4-accepted-state-seed.json --min-newly-passing 0`
  - 结果：通过

已完成的第十二步：

- 新增 `src/core/pipelineRepairGates.js`：
  - `shouldUsePreviewAnchorFastCleanup(...)`
  - `shouldUseKnown48EdgeCleanup(...)`
  - `shouldUseV2SmallEdgeCleanup(...)`
  - `createRepairCleanupFlags(...)`
- `src/core/watermarkProcessor.js` 不再内联 preview / known-48 / v2-small cleanup gate 判定。
- alpha / repair 执行段入口现在通过 `createRepairCleanupFlags(...)` 获得：
  - `usePreviewAnchorFastCleanup`
  - `useKnown48EdgeCleanup`
  - `useV2SmallEdgeCleanup`
- 这一步只迁移 repair cleanup flags 的判定边界，不改变 repair 候选生成、阈值、执行顺序、stage/event 记录或输出像素。

验证证据：

- `node --check src/core/pipelineRepairGates.js`
  - 结果：通过
- `node --check src/core/watermarkProcessor.js`
  - 结果：通过
- `pnpm exec node --test tests/core/pipelineRepairGates.test.js tests/core/pipelineState.test.js tests/core/pipelineMetrics.test.js tests/core/pipelineInitialSelection.test.js tests/core/pipelineMeta.test.js tests/core/pipelineTrace.test.js tests/core/candidateEvaluation.test.js`
  - 结果：通过
- `pnpm exec node --test tests/core/watermarkProcessor.test.js`
  - 结果：`pass=61`，`fail=0`，`skipped=3`
- `pnpm build`
  - 结果：通过
- full benchmark：
  - report：`.artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase4-repair-gates.json`
  - markdown：`.artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase4-repair-gates.md`
  - 结果：`978/1000 = 97.80%`
  - `newlyPassing=0`
  - `newlyFailing=0`
  - `decisionPath` 覆盖：`1000/1000`
  - accepted decision：`984`
  - rejected decision：`16`
  - `repairApplied=175`
- gate：
  - `pnpm benchmark:online-sample:gate -- --report .artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase4-repair-gates.json --min-newly-passing 0`
  - 结果：通过

已完成的第十三步：

- 新增 `src/core/pipelineTimings.js#createTailDebugTimings(...)`。
- `src/core/watermarkProcessor.js` 不再内联尾部 debug timing 汇总。
- 当前迁移出的 timing 项包括：
  - `previewEdgeCleanupMs`
  - `smallPreviewRefinementMs`
  - `locatedAggressiveRemovalMs`
  - `smoothPriorCleanupMs`
  - `newMargin96VariantRescueMs`
  - `known48AntiTemplateRescueMs`
  - `powerProfileRescueMs`
  - `positiveResidualRebalanceMs`
  - `smallMarginPriorRepairMs`
  - `smallLocatedPriorRepairMs`
  - `boundaryRepairRescueMs`
  - `darkHaloRescueMs`
  - `quantizedBodyCorrectionMs`
  - `midCoreBiasCorrectionMs`
  - `totalMs`
- 这一步只迁移观测 / timing 边界，不改变候选检测、alpha 逼近、repair 执行顺序、stage/event 记录或输出像素。

验证证据：

- `node --check src/core/pipelineTimings.js`
  - 结果：通过
- `node --check src/core/watermarkProcessor.js`
  - 结果：通过
- `pnpm exec node --test tests/core/pipelineTimings.test.js tests/core/pipelineRepairGates.test.js tests/core/pipelineState.test.js tests/core/pipelineMetrics.test.js tests/core/pipelineInitialSelection.test.js tests/core/pipelineMeta.test.js tests/core/pipelineTrace.test.js tests/core/candidateEvaluation.test.js`
  - 结果：`pass=32`，`fail=0`
- `pnpm exec node --test tests/core/watermarkProcessor.test.js`
  - 结果：`pass=61`，`fail=0`，`skipped=3`
- `pnpm build`
  - 结果：通过
- full benchmark：
  - report：`.artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase4-pipeline-timings.json`
  - markdown：`.artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase4-pipeline-timings.md`
  - 结果：`978/1000 = 97.80%`
  - `newlyPassing=0`
  - `newlyFailing=0`
  - `decisionPath` 覆盖：`1000/1000`
  - accepted decision：`984`
  - rejected decision：`16`
  - `repairApplied=175`
- gate：
  - `pnpm benchmark:online-sample:gate -- --report .artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase4-pipeline-timings.json --min-newly-passing 0`
  - 结果：通过

已完成的第十四步：

- 新增 `src/core/pipelineResult.js#createAcceptedPipelineResult(...)`。
- `src/core/watermarkProcessor.js` 尾部不再直接组装 accepted 返回对象，而是通过 `createAcceptedPipelineResult(...)` 汇总：
  - `imageData`
  - `meta`
  - `debugTimings`
- `createAcceptedPipelineResult(...)` 仍复用 `createAcceptedWatermarkMeta(...)`，因此 decisionPath / meta contract 没有改变。
- 这一步只迁移最终 accepted result 的封装边界，不改变 residual visibility 计算、selection debug 生成、候选检测、alpha 逼近、repair 执行顺序或输出像素。

验证证据：

- `node --check src/core/pipelineResult.js`
  - 结果：通过
- `node --check src/core/watermarkProcessor.js`
  - 结果：通过
- `pnpm exec node --test tests/core/pipelineResult.test.js tests/core/pipelineTimings.test.js tests/core/pipelineRepairGates.test.js tests/core/pipelineState.test.js tests/core/pipelineMetrics.test.js tests/core/pipelineInitialSelection.test.js tests/core/pipelineMeta.test.js tests/core/pipelineTrace.test.js tests/core/candidateEvaluation.test.js`
  - 结果：`pass=33`，`fail=0`
- `pnpm exec node --test tests/core/watermarkProcessor.test.js`
  - 结果：`pass=61`，`fail=0`，`skipped=3`
- `pnpm build`
  - 结果：通过
- full benchmark：
  - report：`.artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase4-pipeline-result.json`
  - markdown：`.artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase4-pipeline-result.md`
  - 结果：`978/1000 = 97.80%`
  - `newlyPassing=0`
  - `newlyFailing=0`
  - `decisionPath` 覆盖：`1000/1000`
  - accepted decision：`984`
  - rejected decision：`16`
  - `repairApplied=175`
- gate：
  - `pnpm benchmark:online-sample:gate -- --report .artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase4-pipeline-result.json --min-newly-passing 0`
  - 结果：通过

已完成的第十五步：

- 新增 `src/core/pipelineRuntime.js#createAlphaRepairPipelineRuntime(...)`。
- `src/core/watermarkProcessor.js` 不再直接内联 alpha / repair 段的状态提交胶水：
  - 原来的 `readPipelineState() -> createPipelineStateCommit(...) -> applyPipelineState(...)`
  - 现在统一为 `commitPipelineResult(...)`
- runtime 现在承接：
  - `alphaAdjustmentStages`
  - `alphaTrialEvents`
  - `recordAlphaAdjustmentStage(...)`
  - `recordAlphaTrialEvent(...)`
  - `commitPipelineResult(...)`
  - `assignTailDebugTimings(...)`
- `createPipelineStateCommit(...)` 和 `createTailDebugTimings(...)` 仍然是底层 helper；runtime 只是把 alpha / repair 执行段所需的状态、trace、timing 边界统一起来。
- 这一步仍不迁移任何策略主体，不改变候选检测、alpha 逼近、repair 执行顺序、stage/event 内容、timing 字段或输出像素。

验证证据：

- `node --check src/core/pipelineRuntime.js`
  - 结果：通过
- `node --check src/core/watermarkProcessor.js`
  - 结果：通过
- `pnpm exec node --test tests/core/pipelineRuntime.test.js tests/core/pipelineResult.test.js tests/core/pipelineTimings.test.js tests/core/pipelineRepairGates.test.js tests/core/pipelineState.test.js tests/core/pipelineMetrics.test.js tests/core/pipelineInitialSelection.test.js tests/core/pipelineMeta.test.js tests/core/pipelineTrace.test.js tests/core/candidateEvaluation.test.js`
  - 结果：`pass=35`，`fail=0`
- `pnpm exec node --test tests/core/watermarkProcessor.test.js`
  - 结果：`pass=61`，`fail=0`，`skipped=3`
- `pnpm build`
  - 结果：通过
- full benchmark：
  - report：`.artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase4-pipeline-runtime.json`
  - markdown：`.artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase4-pipeline-runtime.md`
  - 结果：`978/1000 = 97.80%`
  - `newlyPassing=0`
  - `newlyFailing=0`
  - `decisionPath` 覆盖：`1000/1000`
  - accepted decision：`984`
  - rejected decision：`16`
  - `repairApplied=175`
- gate：
  - `pnpm benchmark:online-sample:gate -- --report .artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase4-pipeline-runtime.json --min-newly-passing 0`
  - 结果：通过

已完成的第十六步：

- 扩展 `src/core/pipelineResult.js`，新增 `createRejectedPipelineResult(...)`。
- `src/core/watermarkProcessor.js` 的 no-target / skipped 早返回不再手工拼装：
  - `imageData`
  - `meta`
  - `debugTimings`
- accepted 和 rejected 两条输出路径现在都通过 result 层：
  - `createAcceptedPipelineResult(...)`
  - `createRejectedPipelineResult(...)`
- `createRejectedPipelineResult(...)` 仍复用 `createRejectedWatermarkMeta(...)`，因此 rejected decisionPath / meta contract 没有改变。
- 这一步只迁移 skipped 返回封装，不改变检测候选、skip 判定、evaluation 决策、alpha / repair 执行或输出像素。

验证证据：

- `node --check src/core/pipelineResult.js`
  - 结果：通过
- `node --check src/core/watermarkProcessor.js`
  - 结果：通过
- `pnpm exec node --test tests/core/pipelineRuntime.test.js tests/core/pipelineResult.test.js tests/core/pipelineTimings.test.js tests/core/pipelineRepairGates.test.js tests/core/pipelineState.test.js tests/core/pipelineMetrics.test.js tests/core/pipelineInitialSelection.test.js tests/core/pipelineMeta.test.js tests/core/pipelineTrace.test.js tests/core/candidateEvaluation.test.js`
  - 结果：`pass=36`，`fail=0`
- `pnpm exec node --test tests/core/watermarkProcessor.test.js`
  - 结果：`pass=61`，`fail=0`，`skipped=3`
- `pnpm build`
  - 结果：通过
- full benchmark：
  - report：`.artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase4-rejected-pipeline-result.json`
  - markdown：`.artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase4-rejected-pipeline-result.md`
  - 结果：`978/1000 = 97.80%`
  - `newlyPassing=0`
  - `newlyFailing=0`
  - `decisionPath` 覆盖：`1000/1000`
  - accepted decision：`984`
  - rejected decision：`16`
  - `repairApplied=175`
- gate：
  - `pnpm benchmark:online-sample:gate -- --report .artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase4-rejected-pipeline-result.json --min-newly-passing 0`
  - 结果：通过

已完成的第十七步：

- 扩展 `src/core/pipelineRuntime.js`，新增 `acceptAlphaTrialResult(...)`。
- `src/core/watermarkProcessor.js` 中三个同构 alpha trial 接入 runtime：
  - `over-subtraction-recalibration`
  - `dark-catalog-fine-alpha`
  - `weak-positive-residual-fine-alpha`
- 这些片段原本都执行相同流程：
  - 记录 `alphaAdjustmentStage`
  - 记录 `alphaTrialEvent`
  - `commitPipelineResult(...)`
- 现在这些“记录 + event + commit”胶水由 runtime 统一承接，策略计算函数仍留在原处：
  - `recalibrateOverSubtractedAlpha(...)`
  - `fineTuneDarkCatalogAlpha(...)`
  - `fineTuneWeakPositiveResidualAlpha(...)`
- 这一步迁移的是 alpha trial 执行边界，不改变 alpha 逼近策略、阈值、source 规则、stage/event 字段、repair 顺序或输出像素。

验证证据：

- `node --check src/core/pipelineRuntime.js`
  - 结果：通过
- `node --check src/core/watermarkProcessor.js`
  - 结果：通过
- `pnpm exec node --test tests/core/pipelineRuntime.test.js tests/core/pipelineResult.test.js tests/core/pipelineTimings.test.js tests/core/pipelineRepairGates.test.js tests/core/pipelineState.test.js tests/core/pipelineMetrics.test.js tests/core/pipelineInitialSelection.test.js tests/core/pipelineMeta.test.js tests/core/pipelineTrace.test.js tests/core/candidateEvaluation.test.js`
  - 结果：`pass=37`，`fail=0`
- `pnpm exec node --test tests/core/watermarkProcessor.test.js`
  - 结果：`pass=61`，`fail=0`，`skipped=3`
  - 注：本轮测试耗时超过此前 `120s` 窗口，使用更长超时重跑后通过。
- `pnpm build`
  - 结果：通过
- full benchmark：
  - report：`.artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase4-alpha-trial-runtime.json`
  - markdown：`.artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase4-alpha-trial-runtime.md`
  - 结果：`978/1000 = 97.80%`
  - `newlyPassing=0`
  - `newlyFailing=0`
  - `decisionPath` 覆盖：`1000/1000`
  - accepted decision：`984`
  - rejected decision：`16`
  - `repairApplied=175`
- gate：
  - `pnpm benchmark:online-sample:gate -- --report .artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase4-alpha-trial-runtime.json --min-newly-passing 0`
  - 结果：通过

已完成的第十八步：

- 扩展 `src/core/pipelineRuntime.js`，新增 `acceptRepairTrialResult(...)`。
- `src/core/watermarkProcessor.js` 中三个低耦合 repair trial 接入 runtime：
  - `known-48-flat-background-fill`
  - `known-48-luma-edge-correction`
  - `new-margin-96-flat-background-fill`
- 这些片段原本都执行相同流程：
  - 记录 repair-flavored `alphaAdjustmentStage`
  - `commitPipelineResult(...)`
- 现在这些“repair stage + commit”胶水由 runtime 统一承接，策略计算函数仍留在原处：
  - `refineKnown48FlatBackgroundResidual(...)`
  - `refineKnown48LumaEdgeResidual(...)`
  - `refineNewMargin96FlatBackgroundResidual(...)`
- 这一步迁移的是 repair trial 执行边界，不改变 repair 策略、阈值、source 规则、stage 字段、alpha trial event、执行顺序或输出像素。

验证证据：

- `node --check src/core/pipelineRuntime.js`
  - 结果：通过
- `node --check src/core/watermarkProcessor.js`
  - 结果：通过
- `pnpm exec node --test tests/core/pipelineRuntime.test.js tests/core/pipelineResult.test.js tests/core/pipelineTimings.test.js tests/core/pipelineRepairGates.test.js tests/core/pipelineState.test.js tests/core/pipelineMetrics.test.js tests/core/pipelineInitialSelection.test.js tests/core/pipelineMeta.test.js tests/core/pipelineTrace.test.js tests/core/candidateEvaluation.test.js`
  - 结果：`pass=38`，`fail=0`
- `pnpm exec node --test tests/core/watermarkProcessor.test.js`
  - 结果：`pass=61`，`fail=0`，`skipped=3`
- `pnpm build`
  - 结果：通过
- full benchmark：
  - report：`.artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase4-repair-trial-runtime.json`
  - markdown：`.artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase4-repair-trial-runtime.md`
  - 结果：`978/1000 = 97.80%`
  - `newlyPassing=0`
  - `newlyFailing=0`
  - `decisionPath` 覆盖：`1000/1000`
  - accepted decision：`984`
  - rejected decision：`16`
  - `repairApplied=175`
- gate：
  - `pnpm benchmark:online-sample:gate -- --report .artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase4-repair-trial-runtime.json --min-newly-passing 0`
  - 结果：通过

已完成的第十九步：

- 继续扩大 `acceptRepairTrialResult(...)` 的覆盖范围。
- `src/core/watermarkProcessor.js` 中第二批纯 repair trial 接入 runtime：
  - `canonical-96-positive-halo-rescue`
  - `smooth-located-estimated-prior`
  - `known-48-small-margin-prior-repair`
  - `small-located-prior-repair`
  - `known-48-boundary-repair-rescue`
  - `dark-halo-low-logo-rescue`
  - `quantized-body-correction`
  - `known-48-mid-core-bias-correction`
- 这些片段原本都执行同构流程：
  - 记录 repair-flavored `alphaAdjustmentStage`
  - `commitPipelineResult(...)`
- 现在这些“repair stage + commit”胶水统一由 runtime 承接；策略函数、阈值、候选筛选和执行顺序仍留在原处。
- 本轮没有迁移带额外副作用的片段，例如：
  - preview edge cleanup 的局部函数和耗时累计
  - small preview / small fixed-local geometry 调整
  - located aggressive 的 alpha event / pass 计数 / stop reason
  - new-margin variant / power-profile / positive-rebalance 等 alpha trial
- 这一步迁移的是第二批 repair trial 执行边界，不改变 repair 策略、source 规则、stage 字段、alpha trial event、pass 统计或输出像素。

验证证据：

- `node --check src/core/pipelineRuntime.js`
  - 结果：通过
- `node --check src/core/watermarkProcessor.js`
  - 结果：通过
- `pnpm exec node --test tests/core/pipelineRuntime.test.js tests/core/pipelineResult.test.js tests/core/pipelineTimings.test.js tests/core/pipelineRepairGates.test.js tests/core/pipelineState.test.js tests/core/pipelineMetrics.test.js tests/core/pipelineInitialSelection.test.js tests/core/pipelineMeta.test.js tests/core/pipelineTrace.test.js tests/core/candidateEvaluation.test.js`
  - 结果：`pass=38`，`fail=0`
- `pnpm exec node --test tests/core/watermarkProcessor.test.js`
  - 结果：`pass=61`，`fail=0`，`skipped=3`
- `pnpm build`
  - 结果：通过
- full benchmark：
  - report：`.artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase4-repair-trial-runtime-batch2.json`
  - markdown：`.artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase4-repair-trial-runtime-batch2.md`
  - 结果：`978/1000 = 97.80%`
  - `newlyPassing=0`
  - `newlyFailing=0`
  - `decisionPath` 覆盖：`1000/1000`
  - accepted decision：`984`
  - rejected decision：`16`
  - `repairApplied=175`
- gate：
  - `pnpm benchmark:online-sample:gate -- --report .artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase4-repair-trial-runtime-batch2.json --min-newly-passing 0`
  - 结果：通过

已完成的第二十步：

- 扩展 `src/core/pipelineRuntime.js`，新增 `acceptAlphaStageResult(...)`。
- `src/core/watermarkProcessor.js` 中无 event 的 alpha-flavored stage + commit 片段接入 runtime：
  - `new-margin-96-variant-rescue`
  - `known-48-anti-template-rescue`
  - `known-48-power-profile-rescue`
  - `known-48-positive-residual-rebalance`
- 这些片段原本只执行：
  - 记录 `alphaAdjustmentStage`
  - `commitPipelineResult(...)`
- 它们不记录 `alphaTrialEvent`；`acceptAlphaStageResult(...)` 也保持这一点，不向 `alphaTrialEvents` 添加新事件。
- 这一步迁移的是无 event alpha stage 的执行边界，不改变 alpha 逼近策略、阈值、source 规则、profileExponent、allowSameAlphaGain、decisionPath event 列表、repair 顺序或输出像素。

验证证据：

- `node --check src/core/pipelineRuntime.js`
  - 结果：通过
- `node --check src/core/watermarkProcessor.js`
  - 结果：通过
- `pnpm exec node --test tests/core/pipelineRuntime.test.js tests/core/pipelineResult.test.js tests/core/pipelineTimings.test.js tests/core/pipelineRepairGates.test.js tests/core/pipelineState.test.js tests/core/pipelineMetrics.test.js tests/core/pipelineInitialSelection.test.js tests/core/pipelineMeta.test.js tests/core/pipelineTrace.test.js tests/core/candidateEvaluation.test.js`
  - 结果：`pass=39`，`fail=0`
- `pnpm exec node --test tests/core/watermarkProcessor.test.js`
  - 结果：`pass=61`，`fail=0`，`skipped=3`
- `pnpm build`
  - 结果：通过
- full benchmark：
  - report：`.artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase4-alpha-stage-runtime.json`
  - markdown：`.artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase4-alpha-stage-runtime.md`
  - 结果：`978/1000 = 97.80%`
  - `newlyPassing=0`
  - `newlyFailing=0`
  - `decisionPath` 覆盖：`1000/1000`
  - accepted decision：`984`
  - rejected decision：`16`
  - `repairApplied=175`
- gate：
  - `pnpm benchmark:online-sample:gate -- --report .artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase4-alpha-stage-runtime.json --min-newly-passing 0`
  - 结果：通过

已完成的第二十一步：

- `src/core/watermarkProcessor.js` 中 `recalibration` stage 接入 `acceptAlphaStageResult(...)`。
- 这一步只迁移 recalibration 的“记录 `alphaAdjustmentStage` + commit”边界。
- 保持原有行为不变：
  - `recalibrateAlphaStrength(...)` 策略函数仍留在原处
  - `recalibratedGradientScore` 仍在提交前按原逻辑重新计算
  - `afterSpatialScore` 仍使用 `recalibrated.processedSpatialScore`
  - source 仍保持 `adaptive+gain` 或 `${source}+gain`
  - 不新增 `alphaTrialEvent`
- 这一步不改变 alpha 逼近策略、阈值、decisionPath event 列表、repair 顺序或输出像素。

验证证据：

- `node --check src/core/pipelineRuntime.js`
  - 结果：通过
- `node --check src/core/watermarkProcessor.js`
  - 结果：通过
- `pnpm exec node --test tests/core/pipelineRuntime.test.js tests/core/pipelineResult.test.js tests/core/pipelineTimings.test.js tests/core/pipelineRepairGates.test.js tests/core/pipelineState.test.js tests/core/pipelineMetrics.test.js tests/core/pipelineInitialSelection.test.js tests/core/pipelineMeta.test.js tests/core/pipelineTrace.test.js tests/core/candidateEvaluation.test.js`
  - 结果：`pass=39`，`fail=0`
- `pnpm exec node --test tests/core/watermarkProcessor.test.js`
  - 结果：`pass=61`，`fail=0`，`skipped=3`
- `pnpm build`
  - 结果：通过
- full benchmark：
  - report：`.artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase4-recalibration-runtime.json`
  - markdown：`.artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase4-recalibration-runtime.md`
  - 结果：`978/1000 = 97.80%`
  - `newlyPassing=0`
  - `newlyFailing=0`
  - `decisionPath` 覆盖：`1000/1000`
  - accepted decision：`984`
  - rejected decision：`16`
  - `repairApplied=175`
- gate：
  - `pnpm benchmark:online-sample:gate -- --report .artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase4-recalibration-runtime.json --min-newly-passing 0`
  - 结果：通过

已完成的第二十二步：

- `src/core/watermarkProcessor.js` 中剩余的低耦合 stage/commit 片段接入 runtime：
  - preview / known-48 / v2-small edge cleanup：接入 `acceptRepairTrialResult(...)`
  - `subpixel-outline-refinement`：接入 `acceptAlphaStageResult(...)`
  - `small-preview-refinement`：接入 `acceptAlphaStageResult(...)`
  - `small-fixed-local-anchor-relocation`：接入 `acceptAlphaStageResult(...)`
- 这一步只迁移“stage + commit”胶水；保留原有局部副作用和特殊逻辑：
  - `previewEdgeCleanupElapsedMs` 仍在局部函数里累计
  - `subpixelShift = refined.shift` 仍在原处赋值
  - small preview 的 config 仍按 position 派生后提交
  - small fixed-local 仍通过 `allowSameAlphaGain` 允许同 alpha stage 记录
- 本轮没有迁移 located aggressive，因为它同时更新 alpha trial event、passes、passCount、attemptedPassCount 和 passStopReason。
- 这一步不改变 cleanup / subpixel / geometry 策略、阈值、source 规则、event 列表、pass 统计或输出像素。

验证证据：

- `node --check src/core/pipelineRuntime.js`
  - 结果：通过
- `node --check src/core/watermarkProcessor.js`
  - 结果：通过
- `pnpm exec node --test tests/core/pipelineRuntime.test.js tests/core/pipelineResult.test.js tests/core/pipelineTimings.test.js tests/core/pipelineRepairGates.test.js tests/core/pipelineState.test.js tests/core/pipelineMetrics.test.js tests/core/pipelineInitialSelection.test.js tests/core/pipelineMeta.test.js tests/core/pipelineTrace.test.js tests/core/candidateEvaluation.test.js`
  - 结果：`pass=39`，`fail=0`
- `pnpm exec node --test tests/core/watermarkProcessor.test.js`
  - 结果：`pass=61`，`fail=0`，`skipped=3`
- `pnpm build`
  - 结果：通过
- full benchmark：
  - report：`.artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase4-remaining-stage-runtime.json`
  - markdown：`.artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase4-remaining-stage-runtime.md`
  - 结果：`978/1000 = 97.80%`
  - `newlyPassing=0`
  - `newlyFailing=0`
  - `decisionPath` 覆盖：`1000/1000`
  - accepted decision：`984`
  - rejected decision：`16`
  - `repairApplied=175`
- gate：
  - `pnpm benchmark:online-sample:gate -- --report .artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase4-remaining-stage-runtime.json --min-newly-passing 0`
  - 结果：通过

已完成的第二十三步：

- `src/core/pipelineRuntime.js` 新增 `acceptLocatedAggressiveResult(...)`，把 located aggressive 成功路径里的 stage、alpha trial event、pass metadata 和最终 commit 收到 runtime 边界内。
- `src/core/watermarkProcessor.js` 的 located aggressive 成功分支不再手写 `recordAlphaAdjustmentStage(...)` / `recordAlphaTrialEvent(...)` / `passes.push(...)` / `commitPipelineResult(...)`；现在只接收 runtime 返回的 `passIncrement` 和 `passStopReason`，再显式更新 `passCount`、`attemptedPassCount`、`passStopReason`。
- located aggressive 的 reject callback 保持原样，仍由局部 `onRejected` 写入 reject trial event。
- 保持行为不变：
  - stage 字段、alpha trial event 字段、pass entry 字段保持原形状
  - source 仍按原规则追加 `+located-aggressive`
  - pass counter 仍按 `Math.max(1, repeatCount || 1)` 增量
  - `edgeCleanup` 仍映射到 `located-aggressive-edge-cleanup` stop reason
  - 不改变阈值、alpha、repair、geometry 或输出像素

验证证据：

- `node --check src/core/pipelineRuntime.js`
  - 结果：通过
- `node --check src/core/watermarkProcessor.js`
  - 结果：通过
- `pnpm exec node --test tests/core/pipelineRuntime.test.js tests/core/pipelineResult.test.js tests/core/pipelineTimings.test.js tests/core/pipelineRepairGates.test.js tests/core/pipelineState.test.js tests/core/pipelineMetrics.test.js tests/core/pipelineInitialSelection.test.js tests/core/pipelineMeta.test.js tests/core/pipelineTrace.test.js tests/core/candidateEvaluation.test.js`
  - 结果：`pass=40`，`fail=0`
- `pnpm exec node --test tests/core/watermarkProcessor.test.js`
  - 结果：`pass=61`，`fail=0`，`skipped=3`
- `pnpm build`
  - 结果：通过
- full benchmark：
  - report：`.artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase4-located-aggressive-runtime.json`
  - markdown：`.artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase4-located-aggressive-runtime.md`
  - 结果：`978/1000 = 97.80%`
  - `newlyPassing=0`
  - `newlyFailing=0`
  - `decisionPath` 覆盖：`1000/1000`
  - accepted decision：`984`
  - rejected decision：`16`
  - `repairApplied=175`
- gate：
  - `pnpm benchmark:online-sample:gate -- --report .artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase4-located-aggressive-runtime.json --min-newly-passing 0`
  - 结果：通过

已完成的第二十四步：

- `src/core/pipelineRuntime.js` 新增 `acceptPreviewBackgroundCleanupResult(...)`，把 preview smooth background cleanup 的安全门和 commit 收到 runtime 边界内。
- `src/core/watermarkProcessor.js` 仍保留 cleaned 图生成、spatial / gradient / near-black 测量这些图像算法步骤；主函数不再直接调用 `commitPipelineResult(...)` 写入 background cleanup 结果。
- 新 helper 保持原安全条件：
  - `Math.abs(cleanedSpatialScore) <= Math.abs(baselineSpatialScore)`
  - `cleanedNearBlackRatio <= currentNearBlackRatio + maxNearBlackRatioIncrease`
- 拒绝时返回 `null`，不写 state；接受时只提交 `imageData`、`spatialScore`、`gradientScore` 和 source。
- 这一步不改变 preview background cleanup 的启用条件、图像修复算法、分数计算、近黑比例阈值、source 后缀或输出像素。

验证证据：

- `node --check src/core/pipelineRuntime.js`
  - 结果：通过
- `node --check src/core/watermarkProcessor.js`
  - 结果：通过
- `pnpm exec node --test tests/core/pipelineRuntime.test.js tests/core/pipelineResult.test.js tests/core/pipelineTimings.test.js tests/core/pipelineRepairGates.test.js tests/core/pipelineState.test.js tests/core/pipelineMetrics.test.js tests/core/pipelineInitialSelection.test.js tests/core/pipelineMeta.test.js tests/core/pipelineTrace.test.js tests/core/candidateEvaluation.test.js`
  - 结果：`pass=42`，`fail=0`
- `pnpm exec node --test tests/core/watermarkProcessor.test.js`
  - 结果：`pass=61`，`fail=0`，`skipped=3`
- `pnpm build`
  - 结果：通过
- full benchmark：
  - report：`.artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase4-background-cleanup-runtime.json`
  - markdown：`.artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase4-background-cleanup-runtime.md`
  - 结果：`978/1000 = 97.80%`
  - `newlyPassing=0`
  - `newlyFailing=0`
  - `decisionPath` 覆盖：`1000/1000`
  - accepted decision：`984`
  - rejected decision：`16`
  - `repairApplied=175`
- gate：
  - `pnpm benchmark:online-sample:gate -- --report .artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase4-background-cleanup-runtime.json --min-newly-passing 0`
  - 结果：通过

已完成的第二十五步：

- 新增 `src/core/pipelinePassState.js`，把 `processWatermarkImageData` 里的 pass 计数状态抽成独立 helper：
  - `createEmptyPipelinePassState()`
  - `createFirstPassPipelinePassState(...)`
  - `applyPipelinePassOutcome(...)`
- `src/core/watermarkProcessor.js` 不再维护独立的 `passCount`、`attemptedPassCount`、`passStopReason`、`passes` 局部变量；首轮 pass metadata 和 located aggressive 的增量现在统一落在 `passState`。
- located aggressive 仍由 `acceptLocatedAggressiveResult(...)` 写入同一个 `passes` 数组；`applyPipelinePassOutcome(...)` 只负责计数和 stop reason，不改变 pass entry 内容。
- 这一步不改变首轮 pass 记录、located aggressive pass 增量、stop reason、决策路径、图像策略或输出像素。

验证证据：

- `node --check src/core/pipelinePassState.js`
  - 结果：通过
- `node --check src/core/watermarkProcessor.js`
  - 结果：通过
- `pnpm exec node --test tests/core/pipelinePassState.test.js tests/core/pipelineRuntime.test.js tests/core/pipelineResult.test.js tests/core/pipelineTimings.test.js tests/core/pipelineRepairGates.test.js tests/core/pipelineState.test.js tests/core/pipelineMetrics.test.js tests/core/pipelineInitialSelection.test.js tests/core/pipelineMeta.test.js tests/core/pipelineTrace.test.js tests/core/candidateEvaluation.test.js`
  - 结果：`pass=45`，`fail=0`
- `pnpm exec node --test tests/core/watermarkProcessor.test.js`
  - 结果：`pass=61`，`fail=0`，`skipped=3`
- `pnpm build`
  - 结果：通过
- full benchmark：
  - report：`.artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase4-pass-state-runtime.json`
  - markdown：`.artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase4-pass-state-runtime.md`
  - 结果：`978/1000 = 97.80%`
  - `newlyPassing=0`
  - `newlyFailing=0`
  - `decisionPath` 覆盖：`1000/1000`
  - accepted decision：`984`
  - rejected decision：`16`
  - `repairApplied=175`
- gate：
  - `pnpm benchmark:online-sample:gate -- --report .artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase4-pass-state-runtime.json --min-newly-passing 0`
  - 结果：通过

已完成的第二十六步：

- `src/core/pipelineMetrics.js` 新增 `createRegionCorrelationMetrics(...)`，把 ROI spatial / gradient correlation 测分和可选 near-black ratio 统一收进 evaluation helper。
- `createFirstPassMetrics(...)` 内部改为复用 `createRegionCorrelationMetrics(...)`，保持原首轮 pass record 字段和值不变。
- `src/core/watermarkProcessor.js` 中 `processWatermarkImageData` 的两处重复测分接入新 helper：
  - final metrics 初始化：`processedMetrics = createRegionCorrelationMetrics(...)`
  - preview smooth background cleanup：`cleanedMetrics = createRegionCorrelationMetrics(..., includeNearBlackRatio: true)`
- 这一步不迁移其它文件内的低层 scoring 调用，不改变任何检测、alpha、repair 策略、分数公式、近黑比例公式、阈值、source 或输出像素。

验证证据：

- `node --check src/core/pipelineMetrics.js`
  - 结果：通过
- `node --check src/core/watermarkProcessor.js`
  - 结果：通过
- `pnpm exec node --test tests/core/pipelinePassState.test.js tests/core/pipelineRuntime.test.js tests/core/pipelineResult.test.js tests/core/pipelineTimings.test.js tests/core/pipelineRepairGates.test.js tests/core/pipelineState.test.js tests/core/pipelineMetrics.test.js tests/core/pipelineInitialSelection.test.js tests/core/pipelineMeta.test.js tests/core/pipelineTrace.test.js tests/core/candidateEvaluation.test.js`
  - 结果：`pass=46`，`fail=0`
- `pnpm exec node --test tests/core/watermarkProcessor.test.js`
  - 结果：`pass=61`，`fail=0`，`skipped=3`
- `pnpm build`
  - 结果：通过
- full benchmark：
  - report：`.artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase4-region-metrics-runtime.json`
  - markdown：`.artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase4-region-metrics-runtime.md`
  - 结果：`978/1000 = 97.80%`
  - `newlyPassing=0`
  - `newlyFailing=0`
  - `decisionPath` 覆盖：`1000/1000`
  - accepted decision：`984`
  - rejected decision：`16`
  - `repairApplied=175`
- gate：
  - `pnpm benchmark:online-sample:gate -- --report .artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase4-region-metrics-runtime.json --min-newly-passing 0`
  - 结果：通过

已完成的第二十七步：

- `src/core/pipelineRuntime.js` 新增 current-state stage 提交 helper：
  - `acceptCurrentAlphaStageResult(...)`
  - `acceptCurrentRepairTrialResult(...)`
- 这两个 helper 从 `readState()` 补齐当前 `alphaGain`、`finalProcessedSpatialScore`、`finalProcessedGradientScore`，再记录 stage 并 commit；主函数不再需要在 tail residual stages 里反复传 `fromAlphaGain` / before spatial / before gradient。
- `acceptCurrentRepairTrialResult(...)` 支持 `deriveSuppressionGainFromOriginalSpatial`，用于保留原先 `originalSpatialScore - result.spatialScore` 的 suppressionGain 语义。
- `src/core/watermarkProcessor.js` 中 located aggressive 之后的 tail residual stages 已接入 current-state helper：
  - `canonical-96-positive-halo-rescue`
  - `smooth-located-estimated-prior`
  - `new-margin-96-variant-rescue`
  - `known-48-anti-template-rescue`
  - `known-48-power-profile-rescue`
  - `known-48-positive-residual-rebalance`
  - `known-48-small-margin-prior-repair`
  - `small-located-prior-repair`
  - `known-48-boundary-repair-rescue`
  - `dark-halo-low-logo-rescue`
  - `quantized-body-correction`
  - `known-48-mid-core-bias-correction`
- 这一步不改变任何 refine 输入、stage 名、strategy、source 后缀、suppressionGain 公式、stageExtras、阈值或输出像素。

验证证据：

- `node --check src/core/pipelineRuntime.js`
  - 结果：通过
- `node --check src/core/watermarkProcessor.js`
  - 结果：通过
- `pnpm exec node --test tests/core/pipelinePassState.test.js tests/core/pipelineRuntime.test.js tests/core/pipelineResult.test.js tests/core/pipelineTimings.test.js tests/core/pipelineRepairGates.test.js tests/core/pipelineState.test.js tests/core/pipelineMetrics.test.js tests/core/pipelineInitialSelection.test.js tests/core/pipelineMeta.test.js tests/core/pipelineTrace.test.js tests/core/candidateEvaluation.test.js`
  - 结果：`pass=48`，`fail=0`
- `pnpm exec node --test tests/core/watermarkProcessor.test.js`
  - 结果：`pass=61`，`fail=0`，`skipped=3`
- `pnpm build`
  - 结果：通过
- full benchmark：
  - report：`.artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase4-current-stage-runtime.json`
  - markdown：`.artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase4-current-stage-runtime.md`
  - 结果：`978/1000 = 97.80%`
  - `newlyPassing=0`
  - `newlyFailing=0`
  - `decisionPath` 覆盖：`1000/1000`
  - accepted decision：`984`
  - rejected decision：`16`
  - `repairApplied=175`
- gate：
  - `pnpm benchmark:online-sample:gate -- --report .artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase4-current-stage-runtime.json --min-newly-passing 0`
  - 结果：通过

已完成的第二十八步：

- `src/core/watermarkProcessor.js` 将 located aggressive 之前的低耦合 cleanup / refinement stages 继续接入 current-state helper：
  - preview / known-48 / v2-small edge cleanup
  - `subpixel-outline-refinement`
  - `known-48-flat-background-fill`
  - `known-48-luma-edge-correction`
  - `new-margin-96-flat-background-fill`
  - `small-preview-refinement`
  - `small-fixed-local-anchor-relocation`
- `acceptRepairTrialResult(...)` 已不再由 `processWatermarkImageData` 直接调用；普通 repair stage 都通过 `acceptCurrentRepairTrialResult(...)` 从 runtime 读取当前 `alphaGain` 和 before scores。
- `acceptAlphaStageResult(...)` 在主函数中仅保留给 `recalibration`，因为该路径显式传入 `afterSpatialScore: recalibrated.processedSpatialScore` 和重新计算的 gradient，是特殊形态。
- `tests/core/pipelineRuntime.test.js` 增加 explicit-null suppressionGain 契约，确保 `subpixel-outline-refinement` 这类 `suppressionGain: null` 的 stage 不会被默认值覆盖。
- 这一步不改变任何 refine 输入、stage 名、strategy、source 后缀、suppressionGain 公式、本地副作用（例如 `subpixelShift`）、阈值或输出像素。

验证证据：

- `node --check src/core/watermarkProcessor.js`
  - 结果：通过
- `node --check src/core/pipelineRuntime.js`
  - 结果：通过
- `pnpm exec node --test tests/core/pipelinePassState.test.js tests/core/pipelineRuntime.test.js tests/core/pipelineResult.test.js tests/core/pipelineTimings.test.js tests/core/pipelineRepairGates.test.js tests/core/pipelineState.test.js tests/core/pipelineMetrics.test.js tests/core/pipelineInitialSelection.test.js tests/core/pipelineMeta.test.js tests/core/pipelineTrace.test.js tests/core/candidateEvaluation.test.js`
  - 结果：`pass=49`，`fail=0`
- `pnpm exec node --test tests/core/watermarkProcessor.test.js`
  - 结果：`pass=61`，`fail=0`，`skipped=3`
- `pnpm build`
  - 结果：通过
- full benchmark：
  - report：`.artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase4-current-stage-runtime-batch2.json`
  - markdown：`.artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase4-current-stage-runtime-batch2.md`
  - 结果：`978/1000 = 97.80%`
  - `newlyPassing=0`
  - `newlyFailing=0`
  - `decisionPath` 覆盖：`1000/1000`
  - accepted decision：`984`
  - rejected decision：`16`
  - `repairApplied=175`
- gate：
  - `pnpm benchmark:online-sample:gate -- --report .artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase4-current-stage-runtime-batch2.json --min-newly-passing 0`
  - 结果：通过

已完成的第二十九步：

- `src/core/pipelineRuntime.js` 新增 `acceptRecalibrationStageResult(...)`，把 recalibration 的特殊 stage 记录和 commit 规则收进 runtime：
  - stage 固定为 `recalibration`
  - before alpha / before scores 从 `readState()` 读取
  - `afterSpatialScore` 保持使用 `result.processedSpatialScore`
  - `afterGradientScore` 使用主函数按原逻辑重新计算后传入的 `gradientScore`
  - source 保持原规则：当前 source 为 `adaptive` 时写 `adaptive+gain`，否则写 `${source}+gain`
- `src/core/watermarkProcessor.js` 中 recalibration 不再直接调用 `acceptAlphaStageResult(...)`；主函数仍负责按原 alphaMap / position 计算 recalibrated gradient，避免改变分数公式。
- 这一步之后，`processWatermarkImageData` 已不再直接调用 `acceptAlphaStageResult(...)` 或 `acceptRepairTrialResult(...)`；stage 提交都通过更具体的 runtime helper 完成。
- 这一步不改变 recalibration 的启用条件、alpha 重估算法、gradient 计算方式、source 规则、stage 字段或输出像素。

验证证据：

- `node --check src/core/pipelineRuntime.js`
  - 结果：通过
- `node --check src/core/watermarkProcessor.js`
  - 结果：通过
- `pnpm exec node --test tests/core/pipelinePassState.test.js tests/core/pipelineRuntime.test.js tests/core/pipelineResult.test.js tests/core/pipelineTimings.test.js tests/core/pipelineRepairGates.test.js tests/core/pipelineState.test.js tests/core/pipelineMetrics.test.js tests/core/pipelineInitialSelection.test.js tests/core/pipelineMeta.test.js tests/core/pipelineTrace.test.js tests/core/candidateEvaluation.test.js`
  - 结果：`pass=50`，`fail=0`
- `pnpm exec node --test tests/core/watermarkProcessor.test.js`
  - 结果：`pass=61`，`fail=0`，`skipped=3`
- `pnpm build`
  - 结果：通过
- full benchmark：
  - report：`.artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase4-recalibration-stage-runtime.json`
  - markdown：`.artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase4-recalibration-stage-runtime.md`
  - 结果：`978/1000 = 97.80%`
  - `newlyPassing=0`
  - `newlyFailing=0`
  - `decisionPath` 覆盖：`1000/1000`
  - accepted decision：`984`
  - rejected decision：`16`
  - `repairApplied=175`
- gate：
  - `pnpm benchmark:online-sample:gate -- --report .artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase4-recalibration-stage-runtime.json --min-newly-passing 0`
  - 结果：通过

已完成的第三十步：

- `src/core/pipelineRuntime.js` 新增 `acceptCurrentAlphaTrialResult(...)`，把 alpha trial accept 路径中的 before alpha / before scores 读取收进 runtime：
  - `fromAlphaGain` 从当前 `alphaGain` 读取
  - `beforeSpatialScore` / `beforeGradientScore` 从当前 processed scores 读取
  - stage 和 alpha trial event 字段保持与 `acceptAlphaTrialResult(...)` 同形
- `src/core/watermarkProcessor.js` 中三个 alpha trial accept 分支已接入 current-state helper：
  - `over-subtraction-recalibration`
  - `dark-catalog-fine-alpha`
  - `weak-positive-residual-fine-alpha`
- 主函数不再为这些 alpha trial 手动保存 `beforeAlphaGain`，也不再直接解构或调用 `acceptAlphaTrialResult(...)`。
- 旧泛化 `acceptAlphaTrialResult(...)` 仍保留在 runtime 和契约测试中，作为底层兼容 helper；`processWatermarkImageData` 只使用更具体的 runtime helper。
- 这一步不改变 alpha trial 的触发条件、fine-tune 算法、source 规则、stage/event 字段、commit 规则或输出像素。

验证证据：

- `node --check src/core/pipelineRuntime.js`
  - 结果：通过
- `node --check src/core/watermarkProcessor.js`
  - 结果：通过
- `pnpm exec node --test tests/core/pipelinePassState.test.js tests/core/pipelineRuntime.test.js tests/core/pipelineResult.test.js tests/core/pipelineTimings.test.js tests/core/pipelineRepairGates.test.js tests/core/pipelineState.test.js tests/core/pipelineMetrics.test.js tests/core/pipelineInitialSelection.test.js tests/core/pipelineMeta.test.js tests/core/pipelineTrace.test.js tests/core/candidateEvaluation.test.js`
  - 结果：`pass=51`，`fail=0`
- `pnpm exec node --test tests/core/watermarkProcessor.test.js`
  - 结果：`pass=61`，`fail=0`，`skipped=3`
- `pnpm build`
  - 结果：通过
- full benchmark：
  - report：`.artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase4-current-alpha-trial-runtime.json`
  - markdown：`.artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase4-current-alpha-trial-runtime.md`
  - 结果：`978/1000 = 97.80%`
  - `newlyPassing=0`
  - `newlyFailing=0`
  - `decisionPath` 覆盖：`1000/1000`
  - accepted decision：`984`
  - rejected decision：`16`
  - `repairApplied=175`
- gate：
  - `pnpm benchmark:online-sample:gate -- --report .artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase4-current-alpha-trial-runtime.json --min-newly-passing 0`
  - 结果：通过

已完成的第三十一步：

- `src/core/pipelineResult.js` 新增 `createAcceptedPipelineResultFromState(...)`，把 accepted result 的字段映射从 `processWatermarkImageData` 尾部收进 result 层。
- 新 helper 只把 `pipelineState`、`passState`、`traceState`、`resultContext`、`residualVisibility`、`selectionDebug` 映射到既有 `createAcceptedPipelineResult(...)`；不改变 `createAcceptedWatermarkMeta(...)` 的输出结构。
- `src/core/watermarkProcessor.js` 尾部不再手写一长串 `createAcceptedPipelineResult({...})` 参数；现在传入：
  - `pipelineState: readPipelineState()`
  - `passState`
  - trace arrays
  - result context
  - `residualVisibility`
  - `selectionDebug`
- 主函数仍按原逻辑计算 residual visibility 和 selection debug；这一步只移动最终结果组装胶水。
- 这一步不改变最终 `imageData`、meta 字段、decisionPath、debugTimings、pass 统计、trace 列表或输出像素。

验证证据：

- `node --check src/core/pipelineResult.js`
  - 结果：通过
- `node --check src/core/watermarkProcessor.js`
  - 结果：通过
- `pnpm exec node --test tests/core/pipelinePassState.test.js tests/core/pipelineRuntime.test.js tests/core/pipelineResult.test.js tests/core/pipelineTimings.test.js tests/core/pipelineRepairGates.test.js tests/core/pipelineState.test.js tests/core/pipelineMetrics.test.js tests/core/pipelineInitialSelection.test.js tests/core/pipelineMeta.test.js tests/core/pipelineTrace.test.js tests/core/candidateEvaluation.test.js`
  - 结果：`pass=52`，`fail=0`
- `pnpm exec node --test tests/core/watermarkProcessor.test.js`
  - 结果：`pass=61`，`fail=0`，`skipped=3`
- `pnpm build`
  - 结果：通过
- full benchmark：
  - report：`.artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase4-accepted-result-state.json`
  - markdown：`.artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase4-accepted-result-state.md`
  - 结果：`978/1000 = 97.80%`
  - `newlyPassing=0`
  - `newlyFailing=0`
  - `decisionPath` 覆盖：`1000/1000`
  - accepted decision：`984`
  - rejected decision：`16`
  - `repairApplied=175`
- gate：
  - `pnpm benchmark:online-sample:gate -- --report .artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase4-accepted-result-state.json --min-newly-passing 0`
  - 结果：通过

已完成的第三十二步：

- `src/core/pipelineState.js` 新增 `createPipelineStateAccessors(...)`，把 pipeline state 的读写字段映射集中到 state 层：
  - `readPipelineState()`
  - `applyPipelineState(...)`
- `src/core/watermarkProcessor.js` 不再手写完整的 `readPipelineState` / `applyPipelineState` 字段列表；主函数只提供当前局部变量的 `get` / `set` 边界。
- runtime 仍通过同名 `readPipelineState` / `applyPipelineState` 与主函数状态交互，因此 commit 行为和 state 字段保持一致。
- 这一步不改变任何策略、阈值、stage/event、meta、decisionPath、debugTimings 或输出像素。

验证证据：

- `node --check src/core/pipelineState.js`
  - 结果：通过
- `node --check src/core/watermarkProcessor.js`
  - 结果：通过
- `pnpm exec node --test tests/core/pipelinePassState.test.js tests/core/pipelineRuntime.test.js tests/core/pipelineResult.test.js tests/core/pipelineTimings.test.js tests/core/pipelineRepairGates.test.js tests/core/pipelineState.test.js tests/core/pipelineMetrics.test.js tests/core/pipelineInitialSelection.test.js tests/core/pipelineMeta.test.js tests/core/pipelineTrace.test.js tests/core/candidateEvaluation.test.js`
  - 结果：`pass=53`，`fail=0`
- `pnpm exec node --test tests/core/watermarkProcessor.test.js`
  - 结果：`pass=61`，`fail=0`，`skipped=3`
- `pnpm build`
  - 结果：通过
- full benchmark：
  - report：`.artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase4-state-accessors.json`
  - markdown：`.artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase4-state-accessors.md`
  - 结果：`978/1000 = 97.80%`
  - `newlyPassing=0`
  - `newlyFailing=0`
  - `decisionPath` 覆盖：`1000/1000`
  - accepted decision：`984`
  - rejected decision：`16`
  - `repairApplied=175`
- gate：
  - `pnpm benchmark:online-sample:gate -- --report .artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase4-state-accessors.json --min-newly-passing 0`
  - 结果：通过

已完成的第三十三步：

- 新增 `src/core/pipelineFinalization.js#createAcceptedPipelineFinalResult(...)`，把 accepted result 尾部 finalization 胶水从 `processWatermarkImageData` 收出：
  - 计算最终 `residualVisibility`
  - 生成 `selectionDebug`
  - 调用 `createAcceptedPipelineResultFromState(...)`
- `src/core/watermarkProcessor.js` 尾部不再直接计算 residual visibility / selection debug / accepted result mapping；现在只传入当前 `pipelineState`、`passState`、trace、result context、`originalImageData`、`initialSelection` 和 `resolvedConfig`。
- `pipelineFinalization` 复用既有 `assessWatermarkResidualVisibility(...)`、`createSelectionDebugSummary(...)`、`calculateWatermarkPosition(...)` 和 result helper；不改变任何输出结构。
- 这一步不改变最终 `imageData`、meta 字段、decisionPath、debugTimings、pass 统计、trace 列表、selection debug、residual visibility 公式或输出像素。

验证证据：

- `node --check src/core/pipelineFinalization.js`
  - 结果：通过
- `node --check src/core/watermarkProcessor.js`
  - 结果：通过
- `pnpm exec node --test tests/core/pipelineFinalization.test.js tests/core/pipelinePassState.test.js tests/core/pipelineRuntime.test.js tests/core/pipelineResult.test.js tests/core/pipelineTimings.test.js tests/core/pipelineRepairGates.test.js tests/core/pipelineState.test.js tests/core/pipelineMetrics.test.js tests/core/pipelineInitialSelection.test.js tests/core/pipelineMeta.test.js tests/core/pipelineTrace.test.js tests/core/candidateEvaluation.test.js`
  - 结果：`pass=54`，`fail=0`
- `pnpm exec node --test tests/core/watermarkProcessor.test.js`
  - 结果：`pass=61`，`fail=0`，`skipped=3`
- `pnpm build`
  - 结果：通过
- full benchmark：
  - report：`.artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase4-finalization-helper.json`
  - markdown：`.artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase4-finalization-helper.md`
  - 结果：`978/1000 = 97.80%`
  - `newlyPassing=0`
  - `newlyFailing=0`
  - `decisionPath` 覆盖：`1000/1000`
  - accepted decision：`984`
  - rejected decision：`16`
  - `repairApplied=175`
- gate：
  - `pnpm benchmark:online-sample:gate -- --report .artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase4-finalization-helper.json --min-newly-passing 0`
  - 结果：通过

已完成的第三十四步：

- `src/core/pipelineState.js` 新增 `createInitialPipelineRuntimeState(...)`，把 accepted initial selection 和首轮 processed metrics 合成为初始 runtime pipeline state：
  - `finalProcessedSpatialScore`
  - `finalProcessedGradientScore`
  - `suppressionGain`
  - 当前 image / alphaMap / position / config / score / source 字段
- `src/core/watermarkProcessor.js` 不再直接用 `processedMetrics` 手写 `finalProcessed*` 和 `suppressionGain` 的初始种子；现在通过 `createInitialPipelineRuntimeState(...)` 接入。
- 同时清理 `createAlphaRepairPipelineRuntime(...)` 返回值中已经不被主函数直接使用的 `recordAlphaAdjustmentStage` / `commitPipelineResult` 解构，减少执行壳里的误导性胶水。
- 这一步只迁移初始 runtime state 的字段拼装，不改变 detection、alpha trial、repair trial、passState、debugTimings、meta、decisionPath 或输出像素。

验证证据：

- `node --check src/core/pipelineState.js`
  - 结果：通过
- `node --check src/core/watermarkProcessor.js`
  - 结果：通过
- `pnpm exec node --test tests/core/pipelineState.test.js`
  - 结果：`pass=7`，`fail=0`
- `pnpm exec node --test tests/core/pipelineFinalization.test.js tests/core/pipelinePassState.test.js tests/core/pipelineRuntime.test.js tests/core/pipelineResult.test.js tests/core/pipelineTimings.test.js tests/core/pipelineRepairGates.test.js tests/core/pipelineState.test.js tests/core/pipelineMetrics.test.js tests/core/pipelineInitialSelection.test.js tests/core/pipelineMeta.test.js tests/core/pipelineTrace.test.js tests/core/candidateEvaluation.test.js`
  - 结果：`pass=55`，`fail=0`
- `pnpm exec node --test tests/core/watermarkProcessor.test.js`
  - 结果：`pass=61`，`fail=0`，`skipped=3`
- `pnpm build`
  - 结果：通过
- full benchmark：
  - report：`.artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase4-initial-runtime-state.json`
  - markdown：`.artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase4-initial-runtime-state.md`
  - 结果：`978/1000 = 97.80%`
  - `newlyPassing=0`
  - `newlyFailing=0`
  - `decisionPath` 覆盖：`1000/1000`
  - accepted decision：`984`
  - rejected decision：`16`
  - `repairApplied=175`
- gate：
  - `pnpm benchmark:online-sample:gate -- --report .artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase4-initial-runtime-state.json --min-newly-passing 0`
  - 结果：通过

已完成的第三十五步：

- `src/core/pipelineRuntime.js` 新增 `runCurrentAlphaTrialStage(...)`，把“生成 current-state alpha trial -> 若存在则 accept -> 写入 debug timing”的重复执行形态收进 runtime 层。
- `src/core/watermarkProcessor.js` 中以下三段 alpha 逼近调度改为使用 `runCurrentAlphaTrialStage(...)`：
  - `over-subtraction-recalibration`
  - `dark-catalog-fine-alpha`
  - `weak-positive-residual-fine-alpha`
- 具体 alpha trial 生成函数仍保持原位：
  - `recalibrateOverSubtractedAlpha(...)`
  - `fineTuneDarkCatalogAlpha(...)`
  - `fineTuneWeakPositiveResidualAlpha(...)`
- 这一步只迁移 current-state alpha trial 的调度外壳，不改变 trial 生成、accept 条件、source 后缀、trace 字段、debugTimings 字段名、meta、decisionPath 或输出像素。

验证证据：

- `node --check src/core/pipelineRuntime.js`
  - 结果：通过
- `node --check src/core/watermarkProcessor.js`
  - 结果：通过
- `pnpm exec node --test tests/core/pipelineRuntime.test.js`
  - 结果：`pass=15`，`fail=0`
- `pnpm exec node --test tests/core/pipelineFinalization.test.js tests/core/pipelinePassState.test.js tests/core/pipelineRuntime.test.js tests/core/pipelineResult.test.js tests/core/pipelineTimings.test.js tests/core/pipelineRepairGates.test.js tests/core/pipelineState.test.js tests/core/pipelineMetrics.test.js tests/core/pipelineInitialSelection.test.js tests/core/pipelineMeta.test.js tests/core/pipelineTrace.test.js tests/core/candidateEvaluation.test.js`
  - 结果：`pass=57`，`fail=0`
- `pnpm exec node --test tests/core/watermarkProcessor.test.js`
  - 结果：`pass=61`，`fail=0`，`skipped=3`
- `pnpm build`
  - 结果：通过
- full benchmark：
  - report：`.artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase4-current-alpha-trial-stage.json`
  - markdown：`.artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase4-current-alpha-trial-stage.md`
  - 结果：`978/1000 = 97.80%`
  - `newlyPassing=0`
  - `newlyFailing=0`
  - `decisionPath` 覆盖：`1000/1000`
  - accepted decision：`984`
  - rejected decision：`16`
  - `repairApplied=175`
- gate：
  - `pnpm benchmark:online-sample:gate -- --report .artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase4-current-alpha-trial-stage.json --min-newly-passing 0`
  - 结果：通过

已完成的第三十六步：

- `src/core/pipelineRuntime.js` 新增：
  - `runCurrentAlphaStage(...)`
  - `runCurrentRepairStage(...)`
- 这两个 helper 把“生成 current-state stage result -> 若存在则提交到 runtime accept helper”的直线调度外壳从 `processWatermarkImageData` 收进 runtime 层。
- `src/core/watermarkProcessor.js` 已迁移一批无循环、无 passState 特殊副作用的 alpha / repair stage 调度：
  - `new-margin-96-flat-background-fill`
  - `small-preview-refinement`
  - `small-fixed-local-anchor-relocation`
  - `canonical-96-positive-halo-rescue`
  - `smooth-located-estimated-prior`
  - `new-margin-96-variant-rescue`
  - `known-48-anti-template-rescue`
  - `known-48-power-profile-rescue`
  - `known-48-positive-residual-rebalance`
  - `known-48-small-margin-prior-repair`
  - `small-located-prior-repair`
  - `known-48-boundary-repair-rescue`
  - `dark-halo-low-logo-rescue`
  - `quantized-body-correction`
  - `known-48-mid-core-bias-correction`
- 循环型 cleanup、`subpixelShift` 副作用、`located-aggressive` 的 passState 写回仍保留在主函数里，避免在这一刀里混入行为风险。
- 这一步只迁移 stage 调度外壳，不改变 trial / repair 生成函数、接受条件、source 后缀、stageExtras、suppressionGain 取值、trace 字段、meta、decisionPath 或输出像素。

验证证据：

- `node --check src/core/pipelineRuntime.js`
  - 结果：通过
- `node --check src/core/watermarkProcessor.js`
  - 结果：通过
- `pnpm exec node --test tests/core/pipelineRuntime.test.js`
  - 结果：`pass=18`，`fail=0`
- `pnpm exec node --test tests/core/pipelineFinalization.test.js tests/core/pipelinePassState.test.js tests/core/pipelineRuntime.test.js tests/core/pipelineResult.test.js tests/core/pipelineTimings.test.js tests/core/pipelineRepairGates.test.js tests/core/pipelineState.test.js tests/core/pipelineMetrics.test.js tests/core/pipelineInitialSelection.test.js tests/core/pipelineMeta.test.js tests/core/pipelineTrace.test.js tests/core/candidateEvaluation.test.js`
  - 结果：`pass=60`，`fail=0`
- `pnpm exec node --test tests/core/watermarkProcessor.test.js`
  - 结果：`pass=61`，`fail=0`，`skipped=3`
- `pnpm build`
  - 结果：通过
- full benchmark：
  - report：`.artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase4-current-stage-runners.json`
  - markdown：`.artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase4-current-stage-runners.md`
  - 结果：`978/1000 = 97.80%`
  - `newlyPassing=0`
  - `newlyFailing=0`
  - `decisionPath` 覆盖：`1000/1000`
  - accepted decision：`984`
  - rejected decision：`16`
  - `repairApplied=175`
- gate：
  - `pnpm benchmark:online-sample:gate -- --report .artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase4-current-stage-runners.json --min-newly-passing 0`
  - 结果：通过

已完成的第三十七步：

- `src/core/pipelineRuntime.js` 新增 `runRepeatedCurrentRepairStage(...)`，把“重复执行 repair stage，成功提交，失败停止”的循环调度外壳收进 runtime 层。
- `src/core/watermarkProcessor.js` 已迁移两处重复 repair pass：
  - preview / known-48 / v2-small edge cleanup 循环
  - known-48 flat background fill 循环
- preview edge cleanup 的 timing 口径保持不变：成功 pass 和最终失败尝试都会计入 `previewEdgeCleanupElapsedMs`。
- flat-fill 的 passIndex 仍用于区分首轮和后续轮次的 `minGradientImprovement`。
- 这一步只迁移循环调度外壳，不改变 repair 生成函数、循环上限、失败停止条件、source 后缀、stage 名、strategy、suppressionGain 取值、trace 字段、meta、decisionPath 或输出像素。

验证证据：

- `node --check src/core/pipelineRuntime.js`
  - 结果：通过
- `node --check src/core/watermarkProcessor.js`
  - 结果：通过
- `pnpm exec node --test tests/core/pipelineRuntime.test.js`
  - 结果：`pass=19`，`fail=0`
- `pnpm exec node --test tests/core/pipelineFinalization.test.js tests/core/pipelinePassState.test.js tests/core/pipelineRuntime.test.js tests/core/pipelineResult.test.js tests/core/pipelineTimings.test.js tests/core/pipelineRepairGates.test.js tests/core/pipelineState.test.js tests/core/pipelineMetrics.test.js tests/core/pipelineInitialSelection.test.js tests/core/pipelineMeta.test.js tests/core/pipelineTrace.test.js tests/core/candidateEvaluation.test.js`
  - 结果：`pass=61`，`fail=0`
- `pnpm exec node --test tests/core/watermarkProcessor.test.js`
  - 结果：`pass=61`，`fail=0`，`skipped=3`
- `pnpm build`
  - 结果：通过
- full benchmark：
  - report：`.artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase4-repeated-repair-runner.json`
  - markdown：`.artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase4-repeated-repair-runner.md`
  - 结果：`978/1000 = 97.80%`
  - `newlyPassing=0`
  - `newlyFailing=0`
  - `decisionPath` 覆盖：`1000/1000`
  - accepted decision：`984`
  - rejected decision：`16`
  - `repairApplied=175`
- gate：
  - `pnpm benchmark:online-sample:gate -- --report .artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase4-repeated-repair-runner.json --min-newly-passing 0`
  - 结果：通过

已完成的第三十八步：

- `src/core/watermarkProcessor.js` 将最后几个低风险单 stage 直接提交改为复用已有 runner：
  - `subpixel-outline-refinement` 改为 `runCurrentAlphaStage(...)`
  - `known-48-luma-edge-correction` 改为 `runCurrentRepairStage(...)`
- `subpixelShift = refined.shift` 的局部副作用仍保留在主函数里，只把 stage accept / trace / state commit 交给 runtime runner。
- `tests/core/pipelineRuntime.test.js` 补充 `runCurrentAlphaStage(...)` 显式 `suppressionGain: null` 的覆盖，防止 subpixel stage 的 trace 语义被默认值吞掉。
- 这一步只迁移剩余单 stage 的提交外壳，不改变 gate 条件、refine 参数、source 后缀、stage 名、strategy、suppressionGain 语义、trace 字段、meta、decisionPath 或输出像素。

验证证据：

- `node --check src/core/watermarkProcessor.js`
  - 结果：通过
- `node --check src/core/pipelineRuntime.js`
  - 结果：通过
- `pnpm exec node --test tests/core/pipelineRuntime.test.js`
  - 结果：`pass=20`，`fail=0`
- `pnpm exec node --test tests/core/pipelineFinalization.test.js tests/core/pipelinePassState.test.js tests/core/pipelineRuntime.test.js tests/core/pipelineResult.test.js tests/core/pipelineTimings.test.js tests/core/pipelineRepairGates.test.js tests/core/pipelineState.test.js tests/core/pipelineMetrics.test.js tests/core/pipelineInitialSelection.test.js tests/core/pipelineMeta.test.js tests/core/pipelineTrace.test.js tests/core/candidateEvaluation.test.js`
  - 结果：`pass=62`，`fail=0`
- `pnpm exec node --test tests/core/watermarkProcessor.test.js`
  - 结果：`pass=61`，`fail=0`，`skipped=3`
- `pnpm build`
  - 结果：通过
- full benchmark：
  - report：`.artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase4-remaining-stage-runners.json`
  - markdown：`.artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase4-remaining-stage-runners.md`
  - 结果：`978/1000 = 97.80%`
  - `newlyPassing=0`
  - `newlyFailing=0`
  - `decisionPath` 覆盖：`1000/1000`
  - accepted decision：`984`
  - rejected decision：`16`
  - `repairApplied=175`
- gate：
  - `pnpm benchmark:online-sample:gate -- --report .artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase4-remaining-stage-runners.json --min-newly-passing 0`
  - 结果：通过

已完成的第三十九步：

- `src/core/pipelineRuntime.js` 新增 `runPreviewBackgroundCleanupStage(...)`，把 preview smooth background cleanup 的特殊执行壳收进 runtime 层：
  - 创建 cleanup payload
  - 若 payload 存在则调用 `acceptPreviewBackgroundCleanupResult(...)`
  - 写回 `debugTimings.previewBackgroundCleanupMs`
- `src/core/watermarkProcessor.js` 不再直接调用 `acceptPreviewBackgroundCleanupResult(...)`；主函数只保留原有 gate、cleanup 图像生成、region metrics、near-black 参数组装。
- `acceptPreviewBackgroundCleanupResult(...)` 内部的安全判断保持不变，仍由 runtime 的安全 accept helper 执行。
- 这一步只迁移 preview background cleanup 的执行外壳，不改变 enable 条件、border std、cleanup 算法、metrics、near-black 安全门槛、source 后缀、debugTimings 字段名、meta、decisionPath 或输出像素。

验证证据：

- `node --check src/core/pipelineRuntime.js`
  - 结果：通过
- `node --check src/core/watermarkProcessor.js`
  - 结果：通过
- `pnpm exec node --test tests/core/pipelineRuntime.test.js`
  - 结果：`pass=22`，`fail=0`
- `pnpm exec node --test tests/core/pipelineFinalization.test.js tests/core/pipelinePassState.test.js tests/core/pipelineRuntime.test.js tests/core/pipelineResult.test.js tests/core/pipelineTimings.test.js tests/core/pipelineRepairGates.test.js tests/core/pipelineState.test.js tests/core/pipelineMetrics.test.js tests/core/pipelineInitialSelection.test.js tests/core/pipelineMeta.test.js tests/core/pipelineTrace.test.js tests/core/candidateEvaluation.test.js`
  - 结果：`pass=64`，`fail=0`
- `pnpm exec node --test tests/core/watermarkProcessor.test.js`
  - 结果：`pass=61`，`fail=0`，`skipped=3`
- `pnpm build`
  - 结果：通过
- full benchmark：
  - report：`.artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase4-preview-background-runner.json`
  - markdown：`.artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase4-preview-background-runner.md`
  - 结果：`978/1000 = 97.80%`
  - `newlyPassing=0`
  - `newlyFailing=0`
  - `decisionPath` 覆盖：`1000/1000`
  - accepted decision：`984`
  - rejected decision：`16`
  - `repairApplied=175`
- gate：
  - `pnpm benchmark:online-sample:gate -- --report .artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase4-preview-background-runner.json --min-newly-passing 0`
  - 结果：通过

已完成的第四十步：

- `src/core/pipelineRuntime.js` 新增 `runRecalibrationStage(...)`，把 recalibration 的特殊执行壳收进 runtime 层：
  - 执行 `shouldRun` gate
  - 创建 recalibration result
  - 复算 recalibrated gradient score
  - 调用 `acceptRecalibrationStageResult(...)`
  - 写回 `debugTimings.recalibrationMs`
- `src/core/watermarkProcessor.js` 不再直接调用 `acceptRecalibrationStageResult(...)`；主函数只保留原有 gate 参数、near-black 参数、gradient score 复算闭包。
- `acceptRecalibrationStageResult(...)` 内部的 source 兼容逻辑保持不变：
  - `adaptive -> adaptive+gain`
  - 其他 source -> `${source}+gain`
- 这一步只迁移 recalibration 执行外壳，不改变 recalibration gate、alpha 计算、gradient 复算区域、source 后缀、trace 字段、debugTimings 字段名、meta、decisionPath 或输出像素。

验证证据：

- `node --check src/core/pipelineRuntime.js`
  - 结果：通过
- `node --check src/core/watermarkProcessor.js`
  - 结果：通过
- `pnpm exec node --test tests/core/pipelineRuntime.test.js`
  - 结果：`pass=24`，`fail=0`
- `pnpm exec node --test tests/core/pipelineFinalization.test.js tests/core/pipelinePassState.test.js tests/core/pipelineRuntime.test.js tests/core/pipelineResult.test.js tests/core/pipelineTimings.test.js tests/core/pipelineRepairGates.test.js tests/core/pipelineState.test.js tests/core/pipelineMetrics.test.js tests/core/pipelineInitialSelection.test.js tests/core/pipelineMeta.test.js tests/core/pipelineTrace.test.js tests/core/candidateEvaluation.test.js`
  - 结果：`pass=66`，`fail=0`
- `pnpm exec node --test tests/core/watermarkProcessor.test.js`
  - 结果：`pass=61`，`fail=0`，`skipped=3`
- `pnpm build`
  - 结果：通过
- full benchmark：
  - report：`.artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase4-recalibration-runner.json`
  - markdown：`.artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase4-recalibration-runner.md`
  - 结果：`978/1000 = 97.80%`
  - `newlyPassing=0`
  - `newlyFailing=0`
  - `decisionPath` 覆盖：`1000/1000`
  - accepted decision：`984`
  - rejected decision：`16`
  - `repairApplied=175`
- gate：
  - `pnpm benchmark:online-sample:gate -- --report .artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase4-recalibration-runner.json --min-newly-passing 0`
  - 结果：通过

已完成的第四十一步：

- `src/core/pipelineRuntime.js` 新增 `runLocatedAggressiveStage(...)`，把 `located-aggressive` 的特殊执行壳收进 runtime 层：
  - 执行 `shouldRun` gate
  - 调用 located aggressive refine 闭包
  - 将 rejected alpha trial event 自动补上 `decision: "reject"`
  - 调用既有 `acceptLocatedAggressiveResult(...)`
  - 通过 `applyPipelinePassOutcome(...)` 写回 passState
- `src/core/watermarkProcessor.js` 不再直接调用 `recordAlphaTrialEvent(...)`、`acceptLocatedAggressiveResult(...)` 或 `applyPipelinePassOutcome(...)`；主函数只保留原有 gate 参数、visibility 判断、clean canonical 96 skip gate、refine 参数和 source 后缀闭包。
- 这一步保留 `acceptLocatedAggressiveResult(...)` 内部的 trace / alpha trial event / pass record 生成逻辑不变，只迁移外层调度和 passState 写回。
- 这一步之后，`processWatermarkImageData` 中已无直接 `accept*Result(...)` 调用；执行壳的状态提交基本统一走 runtime runner / finalization helper。
- 这一步不改变 located-aggressive gate、refine 参数、rejected event 内容、accepted event 内容、passIncrement、passStopReason、passes 数组写入、source 后缀、trace 字段、meta、decisionPath 或输出像素。

验证证据：

- `node --check src/core/pipelineRuntime.js`
  - 结果：通过
- `node --check src/core/watermarkProcessor.js`
  - 结果：通过
- `pnpm exec node --test tests/core/pipelineRuntime.test.js`
  - 结果：`pass=26`，`fail=0`
- `pnpm exec node --test tests/core/pipelineFinalization.test.js tests/core/pipelinePassState.test.js tests/core/pipelineRuntime.test.js tests/core/pipelineResult.test.js tests/core/pipelineTimings.test.js tests/core/pipelineRepairGates.test.js tests/core/pipelineState.test.js tests/core/pipelineMetrics.test.js tests/core/pipelineInitialSelection.test.js tests/core/pipelineMeta.test.js tests/core/pipelineTrace.test.js tests/core/candidateEvaluation.test.js`
  - 结果：`pass=68`，`fail=0`
- `pnpm exec node --test tests/core/watermarkProcessor.test.js`
  - 结果：`pass=61`，`fail=0`，`skipped=3`
- `pnpm build`
  - 结果：通过
- full benchmark：
  - report：`.artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase4-located-aggressive-runner.json`
  - markdown：`.artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase4-located-aggressive-runner.md`
  - 结果：`978/1000 = 97.80%`
  - `newlyPassing=0`
  - `newlyFailing=0`
  - `decisionPath` 覆盖：`1000/1000`
  - accepted decision：`984`
  - rejected decision：`16`
  - `repairApplied=175`
- gate：
  - `pnpm benchmark:online-sample:gate -- --report .artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase4-located-aggressive-runner.json --min-newly-passing 0`
  - 结果：通过

已完成的第四十二步：

- `src/core/pipelineRuntime.js` 新增 `runCurrentAlphaTrialSequence(...)`，把一组 current-state alpha trial runner 按顺序执行。
- `src/core/watermarkProcessor.js` 中三个连续 alpha trial 调度已改为一个有序 sequence：
  - `over-subtraction-recalibration`
  - `dark-catalog-fine-alpha`
  - `weak-positive-residual-fine-alpha`
- 这是从“单 stage runner”进入“phase adapter / sequence”的第一刀；后续可以继续把 alpha / repair phase 的参数组装往 adapter 收。
- 这一步只迁移 alpha trial 的外层顺序组织，不改变 trial 生成函数、执行顺序、source 后缀、debugTimings 字段名、trace 字段、meta、decisionPath 或输出像素。

验证证据：

- `node --check src/core/pipelineRuntime.js`
  - 结果：通过
- `node --check src/core/watermarkProcessor.js`
  - 结果：通过
- `pnpm exec node --test tests/core/pipelineRuntime.test.js`
  - 结果：`pass=27`，`fail=0`
- `pnpm exec node --test tests/core/pipelineFinalization.test.js tests/core/pipelinePassState.test.js tests/core/pipelineRuntime.test.js tests/core/pipelineResult.test.js tests/core/pipelineTimings.test.js tests/core/pipelineRepairGates.test.js tests/core/pipelineState.test.js tests/core/pipelineMetrics.test.js tests/core/pipelineInitialSelection.test.js tests/core/pipelineMeta.test.js tests/core/pipelineTrace.test.js tests/core/candidateEvaluation.test.js`
  - 结果：`pass=69`，`fail=0`
- `pnpm exec node --test tests/core/watermarkProcessor.test.js`
  - 结果：`pass=61`，`fail=0`，`skipped=3`
- `pnpm build`
  - 结果：通过
- full benchmark：
  - report：`.artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase4-alpha-trial-sequence.json`
  - markdown：`.artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase4-alpha-trial-sequence.md`
  - 结果：`978/1000 = 97.80%`
  - `newlyPassing=0`
  - `newlyFailing=0`
  - `decisionPath` 覆盖：`1000/1000`
  - accepted decision：`984`
  - rejected decision：`16`
  - `repairApplied=175`
- gate：
  - `pnpm benchmark:online-sample:gate -- --report .artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase4-alpha-trial-sequence.json --min-newly-passing 0`
  - 结果：通过

已完成的第四十三步：

- `src/core/pipelineRuntime.js` 新增 `runCurrentAlphaStageSequence(...)`，把一组 current-state alpha stage runner 按顺序执行。
- `src/core/watermarkProcessor.js` 中连续 alpha rescue stage 已改为一个有序 sequence：
  - `new-margin-96-variant-rescue`
  - `known-48-anti-template-rescue`
  - `known-48-power-profile-rescue`
  - `known-48-positive-residual-rebalance`
- 这一步继续推进 phase adapter 方向：alpha trial sequence 与 alpha stage sequence 已经都具备，后续可以在更高层组合 alpha phase。
- 这一步只迁移 alpha stage 的外层顺序组织，不改变 stage 生成函数、执行顺序、source 后缀、stageExtras、trace 字段、meta、decisionPath 或输出像素。

验证证据：

- `node --check src/core/pipelineRuntime.js`
  - 结果：通过
- `node --check src/core/watermarkProcessor.js`
  - 结果：通过
- `pnpm exec node --test tests/core/pipelineRuntime.test.js`
  - 结果：`pass=28`，`fail=0`
- `pnpm exec node --test tests/core/pipelineFinalization.test.js tests/core/pipelinePassState.test.js tests/core/pipelineRuntime.test.js tests/core/pipelineResult.test.js tests/core/pipelineTimings.test.js tests/core/pipelineRepairGates.test.js tests/core/pipelineState.test.js tests/core/pipelineMetrics.test.js tests/core/pipelineInitialSelection.test.js tests/core/pipelineMeta.test.js tests/core/pipelineTrace.test.js tests/core/candidateEvaluation.test.js`
  - 结果：`pass=70`，`fail=0`
- `pnpm exec node --test tests/core/watermarkProcessor.test.js`
  - 结果：`pass=61`，`fail=0`，`skipped=3`
- `pnpm build`
  - 结果：通过
- full benchmark：
  - report：`.artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase4-alpha-stage-sequence.json`
  - markdown：`.artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase4-alpha-stage-sequence.md`
  - 结果：`978/1000 = 97.80%`
  - `newlyPassing=0`
  - `newlyFailing=0`
  - `decisionPath` 覆盖：`1000/1000`
  - accepted decision：`984`
  - rejected decision：`16`
  - `repairApplied=175`
- gate：
  - `pnpm benchmark:online-sample:gate -- --report .artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase4-alpha-stage-sequence.json --min-newly-passing 0`
  - 结果：通过

已完成的第四十四步：

- `src/core/pipelineRuntime.js` 新增 `runCurrentRepairStageSequence(...)`，与 alpha trial / alpha stage sequence 形态对齐。
- `src/core/watermarkProcessor.js` 中尾部连续 repair stage 已改为一个有序 sequence：
  - `known-48-small-margin-prior-repair`
  - `small-located-prior-repair`
  - `known-48-boundary-repair-rescue`
  - `dark-halo-low-logo-rescue`
  - `quantized-body-correction`
  - `known-48-mid-core-bias-correction`
- `tests/core/pipelineRuntime.test.js` 补充 repair sequence 单测，覆盖有序执行、空结果跳过 acceptance、suppressionGain 解析、`deriveSuppressionGainFromOriginalSpatial` 透传，以及 `beforeStage` timing anchor 的执行顺序。
- 这一步继续降低 `processWatermarkImageData(...)` 对具体 repair runner 的直接编排负担；stage 生成函数、执行顺序、source 后缀、debug timing 口径、trace 字段、meta、decisionPath 和输出像素保持等价。

验证证据：

- `node --check src/core/pipelineRuntime.js`
  - 结果：通过
- `node --check src/core/watermarkProcessor.js`
  - 结果：通过
- `pnpm exec node --test tests/core/pipelineRuntime.test.js`
  - 结果：`pass=30`，`fail=0`
- `pnpm exec node --test tests/core/pipelineFinalization.test.js tests/core/pipelinePassState.test.js tests/core/pipelineRuntime.test.js tests/core/pipelineResult.test.js tests/core/pipelineTimings.test.js tests/core/pipelineRepairGates.test.js tests/core/pipelineState.test.js tests/core/pipelineMetrics.test.js tests/core/pipelineInitialSelection.test.js tests/core/pipelineMeta.test.js tests/core/pipelineTrace.test.js tests/core/candidateEvaluation.test.js`
  - 结果：`pass=72`，`fail=0`
- `pnpm exec node --test tests/core/watermarkProcessor.test.js`
  - 结果：`pass=61`，`fail=0`，`skipped=3`
- `pnpm build`
  - 结果：通过
- full benchmark：
  - report：`.artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase4-repair-stage-sequence.json`
  - markdown：`.artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase4-repair-stage-sequence.md`
  - 结果：`978/1000 = 97.80%`
  - `newlyPassing=0`
  - `newlyFailing=0`
  - `decisionPath` 覆盖：`1000/1000`
  - accepted decision：`984`
  - rejected decision：`16`
  - `repairApplied=175`
- gate：
  - `pnpm benchmark:online-sample:gate -- --report .artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase4-repair-stage-sequence.json --min-newly-passing 0`
  - 结果：通过

已完成的第四十五步：

- `src/core/pipelineRepairStageSpecs.js` 新增 `createTailRepairStageSequenceSpecs(...)`，把尾部 repair stage 的 stage 名称、strategy、source 后缀、suppressionGain 解析、timing anchor 写入规则从 `processWatermarkImageData(...)` 中抽出。
- `src/core/watermarkProcessor.js` 改为通过 `readPipelineState` + refiner 函数表生成 tail repair specs，再交给 `runCurrentRepairStageSequence(...)` 执行。
- 这一步是 repair 层继续独立化的中间切口：由于具体 refiner 仍是 `watermarkProcessor.js` 本地函数，暂时通过函数表注入，避免一次性搬动大段算法实现和引入循环依赖。
- `tests/core/pipelineRepairStageSpecs.test.js` 覆盖动态 state 读取、source 链式更新、6 个 timing anchor、stage 顺序，以及 `deriveSuppressionGainFromOriginalSpatial` 透传。
- 行为约束：stage 生成函数本体、执行顺序、source 后缀、debug timing 口径、trace 字段、meta、decisionPath 和输出像素保持等价。

验证证据：

- `node --check src/core/pipelineRepairStageSpecs.js`
  - 结果：通过
- `node --check src/core/watermarkProcessor.js`
  - 结果：通过
- `pnpm exec node --test tests/core/pipelineRepairStageSpecs.test.js tests/core/pipelineRuntime.test.js`
  - 结果：`pass=31`，`fail=0`
- `pnpm exec node --test tests/core/pipelineFinalization.test.js tests/core/pipelinePassState.test.js tests/core/pipelineRuntime.test.js tests/core/pipelineRepairStageSpecs.test.js tests/core/pipelineResult.test.js tests/core/pipelineTimings.test.js tests/core/pipelineRepairGates.test.js tests/core/pipelineState.test.js tests/core/pipelineMetrics.test.js tests/core/pipelineInitialSelection.test.js tests/core/pipelineMeta.test.js tests/core/pipelineTrace.test.js tests/core/candidateEvaluation.test.js`
  - 结果：`pass=73`，`fail=0`
- `pnpm exec node --test tests/core/watermarkProcessor.test.js`
  - 结果：`pass=61`，`fail=0`，`skipped=3`
- `pnpm build`
  - 结果：通过
- full benchmark：
  - report：`.artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase4-tail-repair-specs.json`
  - markdown：`.artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase4-tail-repair-specs.md`
  - 结果：`978/1000 = 97.80%`
  - `newlyPassing=0`
  - `newlyFailing=0`
  - `decisionPath` 覆盖：`1000/1000`
  - accepted decision：`984`
  - rejected decision：`16`
  - `repairApplied=175`
- gate：
  - `pnpm benchmark:online-sample:gate -- --report .artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase4-tail-repair-specs.json --min-newly-passing 0`
  - 结果：通过

已完成的第四十六步：

- `src/core/pipelineAlphaStageSpecs.js` 新增 `createFineAlphaTrialSequenceSpecs(...)`，把 fine-alpha trial 的 stage 名称、strategy、source 后缀、debug timing key 和 refiner 入参组装从 `processWatermarkImageData(...)` 中抽出。
- `src/core/watermarkProcessor.js` 中 `over-subtraction-recalibration`、`dark-catalog-fine-alpha`、`weak-positive-residual-fine-alpha` 三个 alpha trial 改为通过 `readPipelineState` + refiner 函数表生成 specs，再交给 `runCurrentAlphaTrialSequence(...)` 执行。
- `tests/core/pipelineAlphaStageSpecs.test.js` 覆盖动态 state 读取、source 后缀去重、debug timing、stage 顺序，以及三段 trial 接受后继续读取最新 state。
- 这一步继续让 alpha 逼近层脱离执行壳；由于具体 alpha refiner 仍在 `watermarkProcessor.js` 内，暂时通过函数表注入，保持行为等价并避免一次性搬动算法实现。
- 行为约束：trial 生成函数本体、执行顺序、source 后缀、debug timing key、trace 字段、meta、decisionPath 和输出像素保持等价。

验证证据：

- `node --check src/core/pipelineAlphaStageSpecs.js`
  - 结果：通过
- `node --check src/core/watermarkProcessor.js`
  - 结果：通过
- `pnpm exec node --test tests/core/pipelineAlphaStageSpecs.test.js tests/core/pipelineRuntime.test.js`
  - 结果：`pass=32`，`fail=0`
- `pnpm exec node --test tests/core/pipelineAlphaStageSpecs.test.js tests/core/pipelineFinalization.test.js tests/core/pipelinePassState.test.js tests/core/pipelineRuntime.test.js tests/core/pipelineRepairStageSpecs.test.js tests/core/pipelineResult.test.js tests/core/pipelineTimings.test.js tests/core/pipelineRepairGates.test.js tests/core/pipelineState.test.js tests/core/pipelineMetrics.test.js tests/core/pipelineInitialSelection.test.js tests/core/pipelineMeta.test.js tests/core/pipelineTrace.test.js tests/core/candidateEvaluation.test.js`
  - 结果：`pass=75`，`fail=0`
- `pnpm exec node --test tests/core/watermarkProcessor.test.js`
  - 结果：`pass=61`，`fail=0`，`skipped=3`
- `pnpm build`
  - 结果：通过
- full benchmark：
  - report：`.artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase4-alpha-trial-specs.json`
  - markdown：`.artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase4-alpha-trial-specs.md`
  - 结果：`978/1000 = 97.80%`
  - `newlyPassing=0`
  - `newlyFailing=0`
  - `decisionPath` 覆盖：`1000/1000`
  - accepted decision：`984`
  - rejected decision：`16`
  - `repairApplied=175`
- gate：
  - `pnpm benchmark:online-sample:gate -- --report .artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase4-alpha-trial-specs.json --min-newly-passing 0`
  - 结果：通过

已完成的第四十七步：

- `src/core/pipelineAlphaStageSpecs.js` 新增 `createAlphaRescueStageSequenceSpecs(...)`，把 alpha rescue stage 的 stage 名称、strategy、source 后缀、stageExtras、variant alpha map 解析和 tail debug timing anchor 记录从 `processWatermarkImageData(...)` 中抽出。
- `src/core/watermarkProcessor.js` 中 `new-margin-96-variant-rescue`、`known-48-anti-template-rescue`、`known-48-power-profile-rescue`、`known-48-positive-residual-rebalance` 四个 alpha stage 改为通过 `readPipelineState` + refiner 函数表生成 specs，再交给 `runCurrentAlphaStageSequence(...)` 执行。
- `tests/core/pipelineAlphaStageSpecs.test.js` 覆盖动态 state 读取、source 链式更新、variant alpha map 透传、stageExtras、stage 顺序，以及四个 rescue timing anchor 的原有记录顺序。
- 这一步让 alpha trial specs 与 alpha stage specs 都具备独立构造层，`processWatermarkImageData(...)` 不再直接组装这两段 alpha sequence 的大块 stage 对象。
- 行为约束：stage 生成函数本体、执行顺序、variant alpha map 优先级、source 后缀、stageExtras、debug timing 口径、trace 字段、meta、decisionPath 和输出像素保持等价。

验证证据：

- `node --check src/core/pipelineAlphaStageSpecs.js`
  - 结果：通过
- `node --check src/core/watermarkProcessor.js`
  - 结果：通过
- `pnpm exec node --test tests/core/pipelineAlphaStageSpecs.test.js tests/core/pipelineRuntime.test.js`
  - 结果：`pass=33`，`fail=0`
- `pnpm exec node --test tests/core/pipelineAlphaStageSpecs.test.js tests/core/pipelineFinalization.test.js tests/core/pipelinePassState.test.js tests/core/pipelineRuntime.test.js tests/core/pipelineRepairStageSpecs.test.js tests/core/pipelineResult.test.js tests/core/pipelineTimings.test.js tests/core/pipelineRepairGates.test.js tests/core/pipelineState.test.js tests/core/pipelineMetrics.test.js tests/core/pipelineInitialSelection.test.js tests/core/pipelineMeta.test.js tests/core/pipelineTrace.test.js tests/core/candidateEvaluation.test.js`
  - 结果：`pass=76`，`fail=0`
- `pnpm exec node --test tests/core/watermarkProcessor.test.js`
  - 结果：`pass=61`，`fail=0`，`skipped=3`
- `pnpm build`
  - 结果：通过
- full benchmark：
  - report：`.artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase4-alpha-rescue-specs.json`
  - markdown：`.artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase4-alpha-rescue-specs.md`
  - 结果：`978/1000 = 97.80%`
  - `newlyPassing=0`
  - `newlyFailing=0`
  - `decisionPath` 覆盖：`1000/1000`
  - accepted decision：`984`
  - rejected decision：`16`
  - `repairApplied=175`
- gate：
  - `pnpm benchmark:online-sample:gate -- --report .artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase4-alpha-rescue-specs.json --min-newly-passing 0`
  - 结果：通过

已完成的第四十八步：

- `src/core/pipelineRuntime.js` 新增 `runCurrentAlphaTrialSpecPhase(...)`、`runCurrentAlphaStageSpecPhase(...)`、`runCurrentRepairStageSpecPhase(...)`。
- 这三个 helper 只负责“懒创建 specs，再交给对应 sequence runner 执行”，不包含任何具体 watermark 策略、refiner、阈值或评分逻辑。
- `src/core/watermarkProcessor.js` 中 fine-alpha trial specs、alpha rescue specs、tail repair specs 的执行已改为 spec phase wrapper：
  - `createFineAlphaTrialSequenceSpecs(...)` -> `runCurrentAlphaTrialSpecPhase(...)`
  - `createAlphaRescueStageSequenceSpecs(...)` -> `runCurrentAlphaStageSpecPhase(...)`
  - `createTailRepairStageSequenceSpecs(...)` -> `runCurrentRepairStageSpecPhase(...)`
- `tests/core/pipelineRuntime.test.js` 补充三类 spec phase wrapper 单测，覆盖懒创建、acceptance 透传、stageExtras、repair `beforeStage` 顺序和 suppressionGain 解析。
- 这一步继续瘦身执行壳：`processWatermarkImageData(...)` 不再直接调用三段 sequence runner，而是只描述要创建哪类 specs，并交给 runtime phase helper 执行。
- 行为约束：spec 内容、执行顺序、source 后缀、stageExtras、debug timing、trace 字段、meta、decisionPath 和输出像素保持等价。

验证证据：

- `node --check src/core/pipelineRuntime.js`
  - 结果：通过
- `node --check src/core/watermarkProcessor.js`
  - 结果：通过
- `pnpm exec node --test tests/core/pipelineRuntime.test.js`
  - 结果：`pass=33`，`fail=0`
- `pnpm exec node --test tests/core/pipelineAlphaStageSpecs.test.js tests/core/pipelineFinalization.test.js tests/core/pipelinePassState.test.js tests/core/pipelineRuntime.test.js tests/core/pipelineRepairStageSpecs.test.js tests/core/pipelineResult.test.js tests/core/pipelineTimings.test.js tests/core/pipelineRepairGates.test.js tests/core/pipelineState.test.js tests/core/pipelineMetrics.test.js tests/core/pipelineInitialSelection.test.js tests/core/pipelineMeta.test.js tests/core/pipelineTrace.test.js tests/core/candidateEvaluation.test.js`
  - 结果：`pass=79`，`fail=0`
- `pnpm exec node --test tests/core/watermarkProcessor.test.js`
  - 结果：`pass=61`，`fail=0`，`skipped=3`
- `pnpm build`
  - 结果：通过
- full benchmark：
  - report：`.artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase4-spec-phase-runners.json`
  - markdown：`.artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase4-spec-phase-runners.md`
  - 结果：`978/1000 = 97.80%`
  - `newlyPassing=0`
  - `newlyFailing=0`
  - `decisionPath` 覆盖：`1000/1000`
  - accepted decision：`984`
  - rejected decision：`16`
  - `repairApplied=175`
- gate：
  - `pnpm benchmark:online-sample:gate -- --report .artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase4-spec-phase-runners.json --min-newly-passing 0`
  - 结果：通过

已完成的第四十九步：

- `src/core/pipelineRepairStageSpecs.js` 新增 `createRepairCleanupPhaseSpecs(...)`，把早段 repair cleanup 的 edge cleanup、known-48 flat fill、known-48 luma edge、new-margin 96 flat fill 的 specs 从 `processWatermarkImageData(...)` 中抽出。
- `src/core/pipelineRuntime.js` 新增 `runRepairCleanupSpecPhase(...)`，统一执行 mixed repair cleanup phase：
  - repeated edge cleanup
  - repeated known-48 flat fill
  - single known-48 luma edge
  - single new-margin 96 flat fill
- `src/core/watermarkProcessor.js` 中原来的 repeated/single repair cleanup 大段改为 `createRepairCleanupPhaseSpecs(...)` + `runRepairCleanupSpecPhase(...)`，并继续使用 `readPipelineState` 保证多 pass 和前序 accepted repair 后读取最新 image/source/scores。
- `tests/core/pipelineRepairStageSpecs.test.js` 补充 cleanup phase 单测，覆盖 repeated pass、动态 state 更新、mode/minGradientImprovement 选择、source 链式更新、stage 顺序和 `previewEdgeCleanupElapsedMs` 返回值。
- 这一步让 repair 层在 tail repair specs 之外，也覆盖了前半段更高频的 cleanup specs；`processWatermarkImageData(...)` 中直接编排 repair cleanup 的代码显著减少。
- 行为约束：refiner 本体、maxPasses、阈值选择、stage/source 命名、debug timing、trace 字段、meta、decisionPath 和输出像素保持等价。

验证证据：

- `node --check src/core/pipelineRepairStageSpecs.js`
  - 结果：通过
- `node --check src/core/pipelineRuntime.js`
  - 结果：通过
- `node --check src/core/watermarkProcessor.js`
  - 结果：通过
- `pnpm exec node --test tests/core/pipelineRepairStageSpecs.test.js tests/core/pipelineRuntime.test.js`
  - 结果：`pass=35`，`fail=0`
- `pnpm exec node --test tests/core/pipelineAlphaStageSpecs.test.js tests/core/pipelineFinalization.test.js tests/core/pipelinePassState.test.js tests/core/pipelineRuntime.test.js tests/core/pipelineRepairStageSpecs.test.js tests/core/pipelineResult.test.js tests/core/pipelineTimings.test.js tests/core/pipelineRepairGates.test.js tests/core/pipelineState.test.js tests/core/pipelineMetrics.test.js tests/core/pipelineInitialSelection.test.js tests/core/pipelineMeta.test.js tests/core/pipelineTrace.test.js tests/core/candidateEvaluation.test.js`
  - 结果：`pass=80`，`fail=0`
- `pnpm exec node --test tests/core/watermarkProcessor.test.js`
  - 结果：`pass=61`，`fail=0`，`skipped=3`
- `pnpm build`
  - 结果：通过
- full benchmark：
  - report：`.artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase4-repair-cleanup-specs.json`
  - markdown：`.artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase4-repair-cleanup-specs.md`
  - 结果：`978/1000 = 97.80%`
  - `newlyPassing=0`
  - `newlyFailing=0`
  - `decisionPath` 覆盖：`1000/1000`
  - accepted decision：`984`
  - rejected decision：`16`
  - `repairApplied=175`
- gate：
  - `pnpm benchmark:online-sample:gate -- --report .artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase4-repair-cleanup-specs.json --min-newly-passing 0`
  - 结果：通过

已完成的第五十步：

- `src/core/pipelineRepairStageSpecs.js` 新增 `createPostLocatedRepairStageSequenceSpecs(...)`，把 located-aggressive 后面的两个 repair stage 从 `processWatermarkImageData(...)` 中抽出：
  - `canonical-96-positive-halo-rescue`
  - `smooth-located-estimated-prior`
- `src/core/watermarkProcessor.js` 改为通过 `runCurrentRepairStageSpecPhase(...)` 执行 post-located repair specs，并通过 `smoothPriorStartedAt` timing anchor 保持 tail debug timing 口径。
- `tests/core/pipelineRepairStageSpecs.test.js` 补充 post-located repair specs 单测，覆盖 canonical 接受后 smooth 读取最新 image/source、smooth timing anchor、source 链式更新、suppressionGain 和 `deriveSuppressionGainFromOriginalSpatial`。
- 这一步继续减少执行壳中的直接 repair stage 编排；post-located repair 与 tail repair / cleanup repair 一样，进入 repair specs 层。
- 行为约束：refiner 本体、stage/source 命名、smooth timing、trace 字段、meta、decisionPath 和输出像素保持等价。

验证证据：

- `node --check src/core/pipelineRepairStageSpecs.js`
  - 结果：通过
- `node --check src/core/watermarkProcessor.js`
  - 结果：通过
- `pnpm exec node --test tests/core/pipelineRepairStageSpecs.test.js tests/core/pipelineRuntime.test.js`
  - 结果：`pass=36`，`fail=0`
- `pnpm exec node --test tests/core/pipelineAlphaStageSpecs.test.js tests/core/pipelineFinalization.test.js tests/core/pipelinePassState.test.js tests/core/pipelineRuntime.test.js tests/core/pipelineRepairStageSpecs.test.js tests/core/pipelineResult.test.js tests/core/pipelineTimings.test.js tests/core/pipelineRepairGates.test.js tests/core/pipelineState.test.js tests/core/pipelineMetrics.test.js tests/core/pipelineInitialSelection.test.js tests/core/pipelineMeta.test.js tests/core/pipelineTrace.test.js tests/core/candidateEvaluation.test.js`
  - 结果：`pass=81`，`fail=0`
- `pnpm exec node --test tests/core/watermarkProcessor.test.js`
  - 结果：`pass=61`，`fail=0`，`skipped=3`
- `pnpm build`
  - 结果：通过
- full benchmark：
  - report：`.artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase4-post-located-repair-specs.json`
  - markdown：`.artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase4-post-located-repair-specs.md`
  - 结果：`978/1000 = 97.80%`
  - `newlyPassing=0`
  - `newlyFailing=0`
  - `decisionPath` 覆盖：`1000/1000`
  - accepted decision：`984`
  - rejected decision：`16`
  - `repairApplied=175`
- gate：
  - `pnpm benchmark:online-sample:gate -- --report .artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase4-post-located-repair-specs.json --min-newly-passing 0`
  - 结果：通过

已完成的第五十一步：

- `src/core/pipelineAlphaStageSpecs.js` 新增 `createSmallAnchorAlphaStageSequenceSpecs(...)`，把两个 small-anchor alpha stage 从 `processWatermarkImageData(...)` 中抽出：
  - `small-preview-refinement`
  - `small-fixed-local-anchor-relocation`
- `src/core/watermarkProcessor.js` 改为通过 `runCurrentAlphaStageSpecPhase(...)` 执行 small-anchor alpha specs，并继续把第二个 stage 的返回值作为 `smallFixedLocalRelocated` 传给后续 located-aggressive gate。
- `tests/core/pipelineAlphaStageSpecs.test.js` 补充 small-anchor alpha specs 单测，覆盖 small preview 接受后 fixed-local stage 读取最新 image/source/position、`smallPreviewRefinementStartedAt` timing anchor、refined config 计算、stageExtras 和返回值保留。
- 这一步让剩余的连续 small-anchor alpha stage 也进入 alpha specs 层，`processWatermarkImageData(...)` 中直接组装 alpha stage 对象的代码进一步减少。
- 行为约束：refiner 本体、视觉开关、residual visibility 计算时机、refined config 计算、located-aggressive gate 输入、stage/source 命名、debug timing、trace 字段、meta、decisionPath 和输出像素保持等价。

验证证据：

- `node --check src/core/pipelineAlphaStageSpecs.js`
  - 结果：通过
- `node --check src/core/watermarkProcessor.js`
  - 结果：通过
- `pnpm exec node --test tests/core/pipelineAlphaStageSpecs.test.js tests/core/pipelineRuntime.test.js`
  - 结果：`pass=37`，`fail=0`
- `pnpm exec node --test tests/core/pipelineAlphaStageSpecs.test.js tests/core/pipelineFinalization.test.js tests/core/pipelinePassState.test.js tests/core/pipelineRuntime.test.js tests/core/pipelineRepairStageSpecs.test.js tests/core/pipelineResult.test.js tests/core/pipelineTimings.test.js tests/core/pipelineRepairGates.test.js tests/core/pipelineState.test.js tests/core/pipelineMetrics.test.js tests/core/pipelineInitialSelection.test.js tests/core/pipelineMeta.test.js tests/core/pipelineTrace.test.js tests/core/candidateEvaluation.test.js`
  - 结果：`pass=82`，`fail=0`
- `pnpm exec node --test tests/core/watermarkProcessor.test.js`
  - 结果：`pass=61`，`fail=0`，`skipped=3`
- `pnpm build`
  - 结果：通过
- full benchmark：
  - report：`.artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase4-small-anchor-alpha-specs.json`
  - markdown：`.artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase4-small-anchor-alpha-specs.md`
  - 结果：`978/1000 = 97.80%`
  - `newlyPassing=0`
  - `newlyFailing=0`
  - `decisionPath` 覆盖：`1000/1000`
  - accepted decision：`984`
  - rejected decision：`16`
  - `repairApplied=175`
- gate：
  - `pnpm benchmark:online-sample:gate -- --report .artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase4-small-anchor-alpha-specs.json --min-newly-passing 0`
  - 结果：通过

已完成的第五十二步：

- `src/core/pipelineAlphaStageSpecs.js` 新增 `createSubpixelOutlineAlphaStageSpecs(...)`，把 `subpixel-outline-refinement` 的 stage spec 从 `processWatermarkImageData(...)` 中抽出。
- `src/core/watermarkProcessor.js` 改为通过 `runCurrentAlphaStageSpecPhase(...)` 执行 subpixel alpha spec，同时保留主函数中的 `subpixelShift = subpixelRefined.shift` 和 `debugTimings.subpixelRefinementMs` 赋值语义。
- `tests/core/pipelineAlphaStageSpecs.test.js` 补充 subpixel alpha specs 单测，覆盖 gate 条件、refiner 入参、baselineShift、candidate arrays、`suppressionGain: null` 和返回的 `shift`。
- 这一步将最后一个普通 alpha stage 也迁入 alpha specs 层；主函数只保留 `subpixelShift` 这种局部输出副作用和 timing 记录。
- 行为约束：refiner 本体、gate 条件、thresholds、candidate shifts/scales、baselineShift、source 后缀、`suppressionGain: null`、debug timing、trace 字段、meta、decisionPath 和输出像素保持等价。

验证证据：

- `node --check src/core/pipelineAlphaStageSpecs.js`
  - 结果：通过
- `node --check src/core/watermarkProcessor.js`
  - 结果：通过
- `pnpm exec node --test tests/core/pipelineAlphaStageSpecs.test.js tests/core/pipelineRuntime.test.js`
  - 结果：`pass=39`，`fail=0`
- `pnpm exec node --test tests/core/pipelineAlphaStageSpecs.test.js tests/core/pipelineFinalization.test.js tests/core/pipelinePassState.test.js tests/core/pipelineRuntime.test.js tests/core/pipelineRepairStageSpecs.test.js tests/core/pipelineResult.test.js tests/core/pipelineTimings.test.js tests/core/pipelineRepairGates.test.js tests/core/pipelineState.test.js tests/core/pipelineMetrics.test.js tests/core/pipelineInitialSelection.test.js tests/core/pipelineMeta.test.js tests/core/pipelineTrace.test.js tests/core/candidateEvaluation.test.js`
  - 结果：`pass=84`，`fail=0`
- `pnpm exec node --test tests/core/watermarkProcessor.test.js`
  - 结果：`pass=61`，`fail=0`，`skipped=3`
- `pnpm build`
  - 结果：通过
- full benchmark：
  - report：`.artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase4-subpixel-alpha-specs.json`
  - markdown：`.artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase4-subpixel-alpha-specs.md`
  - 结果：`978/1000 = 97.80%`
  - `newlyPassing=0`
  - `newlyFailing=0`
  - `decisionPath` 覆盖：`1000/1000`
  - accepted decision：`984`
  - rejected decision：`16`
  - `repairApplied=175`
- gate：
  - `pnpm benchmark:online-sample:gate -- --report .artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase4-subpixel-alpha-specs.json --min-newly-passing 0`
  - 结果：通过

已完成的第五十三步：

- `src/core/pipelineAlphaStageSpecs.js` 新增 `createLocatedAggressiveStageSpec(...)`，把 `located-aggressive-removal` 的运行参数、gate、source 后缀、passState 入参和 reject event hook 从 `processWatermarkImageData(...)` 中抽出。
- `src/core/watermarkProcessor.js` 改为 `runLocatedAggressiveStage(createLocatedAggressiveStageSpec(...))`，主函数只保留 `locatedAggressiveStartedAt` timing 锚点和 `passState = locatedAggressiveRun.passState` 的局部写回。
- `tests/core/pipelineAlphaStageSpecs.test.js` 补充 located-aggressive spec 单测，覆盖可见性 gate、clean-canonical skip gate、refiner 动态状态入参、source 后缀去重、创建时分数快照和隐藏 relocated residual skip。
- 行为约束：`refineLocatedAggressiveRemoval(...)` 本体、`shouldRun` 条件、`onRejected` 事件封装、`acceptLocatedAggressiveResult(...)` payload、passState 应用、debug timing、trace 字段、meta、decisionPath 和输出像素保持等价。

验证证据：

- `node --check src/core/pipelineAlphaStageSpecs.js`
  - 结果：通过
- `node --check src/core/watermarkProcessor.js`
  - 结果：通过
- `pnpm exec node --test tests/core/pipelineAlphaStageSpecs.test.js tests/core/pipelineRuntime.test.js`
  - 结果：`pass=41`，`fail=0`
- `pnpm exec node --test tests/core/pipelineAlphaStageSpecs.test.js tests/core/pipelineFinalization.test.js tests/core/pipelinePassState.test.js tests/core/pipelineRuntime.test.js tests/core/pipelineRepairStageSpecs.test.js tests/core/pipelineResult.test.js tests/core/pipelineTimings.test.js tests/core/pipelineRepairGates.test.js tests/core/pipelineState.test.js tests/core/pipelineMetrics.test.js tests/core/pipelineInitialSelection.test.js tests/core/pipelineMeta.test.js tests/core/pipelineTrace.test.js tests/core/candidateEvaluation.test.js`
  - 结果：`pass=86`，`fail=0`
- `pnpm exec node --test tests/core/watermarkProcessor.test.js`
  - 结果：`pass=61`，`fail=0`，`skipped=3`
- `pnpm build`
  - 结果：通过
- full benchmark：
  - report：`.artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase4-located-aggressive-spec.json`
  - markdown：`.artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase4-located-aggressive-spec.md`
  - 结果：`978/1000 = 97.80%`
  - `newlyPassing=0`
  - `newlyFailing=0`
  - `decisionPath` 覆盖：`1000/1000`
  - accepted decision：`984`
  - rejected decision：`16`
  - `repairApplied=175`
- gate：
  - `pnpm benchmark:online-sample:gate -- --report .artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase4-located-aggressive-spec.json --min-newly-passing 0`
  - 结果：通过

已完成的第五十四步：

- `src/core/pipelineAlphaStageSpecs.js` 新增 `createRecalibrationStageSpec(...)`，把 `recalibration` 的 gate、alpha 重估入参、near-black 计算、gradient 复算、timing 参数和 accept hook 从 `processWatermarkImageData(...)` 中抽出。
- `src/core/watermarkProcessor.js` 改为 `runRecalibrationStage(createRecalibrationStageSpec(...))`，主函数不再手工拼 recalibration runner 参数。
- `tests/core/pipelineAlphaStageSpecs.test.js` 补充 recalibration spec 单测，覆盖创建时 gate 快照、执行时动态状态读取、near-black 入参、gradient 复算 region、debug timing，以及 gate=false 时不创建 result。
- 行为约束：`shouldRecalibrateAlphaStrength(...)` 条件、`recalibrateAlphaStrength(...)` 入参、gradient 复算公式、source 后缀规则、`acceptRecalibrationStageResult(...)` payload、debug timing、trace 字段、meta、decisionPath 和输出像素保持等价。

验证证据：

- `node --check src/core/pipelineAlphaStageSpecs.js`
  - 结果：通过
- `node --check src/core/watermarkProcessor.js`
  - 结果：通过
- `pnpm exec node --test tests/core/pipelineAlphaStageSpecs.test.js tests/core/pipelineRuntime.test.js`
  - 结果：`pass=43`，`fail=0`
- `pnpm exec node --test tests/core/pipelineAlphaStageSpecs.test.js tests/core/pipelineFinalization.test.js tests/core/pipelinePassState.test.js tests/core/pipelineRuntime.test.js tests/core/pipelineRepairStageSpecs.test.js tests/core/pipelineResult.test.js tests/core/pipelineTimings.test.js tests/core/pipelineRepairGates.test.js tests/core/pipelineState.test.js tests/core/pipelineMetrics.test.js tests/core/pipelineInitialSelection.test.js tests/core/pipelineMeta.test.js tests/core/pipelineTrace.test.js tests/core/candidateEvaluation.test.js`
  - 结果：`pass=88`，`fail=0`
- `pnpm exec node --test tests/core/watermarkProcessor.test.js`
  - 结果：`pass=61`，`fail=0`，`skipped=3`
- `pnpm build`
  - 结果：通过
- full benchmark：
  - report：`.artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase4-recalibration-spec.json`
  - markdown：`.artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase4-recalibration-spec.md`
  - 结果：`978/1000 = 97.80%`
  - `newlyPassing=0`
  - `newlyFailing=0`
  - `decisionPath` 覆盖：`1000/1000`
  - accepted decision：`984`
  - rejected decision：`16`
  - `repairApplied=175`
- gate：
  - `pnpm benchmark:online-sample:gate -- --report .artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase4-recalibration-spec.json --min-newly-passing 0`
  - 结果：通过

已完成的第五十五步：

- `src/core/pipelineRepairStageSpecs.js` 新增 `createPreviewBackgroundCleanupStageSpec(...)`，把 `preview-background-cleanup` 的特殊 cleanup payload 装配从 `processWatermarkImageData(...)` 中抽出。
- `src/core/watermarkProcessor.js` 改为 `runPreviewBackgroundCleanupStage(createPreviewBackgroundCleanupStageSpec(...))`，主函数不再手写 background cleanup 的 borderStd、gate、cleanup、metrics 和 near-black 计算链。
- `tests/core/pipelineRepairStageSpecs.test.js` 补充 preview background cleanup spec 单测，覆盖动态状态读取、border std、gate payload、cleanup payload、metrics payload、near-black、debug timing，以及 disabled 时短路不调用 cleanup/metrics。
- 行为约束：`ENABLE_VISUAL_POST_PROCESSING` gate、`shouldApplyPreviewSmoothBackgroundCleanup(...)` 入参、`applyPreviewSmoothBackgroundCleanup(...)` 入参、`createRegionCorrelationMetrics(...)` 入参、near-black 计算、source 后缀、`acceptPreviewBackgroundCleanupResult(...)` payload、debug timing、trace 字段、meta、decisionPath 和输出像素保持等价。

验证证据：

- `node --check src/core/pipelineRepairStageSpecs.js`
  - 结果：通过
- `node --check src/core/watermarkProcessor.js`
  - 结果：通过
- `pnpm exec node --test tests/core/pipelineRepairStageSpecs.test.js tests/core/pipelineRuntime.test.js`
  - 结果：`pass=38`，`fail=0`
- `pnpm exec node --test tests/core/pipelineAlphaStageSpecs.test.js tests/core/pipelineFinalization.test.js tests/core/pipelinePassState.test.js tests/core/pipelineRuntime.test.js tests/core/pipelineRepairStageSpecs.test.js tests/core/pipelineResult.test.js tests/core/pipelineTimings.test.js tests/core/pipelineRepairGates.test.js tests/core/pipelineState.test.js tests/core/pipelineMetrics.test.js tests/core/pipelineInitialSelection.test.js tests/core/pipelineMeta.test.js tests/core/pipelineTrace.test.js tests/core/candidateEvaluation.test.js`
  - 结果：`pass=90`，`fail=0`
- `pnpm exec node --test tests/core/watermarkProcessor.test.js`
  - 结果：`pass=61`，`fail=0`，`skipped=3`
- `pnpm build`
  - 结果：通过
- full benchmark：
  - report：`.artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase4-preview-background-cleanup-spec.json`
  - markdown：`.artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase4-preview-background-cleanup-spec.md`
  - 结果：`978/1000 = 97.80%`
  - `newlyPassing=0`
  - `newlyFailing=0`
  - `decisionPath` 覆盖：`1000/1000`
  - accepted decision：`984`
  - rejected decision：`16`
  - `repairApplied=175`
- gate：
  - `pnpm benchmark:online-sample:gate -- --report .artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase4-preview-background-cleanup-spec.json --min-newly-passing 0`
  - 结果：通过

已完成的第五十六步：

- `src/core/pipelineRuntimeBootstrap.js` 新增 `createAcceptedPipelineRuntimeBootstrap(...)`，把 accepted initial selection 之后的运行时启动样板从 `processWatermarkImageData(...)` 中抽出。
- bootstrap 现在统一负责：
  - `createRepairCleanupFlags(...)`
  - first pass metrics / `passState`
  - processed metrics
  - 初始 runtime state
  - `readPipelineState` / `applyPipelineState`
  - `firstPassMetricsMs`、`extraPassMs`、`finalMetricsMs`
- `src/core/watermarkProcessor.js` 改为从 bootstrap 获取 cleanup flags、passState 和 state accessors；主函数不再维护 first-pass / final-metrics / state-accessor 的本地初始化样板。
- `tests/core/pipelineRuntimeBootstrap.test.js` 补充 bootstrap 单测，覆盖 cleanup flags、first pass passState、debug timing、runtime state 字段、suppressionGain 派生，以及 mutable accessor 写回。
- 行为约束：初始候选选择、first pass metrics、processed metrics、passState、debug timing 字段名、cleanup flags、后续 specs 读取的当前 state、meta、decisionPath 和输出像素保持等价。

验证证据：

- `node --check src/core/pipelineRuntimeBootstrap.js`
  - 结果：通过
- `node --check src/core/watermarkProcessor.js`
  - 结果：通过
- `pnpm exec node --test tests/core/pipelineRuntimeBootstrap.test.js tests/core/pipelineState.test.js tests/core/pipelineMetrics.test.js tests/core/pipelineRuntime.test.js`
  - 结果：`pass=47`，`fail=0`
- `pnpm exec node --test tests/core/pipelineAlphaStageSpecs.test.js tests/core/pipelineFinalization.test.js tests/core/pipelinePassState.test.js tests/core/pipelineRuntime.test.js tests/core/pipelineRuntimeBootstrap.test.js tests/core/pipelineRepairStageSpecs.test.js tests/core/pipelineResult.test.js tests/core/pipelineTimings.test.js tests/core/pipelineRepairGates.test.js tests/core/pipelineState.test.js tests/core/pipelineMetrics.test.js tests/core/pipelineInitialSelection.test.js tests/core/pipelineMeta.test.js tests/core/pipelineTrace.test.js tests/core/candidateEvaluation.test.js`
  - 结果：`pass=92`，`fail=0`
- `pnpm exec node --test tests/core/watermarkProcessor.test.js`
  - 结果：`pass=61`，`fail=0`，`skipped=3`
- `pnpm build`
  - 结果：通过
- full benchmark：
  - report：`.artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase4-runtime-bootstrap.json`
  - markdown：`.artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase4-runtime-bootstrap.md`
  - 结果：`978/1000 = 97.80%`
  - `newlyPassing=0`
  - `newlyFailing=0`
  - `decisionPath` 覆盖：`1000/1000`
  - accepted decision：`984`
  - rejected decision：`16`
  - `repairApplied=175`
- gate：
  - `pnpm benchmark:online-sample:gate -- --report .artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase4-runtime-bootstrap.json --min-newly-passing 0`
  - 结果：通过

已完成的第五十七步：

- `src/core/pipelineAcceptedExecutor.js` 新增 `runAcceptedAlphaRepairPipeline(...)`，把 accepted initial selection 之后的 alpha / repair stage orchestration 从 `processWatermarkImageData(...)` 中抽出。
- executor 现在统一负责：
  - 创建 `createAlphaRepairPipelineRuntime(...)`
  - 依序运行 recalibration、fine alpha trials、preview background cleanup、subpixel refinement、repair cleanup、small anchor refinement、located aggressive、post-located repair、alpha rescue、tail repair
  - 汇总 `passState`
  - 回传 `subpixelShift`
  - 暴露最终 `readPipelineState`
  - 维持 tail debug timing 写入
- `src/core/watermarkProcessor.js` 改为准备 bootstrap / metrics / gates / config / refiners 后调用 executor，再进入 finalization；主函数不再直接展开 accepted 后的 stage 执行顺序。
- `tests/core/pipelineAcceptedExecutor.test.js` 补充 executor 单测，覆盖 stage 执行、state commit、trace 写入、`subpixelShift` 回传、`passState` 保留和 debug timing。
- 行为约束：stage 顺序、所有 refiner/gate 入参、state commit、passState、subpixelShift、debug timing、trace 字段、meta、decisionPath 和输出像素保持等价。

验证证据：

- `node --check src/core/pipelineAcceptedExecutor.js`
  - 结果：通过
- `node --check src/core/watermarkProcessor.js`
  - 结果：通过
- `pnpm exec node --test tests/core/pipelineAcceptedExecutor.test.js tests/core/pipelineRuntime.test.js tests/core/pipelineAlphaStageSpecs.test.js tests/core/pipelineRepairStageSpecs.test.js`
  - 结果：`pass=49`，`fail=0`
- `pnpm exec node --test tests/core/pipelineAcceptedExecutor.test.js tests/core/pipelineAlphaStageSpecs.test.js tests/core/pipelineFinalization.test.js tests/core/pipelinePassState.test.js tests/core/pipelineRuntime.test.js tests/core/pipelineRuntimeBootstrap.test.js tests/core/pipelineRepairStageSpecs.test.js tests/core/pipelineResult.test.js tests/core/pipelineTimings.test.js tests/core/pipelineRepairGates.test.js tests/core/pipelineState.test.js tests/core/pipelineMetrics.test.js tests/core/pipelineInitialSelection.test.js tests/core/pipelineMeta.test.js tests/core/pipelineTrace.test.js tests/core/candidateEvaluation.test.js`
  - 结果：`pass=93`，`fail=0`
- `pnpm exec node --test tests/core/watermarkProcessor.test.js`
  - 结果：`pass=61`，`fail=0`，`skipped=3`
- `pnpm build`
  - 结果：通过
  - 备注：sandbox 用户下 build 输出了 git `safe.directory` ownership 警告，但命令退出成功。
- full benchmark：
  - report：`.artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase4-accepted-executor.json`
  - markdown：`.artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase4-accepted-executor.md`
  - 结果：`978/1000 = 97.80%`
  - `newlyPassing=0`
  - `newlyFailing=0`
  - `decisionPath` 覆盖：`1000/1000`
  - accepted decision：`984`
  - rejected decision：`16`
  - `repairApplied=175`
- gate：
  - `pnpm benchmark:online-sample:gate -- --report .artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase4-accepted-executor.json --min-newly-passing 0`
  - 结果：通过

下一步：

1. 继续评估 executor 入参瘦身，优先抽 “metrics / gates / refiners dependency bundle”，减少 `processWatermarkImageData(...)` 中的长参数列表。
2. 之后再评估是否把 detection accepted/rejected finalization 也收进更完整的 `runImageWatermarkPipeline(...)` 外壳。
3. 每一步仍用 full benchmark / gate 检查 `newlyFailing=0`。

已完成的第五十八步：

- `src/core/watermarkProcessor.js` 新增 `createAcceptedPipelineExecutorRequest(...)`，把 accepted executor 所需的 runtime context、metrics、gates、config、refiners 和 debug timing 注入收束到一个请求构造函数。
- `processWatermarkImageData(...)` 现在只把 `options`、`totalStartedAt`、`runtimeBootstrap`、`pipelineTraceRecorder`、`originalImageData`、`alpha96`、`debugTimings`、`debugTimingsEnabled`、`templateWarp`、`subpixelShift` 交给 request builder，再调用 `runAcceptedAlphaRepairPipeline(...)`。
- 这一刀没有移动任何 alpha / repair stage，也没有改 detection、候选评分、gate、refiner 或 finalization；目标只是减少主函数中长块依赖装配，让下一步可以把 dependency bundle 继续外提。
- 行为约束：executor 收到的实际依赖、stage 顺序、refiner/gate 入参、state commit、passState、subpixelShift、debug timing、trace 字段、meta、decisionPath 和输出像素保持等价。

验证证据：

- `node --check src/core/watermarkProcessor.js`
  - 结果：通过
- `node --check src/core/pipelineAcceptedExecutor.js`
  - 结果：通过
- `pnpm exec node --test tests/core/pipelineAcceptedExecutor.test.js tests/core/pipelineRuntime.test.js tests/core/pipelineAlphaStageSpecs.test.js tests/core/pipelineRepairStageSpecs.test.js`
  - 结果：`pass=49`，`fail=0`
- `pnpm exec node --test tests/core/pipelineAcceptedExecutor.test.js tests/core/pipelineAlphaStageSpecs.test.js tests/core/pipelineFinalization.test.js tests/core/pipelinePassState.test.js tests/core/pipelineRuntime.test.js tests/core/pipelineRuntimeBootstrap.test.js tests/core/pipelineRepairStageSpecs.test.js tests/core/pipelineResult.test.js tests/core/pipelineTimings.test.js tests/core/pipelineRepairGates.test.js tests/core/pipelineState.test.js tests/core/pipelineMetrics.test.js tests/core/pipelineInitialSelection.test.js tests/core/pipelineMeta.test.js tests/core/pipelineTrace.test.js tests/core/candidateEvaluation.test.js`
  - 结果：`pass=93`，`fail=0`
- `pnpm exec node --test tests/core/watermarkProcessor.test.js`
  - 结果：`pass=61`，`fail=0`，`skipped=3`
  - 备注：sandbox 网络限制导致 pnpm 补依赖时先遇到 registry `EACCES`，随后用已授权提权命令恢复依赖并完成测试。
- `pnpm build`
  - 结果：通过
  - 备注：sandbox 用户下 build 输出了 git `safe.directory` ownership 警告，但命令退出成功。
- full benchmark：
  - report：`.artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase4-executor-request.json`
  - markdown：`.artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase4-executor-request.md`
  - 结果：`978/1000 = 97.80%`
  - `newlyPassing=0`
  - `newlyFailing=0`
  - `decisionPath` 覆盖：`1000/1000`
  - accepted decision：`984`
  - rejected decision：`16`
  - `repairApplied=175`
- gate：
  - `pnpm benchmark:online-sample:gate -- --report .artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase4-executor-request.json --min-newly-passing 0`
  - 结果：通过

下一步：

1. 优先评估是否把 `createAcceptedPipelineExecutorRequest(...)` 从 `watermarkProcessor.js` 移到独立模块，让主流程只装配业务上下文，不直接持有所有 metrics/gates/refiners 依赖。
2. 如果继续在同文件内推进，则先把 metrics / gates / config / refiners 分成更小的 dependency bundle，降低单个构造函数的认知负担。
3. 再往后评估 detection accepted/rejected finalization 是否能进入外层 `runImageWatermarkPipeline(...)`，但仍保持每刀行为等价和 `newlyFailing=0`。

已完成的第五十九步：

- `src/core/watermarkProcessor.js` 新增四个 accepted executor dependency bundle helper：
  - `createAcceptedPipelineMetrics()`
  - `createAcceptedPipelineGates()`
  - `createAcceptedPipelineExecutorConfig()`
  - `createAcceptedPipelineRefiners()`
- `createAcceptedPipelineExecutorRequest(...)` 不再直接内联大块 `metrics / gates / config / refiners` 对象，而是组合这些 bundle helper。
- 这一刀仍把 helper 留在 `watermarkProcessor.js` 内部，没有新增 export，也没有把私有 refiner/gate 暴露到其它模块；目标是先降低单个 request builder 的认知负担，为后续外移做准备。
- 行为约束：executor request 的字段名和值保持等价；alpha / repair stage、gate、refiner、配置常量、debug timing、trace、meta、decisionPath 和输出像素不变。

验证证据：

- `node --check src/core/watermarkProcessor.js`
  - 结果：通过
- `pnpm exec node --test tests/core/pipelineAcceptedExecutor.test.js tests/core/pipelineRuntime.test.js tests/core/pipelineAlphaStageSpecs.test.js tests/core/pipelineRepairStageSpecs.test.js`
  - 结果：`pass=49`，`fail=0`
- `pnpm exec node --test tests/core/pipelineAcceptedExecutor.test.js tests/core/pipelineAlphaStageSpecs.test.js tests/core/pipelineFinalization.test.js tests/core/pipelinePassState.test.js tests/core/pipelineRuntime.test.js tests/core/pipelineRuntimeBootstrap.test.js tests/core/pipelineRepairStageSpecs.test.js tests/core/pipelineResult.test.js tests/core/pipelineTimings.test.js tests/core/pipelineRepairGates.test.js tests/core/pipelineState.test.js tests/core/pipelineMetrics.test.js tests/core/pipelineInitialSelection.test.js tests/core/pipelineMeta.test.js tests/core/pipelineTrace.test.js tests/core/candidateEvaluation.test.js`
  - 结果：`pass=93`，`fail=0`
- `pnpm exec node --test tests/core/watermarkProcessor.test.js`
  - 结果：`pass=61`，`fail=0`，`skipped=3`
- `pnpm build`
  - 结果：通过
  - 备注：sandbox 用户下 build 输出了 git `safe.directory` ownership 警告，但命令退出成功。
- full benchmark：
  - report：`.artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase4-dependency-bundles.json`
  - markdown：`.artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase4-dependency-bundles.md`
  - 结果：`978/1000 = 97.80%`
  - `newlyPassing=0`
  - `newlyFailing=0`
  - `decisionPath` 覆盖：`1000/1000`
  - accepted decision：`984`
  - rejected decision：`16`
  - `repairApplied=175`
- gate：
  - `pnpm benchmark:online-sample:gate -- --report .artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase4-dependency-bundles.json --min-newly-passing 0`
  - 结果：通过

下一步：

1. 评估把 dependency bundle helper 移入新的 `pipelineAcceptedExecutorDependencies.js` 是否划算；如果外移会迫使大量私有函数 export，则暂缓。
2. 更稳的下一刀可能是把 `createAcceptedPipelineExecutorRequest(...)` 改为接受一个显式 `acceptedPipelineDependencies` 参数，默认由当前文件创建，先建立可替换边界。
3. 之后再考虑把 accepted/rejected finalization 收进外层 `runImageWatermarkPipeline(...)`。

已完成的第六十步：

- `src/core/watermarkProcessor.js` 新增 `createAcceptedPipelineDependencies()`，统一聚合：
  - `metrics`
  - `gates`
  - `config`
  - `refiners`
- `createAcceptedPipelineExecutorRequest(...)` 现在接受显式 `acceptedPipelineDependencies` 参数，并默认回退到 `createAcceptedPipelineDependencies()`。
- `processWatermarkImageData(...)` 在创建 accepted executor request 前显式创建 `acceptedPipelineDependencies` 并传入 request builder。
- 这一刀建立了可替换依赖边界，但仍不外移私有 refiner/gate，也不改变 `runAcceptedAlphaRepairPipeline(...)` 的 public request shape；后续如果外移依赖层，可以先替换 dependency provider，而不是同时改主流程和 executor。
- 行为约束：executor request 字段、依赖函数引用、配置常量、stage 顺序、gate/refiner 入参、trace、meta、decisionPath 和输出像素保持等价。

验证证据：

- `node --check src/core/watermarkProcessor.js`
  - 结果：通过
- `pnpm exec node --test tests/core/pipelineAcceptedExecutor.test.js tests/core/pipelineRuntime.test.js tests/core/pipelineAlphaStageSpecs.test.js tests/core/pipelineRepairStageSpecs.test.js`
  - 结果：`pass=49`，`fail=0`
- `pnpm exec node --test tests/core/pipelineAcceptedExecutor.test.js tests/core/pipelineAlphaStageSpecs.test.js tests/core/pipelineFinalization.test.js tests/core/pipelinePassState.test.js tests/core/pipelineRuntime.test.js tests/core/pipelineRuntimeBootstrap.test.js tests/core/pipelineRepairStageSpecs.test.js tests/core/pipelineResult.test.js tests/core/pipelineTimings.test.js tests/core/pipelineRepairGates.test.js tests/core/pipelineState.test.js tests/core/pipelineMetrics.test.js tests/core/pipelineInitialSelection.test.js tests/core/pipelineMeta.test.js tests/core/pipelineTrace.test.js tests/core/candidateEvaluation.test.js`
  - 结果：`pass=93`，`fail=0`
- `pnpm exec node --test tests/core/watermarkProcessor.test.js`
  - 结果：`pass=61`，`fail=0`，`skipped=3`
- `pnpm build`
  - 结果：通过
  - 备注：sandbox 用户下 build 输出了 git `safe.directory` ownership 警告，但命令退出成功。
- full benchmark：
  - report：`.artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase4-explicit-dependencies.json`
  - markdown：`.artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase4-explicit-dependencies.md`
  - 结果：`978/1000 = 97.80%`
  - `newlyPassing=0`
  - `newlyFailing=0`
  - `decisionPath` 覆盖：`1000/1000`
  - accepted decision：`984`
  - rejected decision：`16`
  - `repairApplied=175`
- gate：
  - `pnpm benchmark:online-sample:gate -- --report .artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase4-explicit-dependencies.json --min-newly-passing 0`
  - 结果：通过

下一步：

1. 优先做一刀 request construction 旁路测试或小型导出测试，锁定 `acceptedPipelineDependencies` 可替换边界，避免后续外移时只能靠大 benchmark 发现装配错误。
2. 再评估把 dependency provider 外移到 `pipelineAcceptedExecutorDependencies.js`；如果需要导出大量私有 refiner/gate，则先停在 provider 边界，不强推模块拆分。
3. Phase 4 后续主线仍是把 accepted/rejected finalization 收进更完整的 `runImageWatermarkPipeline(...)` 外壳。

已完成的第六十一步：

- 新增 `src/core/pipelineAcceptedExecutorRequest.js`，导出 `createAcceptedPipelineExecutorRequest(...)`。
- `src/core/watermarkProcessor.js` 移除本地 request builder，改为从新模块导入；主流程仍在本文件内创建 `acceptedPipelineDependencies`，再把 `nowMs`、`ENABLE_VISUAL_POST_PROCESSING`、runtime context 和 dependencies 传入 request builder。
- 新增 `tests/core/pipelineAcceptedExecutorRequest.test.js`，锁定：
  - runtime context 映射
  - `options.getAlphaMap`
  - `options.alpha96Variants`
  - `options.locatedAggressiveRemoval`
  - `runtimeBootstrap.passState`
  - injected `metrics / gates / config / refiners` 引用保持不变
  - 缺省 `alpha96Variants` 归一为 `null`
- 这一刀没有外移私有 refiner/gate，也没有改变 executor request 的 public shape；它只把纯 request construction 从主处理器剥离出来，让后续 dependency provider 外移可以被单测覆盖。
- 行为约束：stage 顺序、依赖函数引用、配置常量、gate/refiner 入参、trace、meta、decisionPath 和输出像素保持等价。

验证证据：

- `node --check src/core/watermarkProcessor.js`
  - 结果：通过
- `node --check src/core/pipelineAcceptedExecutorRequest.js`
  - 结果：通过
- `pnpm exec node --test tests/core/pipelineAcceptedExecutorRequest.test.js tests/core/pipelineAcceptedExecutor.test.js tests/core/pipelineRuntime.test.js tests/core/pipelineAlphaStageSpecs.test.js tests/core/pipelineRepairStageSpecs.test.js`
  - 结果：`pass=51`，`fail=0`
- `pnpm exec node --test tests/core/pipelineAcceptedExecutorRequest.test.js tests/core/pipelineAcceptedExecutor.test.js tests/core/pipelineAlphaStageSpecs.test.js tests/core/pipelineFinalization.test.js tests/core/pipelinePassState.test.js tests/core/pipelineRuntime.test.js tests/core/pipelineRuntimeBootstrap.test.js tests/core/pipelineRepairStageSpecs.test.js tests/core/pipelineResult.test.js tests/core/pipelineTimings.test.js tests/core/pipelineRepairGates.test.js tests/core/pipelineState.test.js tests/core/pipelineMetrics.test.js tests/core/pipelineInitialSelection.test.js tests/core/pipelineMeta.test.js tests/core/pipelineTrace.test.js tests/core/candidateEvaluation.test.js`
  - 结果：`pass=95`，`fail=0`
- `pnpm exec node --test tests/core/watermarkProcessor.test.js`
  - 结果：`pass=61`，`fail=0`，`skipped=3`
- `pnpm build`
  - 结果：通过
  - 备注：sandbox 用户下 build 输出了 git `safe.directory` ownership 警告，但命令退出成功。
- full benchmark：
  - report：`.artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase4-request-builder-module.json`
  - markdown：`.artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase4-request-builder-module.md`
  - 结果：`978/1000 = 97.80%`
  - `newlyPassing=0`
  - `newlyFailing=0`
  - `decisionPath` 覆盖：`1000/1000`
  - accepted decision：`984`
  - rejected decision：`16`
  - `repairApplied=175`
- gate：
  - `pnpm benchmark:online-sample:gate -- --report .artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase4-request-builder-module.json --min-newly-passing 0`
  - 结果：通过

下一步：

1. 评估是否把 `createAcceptedPipelineDependencies()` 外移成 provider 模块；如果为了外移必须导出大量私有 refiner/gate，则先不要做。
2. 可选的稳妥路线：先把 accepted finalization 的 request/context construction 也抽成独立模块，继续减少 `processWatermarkImageData(...)` 的尾部装配负担。
3. 继续保持每刀 `newlyFailing=0`，优先做结构边界，不改 alpha / repair 策略。

已完成的第六十二步：

- 新增 `src/core/pipelineAcceptedFinalizationRequest.js`，导出 `createAcceptedPipelineFinalizationRequest(...)`。
- `src/core/watermarkProcessor.js` 不再手写 accepted finalization 入参对象，改为：
  - 将 `acceptedPipelineRun`
  - `pipelineTraceRecorder`
  - `resultContext`
  - `originalImageData`
  - `initialSelection`
  - `resolvedConfig`
  交给 request builder，再调用 `createAcceptedPipelineFinalResult(...)`。
- 移除了主函数中只用于 finalization 的 `alphaAdjustmentStages / alphaTrialEvents` 局部解构，trace 状态由新 request builder 从 recorder 中读取。
- 新增 `tests/core/pipelineAcceptedFinalizationRequest.test.js`，锁定：
  - `acceptedPipelineRun.readPipelineState()` 映射到 `pipelineState`
  - `acceptedPipelineRun.passState` 映射到 `passState`
  - `pipelineTraceRecorder.alphaAdjustmentStages / alphaTrialEvents` 映射到 `traceState`
  - `resultContext / originalImageData / initialSelection / resolvedConfig` 引用透传
- 这一刀继续瘦身 `processWatermarkImageData(...)` 尾部装配，不改变 accepted finalizer、meta、decisionPath 或任何像素处理逻辑。
- 行为约束：finalization 输入语义、selection debug、residual visibility、trace、meta、decisionPath 和输出像素保持等价。

验证证据：

- `node --check src/core/watermarkProcessor.js`
  - 结果：通过
- `node --check src/core/pipelineAcceptedFinalizationRequest.js`
  - 结果：通过
- `pnpm exec node --test tests/core/pipelineAcceptedFinalizationRequest.test.js tests/core/pipelineAcceptedExecutorRequest.test.js tests/core/pipelineAcceptedExecutor.test.js tests/core/pipelineFinalization.test.js tests/core/pipelineRuntime.test.js tests/core/pipelineAlphaStageSpecs.test.js tests/core/pipelineRepairStageSpecs.test.js`
  - 结果：`pass=53`，`fail=0`
- `pnpm exec node --test tests/core/pipelineAcceptedFinalizationRequest.test.js tests/core/pipelineAcceptedExecutorRequest.test.js tests/core/pipelineAcceptedExecutor.test.js tests/core/pipelineAlphaStageSpecs.test.js tests/core/pipelineFinalization.test.js tests/core/pipelinePassState.test.js tests/core/pipelineRuntime.test.js tests/core/pipelineRuntimeBootstrap.test.js tests/core/pipelineRepairStageSpecs.test.js tests/core/pipelineResult.test.js tests/core/pipelineTimings.test.js tests/core/pipelineRepairGates.test.js tests/core/pipelineState.test.js tests/core/pipelineMetrics.test.js tests/core/pipelineInitialSelection.test.js tests/core/pipelineMeta.test.js tests/core/pipelineTrace.test.js tests/core/candidateEvaluation.test.js`
  - 结果：`pass=96`，`fail=0`
- `pnpm exec node --test tests/core/watermarkProcessor.test.js`
  - 结果：`pass=61`，`fail=0`，`skipped=3`
- `pnpm build`
  - 结果：通过
  - 备注：sandbox 用户下 build 输出了 git `safe.directory` ownership 警告，但命令退出成功。
- full benchmark：
  - report：`.artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase4-finalization-request.json`
  - markdown：`.artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase4-finalization-request.md`
  - 结果：`978/1000 = 97.80%`
  - `newlyPassing=0`
  - `newlyFailing=0`
  - `decisionPath` 覆盖：`1000/1000`
  - accepted decision：`984`
  - rejected decision：`16`
  - `repairApplied=175`
- gate：
  - `pnpm benchmark:online-sample:gate -- --report .artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase4-finalization-request.json --min-newly-passing 0`
  - 结果：通过

下一步：

1. 检查 skipped/rejected path 的 result construction，评估是否能像 accepted finalization 一样抽出 `pipelineRejectedFinalizationRequest` 或统一 result shell。
2. 如果 rejected path 太小，转向外层 `runImageWatermarkPipeline(...)` 壳：把 initial selection、accepted executor、finalization 三段串联从 `processWatermarkImageData(...)` 中继续搬出。
3. 暂不外移 `createAcceptedPipelineDependencies()`，除非确认不会迫使大规模公开私有 refiner/gate。

已完成的第六十三步：

- 新增 `src/core/pipelineInitialContext.js`，导出 `createInitialPipelineContext(...)`。
- initial context builder 现在负责：
  - 归一 `adaptiveMode` 到 `allowAdaptiveSearch`
  - clone 输入 `imageData` 为 `originalImageData`
  - 校验 `alpha48 / alpha96`
  - 计算 `defaultConfig`
  - 解析 `resolvedConfig`
  - 计算初始 `position`
  - 透传 `alphaGainCandidates / alphaPriorityGains`
- `src/core/watermarkProcessor.js` 移除主函数里的输入准备散块，改为一次调用 `createInitialPipelineContext(...)`；同时清理了只剩历史残留的 `alphaMap / source` 局部变量和不再使用的 `watermarkConfig` import。
- 新增 `tests/core/pipelineInitialContext.test.js`，锁定：
  - clone 调用和 cloned image 引用
  - injected `detectConfig / resolveConfig / calculatePosition` 调用顺序与 payload
  - alpha 候选透传
  - `adaptiveMode=off` 禁用 adaptive search
  - 默认 adaptive search 开启
  - 缺少 `alpha48 / alpha96` 时保留原错误信息
- 这一刀把 detection 前置上下文准备迁入独立层，主函数保留 orchestration，不改变候选选择、alpha、repair、evaluation 或 finalization 行为。
- 行为约束：初始 config/position、alpha 候选、adaptive search gate、debug timing、meta、decisionPath 和输出像素保持等价。

验证证据：

- `node --check src/core/watermarkProcessor.js`
  - 结果：通过
- `node --check src/core/pipelineInitialContext.js`
  - 结果：通过
- `pnpm exec node --test tests/core/pipelineInitialContext.test.js tests/core/pipelineInitialSelection.test.js tests/core/pipelineAcceptedFinalizationRequest.test.js tests/core/pipelineAcceptedExecutorRequest.test.js tests/core/pipelineAcceptedExecutor.test.js tests/core/pipelineFinalization.test.js tests/core/pipelineRuntime.test.js tests/core/pipelineAlphaStageSpecs.test.js tests/core/pipelineRepairStageSpecs.test.js`
  - 结果：`pass=59`，`fail=0`
- `pnpm exec node --test tests/core/pipelineInitialContext.test.js tests/core/pipelineInitialSelection.test.js tests/core/pipelineAcceptedFinalizationRequest.test.js tests/core/pipelineAcceptedExecutorRequest.test.js tests/core/pipelineAcceptedExecutor.test.js tests/core/pipelineAlphaStageSpecs.test.js tests/core/pipelineFinalization.test.js tests/core/pipelinePassState.test.js tests/core/pipelineRuntime.test.js tests/core/pipelineRuntimeBootstrap.test.js tests/core/pipelineRepairStageSpecs.test.js tests/core/pipelineResult.test.js tests/core/pipelineTimings.test.js tests/core/pipelineRepairGates.test.js tests/core/pipelineState.test.js tests/core/pipelineMetrics.test.js tests/core/pipelineMeta.test.js tests/core/pipelineTrace.test.js tests/core/candidateEvaluation.test.js`
  - 结果：`pass=99`，`fail=0`
- `pnpm exec node --test tests/core/watermarkProcessor.test.js`
  - 结果：`pass=61`，`fail=0`，`skipped=3`
- `pnpm build`
  - 结果：通过
  - 备注：sandbox 用户下 build 输出了 git `safe.directory` ownership 警告，但命令退出成功。
- full benchmark：
  - report：`.artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase4-initial-context.json`
  - markdown：`.artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase4-initial-context.md`
  - 结果：`978/1000 = 97.80%`
  - `newlyPassing=0`
  - `newlyFailing=0`
  - `decisionPath` 覆盖：`1000/1000`
  - accepted decision：`984`
  - rejected decision：`16`
  - `repairApplied=175`
- gate：
  - `pnpm benchmark:online-sample:gate -- --report .artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase4-initial-context.json --min-newly-passing 0`
  - 结果：通过

下一步：

1. 开始评估外层 `runImageWatermarkPipeline(...)` 壳，把 initial context、initial selection、accepted executor、accepted finalization 串联从 `processWatermarkImageData(...)` 中继续搬出。
2. rejected/skipped path 当前较小，暂不单独拆；如果外层壳需要统一返回，再一起做 rejected request/result shell。
3. 继续保持策略冻结：不改 alpha / repair 阈值，不新增样本特例，每刀都跑 full benchmark / gate。

已完成的第六十四步：

- 新增 `src/core/imageWatermarkPipeline.js`，导出 `runImageWatermarkPipeline(...)`。
- 外层 pipeline 壳现在串联：
  - `createInitialPipelineContext(...)`
  - `selectInitialWatermarkCandidate(...)`
  - rejected early return
  - `createAcceptedPipelineState(...)`
  - `createAcceptedPipelineRuntimeBootstrap(...)`
  - `runAcceptedAlphaRepairPipeline(...)`
  - `createAcceptedPipelineFinalizationRequest(...)`
  - `createAcceptedPipelineFinalResult(...)`
- `src/core/watermarkProcessor.js` 的 `processWatermarkImageData(...)` 现在退回到 thin adapter：
  - 传入 `nowMs`
  - 传入私有 `cloneImageData`
  - 传入 alpha 候选常量
  - 传入 `createAcceptedPipelineDependencies`
  - 传入 cleanup config 常量
  - 传入 `ENABLE_VISUAL_POST_PROCESSING`
- 新增 `tests/core/imageWatermarkPipeline.test.js`，锁定：
  - initial selection rejected 时不会创建 accepted dependencies
  - rejected path 的 debug timings、detection scores、decision tier 映射
  - accepted path 的 executor request 装配
  - injected `metrics / gates / config / refiners` 引用透传
  - accepted finalization request 中的 passState、initialSelection、resultContext 映射
- `runImageWatermarkPipeline(...)` 暴露测试用可注入 selector / accepted runner / result factories，生产路径默认使用现有模块；这让 orchestration 可被小单测覆盖，而不是只依赖 full benchmark。
- 这一刀是 Phase 4 的关键外壳迁移：`processWatermarkImageData(...)` 不再直接持有 detection/accepted/rejected/finalization 串联逻辑，但仍不改变 alpha / repair 策略或私有 refiner/gate。
- 行为约束：初始检测、accepted/rejected 分布、executor request、finalization request、debug timing shape、trace、meta、decisionPath 和输出像素保持等价。

验证证据：

- `node --check src/core/watermarkProcessor.js`
  - 结果：通过
- `node --check src/core/imageWatermarkPipeline.js`
  - 结果：通过
- `pnpm exec node --test tests/core/imageWatermarkPipeline.test.js tests/core/pipelineInitialContext.test.js tests/core/pipelineInitialSelection.test.js tests/core/pipelineAcceptedFinalizationRequest.test.js tests/core/pipelineAcceptedExecutorRequest.test.js tests/core/pipelineAcceptedExecutor.test.js tests/core/pipelineFinalization.test.js tests/core/pipelineRuntime.test.js tests/core/pipelineAlphaStageSpecs.test.js tests/core/pipelineRepairStageSpecs.test.js`
  - 结果：`pass=61`，`fail=0`
- `pnpm exec node --test tests/core/imageWatermarkPipeline.test.js tests/core/pipelineInitialContext.test.js tests/core/pipelineInitialSelection.test.js tests/core/pipelineAcceptedFinalizationRequest.test.js tests/core/pipelineAcceptedExecutorRequest.test.js tests/core/pipelineAcceptedExecutor.test.js tests/core/pipelineAlphaStageSpecs.test.js tests/core/pipelineFinalization.test.js tests/core/pipelinePassState.test.js tests/core/pipelineRuntime.test.js tests/core/pipelineRuntimeBootstrap.test.js tests/core/pipelineRepairStageSpecs.test.js tests/core/pipelineResult.test.js tests/core/pipelineTimings.test.js tests/core/pipelineRepairGates.test.js tests/core/pipelineState.test.js tests/core/pipelineMetrics.test.js tests/core/pipelineMeta.test.js tests/core/pipelineTrace.test.js tests/core/candidateEvaluation.test.js`
  - 结果：`pass=101`，`fail=0`
- `pnpm exec node --test tests/core/watermarkProcessor.test.js`
  - 结果：`pass=61`，`fail=0`，`skipped=3`
- `pnpm build`
  - 结果：通过
  - 备注：sandbox 用户下 build 输出了 git `safe.directory` ownership 警告，但命令退出成功。
- full benchmark：
  - report：`.artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase4-pipeline-shell.json`
  - markdown：`.artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase4-pipeline-shell.md`
  - 结果：`978/1000 = 97.80%`
  - `newlyPassing=0`
  - `newlyFailing=0`
  - `decisionPath` 覆盖：`1000/1000`
  - accepted decision：`984`
  - rejected decision：`16`
  - `repairApplied=175`
- gate：
  - `pnpm benchmark:online-sample:gate -- --report .artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase4-pipeline-shell.json --min-newly-passing 0`
  - 结果：通过

下一步：

1. 收口 Phase 4：检查 `watermarkProcessor.js` 是否还持有可以安全外提的 pure dependency provider，例如 accepted dependency bundle 的 provider 边界。
2. 评估是否把 `createAcceptedPipelineDependencies()` 外移；如果会迫使大量私有 refiner/gate 暴露，则保留在 adapter，转向文档化当前边界。
3. 开始准备 Phase 5：把 detection / alpha / repair / evaluation 的公开接口命名和稳定测试矩阵整理出来，避免继续只做文件层搬运。

已完成的第六十五步：

- 新增 `src/core/imageWatermarkPipelineRequest.js`，导出：
  - `createImageWatermarkPipelineCleanupConfig(...)`
  - `createImageWatermarkPipelineRequest(...)`
- `src/core/watermarkProcessor.js` 的 `processWatermarkImageData(...)` 不再直接内联 `runImageWatermarkPipeline(...)` 的 request 对象，改为：
  - 先用 `createImageWatermarkPipelineCleanupConfig(...)` 组装 cleanup config
  - 再用 `createImageWatermarkPipelineRequest(...)` 组装外层 pipeline request
  - 最后调用 `runImageWatermarkPipeline(...)`
- 新增 `tests/core/imageWatermarkPipelineRequest.test.js`，锁定：
  - cleanup config 常量映射
  - adapter request 对 `imageData / options / nowMs / cloneImageData / alpha candidates / dependency provider / cleanupConfig` 的引用透传
  - `visualPostProcessingEnabled` 默认值为 `false`
- 这一步没有外移 `createAcceptedPipelineDependencies()`：当前 provider 仍绑定大量私有 refiner/gate，强行外移会迫使公开过多内部策略函数，收益低于风险。Phase 4 当前更合适的边界是让 `watermarkProcessor.js` 作为 adapter 持有私有依赖 provider。
- 行为约束：外层 pipeline request 字段、cleanup config、accepted dependencies、debug timing、trace、meta、decisionPath 和输出像素保持等价。

验证证据：

- `node --check src/core/watermarkProcessor.js`
  - 结果：通过
- `node --check src/core/imageWatermarkPipelineRequest.js`
  - 结果：通过
- `pnpm exec node --test tests/core/imageWatermarkPipelineRequest.test.js tests/core/imageWatermarkPipeline.test.js tests/core/pipelineInitialContext.test.js tests/core/pipelineInitialSelection.test.js tests/core/pipelineAcceptedFinalizationRequest.test.js tests/core/pipelineAcceptedExecutorRequest.test.js tests/core/pipelineAcceptedExecutor.test.js tests/core/pipelineFinalization.test.js tests/core/pipelineRuntime.test.js tests/core/pipelineAlphaStageSpecs.test.js tests/core/pipelineRepairStageSpecs.test.js`
  - 结果：`pass=64`，`fail=0`
- `pnpm exec node --test tests/core/imageWatermarkPipelineRequest.test.js tests/core/imageWatermarkPipeline.test.js tests/core/pipelineInitialContext.test.js tests/core/pipelineInitialSelection.test.js tests/core/pipelineAcceptedFinalizationRequest.test.js tests/core/pipelineAcceptedExecutorRequest.test.js tests/core/pipelineAcceptedExecutor.test.js tests/core/pipelineAlphaStageSpecs.test.js tests/core/pipelineFinalization.test.js tests/core/pipelinePassState.test.js tests/core/pipelineRuntime.test.js tests/core/pipelineRuntimeBootstrap.test.js tests/core/pipelineRepairStageSpecs.test.js tests/core/pipelineResult.test.js tests/core/pipelineTimings.test.js tests/core/pipelineRepairGates.test.js tests/core/pipelineState.test.js tests/core/pipelineMetrics.test.js tests/core/pipelineMeta.test.js tests/core/pipelineTrace.test.js tests/core/candidateEvaluation.test.js`
  - 结果：`pass=104`，`fail=0`
- `pnpm exec node --test tests/core/watermarkProcessor.test.js`
  - 结果：`pass=61`，`fail=0`，`skipped=3`
- `pnpm build`
  - 结果：通过
  - 备注：sandbox 用户下 build 输出了 git `safe.directory` ownership 警告，但命令退出成功。
- full benchmark：
  - report：`.artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase4-pipeline-request.json`
  - markdown：`.artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase4-pipeline-request.md`
  - 结果：`978/1000 = 97.80%`
  - `newlyPassing=0`
  - `newlyFailing=0`
  - `decisionPath` 覆盖：`1000/1000`
  - accepted decision：`984`
  - rejected decision：`16`
  - `repairApplied=175`
- gate：
  - `pnpm benchmark:online-sample:gate -- --report .artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase4-pipeline-request.json --min-newly-passing 0`
  - 结果：通过

下一步：

1. Phase 4 可进入收尾审阅：确认 `processWatermarkImageData(...)` 是否已经满足 thin adapter 目标，以及哪些私有 provider 应保留在 `watermarkProcessor.js`。
2. 开始整理 Phase 5 接口矩阵：detection、alpha、repair、evaluation 每层的输入、输出、测试和 benchmark 证据。
3. 若继续动代码，优先做命名/边界文档化或小型接口测试，不再为了“文件更少代码”而强行 export 私有 refiner/gate。

已完成的第六十六步：

- 新增 `src/core/pipelineLayerContracts.js`，导出：
  - `PIPELINE_LAYER_ORDER`
  - `PIPELINE_LAYER_CONTRACTS`
  - `getPipelineLayerContract(...)`
  - `createPipelineLayerContractSummary()`
- Phase 5 的四层契约现在以代码形式固定：
  - `detection`
  - `alpha`
  - `repair`
  - `evaluation`
- 每层 contract 记录：
  - layer 名称
  - ownership 描述
  - input fields
  - output fields
  - module anchors
  - test anchors
- 新增 `tests/core/pipelineLayerContracts.test.js`，锁定：
  - canonical layer order：`detection -> alpha -> repair -> evaluation`
  - contracts key 顺序和 layer order 一致
  - 每层都有 ownership / inputs / outputs / module anchors / test anchors
  - 关键输出锚点存在：`selectedTrial`、`alphaTrialEvents`、`repairTrial`、`decisionPath`
  - unknown layer 返回 `null`
  - summary 只暴露 counts 和 anchors，不直接展开完整 field arrays
- 这一刀不进入像素处理路径，目标是把 Phase 5 的公开接口矩阵变成可测试的代码契约，避免后续迁移只靠文档记忆。
- 行为约束：runtime pipeline、candidate selection、alpha/repair execution、meta、decisionPath 和输出像素不变。

验证证据：

- `node --check src/core/pipelineLayerContracts.js`
  - 结果：通过
- `node --check src/core/watermarkProcessor.js`
  - 结果：通过
- `pnpm exec node --test tests/core/pipelineLayerContracts.test.js tests/core/imageWatermarkPipelineRequest.test.js tests/core/imageWatermarkPipeline.test.js tests/core/pipelineInitialContext.test.js tests/core/pipelineInitialSelection.test.js tests/core/pipelineAcceptedFinalizationRequest.test.js tests/core/pipelineAcceptedExecutorRequest.test.js tests/core/pipelineAcceptedExecutor.test.js tests/core/pipelineFinalization.test.js tests/core/pipelineRuntime.test.js tests/core/pipelineAlphaStageSpecs.test.js tests/core/pipelineRepairStageSpecs.test.js`
  - 结果：`pass=68`，`fail=0`
- `pnpm exec node --test tests/core/pipelineLayerContracts.test.js tests/core/imageWatermarkPipelineRequest.test.js tests/core/imageWatermarkPipeline.test.js tests/core/pipelineInitialContext.test.js tests/core/pipelineInitialSelection.test.js tests/core/pipelineAcceptedFinalizationRequest.test.js tests/core/pipelineAcceptedExecutorRequest.test.js tests/core/pipelineAcceptedExecutor.test.js tests/core/pipelineAlphaStageSpecs.test.js tests/core/pipelineFinalization.test.js tests/core/pipelinePassState.test.js tests/core/pipelineRuntime.test.js tests/core/pipelineRuntimeBootstrap.test.js tests/core/pipelineRepairStageSpecs.test.js tests/core/pipelineResult.test.js tests/core/pipelineTimings.test.js tests/core/pipelineRepairGates.test.js tests/core/pipelineState.test.js tests/core/pipelineMetrics.test.js tests/core/pipelineMeta.test.js tests/core/pipelineTrace.test.js tests/core/candidateEvaluation.test.js`
  - 结果：`pass=108`，`fail=0`
- `pnpm exec node --test tests/core/watermarkProcessor.test.js`
  - 结果：`pass=61`，`fail=0`，`skipped=3`
- `pnpm build`
  - 结果：通过
  - 备注：sandbox 用户下 build 输出了 git `safe.directory` ownership 警告，但命令退出成功。
- full benchmark：
  - report：`.artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase5-layer-contracts.json`
  - markdown：`.artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase5-layer-contracts.md`
  - 结果：`978/1000 = 97.80%`
  - `newlyPassing=0`
  - `newlyFailing=0`
  - `decisionPath` 覆盖：`1000/1000`
  - accepted decision：`984`
  - rejected decision：`16`
  - `repairApplied=175`
- gate：
  - `pnpm benchmark:online-sample:gate -- --report .artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase5-layer-contracts.json --min-newly-passing 0`
  - 结果：通过

下一步：

1. 按 `pipelineLayerContracts.js` 逐层推进 Phase 5，优先找 detection contract 的真实迁移点：把 selection result 到 detectionCandidate 的适配边界再收紧。
2. alpha / repair / evaluation 后续迁移必须维护 contract anchors，不允许为了文件拆分破坏 `decisionPath` 和 benchmark gate。
3. Phase 4 视为结构上基本收口，除非发现 `watermarkProcessor.js` 还有不需要暴露私有 refiner 的安全切口。

已完成的第六十七步：

- 新增 `src/core/pipelineDetectionCandidate.js`，把 detection 层的候选对象构造从 `candidateEvaluation.js` 里迁出：
  - `createDetectionCandidateFromSelectedTrial(...)`
  - `createRejectedDetectionCandidate(...)`
  - `createDetectionCandidateContractSummary()`
- `candidateEvaluation.js` 现在从 detection 模块导入 accepted / rejected detection candidate builder，并继续 re-export `createDetectionCandidateFromSelectedTrial(...)`，保持外部调用兼容。
- `createRejectedDecisionPath(...)` 改为复用 `createRejectedDetectionCandidate(...)`，让 skipped / rejected 路径也进入 detection contract 边界。
- `pipelineLayerContracts.js` 的 detection anchors 增加：
  - module：`pipelineDetectionCandidate`
  - test：`pipelineDetectionCandidate.test`
- 新增 `tests/core/pipelineDetectionCandidate.test.js`，锁定：
  - accepted detection candidate 的 id / geometry / alphaMapHint / polarityHint / evidence / provenance 映射
  - rejected detection candidate 的 reason / source / scores / adaptiveConfidence 映射
  - detection candidate contract summary 的生产阈值和 evidence 字段
- 行为约束：这一刀只移动 detection candidate 适配边界，不改变 candidate scoring、alpha/repair 执行、evaluation、meta、decisionPath 字段语义或输出像素。

验证证据：

- `node --check src/core/pipelineDetectionCandidate.js`
  - 结果：通过
- `node --check src/core/candidateEvaluation.js`
  - 结果：通过
- `node --check src/core/pipelineLayerContracts.js`
  - 结果：通过
- `pnpm exec node --test tests/core/pipelineDetectionCandidate.test.js tests/core/candidateEvaluation.test.js tests/core/pipelineLayerContracts.test.js tests/core/pipelineMeta.test.js tests/core/pipelineResult.test.js tests/core/watermarkProcessor.test.js`
  - 结果：`pass=84`，`fail=0`，`skipped=3`
- `pnpm exec node --test tests/core/pipelineDetectionCandidate.test.js tests/core/candidateEvaluation.test.js tests/core/pipelineLayerContracts.test.js tests/core/imageWatermarkPipelineRequest.test.js tests/core/imageWatermarkPipeline.test.js tests/core/pipelineInitialContext.test.js tests/core/pipelineInitialSelection.test.js tests/core/pipelineAcceptedFinalizationRequest.test.js tests/core/pipelineAcceptedExecutorRequest.test.js tests/core/pipelineAcceptedExecutor.test.js tests/core/pipelineAlphaStageSpecs.test.js tests/core/pipelineFinalization.test.js tests/core/pipelinePassState.test.js tests/core/pipelineRuntime.test.js tests/core/pipelineRuntimeBootstrap.test.js tests/core/pipelineRepairStageSpecs.test.js tests/core/pipelineResult.test.js tests/core/pipelineTimings.test.js tests/core/pipelineRepairGates.test.js tests/core/pipelineState.test.js tests/core/pipelineMetrics.test.js tests/core/pipelineMeta.test.js tests/core/pipelineTrace.test.js`
  - 结果：`pass=111`，`fail=0`
- `pnpm build`
  - 结果：通过
- full benchmark：
  - report：`.artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase5-detection-candidate.json`
  - markdown：`.artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase5-detection-candidate.md`
  - 结果：`978/1000 = 97.80%`
  - `newlyPassing=0`
  - `newlyFailing=0`
  - `decisionPath` 覆盖：`1000/1000`
  - accepted decision：`984`
  - rejected decision：`16`
  - `repairApplied=175`
- gate：
  - `pnpm benchmark:online-sample:gate -- --report .artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase5-detection-candidate.json --min-newly-passing 0`
  - 结果：通过

下一步：

1. 继续 Phase 5 的真实迁移，优先收紧 alpha contract：把 alpha trial / alpha stage 的“构造规格”和“运行结果事件”之间的边界命名清楚。
2. 保持小步行为等价迁移；每个会触碰输出路径的切口都必须跑 1000 样本 benchmark 和 gate。
3. detection 层后续只在有样本证据时继续改定位/阈值；当前这一步只是 contract 迁移，不解决新的 missed-detection。

已完成的第六十八步：

- 新增 `src/core/pipelineAlphaTrial.js`，把 `decisionPath.alphaTrial` 的构造从 `candidateEvaluation.js` 迁出：
  - `createAlphaTrialFromSelectedTrial(...)`
  - `createAlphaTrialContractSummary(...)`
- `candidateEvaluation.js` 现在导入并 re-export `createAlphaTrialFromSelectedTrial(...)`，保持旧调用路径兼容。
- 同时清理 `candidateEvaluation.js` 中迁出后未再使用的 trial id / config / position helper，让该文件继续向 evaluation / repair path 收敛。
- `pipelineLayerContracts.js` 的 alpha anchors 增加：
  - module：`pipelineAlphaTrial`
  - test：`pipelineAlphaTrial.test`
- 新增 `tests/core/pipelineAlphaTrial.test.js`，锁定：
  - phase2 alpha trial 的 id / detectionId / strategy / migrationStage / alphaShape / scores / gates 映射
  - accepted / rejected alpha trial events 的分流
  - alpha contract summary 的 strategy 和计数字段
- 行为约束：这一刀只移动 `decisionPath.alphaTrial` 适配边界，不改变 alpha 搜索、alpha map、repair、evaluation gate、meta 或输出像素。

验证证据：

- `node --check src/core/pipelineAlphaTrial.js`
  - 结果：通过
- `node --check src/core/candidateEvaluation.js`
  - 结果：通过
- `node --check src/core/pipelineLayerContracts.js`
  - 结果：通过
- `pnpm exec node --test tests/core/pipelineAlphaTrial.test.js tests/core/candidateEvaluation.test.js tests/core/pipelineLayerContracts.test.js`
  - 结果：`pass=17`，`fail=0`
- `pnpm exec node --test tests/core/pipelineAlphaTrial.test.js tests/core/pipelineDetectionCandidate.test.js tests/core/candidateEvaluation.test.js tests/core/pipelineLayerContracts.test.js tests/core/imageWatermarkPipelineRequest.test.js tests/core/imageWatermarkPipeline.test.js tests/core/pipelineInitialContext.test.js tests/core/pipelineInitialSelection.test.js tests/core/pipelineAcceptedFinalizationRequest.test.js tests/core/pipelineAcceptedExecutorRequest.test.js tests/core/pipelineAcceptedExecutor.test.js tests/core/pipelineAlphaStageSpecs.test.js tests/core/pipelineFinalization.test.js tests/core/pipelinePassState.test.js tests/core/pipelineRuntime.test.js tests/core/pipelineRuntimeBootstrap.test.js tests/core/pipelineRepairStageSpecs.test.js tests/core/pipelineResult.test.js tests/core/pipelineTimings.test.js tests/core/pipelineRepairGates.test.js tests/core/pipelineState.test.js tests/core/pipelineMetrics.test.js tests/core/pipelineMeta.test.js tests/core/pipelineTrace.test.js`
  - 结果：`pass=114`，`fail=0`
- `pnpm build`
  - 结果：通过
- full benchmark：
  - report：`.artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase5-alpha-trial.json`
  - markdown：`.artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase5-alpha-trial.md`
  - 结果：`978/1000 = 97.80%`
  - `newlyPassing=0`
  - `newlyFailing=0`
  - `decisionPath` 覆盖：`1000/1000`
  - accepted decision：`984`
  - rejected decision：`16`
  - `repairApplied=175`
- gate：
  - `pnpm benchmark:online-sample:gate -- --report .artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase5-alpha-trial.json --min-newly-passing 0`
  - 结果：通过

下一步：

1. 继续 alpha contract，但先不要再碰像素执行：优先把 `pipelineTrace.js` 里的 alpha event / alpha adjustment stage 记录结构命名成独立 contract。
2. 之后再考虑是否把 alpha stage specs 的“规格构造”和 runtime 的“执行记录”对齐，避免 stage 名称在多处隐式推断。
3. repair 层保持排队，等 alpha trace contract 清楚后再迁 `repairTrial` 构造。

已完成的第六十九步：

- 新增 `src/core/pipelineAlphaTraceContract.js`，把 alpha trace 的记录格式从 `pipelineTrace.js` 里抽出：
  - `normalizeAlphaTrialEventForTrace(...)`
  - `normalizeAlphaAdjustmentStageForTrace(...)`
  - `createAlphaTraceContractSummary(...)`
- `pipelineTrace.js` 现在只负责维护 `alphaAdjustmentStages` / `alphaTrialEvents` 两个数组，并调用 trace contract 做格式归一化。
- `normalizeAlphaTrialEventForTrace(...)` 保持对象 event 原样返回，兼容之前的 verbatim trial event 行为。
- `normalizeAlphaAdjustmentStageForTrace(...)` 保持原先字段和 gate 逻辑：
  - 缺少 stage / alpha gain 时跳过
  - same-gain 默认跳过，`allowSameAlphaGain` 时允许
  - 非有限数归一为 `null`
  - 空字符串 strategy 归一为 `null`
- `pipelineLayerContracts.js` 的 alpha anchors 增加：
  - module：`pipelineAlphaTraceContract`
  - test：`pipelineAlphaTraceContract.test`
- 新增 `tests/core/pipelineAlphaTraceContract.test.js`，锁定：
  - trial event 原样保留
  - alpha adjustment stage 字段归一化和 same-gain gate
  - trace summary 计数字段
- 行为约束：这一刀只命名 alpha trace 记录 contract，不改变 alpha stage 执行、repair、finalization、decisionPath 字段语义或输出像素。

验证证据：

- `node --check src/core/pipelineAlphaTraceContract.js`
  - 结果：通过
- `node --check src/core/pipelineTrace.js`
  - 结果：通过
- `node --check src/core/pipelineLayerContracts.js`
  - 结果：通过
- `pnpm exec node --test tests/core/pipelineAlphaTraceContract.test.js tests/core/pipelineTrace.test.js tests/core/pipelineLayerContracts.test.js tests/core/pipelineAlphaTrial.test.js tests/core/candidateEvaluation.test.js`
  - 结果：`pass=22`，`fail=0`
- `pnpm exec node --test tests/core/pipelineAlphaTraceContract.test.js tests/core/pipelineTrace.test.js tests/core/pipelineAlphaTrial.test.js tests/core/pipelineDetectionCandidate.test.js tests/core/candidateEvaluation.test.js tests/core/pipelineLayerContracts.test.js tests/core/imageWatermarkPipelineRequest.test.js tests/core/imageWatermarkPipeline.test.js tests/core/pipelineInitialContext.test.js tests/core/pipelineInitialSelection.test.js tests/core/pipelineAcceptedFinalizationRequest.test.js tests/core/pipelineAcceptedExecutorRequest.test.js tests/core/pipelineAcceptedExecutor.test.js tests/core/pipelineAlphaStageSpecs.test.js tests/core/pipelineFinalization.test.js tests/core/pipelinePassState.test.js tests/core/pipelineRuntime.test.js tests/core/pipelineRuntimeBootstrap.test.js tests/core/pipelineRepairStageSpecs.test.js tests/core/pipelineResult.test.js tests/core/pipelineTimings.test.js tests/core/pipelineRepairGates.test.js tests/core/pipelineState.test.js tests/core/pipelineMetrics.test.js tests/core/pipelineMeta.test.js`
  - 结果：`pass=117`，`fail=0`
- `pnpm build`
  - 结果：通过
- full benchmark：
  - report：`.artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase5-alpha-trace-contract.json`
  - markdown：`.artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase5-alpha-trace-contract.md`
  - 结果：`978/1000 = 97.80%`
  - `newlyPassing=0`
  - `newlyFailing=0`
  - `decisionPath` 覆盖：`1000/1000`
  - accepted decision：`984`
  - rejected decision：`16`
  - `repairApplied=175`
- gate：
  - `pnpm benchmark:online-sample:gate -- --report .artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase5-alpha-trace-contract.json --min-newly-passing 0`
  - 结果：通过

下一步：

1. 迁移 `repairTrial` 构造：把 `createRepairTrialFromStages(...)` 从 `candidateEvaluation.js` 移到 repair contract 模块。
2. 迁移时保持 `alphaAdjustmentStages` 分类和 `repairStrategy` 推断完全等价，避免影响 `decisionPath.repairTrial` 和 `meta.alphaAdjustmentStages`。
3. 完成后再考虑把 repair stage specs / repair gates 与 `repairTrial` contract 的字段对应关系写进测试。

已完成的第七十步：

- 新增 `src/core/pipelineRepairTrial.js`，把 `decisionPath.repairTrial` 的构造从 `candidateEvaluation.js` 迁出：
  - `createRepairTrialFromStages(...)`
  - `createRepairTrialContractSummary(...)`
- `candidateEvaluation.js` 现在导入并 re-export `createRepairTrialFromStages(...)`，保持旧调用路径兼容。
- 同时清理 `candidateEvaluation.js` 中迁出后未再使用的 repair stage helper：
  - alpha / repair stage pattern
  - stage list normalize
  - repair stage classify
  - repair strategy infer
  - repair params compact helper
- `pipelineLayerContracts.js` 的 repair anchors 增加：
  - module：`pipelineRepairTrial`
  - test：`pipelineRepairTrial.test`
- 新增 `tests/core/pipelineRepairTrial.test.js`，锁定：
  - 无 repair stage 时的 `repair:none` 形状
  - alpha-only stage 不会误归类为 repair
  - repair stage 分类、`repairStrategy` 推断、显式 strategy 优先级
  - scores / artifacts / gates / provenance 字段映射
  - repair contract summary 计数字段
- 行为约束：这一刀只移动 `decisionPath.repairTrial` 适配边界，不改变 repair 执行、repair gate、trace、finalization、meta 或输出像素。

验证证据：

- `node --check src/core/pipelineRepairTrial.js`
  - 结果：通过
- `node --check src/core/candidateEvaluation.js`
  - 结果：通过
- `node --check src/core/pipelineLayerContracts.js`
  - 结果：通过
- `pnpm exec node --test tests/core/pipelineRepairTrial.test.js tests/core/candidateEvaluation.test.js tests/core/pipelineLayerContracts.test.js tests/core/pipelineRepairStageSpecs.test.js tests/core/pipelineRepairGates.test.js`
  - 结果：`pass=26`，`fail=0`
- `pnpm exec node --test tests/core/pipelineRepairTrial.test.js tests/core/pipelineAlphaTraceContract.test.js tests/core/pipelineTrace.test.js tests/core/pipelineAlphaTrial.test.js tests/core/pipelineDetectionCandidate.test.js tests/core/candidateEvaluation.test.js tests/core/pipelineLayerContracts.test.js tests/core/imageWatermarkPipelineRequest.test.js tests/core/imageWatermarkPipeline.test.js tests/core/pipelineInitialContext.test.js tests/core/pipelineInitialSelection.test.js tests/core/pipelineAcceptedFinalizationRequest.test.js tests/core/pipelineAcceptedExecutorRequest.test.js tests/core/pipelineAcceptedExecutor.test.js tests/core/pipelineAlphaStageSpecs.test.js tests/core/pipelineFinalization.test.js tests/core/pipelinePassState.test.js tests/core/pipelineRuntime.test.js tests/core/pipelineRuntimeBootstrap.test.js tests/core/pipelineRepairStageSpecs.test.js tests/core/pipelineResult.test.js tests/core/pipelineTimings.test.js tests/core/pipelineRepairGates.test.js tests/core/pipelineState.test.js tests/core/pipelineMetrics.test.js tests/core/pipelineMeta.test.js`
  - 结果：`pass=120`，`fail=0`
- `pnpm build`
  - 结果：通过
- full benchmark：
  - report：`.artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase5-repair-trial.json`
  - markdown：`.artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase5-repair-trial.md`
  - 结果：`978/1000 = 97.80%`
  - `newlyPassing=0`
  - `newlyFailing=0`
  - `decisionPath` 覆盖：`1000/1000`
  - accepted decision：`984`
  - rejected decision：`16`
  - `repairApplied=175`
- gate：
  - `pnpm benchmark:online-sample:gate -- --report .artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase5-repair-trial.json --min-newly-passing 0`
  - 结果：通过

下一步：

1. 收口 evaluation contract：`candidateEvaluation.js` 现在主要剩 candidate arbitration、accepted/rejected decisionPath 装配和风险 gate，可继续拆出 `pipelineDecisionPath` 或 `pipelineEvaluationDecision`。
2. 优先迁移 accepted/rejected decisionPath 的最终装配，而不是动评分阈值；目标是让 `candidateEvaluation.js` 只保留真正的 candidate scoring / arbitration。
3. 下一刀仍需保持 benchmark gate，因为会触碰 `decisionPath` 顶层形状。

已完成的第七十一步：

- 新增 `src/core/pipelineDecisionPath.js`，把 accepted / rejected `decisionPath` 顶层装配从 `candidateEvaluation.js` 迁出：
  - `createAcceptedDecisionPath(...)`
  - `createRejectedDecisionPath(...)`
  - `createDecisionPathContractSummary(...)`
- `candidateEvaluation.js` 现在导入并 re-export `createAcceptedDecisionPath(...)` / `createRejectedDecisionPath(...)`，保持旧调用路径兼容。
- `candidateEvaluation.js` 进一步收敛为 candidate scoring / arbitration 入口：
  - 保留 new-margin 风险 gate
  - 保留 default-alpha / alpha-variant 仲裁
  - 不再直接装配 detection / alpha / repair / decisionPath 顶层对象
- `pipelineLayerContracts.js` 的 evaluation anchors 增加：
  - module：`pipelineDecisionPath`
  - test：`pipelineDecisionPath.test`
- 新增 `tests/core/pipelineDecisionPath.test.js`，锁定：
  - accepted decisionPath 的 version / decision / source / evaluationDecision / riskFlags
  - detectionCandidate / alphaTrial / repairTrial 串联后的 pathId
  - rejected decisionPath 的 blockedGate / evidenceClass / null alpha & repair trial
  - decision path contract summary 字段
- 行为约束：这一刀只移动 `decisionPath` 顶层装配，不改变 scoring、arbitration、alpha/repair 执行、meta、gate 或输出像素。

验证证据：

- `node --check src/core/pipelineDecisionPath.js`
  - 结果：通过
- `node --check src/core/candidateEvaluation.js`
  - 结果：通过
- `node --check src/core/pipelineLayerContracts.js`
  - 结果：通过
- `pnpm exec node --test tests/core/pipelineDecisionPath.test.js tests/core/candidateEvaluation.test.js tests/core/pipelineLayerContracts.test.js tests/core/pipelineMeta.test.js tests/core/pipelineResult.test.js`
  - 结果：`pass=23`，`fail=0`
- `pnpm exec node --test tests/core/pipelineDecisionPath.test.js tests/core/pipelineRepairTrial.test.js tests/core/pipelineAlphaTraceContract.test.js tests/core/pipelineTrace.test.js tests/core/pipelineAlphaTrial.test.js tests/core/pipelineDetectionCandidate.test.js tests/core/candidateEvaluation.test.js tests/core/pipelineLayerContracts.test.js tests/core/imageWatermarkPipelineRequest.test.js tests/core/imageWatermarkPipeline.test.js tests/core/pipelineInitialContext.test.js tests/core/pipelineInitialSelection.test.js tests/core/pipelineAcceptedFinalizationRequest.test.js tests/core/pipelineAcceptedExecutorRequest.test.js tests/core/pipelineAcceptedExecutor.test.js tests/core/pipelineAlphaStageSpecs.test.js tests/core/pipelineFinalization.test.js tests/core/pipelinePassState.test.js tests/core/pipelineRuntime.test.js tests/core/pipelineRuntimeBootstrap.test.js tests/core/pipelineRepairStageSpecs.test.js tests/core/pipelineResult.test.js tests/core/pipelineTimings.test.js tests/core/pipelineRepairGates.test.js tests/core/pipelineState.test.js tests/core/pipelineMetrics.test.js tests/core/pipelineMeta.test.js`
  - 结果：`pass=123`，`fail=0`
- `pnpm build`
  - 结果：通过
- full benchmark：
  - report：`.artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase5-decision-path.json`
  - markdown：`.artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase5-decision-path.md`
  - 结果：`978/1000 = 97.80%`
  - `newlyPassing=0`
  - `newlyFailing=0`
  - `decisionPath` 覆盖：`1000/1000`
  - accepted decision：`984`
  - rejected decision：`16`
  - `repairApplied=175`
- gate：
  - `pnpm benchmark:online-sample:gate -- --report .artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase5-decision-path.json --min-newly-passing 0`
  - 结果：通过

下一步：

1. Phase 5 主体 contract 迁移已基本收口；下一步先做一次结构审阅，确认 `candidateEvaluation.js` 是否已经只剩 scoring/arbitration。
2. 如果继续代码切口，优先把 evaluation scoring 的输入/输出整理成更小的 `pipelineCandidateEvaluation` contract，而不是再动运行路径。
3. 后续再进入“真实能力提升”前，先对照 issue 92 和线上 22 个剩余失败样本，确认哪类问题该由 detection / alpha / repair / evaluation 哪一层处理。

Phase 5 收尾审阅：

- 结论：Phase 5 的主体 contract 迁移已经可以收口，不建议继续为了“更细文件”机械拆分。
- 当前 `candidateEvaluation.js` 已经基本只剩：
  - new-margin / alpha-variant 风险 gate
  - default-alpha vs alpha-variant 的候选仲裁
  - candidate evaluation score shape
  - 兼容 re-export
- 四层 contract 的主要对象边界已经落到代码和测试：
  - detection：`pipelineDetectionCandidate.js`
  - alpha：`pipelineAlphaTrial.js`、`pipelineAlphaTraceContract.js`、`pipelineAlphaStageSpecs.js`
  - repair：`pipelineRepairTrial.js`、`pipelineRepairStageSpecs.js`、`pipelineRepairGates.js`
  - evaluation：`pipelineDecisionPath.js`、`candidateEvaluation.js`
- 运行壳已经有独立边界：
  - `imageWatermarkPipeline.js`
  - `imageWatermarkPipelineRequest.js`
  - `pipelineAcceptedExecutor.js`
  - `pipelineAcceptedExecutorRequest.js`
  - `pipelineAcceptedFinalizationRequest.js`
  - `pipelineRuntime*.js`
  - `pipelineResult.js`
  - `pipelineMeta.js`
- 质量门禁保持稳定：
  - 最新 Phase 5 report：`.artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase5-decision-path.json`
  - `978/1000 = 97.80%`
  - `newlyPassing=0`
  - `newlyFailing=0`
  - `decisionPath=1000/1000`
  - accepted decision：`984`
  - rejected decision：`16`
  - `repairApplied=175`
- 这轮重构的实际收益：
  - 已把“检测、alpha 逼近、修复、评估”的边界从文档意图变成可测试 contract。
  - 后续新增 alpha 候选、纹理修复、评估择优时，不必再塞进一个长函数里。
  - 对 issue 92 这类“水印去掉后仍有明显痕迹”的问题，已经有地方分别承接：alpha profile 问题进 alpha 层，边缘/纹理残留进 repair 层，路径选择错误进 evaluation 层。
- 暂停继续行为等价重构的原因：
  - 当前继续拆 `candidateEvaluation.js` 的收益低于回到真实失败样本。
  - 剩余问题不太可能靠继续搬文件解决，需要重新按样本归因。
  - 每次触碰 decisionPath / meta 都要跑全量 benchmark，低收益重构会拖慢进入算法改进。

收尾后的下一阶段入口：

1. 回到 issue 92 和线上 22 个剩余失败样本，先做四层归因表：`detection / alpha / repair / evaluation`。
2. 每个失败样本记录：水印位置是否准、alpha 是否过强/过弱、是否存在边缘/纹理残留、当前评估是否选错路径。
3. 优先挑一个高证据簇做真实能力提升：
   - alpha 错：做 alpha profile / edge alpha 逼近。
   - repair 错：做局部纹理重建/边缘修复增强。
   - evaluation 错：增加路径评估择优，而不是放宽检测阈值。
4. 继续沿用当前门禁：核心测试、`pnpm build`、1000 样本 benchmark、gate、`newlyFailing=0`。

下一阶段第一版归因：

- 新增归因报告：`.artifacts/online-sample-2026-06-23-to-2026-06-24-max500/phase5-four-layer-attribution.md`
- JSON：`.artifacts/online-sample-2026-06-23-to-2026-06-24-max500/phase5-four-layer-attribution.json`
- issue 92 当前诊断：`.artifacts/online-sample-2026-06-23-to-2026-06-24-max500/issue92-current-diagnosis.json`
- 22 个失败样本按主责层归因：
  - detection：`16`
  - repair：`4`
  - alpha：`2`
- 关键结论：
  - 唯一值得优先做生产能力提升的重复簇是 `48/96/96` accepted residual / weak-suppression，共 `3` 个样本：
    - `2026-06-23/2069426775582052352-source.png`
    - `2026-06-23/2069438837913817088-source.png`
    - `2026-06-24/2069602182474240000-source.png`
  - 这组应归到 `repair -> alpha`，不是 detection；优先做 edge alpha/profile 与局部 repair 的小实验。
  - 16 个 skipped 样本仍不建议放宽检测；skipped audit 结论仍是没有 production-evidence-safe candidate。
  - issue 92 当前不是 `48/96/96` 残留簇，而是 false-positive anchor-selection guard：
    - 当前选择 `96/64/64`
    - 没有选弱证据 `96/192/192` default-alpha
    - processed spatial `0.048556`
    - processed gradient `0.016797`
    - 适合留作 evaluation/detection 回归，不应混入 P1 residual fixture set。

这次重构值得做，但不做一次性推倒重写。目标是把当前“样本特例链”升级成“候选路径评估系统”，先保持行为等价，再逐步迁移策略。

当前线上样本基线：

- 样本集：`sample-files/gemini-watermark/online-sample-2026-06-23-to-2026-06-24-max500`，本地可用 `GWR_ONLINE_SAMPLE_ROOT` 指向实际下载目录。
- 报告：`.artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-after-rebalance.json`
- 结果：`978/1000 = 97.80%`
- 相对基线：`newlyPassing=29`，`newlyFailing=0`
- gate：`rtk pnpm benchmark:online-sample:gate -- --min-newly-passing 29`

关键判断：

- 剩余 `missed-detection` 不应直接用于放宽检测阈值。
- skipped 专用审计显示 `productionEvidenceSafeTotal=0`，即没有样本同时满足“原图生产级水印证据强”和“去除后安全”。
- 剩余单例 residual/weak-suppression 更适合继续收簇和人工真值确认，而不是继续堆单例特例。

相关证据：

- skipped 审计：`.artifacts/online-sample-2026-06-23-to-2026-06-24-max500/skipped-candidate-audit/skipped-candidate-audit.md`
- unresolved/allenk 对比：`.artifacts/online-sample-2026-06-23-to-2026-06-24-max500/allenk-unresolved-comparison-after-rebalance/latest-report.md`
- 后续跟踪清单：`.artifacts/online-sample-2026-06-23-to-2026-06-24-max500/follow-up/worth-tracking-after-rebalance.md`

## 目标架构

目标流水线：

```text
DetectionCandidate[]
  -> AlphaTrial[]
    -> RepairTrial[]
      -> CandidateEvaluation[]
        -> SelectedPlan | RejectedDecision
          -> executor
```

分层职责：

| 层 | 只回答的问题 | 不应该做的事 |
|---|---|---|
| 水印检测层 | 哪里可能有水印、规格是什么、原图证据强不强 | 不改图，不决定 alphaGain，不根据去除后结果反推水印存在 |
| Alpha 逼近层 | 哪个 alpha map / alphaGain / alpha shape 最能解释检测候选 | 不做纹理修复，不越过检测证据门槛 |
| 纹理重建/修复层 | 在可信 alpha 反解基础上，局部残留、边缘、halo、纹理断裂能否安全修复 | 不替代检测，不掩盖错误 alpha，不扩大到非 ROI |
| 评估仲裁层 | 哪条完整路径最优，或是否拒绝处理 | 不直接生成候选，不执行最终改图 |
| 执行壳 | 应用最终 plan，返回 imageData 和 meta | 不临时插入策略分支 |

## 核心对象草案

### DetectionCandidate

```js
{
  id,
  source,
  config: { logoSize, marginRight, marginBottom, alphaVariant },
  position: { x, y, width, height },
  alphaMapHint,
  polarityHint,
  evidence: {
    spatialScore,
    gradientScore,
    textureStats,
    confidence,
    productionEvidence
  },
  provenance: {
    catalogVariant,
    fixedVariant,
    localShift,
    previewAnchor,
    adaptive,
    darkPolarity
  }
}
```

### AlphaTrial

```js
{
  id,
  detectionId,
  source,
  alphaMap,
  alphaMapSource,
  alphaGain,
  alphaShape: {
    variant,
    exponent,
    subpixelShift,
    scale
  },
  imageData,
  scores: {
    originalSpatial,
    originalGradient,
    processedSpatial,
    processedGradient,
    suppressionGain
  },
  damage,
  gates,
  provenance
}
```

### RepairTrial

```js
{
  id,
  alphaTrialId,
  source,
  repairType,
  params,
  imageData,
  scores,
  artifacts,
  gates,
  provenance
}
```

### CandidateEvaluation

```js
{
  pathId,
  detectionId,
  alphaTrialId,
  repairTrialId,
  eligible,
  decision,
  blockedGate,
  riskFlags,
  evidenceClass,
  residualClass,
  damageClass,
  rankingKey,
  explanation
}
```

### SelectedPlan

```js
{
  decision: 'accept',
  selectedPathId,
  detection,
  alphaTrial,
  repairTrial,
  outputImageData,
  meta
}
```

### RejectedDecision

```js
{
  decision: 'reject',
  reason,
  evidenceClass,
  bestRejectedPathId,
  riskFlags,
  meta
}
```

## 现有逻辑归类

### 水印检测层

- catalog size / anchor lookup
- canonical 48 / 96 anchor
- 96 new-margin anchor
- local shift / size jitter
- preview anchor search
- adaptive region search
- dark polarity seed

目标模块候选：

- `src/core/watermarkDetection.js`
- `src/core/watermarkDetectionTypes.js`

### Alpha 逼近层

- alphaGain sweep
- weak / strong alpha group
- default alpha vs `96-20260520`
- power/exponent profile
- subpixel / scale refinement
- dark/white polarity alpha map
- positive residual rebalance
- over-subtraction fine tune

目标模块候选：

- `src/core/alphaTrialGenerator.js`
- `src/core/alphaTrialScoring.js`

### 纹理重建/修复层

- luma edge cleanup
- flat fill
- preview edge cleanup
- smooth prior located repair
- small margin prior repair
- small located prior repair
- dark halo rescue
- boundary repair
- quantized body correction

目标模块候选：

- `src/core/repairTrialGenerator.js`
- `src/core/textureRepairStrategies.js`

### 评估仲裁层

现有起点：

- `src/core/candidateEvaluation.js`
- `src/core/watermarkScoring.js`
- `src/core/restorationMetrics.js`

目标模块候选：

- `src/core/candidateEvaluation.js`
- `src/core/candidatePathArbitration.js`
- `src/core/candidateDecisionReport.js`

## 迁移原则

1. 先加结构，不改行为。
2. 每一步迁移都必须保留旧路径对照，直到 full benchmark 和 gate 通过。
3. 单个 strategy 迁移独立完成，不跨多类样本混改。
4. skipped 的安全候选必须同时满足生产级原图证据和去除安全，不能只看去除后指标。
5. 纹理修复只能在可信 detection + alpha trial 后执行，不能用来制造水印存在证据。
6. 每个拒绝都要可解释：`detection-rejected`、`alpha-no-safe-fit`、`repair-unsafe`、`evaluation-rejected`。
7. 每轮重构后更新此文档的状态和下一步。

## 阶段计划

### Phase 0：文档与基线冻结

目标：

- 建立本活文档。
- 固化当前 97.80% 基线和 gate。
- 明确剩余失败样本的跟踪口径。

完成条件：

- 文档存在并记录当前证据。
- `rtk pnpm benchmark:online-sample:gate -- --min-newly-passing 29` 可通过。
- 不新增生产算法行为。

### Phase 1：评估层中枢与类型外壳

目标：

- 定义 `DetectionCandidate`、`AlphaTrial`、`RepairTrial`、`CandidateEvaluation` 的轻量结构。
- 将现有 `selectedTrial` 包装为新路径对象。
- benchmark report 增加 selected/rejected path 的解释字段。

完成条件：

- 生产输出图像与当前路径保持等价。
- 核心测试通过。
- full 1000 benchmark 仍满足：
  - pass rate >= 97.80% 或不低于当前基线
  - `newlyFailing=0`
  - gate 通过

建议验证：

```powershell
rtk pnpm exec node --test tests/core/candidateEvaluation.test.js tests/core/candidateSelector.test.js tests/core/watermarkProcessor.test.js
rtk pnpm build
rtk pnpm benchmark:online-sample:gate -- --min-newly-passing 29
```

### Phase 2：Alpha trial 迁移

优先迁移：

- `new-margin-96-variant`
- `known-48-positive-residual-rebalance`
- `located-aggressive-alpha`
- `over-subtraction fine alpha`
- `dark-catalog-fine-alpha`

完成条件：

- 每个 alpha strategy 都能作为 `AlphaTrial` 被评估层记录和仲裁。
- 不改变纹理修复策略位置。
- full benchmark 不回退。

### Phase 3：Repair trial 迁移

优先迁移：

- `luma-edge`
- `flat-fill`
- `small-margin-prior`
- `small-located-prior`
- `dark-halo-rescue`

完成条件：

- 纹理修复不再直接藏在 alpha 调整链里。
- 每个 repair trial 都有独立 artifacts / gates / reason。
- 评估层能选择“不修复，仅 alpha”或“alpha + repair”。

### Phase 4：执行壳瘦身

目标：

- `processWatermarkImageData` 只负责：
  - 调用 pipeline
  - 应用 selected plan
  - 输出 imageData/meta
- 清理重复 scoring 和散落的 stage 字符串。

完成条件：

- `watermarkProcessor.js` 的策略分支显著减少。
- benchmark、核心测试、build 通过。
- meta 仍兼容现有 userscript / SDK / CLI。

## 验收门槛

每个阶段必须满足：

- 核心测试通过。
- build 通过。
- 线上样本 gate 通过。
- `newlyFailing=0`。
- 关键 report 能解释：
  - selected path
  - rejected path
  - rejection reason
  - detection evidence
  - alpha fit scores
  - repair artifact scores

Phase 1 之后新增的最低 report 字段：

```js
{
  decisionPath: {
    detectionSource,
    alphaSource,
    repairSource,
    evaluationDecision,
    blockedGate,
    riskFlags
  }
}
```

## Stop 条件

遇到以下情况要停下来复核，而不是继续堆策略：

- full benchmark 出现 `newlyFailing > 0`。
- skipped 样本只凭去除后指标变为通过，但原图生产级证据不足。
- 单例样本需要新增独有阈值才能通过。
- repair trial 在非 ROI 或低证据区域产生明显内容损伤。
- userscript / SDK / CLI meta 兼容性被破坏。

## 当前值得跟的样本簇

### 48/96/96 大边距残留

- `2026-06-23/2069426775582052352-source.png`
- `2026-06-23/2069438837913817088-source.png`
- `2026-06-24/2069602182474240000-source.png`

跟踪方向：

- alpha edge profile
- luma edge cleanup
- 修复层安全门槛

### 48/32/32 小边距近阈值残留

- `2026-06-23/2069446929581871104-source.png`

跟踪方向：

- 高纹理/高对比背景下的轻量 edge cleanup。
- 该样本只略高于 residual 阈值，优先等同簇样本，不建议单例特化。

### 需要人工真值确认

- `2026-06-23/2069406094224003072-source.png`
- `2026-06-23/2069459218146004992-source.png`
- `2026-06-24/2069705744290156544-source.webp`

这些样本有部分模板证据，但去除不安全，适合作为人工真值池，不适合作为自动阈值依据。

## 下一步

推荐进入 Phase 2：Alpha trial 迁移。

1. 做 Phase 2 收口审阅：确认 `alpha-variant` 是否需要拆成明确 strategy，还是留作 fallback adapter。
2. 开始 Phase 3：Repair trial 迁移，优先 `luma-edge` / `edge-cleanup`，因为它们覆盖多且风险边界清晰。
3. Repair trial 第一刀仍保持行为等价，只把 stage、artifact、gate 写入 `decisionPath.repairTrial`。

## 2026-06-27 Phase 5 后 P1 小实验收尾

Phase 5 的行为等价重构已经收口，当前不要继续为重构而重构。线上抽样最新稳定基线仍是：

- report：`.artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase5-decision-path.json`
- `978/1000 = 97.80%`
- `newlyPassing=0`
- `newlyFailing=0`
- `decisionPath=1000`

四层归因报告：

- Markdown：`.artifacts/online-sample-2026-06-23-to-2026-06-24-max500/phase5-four-layer-attribution.md`
- JSON：`.artifacts/online-sample-2026-06-23-to-2026-06-24-max500/phase5-four-layer-attribution.json`

P1 簇定义为当前唯一值得继续跟的重复生产改进簇：

- `2026-06-23/2069426775582052352-source.png`
- `2026-06-23/2069438837913817088-source.png`
- `2026-06-24/2069602182474240000-source.png`

本轮为 P1 生成了专用 probe 输入：

- `.artifacts/online-sample-2026-06-23-to-2026-06-24-max500/p1-48-96-96-probe-input.json`

Alpha profile sweep：

- report：`.artifacts/online-sample-2026-06-23-to-2026-06-24-max500/p1-alpha-profile-probe/latest.json`
- sheet：`.artifacts/online-sample-2026-06-23-to-2026-06-24-max500/p1-alpha-profile-probe/profile-sweep-sheet.png`
- 结果：
  - total `3`
  - production visible `3`
  - best safe profile improvements `0`
  - reference better than production `0`

结论：P1 不是“找一个更合适 alpha 值”就能解决。纯 alpha profile sweep 没有安全、稳定、可推广候选；部分非可见候选伴随明显 damage 或 balanced cost 回退。

Boundary / texture repair sweep：

- report：`.artifacts/online-sample-2026-06-23-to-2026-06-24-max500/p1-boundary-repair-probe/latest.json`
- sheet：`.artifacts/online-sample-2026-06-23-to-2026-06-24-max500/p1-boundary-repair-probe/boundary-repair-sheet.png`
- 结果：
  - total `3`
  - best safe boundary repairs `1`
  - boundary repair allowed by existing gate `0`
  - best safe preset：`edge-luma-r5-signed-mid`

逐样本结论：

- `2069426775582052352`：`edge-luma-r5-signed-mid` 从 `balancedCost 0.578219` 降到 `0.293285`，`gradient 0.312419` 降到 `0.216936`，`visible=false`，但样本被归类为 `structured-edge-protected`，当前 gate 不允许直接进生产。
- `2069438837913817088`：最佳修复只带来极小 balanced 改善，且属于 `positive-halo-background-collision` 指标风险，不是生产候选。
- `2069602182474240000`：最佳修复同样只是极小改善，仍是指标风险样本，不建议特化。

当前判断：

- 架构收益已经兑现：四层路径能解释失败落点，并能把 `detection / alpha / repair / evaluation` 的责任拆开。
- P1 后续不应该继续调全局 alpha；应该围绕 `edge-luma-r5-signed-mid` 做受控视觉复核和更大样本安全门。
- 如果要进入生产实现，必须先补一个“结构边缘保护下的例外准入 gate”，条件至少包括：
  - 原图证据强。
  - 修复后 visible 关闭。
  - balanced cost 明显下降。
  - artifact cost 不上升。
  - newly clipped 不上升。
  - 在非 P1 / skipped / issue92 样本上没有误伤。

下一步推荐：

1. 把 `2069426775582052352` 做成人工视觉复核样本，确认 `edge-luma-r5-signed-mid` 的 sheet 结果是否真实优于生产输出。
2. 若视觉确认通过，再从全量 1000 里找同类 `structured-edge-protected + high-gradient residual` 样本做离线 gate sweep。
3. 只有当离线 gate sweep 没有新增损伤，才把纹理修复层的例外 gate 写入生产。
4. issue 92 继续作为评估/检测保护回归样本，不并入 P1 修复簇。

## 2026-06-27 完美修复率 / 瑕疵率监控

新增诊断入口：

- script：`scripts/create-online-sample-quality-monitor.js`
- package script：`pnpm report:online-sample:quality-monitor`

监控分三档：

- `perfect strict`：通过 benchmark，且 strict 阈值下没有 residual / halo / damage / texture / near-black / clipping / weak suppression flag。
- `clean pass`：通过 benchmark，且 clean 阈值下没有瑕疵 flag。
- `severe defect`：benchmark fail、可见残留、强 residual、强 halo、强 damage、强 texture、强 near-black 任一命中。

当前 Phase 5 基线：

- artifact：`.artifacts/online-sample-2026-06-23-to-2026-06-24-max500/quality-monitor/phase5-current/latest.json`
- Markdown：`.artifacts/online-sample-2026-06-23-to-2026-06-24-max500/quality-monitor/phase5-current/latest.md`
- `pass = 978/1000 = 97.80%`
- `perfect strict = 82/1000 = 8.20%`
- `clean pass = 247/1000 = 24.70%`
- `strict defect = 918/1000 = 91.80%`
- `clean defect = 753/1000 = 75.30%`
- `severe defect = 393/1000 = 39.30%`
- `visible residual = 292/1000 = 29.20%`
- `damage / texture metric coverage = 984/1000 = 98.40%`

与最早线上基线 `.artifacts/.../latest-report.json` 对比：

- artifact：`.artifacts/online-sample-2026-06-23-to-2026-06-24-max500/quality-monitor/phase5-vs-initial/latest.json`
- `pass +29`
- `visible residual -13`
- `perfect strict -59`
- `strict defect +59`
- `severe defect +72`
- caveat：`latest-report.json` 的 damage / texture 指标覆盖为 0，而 Phase 5 当前报告覆盖为 984/1000；所以 `perfect / strict defect / severe defect` 的跨 initial delta 只能当风险预警，不是同口径质量结论。后续 accepted quality baseline 必须使用同覆盖率报告。

解读：

- 当前算法确实提高了覆盖率，且减少了一部分可见残留。
- 但“完美修复”比例下降，主要原因不是 residual，而是 damage / texture 风险上升。
- 59 个 `perfectLost` 中，主要 flags 为：
  - `damage-penalty = 56`
  - `texture-penalty = 45`
  - `near-black-increase = 6`
- 59 个 `perfectLost` 的 anchor 主要集中在：
  - `48/96/96 = 44`
  - `96/64/64 = 8`
  - `48/32/32 = 3`

这说明后续生产改动必须同时守住两条线：

1. `passRate` 不能回退。
2. `perfect strict` 不能下降，`strict defect / severe defect` 不能上升。

推荐未来每次线上样本 benchmark 后跑：

```powershell
pnpm report:online-sample:quality-monitor -- --report <new-report.json> --baseline .artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase5-decision-path.json --out-dir <quality-monitor-output> --fail-on-strict-defect-increase --max-strict-defect-increase 0 --fail-on-perfect-loss --max-perfect-loss 0
```

注意：如果某次改动有意用少量 texture 风险换取大量残留消除，不能直接放行；必须附带视觉 sheet 和人工确认，并更新 accepted quality baseline。

### 质量复核包

新增视觉复核入口：

- script：`scripts/create-online-quality-review-pack.js`
- package script：`pnpm report:online-sample:quality-review`

当前复核包：

- dir：`.artifacts/online-sample-2026-06-23-to-2026-06-24-max500/quality-review-pack/phase5-vs-initial`
- JSON：`.artifacts/online-sample-2026-06-23-to-2026-06-24-max500/quality-review-pack/phase5-vs-initial/latest.json`
- README：`.artifacts/online-sample-2026-06-23-to-2026-06-24-max500/quality-review-pack/phase5-vs-initial/README.md`
- `perfectLost` sheet：`.artifacts/online-sample-2026-06-23-to-2026-06-24-max500/quality-review-pack/phase5-vs-initial/perfectLost.png`
- `severeDefectIntroduced` sheet：`.artifacts/online-sample-2026-06-23-to-2026-06-24-max500/quality-review-pack/phase5-vs-initial/severeDefectIntroduced.png`
- `passGained` sheet：`.artifacts/online-sample-2026-06-23-to-2026-06-24-max500/quality-review-pack/phase5-vs-initial/passGained.png`

队列：

- `perfectLost = 30/59`，按当前 severity 取前 30。
- `severeDefectIntroduced = 30/81`，按当前 severity 取前 30。
- `passGained = 29/29`，全量进入复核。

当前机器摘要：

- `perfectLost` top 30：
  - `damage-penalty = 30`
  - `texture-penalty = 29`
  - `near-black-increase = 2`
  - anchor 主要为 `48/96/96 = 23`
- `passGained` 全量只有 29，其中此前质量监控显示 `passGainedPerfect = 0`、`passGainedClean = 2`。

复核目标：

1. 先看 `perfectLost.png`：判断 damage / texture 指标是否是真实肉眼损伤，还是 strict 口径过严。
2. 再看 `severeDefectIntroduced.png`：确认 severe defect 是否真需要收紧 gate。
3. 最后看 `passGained.png`：判断新增通过样本是否足以补偿完美率下降。

生产决策规则暂定：

- 如果 `perfectLost` 多数是真实纹理损伤，下一步优先收紧 `48/96/96` 上的 aggressive / fine-alpha / repair gate。
- 如果 `perfectLost` 多数肉眼不可见，下一步调整 quality monitor 的 damage / texture 阈值，并保留当前算法。
- 如果 `passGained` 肉眼收益很强但带轻微瑕疵，必须新增 tradeoff gate，而不是直接修改全局阈值。

### 质量消融报告

新增离线消融入口：

- script：`scripts/create-online-quality-ablation-report.js`
- package script：`pnpm report:online-sample:quality-ablation`

当前消融包：

- dir：`.artifacts/online-sample-2026-06-23-to-2026-06-24-max500/quality-ablation/phase5-vs-initial`
- JSON：`.artifacts/online-sample-2026-06-23-to-2026-06-24-max500/quality-ablation/phase5-vs-initial/latest.json`
- Markdown：`.artifacts/online-sample-2026-06-23-to-2026-06-24-max500/quality-ablation/phase5-vs-initial/latest.md`
- bestClean 视觉复核 sheet：`.artifacts/online-sample-2026-06-23-to-2026-06-24-max500/quality-ablation-review/phase5-vs-initial/perfectLost-bestClean.png`
- bestClean 复核 JSON：`.artifacts/online-sample-2026-06-23-to-2026-06-24-max500/quality-ablation-review/phase5-vs-initial/latest.json`

消融方法：

- 固定当前生产选择的检测位置 / watermark 尺寸 / alpha map。
- 跳过生产后续修复和清理路径，只对直接 alpha 反混合做 gain 网格搜索。
- 用同一套 strict / clean 阈值评估“更保守的 alpha 是否能恢复 perfect 或 clean”。

当前结论：

- 总计检查 `148` 个重点样本：`perfectLost = 59`、`severeDefectIntroduced = 60`、`passGained = 29`。
- 全局只有 `bestPerfect = 1`、`bestClean = 12`。
- 主要诊断：
  - `no-direct-alpha-improvement = 64`
  - `selected-alpha-core-causes-quality-flag = 53`
  - `direct-alpha-improves-but-not-clean = 19`
  - `alpha-grid-has-clean-candidate = 9`
  - `alpha-stage-overfit-previous-gain-clean = 2`

按队列看：

- `perfectLost`：59 个里只有 1 个 direct alpha 可恢复 perfect，12 个可恢复 clean；其中 28 个是当前 selected alpha/core inverse 本身触发质量 flag，19 个没有任何 direct alpha 改善。
- `severeDefectIntroduced`：60 个里没有 direct alpha 可恢复 clean；多数是无 direct alpha 改善或核心 alpha 候选自身带风险。
- `passGained`：29 个里没有 direct alpha 可恢复 clean；这些更像“残留换覆盖”的 tradeoff 样本，不应该用全局降 alpha 解决。

架构判断：

- 这不是单纯的“纹理修复/后处理层把图搞坏”；后处理可能放大少数问题，但主因已经前移到 detection 后的 alpha/core inverse 候选选择。
- 对 `perfectLost`，确实存在少量“更保守 alpha 更干净”的可跟样本，适合做窄 gate，而不是全局降 alpha。
- 对 `severeDefectIntroduced` 和 `passGained`，直接 alpha 网格几乎不能恢复 clean，下一步应该靠人工视觉复核决定 tradeoff 是否接受，或者把 evaluation 层做成候选仲裁，而不是继续单点调 alpha。

下一步推荐：

1. 先人工看 `perfectLost.png`，并优先标注消融里 `bestClean` 的 12 个样本。
2. 如果这 12 个肉眼确实更好，再做一个窄范围 conservative-alpha admission gate，只覆盖对应 anchor / source / flag 组合。
3. 暂不全局关闭 `fine-alpha / located-aggressive / repair`，因为消融显示大部分问题不是这些层单独造成的。
4. 后续所有质量结论都用 Phase 5 当前报告作为 accepted quality baseline，避免再拿无 damage/texture 覆盖的 initial 报告直接作硬门禁。

### 质量复核决策：暂不增加 production gate

已完成本轮人工视觉复核：

- `perfectLost-bestClean.png`：重点检查消融里可恢复 clean 的 12 个样本。
- `severeDefectIntroduced.png`：检查 severe defect 是否真实存在。
- `passGained.png`：检查新增通过样本的覆盖收益是否足以换取瑕疵风险。

复核结论：

- 12 个 `perfectLost bestClean` 样本里，只有 1 个的 `currentAlphaGain` 与 `bestCleanAlphaGain` 不同；其余多数只是 direct-alpha 与 production 输出在当前指标口径下重合或近似重合。
- 肉眼对比看，`direct alpha` 相比 `current production` 没有稳定、明确的纹理改善；部分样本的 direct-alpha 反而有更明显边缘/亮度波动。
- `severeDefectIntroduced` 主要集中在高对比文字、图案边缘、深色纹理、手部/布料纹理等区域，属于真实 tradeoff 风险，不适合用更激进覆盖率直接吞掉。
- `passGained` 的收益是真实的：不少样本确实去掉了明显水印；但它们也集中在同类高风险纹理/文字区域，不能作为全局放宽 gate 的证据。

生产决策：

- 本轮不增加窄范围 `conservative-alpha` production gate。
- 本轮不增加新的 `tradeoff` production gate。
- 本轮不全局关闭 `fine-alpha / located-aggressive / repair`。

原因：

- 当前证据只证明“有少量样本在 clean 阈值下可接受”，没有证明“切换到 conservative-alpha 会稳定改善肉眼质量”。
- `perfect strict` 损失多数不是一个可由简单降 alpha 修好的簇。
- `passGained` 与 `severeDefectIntroduced` 的视觉风险需要 evaluation 层继续记录和仲裁，不能变成默认放行逻辑。

守门验证：

- 同基线零 delta 监控：`.artifacts/online-sample-2026-06-23-to-2026-06-24-max500/quality-monitor/phase5-self-zero-delta/latest.json`
- `pass = 978/1000 = 97.80%`
- `perfect delta = 0`
- `strict defect delta = 0`
- `severe defect delta = 0`
- `pass delta = 0`

下一步如果继续提升质量，应该转向：

1. 把 `severeDefectIntroduced` 按文字/高对比边缘/深色纹理/人体纹理分簇。
2. 在 evaluation 层做 candidate arbitration，而不是直接调 alpha。
3. 只有当某个分簇同时满足“可见残留下降、damage/texture 不上升、人工视觉稳定更好”，才新增窄 gate。

### perfectLost 新旧版本目测复核

为确认 `perfect strict -59` 是否真的是“当前版本相对 GitHub 旧版退步”，新增对照脚本：

- script：`scripts/create-online-perfect-lost-github-compare.js`
- package script：`pnpm report:online-sample:perfect-lost-github-compare`
- GitHub 旧版基线：`v1.0.27 / 642db00`
- 旧版代码解出目录：`.artifacts/baseline-642db00`

当前对照产物：

- sheet：`.artifacts/online-sample-2026-06-23-to-2026-06-24-max500/github-compare/perfect-lost-v1.0.27-vs-current/perfectLost-github-v1.0.27-vs-current.png`
- split chunks：`.artifacts/online-sample-2026-06-23-to-2026-06-24-max500/github-compare/perfect-lost-v1.0.27-vs-current/chunks/`
- JSON：`.artifacts/online-sample-2026-06-23-to-2026-06-24-max500/github-compare/perfect-lost-v1.0.27-vs-current/latest.json`

复核方法：

- 对 59 个 `perfectLost` 样本分别渲染：
  - source
  - GitHub v1.0.27 after
  - current after
  - old-to-current diff x8
- 另外计算 old/current crop 平均像素差。

目测结论：

- 59 个 `perfectLost` 中，大多数 GitHub v1.0.27 after 与 current after 肉眼几乎重合。
- 没有看到“GitHub 旧版明显完美、当前明显损伤”的系统性退步。
- 个别样本在高对比建筑/界面纹理区域有轻微真实差异，但 diff 很小，且不构成全局质量回退证据。

量化补充：

- `old-current avg crop delta < 0.01`：57/59。
- `old-current avg crop delta < 0.1`：58/59。
- `old-current avg crop delta < 0.5`：59/59。
- 最大平均差只有 `0.161/255`，来自 `2026-06-24/2069680560854274048-source.png`，肉眼看属于轻微局部差异。

最终判断：

- `perfect strict -59` 主要不是当前算法相对 GitHub v1.0.27 的真实视觉退步。
- 主要原因是 Phase 5 当前质量监控新增了 damage / texture / near-black 等严格指标，而旧 initial 质量报告没有这些指标覆盖。
- 因此这个下降应标记为“评估口径升级暴露风险”，不是“生产输出明显变差”。
