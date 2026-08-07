# Satélite como indicador antecedente: testado e **descartado**

**Veredito: a hipótese não se sustenta.** Este documento existe para que a ideia
não seja proposta de novo sem que alguém saiba o que já foi medido.

## A hipótese

O CEMPRE do IBGE — nossa fonte de nº de empresas por município — é publicado
com cerca de um ano de defasagem. Satélites veem o solo a cada poucos dias.

Se a **expansão de área construída** precede a **abertura formal de empresas**,
existiria um indicador antecedente que nenhum concorrente usa: saber que uma
praça está aquecendo antes de a estatística oficial registrar. Era, de longe,
a mais promissora das inovações levantadas para o produto.

## Como foi testado

| | |
|---|---|
| Área construída | MapBiomas Coleção 10, classe `Non-Vegetated Urban Area`, hectares por município, 1985–2024 (derivada de Landsat/Sentinel) |
| Empresas | IBGE CEMPRE, agregados 9418 (2022–2024) e 6449 (2008–2020), variável 2585 |
| Cobertura | 5.571 municípios em ambas as fontes |
| Estatística | Spearman (posto) como principal; Pearson reportado junto |

Spearman é a medida principal porque variação percentual de município pequeno
tem cauda pesadíssima — sair de 2 para 4 empresas é +100% — e Pearson viraria
refém desses casos.

**O teste foi desenhado para poder falhar.** Cada janela antecedente tem uma
contemporânea ao lado. Se as duas forem parecidas, não há antecipação: é apenas
a constatação óbvia de que lugares que crescem crescem em tudo ao mesmo tempo.

Script reprodutível: [`scripts/pesquisa/satelite_indicador.py`](../scripts/pesquisa/satelite_indicador.py)

## Resultados

### Janela curta (2 anos, pós-pandemia), municípios com ≥ 200 empresas

| Setor | Antecedente | Contemporânea |
|---|---|---|
| Comércio (G) | ρ = **+0,121** | ρ = +0,098 |
| Construção (F) | ρ = **+0,124** | ρ = +0,046 |

### Janela longa (5 anos, pré-pandemia), municípios com ≥ 200 empresas

| Setor | Janela | Antecedente | Contemporânea |
|---|---|---|---|
| Comércio (G) | constr. 2010–15 → empresas 2015–20 | ρ = +0,181 | ρ = **+0,191** |
| Comércio (G) | constr. 2008–13 → empresas 2013–18 | ρ = +0,126 | — |
| Construção (F) | constr. 2010–15 → empresas 2015–20 | ρ = +0,264 | ρ = **+0,323** |
| Construção (F) | constr. 2008–13 → empresas 2013–18 | ρ = +0,285 | — |

Sem corte de porte (todos os 5.570 municípios), tudo cai para ρ ≈ 0,01–0,04 —
indistinguível de zero.

## Leitura

**1. Existe relação, e ela é fraca.** ρ entre 0,12 e 0,29 explica de 1% a 8% da
variação. Estatisticamente significante com n = 1.400, e comercialmente
irrelevante: não sustenta uma decisão de onde alocar vendedor.

**2. Não há antecipação.** Nas janelas longas — as mais favoráveis à hipótese —
a correlação **contemporânea é igual ou maior** que a antecedente, nos dois
setores. O satélite não está vendo o futuro; está vendo o mesmo presente, com
menos resolução.

**3. Construção civil responde melhor que Comércio** (ρ 0,26–0,32 contra
0,13–0,19), o que faz sentido: empresa de construção literalmente constrói. Mas
mesmo lá a contemporânea vence.

**4. A premissa tinha um furo independente da correlação.** A série urbana do
MapBiomas é **anual e publicada com defasagem própria** — a Coleção 10 saiu em
2025 cobrindo até 2024. Mesmo que a correlação fosse forte, a vantagem de tempo
sobre o CEMPRE seria pequena. Este ponto sozinho já enfraquece a tese, e deveria
ter sido verificado antes das correlações.

## O que salvaria a ideia (e o que custaria)

O provável erro é de **granularidade**: o sinal comercial não é "o município
cresceu 3% de área construída", é "abriu um centro comercial naquele bairro".
Agregado municipal dilui isso até sumir.

Testar direito exigiria processar Sentinel-2 bruto em recorte intraurbano, com
detecção de mudança por célula — semanas de trabalho, pipeline de raster e
validação contra dado conhecido. **Não é o próximo passo recomendado**, mas se
alguém quiser tentar, o erro a evitar está documentado acima.

## Custo do teste

Duas horas, dois downloads públicos, nenhuma credencial. É o resultado que se
esperava de um teste de viabilidade: **matou barato uma ideia cara**.

---

*Medido em 07/08/2026. Para reproduzir: `python scripts/pesquisa/satelite_indicador.py`*
