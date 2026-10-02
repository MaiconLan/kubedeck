# Security policy

## Reporting a vulnerability

Please **do not open a public issue** for security problems. Use GitHub's
[private vulnerability reporting](../../security/advisories/new) for this repository instead.
Include what you found, how to reproduce it and which version you used. You can expect a first
answer within a few days.

## Security model

KubeDeck is designed to add no new attack surface to your clusters:

- **Nothing is installed in your cluster.** KubeDeck runs the `kubectl`, `helm` and `az` binaries on
  your machine, with your kubeconfig and your existing permissions. It can never do more than you can.
- **Local only.** The UI talks to a small server bound to `127.0.0.1`. Every API call needs a random
  token generated at startup, and requests with a non-loopback `Host` header are rejected (DNS
  rebinding protection).
- **No shell.** Commands are started with argument arrays, never through a shell. The only exception
  is the Azure CLI on Windows (it is a `.cmd` file); there every argument is validated and quoted.
- **Allow-listed writes.** The only changes KubeDeck can make are: restart, scale, delete pod, and
  Flux reconcile/suspend/resume, plus adding an AKS context to your kubeconfig. Each one shows the exact
  command before it runs, and protected contexts require typing the resource name.
- **Secrets stay on screen.** Secret values are fetched only when you open a Secret's Values tab, are
  never cached and are masked until you reveal them. The diagnosis feature never reads environment
  variable values.
- **No telemetry.** KubeDeck makes no network requests of its own. Fonts and assets are bundled.
- **Stored data:** only UI preferences in `~/.kubedeck/settings.json`.

## Supported versions

Security fixes go into the latest release.
