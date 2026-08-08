import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: { port: 5273, open: false },
  /* `chunkSizeWarningLimit` fica no padrão do Vite (500KB) de propósito. Eu
     já o levantei para 900 uma vez, e o efeito foi calar o aviso justamente
     quando um import estático dobrou o bundle inicial — o alarme funcionou e
     não tinha ninguém escutando. Hoje o maior chunk é o do Recharts (410KB),
     então o padrão cobre tudo sem ruído: se algo passar de 500KB, é regressão
     de verdade e o build avisa. */
  build: { outDir: "dist", sourcemap: true },
});
