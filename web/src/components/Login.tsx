/**
 * Login.tsx — a porta de entrada.
 *
 * ── Decisões que não são estéticas ─────────────────────────────────────────
 *
 * **A mensagem de erro não distingue "e-mail não existe" de "senha errada".**
 * O backend já responde "e-mail ou senha inválidos" para os dois casos, e a
 * tela mantém isso. Uma mensagem específica transformaria o formulário num
 * oráculo de quem tem conta na instalação.
 *
 * **`autoComplete` correto nos dois campos.** Sem `username`/`current-password`
 * o gerenciador de senhas do navegador não salva nem preenche, e o usuário
 * acaba escolhendo uma senha memorizável — pior que qualquer política de
 * complexidade que a tela pudesse impor.
 *
 * **O botão desabilita durante o envio.** Duplo clique num formulário de login
 * gera duas tentativas, e duas tentativas contam duas vezes na trilha de
 * auditoria como se fossem duas pessoas.
 */
import { useState, type FormEvent } from "react";
import { styled, animations } from "../stitches.config";
import { Asset } from "../assets/AssetProvider";
import { useSessao } from "../app/sessao";
import { mensagemDeErro } from "./estados";
import { Button, Card, Heading, Input, Label, Row, Stack, Text } from "./primitives";

const Tela = styled("div", {
  minHeight: "100vh",
  display: "grid",
  gridTemplateColumns: "1fr",
  "@md": { gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr)" },
  backgroundColor: "$canvas",
});

/** Painel de marca. Some no mobile: numa tela estreita, o formulário é a
 *  única coisa que importa. */
const Vitrine = styled("div", {
  display: "none",
  position: "relative",
  overflow: "hidden",
  padding: "$10",
  flexDirection: "column",
  justifyContent: "space-between",
  backgroundColor: "$surface",
  borderRight: "1px solid $border",
  backgroundImage:
    "radial-gradient(circle at 78% 18%, rgba(79,110,247,0.20), transparent 58%), radial-gradient(circle at 12% 88%, rgba(34,211,238,0.13), transparent 52%)",
  "@md": { display: "flex" },
});

const Formulario = styled("form", {
  display: "flex",
  flexDirection: "column",
  justifyContent: "center",
  padding: "$7",
  "@md": { padding: "$10" },
});

const Caixa = styled("div", {
  width: "100%",
  maxWidth: 400,
  mx: "auto",
  "@motion": { animation: `${animations.fadeUp} 320ms cubic-bezier(0.16,1,0.3,1)` },
});

const Aviso = styled("div", {
  display: "flex",
  alignItems: "flex-start",
  gap: "$2",
  padding: "$3",
  borderRadius: "$md",
  border: "1px solid rgba(208,59,59,0.34)",
  backgroundColor: "$criticalSubtle",
});

const Girando = styled("span", {
  display: "inline-block",
  size: 14,
  border: "2px solid rgba(255,255,255,0.32)",
  borderTopColor: "#fff",
  borderRadius: "$pill",
  "@motion": { animation: `${animations.spin} 700ms linear infinite` },
});

const ITENS_VITRINE = [
  {
    figura: "10,6 mi",
    texto: "empresas formalizadas no Brasil, do Cadastro Central de Empresas do IBGE",
  },
  {
    figura: "5.570",
    texto: "municípios com população, PIB e composição setorial por CNAE",
  },
  {
    figura: "21",
    texto: "seções da CNAE 2.0 para recortar o mercado endereçável",
  },
];

export function Login() {
  const { entrar, estado } = useSessao();
  const [email, setEmail] = useState("");
  const [senha, setSenha] = useState("");
  const [erro, setErro] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);

  const motivoDaSessao = estado.fase === "anonimo" ? estado.motivo : null;

  async function aoEnviar(e: FormEvent) {
    e.preventDefault();
    if (enviando) return;
    setErro(null);
    setEnviando(true);
    try {
      await entrar(email.trim(), senha);
    } catch (erroDeLogin) {
      setErro(mensagemDeErro(erroDeLogin).titulo);
      setEnviando(false);
    }
    /* Em caso de sucesso não faz `setEnviando(false)`: o componente é
       desmontado pela troca de rota, e mexer no estado depois disso é o
       clássico aviso de "update on unmounted component". */
  }

  return (
    <Tela>
      <Vitrine>
        <Row gap={3}>
          <Asset id="logo.mark" size={34} />
          <Stack gap={0}>
            <Text size="lg" tone="primary" weight="bold" css={{ letterSpacing: "$tighter" }}>
              Vendalytics
            </Text>
            <Text size="xs" tone="muted" css={{ letterSpacing: "$wider" }}>
              SALES INTELLIGENCE
            </Text>
          </Stack>
        </Row>

        <Stack gap={7}>
          <Heading size="2xl" css={{ maxWidth: 420, lineHeight: "$snug" }}>
            Inteligência de mercado sobre dados públicos brasileiros.
          </Heading>

          <Stack gap={5}>
            {ITENS_VITRINE.map((i) => (
              <Row key={i.figura} gap={4} align="start">
                <Text
                  size="xl"
                  tone="accent"
                  weight="bold"
                  css={{ minWidth: 92, letterSpacing: "$tighter" }}
                >
                  {i.figura}
                </Text>
                <Text size="md" css={{ maxWidth: 330 }}>
                  {i.texto}
                </Text>
              </Row>
            ))}
          </Stack>
        </Stack>

        <Text size="xs" tone="muted">
          Fontes: IBGE (SIDRA e Localidades) e Receita Federal via BrasilAPI. Nenhum dado
          sintético.
        </Text>
      </Vitrine>

      <Formulario onSubmit={aoEnviar}>
        <Caixa>
          <Stack gap={6}>
            <Stack gap={2}>
              <Row gap={3} css={{ "@md": { display: "none" } }}>
                <Asset id="logo.mark" size={28} />
                <Text size="lg" tone="primary" weight="bold">
                  Vendalytics
                </Text>
              </Row>
              <Heading size="xl">Entrar na plataforma</Heading>
              <Text size="md">Use as credenciais fornecidas pelo administrador da conta.</Text>
            </Stack>

            {motivoDaSessao && !erro && (
              <Aviso css={{ borderColor: "rgba(250,178,25,0.34)", backgroundColor: "$warningSubtle" }}>
                <Text size="sm" tone="warning">
                  {motivoDaSessao}
                </Text>
              </Aviso>
            )}

            {erro && (
              <Aviso role="alert">
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
                  <circle cx="8" cy="8" r="7" stroke="#e56a6a" strokeWidth="1.4" />
                  <path d="M8 4.6v4.2" stroke="#e56a6a" strokeWidth="1.6" strokeLinecap="round" />
                  <circle cx="8" cy="11.4" r="0.9" fill="#e56a6a" />
                </svg>
                <Text size="sm" css={{ color: "#e56a6a" }}>
                  {erro}
                </Text>
              </Aviso>
            )}

            <Stack gap={4}>
              <div>
                <Label htmlFor="email">E-mail</Label>
                <Input
                  id="email"
                  type="email"
                  largura="cheia"
                  autoComplete="username"
                  placeholder="voce@empresa.com.br"
                  value={email}
                  required
                  autoFocus
                  disabled={enviando}
                  onChange={(e) => setEmail(e.currentTarget.value)}
                />
              </div>

              <div>
                <Label htmlFor="senha">Senha</Label>
                <Input
                  id="senha"
                  type="password"
                  largura="cheia"
                  autoComplete="current-password"
                  placeholder="••••••••••"
                  value={senha}
                  required
                  disabled={enviando}
                  onChange={(e) => setSenha(e.currentTarget.value)}
                />
              </div>
            </Stack>

            <Button
              type="submit"
              variante="primario"
              tamanho="lg"
              largura="cheia"
              disabled={enviando || !email.trim() || !senha}
            >
              {enviando ? (
                <>
                  <Girando aria-hidden /> Entrando…
                </>
              ) : (
                "Entrar"
              )}
            </Button>

            <Card padding="sm" tone="sunken">
              <Text size="xs" tone="muted" css={{ lineHeight: "$relaxed" }}>
                <strong style={{ color: "#94a3b8" }}>Primeiro acesso?</strong> Na primeira subida
                do servidor, um administrador é criado automaticamente com senha aleatória
                impressa uma única vez no log. Depois disso, novas contas são criadas dentro da
                plataforma, em <em>Usuários</em>.
              </Text>
            </Card>
          </Stack>
        </Caixa>
      </Formulario>
    </Tela>
  );
}
