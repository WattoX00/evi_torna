# Private GitHub File Manager

A responsive React, TypeScript, and Vite application for managing files in a private GitHub repository. The app is static and can be hosted on GitHub Pages; file operations use GitHub's REST Contents API directly from the browser.

## Local development

1. Install Node.js 20 or later.
2. Run `npm install`.
3. Run `npm run dev` and open the local URL Vite prints.
4. Run `npm run build` to type-check and create the production build in `dist/`.

## GitHub token permissions

Create a **fine-grained personal access token** in GitHub. Limit repository access to the one private repository you intend to manage and grant **Contents: Read and write** repository permission. Organization policies or SSO authorization may require additional approval.

In the app's Settings, enter the GitHub account login that owns the token, repository owner/name, branch, and token. The app validates the token's account, repository access, and branch before connecting.

After a successful connection, the app saves the username, repository settings, and access token in this browser's `localStorage` so the connection survives page reloads. Disconnect to remove the saved settings. The token is not written to cookies, source code, URLs, build artifacts, or application logs. Anyone with access to the browser or its developer tools can inspect or use the token; browser extensions, compromised devices, and malicious scripts have the same potential exposure. GitHub API requests go directly from the browser to `api.github.com`; GitHub receives the request and the token. This is not equivalent to server-side secret storage, and a public Pages site cannot keep a token secret from its user. Use a narrowly scoped token, do not share the browser session, and revoke the token in GitHub if it may be exposed. For stronger authentication boundaries, use a trusted backend or GitHub App instead.

## GitHub Pages deployment

1. Create a **public** GitHub repository for this frontend and push the project to its `main` branch.
2. In the repository, open **Settings → Pages** and set the build/deployment source to **GitHub Actions**.
3. Ensure Actions are enabled and that the workflow's Pages deployment permissions are allowed by repository/organization policy.
4. The included `.github/workflows/deploy.yml` builds on pushes to `main` and deploys `dist/` to GitHub Pages. Find the deployed URL under **Settings → Pages**.

Vite automatically sets the correct base path for project Pages sites using the repository name supplied by GitHub Actions. For a custom production branch, update the workflow's `push.branches` list.

## Features and limits

- Browse directories, use breadcrumbs, search, sort by name or size, and switch between list and grid views.
- Upload files and delete files (with confirmation); both operations create Git commits on the selected branch.
- Preview common images, PDFs, and text/code formats. Other types can be downloaded.
- Download and share files using the Web Share API where file sharing is supported. Otherwise, download the file and open an email draft with instructions to attach it manually; `mailto:` cannot reliably attach files.
- Desktop Print/Open launches the GitHub blob page, which requires a GitHub login with repository access for private files. On mobile, it opens an authenticated, temporary Blob URL; some browsers may block popups or be unable to display a given file type.
- GitHub's Contents API limits a file to 100 MB and a directory listing to 1,000 entries. GitHub may impose additional API rate limits and content response constraints. Uploads are sequential and show per-file progress, not byte-level progress. A failed upload in a multi-file selection does not roll back files already committed.
- Changes are committed directly to the selected branch. The app does not provide conflict resolution, history, or recovery beyond GitHub's repository history.
- The app requires network access to GitHub's REST API and does not proxy requests through a server.
