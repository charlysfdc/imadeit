# ImadeIt: a blanket log by Rustic Nastalje

A cozy little app for chunky blanket knitters to keep track of every blanket they make: photos, dates, size, stitch count, yarn and notes.

**Free. No account. No ads. No tracking.** Everything stays on your own phone.

**Open the app:** https://imadeit.rusticnastalje.com

## What it does

- Log each blanket with photos, a blanket number, start and finish dates, size, stitches wide, rows, yarn and notes
- **Pattern:** a pattern name, a link (Ravelry, a blog, YouTube…) and/or an attached pattern file (PDF, photo or document, up to 30 MB) that you can open or save from the blanket
- **Yarn picker:** brand and colour fields suggest as you type, from 17 well-known chunky and chenille lines (Bernat, Lion Brand, Premier, Cozyful, HOMBYS, Loops & Threads, iDIY, Alize; about 850 colours). Anything else you type is remembered for next time. The list lives in `yarn-catalog.js`.
- **Patterns:** save each pattern once (name, link, PDF, notes) and pick it when you start a blanket. Add many pattern files at once. Each pattern shows how often you've made it, average skeins and days.
- **Free pattern:** The Rustic Blanket, a Breadcrumb pattern by Rustic Nastalje, built in. Pick a size and it sets up the blanket; the row counter shows each row's instruction.
- **Row counter:** for any blanket with a row count, tap once per row, with undo
- **Spreadsheets:** import blankets from Google Sheets, Excel or Numbers (CSV, one row per yarn colour), download a blank template, or export everything as a spreadsheet
- **Plan before you start:** planned size, and how many skeins of each colour you expect to use
- **Skein tracker:** tap **New skein** each time you join one, so you never lose count (with undo, and a dated skein diary)
- **I finished it!** asks for the finished size and skeins used, then shows planned vs. actual: "2 in narrower and 3 in longer than planned", "1 more skein than planned"
- Browse your blankets by year, with totals for blankets made and skeins used
- Search anything: "sage", a pattern name, "Bernat", "pillow"
- Tap **Make another like this** to plan a new blanket from what an old one actually took
- Save a **backup** file (to Files, iCloud Drive, Google Drive or email) and restore it on a new phone
- Works offline and looks right in light and dark mode

## Installing it on your phone

1. Open https://imadeit.rusticnastalje.com in **Safari** (iPhone) or **Chrome** (Android).
2. iPhone: tap **Share**, then **Add to Home Screen**. Android: tap the menu (⋮), then **Install app**.
3. Open ImadeIt from your Home Screen and start logging there.

> The Home Screen app and the browser keep separate notebooks, so always use the Home Screen app.

## Licence

The app's code is MIT-licensed (see `LICENSE`). The pattern text in `rustic-patterns.js` is © Rustic Nastalje and is not covered by the MIT licence: it may not be copied or redistributed outside ImadeIt.

## Privacy

ImadeIt has no server. Blankets and photos are stored in your browser's on-device storage (IndexedDB). Nothing is sent anywhere. The only way data leaves the phone is a backup file that you save yourself.

## Hosting it (GitHub Pages + custom domain)

The app is plain HTML, CSS and JavaScript with no build step. It's served by GitHub Pages at
`imadeit.rusticnastalje.com` (set by the `CNAME` file).

1. **GitHub:** in the repository, go to **Settings → Pages**. Under **Build and deployment**, choose
   **Deploy from a branch**, pick the branch and the `/ (root)` folder, and save.
2. **DNS (Cloudflare):** add a record of type `CNAME`, name `imadeit`, target `charlysfdc.github.io`,
   with the proxy turned **off** (grey cloud, "DNS only") so GitHub can issue the HTTPS certificate.
3. **GitHub again:** in **Settings → Pages**, enter `imadeit.rusticnastalje.com` as the custom domain,
   wait for the DNS check to pass, then tick **Enforce HTTPS**.

Changing the domain later moves the app to a new address, and browsers keep each address's data
separately. Anyone already using it would need to save a backup and restore it at the new address, so pick
the domain once and keep it.

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
| `autocomplete.js` | The type-ahead list used by the yarn brand and colour fields |
| `yarn-catalog.js` | Built-in yarn brands and their colours |
| `rustic-patterns.js` | The free built-in pattern (The Rustic Blanket) |
| `csv.js` | Reading and writing spreadsheets (CSV) |
| `styles.css` | The cozy rustic look, light and dark |
| `sw.js` | Offline support |
| `manifest.webmanifest`, `icons/` | What makes it installable as an app |
