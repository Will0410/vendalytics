/**
 * main.tsx — a raiz, e o único lugar que decide de onde vêm os assets.
 *
 * ── A escolha do provedor de assets ────────────────────────────────────────
 * O padrão é o SVG autoral: nítido, offline, sem chave, determinístico.
 * Havendo `VITE_ASSET_PROXY_URL` (ou, em desenvolvimento, `VITE_GEMINI_API_KEY`),
 * o Nano Banana entra na frente e o SVG passa a ser a rede de segurança —
 * `fallbackChain` garante que uma chave expirada ou uma cota estourada nunca
 * deixem a interface sem ícone.
 *
 * Trocar de provedor é esta linha e só ela. Nenhum componente sabe a diferença.
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { globalStyles } from "./stitches.config";
import { AssetProvider, fallbackChain } from "./assets/AssetProvider";
import { svgSource } from "./assets/svgSource";
import { createNanoBananaSource, nanoBananaConfigurado } from "./assets/nanoBanana";
import { ProvedorFiltros } from "./app/filtros";
import { ProvedorSessao } from "./app/sessao";

globalStyles();

const fonteDeAssets = nanoBananaConfigurado()
  ? fallbackChain(createNanoBananaSource(), svgSource)
  : svgSource;

const raiz = document.getElementById("root");
if (!raiz) throw new Error("#root não encontrado no index.html");

createRoot(raiz).render(
  <StrictMode>
    <AssetProvider source={fonteDeAssets}>
      {/* A sessão envolve os filtros: a tela de login precisa dos assets
          (logo) mas não do contexto de filtro, e todo módulo autenticado
          precisa dos dois. */}
      <ProvedorSessao>
        <ProvedorFiltros>
          <App />
        </ProvedorFiltros>
      </ProvedorSessao>
    </AssetProvider>
  </StrictMode>,
);
