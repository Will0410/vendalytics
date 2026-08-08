# Espaço de atividades: prever ONDE uma atividade econômica vai aparecer

**Veredito: funciona, com AUC 0,75 fora da amostra, em 69 das 87 divisões
CNAE.** Este documento existe para que o método não seja vendido como mais do
que é, e para que quem for mexer saiba o que já foi medido — inclusive a parte
que quase me enganou.

## A tese

Todo o resto da plataforma trata cada atividade econômica como uma coluna
independente: conta comércios, conta indústrias, ordena por volume.

A economia da complexidade (Hausmann–Hidalgo, o "espaço de produtos", validado
em comércio internacional) parte de outra premissa: **atividades não aparecem
em qualquer lugar. Aparecem onde as capacidades vizinhas já existem.** Um
município forte em metalurgia e produtos de metal tem mais chance de ganhar
fabricação de máquinas do que de ganhar turismo — não por ser maior ou mais
rico, mas porque as capacidades se sobrepõem.

Se isso valer para CNAE municipal brasileiro, o produto responde algo que
nenhuma plataforma de vendas responde: **quais praças já têm os pré-requisitos
para o seu tipo de cliente, mas ainda não o têm.**

## O método

| | |
|---|---|
| Dado | IBGE CEMPRE, nº de empresas por município × divisão CNAE (87 divisões) |
| Especialização | RCA ≥ 1 — a atividade pesa mais no município do que pesa no país |
| Proximidade | φ(i,j) = min( P(RCA_i \| RCA_j), P(RCA_j \| RCA_i) ) |
| Densidade | quanto do entorno de uma atividade o município já domina, 0 a 1 |
| Score | √(densidade × popularidade) |

O **RCA binarizado** é o que faz o método medir capacidade e não tamanho. Sem
essa normalização, São Paulo seria vizinho de todo mundo simplesmente por ter
mais de tudo.

O **`min`** na proximidade é o coração: sem ele, uma atividade presente em
quase todo município pareceria próxima de tudo. A ligação só é forte se a
coocorrência for forte nos dois sentidos.

Reprodutível: [`scripts/gerar-espaco-cnae.py`](../scripts/gerar-espaco-cnae.py)
Implementação: [`web/src/domain/ecossistema.ts`](../web/src/domain/ecossistema.ts)

## A validação

Rede construída com o CEMPRE de **2013**; rótulo = a divisão efetivamente
apareceu naquele município até **2020**. Metade dos municípios ficou fora do
ajuste — **inclusive da construção da rede**, senão o conjunto de teste já
teria visto a própria coocorrência.

AUC em 2.785 municípios nunca vistos, 198.004 casos:

| | AUC |
|---|---|
| Só popularidade (referência honesta) | 0,7185 |
| Só densidade (a rede) | 0,7100 |
| **As duas juntas** | **0,7549** |

Taxa de aparecimento por decil do score, no conjunto de teste:

```
decil  1   0,3%          decil  6    7,5%
decil  2   1,6%          decil  7   10,6%
decil  3   3,0%          decil  8   13,8%
decil  4   3,9%          decil  9   17,9%
decil  5   5,4%          decil 10   23,8%
```

## A parte que quase me enganou

**Sozinha, a rede PERDE para a referência ingênua.** Prever pela simples
frequência da atividade dá 0,7185; a rede inteira dá 0,7100.

Se eu tivesse olhado só para os decis da densidade — que vão de 1,0% a 19,9% e
parecem ótimos — teria embarcado um grafo bonito que uma linha de heurística
supera. A referência honesta ao lado é o que impediu isso.

O que salva o método não é a rede substituir a popularidade, é ela carregar
informação **independente**. Controlando por faixa de frequência, a rede vence
em todas:

| Faixa | Rede | Popularidade |
|---|---|---|
| rara (<10%) | **0,7155** | 0,6675 |
| incomum (10–35%) | **0,6513** | 0,6147 |
| comum (35–70%) | **0,5941** | 0,5082 |
| ubíqua (>70%) | 0,4492 | 0,4227 |

Também testei o caminho oposto, que parecia a correção óbvia: **excluir as
atividades ubíquas piorou** (0,7125 → 0,6744). A rede precisa delas como
contexto, mesmo não sabendo prevê-las.

## Por que média geométrica, e não um modelo ajustado

A regressão logística sobre log(densidade) e log(popularidade) devolveu pesos
**+0,999** e **+0,997** — praticamente idênticos. O modelo ajustado *é* o
produto das duas.

| | AUC no teste |
|---|---|
| Logística ajustada | 0,7549 |
| √(densidade × popularidade) | 0,7540 |

Diferença de 0,0009. Ficou a média geométrica: mesma acurácia, escala 0–1
legível, e **nenhum parâmetro ajustado** para versionar, envelhecer ou
explicar.

## Onde não funciona

O AUC **não é parecido entre as divisões** — vai de 0,88 a 0,39. O artefato
carrega o valor medido de cada uma, e o produto só oferece as que passam de
0,55. São 69 de 87.

| Funciona | | Falha | |
|---|---|---|---|
| 39 Descontaminação | 0,878 | 82 Serviços de escritório | 0,394 |
| 51 Transporte aéreo | 0,873 | 47 Comércio varejista | 0,412 |
| 21 Farmoquímicos | 0,847 | 85 Educação | 0,423 |
| 30 Equip. de transporte | 0,845 | 84 Administração pública | 0,461 |
| 65 Seguros | 0,835 | 01 Agricultura | 0,470 |
| 26 Equip. de informática | 0,826 | 41 Construção de edifícios | 0,482 |

O padrão é interpretável: **a rede prevê atividades que exigem capacidade
específica e falha nas que apenas acompanham população.** Todo município tem
varejo, escola e prefeitura na medida da sua gente, sem precisar de ecossistema
industrial nenhum.

Este corte substituiu um chute meu. Eu tinha barrado por "ubiquidade > 70%", o
que pega varejo e administração pública mas **deixa passar Educação** (31% de
ubiquidade, AUC 0,423) e **Agricultura** (28%, AUC 0,470). Medir cada divisão é
mais trabalho e é a única forma de acertar quais.

Uma suspeita minha se mostrou **errada**: achei que atividades extrativas
falhariam, porque dependem de geologia e não de capacidade. Elas dão AUC 0,659
— na média geral.

## A direção que não existe

"Dado um município, o que ele está mais pronto para receber" parece a pergunta
gêmea. Não é: as duas formas testadas saem degeneradas.

- Ordenando pela prontidão, a popularidade varia entre divisões e domina —
  Caxias do Sul e São Paulo recebem quase a **mesma lista**.
- Normalizando pela densidade média da divisão, inverte e passa a ser dominada
  pelas mais raras: as três cidades testadas recebiam *"Extração de carvão
  mineral"* e *"Extração de petróleo"*.

A assimetria tem explicação. Fixando a **atividade**, a popularidade é
constante entre os candidatos e não afeta a ordem — sobra a densidade, que é o
sinal específico do município. Fixando o **município**, ela vira o termo
dominante e não diz nada sobre aquele lugar.

O produto entrega uma direção só, que é a validada.

## Por que um artefato pré-gerado

A API do IBGE entrega **uma divisão CNAE por vez** para os 5.570 municípios
(655KB, ~2,7s). Cinco de uma vez já devolve HTTP 500. São 87 divisões: ~57MB e
quatro minutos, inviável no navegador.

E desnecessário — a rede é um objeto **global**: não muda por usuário, filtro
ou sessão. Muda uma vez por ano, quando o IBGE publica o CEMPRE. O artefato tem
432KB (98KB comprimido) e desce só para quem abre o módulo.

## Como ler o resultado

**O que permite:** ordenar candidatas por preparo do ecossistema, com o
argumento junto. Para *Fabricação de máquinas*, o topo hoje é Três Rios/RJ
(62%), Duque de Caxias/RJ (58%) e Sete Lagoas/MG (57%) — todas já com borracha
e plástico, veículos automotores e manutenção de máquinas.

**O que não permite:** afirmar que a atividade vai abrir em um município
específico. AUC 0,75 ordena bem uma lista; não decide uma visita sozinho.

---

*Medido em 08/08/2026. Para reproduzir: `python scripts/gerar-espaco-cnae.py`*
