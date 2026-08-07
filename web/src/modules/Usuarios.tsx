/**
 * Usuarios.tsx — administração de contas de acesso.
 *
 * ── A senha aparece UMA vez, e a tela é honesta sobre isso ─────────────────
 * O backend guarda só o hash bcrypt: nem ele consegue recuperar a senha
 * depois. Então, ao criar uma conta, a senha é exibida num painel destacado
 * com um botão de copiar e um aviso explícito de que não será mostrada de
 * novo. Fingir que dá para consultar depois faria o admin fechar a tela e
 * perder a credencial que ele acabou de gerar.
 *
 * ── Gerador de senha ──────────────────────────────────────────────────────
 * Usa `crypto.getRandomValues`, não `Math.random`. `Math.random` não é
 * criptograficamente seguro e é previsível a partir do estado interno — em
 * gerador de credencial isso não é detalhe acadêmico.
 *
 * ── As travas ficam no servidor ───────────────────────────────────────────
 * "Não remover o último admin", "não remover a si mesmo", "senha mínima" são
 * validadas em `modules/usuarios.py`. A tela desabilita os botões
 * correspondentes por cortesia, mas quem garante é o backend — uma trava só
 * de interface é contornada com o DevTools aberto.
 */
import {
  useCallback,
  useMemo,
  useState,
  type ChangeEvent,
  type Dispatch,
  type SetStateAction,
} from "react";
import { styled } from "../stitches.config";
import {
  alterarPapel,
  criarUsuario,
  listarUsuarios,
  redefinirSenha,
  removerUsuario,
  trocarPropriaSenha,
  type UsuarioApi,
} from "../data/api";
import { useAsync } from "../lib/useAsync";
import { useSessao } from "../app/sessao";
import { Secao } from "../components/cards";
import { EstadoErro, SkeletonTabela, mensagemDeErro } from "../components/estados";
import {
  Badge,
  Button,
  Card,
  Grid,
  Input,
  Label,
  Row,
  Select,
  Stack,
  Tabela,
  TabelaWrap,
  Td,
  Text,
  Th,
} from "../components/primitives";

/* ─── Geração de senha ─────────────────────────────────────────────────── */

/* Sem I, l, O, 0, 1: a senha vai ser transcrita por uma pessoa a partir da
   tela, e esses caracteres são a origem da maior parte dos "não consigo
   entrar" que na verdade são erro de leitura. */
const ALFABETO = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789#@%+=?";

function gerarSenha(tamanho = 16): string {
  const bytes = new Uint32Array(tamanho);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => ALFABETO[b % ALFABETO.length]).join("");
}

const SENHA_MINIMA = 10;

/* ─── Apresentação ─────────────────────────────────────────────────────── */

const CaixaSenha = styled("div", {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "$3",
  padding: "$3 $4",
  borderRadius: "$md",
  border: "1px dashed rgba(34,211,238,0.4)",
  backgroundColor: "$accentSubtle",
  "& code": {
    fontFamily: "$mono",
    fontSize: "$lg",
    color: "$accent",
    letterSpacing: "0.06em",
    wordBreak: "break-all",
  },
});

function dataCurta(iso: string | null): string {
  if (!iso) return "nunca";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "—";
  return new Date(t).toLocaleDateString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}

/**
 * Handler de campo controlado dentro de um objeto de estado.
 *
 * Existe por causa de um comportamento do React que já quebrou esta tela: o
 * `SyntheticEvent` tem `currentTarget` anulado assim que o handler retorna, e
 * um **updater funcional** (`set(s => ...)`) roda DEPOIS disso. Ler o evento
 * de dentro do updater — `set((f) => ({ ...f, nome: e.currentTarget.value }))`
 * — lança "Cannot read properties of null (reading 'value')" logo na primeira
 * tecla, e o formulário inteiro desmonta na fronteira de erro.
 *
 * Aqui o valor é lido no corpo do handler, enquanto o evento ainda é válido, e
 * só então entra no updater. Passar por este helper elimina a classe do
 * problema em vez de corrigir ocorrência por ocorrência.
 */
function campoDe<T>(set: Dispatch<SetStateAction<T>>, chave: keyof T) {
  return (e: ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    const valor = e.currentTarget.value;
    set((s) => ({ ...s, [chave]: valor }));
  };
}

/* ─── Módulo ───────────────────────────────────────────────────────────── */

export function Usuarios() {
  const { sessao, ehAdmin } = useSessao();

  const lista = useAsync(() => listarUsuarios(), [], { habilitado: ehAdmin });

  const [form, setForm] = useState({
    email: "",
    nome: "",
    senha: gerarSenha(),
    role: "user" as "admin" | "user",
  });
  const [salvando, setSalvando] = useState(false);
  const [erroForm, setErroForm] = useState<string | null>(null);
  const [criada, setCriada] = useState<{ email: string; senha: string } | null>(null);
  const [copiado, setCopiado] = useState(false);
  const [ocupado, setOcupado] = useState<string | null>(null);

  const [minhaSenha, setMinhaSenha] = useState({ atual: "", nova: "" });
  const [statusMinhaSenha, setStatusMinhaSenha] = useState<
    { tipo: "ok" | "erro"; texto: string } | null
  >(null);

  const admins = useMemo(
    () => (lista.dado ?? []).filter((u) => u.role === "admin").length,
    [lista.dado],
  );

  const copiar = useCallback(async (texto: string) => {
    try {
      await navigator.clipboard.writeText(texto);
      setCopiado(true);
      setTimeout(() => setCopiado(false), 1800);
    } catch {
      /* clipboard bloqueado (http sem localhost) — a senha continua visível
         na tela para transcrição manual, então não é um caminho quebrado. */
    }
  }, []);

  async function aoCriar(e: React.FormEvent) {
    e.preventDefault();
    if (salvando) return;
    setErroForm(null);
    setSalvando(true);
    try {
      await criarUsuario({
        email: form.email.trim(),
        nome: form.nome.trim(),
        senha: form.senha,
        role: form.role,
      });
      setCriada({ email: form.email.trim(), senha: form.senha });
      setForm({ email: "", nome: "", senha: gerarSenha(), role: "user" });
      lista.recarregar();
    } catch (err) {
      setErroForm(mensagemDeErro(err).titulo);
    } finally {
      setSalvando(false);
    }
  }

  async function comOcupado(email: string, acao: () => Promise<unknown>) {
    setOcupado(email);
    try {
      await acao();
      lista.recarregar();
    } catch (err) {
      setErroForm(mensagemDeErro(err).titulo);
    } finally {
      setOcupado(null);
    }
  }

  async function aoTrocarPropriaSenha(e: React.FormEvent) {
    e.preventDefault();
    setStatusMinhaSenha(null);
    try {
      await trocarPropriaSenha(minhaSenha.atual, minhaSenha.nova);
      setMinhaSenha({ atual: "", nova: "" });
      setStatusMinhaSenha({ tipo: "ok", texto: "Senha alterada com sucesso." });
    } catch (err) {
      setStatusMinhaSenha({ tipo: "erro", texto: mensagemDeErro(err).titulo });
    }
  }

  if (!ehAdmin) {
    /* Usuário comum não administra contas, mas precisa poder trocar a própria
       senha — negar a tela inteira o obrigaria a pedir isso ao admin. */
    return (
      <Stack gap={6} css={{ maxWidth: 520 }}>
        <Secao titulo="Minha conta" descricao={`Você está autenticado como ${sessao?.email}`}>
          <Card padding="lg">
            <form onSubmit={aoTrocarPropriaSenha}>
              <Stack gap={4}>
                <div>
                  <Label htmlFor="atual">Senha atual</Label>
                  <Input
                    id="atual"
                    type="password"
                    largura="cheia"
                    autoComplete="current-password"
                    value={minhaSenha.atual}
                    required
                    onChange={campoDe(setMinhaSenha, "atual")}
                  />
                </div>
                <div>
                  <Label htmlFor="nova">Nova senha (mínimo {SENHA_MINIMA} caracteres)</Label>
                  <Input
                    id="nova"
                    type="password"
                    largura="cheia"
                    autoComplete="new-password"
                    value={minhaSenha.nova}
                    required
                    minLength={SENHA_MINIMA}
                    onChange={campoDe(setMinhaSenha, "nova")}
                  />
                </div>
                {statusMinhaSenha && (
                  <Text size="sm" tone={statusMinhaSenha.tipo === "ok" ? "good" : "critical"}>
                    {statusMinhaSenha.texto}
                  </Text>
                )}
                <div>
                  <Button type="submit" variante="primario">
                    Alterar senha
                  </Button>
                </div>
              </Stack>
            </form>
          </Card>
        </Secao>
        <Text size="sm" tone="muted">
          A administração de contas exige perfil <strong>admin</strong>.
        </Text>
      </Stack>
    );
  }

  return (
    <Stack gap={7}>
      {/* ─── Criar conta ────────────────────────────────────────────── */}
      <Secao
        titulo="Nova conta de acesso"
        descricao="A senha é gravada como hash bcrypt — nem o servidor consegue recuperá-la depois"
      >
        <Card padding="lg">
          <form onSubmit={aoCriar}>
            <Stack gap={5}>
              <Grid cols="4">
                <div>
                  <Label htmlFor="n-email">E-mail</Label>
                  <Input
                    id="n-email"
                    type="email"
                    largura="cheia"
                    placeholder="pessoa@empresa.com.br"
                    value={form.email}
                    required
                    onChange={campoDe(setForm, "email")}
                  />
                </div>
                <div>
                  <Label htmlFor="n-nome">Nome</Label>
                  <Input
                    id="n-nome"
                    largura="cheia"
                    placeholder="Nome completo"
                    value={form.nome}
                    required
                    onChange={campoDe(setForm, "nome")}
                  />
                </div>
                <div>
                  <Label htmlFor="n-senha">Senha inicial</Label>
                  <Row gap={2}>
                    <Input
                      id="n-senha"
                      mono
                      largura="cheia"
                      value={form.senha}
                      required
                      minLength={SENHA_MINIMA}
                      onChange={campoDe(setForm, "senha")}
                    />
                    <Button
                      type="button"
                      variante="secundario"
                      title="Gerar senha aleatória (crypto.getRandomValues)"
                      onClick={() => setForm((f) => ({ ...f, senha: gerarSenha() }))}
                    >
                      Gerar
                    </Button>
                  </Row>
                </div>
                <div>
                  <Label htmlFor="n-role">Perfil</Label>
                  <Select
                    id="n-role"
                    largura="cheia"
                    value={form.role}
                    onChange={campoDe(setForm, "role")}
                  >
                    <option value="user">Usuário — opera a plataforma</option>
                    <option value="admin">Administrador — também gerencia contas</option>
                  </Select>
                </div>
              </Grid>

              {erroForm && (
                <Text size="sm" tone="critical">
                  {erroForm}
                </Text>
              )}

              {criada && (
                <Stack gap={2}>
                  <CaixaSenha>
                    <Stack gap={1}>
                      <Text size="xs" overline>
                        Credencial de {criada.email}
                      </Text>
                      <code>{criada.senha}</code>
                    </Stack>
                    <Button
                      type="button"
                      variante="secundario"
                      tamanho="sm"
                      onClick={() => copiar(`${criada.email} / ${criada.senha}`)}
                    >
                      {copiado ? "Copiado" : "Copiar"}
                    </Button>
                  </CaixaSenha>
                  <Text size="sm" tone="warning">
                    Guarde agora — esta senha não será mostrada de novo. O servidor só tem o hash.
                  </Text>
                </Stack>
              )}

              <Row gap={3}>
                <Button type="submit" variante="primario" disabled={salvando}>
                  {salvando ? "Criando…" : "Criar conta"}
                </Button>
                {criada && (
                  <Button type="button" variante="fantasma" onClick={() => setCriada(null)}>
                    Ocultar credencial
                  </Button>
                )}
              </Row>
            </Stack>
          </form>
        </Card>
      </Secao>

      {/* ─── Lista ──────────────────────────────────────────────────── */}
      <Secao
        titulo="Contas ativas"
        descricao="Todas as ações desta tela ficam registradas na trilha de auditoria"
        acoes={
          lista.dado && (
            <Row gap={2}>
              <Badge tone="marca" tamanho="md">
                {lista.dado.length} contas
              </Badge>
              <Badge tone="neutro" tamanho="md">
                {admins} {admins === 1 ? "administrador" : "administradores"}
              </Badge>
            </Row>
          )
        }
      >
        {lista.erro ? (
          <EstadoErro erro={lista.erro} aoTentar={lista.recarregar} />
        ) : (
          <Card padding="none">
            {lista.carregando && !lista.dado ? (
              <SkeletonTabela linhas={4} colunas={5} />
            ) : (
              <TabelaWrap>
                <Tabela>
                  <thead>
                    <tr>
                      <Th>Nome</Th>
                      <Th>E-mail</Th>
                      <Th>Perfil</Th>
                      <Th>Criada em</Th>
                      <Th>Último acesso</Th>
                      <Th alinhamento="direita">Ações</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {(lista.dado ?? []).map((u: UsuarioApi) => {
                      const euMesmo = u.email === sessao?.email;
                      const ultimoAdmin = u.role === "admin" && admins <= 1;
                      const travado = ocupado === u.email;

                      return (
                        <tr key={u.email}>
                          <Td enfase="forte">
                            {u.nome}
                            {euMesmo && (
                              <Badge tone="acento" css={{ marginLeft: 6 }}>
                                você
                              </Badge>
                            )}
                          </Td>
                          <Td mono>{u.email}</Td>
                          <Td>
                            <Badge tone={u.role === "admin" ? "marca" : "neutro"}>
                              {u.role === "admin" ? "Administrador" : "Usuário"}
                            </Badge>
                          </Td>
                          <Td enfase="fraca">{dataCurta(u.criado_em)}</Td>
                          <Td enfase="fraca">{dataCurta(u.ultimo_acesso)}</Td>
                          <Td alinhamento="direita">
                            <Row gap={2} justify="end">
                              <Button
                                variante="fantasma"
                                tamanho="sm"
                                disabled={travado}
                                title="Gera uma senha nova e a exibe uma única vez"
                                onClick={() => {
                                  const nova = gerarSenha();
                                  comOcupado(u.email, async () => {
                                    await redefinirSenha(u.email, nova);
                                    setCriada({ email: u.email, senha: nova });
                                  });
                                }}
                              >
                                Nova senha
                              </Button>

                              <Button
                                variante="fantasma"
                                tamanho="sm"
                                disabled={travado || ultimoAdmin}
                                title={
                                  ultimoAdmin
                                    ? "É o último administrador — promova outro antes de rebaixá-lo"
                                    : u.role === "admin"
                                      ? "Rebaixar para usuário"
                                      : "Promover a administrador"
                                }
                                onClick={() =>
                                  comOcupado(u.email, () =>
                                    alterarPapel(u.email, u.role === "admin" ? "user" : "admin"),
                                  )
                                }
                              >
                                {u.role === "admin" ? "Rebaixar" : "Promover"}
                              </Button>

                              <Button
                                variante="perigo"
                                tamanho="sm"
                                disabled={travado || euMesmo || ultimoAdmin}
                                title={
                                  euMesmo
                                    ? "Você não pode remover a própria conta"
                                    : ultimoAdmin
                                      ? "É o último administrador da instalação"
                                      : "Remover conta"
                                }
                                onClick={() => {
                                  if (
                                    confirm(
                                      `Remover ${u.nome} (${u.email})? A conta perde o acesso imediatamente.`,
                                    )
                                  ) {
                                    comOcupado(u.email, () => removerUsuario(u.email));
                                  }
                                }}
                              >
                                Remover
                              </Button>
                            </Row>
                          </Td>
                        </tr>
                      );
                    })}
                  </tbody>
                </Tabela>
              </TabelaWrap>
            )}
          </Card>
        )}
      </Secao>

      {/* ─── Própria senha ──────────────────────────────────────────── */}
      <Secao titulo="Minha senha" descricao="Exige a senha atual — um token roubado não troca a senha sozinho">
        <Card padding="lg" css={{ maxWidth: 520 }}>
          <form onSubmit={aoTrocarPropriaSenha}>
            <Stack gap={4}>
              <div>
                <Label htmlFor="a-atual">Senha atual</Label>
                <Input
                  id="a-atual"
                  type="password"
                  largura="cheia"
                  autoComplete="current-password"
                  value={minhaSenha.atual}
                  required
                  onChange={campoDe(setMinhaSenha, "atual")}
                />
              </div>
              <div>
                <Label htmlFor="a-nova">Nova senha (mínimo {SENHA_MINIMA} caracteres)</Label>
                <Input
                  id="a-nova"
                  type="password"
                  largura="cheia"
                  autoComplete="new-password"
                  value={minhaSenha.nova}
                  required
                  minLength={SENHA_MINIMA}
                  onChange={campoDe(setMinhaSenha, "nova")}
                />
              </div>
              {statusMinhaSenha && (
                <Text size="sm" tone={statusMinhaSenha.tipo === "ok" ? "good" : "critical"}>
                  {statusMinhaSenha.texto}
                </Text>
              )}
              <div>
                <Button type="submit" variante="primario">
                  Alterar minha senha
                </Button>
              </div>
            </Stack>
          </form>
        </Card>
      </Secao>
    </Stack>
  );
}
