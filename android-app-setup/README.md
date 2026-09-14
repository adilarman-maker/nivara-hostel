# Getnesty Android app (Capacitor WebView shell)

This APK does NOT contain your app's HTML/CSS/JS. It's a thin native shell
that opens a WebView pointed at your live server (`capacitor.config.json` ->
`server.url`). This is deliberate: it means most future updates need **zero**
Play Store resubmission.

## What auto-updates for free (no new APK needed)
- Anything in `public/` (HTML, CSS, JS)
- Any backend route/behavior change in `routes/`, `db/`
- New features, bug fixes, styling — literally everything you `git push`
  through your normal Vercel deploy

Users get it the next time they open the app. That's it.

## What DOES need a new APK + Play Store update
- App icon or splash screen
- Android permissions (camera, notifications, etc.)
- Adding a native Capacitor plugin
- Changing `appId` or the app name

## One-time setup (run on your Windows machine, in the project root)

```
npm install @capacitor/core @capacitor/android
npm install -D @capacitor/cli
npx cap init "Getnesty" "com.nesto.app" --web-dir=public
```

(You already have `capacitor.config.json` — `cap init` may ask to
overwrite it; keep the version already in this repo, it has your
`server.url` pre-filled.)

**Before continuing:** edit `capacitor.config.json` and replace
`REPLACE-WITH-YOUR-PRODUCTION-URL` with your real Vercel production URL.

```
npx cap add android
npx cap sync android
```

This creates an `android/` folder — a full Android Studio project. From here:

1. Open the `android/` folder in **Android Studio** (free download, needed
   once for building/signing — not needed again for future content updates).
2. Build → Generate Signed Bundle / APK. Create a keystore the first time
   (back this up somewhere safe — you need the SAME keystore for every
   future Play Store update of the app itself, i.e. the rare "needs a new
   APK" case above).
3. Upload the signed `.aab` to Google Play Console (or share the signed
   `.apk` directly for sideloading, if you're not going through Play Store
   yet).

## After the one-time setup
Day to day, you never touch Android Studio again unless you're changing
something in the "needs a new APK" list above. Just `git push` like normal.

## A note on offline behavior
Since this loads a remote URL, there's no offline mode — no internet, no
app, same as any other web app. If you ever want basic offline support
(e.g. viewing already-loaded data), that's a separate, bigger feature
(service worker / local caching) — worth its own conversation once the
core multi-tenant work is done and stable.
