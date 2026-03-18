# App Store Assets

Place required assets here before submitting to App Store / Google Play.

## iOS (App Store Connect)

### App Icon
- `ios/icons/icon-1024.png` — 1024×1024 px, no alpha channel (required)
- Xcode generates all other sizes from this via asset catalog

### Screenshots (required per device category)
- `ios/screenshots/iphone-6-7-inch/` — 1290×2796 or 1320×2868 px (iPhone 15 Pro Max)
- `ios/screenshots/iphone-5-5-inch/` — 1242×2208 px (iPhone 8 Plus, required for older iOS)
- `ios/screenshots/ipad-pro-12-9/` — 2048×2732 px (iPad Pro 12.9")

### App Store Listing
- **Name**: IM.codes
- **Subtitle**: AI agent terminal, anywhere
- **Description**: Control AI coding agents from Discord, Telegram, or your browser. IM.codes bridges your local Claude Code / Codex sessions to any platform.
- **Keywords**: AI, terminal, Claude, agent, remote, SSH, coding assistant
- **Category**: Developer Tools
- **Privacy URL**: (your privacy policy URL)
- **Support URL**: https://github.com/yourusername/imcodes

## Android (Google Play Console)

### App Icon
- `android/icons/ic_launcher-512.png` — 512×512 px, 32-bit PNG with alpha (required)

### Feature Graphic
- `android/icons/feature-graphic.png` — 1024×500 px (required for Play Store listing)

### Screenshots (phone required, tablet optional)
- `android/screenshots/phone/` — minimum 2, max 8; 1080×1920 or 1440×2560 px recommended
- `android/screenshots/tablet-7/` — 1200×1920 px (optional)
- `android/screenshots/tablet-10/` — 1920×1200 px (optional)

### Play Store Listing
- **App name**: IM.codes
- **Short description** (80 chars): Control AI agents remotely via Discord, Telegram, or browser
- **Full description**: (same as iOS, reformatted for Play Store markdown)
- **Category**: Tools
- **Content rating**: Everyone

## Recommended Screenshot Content

1. **Terminal view** — live session stream with Claude Code output
2. **Session tabs** — multiple sessions side by side
3. **Discord integration** — sending task, receiving response
4. **Project dashboard** — list of projects with status indicators
5. **Auto-fix pipeline** — progress bar showing design→implement→approve flow

## Tools for Generating Screenshots

- [Fastlane Snapshot](https://docs.fastlane.tools/actions/snapshot/) — automated iOS screenshots
- [Fastlane Screengrab](https://docs.fastlane.tools/actions/screengrab/) — automated Android screenshots
- [Capacitor Screenshots plugin](https://github.com/capacitor-community/screenshots) — cross-platform
