"""
infra/ — fundação transversal (Fase 0 do roadmap em docs/gtm-intelligence-platform.md):
contexto de request com escopo de acesso, migrations versionadas, trilha de
auditoria append-only e observabilidade.

Nada aqui é lógica de negócio. A regra de ouro é a da §3.5 da spec: o
isolamento é imposto pela infraestrutura, não pela boa memória de quem
escreve o próximo endpoint.
"""
