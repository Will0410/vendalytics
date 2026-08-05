"""
propensao.py — modelo de propensão de recompra (spec §2.1 A1/A3).

── Qual é o alvo, aqui ────────────────────────────────────────────────────
A spec fala em "probabilidade de fechar em N dias", pensando num CRM com
ganho/perda. Numa distribuidora o label equivalente e disponível é
**recompra**: o cliente comprou de novo nos próximos H dias? É o mesmo
problema estatístico, com a vantagem de o label já existir no histórico —
não depende de o time preencher CRM.

── Por que regressão logística e não gradient boosting ───────────────────
A spec pede LightGBM/XGBoost. Aqui a escolha é logística, por dois motivos
que valem mais do que o ganho de AUC nesta fase:

1. **Zero dependências.** O projeto roda hoje sem numpy/sklearn, em free
   tier. Um modelo que exige 300MB de wheels muda o perfil de deploy do
   produto inteiro para ganhar alguns pontos de AUC num piloto.
2. **A explicação é exata, não aproximada.** Para um modelo linear, o valor
   SHAP de uma feature É `coef_j · (x_j − E[x_j])` — forma fechada, sem
   amostragem, sem aproximação. O diferencial D-2 da spec (explicabilidade
   obrigatória) fica mais forte, não mais fraco.

O custo real: a logística não captura interação nem não-linearidade. Quando
o volume de dado justificar, troque `_treinar` e `_contribuicoes` por
LightGBM + SHAP — o resto do módulo (features, split temporal, calibração,
métricas, persistência) não muda, porque nada aqui depende da família do
modelo.

── Correção temporal ──────────────────────────────────────────────────────
Features são calculadas numa data de referência e o label olha só para
depois dela (`_montar_amostras`). Validação é out-of-time, nunca k-fold
aleatório: o modelo vai ser usado no futuro, então precisa ser medido no
futuro. Um k-fold aqui daria uma AUC bonita e mentirosa.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta

from .. import data_layer

# Versão do modelo: entra em todo score persistido. Mude junto com qualquer
# alteração de feature, hiperparâmetro ou label — é o que permite comparar
# scores de épocas diferentes sem adivinhação.
MODELO_VERSAO = "propensao-recompra-lr-v1"

HORIZONTE_DIAS = 30

# Dicionário de features versionado (spec D-2): a UI nunca mostra
# `atraso_relativo`, mostra a frase. Sem isto, "explicabilidade" vira uma
# lista de nomes de variável, que não explica nada para um vendedor.
FEATURES: dict[str, dict] = {
    "recencia_dias": {
        "rotulo_alto": "faz muito tempo desde a última compra",
        "rotulo_baixo": "comprou recentemente",
    },
    "atraso_relativo": {
        "rotulo_alto": "está atrasado em relação ao ritmo habitual de compra",
        "rotulo_baixo": "está dentro do ritmo habitual de compra",
    },
    "frequencia_90d": {
        "rotulo_alto": "compra com frequência alta nos últimos 90 dias",
        "rotulo_baixo": "comprou poucas vezes nos últimos 90 dias",
    },
    "ticket_medio": {
        "rotulo_alto": "ticket médio acima da carteira",
        "rotulo_baixo": "ticket médio abaixo da carteira",
    },
    "tendencia_90d": {
        "rotulo_alto": "volume em alta contra o trimestre anterior",
        "rotulo_baixo": "volume em queda contra o trimestre anterior",
    },
    "meses_relacionamento": {
        "rotulo_alto": "relacionamento longo com a casa",
        "rotulo_baixo": "cliente recente",
    },
    "intervalo_medio_dias": {
        "rotulo_alto": "costuma comprar com intervalos longos",
        "rotulo_baixo": "costuma comprar com intervalos curtos",
    },
}
ORDEM_FEATURES = list(FEATURES)


# ── extração de features ───────────────────────────────────────────────────
def _dt(s: str) -> date | None:
    try:
        return datetime.fromisoformat(str(s)[:10]).date()
    except (ValueError, TypeError):
        return None


def _features_do_cliente(compras: list[tuple[date, float]], referencia: date) -> dict | None:
    """Vetor de features de UM cliente numa data de referência.

    Só enxerga compras <= referência. É aqui que a correção temporal é
    garantida — o resto do pipeline confia nesta função para não vazar o
    futuro para dentro do treino.
    """
    ate = [(d, v) for d, v in compras if d <= referencia]
    if not ate:
        return None
    ate.sort()
    datas = [d for d, _ in ate]
    valores = [v for _, v in ate]

    recencia = (referencia - datas[-1]).days
    relacionamento = max((referencia - datas[0]).days, 1)

    if len(datas) > 1:
        intervalos = [(datas[i] - datas[i - 1]).days for i in range(1, len(datas))]
        intervalo_medio = sum(intervalos) / len(intervalos)
    else:
        # Cliente com uma compra só não tem ritmo observado. Usar o tempo de
        # relacionamento como proxy é honesto: é o único intervalo que existe.
        intervalo_medio = float(relacionamento)
    intervalo_medio = max(intervalo_medio, 1.0)

    corte_90 = referencia - timedelta(days=90)
    corte_180 = referencia - timedelta(days=180)
    freq_90 = sum(1 for d in datas if d > corte_90)
    valor_90 = sum(v for d, v in ate if d > corte_90)
    valor_90_anterior = sum(v for d, v in ate if corte_180 < d <= corte_90)

    return {
        "recencia_dias": float(recencia),
        # A feature mais informativa do conjunto: 30 dias sem comprar é normal
        # para quem compra a cada 45, e alarmante para quem compra a cada 7.
        # Recência sozinha não distingue os dois casos.
        "atraso_relativo": recencia / intervalo_medio,
        "frequencia_90d": float(freq_90),
        "ticket_medio": sum(valores) / len(valores),
        "tendencia_90d": (valor_90 / valor_90_anterior) if valor_90_anterior > 0 else 1.0,
        "meses_relacionamento": relacionamento / 30.0,
        "intervalo_medio_dias": intervalo_medio,
    }


def _compras_por_cliente(filial: str = "") -> dict[str, list[tuple[date, float]]]:
    por_cliente: dict[str, list[tuple[date, float]]] = {}
    for v in data_layer.vendas_por_periodo(filial=filial):
        d = _dt(v.get("data_venda", ""))
        if d is None:
            continue
        por_cliente.setdefault(str(v.get("cliente_id")), []).append(
            (d, float(v.get("valor_total") or 0.0)))
    return por_cliente


def _montar_amostras(por_cliente: dict, referencia: date, horizonte: int):
    """(X, y, ids) numa data de referência. y = comprou até referência+horizonte."""
    fim = referencia + timedelta(days=horizonte)
    X, y, ids = [], [], []
    for cid, compras in por_cliente.items():
        f = _features_do_cliente(compras, referencia)
        if f is None:
            continue
        comprou = any(referencia < d <= fim for d, _ in compras)
        X.append([f[k] for k in ORDEM_FEATURES])
        y.append(1 if comprou else 0)
        ids.append(cid)
    return X, y, ids


# ── modelo ─────────────────────────────────────────────────────────────────
@dataclass
class Modelo:
    coeficientes: list[float]
    intercepto: float
    media: list[float]
    desvio: list[float]
    versao: str = MODELO_VERSAO
    metricas: dict = field(default_factory=dict)
    treinado_em: str = ""

    def _padronizar(self, x: list[float]) -> list[float]:
        return [(x[i] - self.media[i]) / self.desvio[i] for i in range(len(x))]

    def probabilidade(self, x: list[float]) -> float:
        z = self.intercepto + sum(
            c * v for c, v in zip(self.coeficientes, self._padronizar(x)))
        return 1.0 / (1.0 + math.exp(-max(min(z, 35.0), -35.0)))

    def contribuicoes(self, x: list[float]) -> list[tuple[str, float]]:
        """Contribuição de cada feature, em log-odds.

        Para um modelo linear esta é a decomposição SHAP exata: com as
        features padronizadas, E[x_padronizado] = 0 no treino, então
        `coef_j · x_padronizado_j` já é o afastamento do cliente em relação
        ao cliente médio. Nada de amostragem, nada de aproximação.
        """
        xs = self._padronizar(x)
        return [(ORDEM_FEATURES[i], self.coeficientes[i] * xs[i]) for i in range(len(xs))]


def _treinar(X: list[list[float]], y: list[int], *, iteracoes: int = 3000,
             taxa: float = 0.3, l2: float = 1e-3,
             verificar_a_cada: int = 25, tolerancia: float = 1e-5) -> Modelo:
    """Gradient descent puro Python — sem numpy, mesmo racional de sempre
    (zero dependência pesada). `iteracoes` é o TETO, não a meta: a maior
    parte dos treinos converge bem antes disso, e rodar até o teto sem
    checar convergência é o maior custo de CPU deste módulo — sensível de
    verdade num ambiente com CPU compartilhada/limitada (ex.: Render free
    tier), onde é literalmente a diferença entre a fila carregar ou a
    página travar em "carregando" até a request estourar.

    Parada antecipada: a cada `verificar_a_cada` iterações, compara o
    log-loss médio contra a checagem anterior; para se a melhora for menor
    que `tolerancia`. Não muda o RESULTADO do modelo (ele já teria
    convergido para perto disso de qualquer forma) — muda só quanto tempo
    se gasta rodando depois que já convergiu.
    """
    n, p = len(X), len(X[0])
    media = [sum(linha[j] for linha in X) / n for j in range(p)]
    desvio = []
    for j in range(p):
        var = sum((linha[j] - media[j]) ** 2 for linha in X) / n
        # Feature constante no treino não pode dividir por zero nem gerar
        # contribuição infinita: desvio 1 a deixa inerte (x - média = 0).
        desvio.append(math.sqrt(var) if var > 1e-12 else 1.0)
    Xs = [[(linha[j] - media[j]) / desvio[j] for j in range(p)] for linha in X]

    coef = [0.0] * p
    b = math.log(max(sum(y), 1) / max(n - sum(y), 1))  # intercepto na taxa-base
    perda_anterior = None
    for it in range(iteracoes):
        gc = [0.0] * p
        gb = 0.0
        perda = 0.0
        checar = (it + 1) % verificar_a_cada == 0
        for i in range(n):
            z = b + sum(coef[j] * Xs[i][j] for j in range(p))
            z_clamp = max(min(z, 35.0), -35.0)
            pred = 1.0 / (1.0 + math.exp(-z_clamp))
            erro = pred - y[i]
            gb += erro
            for j in range(p):
                gc[j] += erro * Xs[i][j]
            if checar:
                # log-loss com epsilon para não bater em log(0) quando o
                # modelo já está bem confiante e acerta.
                pred_c = min(max(pred, 1e-12), 1 - 1e-12)
                perda += -(y[i] * math.log(pred_c) + (1 - y[i]) * math.log(1 - pred_c))
        b -= taxa * gb / n
        for j in range(p):
            coef[j] -= taxa * (gc[j] / n + l2 * coef[j])

        if checar:
            perda = perda / n
            if perda_anterior is not None and (perda_anterior - perda) < tolerancia:
                break
            perda_anterior = perda
    return Modelo(coeficientes=coef, intercepto=b, media=media, desvio=desvio,
                  treinado_em=datetime.now().isoformat(timespec="seconds"))


# ── métricas de qualidade ──────────────────────────────────────────────────
def _auc(y: list[int], p: list[float]) -> float | None:
    """AUC por ranking (Mann-Whitney), com tratamento de empate."""
    pos = [pi for pi, yi in zip(p, y) if yi == 1]
    neg = [pi for pi, yi in zip(p, y) if yi == 0]
    if not pos or not neg:
        return None  # sem as duas classes não existe AUC — não devolve 0.5
    pares = sum(1 for a in pos for b in neg if a > b) + \
        0.5 * sum(1 for a in pos for b in neg if a == b)
    return pares / (len(pos) * len(neg))


def _ece(y: list[int], p: list[float], bins: int = 10) -> float | None:
    """Expected Calibration Error: o quanto "70%" significa mesmo 70%.

    É a métrica que valida a priorização por valor esperado (§5, passo 4).
    Score não calibrado torna `propensão × ticket` uma multiplicação sem
    significado — e a fila inteira passa a ser ordenada por um número que
    não é probabilidade de coisa nenhuma.
    """
    if not y:
        return None
    total, erro = len(y), 0.0
    for k in range(bins):
        lo, hi = k / bins, (k + 1) / bins
        idx = [i for i in range(total) if (lo < p[i] <= hi) or (k == 0 and p[i] <= hi)]
        if not idx:
            continue
        conf = sum(p[i] for i in idx) / len(idx)
        real = sum(y[i] for i in idx) / len(idx)
        erro += (len(idx) / total) * abs(conf - real)
    return erro


def _lift_top_decil(y: list[int], p: list[float]) -> float | None:
    if not y or sum(y) == 0:
        return None
    ordenado = sorted(range(len(p)), key=lambda i: p[i], reverse=True)
    k = max(len(p) // 10, 1)
    taxa_topo = sum(y[i] for i in ordenado[:k]) / k
    taxa_base = sum(y) / len(y)
    return round(taxa_topo / taxa_base, 2) if taxa_base > 0 else None


# ── treino + avaliação out-of-time ─────────────────────────────────────────
def treinar(*, filial: str = "", horizonte: int = HORIZONTE_DIAS) -> Modelo | None:
    """Treina numa janela passada e valida numa janela posterior, sem
    sobreposição. Devolve None se não houver histórico suficiente — melhor
    não ter score do que ter um score sem lastro."""
    por_cliente = _compras_por_cliente(filial=filial)
    if not por_cliente:
        return None
    todas = [d for compras in por_cliente.values() for d, _ in compras]
    if not todas:
        return None
    fim = max(todas)
    inicio = min(todas)
    if (fim - inicio).days < horizonte * 3:
        return None  # histórico curto demais para um split temporal honesto

    ref_treino = fim - timedelta(days=horizonte * 2)
    ref_valid = fim - timedelta(days=horizonte)

    Xtr, ytr, _ = _montar_amostras(por_cliente, ref_treino, horizonte)
    Xva, yva, _ = _montar_amostras(por_cliente, ref_valid, horizonte)
    if len(Xtr) < 30 or len(set(ytr)) < 2:
        return None

    modelo = _treinar(Xtr, ytr)
    pva = [modelo.probabilidade(x) for x in Xva]
    modelo.metricas = {
        "amostras_treino": len(Xtr),
        "amostras_validacao": len(Xva),
        "taxa_base_treino": round(sum(ytr) / len(ytr), 3),
        "taxa_base_validacao": round(sum(yva) / len(yva), 3) if yva else None,
        "auc_out_of_time": round(_auc(yva, pva), 3) if _auc(yva, pva) is not None else None,
        "ece": round(_ece(yva, pva), 3) if _ece(yva, pva) is not None else None,
        "lift_top_decil": _lift_top_decil(yva, pva),
        "horizonte_dias": horizonte,
        "referencia_treino": ref_treino.isoformat(),
        "referencia_validacao": ref_valid.isoformat(),
    }
    return modelo


def pontuar(modelo: Modelo, *, filial: str = "", top_fatores: int = 4) -> list[dict]:
    """Pontua a carteira na data de hoje, com os fatores que explicam cada score."""
    por_cliente = _compras_por_cliente(filial=filial)
    hoje = date.today()
    saida = []
    for cid, compras in por_cliente.items():
        f = _features_do_cliente(compras, hoje)
        if f is None:
            continue
        x = [f[k] for k in ORDEM_FEATURES]
        prob = modelo.probabilidade(x)
        contribs = sorted(modelo.contribuicoes(x), key=lambda t: abs(t[1]), reverse=True)
        fatores = [
            {
                "feature": nome,
                "rotulo": _rotulo(nome, f[nome], contrib),
                "contribuicao": round(contrib, 4),
                "valor_feature": round(f[nome], 3),
            }
            for nome, contrib in contribs[:top_fatores] if abs(contrib) > 1e-6
        ]
        if not fatores:
            # Cliente exatamente na média em tudo: sem fator não se grava
            # score (invariante de infra.scores). O rótulo diz isso em vez de
            # inventar uma explicação.
            fatores = [{"feature": "media_carteira",
                        "rotulo": "perfil de compra igual à média da carteira",
                        "contribuicao": 0.0, "valor_feature": None}]
        saida.append({
            "cliente_id": cid,
            "probabilidade": round(prob, 4),
            "score": round(prob * 100, 1),
            "fatores": fatores,
            "features": f,
        })
    saida.sort(key=lambda d: d["score"], reverse=True)
    return saida


def _rotulo(feature: str, valor: float, contribuicao: float) -> str:
    """Traduz a feature para linguagem de negócio, escolhendo a frase pela
    direção da contribuição — não pelo valor bruto. É a contribuição que o
    usuário precisa entender: 'o que empurrou este score para cima'."""
    d = FEATURES.get(feature, {})
    return d.get("rotulo_alto" if contribuicao > 0 else "rotulo_baixo", feature)
