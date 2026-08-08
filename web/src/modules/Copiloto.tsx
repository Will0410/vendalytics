/**
 * Copiloto.tsx — pergunta em português, resposta com número real.
 *
 * ── Como funciona, e por que isso importa ─────────────────────────────────
 * O laço é: pergunta → o modelo escolhe uma ferramenta → **o navegador
 * executa** sobre os 5.570 municípios que já estão em memória → o resultado
 * volta para o modelo → ele redige.
 *
 * O modelo nunca recebe a base. Recebe funções. É a diferença entre um
 * assistente que *lembra* de dado e um que *consulta* dado — e é o que
 * permite prometer que nenhum número desta tela foi inventado.
 *
 * Cada chamada de ferramenta fica visível na conversa, com os argumentos que
 * o modelo escolheu. Um copiloto que responde sem mostrar o caminho é uma
 * caixa-preta que ninguém audita e, por isso, ninguém usa em decisão de
 * investimento.
 *
 * ── Limite de rodadas ─────────────────────────────────────────────────────
 * No máximo 4 idas ao modelo por pergunta. Sem teto, um modelo confuso
 * encadeia chamadas indefinidamente — cada uma custando tokens e segundos.
 */
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { styled, animations } from "../stitches.config";
import { conversarComAgente, type MensagemAgente } from "../data/api";
import { SECOES } from "../data/cnae";
import { useFiltros } from "../app/filtros";
import { useUniverso } from "../app/useUniverso";
import { executarFerramenta, FERRAMENTAS } from "../domain/ferramentas";
import { Asset } from "../assets/AssetProvider";
import { mensagemDeErro } from "../components/estados";
import { Badge, Button, Input, Row, Stack, Text } from "../components/primitives";

const MAX_RODADAS = 4;

const nomeSecao = (letra: string) => SECOES.find((s) => s.letra === letra);

/* ─── Layout ───────────────────────────────────────────────────────────── */

const Palco = styled("div", {
  display: "flex",
  flexDirection: "column",
  height: "calc(100vh - 210px)",
  minHeight: 520,
});

const Conversa = styled("div", {
  flex: 1,
  overflowY: "auto",
  display: "flex",
  flexDirection: "column",
  gap: "$5",
  padding: "$2 $1 $6",
});

const Balao = styled("div", {
  maxWidth: "min(760px, 88%)",
  padding: "$4 $5",
  borderRadius: "$xl",
  lineHeight: "$relaxed",
  fontSize: "$lg",
  whiteSpace: "pre-wrap",
  "@motion": { animation: `${animations.fadeUp} 260ms cubic-bezier(0.16,1,0.3,1)` },
  variants: {
    de: {
      usuario: {
        alignSelf: "flex-end",
        backgroundColor: "$brand",
        color: "#fff",
        borderBottomRightRadius: "$sm",
      },
      agente: {
        alignSelf: "flex-start",
        backgroundColor: "$surfaceRaised",
        color: "$textPrimary",
        border: "1px solid $border",
        borderBottomLeftRadius: "$sm",
      },
      erro: {
        alignSelf: "flex-start",
        backgroundColor: "$criticalSubtle",
        color: "#e56a6a",
        border: "1px solid rgba(208,59,59,0.34)",
      },
    },
  },
});

/** A chamada de ferramenta aparece na conversa — é a prova de que o número
 *  veio de uma consulta, não da memória do modelo. */
const Passo = styled("div", {
  alignSelf: "flex-start",
  display: "flex",
  alignItems: "center",
  gap: "$2",
  padding: "$2 $3",
  borderRadius: "$md",
  border: "1px dashed rgba(34,211,238,0.34)",
  backgroundColor: "$accentSubtle",
  fontFamily: "$mono",
  fontSize: "$sm",
  color: "$accent",
  maxWidth: "min(760px, 88%)",
  overflowX: "auto",
  whiteSpace: "nowrap",
});

const Rodape = styled("form", {
  display: "flex",
  gap: "$3",
  paddingTop: "$4",
  borderTop: "1px solid $border",
  flexShrink: 0,
});

const Girando = styled("span", {
  display: "inline-block",
  size: 13,
  border: "2px solid rgba(34,211,238,0.28)",
  borderTopColor: "#22d3ee",
  borderRadius: "$pill",
  "@motion": { animation: `${animations.spin} 700ms linear infinite` },
});

const Sugestao = styled("button", {
  border: "1px solid $border",
  background: "transparent",
  borderRadius: "$pill",
  px: "$4",
  py: "$2",
  color: "$textSecondary",
  fontSize: "$md",
  cursor: "pointer",
  textAlign: "left",
  "&:hover": { borderColor: "$brandBorder", color: "$textPrimary", backgroundColor: "$brandSubtle" },
});

/* ─── Itens exibidos ───────────────────────────────────────────────────── */

type Item =
  | { tipo: "usuario"; texto: string }
  | { tipo: "agente"; texto: string; tokens?: number }
  | { tipo: "erro"; texto: string }
  | { tipo: "ferramenta"; nome: string; args: string; resumo: string };

const SUGESTOES = [
  "Quais praças de Santa Catarina com mais de 50 mil habitantes estão crescendo neste setor?",
  "Compare Ribeirão Preto, Campinas e São José do Rio Preto",
  "Onde encontro praças subexploradas com bom poder de compra no Nordeste?",
  "Quantas empresas do setor existem no Paraná e quantas praças concentram 80%?",
];

export function Copiloto() {
  const { filtros } = useFiltros();
  const setor = filtros.secoes[0] ?? "G";
  const { universo, carregando, refinando } = useUniverso(setor);

  const [itens, setItens] = useState<Item[]>([]);
  const [entrada, setEntrada] = useState("");
  const [pensando, setPensando] = useState(false);
  const fim = useRef<HTMLDivElement>(null);

  /* Mantém a conversa crua para o modelo — separada do que a tela mostra,
     porque o modelo precisa dos `tool_calls` e o usuário não. */
  const historico = useRef<MensagemAgente[]>([]);

  useEffect(() => {
    fim.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [itens, pensando]);

  /* Trocar de setor invalida a conversa: as respostas anteriores foram
     calculadas sobre outro recorte e passariam a mentir por contexto. */
  useEffect(() => {
    historico.current = [];
    setItens([]);
  }, [setor]);

  const perguntar = useCallback(
    async (pergunta: string) => {
      if (!pergunta.trim() || pensando) return;

      setItens((a) => [...a, { tipo: "usuario", texto: pergunta }]);
      historico.current.push({ role: "user", content: pergunta });
      setEntrada("");
      setPensando(true);

      try {
        for (let rodada = 0; rodada < MAX_RODADAS; rodada++) {
          const r = await conversarComAgente(historico.current, FERRAMENTAS as unknown as unknown[]);

          if (!r.disponivel || !r.mensagem) {
            setItens((a) => [
              ...a,
              { tipo: "erro", texto: r.motivo ?? "A camada de IA não está disponível." },
            ]);
            return;
          }

          const msg = r.mensagem;
          historico.current.push(msg);

          const chamadas = msg.tool_calls ?? [];
          if (chamadas.length === 0) {
            setItens((a) => [
              ...a,
              { tipo: "agente", texto: msg.content ?? "(sem resposta)", tokens: r.tokens },
            ]);
            return;
          }

          for (const c of chamadas) {
            let args: Record<string, unknown> = {};
            try {
              args = JSON.parse(c.function.arguments || "{}");
            } catch {
              /* Argumento malformado é falha do modelo, não do usuário — segue
                 com objeto vazio e a ferramenta reclama do que faltou. */
            }

            const res = executarFerramenta(c.function.name, args, { universo, setor });

            const resumo = res.ok
              ? (() => {
                  const d = res.dados as Record<string, unknown>;
                  const n =
                    (d?.pracas as unknown[])?.length ??
                    (d?.semelhantes as unknown[])?.length ??
                    (d?.comparacao as unknown[])?.length;
                  return n != null ? `${n} resultados` : "ok";
                })()
              : (res.erro ?? "falhou");

            setItens((a) => [
              ...a,
              {
                tipo: "ferramenta",
                nome: c.function.name,
                args: JSON.stringify(args),
                resumo,
              },
            ]);

            historico.current.push({
              role: "tool",
              tool_call_id: c.id,
              name: c.function.name,
              content: JSON.stringify(res.ok ? res.dados : { erro: res.erro }),
            });

            /* Recusa permanente encerra a conversa aqui, com o motivo na tela.
               Devolver ao modelo só faria ele tentar de novo com outro
               argumento — foi o comportamento medido ao vivo — e queimar as
               rodadas restantes para chegar a "tente uma pergunta mais
               específica", que não explica nada. */
            if (res.definitivo) {
              setItens((a) => [
                ...a,
                { tipo: "agente", texto: res.erro ?? "Consulta não aplicável." },
              ]);
              return;
            }
          }
        }

        setItens((a) => [
          ...a,
          {
            tipo: "erro",
            texto: `O agente encadeou ${MAX_RODADAS} consultas sem concluir. Tente uma pergunta mais específica.`,
          },
        ]);
      } catch (e) {
        setItens((a) => [...a, { tipo: "erro", texto: mensagemDeErro(e).titulo }]);
      } finally {
        setPensando(false);
      }
    },
    [pensando, universo, setor],
  );

  const pronto = !carregando && universo.pracas.length > 0;

  return (
    <Palco>
      <Row justify="between" align="center" gap={4} wrap css={{ paddingBottom: "$4" }}>
        <Row gap={3} align="center">
          <Asset id="illustration.insight" size={34} />
          <Stack gap={0}>
            <Text size="lg" tone="primary" weight="semibold">
              Copiloto de Mercado
            </Text>
            <Text size="sm" tone="muted">
              Pergunte em português. Cada número vem de uma consulta aos {" "}
              {universo.pracas.length ? universo.pracas.length.toLocaleString("pt-BR") : "5.570"}{" "}
              municípios do IBGE — o modelo não tem dado na memória.
            </Text>
          </Stack>
        </Row>
        <Row gap={2} align="center">
          {refinando && <Badge tone="neutro">série histórica carregando…</Badge>}
          {!pronto && <Badge tone="atencao">carregando o IBGE…</Badge>}
          <Text size="xs" tone="muted">
            Setor
          </Text>
          <Badge tone="acento" tamanho="md">
            {nomeSecao(setor)?.curto ?? setor}
          </Badge>
        </Row>
      </Row>

      <Conversa>
        {itens.length === 0 && (
          <Stack gap={4} css={{ maxWidth: 720, marginTop: "$6" }}>
            <Text size="md" tone="muted">
              O setor analisado vem do filtro de CNAE do cabeçalho. Experimente:
            </Text>
            <Stack gap={2}>
              {SUGESTOES.map((s) => (
                <Sugestao key={s} onClick={() => perguntar(s)} disabled={!pronto}>
                  {s}
                </Sugestao>
              ))}
            </Stack>
          </Stack>
        )}

        {itens.map((it, i) => {
          if (it.tipo === "ferramenta") {
            return (
              <Passo key={i} title={`Argumentos: ${it.args}`}>
                <span>⚙</span>
                <span>
                  {it.nome}({it.args.length > 90 ? it.args.slice(0, 90) + "…" : it.args}) →{" "}
                  {it.resumo}
                </span>
              </Passo>
            );
          }
          return (
            <Balao key={i} de={it.tipo === "usuario" ? "usuario" : it.tipo === "erro" ? "erro" : "agente"}>
              {it.texto}
              {it.tipo === "agente" && it.tokens != null && (
                <Text size="xs" tone="muted" mono css={{ marginTop: "$3" }}>
                  {it.tokens} tokens · números obtidos por consulta, não gerados pelo modelo
                </Text>
              )}
            </Balao>
          );
        })}

        {pensando && (
          <Row gap={2} align="center" css={{ alignSelf: "flex-start", paddingLeft: "$2" }}>
            <Girando aria-hidden />
            <Text size="sm" tone="muted">
              consultando…
            </Text>
          </Row>
        )}

        <div ref={fim} />
      </Conversa>

      <Rodape
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          perguntar(entrada);
        }}
      >
        <Input
          largura="cheia"
          placeholder={
            pronto ? "Pergunte sobre praças, setores, crescimento…" : "Carregando os dados do IBGE…"
          }
          value={entrada}
          disabled={!pronto || pensando}
          onChange={(e) => setEntrada(e.currentTarget.value)}
        />
        <Button type="submit" variante="primario" disabled={!pronto || pensando || !entrada.trim()}>
          {pensando ? "…" : "Perguntar"}
        </Button>
        {itens.length > 0 && (
          <Button
            type="button"
            variante="fantasma"
            disabled={pensando}
            onClick={() => {
              historico.current = [];
              setItens([]);
            }}
          >
            Limpar
          </Button>
        )}
      </Rodape>
    </Palco>
  );
}
