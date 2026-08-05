# Stack de infraestrutura de referência (spec §3.5)

A spec original (`docs/gtm-intelligence-platform.md`) pede Kafka, Postgres+
PostGIS, ClickHouse, Redis (Feast online store), MLflow e Dagster — a
plataforma inteira roda hoje em SQLite+FastAPI (decisão documentada em
todo módulo: zero dependência pesada, cabe em free tier). Isto aqui é a
peça que faltava para "a spec inteira": infraestrutura real, não simulada.

## O que foi validado nesta sessão, e como

Todos os 6 serviços foram **subidos de verdade neste ambiente** (Docker
Desktop, `docker compose up`) e testados com uma operação REAL em cada um
— não só `healthcheck`:

| Serviço | Validação real feita |
|---|---|
| Kafka (KRaft, sem Zookeeper) | Criou o tópico `signal.sales.priority_adjustment`, publicou uma mensagem e leu de volta via `kafka-console-consumer` |
| PostgreSQL + PostGIS | `CREATE EXTENSION postgis`, `SELECT ST_AsText(ST_MakePoint(...))` — geometria real calculada |
| ClickHouse | Criou tabela `MergeTree`, inseriu linha, `SELECT count()` |
| Redis | `SET`/`GET` real |
| MLflow (tracking server) | Criou experimento via API REST, listou de volta — persistiu em SQLite próprio |
| Dagster (webserver) | GraphQL respondeu com o asset de exemplo (`dagster_defs.py`) carregado |

Dois problemas reais apareceram e foram corrigidos durante essa validação
(não hipotéticos — aconteceram rodando):
- **MLflow/Dagster sem `curl`** na imagem `python:slim` — o healthcheck do
  compose falhava silenciosamente (`starting` para sempre) porque o
  comando não existia dentro do container, não porque o serviço estivesse
  fora do ar. Corrigido instalando `curl` nas duas imagens.
- **Porta 5000 reservada pelo Windows** (bind recusado por permissão, PID
  4/`System`) — MLflow foi remapeado para `5050:5000` no host.

## Como subir

```bash
cd infra_stack
docker compose up -d
docker compose ps   # espera todos ficarem "healthy"
```

- Kafka: `localhost:9092`
- Postgres+PostGIS: `localhost:5432` (usuário `vendalytics`)
- ClickHouse: `localhost:8123` (HTTP) / `9000` (nativo)
- Redis: `localhost:6379`
- MLflow: http://localhost:5050
- Dagster: http://localhost:3001

```bash
docker compose down -v   # remove containers E volumes — reset limpo
```

## O que NÃO foi validado, e por quê

- **Kubernetes** (`k8s/vendalytics-app.yaml`): `kubectl` está disponível
  neste ambiente, mas não há cluster local (`kind`/`minikube` não
  instalados) — mesmo `--dry-run=client` do kubectl exige falar com um
  API server para validar schema. O manifesto foi conferido como YAML
  válido (`yaml.safe_load`) e a estrutura (Deployment+Service+ConfigMap)
  está correta por construção, mas **nunca rodou contra um cluster de
  verdade**. Aplicar isso pela primeira vez num cluster real exige revisão.
- **Terraform/Helm/ArgoCD**: não escritos nesta sessão — dependem de qual
  provedor de nuvem o cliente usa (AWS/GCP/Azure), decisão que não é minha
  para tomar sem o cliente. O padrão de todo o resto deste repositório
  (conectores de CRM, mídia, IBGE) é o mesmo: não construir contra uma
  decisão de provedor que ainda não foi tomada.
- **Conexão do código Python a este stack**: `infra/reactor.py` e
  `infra/scores.py::emitir_sinal` continuam publicando no SQLite local, não
  neste Kafka. Documentado desde a Fase 5: trocar o transporte é mudar o
  corpo de UMA função, não a arquitetura — feito quando fizer sentido subir
  este stack em produção de verdade, não antes.
