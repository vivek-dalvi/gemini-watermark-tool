# DevCart Gemini Watermark Tool - Documentation

Welcome to the documentation for **DevCart Gemini Watermark Tool**, developed and maintained by **DevCart Technologies** and Lead Developer **Vivek Dalvi**.

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Core Algorithm & Mathematics](#core-algorithm--mathematics)
3. [Supported Media & Formats](#supported-media--formats)
4. [Deployment Guides](#deployment-guides)
5. [Browser Integrations & SDKs](#browser-integrations--sdks)
6. [Open Source & License](#open-source--license)

---

## Architecture Overview

DevCart Gemini Watermark Tool is structured into modular layers:

- **`src/core/`**: Mathematical reverse alpha channel blended pixel restoration engine.
- **`src/sdk/`**: Browser, ImageData, Node.js, and Video runtime SDK exports.
- **`src/app.js`**: Web Application UI handler, preview modes (Split Slider, Side-by-Side, Flip), and theme system.
- **`src/userscript/`**: Tampermonkey userscript for automated download/preview cleaning on `gemini.google.com`.
- **`src/extension/`**: Chrome Extension Manifest V3 implementation.
- **`public/`**: Static HTML assets, logo branding, worker probes, and ONNX runtime binaries.

---

## Core Algorithm & Mathematics

Google Gemini overlays translucent watermark logos ($C_{\text{src}}$) over generated images using standard compositing:

$$C_{\text{wm}} = \alpha \cdot C_{\text{src}} + (1 - \alpha) \cdot C_{\text{orig}}$$

By analytical inverse blending, this tool restores $C_{\text{orig}}$ with exact precision:

$$C_{\text{orig}} = \frac{C_{\text{wm}} - \alpha \cdot C_{\text{src}}}{1 - \alpha}$$

---

## Supported Media & Formats

- **Images**: PNG, JPG, WebP (0.5K, 1K, 2K, 4K resolutions).
- **Videos**: MP4, WebM, MOV (Google Veo and Gemini Video outputs).

---

## Deployment Guides

### Quick Start
```bash
npm install
npm run dev
```

### Production Build
```bash
npm run build
npm start
```

---

## Open Source & License

- **GitHub Repository**: [https://github.com/vivek-dalvi/gemini-watermark-tool.git](https://github.com/vivek-dalvi/gemini-watermark-tool.git)
- **Organization**: DevCart Technologies ([info@devcart-technologies.in](mailto:info@devcart-technologies.in))
- **Lead Developer**: Vivek Dalvi ([vivekdalvi147@gmail.com](mailto:vivekdalvi147@gmail.com))
- **License**: MIT License
