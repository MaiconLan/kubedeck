# KubeDeck

Painel local e visual para Kubernetes — uma alternativa ao k9s que roda no navegador.
Por baixo ele executa `kubectl` e `helm` da sua máquina, então funciona com qualquer cluster
que já funciona no seu terminal (k3d, k3s, AKS com `az login`, EKS, GKE…).

## Instalação

Requisitos: Node 20+, `kubectl` e (opcional) `helm` no PATH.

```bash
npm install
npm run build
npm link          # deixa o comando "kubedeck" disponível em qualquer terminal
```

## Uso

```bash
kubedeck
```

Abre o navegador em `http://127.0.0.1:<porta>/?t=<token>`. Opções: `--port 7420`, `--no-open`.

O servidor escuta só em `127.0.0.1` e exige o token da URL em toda chamada.
Nada é salvo além das preferências em `~/.kubedeck/settings.json`.

### Atalhos

| Tecla | Ação |
|---|---|
| `:` ou `Ctrl+K` | Ir para recurso, contexto ou namespace (`po`, `deploy`, `hr`, `ks`, `ctx nome`, `ns nome`) |
| `/` | Filtrar a tabela (aceita várias palavras e labels `app=api`) |
| `Esc` | Fechar painel |

### O que tem

- Contextos do kubeconfig (sem alterar o `current-context`) e namespaces.
- Workloads, rede (incluindo IngressRoutes do Traefik), config, storage, Flux, releases Helm e qualquer CRD.
- Painel de detalhes: visão geral, logs ao vivo (pod ou deployment inteiro), describe, YAML, eventos, secrets decodificados.
- Ações do dia a dia: reiniciar, escalar, apagar pod, reconciliar/suspender/retomar objetos do Flux.
- Cada ação mostra o comando exato antes de rodar; o ícone de terminal lista tudo que foi executado.

### Cluster do trabalho (AKS)

1. `az login` no terminal.
2. Se o cluster ainda não está no kubeconfig, clique no **+** ao lado do contexto (ou `:` → "Adicionar cluster AKS").
   Informe account, resource group, nome do cluster e, se quiser, um namespace padrão — ou use **Buscar clusters**
   para escolher da lista. O KubeDeck executa:
   ```
   az account set --subscription <account>
   az aks get-credentials --resource-group <rg> --name <cluster> --context <contexto> --overwrite-existing
   kubelogin convert-kubeconfig -l azurecli --context <contexto>      # opcional
   kubectl config set-context <contexto> --namespace <namespace>      # se informado
   ```
3. Escolha o contexto.
3. Clique no cadeado ao lado do contexto para **protegê-lo**: toda ação passa a exigir que você digite o nome do recurso, e aparece uma faixa vermelha no topo.

Se o token do Azure expirar, aparece um aviso pedindo `az login`; depois é só clicar em **Tentar de novo**.
Se seu usuário não pode listar namespaces, o seletor vira um campo de texto e lembra os que você digitou.

## Desenvolvimento

Em dois terminais:

```bash
npm run dev:server   # API em 127.0.0.1:7420 (token "dev")
npm run dev:web      # Vite em http://localhost:5173/?t=dev
```

Estrutura: `server/` (Node sem dependências, executa kubectl/helm) e `web/` (React + Vite).
