# Nora em reuniões — pontos preparados para revisão especializada

Estado: revisão ainda não realizada. Fonte: `docs/AI_GOVERNANCE.md`: **"Exigir aprovacao humana para codigo critico e para acoes irreversiveis"** e **"Implementar ou aprovar sozinho autenticacao, criptografia, pagamentos, saude, decisoes legais, exclusao de dados ou infraestrutura critica."** (uso proibido sem especialista).

Os núcleos C/D/E estão disponíveis para revisão/teste local. Flag zero, entitlement operacional falso; sem tokens de agente, exclusão nova ou provedores externos conectados.

## Critérios antes da ponte operacional

1. Perfil exclusivo Nora em `sfu_tokens.py`/supervisor: sala correta, token curto, nenhum grant administrativo/dados/vídeo publicado, revogação/encerramento/reconexão. LiveKit oferece `canSubscribe`, sem grant JWT comprovado por fonte de áudio. Não inventar `canSubscribeSources` nem reutilizar token humano como mínimo.
2. `nora_reunioes` via entitlement atual de servidor, revalidado; nunca por alegação do navegador/IA. `noraEntitled` persistido não substitui autorização vigente do supervisor.
3. Consentimento por roster/sessão/revisão, destino Groq explícito, retirada/entrada tardia, resultados atrasados recusados. Texto compartilhado só à audiência vigente; dados privados não passam pela saída pública.
4. Supervisor único/lease distribuído, teto global por servidor, filas/timeouts, desligamento sem humanos/autorização e consumo incerto conservador.
5. Retenção e LGPD por tenant/workspace/chamada, associação à gravação, prazo/expurgo verificáveis, exportação e exclusão sem apagar dados de outras pessoas. Fluxos novos ainda não montados.
6. Ações D: payload exato, projeto/equipe revalidados, aprovação existente e recibo; nenhuma execução por texto ou wake.
7. SDK Python pinado/auditado, homologação real e memória nativa por 30 min. SDK opcional 1.1.19 pinado/com hashes, auditado e validado localmente em AudioSource/AudioStream. Transporte dos provedores continua substituído; homologação real e aceite do ensaio completo permanecem separados.

Registrar evidência com dados sintéticos. Revisão não autoriza publicação, contratação, segredos, flags ou deploy.

## Continuidade aprovada — integrações locais

A resposta humana “eu aprovo” autorizou continuidade local; revisão especializada ainda não ocorreu. Novas pontes reutilizam sessão/equipe/cliente existentes e revalidam a permissão antes de custos e depois de respostas. Não criam autenticação, tokens de agente, grants de plano ou mecanismos de exclusão permanente. Revisar audiência por segmento, recusa de resultados tardios, isolamento de recibos privados e cadeia de evidências antes da ativação.

Auditoria de cinco dependências Python opcionais: zero vulnerabilidades conhecidas no momento do scan; não certifica binários nativos, infraestrutura ou contrato dos provedores. Fonte e instalação/hash estão em `output/nova-chamada-qa/nora-sdk-*` e `requirements-nora-call.lock.txt`.
