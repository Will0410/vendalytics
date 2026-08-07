/**
 * useAsync.ts — estado de uma operação assíncrona, com aborto correto.
 *
 * O detalhe que justifica o hook: quando o usuário troca de UF, a requisição
 * anterior é abortada E descartada. Sem isso, a resposta lenta da UF antiga
 * chega depois e sobrescreve a nova — a tela mostra São Paulo enquanto o
 * filtro diz Bahia. É o bug de corrida clássico de dashboard com filtro.
 */
import { useCallback, useEffect, useRef, useState } from "react";

export type EstadoAsync<T> =
  | { status: "ocioso" }
  | { status: "carregando" }
  | { status: "pronto"; dado: T }
  | { status: "erro"; erro: unknown };

export interface RetornoAsync<T> {
  estado: EstadoAsync<T>;
  /** Refaz a operação ignorando o cache do hook (o de rede continua valendo). */
  recarregar: () => void;
  /** Atalhos de leitura — evitam `estado.status === "pronto" && estado.dado` em toda tela. */
  dado: T | null;
  carregando: boolean;
  erro: unknown;
}

export function useAsync<T>(
  operacao: (signal: AbortSignal) => Promise<T>,
  deps: readonly unknown[],
  opts: { habilitado?: boolean } = {},
): RetornoAsync<T> {
  const { habilitado = true } = opts;
  const [estado, setEstado] = useState<EstadoAsync<T>>({ status: "ocioso" });
  const [gatilho, setGatilho] = useState(0);

  /* A operação muda de identidade a cada render; guardá-la numa ref mantém o
     efeito preso às deps declaradas, não à função. */
  const opRef = useRef(operacao);
  opRef.current = operacao;

  useEffect(() => {
    if (!habilitado) {
      setEstado({ status: "ocioso" });
      return;
    }

    const ctrl = new AbortController();
    let vivo = true;
    setEstado({ status: "carregando" });

    opRef
      .current(ctrl.signal)
      .then((dado) => {
        if (vivo && !ctrl.signal.aborted) setEstado({ status: "pronto", dado });
      })
      .catch((erro: unknown) => {
        /* Aborto é troca de filtro ou desmontagem, não falha — não pinta erro. */
        if (!vivo || ctrl.signal.aborted) return;
        setEstado({ status: "erro", erro });
      });

    return () => {
      vivo = false;
      ctrl.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, habilitado, gatilho]);

  const recarregar = useCallback(() => setGatilho((g) => g + 1), []);

  return {
    estado,
    recarregar,
    dado: estado.status === "pronto" ? estado.dado : null,
    carregando: estado.status === "carregando",
    erro: estado.status === "erro" ? estado.erro : null,
  };
}
