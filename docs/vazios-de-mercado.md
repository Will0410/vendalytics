# Vazios de mercado: prever onde vai abrir empresa

**Veredito: funciona, é modesto, e só vale para alguns setores.** Este
documento existe para que ninguém venda o indicador como mais do que ele é, e
para que quem for mexer no modelo saiba o que já foi medido.

## A pergunta

Todo o resto da plataforma é descritivo: conta empresas, calcula densidade,
ordena por atratividade. Isso responde *onde está o mercado hoje* — uma
pergunta que qualquer concorrente com acesso ao IBGE também responde.

A pergunta que gera visita é a seguinte: **onde o mercado ainda não está, mas
as condições para ele existir já estão?**

## O modelo

Ajusta quantas empresas de um setor um município deveria ter e mede quem está
abaixo disso.

```
ln(empresas) = a + b·ln(população) + c·ln(PIB per capita)
```

O resíduo — a diferença entre o observado e o previsto — é a lacuna.

| | |
|---|---|
| Empresas | IBGE CEMPRE, agregados 9418 (produção) e 6449 (validação histórica), variável 2585 |
| População | IBGE 6579/9324 |
| PIB | IBGE 5938/37 |
| Estimação | Mínimos quadrados, reestimado a cada execução sobre o dado corrente |
| Piso | 20 empresas do setor no município |

Reprodutível: [`scripts/pesquisa/vazios_de_mercado.py`](../scripts/pesquisa/vazios_de_mercado.py)
Implementação em produção: [`web/src/domain/vazios.ts`](../web/src/domain/vazios.ts)

## Como foi validado

**Ajuste em 2013, confronto com o crescimento de 2015 a 2020.** As janelas são
disjuntas. Nenhum dado da validação entra no ajuste.

Isso não é preciosismo. Ajustando em 2015 e medindo o crescimento a partir de
2015, o Comércio dá ρ = **−0,292**. Com a janela disjunta, **−0,232**. A
diferença é reversão à média: o número de empresas de 2015 aparece dos dois
lados da conta, e ruído nele gera correlação sozinho. **Quem medir do jeito
fácil vai achar que o indicador é 26% melhor do que é.**

Toda comparação tem uma **referência honesta** ao lado: a densidade pura
(empresas ÷ população). Um modelo que não bate a conta mais simples possível
não é modelo, é nome novo.

## Resultados

| Setor | n | Densidade pura | Modelo | R² |
|---|---|---|---|---|
| Comércio (G) | 4.979 | ρ = −0,170 | ρ = **−0,232** | 0,869 |
| Indústria de transformação (C) | 5.476 | ρ = −0,096 | ρ = **−0,201** | 0,855 |
| Construção (F) | 1.155 | ρ = +0,059 | ρ = **+0,010** | 0,797 |

O sinal negativo é o esperado: abaixo do previsto hoje, cresce mais depois.

**Crescimento médio de 2015 a 2020, primeiro decil contra último:**

| Setor | Mais desabastecidos | Mais saturados | Diferença |
|---|---|---|---|
| Comércio | +0,6% | −18,0% | 18,6 pontos |
| Indústria | +9,8% | −9,8% | 19,6 pontos |

O período inclui a recessão brasileira, o que explica os valores negativos. O
que importa é a diferença entre os decis, com o modelo ajustado dois anos antes
da janela.

**Estabilidade:** o resíduo de 2013 correlaciona ρ = **+0,913** com o de 2015. O
desequilíbrio é estrutural, não ruído de um ano — é o que torna o indicador
utilizável, porque não desaparece antes de a operação chegar lá.

## Onde não funciona, e por quê

**Construção civil: ρ = +0,010.** Sinal nulo.

A causa é a premissa do modelo, que é **equilíbrio de mercado local**: a empresa
se instala onde está a demanda que atende. Construtora não obedece a isso —
empresa sediada em São Paulo constrói na Bahia. O município da sede não diz nada
sobre o mercado que ela serve.

No produto, o indicador é **bloqueado** para setores não validados. O modelo roda
em qualquer seção CNAE e devolve números de aparência idêntica; entregá-los
seria vender um indicador que não indica nada.

## O que faz o trabalho

As duas variáveis não valem o mesmo:

| | ρ com crescimento futuro |
|---|---|
| Só população | −0,151 |
| **+ poder de compra** | **−0,218** |
| + hinterlândia por gravidade | −0,225 *(descartado)* |

O coeficiente de população sozinho é **+0,994** — praticamente 1. O resíduo desse
modelo *é* a densidade, com outro nome, e o ρ confirma: −0,151 contra −0,152 da
densidade pura.

**O salto vem do poder de compra.** É ele que separa "densidade baixa porque a
cidade é pobre" — onde não há oportunidade alguma — de "densidade baixa apesar
do dinheiro", que é o caso que interessa.

## O teto de renda

PIB per capita é o proxy de poder de compra, e em alguns municípios ele não mede
poder de compra nenhum: é uma planta industrial dividida pela população.

| | PIB per capita | Motivo |
|---|---|---|
| Maricá/RJ | R$ 631 mil | royalties de petróleo |
| Paulínia/SP | R$ 575 mil | refinaria da Replan |
| *mediana do país* | *R$ 13,5 mil* | |

Sem teto, o modelo esperava **24 comércios por mil habitantes** nesses casos.
Nenhum município brasileiro chega perto disso. Pior: a distorção se concentra no
**topo do ranking**, que é exatamente onde as pessoas agem — o erro médio ficava
bom e o produto ficava ruim.

O corte no percentil 95 da própria amostra não é meio-termo, melhora as três
coisas ao mesmo tempo:

| | R² | ρ | Densidade máxima esperada |
|---|---|---|---|
| Sem teto | 0,8606 | −0,2292 | 23,9/mil hab |
| Teto no p99 | 0,8634 | −0,2301 | 21,2/mil hab |
| **Teto no p95** | **0,8691** | **−0,2318** | **15,3/mil hab** |

É percentil e não valor fixo porque o modelo roda sobre o dado do momento — um
teto em reais de 2013 estaria errado em 2024 só por inflação.

## A hipótese que foi descartada

A ideia original era **redistribuir demanda por gravidade** (modelo de Huff):
quem mora em Serrana compra em Ribeirão Preto, então a densidade de Serrana
parece baixa não porque há oportunidade, e sim porque a demanda vaza para o
vizinho. Parecia o salto.

**Foi cortada.** Dois motivos:

**1. Ganho de 0,007 no ρ e 0,001 no R².** Dentro do ruído.

**2. A razão que ela produz é artefato de agregação.** O modelo trata a
população inteira de um município como um ponto no centroide. O centroide de
área de São Paulo cai a **7,0 km** de Diadema, então Diadema "captura" parte de
12 milhões de pessoas e sai com a maior razão do país — 1,611 — sem ser polo de
coisa nenhuma. A razão vira quase uma função da distância ao centroide do
vizinho grande:

```
7,0 km -> 1,611      15,9 km -> 0,931
8,7 km -> 1,214      20,1 km -> 0,806
```

Fora de região metropolitana ela funciona (São Paulo 1,32, Ribeirão Preto 1,36,
Juazeiro do Norte 1,38, contra Serrana 0,76 e Cravinhos 0,66). Mas falharia
justamente nos mercados mais densos, e explicação falsa entregue com confiança é
pior que explicação nenhuma.

Efeito colateral bom: sem gravidade, o modelo não precisa de coordenada nenhuma.
Três números por município bastam.

## Como ler o resultado

**O que permite:** priorizar. Ordenar 5.570 praças por onde a chance de
crescimento é maior, com uma diferença medida de ~19 pontos percentuais entre o
primeiro e o último decil ao longo de cinco anos.

**O que não permite:** prever um município específico. ρ = −0,23 explica cerca
de **5% da variação**. Isto decide a sequência da rota; não substitui a visita.

No produto, a tela usa as duas medidas com papéis diferentes: o resíduo
**qualifica** (só entra o quartil mais desabastecido) e a lacuna absoluta
**ordena** (entre os qualificados, aparece primeiro o maior prêmio). Ordenar só
pelo resíduo entrega o ranking a municípios de 6 mil habitantes aos quais faltam
8 comércios — verdade estatística, inútil como rota de vendedor.

## Custo

Meio dia, só API pública do IBGE, nenhuma credencial. Uma hipótese principal
descartada (gravidade), uma correção encontrada por inspeção do resultado (teto
de renda), um setor reprovado (Construção) e dois validados.

---

*Medido em 08/08/2026. Para reproduzir: `python scripts/pesquisa/vazios_de_mercado.py`*
