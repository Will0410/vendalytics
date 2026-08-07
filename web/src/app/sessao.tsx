/**
 * sessao.tsx — quem está usando a plataforma.
 *
 * ── Onde o token fica, e por quê ───────────────────────────────────────────
 * `localStorage`. Não é a opção mais segura que existe — um XSS lê de lá — mas
 * é a que corresponde ao que este sistema é: um JWT de 12h emitido pelo
 * próprio backend, para uma ferramenta interna.
 *
 * A alternativa de verdade seria cookie `HttpOnly` + `SameSite`, que XSS não
 * lê. Isso exige o backend emitindo `Set-Cookie` e proteção de CSRF — mudança
 * no servidor, não no cliente. Está registrado aqui como a evolução natural
 * quando este produto sair de uso interno, em vez de ficar implícito.
 *
 * ── O boot não confia no que está guardado ────────────────────────────────
 * Um token no localStorage pode ter expirado com a aba fechada. Montar o
 * dashboard e só descobrir isso no primeiro 401 mostra um painel vazio e
 * confuso. Por isso o boot valida contra `/api/auth/me` antes de liberar a
 * interface — e enquanto valida, mostra tela de carregamento, não o login
 * (senão a sessão válida piscaria o formulário a cada F5).
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  aoExpirarSessao,
  definirToken,
  entrar as entrarApi,
  verificarSessao,
  type Sessao,
} from "../data/api";

const CHAVE = "vendalytics:sessao";

type Estado =
  | { fase: "verificando" }
  | { fase: "anonimo"; motivo: string | null }
  | { fase: "autenticado"; sessao: Sessao };

interface ContextoSessao {
  estado: Estado;
  sessao: Sessao | null;
  ehAdmin: boolean;
  entrar: (email: string, senha: string) => Promise<void>;
  sair: () => void;
}

const Ctx = createContext<ContextoSessao | null>(null);

function lerGuardada(): Sessao | null {
  try {
    const bruto = localStorage.getItem(CHAVE);
    if (!bruto) return null;
    const s = JSON.parse(bruto) as Sessao;
    return s?.token && s?.email ? s : null;
  } catch {
    return null;
  }
}

function guardar(s: Sessao | null): void {
  try {
    if (s) localStorage.setItem(CHAVE, JSON.stringify(s));
    else localStorage.removeItem(CHAVE);
  } catch {
    /* storage bloqueado — a sessão vira só-memória, some no F5 */
  }
}

export function ProvedorSessao({ children }: { children: ReactNode }) {
  const [estado, setEstado] = useState<Estado>({ fase: "verificando" });

  const sair = useCallback((motivo: string | null = null) => {
    definirToken(null);
    guardar(null);
    setEstado({ fase: "anonimo", motivo });
  }, []);

  /* Um 401 em QUALQUER chamada cai aqui. Registrado uma vez, num lugar só —
     sem isto, cada módulo teria que tratar expiração por conta própria. */
  useEffect(() => {
    aoExpirarSessao(() => sair("Sua sessão expirou. Entre novamente."));
  }, [sair]);

  useEffect(() => {
    const guardada = lerGuardada();
    if (!guardada) {
      setEstado({ fase: "anonimo", motivo: null });
      return;
    }

    definirToken(guardada.token);
    let vivo = true;

    verificarSessao()
      .then((u) => {
        if (!vivo) return;
        /* O servidor é a fonte de verdade sobre papel: um usuário rebaixado
           de admin para user com o token ainda válido não pode continuar
           vendo a tela de administração por causa do que está no localStorage. */
        setEstado({
          fase: "autenticado",
          sessao: { ...guardada, role: u.role, nome: u.name || guardada.nome },
        });
      })
      .catch(() => {
        if (!vivo) return;
        definirToken(null);
        guardar(null);
        setEstado({ fase: "anonimo", motivo: null });
      });

    return () => {
      vivo = false;
    };
  }, []);

  const entrar = useCallback(async (email: string, senha: string) => {
    const s = await entrarApi(email, senha);
    definirToken(s.token);
    guardar(s);
    setEstado({ fase: "autenticado", sessao: s });
  }, []);

  const valor = useMemo<ContextoSessao>(
    () => ({
      estado,
      sessao: estado.fase === "autenticado" ? estado.sessao : null,
      ehAdmin: estado.fase === "autenticado" && estado.sessao.role === "admin",
      entrar,
      sair: () => sair(null),
    }),
    [estado, entrar, sair],
  );

  return <Ctx.Provider value={valor}>{children}</Ctx.Provider>;
}

export function useSessao(): ContextoSessao {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useSessao precisa estar dentro de <ProvedorSessao>");
  return ctx;
}
