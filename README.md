# Anatomy Study PWA

A private, offline-first exercise-file library and 3D anatomy viewer. The app is static and has no app backend, analytics, or paid service. Local files and settings stay in the browser's IndexedDB. GitHub sync is optional and sends files only to the private repository you configure.

## Run locally

1. Install Node.js 22 LTS and npm.
2. Run `npm install`.
3. Run `npm run dev` and open the local URL printed by Vite.
4. Run `npm run build` to type-check and create the static site in `dist/`.

For a release build, add the model described below at `public/models/anatomy.glb`. If it is absent or cannot be loaded, a procedural model appears instead.

## Deploy to GitHub Pages

1. Create a new **public** GitHub repository for this app. Use a project repository (for example, a repository named `anatomy-study-pwa`); the Pages URL will be `https://OWNER.github.io/REPOSITORY/`.
2. Copy this project into the repository, commit the files, and push the `main` branch. The included workflow installs dependencies, builds with the repository-specific Vite base path, and publishes `dist/`.
3. In the repository, open **Settings → Pages** and set **Build and deployment → Source** to **GitHub Actions**. Do not choose the branch/folder source.
4. Open **Actions**, confirm **Deploy PWA to GitHub Pages** succeeds, then open the Pages URL shown by the deployment.
5. For offline use, visit the site online once and wait for the “App is ready to use offline” message. The service worker precaches the app shell and bundled model when present.

The workflow needs `pages: write` and `id-token: write`; these are declared in `.github/workflows/deploy.yml`. If organization policy disallows Actions deployments, have an administrator permit GitHub Pages deployment workflows.

### Local icon PNGs

The SVG icon is at `public/icons/icon.svg`. Generate the install PNG files using only Python's standard library:

```powershell
node scripts\generate-icons.mjs
```

This writes `icon-192.png`, `icon-512.png`, and the iOS `apple-touch-icon.png` (180×180). Commit these generated assets with the app.

## Optional private GitHub file sync

1. Create a **private** GitHub repository separate from the public app repository, such as `exercise-files`. It can start empty; the app creates the `files/` directory when it uploads the first file.
2. On GitHub, open **Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token**.
3. Give the token a descriptive name, choose only the private data repository under **Repository access**, and set **Expiration** to **Custom → 1 year** (the maximum lifetime may be restricted by organization policy).
4. Under **Repository permissions**, grant **Contents: Read and write**. Leave other permissions at **No access**. Metadata read access is automatically included by GitHub.
5. In the app's **Settings → Optional GitHub sync**, enter your GitHub owner, private repository name, branch (normally `main`), and token. Select **Save sync settings**, then **Test connection**.
6. The token is kept in this browser's IndexedDB and is sent only in the GitHub API authorization header. Never put it in a URL, source file, public issue, or the app repository. Use **Clear credentials** before sharing a device.

The app syncs PDF and common image files in the private repository's `/files` folder. It compares file names and GitHub SHAs. If the same name is edited locally while offline and remotely before the next sync, the local pending version wins and is uploaded (simple last-write-wins). Remote changes to otherwise unchanged local files download; files deleted remotely are removed locally on sync. Local deletes are queued while offline. GitHub API errors are shown in the app; local-only use remains available.

### Renew an expired token

Generate a replacement fine-grained token with the same repository scope, **Contents: Read and write**, and a one-year expiry. In Settings, enter the new token and select **Save sync settings**, then **Test connection**. If GitHub revokes the old token, pending local changes remain stored until a valid token is entered and sync succeeds. The app never logs token contents.

## Supply and optimize the anatomy model

The app looks for `public/models/anatomy.glb`. Use the original Z-Anatomy distribution and preserve its attribution/license. The procedural scene is intentionally built into the app so the interface remains testable without that asset.

### Blender export guide

1. Open the Z-Anatomy `.blend` file and save a separate working copy. Keep a source copy unchanged.
2. In the Outliner, identify and keep only the muscle and bone collections/objects. Preserve original object/mesh names because region mapping, side detection, and part search use them.
3. Apply object transforms where appropriate; do not merge objects if individual muscle/bone selection is wanted. Remove hidden duplicates and unnecessary decorative objects.
4. For oversized meshes, use Blender's **Decimate** modifier conservatively. Apply it only to the working copy, inspect silhouettes and joints, and retain enough detail for the intended phone screen.
5. Select the retained anatomy objects and choose **File → Export → glTF 2.0**. Set format to **glTF Binary (.glb)**. Keep mesh names, materials, and user data if available. Export a regular GLB and optimize it with Meshopt below; the viewer bundles the Meshopt decoder for offline use.
6. Aim for under **25 MB** for reasonable mobile downloads, then save the result as `public/models/anatomy.glb`. A model containing meshes outside the mapping still loads; in development the unmatched-name panel helps extend `src/data/regions.json`.

Optional local optimization with gltf-transform (install its CLI separately only if you want to use it):

```powershell
npx @gltf-transform/cli optimize public\models\anatomy.glb public\models\anatomy-optimized.glb --compress meshopt
```

If you use the optimized output, rename it to `anatomy.glb`. The viewer registers Meshopt decoding. Keep an unoptimized backup and validate the output in the app before publishing.

## Offline test plan

1. Deploy or run the production build over HTTPS, load it once online, and wait for the offline-ready message.
2. Add a PDF and an image. Open the PDF, navigate pages and zoom; scroll the file list until a thumbnail is rendered.
3. Use browser developer tools to switch the network to **Offline**, reload, then verify tabs, saved file previews, the cached 3D model (or procedural fallback), settings, and search still work.
4. Restore the network. Configure the private repo if desired, add a file while offline, reconnect, and verify its status changes from Pending sync to Synced.
5. Delete a synced file while offline, reconnect, sync, and verify removal in the private repository.
6. Export a ZIP, clear browser site data in a disposable test profile, import the ZIP, and verify the files return.
7. Publish a new version, leave the app open, and verify the update banner offers **Reload**.

## Known iOS PWA limitations and handling

- **Storage eviction:** iOS may evict website data when storage is low or the app is unused. The app requests persistent storage when available, reports quota/usage, and provides ZIP export/import. Persistence is a browser decision and cannot be guaranteed.
- **Sharing:** on phones and tablets, Share and Print open the operating system's native share sheet with the file contents; choose a destination, or choose **Print** for printing. If the browser cannot share the file, the app reports the problem. On desktop, Share downloads the file(s) and opens the default mail app with the file name(s), so you can attach the downloads manually; Print opens the file in a new tab.
- **Background/update behavior:** iOS may suspend background work and service-worker updates until the app is foregrounded and online. Sync queues changes locally and retries after connectivity returns.
- **Offline model storage:** large GLB files take time to cache and use device quota. Keep the model below 25 MB and open the app online once after each deployment.

## License and attribution

The app source is provided for personal use. Any supplied Z-Anatomy model retains its own CC BY-SA 4.0 attribution and share-alike obligations. Dependencies retain their respective licenses as listed in Settings.
