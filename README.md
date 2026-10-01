# KubeDeck

A local, visual Kubernetes dashboard — a k9s alternative that runs in your browser.
Under the hood it runs the `kubectl` and `helm` on your machine, so it works with any cluster
that already works in your terminal (k3d, k3s, AKS with `az login`, EKS, GKE…).

## Installation

Requirements: Node 20+, `kubectl` and (optionally) `helm` in PATH. For AKS: the Azure CLI (`az`)
and, for Entra ID clusters, `kubelogin`.

```bash
npm install
npm run build
npm link          # makes the "kubedeck" command available in any terminal
```

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

If a managed/company laptop resets your `PATH` at login, add it in your PowerShell profile instead
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

### Features

- kubeconfig contexts (without touching your `current-context`) and namespaces.
- Workloads, network (including Traefik IngressRoutes), config, storage, Flux, Helm releases and any CRD.
- Detail panel: overview, live logs (a pod or a whole deployment), describe, YAML, events, decoded secrets.
- Day-to-day actions: restart, scale, delete pod, reconcile/suspend/resume Flux objects.
- Every action shows the exact command before running; the terminal icon lists everything that was run.
- UI in English or Portuguese (language picker in the top bar).

### Work cluster (AKS)

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

Layout: `server/` (dependency-free Node, runs kubectl/helm/az) and `web/` (React + Vite).

### Translations

UI strings live in `web/src/i18n/`. `en.ts` is the source dictionary; every other language file is typed
against it, so a missing key fails the build. To add a language, create a file like `pt-BR.ts`, register it
in `DICTIONARIES` and `LANGUAGES` in `web/src/i18n/index.ts`, and add its id to `Settings.language` in
`server/settings.ts`.

Server errors carry a `code` (e.g. `azureLogin`, `forbidden`) plus an English `message`; the UI shows
`error.<code>` from the dictionary and falls back to the English message. Raw tool output is never translated.
