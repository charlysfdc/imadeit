# ImadeIt: a blanket log by Rustic Nastalje

A cozy little app for chunky blanket knitters to keep track of every blanket they make: photos, dates, size, stitch count, yarn and notes.

**Free. No account. No ads. No tracking.** Everything stays on your own phone.

## What it does

- Log each blanket with photos, a blanket number, start and finish dates, size, stitches wide, rows, stitch, yarn (brand, colour, skeins) and notes
- Browse your blankets by year, with totals for blankets made and skeins used
- Search anything: "sage", "garter", "Bernat", "pillow"
- Tap **Make another like this** to start a new blanket from an old one's recipe
- Tap **Mark finished today** when a blanket comes off your arms
- Save a **backup** file (to Files, iCloud Drive, Google Drive or email) and restore it on a new phone
- Works offline and looks right in light and dark mode

## Installing it on your phone

1. Open the app's link in **Safari** (iPhone) or **Chrome** (Android).
2. iPhone: tap **Share**, then **Add to Home Screen**. Android: tap the menu (⋮), then **Install app**.
3. Open ImadeIt from your Home Screen and start logging there.

> The Home Screen app and the browser keep separate notebooks, so always use the Home Screen app.

## Privacy

ImadeIt has no server. Blankets and photos are stored in your browser's on-device storage (IndexedDB). Nothing is sent anywhere. The only way data leaves the phone is a backup file that you save yourself.

## Hosting it (GitHub Pages)

The app is plain HTML, CSS and JavaScript with no build step.

1. In the repository on GitHub, go to **Settings → Pages**.
2. Under **Build and deployment**, choose **Deploy from a branch**, pick the branch and the `/ (root)` folder, and save.
3. After a minute the app is live at `https://<your-username>.github.io/<repo-name>/`.

## Making changes

- Run it locally with `python3 -m http.server 8000` and open http://localhost:8000.
- **Whenever you change any file, bump `VERSION` in `sw.js`** (for example `imadeit-v1.0.1`). That tells installed copies to download the new version the next time they open.
- Update `APP_VERSION` in `app.js` to match, so it shows in Settings.

## Files

| File | What it is |
| --- | --- |
| `index.html` | The page shell |
| `app.js` | All screens: blanket list, blanket details, add/edit form, settings and backups |
| `db.js` | On-device storage (IndexedDB) |
| `images.js` | Shrinks photos so they don't fill up the phone |
| `styles.css` | The cozy rustic look, light and dark |
| `sw.js` | Offline support |
| `manifest.webmanifest`, `icons/` | What makes it installable as an app |
