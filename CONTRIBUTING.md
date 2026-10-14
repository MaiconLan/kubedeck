# Contributing to KubeDeck

Thanks for helping! Bug reports, ideas, translations and pull requests are all welcome.

## Getting started

Requirements: Node 20+. `kubectl` is only needed to try against a real cluster.

```bash
npm install
npm run dev:demo     # API in demo mode on 127.0.0.1:7420 (fake cluster, no kubectl needed)
npm run dev:web      # UI with hot reload on http://localhost:5173/?t=dev
```

Use `npm run dev:server` instead of `dev:demo` to work against your real kubeconfig, and
`npm run dev:desktop` (in a third terminal) to see the same UI inside the desktop window.

## Submitting changes

You don't need write access to this repository. Contributions come in through a fork:

1. **Fork** the repository with the "Fork" button at the top right of the GitHub page.
2. **Clone your fork** and create a branch from `main`, e.g. `git switch -c fix/pod-logs`.
3. Make your changes and push the branch **to your fork**.
4. Open a **pull request** from your branch to `main` of this repository.

Rules of the road:

- `main` is protected: nobody pushes to it directly, every change goes through a pull request.
- A pull request can only be merged after approval from the maintainer, and the maintainer does the merge
  (squash). If a review leaves comments, resolve them and push again; new pushes require a fresh approval.
- Pushing branches directly to this repository requires write access, which is limited to the maintainer.
  If you hit a permission error on `git push`, you are probably pushing to the original repository instead
  of your fork.
- For larger changes, open an [issue](../../issues) first so we can agree on the approach.

Before opening a pull request:

```bash
npm run typecheck
npm run build
```

## Project layout

| Path | What lives there |
|---|---|
| `server/` | Dependency-free Node server. Runs `kubectl`/`helm`/`az`, validates input, streams logs. |
| `server/demo.ts` | The fake cluster used by `--demo`, development and the README media. |
| `web/src/` | React UI (Vite). `catalog.ts` defines resource kinds and table columns. |
| `web/src/diagnosis.ts` | Rule-based "why isn't this pod running?" explanations. |
| `web/src/i18n/` | Translations. `en.ts` is the source; other languages are type-checked against it. |
| `desktop/` | Electron shell: starts the server in-process and opens windows. |
| `scripts/record-media.mjs` | Records the screenshots and GIFs in `docs/media/`. |

## Guidelines

- **Code, comments and docs in English.** User-facing text always goes through `t('key')` and must be
  added to every file in `web/src/i18n/` (the build fails if a key is missing).
- **Keep it local and safe.** No telemetry, no remote calls, no shell strings. New write actions must be
  allow-listed in `server/actions.ts`, show the exact command and respect protected contexts.
- **Keep the server dependency-free** unless there is a strong reason.
- **Neutral examples.** Use fictional names (`my-cluster`, `example.com`) in code, docs and demo data.

### Adding a diagnosis rule

1. Make sure the facts you need are collected in `server/diagnose.ts` (pod, events, previous logs,
   missing references, PVCs).
2. Add the rule in `web/src/diagnosis.ts`: return a `Diagnosis` with message keys, the raw evidence and
   a fix. Prefer matching structured fields (reasons, exit codes) over free text.
3. Add the messages to every language file.
4. Reproduce it in `server/demo.ts` if possible, so others can see it with `--demo`.

### Adding a language

Create `web/src/i18n/<code>.ts` typed as `Messages`, register it in `web/src/i18n/index.ts`
(`DICTIONARIES` and `LANGUAGES`) and allow the code in `server/settings.ts`.

### Updating the README media

```bash
npx playwright install chromium   # once
npm run media                     # all scenes
node scripts/record-media.mjs logs  # one scene
```

## Releases

Pushing a tag like `v0.2.0` runs `.github/workflows/release.yml`, which builds installers for Windows,
macOS and Linux and attaches them to a draft GitHub release.
