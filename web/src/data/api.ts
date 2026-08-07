/**
 * api.ts — cliente do backend Vendalytics (FastAPI).
 *
 * Distinto dos clientes de IBGE/BrasilAPI por três razões que mudam o
 * comportamento:
 *
 *   1. **É autenticado.** Todo request leva o JWT. Um 401 não é "erro de
 *      rede": é sessão expirada, e a aplicação inteira precisa saber disso ao
 *      mesmo tempo — daí o `aoExpirar`, um gancho global registrado uma vez
 *      pelo provedor de sessão.
 *   2. **Não é cacheado.** Cadastro de usuário muda porque alguém acabou de
 *      mudá-lo; servir do cache mostraria a lista velha logo depois de criar
 *      uma conta.
 *   3. **Não repete em erro.** Um POST que criou usuário e devolveu 500 na
 *      resposta não pode ser reenviado — a repetição criaria a conta duas
 *      vezes. Repetição automática é segura em GET público, não aqui.
 */
import { ApiError } from "../lib/http";

/**
 * Origem do backend.
 *
 * Em desenvolvimento o Vite roda em :5273 e o FastAPI em :8901 — origens
 * diferentes, então precisa ser absoluto. Em produção o build é servido pelo
 * próprio FastAPI, então o certo é string vazia: tudo vira caminho relativo,
 * mesma origem, sem CORS.
 *
 * O `import.meta.env.DEV` no meio disto não é enfeite. Sem ele, um build de
 * produção sem `VITE_API_URL` definida sairia apontando para
 * `http://localhost:8901` — e o app publicado tentaria falar com a máquina de
 * quem está visitando. O padrão precisa estar certo nos dois lados sem exigir
 * variável de ambiente nenhuma.
 */
const BASE =
  (import.meta.env.VITE_API_URL as string | undefined) ??
  (import.meta.env.DEV ? "http://localhost:8901" : "");

export interface Sessao {
  token: string;
  email: string;
  nome: string;
  role: "admin" | "user";
}

export interface UsuarioApi {
  email: string;
  nome: string;
  role: "admin" | "user";
  filiais: string[];
  criado_em: string;
  ultimo_acesso: string | null;
}

/* ─── Estado do token ──────────────────────────────────────────────────── */

let tokenAtual: string | null = null;
let aoExpirar: (() => void) | null = null;

export function definirToken(token: string | null): void {
  tokenAtual = token;
}

/** Registrado uma vez pelo provedor de sessão. Qualquer 401 em qualquer
 *  chamada derruba a sessão por este caminho único. */
export function aoExpirarSessao(cb: () => void): void {
  aoExpirar = cb;
}

/* ─── Núcleo ───────────────────────────────────────────────────────────── */

async function requisitar<T>(
  caminho: string,
  opts: { metodo?: string; corpo?: unknown; semAuth?: boolean } = {},
): Promise<T> {
  const { metodo = "GET", corpo, semAuth = false } = opts;
  const url = `${BASE}${caminho}`;

  const headers: Record<string, string> = { Accept: "application/json" };
  if (corpo !== undefined) headers["Content-Type"] = "application/json";
  if (!semAuth && tokenAtual) headers.Authorization = `Bearer ${tokenAtual}`;

  let r: Response;
  try {
    r = await fetch(url, {
      method: metodo,
      headers,
      body: corpo === undefined ? undefined : JSON.stringify(corpo),
    });
  } catch (e) {
    /* Aqui quase sempre significa "o backend não está no ar" — a mensagem
       precisa dizer isso, não "Failed to fetch". */
    throw new ApiError(
      e instanceof Error ? e.message : String(e),
      { status: null, url, repetivel: false },
    );
  }

  if (r.status === 401 && !semAuth) {
    aoExpirar?.();
    throw new ApiError("sessão expirada", { status: 401, url });
  }

  if (!r.ok) {
    /* O FastAPI devolve o motivo em `detail`. Perder isso obrigaria o usuário
       a adivinhar por que a criação falhou. */
    let detalhe = `HTTP ${r.status}`;
    try {
      const corpoErro = (await r.json()) as { detail?: string | { msg?: string }[] };
      if (typeof corpoErro.detail === "string") detalhe = corpoErro.detail;
      else if (Array.isArray(corpoErro.detail) && corpoErro.detail[0]?.msg)
        detalhe = corpoErro.detail[0].msg as string;
    } catch {
      /* resposta sem corpo JSON — fica o status */
    }
    throw new ApiError(detalhe, { status: r.status, url, repetivel: false });
  }

  if (r.status === 204) return undefined as T;
  return (await r.json()) as T;
}

/* ─── Autenticação ─────────────────────────────────────────────────────── */

export function entrar(email: string, senha: string): Promise<Sessao> {
  return requisitar<Sessao>("/api/auth/login", {
    metodo: "POST",
    corpo: { email, senha },
    semAuth: true,
  });
}

/** Valida um token guardado. Usado no boot: um JWT no localStorage pode ter
 *  expirado enquanto a aba estava fechada, e mostrar o dashboard para depois
 *  cair em 401 na primeira ação é pior que pedir login de novo. */
export function verificarSessao(): Promise<{
  email: string;
  name: string;
  role: "admin" | "user";
}> {
  return requisitar("/api/auth/me");
}

/* ─── Usuários ─────────────────────────────────────────────────────────── */

export async function listarUsuarios(): Promise<UsuarioApi[]> {
  const r = await requisitar<{ usuarios: UsuarioApi[] }>("/api/usuarios");
  return r.usuarios;
}

export function criarUsuario(dados: {
  email: string;
  senha: string;
  nome: string;
  role: "admin" | "user";
  filiais?: string[];
}): Promise<UsuarioApi> {
  return requisitar<UsuarioApi>("/api/usuarios", { metodo: "POST", corpo: dados });
}

export function redefinirSenha(email: string, senha: string): Promise<{ ok: boolean }> {
  return requisitar(`/api/usuarios/${encodeURIComponent(email)}/senha`, {
    metodo: "PUT",
    corpo: { senha },
  });
}

export function alterarPapel(email: string, role: "admin" | "user"): Promise<UsuarioApi> {
  return requisitar(`/api/usuarios/${encodeURIComponent(email)}/papel`, {
    metodo: "PUT",
    corpo: { role },
  });
}

export function removerUsuario(email: string): Promise<{ ok: boolean }> {
  return requisitar(`/api/usuarios/${encodeURIComponent(email)}`, { metodo: "DELETE" });
}

export function trocarPropriaSenha(
  senhaAtual: string,
  senhaNova: string,
): Promise<{ ok: boolean }> {
  return requisitar("/api/usuarios/senha", {
    metodo: "POST",
    corpo: { senha_atual: senhaAtual, senha_nova: senhaNova },
  });
}

/* ─── Análise por IA ───────────────────────────────────────────────────── */

export interface RespostaIA {
  disponivel: boolean;
  texto?: string;
  modelo?: string;
  tokens?: number;
  ancoragem?: string;
  motivo?: string;
}

/**
 * Manda os fatos JÁ CALCULADOS e recebe a leitura executiva.
 *
 * A chave da Groq mora no servidor — o navegador nunca a vê. E o modelo
 * recebe só o que está em `fatos`: o que ele escreve é redação sobre números
 * do IBGE e da Receita, não conhecimento próprio dele sobre o mercado.
 */
export function analisarComIA(contexto: string, fatos: unknown): Promise<RespostaIA> {
  return requisitar<RespostaIA>("/api/ia/analisar", {
    metodo: "POST",
    corpo: { contexto, fatos },
  });
}

export function statusIA(): Promise<{ disponivel: boolean; modelo: string }> {
  return requisitar("/api/ia/status");
}

/* ─── Agente com ferramentas ───────────────────────────────────────────── */

export interface ChamadaFerramenta {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface MensagemAgente {
  role: "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ChamadaFerramenta[];
  tool_call_id?: string;
  name?: string;
}

export interface RespostaAgente {
  disponivel: boolean;
  mensagem?: MensagemAgente;
  modelo?: string;
  tokens?: number;
  motivo?: string;
}

/**
 * Um turno do agente.
 *
 * O laço vive no cliente porque as ferramentas executam aqui, sobre os 5.570
 * municípios já carregados — mandar essa base ao servidor a cada pergunta
 * seria trafegar megabytes para responder o que o navegador já tem. O backend
 * só empresta a credencial da Groq.
 */
export function conversarComAgente(
  mensagens: MensagemAgente[],
  ferramentas: unknown[],
): Promise<RespostaAgente> {
  return requisitar<RespostaAgente>("/api/ia/agente", {
    metodo: "POST",
    corpo: { mensagens, ferramentas },
  });
}
