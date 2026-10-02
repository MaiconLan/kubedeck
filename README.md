# KubeDeck

A local, visual Kubernetes dashboard — a k9s alternative with tabs and split panes, as a desktop app or in your browser.
Under the hood it runs the `kubectl` and `helm` on your machine, so it works with any cluster
that already works in your terminal (k3d, k3s, AKS with `az login`, EKS, GKE…).

## Installation

Requirements: Node 20+, `kubectl` and (optionally) `helm` in PATH. For AKS: the Azure CLI (`az`)
and, for Entra ID clusters, `kubelogin`.

```bash
npm install
```

**Desktop app (recommended):**

```bash
npm run desktop       # build and open the app
npm run dist:win      # build a Windows installer and a portable .exe into release/
```

Launching KubeDeck again opens another window of the same app.

**Browser mode** (the `kubedeck` command):

```bash
npm run build
npm link          # makes the "kubedeck" command available in any terminal
```

After code changes, run `npm run build` again and restart `kubedeck`.

### Troubleshooting: "kubedeck is not recognized as the name of a cmdlet…" (Windows)

`npm link` creates `kubedeck`, `kubedeck.cmd` and `kubedeck.ps1` in npm's global folder. If that folder is
not in your `PATH`, PowerShell can't find them. Check:

```powershell
Get-ChildItem (npm prefix -g) -Filter "kubedeck*"                    # the 3 files should be listed
$env:PATH -split ';' | Select-String -SimpleMatch (npm prefix -g)   # prints nothing = folder not in PATH
```

Add the folder to your user `PATH` (no admin rights needed):

```powershell
[Environment]::SetEnvironmentVariable('Path', [Environment]::GetEnvironmentVariable('Path','User') + ';' + (npm prefix -g), 'User')
```

Then **close every terminal and open a new one** (including VS Code terminals). Open terminals keep the old `PATH`.

If your `PATH` gets reset at login (some environments enforce it), add it in your PowerShell profile instead
(create the profile first with `New-Item -ItemType File -Force $PROFILE` if it doesn't exist):

```powershell
Add-Content $PROFILE "`n`$env:PATH += ';' + (npm prefix -g)"
```

Other cases:

- **The 3 files are missing:** `npm link` failed, often with `EPERM`/`EACCES` when npm's folder is under
  `C:\Program Files`. Run `npm config set prefix "$env:APPDATA\npm"` and `npm link` again.
- **"running scripts is disabled on this system":** execution policy blocks the `.ps1` wrapper. Use `kubedeck.cmd` instead.
- **No global command at all:** `npm start` from the project folder, or `node <path-to-kubedeck>\bin\kubedeck.js`.

## Usage

```bash
kubedeck
```

Opens the browser at `http://127.0.0.1:<port>/?t=<token>`. Options: `--port 7420`, `--no-open`.

The server only listens on `127.0.0.1` and requires the token from the URL on every call.
Nothing is stored except preferences in `~/.kubedeck/settings.json`.

### Shortcuts

| Key | Action |
|---|---|
| `:` or `Ctrl+K` | Go to a resource, context or namespace (`po`, `deploy`, `hr`, `ks`, `ctx name`, `ns name`) |
| `/` | Filter the table (several words, labels such as `app=api`) |
| `Esc` | Close the panel |
| `g` then `d` / `p` / `y` / `s` … | Go to dashboard / pods / deployments / services … |
| `g` then `f` / `l` | Port-forwards / executed commands panel |
| `?` | All shortcuts |
| `Ctrl+T` / `Ctrl+W` / `Ctrl+Tab` | New / close / next tab (desktop app; `g t` / `g w` in the browser) |
| `Ctrl+\` / `Ctrl+N` | Split right / open the tab in a new window (desktop app) |

### Features

- **Dashboard** (home screen): node and pod health, cluster CPU/memory usage against allocatable capacity and
  requests, per-node usage, top pods by CPU and memory, a "needs attention" list and recent warnings.
  Usage numbers need `metrics-server` (bundled with k3s and AKS); without it the dashboard shows requests only.
- **Diagnosis** ("why isn't this pod running?"): for unhealthy pods, Deployments, StatefulSets, DaemonSets,
  ReplicaSets and Jobs, the Overview tab explains the likely cause (out of memory, image not found or not allowed,
  missing Secret/ConfigMap/key, no node with free resources, taints, failing probes, volume or PVC problems,
  namespace quota, admission webhooks, stuck rollouts, failed jobs…), shows the evidence it is based on and what
  to do. It is rule-based: no AI, nothing leaves your machine. The dashboard shows the short version.
- **Port-forward** from pods, services, deployments and statefulsets, with a panel to open, copy or stop
  active forwards. Forwards stop when KubeDeck exits.
- **Navigation**: browser back/forward and bookmarkable URLs, related resources in the detail panel
  (a deployment's pods, a pod's node, ConfigMaps/Secrets/PVCs it uses…), recent items in quick navigation,
  and `g` + key shortcuts (press `?` for the list).
- **Tabs and split panes**: each tab has its own context, namespace, screen, filter and back/forward history.
  Ctrl+click or middle-click a row (or use the button in the detail panel) to open a resource in its own tab,
  where its logs keep streaming in the background. Split the window into up to 3 panes, drag tabs between
  them, or open a tab in a new window. Open tabs are restored on the next start.
- kubeconfig contexts (without touching your `current-context`) and namespaces.
- Workloads, network (including Traefik IngressRoutes), config, storage, Flux, Helm releases and any CRD.
- Detail panel: overview, live logs (a pod or a whole deployment), describe, YAML, events, decoded secrets.
- Day-to-day actions: restart, scale, delete pod, reconcile/suspend/resume Flux objects.
- Every action shows the exact command before running; the terminal icon lists everything that was run.
- UI in English or Portuguese (language picker in the top bar).

### AKS clusters

1. `az login` in a terminal.
2. If the cluster is not in your kubeconfig yet, click **+** next to the context picker (or `:` → "Add AKS cluster").
   Enter account, resource group, cluster name and optionally a default namespace — or use **Find clusters**
   to pick from a list. KubeDeck runs:
   ```
   az account set --subscription <account>
   az aks get-credentials --resource-group <rg> --name <cluster> --context <context> --overwrite-existing
   kubelogin convert-kubeconfig -l azurecli --context <context>      # optional
   kubectl config set-context <context> --namespace <namespace>      # if given
   ```
3. Pick the context. Click the lock next to it to **protect** it: every action then requires typing the
   resource name, and a red stripe shows at the top.

If the Azure token expires, a banner asks you to run `az login`; then click **Retry**.
If your user cannot list namespaces, the namespace picker becomes a text field that remembers what you typed.

## Development

In two terminals:

```bash
npm run dev:server   # API on 127.0.0.1:7420 (token "dev")
npm run dev:web      # Vite on http://localhost:5173/?t=dev
```

Open `http://localhost:5173/?t=dev` in a browser, or run `npm run dev:desktop` in a third terminal to get the
desktop window on top of the same dev servers.

Layout: `server/` (dependency-free Node, runs kubectl/helm/az), `web/` (React + Vite) and `desktop/`
(Electron shell that starts the same server in-process and opens app windows).

Unreleased features are switched off in `FEATURES` (`web/src/catalog.ts`); the relationship map is currently off.
Fonts (Geist / Geist Mono) are bundled from `@fontsource`, so the app works offline. The app icon is
`build/icon.png`; electron-builder generates the Windows `.ico` from it.

### Translations

UI strings live in `web/src/i18n/`. `en.ts` is the source dictionary; every other language file is typed
against it, so a missing key fails the build. To add a language, create a file like `pt-BR.ts`, register it
in `DICTIONARIES` and `LANGUAGES` in `web/src/i18n/index.ts`, and add its id to `Settings.language` in
`server/settings.ts`.

Server errors carry a `code` (e.g. `azureLogin`, `forbidden`) plus an English `message`; the UI shows
`error.<code>` from the dictionary and falls back to the English message. Raw tool output is never translated.
