/**
 * AnaliseIA.tsx — a leitura executiva escrita pelo modelo da Groq.
 *
 * ── A relação com a análise determinística ────────────────────────────────
 * Este painel NÃO substitui os cards de Inteligência Analítica. Eles são a
 * camada de fatos — determinísticos, auditáveis, sempre presentes, e é deles
 * que sai o payload mandado para o modelo. A IA é a camada de redação por
 * cima: costura os mesmos números numa leitura corrida.
 *
 * A ordem importa. Se a Groq estiver fora do ar, sem chave ou fora de cota, a
 * tela continua entregando a análise inteira — só sem a prosa. O contrário
 * (IA como única análise) transformaria uma indisponibilidade de terceiro
 * numa tela vazia.
 *
 * ── Custo ─────────────────────────────────────────────────────────────────
 * Cada geração é uma chamada paga. O resultado é memoizado por contexto+fatos
 * enquanto a aba viver: trocar de módulo e voltar não gera de novo, e mudar um
 * filtro (que muda os fatos) gera. O botão "Regerar" existe para o caso em
 * que o usuário quer outra redação dos mesmos números.
 */
import { useCallback, useEffect, useState } from "react";
import { styled, animations } from "../stitches.config";
import { analisarComIA, type RespostaIA } from "../data/api";
import { Asset } from "../assets/AssetProvider";
import { useSessao } from "../app/sessao";
import { mensagemDeErro } from "./estados";
import { Badge, Button, Card, Row, Stack, Text } from "./primitives";

/* Memo por sessão de aba: mesma pergunta, mesmos fatos → não paga de novo. */
const memo = new Map<string, RespostaIA>();

function chaveDe(contexto: string, fatos: unknown): string {
  const bruto = `${contexto}::${JSON.stringify(fatos)}`;
  let h = 5381;
  for (let i = 0; i < bruto.length; i++) h = ((h << 5) + h + bruto.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

const Corpo = styled(Card, {
  position: "relative",
  overflow: "hidden",
  backgroundImage:
    "linear-gradient(150deg, rgba(34,211,238,0.09) 0%, rgba(79,110,247,0.06) 34%, rgba(15,23,42,0) 68%)",
  borderColor: "$brandBorder",
});

const Prosa = styled("div", {
  display: "flex",
  flexDirection: "column",
  gap: "$4",
  maxWidth: "76ch",
  "& p": {
    margin: 0,
    fontSize: "$lg",
    lineHeight: "$relaxed",
    color: "$textPrimary",
  },
  "@motion": { animation: `${animations.fadeUp} 320ms cubic-bezier(0.16,1,0.3,1)` },
});

const Girando = styled("span", {
  display: "inline-block",
  size: 13,
  border: "2px solid rgba(34,211,238,0.28)",
  borderTopColor: "#22d3ee",
  borderRadius: "$pill",
  "@motion": { animation: `${animations.spin} 700ms linear infinite` },
});

/** Enquanto o modelo escreve, linhas de texto fantasma no lugar da prosa —
 *  a caixa já ocupa a altura final, então nada salta quando o texto chega. */
const LinhaFantasma = styled("div", {
  height: 13,
  borderRadius: "$pill",
  background:
    "linear-gradient(90deg, rgba(34,211,238,0.05) 0%, rgba(34,211,238,0.15) 50%, rgba(34,211,238,0.05) 100%)",
  backgroundSize: "420px 100%",
  "@motion": { animation: `${animations.shimmer} 1.5s linear infinite` },
});

export function AnaliseIA({
  contexto,
  fatos,
  /** Sem fatos ainda (dado carregando), o painel nem tenta. */
  pronto = true,
}: {
  contexto: string;
  fatos: unknown;
  pronto?: boolean;
}) {
  const { sessao } = useSessao();
  const [resposta, setResposta] = useState<RespostaIA | null>(null);
  const [carregando, setCarregando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  const chave = pronto ? chaveDe(contexto, fatos) : null;

  const gerar = useCallback(
    async (forcar = false) => {
      if (!chave || !sessao) return;
      if (!forcar) {
        const guardado = memo.get(chave);
        if (guardado) {
          setResposta(guardado);
          return;
        }
      }
      setCarregando(true);
      setErro(null);
      try {
        const r = await analisarComIA(contexto, fatos);
        memo.set(chave, r);
        setResposta(r);
      } catch (e) {
        setErro(mensagemDeErro(e).titulo);
      } finally {
        setCarregando(false);
      }
    },
    [chave, contexto, fatos, sessao],
  );

  useEffect(() => {
    if (!chave) return;
    const guardado = memo.get(chave);
    if (guardado) {
      setResposta(guardado);
      return;
    }
    setResposta(null);
    void gerar();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chave]);

  if (!pronto) return null;

  const indisponivel = resposta && !resposta.disponivel;

  return (
    <Corpo padding="lg">
      <Stack gap={5}>
        <Row justify="between" align="start" gap={4} wrap>
          <Row gap={4} align="center">
            <Asset id="illustration.insight" size={44} />
            <Stack gap={1}>
              <Row gap={2} align="center" wrap>
                <Text size="lg" tone="primary" weight="semibold">
                  Leitura do analista de IA
                </Text>
                {resposta?.modelo && (
                  <Badge tone="acento" title="Modelo que redigiu este texto">
                    {resposta.modelo}
                  </Badge>
                )}
                {carregando && (
                  <Row gap={2} align="center">
                    <Girando aria-hidden />
                    <Text size="sm" tone="muted">
                      redigindo…
                    </Text>
                  </Row>
                )}
              </Row>
              <Text size="sm" tone="muted">
                O modelo recebe os números já calculados a partir do IBGE e da Receita Federal.
                Ele redige — não calcula, não estima e não completa lacuna com conhecimento
                próprio.
              </Text>
            </Stack>
          </Row>

          {resposta?.disponivel && (
            <Button
              variante="fantasma"
              tamanho="sm"
              disabled={carregando}
              onClick={() => gerar(true)}
              title="Pede outra redação sobre exatamente os mesmos números"
            >
              Regerar
            </Button>
          )}
        </Row>

        {carregando && !resposta && (
          <Stack gap={3} css={{ maxWidth: "76ch" }}>
            {[96, 100, 88, 72, 94, 60].map((largura, i) => (
              <LinhaFantasma key={i} css={{ width: `${largura}%` }} />
            ))}
          </Stack>
        )}

        {erro && (
          <Row gap={3} align="center" wrap>
            <Text size="sm" tone="critical">
              {erro}
            </Text>
            <Button variante="secundario" tamanho="sm" onClick={() => gerar(true)}>
              Tentar de novo
            </Button>
          </Row>
        )}

        {indisponivel && (
          <Stack gap={2}>
            <Text size="sm" tone="warning">
              A camada de IA não está disponível: {resposta?.motivo}
            </Text>
            <Text size="sm" tone="muted">
              A análise determinística acima continua completa — ela é a fonte dos fatos, não um
              resumo do que a IA escreveu.
            </Text>
          </Stack>
        )}

        {resposta?.disponivel && resposta.texto && (
          <>
            <Prosa>
              {resposta.texto
                .split(/\n{2,}/)
                .map((p) => p.trim())
                .filter(Boolean)
                .map((p, i) => (
                  <p key={i}>{p}</p>
                ))}
            </Prosa>

            <Row gap={3} wrap css={{ borderTop: "1px solid $border", paddingTop: "$4" }}>
              <Text size="xs" tone="muted">
                {resposta.ancoragem}
              </Text>
              {resposta.tokens != null && (
                <Text size="xs" tone="muted" mono>
                  {resposta.tokens} tokens
                </Text>
              )}
            </Row>
          </>
        )}
      </Stack>
    </Corpo>
  );
}
