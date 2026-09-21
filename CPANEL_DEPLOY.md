# Deploying the frontend to cPanel

The frontend is a static React build. cPanel serves the files; the API
runs separately as a DigitalOcean app. Nothing here runs Python.

## 1. Build (on your Mac)

The build must run on macOS — `node_modules` holds macOS-native binaries,
so it cannot be built from a Linux container.

```bash
cd ~/wialon-backend/frontend
npm run build
```

That runs `tsc -b && vite build` and writes `dist/`.

`.env.production` supplies the API address at build time:

```
VITE_API_BASE_URL=https://urchin-app-3tpdf.ondigitalocean.app
```

Vite substitutes this **at build time, not run time** — change it and you
must rebuild. It is not a secret; it ends up visible in the shipped
JavaScript, so never put a password or key in that file.

## 2. Upload

Upload the **contents** of `dist/` into `public_html/` — not the `dist`
folder itself. Replace the previous files.

`dist/.htaccess` must go up too. It is a dotfile, so cPanel's File
Manager hides it by default: turn on **Settings → Show Hidden Files
(dotfiles)** or you will upload a site that 404s on every page refresh.

It comes from `frontend/public/.htaccess`, which Vite copies into `dist/`
on every build. Do not edit it inside `dist/` — that copy is overwritten.

What it does:

- routes unknown paths to `index.html`, so React Router handles
  `/employees`, `/payroll/report` and so on after a refresh or a pasted
  link
- caches fingerprinted assets hard, and forbids caching `index.html` —
  without that, browsers keep loading the previous build's asset names
- gzip, plus basic security headers

## 3. Allow the browser to reach the API

The site and the API are on different domains, so the browser enforces
CORS. Set `CORS_ORIGINS` on the DigitalOcean app to the cPanel domain
(scheme included, no trailing slash), then redeploy the API.

Without this the site loads and then every screen fails to fetch — the
usual symptom is an empty table with a console error, not an error page.

## 4. Check

Open the site and confirm:

- the login page loads
- signing in works (proves the API is reachable and CORS is right)
- navigate to a sub-page, then **refresh** — still works, proving
  `.htaccess` uploaded
- the Network tab shows requests going to the DigitalOcean domain

## Rebuilding after a change

`npm run build`, re-upload `dist/`, hard-refresh. Asset filenames are
fingerprinted, so a normal refresh usually suffices, but `index.html`
must not be served from cache.
