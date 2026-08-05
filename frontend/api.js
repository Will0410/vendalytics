// api.js — fetch compartilhado por todas as páginas autenticadas: token,
// timeout real e mensagem de erro clara. Antes cada página tinha sua
// própria cópia de `api()` sem timeout nenhum — se o servidor demorasse
// (ex.: treinando o modelo de propensão pela primeira vez, caro em CPU
// limitada como a do Render free tier), a tela ficava presa em
// "Carregando..." para sempre, sem erro, sem retry, sem explicação.
const TOKEN = localStorage.getItem("vendalytics_token");
if (!TOKEN && !location.pathname.endsWith("login.html")) location.href = "login.html";

const API_TIMEOUT_MS = 25000;

async function api(path, opcoes = {}) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
  try {
    const r = await fetch(path, {
      ...opcoes,
      headers: { Authorization: "Bearer " + TOKEN, "Content-Type": "application/json", ...(opcoes.headers || {}) },
      signal: controller.signal,
    });
    if (r.status === 401) { localStorage.clear(); location.href = "login.html"; throw new Error("sessão expirada"); }
    if (!r.ok) throw new Error((await r.text().catch(() => "")) || `erro ${r.status}`);
    return await r.json();
  } catch (e) {
    if (e.name === "AbortError") {
      throw new Error(
        `Tempo esgotado (${API_TIMEOUT_MS / 1000}s) sem resposta do servidor. Se for a primeira ` +
        `consulta depois de um tempo parado, o servidor pode estar acordando ou processando algo ` +
        `pesado — tente novamente em alguns segundos.`
      );
    }
    throw e;
  } finally {
    clearTimeout(timeoutId);
  }
}

function sair() {
  localStorage.clear();
  location.href = "login.html";
}

// Erro padrão com botão de tentar de novo — todo `catch` de carregamento
// pode usar isto em vez de só imprimir a mensagem e deixar o usuário preso.
function erroComRetry(mensagem, funcaoRecarregar) {
  const nomeFn = `__retry_${Math.random().toString(36).slice(2)}`;
  window[nomeFn] = funcaoRecarregar;
  return `<p class="vazio">${mensagem} <button class="bt-secundario" onclick="${nomeFn}()">Tentar de novo</button></p>`;
}
