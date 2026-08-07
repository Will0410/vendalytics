# Vendalytics Web

Plataforma de inteligência de vendas, geomarketing e enriquecimento B2B, em
**React + Stitches**, sobre dados públicos brasileiros reais.

Nenhum número nesta interface é mockado. Tudo vem, ao vivo, de:

| Fonte | O que traz | Chave? |
|---|---|---|
| IBGE · Localidades v1 | 27 UFs, 5.570 municípios | não |
| IBGE · Agregados v3 (SIDRA) | população, PIB, empresas por CNAE | não |
| Receita Federal · via BrasilAPI | cadastro completo por CNPJ | não |
| Backend Vendalytics (FastAPI) | login, contas de acesso, análise por IA | JWT |

---

## Subir

```bash
# 1. backend (login, usuários e a camada de IA)
cd backend
python -m uvicorn vendalytics.main:app --reload --port 8901

# 2. frontend
cd web
npm install
npm run dev          # http://localhost:5273
```

Na primeira subida do backend, um administrador é criado automaticamente com
senha aleatória **impressa uma única vez no log**. Perdeu?

```bash
cd backend
python reset_admin_password.py seu.email@exemplo.com -s "SuaSenhaNova"
```

Daí em diante, contas novas são criadas dentro da própria plataforma, em
**Usuários** (visível só para perfil `admin`).

---

## Os cinco módulos

| Módulo | Pergunta que responde | Requisições |
|---|---|---|
| **Inteligência de Vendas** | Quantas empresas de cada setor existem no Brasil? | 4 |
| **Geomarketing** | Onde estão as empresas do meu setor, município a município? | 2 |
| **Relatório de Praça** | Quanto vale esta praça? TAM, SAM, SOM, densidade, saturação | 4 |
| **Prospecção B2B** | Quais contas atacar primeiro? Score ICP explicável | 1 por CNPJ |
| **Enriquecimento** | Tudo sobre um CNPJ + o contexto da praça onde ele está | 2 |

---

## Decisões que valem conhecer antes de mexer

### O agregado do IBGE é o 9418, não o 9510

O CEMPRE aparece em várias tabelas do SIDRA. A **9510** (variável 367) tem
apenas a categoria "Total": pedir qualquer seção CNAE nela devolve `"-"` em
todo nível geográfico e em todos os períodos publicados — testado ao vivo,
2022/2023/2024.

A **9418** (variável 2585) publica as 1.067 categorias da CNAE 2.0 — seção,
divisão, grupo e classe — em N1/N2/N3/N6, e cobre os 5.570 municípios sem
supressão no total. É a diferença entre *"existem X empresas nesta praça"* e
*"existem X empresas, das quais Y são do seu setor"*.

Limites de payload, medidos:

```
21 seções × 27 UFs ..............  73 KB, 0,2s   ✓
 1 seção  × 5.570 municípios .... 678 KB, 1,5s   ✓
21 seções × 5.570 municípios .... erro 500       ✗  (a API recusa)
```

Daí o desenho: matriz setor×UF numa chamada; drill municipal um setor por vez,
sob demanda.

### Nenhuma entrada de cache aceita `AbortSignal` de consumidor

Uma entrada de cache é **compartilhada**. Se o `AbortController` de um
componente entrar na função que produz o valor, o desmonte desse componente
cancela a busca de todos os outros que esperam a mesma chave.

Não é teórico: foi o bug que derrubou todas as telas de IBGE na primeira
execução. No StrictMode do React 18 o efeito monta, desmonta e monta de novo;
a limpeza da 1ª montagem abortava a promise que a 2ª ia reaproveitar, e a tela
morria com *"signal is aborted without reason"*.

O cancelamento certo acontece uma camada acima — `useAsync` descarta o
resultado de quem desmontou, e `mapaComLimite` para de disparar tarefas novas.

### Todo número carrega a procedência

Cada KPI mostra uma etiqueta: `dado IBGE`, `calculado` ou `premissa sua`.

TAM/SAM/SOM em reais são sempre *base real × premissa comercial*. Misturar os
dois num número só faz o usuário tratar a própria arbitragem de ticket médio
como dado do IBGE — e decidir investimento de praça em cima disso.

### A IA redige, não calcula

O painel **Leitura do analista de IA** usa a Groq (`llama-3.3-70b-versatile`).
O modelo recebe os fatos **já computados** pelo front e só costura a leitura.
Perguntar direto "quantas empresas de comércio há em Curitiba?" a um LLM
devolve um número plausível e errado, com a mesma confiança de um certo.

A camada determinística (cards de *Inteligência Analítica*) é a fonte dos
fatos e continua completa se a Groq cair, faltar chave ou estourar cota.

### A chave da Groq mora no servidor

Toda variável `VITE_*` vai para o bundle do cliente e é legível no DevTools.
Por isso a IA passa por `POST /api/ia/analisar` no backend — autenticado, para
não virar um proxy de LLM aberto rodando na cota do dono da instalação.

### Paleta de gráfico validada, não escolhida a olho

As cores de série passam nos seis testes de acessibilidade contra a superfície
real dos cards (`#0f172a`): banda de luminosidade, piso de croma, separação
para daltonismo (protan/deutan/tritan), piso de visão normal e contraste.

```
pior par adjacente CVD ....... ΔE 8.4   (alvo ≥ 8)
pior par adjacente normal .... ΔE 19.3  (piso ≥ 15)
contraste vs superfície ...... todos ≥ 3:1
```

Dispersão e bolha usam no máximo **3 slots** — só eles passam no teste
all-pairs. Reordenar ou re-tonalizar exige rodar o validador de novo: a ordem
é o mecanismo de segurança, não decoração.

---

## Estrutura

```
src/
  stitches.config.ts   Design system: tokens, variants, paleta validada
  app/                 sessão, filtros globais, roteamento
  assets/              catálogo + provedor SVG + adapter Nano Banana
  lib/                 http com backoff, cache, pool, formatação pt-BR
  data/                clientes IBGE, BrasilAPI, backend, CNAE 2.0
  domain/              TAM/SAM/SOM, saturação, Score ICP, motor de insights
  components/          primitivas Stitches, shell, gráficos, cards
  modules/             as seis telas
```

---

## Assets visuais

O provedor padrão desenha tudo em **SVG autoral**: nítido em qualquer
densidade, ~0kb de rede, offline, sem chave, determinístico, e os ícones
herdam a cor do contexto via `currentColor`.

Há um adapter de **Nano Banana** (`gemini-2.5-flash-image`) escrito e
documentado em `src/assets/nanoBanana.ts`. Configurando `VITE_ASSET_PROXY_URL`
(ou `VITE_GEMINI_API_KEY` em desenvolvimento), ele assume e o SVG vira a rede
de segurança — `fallbackChain` garante que chave expirada, cota estourada ou
rede fora nunca deixem a interface sem asset.

> Esse adapter foi escrito contra a API documentada mas **não foi executado
> contra a API real** — este ambiente não tem chave do Gemini. Trate como
> integração pendente de validação.

---

## Comandos

```bash
npm run dev         # servidor de desenvolvimento
npm run build       # tsc -b && vite build
npm run typecheck   # só os tipos
npm run preview     # serve o build
```

Veja `.env.example` para as variáveis (todas opcionais).
