// branding.js — aplica a identidade do tenant (nome, cores, logo) em runtime,
// vinda de /api/tenant/branding. Nenhum HTML/CSS deste projeto cita o nome
// de uma empresa específica — tudo isso é injetado aqui.
async function aplicarBranding() {
  try {
    const r = await fetch("/api/tenant/branding");
    const b = await r.json();
    document.documentElement.style.setProperty("--cor-primaria", b.cor_primaria || "#2563eb");
    document.documentElement.style.setProperty("--cor-secundaria", b.cor_secundaria || "#f59e0b");
    document.querySelectorAll("[data-tenant-nome]").forEach(el => { el.textContent = b.nome || "Vendalytics"; });
    document.title = (b.nome_curto || b.nome || "Vendalytics") + " — " + document.title.split("—").pop().trim();
    return b;
  } catch (e) {
    console.warn("branding indisponível:", e);
    return {};
  }
}
document.addEventListener("DOMContentLoaded", aplicarBranding);
