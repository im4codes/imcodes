## 1. Nonce Exchange — Server (BLOCKER)

- [ ] 1.1 Create DB migration `server/src/db/migrations/0XX-auth-nonces.sql` — `auth_nonces` table (nonce TEXT PK, api_key, user_id, key_id, expires_at BIGINT) + TTL index
- [ ] 1.2 Run migration locally and verify table exists
- [ ] 1.3 Add `POST /api/auth/token-exchange` endpoint in `server/src/routes/auth.ts` — DELETE nonce WHERE nonce=$1 AND expires_at > now, RETURNING api_key/user_id/key_id
- [ ] 1.4 Update passkey login callback in `server/src/routes/passkey-auth.ts` (~L365) — generate nonce, INSERT into auth_nonces, replace `key`/`userId`/`keyId` URL params with `nonce`
- [ ] 1.5 Update passkey registration callback in `passkey-auth.ts` (~L470) — same nonce pattern
- [ ] 1.6 Update password setup callback in `passkey-auth.ts` (~L648) — same nonce pattern
- [ ] 1.7 Update `NativeAuthBridge.tsx` password_setup flow — use nonce exchange instead of encoding API key in URL hash. After password setup completes, server creates nonce and redirects to `imcodes://auth?nonce=<nonce>`
- [ ] 1.8 Add backward compat: server generates BOTH `nonce` and `key` params during 30-day rollout window. Client tries `nonce` first, falls back to `key`.
- [ ] 1.9 Add nonce cleanup function — DELETE expired nonces on server startup + setInterval every 5 min
- [ ] 1.10 Write server tests for token-exchange: valid exchange, replay rejection, expired nonce, missing nonce

## 2. Nonce Exchange — Client (BLOCKER)

- [ ] 2.1 Add `exchangeNonce(serverUrl, nonce)` function in `web/src/api.ts`
- [ ] 2.2 Add `exchangeNonceWithRetry(serverUrl, nonce, maxRetries=3)` wrapper with exponential backoff (1s/2s/4s). Add `AbortSignal.timeout(10000)` to each fetch attempt. Total retry window capped at 30s, well within 60s nonce TTL.
- [ ] 2.3 Update `handleNativeAuth` in `web/src/pages/LoginPage.tsx` — parse `nonce` from callback, call exchangeNonceWithRetry. Fall back to `key` param if present (30-day backward compat).
- [ ] 2.4 Update `NativeAuthBridge.tsx` callback handling — same nonce exchange for password setup path
- [ ] 2.5 Add i18n key for nonce exchange failure message ("Authentication completed but connection failed") in all 7 locales
- [ ] 2.6 Write web tests for nonce exchange: success, retry, fallback to key param, AbortSignal timeout

## 3. Android Auth Reliability

- [x] 3.1 Add try-catch around `CustomTabsIntent.launchUrl()` in `AuthSessionPlugin.java` — catch ActivityNotFoundException, fall back to Intent.ACTION_VIEW
- [x] 3.2 Add "no browser at all" handling — reject with `no_browser_available` structured error
- [x] 3.3 Add `callbackReceived` boolean flag to AuthSessionPlugin
- [x] 3.4 Update `handleCallback()` to set `callbackReceived = true` before resolving
- [x] 3.5 Update `handleOnResume()` — check flag, increase delay from 1000ms to 3000ms
- [x] 3.6 Replace all `call.reject("cancelled")` with structured error codes: `user_cancelled`, `custom_tab_failed`, `missing_parameters`, `no_browser_available`
- [ ] 3.7 Test on emulator: verify Custom Tab fallback, back button rejection, structured errors

## 4. Auth Observability

- [ ] 4.1 Add `X-Platform` header to auth API calls — use `Capacitor.getPlatform()` on native, 'web' on browser
- [ ] 4.2 Add version attribution headers: `X-App-Version` (from `App.getInfo()`), `X-Bundle-Version` (from CapacitorUpdater or 'none')
- [ ] 4.3 Update `logAudit` calls in `passkey-auth.ts` and `auth.ts` to include `platform`, `app_version`, `bundle_version` fields
- [ ] 4.4 Add `outcome_code` field to audit log entries (success, passkey_failed, user_cancelled, nonce_expired, token_exchange_failed, etc.)
- [ ] 4.5 Verify audit log includes platform + version + outcome for all auth events

## 5. Firebase / Push Notifications

- [ ] 5.1 Create new Firebase project. Add BOTH Android and iOS apps. Download `google-services.json` (Android) and `GoogleService-Info.plist` (iOS).
- [ ] 5.2 Add `google-services.json` to `web/android/app/`
- [ ] 5.3 Add `GoogleService-Info.plist` to `web/ios/App/App/` if not already present
- [ ] 5.4 Add both files to `.gitignore` (or encrypt for CI)
- [ ] 5.5 Uncomment `google-services.json` in `web/android/.gitignore` (currently commented out with `#`)
- [ ] 5.6 Test push notification delivery on a real Android device
- [ ] 5.7 Verify non-GMS device handles missing FCM gracefully (no crash — `build.gradle` already conditionally applies plugin)

## 6. Android Branding

- [ ] 6.1 Generate IM.codes launcher icons for all density buckets (mdpi through xxxhdpi)
- [ ] 6.2 Generate adaptive icon foreground + background drawables
- [ ] 6.3 Generate round icon variants
- [ ] 6.4 Replace files in `web/android/app/src/main/res/mipmap-*/`
- [ ] 6.5 Verify icon displays correctly on Pixel emulator and Samsung device

## 7. Release Build Configuration

- [ ] 7.1 Create release keystore (or configure Play App Signing)
- [x] 7.2 Add `signingConfigs` block to `web/android/app/build.gradle` reading from environment variables (KEYSTORE_FILE, KEYSTORE_PASSWORD, KEY_ALIAS, KEY_PASSWORD)
- [x] 7.3 Enable `minifyEnabled true` and `shrinkResources true` in release buildType
- [x] 7.4 Verify versionCode/versionName match iOS (currently 1.0/1). No bump needed for initial release.
- [ ] 7.5 Run `npx cap sync android && cd web/android && ./gradlew assembleRelease` — verify it produces signed APK
- [ ] 7.6 Verify signed APK installs and runs correctly on emulator

## 8. CI/CD Pipeline

- [x] 8.1 Add new GitHub Actions job (or workflow `ci-android.yml`)
- [x] 8.2 Configure runner: `ubuntu-latest` with `actions/setup-java@v4` (Java 21, distribution: temurin)
- [x] 8.3 Install Android SDK: `android-actions/setup-android@v3` with API 36, build-tools
- [x] 8.4 Install Node.js + `npm ci` (web dependencies)
- [x] 8.5 Decode secrets from GitHub secrets: `google-services.json` (base64), keystore file (base64), keystore passwords
- [x] 8.6 Build web assets: `cd web && npm run build` (or equivalent Vite build)
- [x] 8.7 Sync to Android: `npx cap sync android`
- [x] 8.8 Gradle build: `cd web/android && ./gradlew assembleRelease`
- [x] 8.9 Upload APK/AAB as GitHub Actions workflow artifact
- [ ] 8.10 Verify CI passes on push to dev branch

## 9. Auth Surface Decision (after measurements)

- [ ] 9.1 Define benchmark: device=Redmi 9A class, network=4G, event measured=Custom Tab open → `navigator.credentials.get()` called, threshold=3s
- [ ] 9.2 Measure end-to-end "tap Login → WebAuthn prompt appears" latency in Custom Tab using `performance.now()` timestamps
- [ ] 9.3 If < 3s: mark SPA bridge as canonical, add deprecation notice to lightweight page
- [ ] 9.4 If > 3s: add registration + password setup flows to lightweight HTML page
- [ ] 9.5 Document decision in `docs/plan/Android.md` §4.2.1

## 10. End-to-End Verification

- [ ] 10.1 Test passkey login on Pixel (GMS) — full flow with nonce exchange
- [ ] 10.2 Test password login on Pixel — verify works without passkey
- [ ] 10.3 Test passkey login on Samsung — verify Custom Tab behavior
- [ ] 10.4 Test on Huawei emulator (non-GMS) — verify browser fallback + password login
- [ ] 10.5 Test on Xiaomi/Redmi (slow device) — verify no false rejection on resume
- [ ] 10.6 Test push notification delivery — send from server, verify received on device
- [ ] 10.7 Test nonce exchange backward compat — old client with new server, new client with old server
- [ ] 10.8 Test OTA-updated bundle with old native shell — verify nonce exchange works
- [ ] 10.9 Verify release APK installs and runs correctly
- [ ] 10.10 Verify auth audit log includes platform + version + outcome fields
