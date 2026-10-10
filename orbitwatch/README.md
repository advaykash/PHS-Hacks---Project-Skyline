# OrbitWatch

A 3D globe of tracked satellites and space debris, made for hackPHS 2026 ("Into the Skies").
Positions are calculated in your browser with SGP4 (satellite.js 6.0.2), using orbital elements from
[CelesTrak](https://celestrak.org). This app's own Node.js server downloads and caches those elements.

- **No dependencies to install.** You need Node.js 20 or newer, and nothing else.
- **No API keys or secrets.**
- **Everything is in this folder**, including the three.js and satellite.js libraries. Only the IBM Plex
  font is loaded from Google Fonts, and the page falls back to system fonts if that fails.

## How the data gets to the page

```
celestrak.org  --(at most once per group every 2 h)-->  server/server.mjs  --(same origin: /api/gp)-->  browser
                                                        keeps the last good copy                         SGP4 + three.js
```

- **The browser never contacts CelesTrak.** It asks this server at `/api/gp?group=<group>`.
- **The server downloads each group at most once per CelesTrak update**, which happens every 2 hours. Each request
  has a 20 second timeout. A reply replaces the cached copy only if it is HTTP 200, is JSON, is a list, and
  contains valid orbital elements.
- **If CelesTrak is slow, down or refusing**, the server keeps serving the last good copy and marks it stale when
  it is old.
- **Groups:**
  - `stations`
  - `active`
  - `visual`
  - `fengyun-1c-debris`
  - `iridium-33-debris`
  - `cosmos-2251-debris`

  `cosmos-1408-debris` is not included because CelesTrak no longer publishes it.

### Why there is a server

- **CelesTrak's rules.** CelesTrak allows one download per IP address per data update, and blocks addresses
  that keep sending failing requests. Visitors on a school or hackathon network share one IP. With the
  server, the whole site makes at most 6 downloads every 2 hours, however many people visit.
- **Browser security.** In a Claude artifact, the page's Content-Security-Policy (`connect-src`) blocks
  every outside download. A same-origin endpoint avoids that.

## Files

```
orbitwatch/
├── package.json            npm start / npm test / npm run build:page / npm run fetch-data
├── package-lock.json       (no dependencies)
├── README.md
├── .do/app.yaml            DigitalOcean App Platform spec
├── .gitignore              ignores the server's .cache/ folder
├── .gitattributes          keeps LF line endings on Windows
├── server/server.mjs       web server: the page, /api/gp, /api/health
├── public/                 everything the browser loads
│   ├── index.html          the whole app (built from src/; includes the Earth image)
│   └── vendor/             three.js r128 and satellite.js 6.0.2, with their MIT licences
├── src/                    page source: edit these, then run npm run build:page
│   ├── template.html       layout and styles
│   ├── app.js              app logic
│   └── earth.datauri       Earth texture, embedded into the page
├── tools/
│   ├── build-page.mjs      builds public/index.html from src/
│   └── fetch-celestrak.mjs optional: saves a static copy for hosts without a server
└── test/
    ├── server.test.mjs     server tests against a stand-in for CelesTrak (no real downloads)
    └── build.test.mjs      checks the built page, libraries and group lists are consistent
```

## Run it on Windows

### 1. Install Node.js (once)

Install the **LTS** version from <https://nodejs.org>, using the Windows Installer (.msi) with the default
options. Or, in PowerShell:

```powershell
winget install OpenJS.NodeJS.LTS
```

Close and reopen PowerShell, then check the version. It must be 20 or higher.

```powershell
node --version
npm --version
```

### 2. Unzip and open the folder

Right-click the ZIP and choose **Extract All…**. Or, in PowerShell, from the folder holding the ZIP:

```powershell
Expand-Archive .\orbitwatch-deploy.zip -DestinationPath .
cd .\orbitwatch
```

### 3. Test, build and start

There is nothing to install: `npm install` is not needed, though running it is harmless.

```powershell
npm test               # 14 tests; should end with "pass 14" and "fail 0"
npm run build:page     # rebuilds public\index.html from src\ (only needed after editing src\)
npm start              # starts the server
```

Then open <http://localhost:8080> in Edge or Chrome. Press **Ctrl+C** in PowerShell to stop the server.

What to expect when you start it:

- **Windows Defender Firewall may ask** whether Node.js can use networks, because the server listens on all
  network interfaces (`0.0.0.0`). Choose **Allow** to let other devices on your network open it. Choose
  **Cancel** to use it only on this computer; `http://localhost:8080` still works.
- **The badge should read `LIVE · CelesTrak · updated HH:MM UTC`**, if your network can reach celestrak.org.
- **If it reads `DEMO DATA`**, the status line under the time controls says why, for example that CelesTrak
  could not be reached from your network.

Check the server directly:

```powershell
curl.exe http://localhost:8080/api/health
curl.exe "http://localhost:8080/api/gp?group=stations"
```

### If something goes wrong

| Problem | Fix |
|---|---|
| `npm : File C:\Program Files\nodejs\npm.ps1 cannot be loaded because running scripts is disabled` | Use Command Prompt (`cmd`) instead of PowerShell, or type `npm.cmd` instead of `npm`, or run `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` once. |
| `Port 8080 is already in use` | PowerShell: `$env:PORT=3000; npm start`. Command Prompt: `set PORT=3000 && npm start`. Then open http://localhost:3000 |
| `'node' is not recognized` | Reopen the terminal after installing Node.js, or restart Windows. |
| `npm test` fails with "public/index.html differs from a fresh build" | You edited `src\`. Run `npm run build:page`, then `npm test` again. |
| Badge shows STALE or DEMO | Open http://localhost:8080/api/health and read `lastError` for each group. |

## Deploy on DigitalOcean App Platform

This needs a DigitalOcean account and a GitHub account. The smallest web service costs $5/month, as of
October 2026. Static sites are free, but a static site cannot run the server, so it would only ever show demo data.

### 1. Put the project on GitHub

**Option A: GitHub Desktop** (<https://desktop.github.com>).

1. Choose **File → Add local repository…** and pick the `orbitwatch` folder.
2. When it says the folder is not a repository, click **create a repository** and keep the defaults.
3. Click **Publish repository**. Public or private both work.

**Option B: Git for Windows** (<https://git-scm.com>), in PowerShell inside the `orbitwatch` folder.

First create an empty repository named `orbitwatch` on github.com, with no README, licence or .gitignore. Then:

```powershell
git init -b main
git add -A
git commit -m "OrbitWatch"
git remote add origin https://github.com/YOUR-GITHUB-USERNAME/orbitwatch.git
git push -u origin main
```

`package.json` must be at the top level of the repository, not inside a subfolder.

### 2. Create the app

1. In the DigitalOcean control panel, choose **Create → App Platform**.
2. Choose **GitHub** as the source, and authorise DigitalOcean if asked. Pick your `orbitwatch` repository
   and the `main` branch. Leave **Source directory** as `/` and keep **Autodeploy** on.
3. DigitalOcean detects a Node.js **Web Service**. Open its settings and check that they match:
   - **Build command:** leave empty. `public/index.html` is already built and committed.
   - **Run command:** `npm start`
   - **HTTP port:** `8080`
   - **Health check:** HTTP, path `/api/health`
   - **Instance size:** the smallest shared CPU size (`apps-s-1vcpu-0.5gb`, 512 MB, $5/month)
   - **Containers:** 1. Do not scale up. Each container downloads from CelesTrak on its own and keeps its own
     cache, and CelesTrak allows one download per IP per update.
   - **Environment variables:** none needed.
4. Pick a region, then click **Create Resources**. The first deploy takes a few minutes.

Instead of steps 1 to 4, you can use the `doctl` command-line tool: edit `github.repo` in `.do/app.yaml`, then
run `doctl apps create --spec .do/app.yaml`.

### 3. Check that it works

When the deploy shows **Deployed**, open the app's `https://….ondigitalocean.app` link and check:

1. **The page loads** and the badge reads `LIVE · CelesTrak · updated HH:MM UTC`.
2. **`/api/health`** shows a `fetchedAt` time for every group. A group shows `null` until someone first loads
   the page.
3. **`/api/gp?group=stations`** returns JSON with `"count"` above 0 and real station names in `rows`.

A successful local run does not prove the cloud deploy works. Check these three things on the real URL.

### If the deployed badge says STALE or DEMO

Open `/api/health` and read `lastError`:

- **`CelesTrak refused the request (HTTP 403)`.** CelesTrak's data had not changed since the last download from
  the same IP address. App Platform apps can share outgoing IP addresses, so another app may have caused this.
  The server waits 2 hours, then tries again. If it keeps happening, add a **dedicated egress IP** in the app's
  settings (billed per second, up to $25/month).
- **`Could not connect` or `did not answer`.** CelesTrak or the network is down. The server tries again
  after 30 minutes.
- **The server's cache is in memory and in the `.cache/` folder.** Both are lost whenever the app redeploys or
  restarts. The next visit downloads again.

## Hosting without a server

Static hosts such as GitHub Pages, DigitalOcean static sites and Claude artifacts cannot run `server/server.mjs`,
so `/api/gp` does not exist there. The page notices this and shows clearly labelled demo data.

To show real but dated data on a static host:

1. On a computer that can reach CelesTrak, run `npm run fetch-data`. It saves `public/data/celestrak.json`.
2. Upload the `public/` folder.

The badge then reads `SERVER COPY` for 3 hours and `STALE` after that. Run the command again to refresh the data.
It will not download more than once every 2 hours.

## Server settings

All settings are optional environment variables.

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `8080` | Port to listen on. App Platform sets this. |
| `HOST` | `0.0.0.0` | Interface to listen on |
| `REFRESH_MS` | `7200000` (2 h) | Minimum time between downloads of a group |
| `STALE_MS` | `10800000` (3 h) | After this, responses are marked `stale: true` |
| `RETRY_MS` | `1800000` (30 min) | Wait after a failed download |
| `TIMEOUT_MS` | `20000` | Timeout for each CelesTrak request |
| `WAIT_MS` | `8000` | How long a visitor waits for a refresh before getting the cached copy |
| `CACHE_DIR` | `.cache` | Where downloaded data is kept |
| `PUBLIC_DIR` | `public` | Folder served as the website |
| `CELESTRAK_URL` | CelesTrak GP endpoint | Used by the tests to point at a stand-in |

## API

| Request | Response |
|---|---|
| `GET /api/gp?group=stations` | `200` with `{group, fetchedAt, count, skipped, stale, lastError, lastAttemptAt, refreshMinutes, fields, rows}`. `fetchedAt` is when this server downloaded the data, in ms since 1970 UTC. `rows` are arrays in the order of `fields`. |
| | `400` for a group not in the list. `503` with `{error, retryAfterSeconds}` and a `Retry-After` header when there is no data yet. |
| `GET /api/health` | `200` with each group's `fetchedAt`, `count`, `lastAttemptAt`, `lastError` and `nextAttemptAt` |

## Credits and licences

- **Orbital data:** [CelesTrak](https://celestrak.org) GP data (Dr T.S. Kelso). Please keep this credit.
- **three.js r128:** MIT licence, in `public/vendor/three.LICENSE.txt`. Byte-identical to npm `three@0.128.0`.
- **satellite.js 6.0.2:** MIT licence, in `public/vendor/satellite.js.LICENSE.txt`. Byte-identical to npm
  `satellite.js@6.0.2`.
- **IBM Plex fonts:** SIL Open Font License, loaded from Google Fonts.
- **Earth texture (`src/earth.datauri`):** came with the original prototype, and its source is unknown. It
  looks like NASA Blue Marble imagery, which is public domain, but this is not confirmed. Credit it or
  replace it before judging.
