# Icon Assets

## Trademark Notice

The icons in this folder are **original designs**. They do **not** use the official GitHub Copilot logo, wordmark, or any Microsoft/GitHub trademarked imagery.

**Why we designed our own:**
- The GitHub Copilot logo (the "AI face" mark) is a registered trademark of GitHub, Inc.
- Using it in a third-party extension without permission would violate GitHub's trademark policy.
- Our robot head is a generic, original "AI assistant" silhouette — no association with Copilot's brand.

**Our design approach:**
- Generic rounded-rectangle robot head with circular eyes
- Simple antenna with a glowing tip (common sci-fi trope)
- Bar chart + cost badge to communicate "analytics for AI coding"
- No GitHub Octocat, no Copilot "face" logo, no Microsoft branding

If you need the official Copilot icon for any purpose, request it from GitHub directly:
https://github.com/logos

## Icon Variations

| File | Shape | Best For |
|------|-------|----------|
| `icon-v1-chart-copilot.svg` | Rounded square | Primary extension icon |
| `icon-v2-hex-bars.svg` | Hexagon | Alternate / dark theme variant |
| `icon-v3-minimal-ring.svg` | Circle | Minimal / small sizes |
| `icon-v4-badge-charts.svg` | Shield / badge | Marketplace listing hero |

## Exporting PNGs

VS Code requires PNG icons at these sizes:
- 128x128 (extension icon)
- 48x48 (command palette)
- 32x32 (activity bar, if added)
- 16x16 (status bar, if added)

Export from SVG using:
```bash
# Requires Inkscape or ImageMagick
inkscape icon-v1-chart-copilot.svg --export-filename=icon-128.png -w 128 -h 128
```
