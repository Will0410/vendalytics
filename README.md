# Vendalytics

Plataforma de inteligência comercial para distribuidoras: mapa de clientes,
métricas de carteira e (nas próximas fases) prospecção territorial, gap de
mix/cross-sell, recompra preditiva e CRM de WhatsApp com IA.

A identidade de cada instalação (nome, cores, filiais, segmentação de
mercado) vive em `config/tenant_config.yaml` — o código nunca menciona uma
empresa específica. A fonte de dados é plugável (`DataSourceAdapter`); vem
com uma implementação de referência em SQLite que já roda sem nenhuma
dependência externa, populável tanto por dado sintético de demonstração
quanto pelo CSV real de um cliente.

## Setup local

```bash
cd backend
python -m venv .venv
.venv/Scripts/activate   # Windows: .venv\Scripts\Activate.ps1
pip install -r requirements.txt
cd ..
cp .env.example .env
python -c "import secrets; print(secrets.token_hex(32))"   # cole o resultado em JWT_SECRET no .env
cp config/tenant_config.example.yaml config/tenant_config.yaml   # ajuste nome/cores/filiais

python -m demo_data.seed        # gera ~1000 clientes fictícios
cd backend
python -m uvicorn vendalytics.main:app --reload --port 8901
```

Abra `http://localhost:8901/login.html`. Na primeira subida, um usuário
admin é criado automaticamente — o e-mail vem de `tenant_config.yaml`
(`empresa.admin_email`) e a senha é gerada aleatoriamente e impressa **uma
única vez** no log do servidor.

## Estrutura

- `backend/vendalytics/adapters/` — contrato `DataSourceAdapter` + implementação de referência (`sqlite_reference.py`)
- `backend/vendalytics/data_layer.py` — fachada única que os módulos de negócio chamam (nunca importam um adapter concreto)
- `backend/vendalytics/infra/` — fundação transversal: escopo de acesso, migrations, auditoria, observabilidade
- `backend/vendalytics/tenant.py` — carrega `config/tenant_config.yaml`
- `demo_data/seed.py` — dado sintético de demonstração (Faker, nunca dado real)
- `frontend/` — HTML/JS simples, branding aplicado em runtime via `/api/tenant/branding`

## Fundação: escopo de acesso, auditoria e migrations

A arquitetura-alvo está em [docs/gtm-intelligence-platform.md](docs/gtm-intelligence-platform.md).
A Fase 0 dela já está implementada aqui:

**Escopo de acesso (RBAC + ABAC).** Cada usuário tem um papel (`role`) e um
conjunto de filiais (`filiais`, vazio = irrestrito). O escopo é montado a
partir do JWT por um middleware ASGI e viaja por contextvar; `data_layer` é
o único ponto que o traduz em filtro de dado. Ler dado sem escopo ativo
levanta `EscopoAusente` — o caminho do esquecimento quebra em teste em vez
de vazar em produção. Pedir uma filial fora do escopo é 403, nunca uma
redução silenciosa do resultado.

**Trilha de auditoria.** Tabela `auditoria` no banco operacional, append-only
imposto por trigger do SQLite (nem a aplicação reescreve). Registra login,
acessos negados e consultas à própria trilha. Admin lê via `GET /api/auditoria`.

**Migrations versionadas.** `backend/vendalytics/infra/db.py` — aplicadas no
startup, idempotentes, com a versão visível em `GET /api/health`. Nunca edite
uma migration já publicada; adicione a próxima.

**Observabilidade.** `X-Request-Id` em toda resposta, log estruturado em JSON
com o mesmo id (correlaciona log ↔ trilha ↔ resposta) e latência p50/p95 por
rota em `GET /api/metrics/runtime` (admin).

## Fase 1: integração de CRM e comitê de compras

**Conector de CRM** (`integracoes/`) — mesmo padrão do `DataSourceAdapter`:
contrato em `base.py` (`CRMConnector`), implementação de referência em
`csv_connector.py` que funciona de verdade hoje. Não há conector
Salesforce/HubSpot real: um conector OAuth "pronto" que nunca rodou contra a
API de verdade passaria confiança sem lastro. O que é testável sem
credenciais de provedor — reconciliação por CNPJ, idempotência, write-back —
está implementado e testado; o adapter Salesforce/HubSpot entra depois, sobre
o mesmo contrato, quando houver conta de teste para validar contra a API real.

- `POST /api/crm/importar-csv` — upsert idempotente por CNPJ; reimportar o
  mesmo arquivo não duplica, atualiza o estágio da mesma oportunidade. CNPJ
  inválido é descartado, nunca adivinhado.
- `POST /api/crm/exportar-recomendacoes` — write-back: pega a fila
  priorizada atual e escreve score + fatores de volta (staging versionado
  hoje, chamada de API amanhã — o resto do sistema não muda).

**Comitê de compras** (`modules/comite.py`, spec A5) — múltiplos contatos por
conta com papel (decisor econômico, usuário, influenciador, gatekeeper,
campeão) e **score de completude** com pesos explícitos: decisor econômico e
campeão pesam mais que os demais, porque a ausência deles é o risco real —
"venda complexa com um único contato mapeado é risco a mais que uma
recompra de propensão alta não compensa".

## Fase 1: resolução de entidade

`modules/identidade.py` — atribui um `account_id` **canônico e estável** a
cada cliente (spec §3.1/§4.3: "peça crítica, subestimada em quase todo
projeto assim"). Sem isso a mesma empresa aparece várias vezes na fila e o
usuário para de confiar na tela.

Estratégia em duas camadas:
1. **Raiz do CNPJ** (determinística) — matriz e filial compartilham os 8
   primeiros dígitos por lei; cobre a maioria dos casos sem depender de
   nenhum estado guardado.
2. **Curadoria humana** para o resto — Jaro-Winkler + telefone/e-mail/CEP
   levantam candidatos a duplicata **com evidências**, mas o sistema nunca
   funde sozinho: `GET /api/identidade/duplicatas` lista, `POST
   /api/identidade/decidir` registra a decisão. Fusão errada é muito mais
   cara de desfazer do que de evitar.

O requisito de verdade não é precisão do match, é **estabilidade**: rodar a
resolução duas vezes sobre o mesmo cadastro precisa produzir exatamente os
mesmos ids, senão score/sinal/desfecho históricos apontam para uma conta que
não existe mais. `GET /api/identidade/qualidade` publica o quanto da
carteira ficou sem documento válido (o principal limitador real).

## Fase 1: propensão explicável e fila priorizada

**Modelo de propensão de recompra** (`modules/propensao.py`) — regressão
logística treinada no próprio histórico, com **validação out-of-time** (nunca
k-fold aleatório: o modelo vai ser usado no futuro, então é medido no futuro)
e métricas publicadas junto da fila: AUC, ECE (calibração) e lift do top decil.

Escolha de modelo consciente: a spec pede LightGBM/XGBoost. Aqui é logística
porque (a) o projeto roda sem numpy/sklearn e um modelo de 300MB de wheels
mudaria o perfil de deploy inteiro, e (b) para modelo linear a contribuição
`coef·(x−E[x])` **é** o valor SHAP — forma fechada, sem aproximação. Trocar
por GBM+SHAP depois muda `_treinar`/`_contribuicoes` e nada mais.

**Fila priorizada** (`modules/fila.py`) — ordenada por **valor esperado**
(`probabilidade × ticket`), não por score bruto, e **finita** (12 contas no
dia, não 4.000 no ranking). Cada item traz os fatores em linguagem de
negócio, nunca o nome da variável.

**Loop fechado** — `POST /api/fila/desfecho/{id}` com
`aceita|recusada|ganhou|perdeu|ignorada`. Grava o desfecho, emite o sinal e
invalida o modelo em cache. `GET /api/fila/saude-do-loop` reporta a cobertura
de loop fechado, que é a métrica que faz todas as outras melhorarem sozinhas.

**Distribuição de carteiras** (`modules/territorio.py`) — reparte clientes
entre vendedores equilibrando **potencial**, não headcount (dividir 80
clientes em 4 grupos de 20 é inútil quando 8 deles valem 90% da receita),
com penalidade geográfica e bônus de continuidade de relacionamento. Heurística
gulosa e explicável, não ótimo global: o gestor precisa entender e ajustar a
proposta. `GET /api/territorio/simular-carteiras?vendedores_extra=N` responde
"e se eu contratar mais N?" — e **nunca aplica**, só simula.

Score, fator, sinal e desfecho vivem em tabelas **append-only** (trigger no
banco): nunca `UPDATE scores SET valor=...`, sempre uma versão nova — é o que
permite responder "por que este score mudou desde ontem?".

### Testes

```bash
pip install -r backend/requirements-dev.txt
python -m pytest tests -q
```

`tests/test_isolamento_escopo.py` é a trava: ele descobre as funções de
`data_layer` **por reflexão** e reprova qualquer função de leitura nova que
não passe pelo escopo — sem que ninguém precise lembrar de atualizar o teste.

## Fases 2-5: Geo, Reputation, Field e o barramento de sinais

A arquitetura-alvo está em [docs/gtm-intelligence-platform.md](docs/gtm-intelligence-platform.md).
Estas fases foram implementadas como **MVP honesto**: zero dependência
externa paga/com credencial (roteamento, IBGE, mídia, WhatsApp Business,
LLM), tudo determinístico e testado — com os pontos de troca por dado real
claramente marcados no código, mesmo padrão já usado para o CRM na Fase 1.
Construir um conector real sem poder validá-lo contra a API de verdade
passaria confiança sem lastro; por isso não há chamada real a nenhum
provedor externo em nenhuma destas fases.

**Geo Intelligence** (`modules/geo.py`) — simulador de ponto candidato com
score de atratividade ponderado por decaimento de distância (Huff, sobre a
própria carteira geolocalizada), comparador de similaridade entre filiais e
preditor de faturamento **sempre com intervalo de confiança** (nunca ponto
único) e backtest ao lado. Sem H3 nem isócronas reais — `infra/geo.py` usa
uma grade lat/lon simples e documenta a distorção; a aproximação de
deslocamento nunca é chamada de "isócrona" na resposta, para não passar
precisão que o produto não tem.

**Reputation Intelligence** (`modules/reputacao.py`) — sentimento por léxico
PT-BR com negação simples (heurístico, rotulado como tal em toda saída),
deduplicação de matéria replicada por shingling+Jaccard, alerta de anomalia
de volume por z-score contra baseline móvel, share of voice por veículo.
Ingestão via `integracoes/mentions_base.py` (mesmo contrato do CRM). Quando
uma menção casa com uma conta conhecida, publica sinal no barramento — é a
materialização do diferencial D-1.

**Field Execution** (`modules/field.py`) — gap de mix no nível do CLIENTE
(não da carteira inteira): o que os vizinhos geográficos + de segmento
compram e este cliente não, a fusão real de Geo com Sales. O "agente
conversacional" é **100% grounded sem LLM**: todo número do texto vem
direto do cálculo do gap, nunca gerado livremente — mais restrito que a
spec original, deliberadamente, na ausência de uma decisão de provedor de
IA validada. `integracoes/messaging_base.py` é o mesmo padrão de contrato
do CRM para o canal (WhatsApp/WHAPI real entra depois, sobre a mesma
interface).

**O barramento de sinais** (`infra/reactor.py`, spec D-1/§3.6) — a prova de
que os módulos não são silos. `modules/fila.py` (Sales) **nunca importa**
`reputacao.py` nem `field.py` — só reage a sinais que o reactor publicou.
Duas regras implementadas: menção muito negativa sobre conta conhecida
reduz o valor esperado na fila (com o motivo exposto como fator, spec D-2);
PDV reportado como fechado em visita de campo tira o cliente da fila até a
curadoria confirmar. Hoje é uma tabela SQLite consultada sob demanda, não
Kafka — o ponto de troca já está documentado em `infra/scores.py` desde a
Fase 1 (`emitir_sinal`): trocar o transporte não muda as regras de negócio.

**O que ficou de fora, por decisão, não por esquecimento:** A7 (agente
orquestrador com LLM) e conectores reais de CRM/mídia/WhatsApp — todos
exigem uma decisão de provedor e credencial validada que não é minha para
tomar sozinho; construir isso sem poder testar contra a API real seria
pior que não construir.

## Banco operacional em Postgres (Render ou qualquer outro)

Por padrão o banco operacional (usuários, auditoria, scores, sinais,
menções, CRM, comitê — tudo em `backend/vendalytics/infra/db.py`) é
SQLite local. Isso quebra em qualquer PaaS com disco efêmero (Render free
tier já resetou a base uma vez — ver commit "Fix empty dashboard...
Render's ephemeral disk"): o mesmo problema que afeta `usuarios.sqlite`
afeta o SQLite de demonstração.

**Setar `DATABASE_URL`** (Postgres) faz o banco operacional inteiro migrar
para lá, sem tocar em nenhum módulo consumidor — 8 arquivos (`audit.py`,
`scores.py`, `comite.py`, `identidade.py`, `reputacao.py`, `relatorio.py`,
`comunicacao_kpi.py`, `csv_connector.py`, `auth.py`) continuam chamando
`db.conexao()` exatamente como chamavam antes.

### Como configurar (Render)

1. No painel do banco Postgres do Render, copie a **Internal Database
   URL** (já vem com usuário/senha embutidos — não precisa montar a string
   à mão).
2. No serviço web do Vendalytics no Render → **Environment** → adicione
   `DATABASE_URL` com esse valor.
3. Deploy. O log de startup mostra `Schema operacional (Postgres) já na
   versão N` (ou aplica as migrations pendentes) — confirma que pegou.

**Nunca cole a connection string com senha em chat, PR ou log.** Configure
direto no painel do Render; se precisar validar localmente, use uma senha
de teste descartável, nunca a de produção.

### O que foi validado, e como

Todo o port foi testado contra um **Postgres real** (container Docker
nesta sessão, schema recriado do zero) — não só revisado: `db.migrar()`
aplicando as 10 migrations, `auth` (criar usuário + login), `scores`
(`RETURNING id` em vez de `.lastrowid`, que não existe em Postgres),
`sinais`/`marcar_processado` (idempotência via `ON CONFLICT DO NOTHING`),
`auditoria` (trigger PL/pgSQL bloqueando UPDATE de verdade — não só a
versão SQLite), `comite`, `identidade` (upsert `ON CONFLICT DO UPDATE`),
`reputacao` (dedup `MIN(id) GROUP BY cluster_id`), e a aplicação FastAPI
inteira subindo e respondendo `/api/health` e `/api/fila/diaria` via HTTP
real apontada para esse Postgres.

**Not testado**: a suíte `pytest` automatizada roda só contra SQLite — o
isolamento entre testes (`base_isolada`/`db_operacional_isolado`) troca de
arquivo SQLite por teste, e não existe hoje um equivalente para Postgres
(criar/derrubar um schema por teste). Rodar a suíte inteira contra Postgres
exigiria essa peça a mais — não construída ainda, para não inflar ainda
mais o escopo desta sessão. A validação acima (módulo a módulo, contra
banco real) é o substituto manual disso por enquanto.

## Onboarding de um cliente real

1. Copie `config/tenant_config.example.yaml` para `config/tenant_config.yaml` e preencha com os dados do cliente.
2. Popule `SQLiteReferenceAdapter` a partir do CSV do cliente (script de import — fase futura do roadmap).
3. Nunca reaproveite `tenant_config.yaml`/`.env` de outro cliente — cada instalação tem os seus, fora do controle de versão.
