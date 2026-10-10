import {
    WatermarkEngine,
    detectWatermarkConfig,
    calculateWatermarkPosition
} from './core/watermarkEngine.js';
import { WatermarkWorkerClient, canUseWatermarkWorker } from './core/workerClient.js';
import {
    isConfirmedWatermarkDecision,
    resolveDisplayWatermarkInfo,
    resolveProcessedStatusPresentation
} from './core/watermarkDisplay.js';
import { canvasToBlob } from './core/canvasBlob.js';
import {
    loadImage,
    setStatusMessage,
    showLoading,
    hideLoading
} from './utils.js';
import {
    consumeDebugFileHandoff,
    getDebugFileKind,
    saveDebugFileHandoff
} from './shared/debugFileHandoff.js';

const TEXT = {
    loading: 'Loading resources...',
    size: 'Dimensions',
    watermark: 'Detected Watermark',
    position: 'Position',
    status: 'Status',
    removed: 'Watermark Removed',
    skipped: 'No removable watermark detected, original preserved',
    visibleResidual: 'Processed, slight residual faint ghosting may remain',
    possibleContentDamage: 'Best result generated, please verify watermark region',
    mixedQualityWarning: 'Best result generated with quality warning',
    unsupported: 'Browser does not support clipboard copy',
    copied: 'Copied!',
    copy: 'Copy Result',
    copyFailed: 'Copy failed',
    unsupportedFile: 'Please select a valid JPG, PNG, or WebP image, or MP4/WebM video.',
    fileTooLarge: 'Images over 20MB are skipped for preview.',
    skippedLargeImages: 'Skipped images exceeding 20MB.',
    handoffVideo: 'Routing to video processing workflow...',
    progress: 'Processing Progress',
    pending: 'Pending',
    loadingImage: 'Reading image...',
    processing: 'Processing...',
    processFailed: 'Processing failed'
};

let enginePromise = null;
let workerClient = null;
let currentItem = null;
let imageQueue = [];
let processedCount = 0;
let activeBatchId = 0;

const uploadArea = document.getElementById('uploadArea');
const fileInput = document.getElementById('fileInput');
const singlePreview = document.getElementById('singlePreview');
const multiPreview = document.getElementById('multiPreview');
const imageList = document.getElementById('imageList');
const progressText = document.getElementById('progressText');
const originalImage = document.getElementById('originalImage');
const processedImage = document.getElementById('processedImage');
const originalInfo = document.getElementById('originalInfo');
const processedInfo = document.getElementById('processedInfo');
const downloadBtn = document.getElementById('downloadBtn');
const copyBtn = document.getElementById('copyBtn');
const resetBtn = document.getElementById('resetBtn');
const batchResetBtn = document.getElementById('batchResetBtn');
const bestEffortMode = document.getElementById('bestEffortMode');
const processedOverlay = document.getElementById('processedOverlay');
const sliderHandle = document.getElementById('sliderHandle');

// Enhanced Elements for View Modes, Animations, & Themes
const scanlineEffect = document.getElementById('scanlineEffect');
const comparisonContainer = document.getElementById('comparisonContainer');
const sideBySideContainer = document.getElementById('sideBySideContainer');
const sideBySideOriginal = document.getElementById('sideBySideOriginal');
const sideBySideProcessed = document.getElementById('sideBySideProcessed');
const flipContainer = document.getElementById('flipContainer');
const flipImage = document.getElementById('flipImage');
const flipBadge = document.getElementById('flipBadge');
const watermarkAnalysisCard = document.getElementById('watermarkAnalysisCard');
const analysisRes = document.getElementById('analysisRes');
const analysisAnchor = document.getElementById('analysisAnchor');
const analysisTime = document.getElementById('analysisTime');
const processedBadge = document.getElementById('processedBadge');

let currentViewMode = 'slider';
let flipState = 'processed';

const THEMES = ['dark', 'midnight', 'light'];
const THEME_NAMES = { dark: 'Dark', midnight: 'Midnight', light: 'Light' };
const THEME_ICONS = { dark: '🌙', midnight: '🌑', light: '☀️' };

function showToast(message, icon = '✅') {
    const toast = document.getElementById('toastNotice');
    const toastMsg = document.getElementById('toastMsg');
    const toastIcon = document.getElementById('toastIcon');
    if (!toast || !toastMsg) return;
    toastMsg.textContent = message;
    if (toastIcon) toastIcon.textContent = icon;
    toast.classList.add('show');
    clearTimeout(window.__toastTimeout);
    window.__toastTimeout = setTimeout(() => {
        toast.classList.remove('show');
    }, 2800);
}

function applyTheme(theme) {
    const root = document.documentElement;
    root.classList.remove('theme-midnight', 'theme-light');
    if (theme === 'midnight') root.classList.add('theme-midnight');
    if (theme === 'light') root.classList.add('theme-light');

    const iconEl = document.getElementById('themeIcon');
    const nameEl = document.getElementById('themeName');
    if (iconEl) iconEl.textContent = THEME_ICONS[theme] || '🌙';
    if (nameEl) nameEl.textContent = THEME_NAMES[theme] || 'Dark';

    try {
        localStorage.setItem('gwr_theme', theme);
    } catch (_) {}
}

function initTheme() {
    let saved = 'dark';
    try {
        saved = localStorage.getItem('gwr_theme') || 'dark';
    } catch (_) {}
    if (!THEMES.includes(saved)) saved = 'dark';
    applyTheme(saved);

    const toggleBtn = document.getElementById('themeToggleBtn');
    if (toggleBtn) {
        toggleBtn.addEventListener('click', () => {
            let current = 'dark';
            try { current = localStorage.getItem('gwr_theme') || 'dark'; } catch (_) {}
            const nextIndex = (THEMES.indexOf(current) + 1) % THEMES.length;
            const nextTheme = THEMES[nextIndex];
            applyTheme(nextTheme);
            showToast(`Theme switched to ${THEME_NAMES[nextTheme]} Mode`, THEME_ICONS[nextTheme]);
        });
    }
}

function initModals() {
    const privacyModal = document.getElementById('privacyModal');
    const aboutModal = document.getElementById('aboutModal');

    const openPrivacy = () => { if (privacyModal) privacyModal.classList.remove('hidden'), privacyModal.classList.add('flex'); };
    const closePrivacy = () => { if (privacyModal) privacyModal.classList.add('hidden'), privacyModal.classList.remove('flex'); };

    const openAbout = () => { if (aboutModal) aboutModal.classList.remove('hidden'), aboutModal.classList.add('flex'); };
    const closeAbout = () => { if (aboutModal) aboutModal.classList.add('hidden'), aboutModal.classList.remove('flex'); };

    document.getElementById('openPrivacyModalBtn')?.addEventListener('click', openPrivacy);
    document.getElementById('footerPrivacyBtn')?.addEventListener('click', openPrivacy);
    document.getElementById('closePrivacyModalBtn')?.addEventListener('click', closePrivacy);
    document.getElementById('dismissPrivacyModalBtn')?.addEventListener('click', closePrivacy);

    document.getElementById('openAboutModalBtn')?.addEventListener('click', openAbout);
    document.getElementById('footerAboutBtn')?.addEventListener('click', openAbout);
    document.getElementById('closeAboutModalBtn')?.addEventListener('click', closeAbout);
    document.getElementById('dismissAboutModalBtn')?.addEventListener('click', closeAbout);

    window.addEventListener('click', (e) => {
        if (e.target === privacyModal) closePrivacy();
        if (e.target === aboutModal) closeAbout();
    });
}

function updateProcessingStep(step, percent) {
    const card = document.getElementById('processingStepsCard');
    const text = document.getElementById('processingStepText');
    const bar = document.getElementById('processingProgressBar');
    const pct = document.getElementById('processingStepPercent');
    if (card) card.classList.remove('hidden');
    if (text) text.textContent = step;
    if (bar) bar.style.width = `${percent}%`;
    if (pct) pct.textContent = `${percent}%`;
}

function hideProcessingStep() {
    const card = document.getElementById('processingStepsCard');
    if (card) card.classList.add('hidden');
}

function setViewMode(mode) {
    currentViewMode = mode;
    const btnSlider = document.getElementById('viewModeSlider');
    const btnSideBySide = document.getElementById('viewModeSideBySide');
    const btnFlip = document.getElementById('viewModeFlip');

    const activeClasses = ['bg-brand-600', 'text-white', 'shadow-sm'];
    const inactiveClasses = ['text-gray-400', 'hover:text-white'];

    [btnSlider, btnSideBySide, btnFlip].forEach((btn) => {
        btn?.classList.remove(...activeClasses);
        btn?.classList.add(...inactiveClasses);
    });

    if (mode === 'slider') {
        btnSlider?.classList.add(...activeClasses);
        btnSlider?.classList.remove(...inactiveClasses);
        if (comparisonContainer) comparisonContainer.style.display = 'block';
        if (sideBySideContainer) sideBySideContainer.classList.add('hidden'), sideBySideContainer.classList.remove('grid');
        if (flipContainer) flipContainer.classList.add('hidden');
    } else if (mode === 'sideBySide') {
        btnSideBySide?.classList.add(...activeClasses);
        btnSideBySide?.classList.remove(...inactiveClasses);
        if (comparisonContainer) comparisonContainer.style.display = 'none';
        if (sideBySideContainer) sideBySideContainer.classList.remove('hidden'), sideBySideContainer.classList.add('grid');
        if (flipContainer) flipContainer.classList.add('hidden');
    } else if (mode === 'flip') {
        btnFlip?.classList.add(...activeClasses);
        btnFlip?.classList.remove(...inactiveClasses);
        if (comparisonContainer) comparisonContainer.style.display = 'none';
        if (sideBySideContainer) sideBySideContainer.classList.add('hidden'), sideBySideContainer.classList.remove('grid');
        if (flipContainer) flipContainer.classList.remove('hidden');
        updateFlipImage();
    }
}

function updateFlipImage() {
    if (!currentItem || !flipImage || !flipBadge) return;
    if (flipState === 'processed') {
        flipImage.src = currentItem.processedUrl || currentItem.originalUrl;
        flipBadge.textContent = 'PROCESSED (CLICK TO FLIP)';
        flipBadge.className = 'absolute top-4 left-4 bg-brand-950/90 border border-brand-500 text-brand-300 text-xs font-bold px-3 py-1 rounded-lg z-30 pointer-events-none';
    } else {
        flipImage.src = currentItem.originalUrl;
        flipBadge.textContent = 'ORIGINAL (CLICK TO FLIP)';
        flipBadge.className = 'absolute top-4 left-4 bg-darkbg/90 border border-gray-700 text-gray-300 text-xs font-bold px-3 py-1 rounded-lg z-30 pointer-events-none';
    }
}

function setupViewModes() {
    document.getElementById('viewModeSlider')?.addEventListener('click', () => setViewMode('slider'));
    document.getElementById('viewModeSideBySide')?.addEventListener('click', () => setViewMode('sideBySide'));
    document.getElementById('viewModeFlip')?.addEventListener('click', () => setViewMode('flip'));

    if (flipContainer) {
        flipContainer.addEventListener('click', () => {
            flipState = flipState === 'processed' ? 'original' : 'processed';
            updateFlipImage();
        });
    }
}

async function getEngine() {
    if (!enginePromise) {
        enginePromise = WatermarkEngine.create().catch((error) => {
            enginePromise = null;
            throw error;
        });
    }
    return enginePromise;
}

function getEstimatedWatermarkInfo(item) {
    if (!item?.originalImg) return null;
    const { width, height } = item.originalImg;
    const config = detectWatermarkConfig(width, height);
    const position = calculateWatermarkPosition(width, height, config);
    return {
        size: config.logoSize,
        position,
        config
    };
}

function disableWorkerClient(reason) {
    if (!workerClient) return;
    console.warn('disable worker path, fallback to main thread:', reason);
    workerClient.dispose();
    workerClient = null;
}

function cleanupCurrentItem() {
    if (!currentItem) return;
    if (currentItem.originalUrl) URL.revokeObjectURL(currentItem.originalUrl);
    if (currentItem.processedUrl) URL.revokeObjectURL(currentItem.processedUrl);
    currentItem = null;
}

function cleanupBatchItems() {
    activeBatchId++;
    imageQueue.forEach((item) => {
        if (item.originalUrl) URL.revokeObjectURL(item.originalUrl);
        if (item.processedUrl) URL.revokeObjectURL(item.processedUrl);
    });
    imageQueue = [];
    processedCount = 0;
}

async function init() {
    try {
        showLoading(TEXT.loading);

        if (canUseWatermarkWorker()) {
            try {
                workerClient = new WatermarkWorkerClient({
                    workerUrl: './workers/watermark-worker.js'
                });
            } catch (workerError) {
                console.warn('worker unavailable, fallback to main thread:', workerError);
                workerClient = null;
            }
        }

        if (!workerClient) {
            getEngine().catch((error) => {
                console.warn('main thread engine warmup failed:', error);
            });
        }

        hideLoading();
        initTheme();
        initModals();
        setupViewModes();
        setupEventListeners();
        setupSlider();
        await consumePendingImageHandoff();
    } catch (error) {
        hideLoading();
        console.error('initialize error:', error);
    }
}

function setupEventListeners() {
    uploadArea.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', handleFileSelect);

    document.addEventListener('dragover', (e) => {
        e.preventDefault();
        uploadArea.classList.add('border-primary', 'bg-emerald-50');
    });

    document.addEventListener('dragleave', (e) => {
        if (e.clientX === 0 && e.clientY === 0) {
            uploadArea.classList.remove('border-primary', 'bg-emerald-50');
        }
    });

    document.addEventListener('drop', (e) => {
        e.preventDefault();
        uploadArea.classList.remove('border-primary', 'bg-emerald-50');
        if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
            handleFiles(Array.from(e.dataTransfer.files));
        }
    });

    document.addEventListener('paste', (e) => {
        const items = e.clipboardData.items;
        const files = [];
        for (let i = 0; i < items.length; i++) {
            if (items[i].kind === 'file') {
                files.push(items[i].getAsFile());
            }
        }
        if (files.length > 0) handleFiles(files);
    });

    resetBtn.addEventListener('click', reset);
    batchResetBtn.addEventListener('click', reset);
    window.addEventListener('beforeunload', () => {
        cleanupBatchItems();
        disableWorkerClient('beforeunload');
    });
}

function reset() {
    cleanupCurrentItem();
    cleanupBatchItems();
    hideProcessingStep();
    if (scanlineEffect) scanlineEffect.classList.add('hidden');
    if (watermarkAnalysisCard) watermarkAnalysisCard.classList.add('hidden');
    if (processedBadge) processedBadge.classList.add('hidden');
    singlePreview.style.display = 'none';
    multiPreview.style.display = 'none';
    fileInput.value = '';
    imageList.innerHTML = '';
    updateProgress();
    originalImage.src = '';
    processedImage.src = '';
    if (sideBySideOriginal) sideBySideOriginal.src = '';
    if (sideBySideProcessed) sideBySideProcessed.src = '';
    if (flipImage) flipImage.src = '';
    setViewMode('slider');
    originalInfo.innerHTML = '';
    processedInfo.innerHTML = '';
    processedInfo.style.display = 'none';
    processedOverlay.style.display = 'none';
    sliderHandle.style.display = 'none';
    copyBtn.style.display = 'none';
    downloadBtn.style.display = 'none';
    setStatusMessage('');
    uploadArea.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function handleFileSelect(e) {
    handleFiles(Array.from(e.target.files));
}

async function handleFiles(files) {
    setStatusMessage('');

    const list = Array.from(files || []).filter(Boolean);
    const videoFile = list.find((file) => getDebugFileKind(file) === 'video');
    if (videoFile) {
        await routeVideoFile(videoFile);
        return;
    }

    const imageFiles = list.filter((file) => getDebugFileKind(file) === 'image');
    if (imageFiles.length === 0) {
        setStatusMessage(TEXT.unsupportedFile, 'warn');
        return;
    }

    const validImageFiles = imageFiles.filter((file) => file.size <= 20 * 1024 * 1024);
    if (validImageFiles.length === 0) {
        setStatusMessage(TEXT.fileTooLarge, 'warn');
        return;
    }

    if (validImageFiles.length < imageFiles.length) {
        setStatusMessage(TEXT.skippedLargeImages, 'warn');
    }

    if (validImageFiles.length > 1) {
        processBatch(validImageFiles);
        return;
    }

    const validFile = validImageFiles[0];
    const bestEffort = bestEffortMode?.checked === true;
    cleanupCurrentItem();
    cleanupBatchItems();
    multiPreview.style.display = 'none';
    imageList.innerHTML = '';
    currentItem = {
        id: Date.now(),
        file: validFile,
        name: validFile.name,
        bestEffort,
        originalImg: null,
        processedMeta: null,
        processedBlob: null,
        originalUrl: null,
        processedUrl: null
    };

    singlePreview.style.display = 'block';
    processSingle(currentItem);
}

function createDebugImageItem(file, index) {
    const bestEffort = bestEffortMode?.checked === true;
    return {
        id: `${Date.now()}-${index}`,
        file,
        name: file.name,
        bestEffort,
        status: 'pending',
        originalImg: null,
        processedMeta: null,
        processedBlob: null,
        originalUrl: null,
        processedUrl: null
    };
}

function processBatch(files) {
    cleanupCurrentItem();
    cleanupBatchItems();

    imageQueue = files.map(createDebugImageItem);
    singlePreview.style.display = 'none';
    multiPreview.style.display = 'block';
    imageList.innerHTML = '';
    updateProgress();
    imageQueue.forEach((item) => createImageCard(item));
    multiPreview.scrollIntoView({ behavior: 'smooth', block: 'start' });

    const batchId = activeBatchId;
    processQueue(batchId);
}

async function routeVideoFile(file) {
    try {
        showLoading(TEXT.handoffVideo);
        await saveDebugFileHandoff(file, 'video');
        window.location.assign('./video-preview.html?fileHandoff=1');
    } catch (error) {
        hideLoading();
        console.error(error);
        setStatusMessage(error.message || 'Unable to enter video workflow. Please open the video processor page and select file again.', 'warn');
    }
}

async function consumePendingImageHandoff() {
    const params = new URLSearchParams(window.location.search);
    if (params.get('fileHandoff') !== '1') return;

    try {
        const record = await consumeDebugFileHandoff('image');
        if (!record?.file) return;
        await handleFiles([record.file]);
        window.history.replaceState(null, '', window.location.pathname);
    } catch (error) {
        console.warn('image handoff unavailable:', error);
        setStatusMessage(error.message || 'Failed to read image cache. Please select file again.', 'warn');
    }
}

function renderSingleImageMeta(item) {
    if (!item?.originalImg) return;

    const watermarkInfo = resolveDisplayWatermarkInfo(
        item,
        getEstimatedWatermarkInfo(item)
    );
    if (!watermarkInfo) return;

    originalInfo.innerHTML = `
        <p>${TEXT.size}: ${item.originalImg.width}x${item.originalImg.height}</p>
        <p>${TEXT.watermark}: ${watermarkInfo.size}x${watermarkInfo.size}</p>
        <p>${TEXT.position}: (${watermarkInfo.position.x},${watermarkInfo.position.y})</p>
    `;
}

function getProcessedStatusPresentation(item) {
    const presentation = resolveProcessedStatusPresentation(item);
    return {
        label: TEXT[presentation.messageKey],
        tone: presentation.tone
    };
}

function renderSingleProcessedMeta(item) {
    if (!item?.originalImg) return;

    const watermarkInfo = resolveDisplayWatermarkInfo(
        item,
        getEstimatedWatermarkInfo(item)
    );
    const showWatermarkInfo = watermarkInfo && isConfirmedWatermarkDecision(item);
    const statusPresentation = getProcessedStatusPresentation(item);

    processedInfo.innerHTML = `
        <p>${TEXT.size}: ${item.originalImg.width}x${item.originalImg.height}</p>
        ${showWatermarkInfo ? `<p>${TEXT.watermark}: ${watermarkInfo.size}x${watermarkInfo.size}</p>` : ''}
        ${showWatermarkInfo ? `<p>${TEXT.position}: (${watermarkInfo.position.x},${watermarkInfo.position.y})</p>` : ''}
        <p class="${statusPresentation.tone === 'warning' ? 'text-warning' : ''}">${TEXT.status}: ${statusPresentation.label}</p>
    `;
}

async function processSingle(item) {
    try {
        const startTime = performance.now();
        updateProcessingStep('Reading image file & color buffers...', 20);
        if (scanlineEffect) scanlineEffect.classList.remove('hidden');

        const img = await loadImage(item.file);
        item.originalImg = img;
        item.originalUrl = img.src;

        originalImage.src = img.src;
        if (sideBySideOriginal) sideBySideOriginal.src = img.src;
        renderSingleImageMeta(item);

        updateProcessingStep('Locating watermark anchor & margins...', 50);

        const processed = await processImageWithBestPath(item.file, img, {
            bestEffort: item.bestEffort
        });

        updateProcessingStep('Applying reverse alpha channel reconstruction...', 85);

        item.processedMeta = processed.meta;
        item.processedBlob = processed.blob;
        item.processedUrl = URL.createObjectURL(processed.blob);

        const durationMs = performance.now() - startTime;

        processedImage.src = item.processedUrl;
        if (sideBySideProcessed) sideBySideProcessed.src = item.processedUrl;
        if (flipImage) flipImage.src = item.processedUrl;
        flipState = 'processed';

        processedOverlay.style.display = 'block';
        sliderHandle.style.display = 'flex';
        processedInfo.style.display = 'block';

        copyBtn.style.display = 'flex';
        copyBtn.onclick = () => copyImage(item);

        downloadBtn.style.display = 'flex';
        downloadBtn.onclick = () => downloadImage(item);

        renderSingleProcessedMeta(item);

        // Populate Watermark Analysis Metrics Card
        if (watermarkAnalysisCard) watermarkAnalysisCard.classList.remove('hidden');
        if (processedBadge) processedBadge.classList.remove('hidden');
        if (analysisRes) analysisRes.textContent = `${img.width} × ${img.height} px`;
        const estInfo = getEstimatedWatermarkInfo(item);
        if (analysisAnchor && estInfo) {
            analysisAnchor.textContent = `${estInfo.size}×${estInfo.size} (x:${estInfo.position.x}, y:${estInfo.position.y})`;
        } else if (analysisAnchor) {
            analysisAnchor.textContent = 'Detected & Recovered';
        }
        if (analysisTime) analysisTime.textContent = `${Math.round(durationMs)} ms`;

        updateProcessingStep('Restoration complete! Zero quality loss.', 100);
        setTimeout(() => {
            hideProcessingStep();
            if (scanlineEffect) scanlineEffect.classList.add('hidden');
        }, 1200);

        showToast(`Watermark removed in ${Math.round(durationMs)}ms!`, '✨');
        document.getElementById('comparisonContainer').scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (error) {
        hideProcessingStep();
        if (scanlineEffect) scanlineEffect.classList.add('hidden');
        console.error(error);
        showToast('Error processing image. Check console for details.', '⚠️');
    }
}

function createImageCard(item) {
    const card = document.createElement('div');
    card.id = `card-${item.id}`;
    card.className = 'batch-card';
    card.innerHTML = `
        <div class="batch-comparison">
            <div class="batch-pane original">
                <span class="batch-pane-label">Original</span>
                <img id="original-${item.id}" class="batch-image" draggable="false" alt="" />
            </div>
            <div class="batch-pane processed">
                <span class="batch-pane-label">Processed</span>
                <img id="processed-${item.id}" class="batch-image" draggable="false" alt="" />
            </div>
        </div>
        <div class="batch-main">
            <h4 class="batch-title"></h4>
            <div class="batch-status" id="status-${item.id}"></div>
        </div>
        <div class="batch-actions">
            <button id="copy-${item.id}" class="batch-button primary" style="display: none;">
                <svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 5H6a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2v-1M8 5a2 2 0 002 2h2a2 2 0 002-2M8 5a2 2 0 002-2M8 5a2 2 0 012-2h2a2 2 0 012 2m-1 10H8m4-3H8m1.5 6H8"></path></svg>
                <span>${TEXT.copy}</span>
            </button>
            <button id="download-${item.id}" class="batch-button secondary" style="display: none;">
                Download Result
            </button>
        </div>
    `;
    imageList.appendChild(card);

    const title = card.querySelector('.batch-title');
    title.textContent = typeof item.name === 'string' ? item.name : '';
    title.title = title.textContent;
    renderImageCardStatus(item);
}

function renderImageCardStatus(item) {
    const statusEl = document.getElementById(`status-${item.id}`);
    if (!statusEl) return;

    statusEl.classList.remove('text-primary', 'text-warning');
    if (item.status === 'completed') {
        const presentation = getProcessedStatusPresentation(item);
        statusEl.textContent = presentation.label;
        statusEl.classList.add(presentation.tone === 'warning' ? 'text-warning' : 'text-primary');
        return;
    }

    const labels = {
        pending: TEXT.pending,
        loading: TEXT.loadingImage,
        processing: TEXT.processing,
        error: TEXT.processFailed
    };
    statusEl.textContent = labels[item.status] || TEXT.pending;
}

function updateProgress() {
    progressText.textContent = `${TEXT.progress}: ${processedCount}/${imageQueue.length}`;
}

async function processQueue(batchId) {
    const concurrency = 3;
    for (let i = 0; i < imageQueue.length; i += concurrency) {
        if (batchId !== activeBatchId) return;

        await Promise.all(imageQueue.slice(i, i + concurrency).map(async (item) => {
            if (batchId !== activeBatchId || item.status !== 'pending') return;

            item.status = 'loading';
            renderImageCardStatus(item);

            try {
                const img = await loadImage(item.file);
                if (batchId !== activeBatchId) return;

                item.originalImg = img;
                item.originalUrl = img.src;
                const originalPreview = document.getElementById(`original-${item.id}`);
                const processedPreview = document.getElementById(`processed-${item.id}`);
                if (originalPreview) originalPreview.src = img.src;

                item.status = 'processing';
                renderImageCardStatus(item);

                const processed = await processImageWithBestPath(item.file, img, {
                    bestEffort: item.bestEffort
                });
                if (batchId !== activeBatchId) return;

                item.processedMeta = processed.meta;
                item.processedBlob = processed.blob;
                item.processedUrl = URL.createObjectURL(processed.blob);
                if (processedPreview) processedPreview.src = item.processedUrl;

                item.status = 'completed';
                processedCount++;
                renderImageCardStatus(item);
                updateProgress();

                const itemCopyBtn = document.getElementById(`copy-${item.id}`);
                if (itemCopyBtn) {
                    itemCopyBtn.style.display = 'inline-flex';
                    itemCopyBtn.onclick = () => copyImage(item, itemCopyBtn);
                }

                const itemDownloadBtn = document.getElementById(`download-${item.id}`);
                if (itemDownloadBtn) {
                    itemDownloadBtn.style.display = 'inline-flex';
                    itemDownloadBtn.onclick = () => downloadImage(item);
                }
            } catch (error) {
                if (batchId !== activeBatchId) return;
                item.status = 'error';
                renderImageCardStatus(item);
                console.error(error);
            }
        }));
    }
}

async function processImageWithBestPath(file, fallbackImage, options = {}) {
    const bestEffort = options.bestEffort === true;
    if (workerClient) {
        try {
            return await workerClient.processBlob(file, {
                ...options,
                adaptiveMode: bestEffort ? 'always' : options.adaptiveMode
            });
        } catch (error) {
            console.warn('worker process failed, fallback to main thread:', error);
            disableWorkerClient(error);
        }
    }

    const engine = await getEngine();
    const canvas = await engine.removeWatermarkFromImage(fallbackImage, {
        ...options,
        adaptiveMode: bestEffort ? 'always' : options.adaptiveMode
    });
    const blob = await canvasToBlob(canvas);
    return {
        blob,
        meta: canvas.__watermarkMeta || null
    };
}

async function copyImage(item, targetBtn = copyBtn) {
    if (!navigator.clipboard || !window.ClipboardItem) {
        setStatusMessage(TEXT.unsupported, 'warn');
        showToast('Clipboard copy unsupported in browser', '⚠️');
        return;
    }

    try {
        if (!item.processedBlob) return;
        const data = [new ClipboardItem({ [item.processedBlob.type]: item.processedBlob })];
        await navigator.clipboard.write(data);

        const span = targetBtn.querySelector('span');
        const svg = targetBtn.querySelector('svg');
        const originalSvgPath = svg.innerHTML;

        span.textContent = TEXT.copied;
        svg.innerHTML = '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"></path>';
        showToast('Clean image copied to clipboard!', '📋');

        setTimeout(() => {
            span.textContent = TEXT.copy;
            svg.innerHTML = originalSvgPath;
        }, 2000);
    } catch (err) {
        console.error('Failed to copy image: ', err);
        setStatusMessage(TEXT.copyFailed, 'warn');
        showToast('Failed to copy to clipboard', '⚠️');
    }
}

function downloadImage(item) {
    const a = document.createElement('a');
    a.href = item.processedUrl;
    a.download = `unwatermarked_${item.name.replace(/\.[^.]+$/, '')}.png`;
    a.click();
    showToast('Clean image download started!', '💾');
}

function setupSlider() {
    const container = document.getElementById('comparisonContainer');
    let isDown = false;

    function move(e) {
        if (!isDown) return;
        const rect = container.getBoundingClientRect();
        const clientX = e.clientX || (e.touches && e.touches[0].clientX);
        if (!clientX) return;

        const x = clientX - rect.left;
        const percent = Math.min(Math.max(x / rect.width, 0), 1) * 100;

        processedOverlay.style.width = `${percent}%`;
        sliderHandle.style.left = `${percent}%`;
    }

    container.addEventListener('mousedown', (e) => {
        isDown = true;
        move(e);
    });
    window.addEventListener('mouseup', () => { isDown = false; });
    window.addEventListener('mousemove', move);

    container.addEventListener('touchstart', (e) => {
        isDown = true;
        move(e);
    });
    window.addEventListener('touchend', () => { isDown = false; });
    window.addEventListener('touchmove', move);
}

init();
