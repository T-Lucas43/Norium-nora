# TURN na VPS — preparação para revisão humana

Estado em 2026-10-12: **PREPARADO; NÃO INSTALADO, NÃO ATIVADO, NÃO VALIDADO**.
Finalidade: permitir relay de mídia nas chamadas quando a conexão direta falha.
Este pacote usa apenas metadados do host e dados sintéticos; não contém chaves ou segredos.

## Base observada e limites

- Base de código: `9176971`; PR #58 permanece draft e fora deste pacote.
- Ubuntu 24.04; coturn ausente; candidato apt observado: `4.6.1-1build4`.
- Caddy ocupa 80/443. Norium mantém UID 10001, filesystem somente leitura, capabilities removidas, no-new-privileges, seccomp e um worker.
- `TEAM_CALL_TURN_REQUIRED=false`; URLs, segredo TURN e override STUN ausentes.
- Nenhuma alteração de aplicação, PostgreSQL, dados, autenticação existente, Caddy ou rede faz parte desta preparação.

## Dependência: decisão ainda bloqueada

| Opção | Evidência | Decisão proposta |
|---|---|---|
| Pacote nativo Ubuntu | `4.6.1-1build4`, universe, coincide com apt observado. [Ubuntu](https://packages.ubuntu.com/noble/net/coturn) | Preferido pela manutenção nativa, **sem aprovação de segurança**. |
| Imagem oficial coturn | Release `docker/4.18.0-r0`; tag Debian `4.18.0-r0-debian` publicada pelo projeto. [Release](https://github.com/coturn/coturn/releases/tag/docker/4.18.0-r0), [README oficial](https://github.com/coturn/coturn/blob/master/docker/coturn/README.md) | Alternativa somente para revisão; digest/arquitetura, dependências e isolamento ainda não verificados. |

Canonical registra **“Needs evaluation”** para Noble na falha de ACL com IPv4 mapeado em IPv6 e no DoS de DTLS. Isso não prova exploração no host nem existência de backport corretivo. [CVE-2026-27624](https://ubuntu.com/security/CVE-2026-27624), [CVE-2026-73214](https://ubuntu.com/security/CVE-2026-73214).
O upstream também informa falha de framing TCP/TLS até 4.14.0 e bypass de certas faixas IPv6 até 4.15.0. A revisão deve confrontar **todos** os advisories com source/changelog do artefato exato; versão maior sozinha não certifica segurança. [Framing](https://github.com/coturn/coturn/security/advisories/GHSA-m562-mf7x-q7rr), [ACL IPv6](https://github.com/coturn/coturn/security/advisories/GHSA-4v97-rxjj-4f99), [advisories](https://github.com/coturn/coturn/security/advisories).
Sem prova de patches e revisão especializada, **não instalar nem expor o candidato apt**. Não usar latest, PPA, compilação ad hoc ou pull automático para contornar esse gate.

## Perfil proposto

- IPv4 público **atribuído à interface do host**, domínio dedicado com A correspondente e sem AAAA neste perfil; NAT exige novo desenho revisado.
- Entrada futura: TCP 5349 com TLS; relay UDP 50000–50199. Nenhum listener UDP/DTLS, TCP sem TLS ou relay TCP. Caddy 443 não intermedeia TURN. [Opções coturn](https://github.com/coturn/coturn/blob/4.6.1/examples/etc/turnserver.conf)
- Teto de 100 allocations, 200 portas prevendo reserva EVEN-PORT; isso não garante 100 usuários/chamadas nem throughput. Quota por username 4; usernames REST mudam com o vencimento, então não é limite estável por conta. [Coturn](https://github.com/coturn/coturn/blob/4.6.1/examples/etc/turnserver.conf)
- Proposta de banda: 1.000.000 bytes/s por allocation e capacidade 12.500.000 bytes/s, entrada/saída tratadas separadamente. Revisar custo, capacidade e qualidade antes de ativar. [Coturn](https://github.com/coturn/coturn/blob/4.6.1/examples/etc/turnserver.conf)
- Negar loopback, privados, link-local, CGNAT, multicast, reservados e IPv6 inteiro. O IP público do próprio TURN precisa aceitar self-relay na faixa UDP; negá-lo inteiro quebra peers no mesmo relay. Revisar controles de saída que bloqueiem serviços locais/provedor preservando essa faixa; ACL do daemon não é isolamento suficiente. [IANA](https://www.iana.org/assignments/iana-ipv4-special-registry/iana-ipv4-special-registry.xhtml), [self-relay oficial](https://github.com/coturn/coturn/blob/4.6.1/README.turnutils)
- Configuração do daemon e chave TLS futuras: root:turnserver 0640, diretório 0750; usuário turnserver sem privilégios. Conferir a unit vendor e endurecimento antes de habilitar.
- Segredo novo, exclusivo, 32 bytes aleatórios representados por 64 caracteres hex, gerado **no host**. Arquivo de ambiente da API futuro: root:root 0600 sob diretório privado não gravável por terceiros. Igual ao static-auth-secret do daemon; jamais ao SESSION_SECRET.
- Coturn avisa que sem mecanismo de credenciais há **“any user allowed”**; `use-auth-secret` é obrigatório e já habilita long-term credentials internamente. [Configuração oficial](https://github.com/coturn/coturn/blob/4.6.1/examples/etc/turnserver.conf)
- Domínio, cadeia TLS válida e chave privada serão fornecidos no host pelo responsável humano. Não reutilizar chaves internas do Caddy, não baixar certificado/chave neste fluxo e não desabilitar TLS.
- Syslog sem verbose, CLI e web-admin desativados. Revisar retenção/acesso dos logs que podem incluir IP e username; conservar apenas contadores agregados para alocações, recusas, bytes, erros, reinícios e vencimento TLS. Nenhuma porta de métricas nova.

## Checagem local, sem efeitos no host

`plan.json` guarda referências de revisão, nunca aprovação automática ou segredos.
O template é deliberadamente incompleto e não é configuração aprovada; placeholders jamais devem ser usados em produção. A sintaxe e o comportamento no pacote escolhido ainda não foram validados.
O preflight usa somente biblioteca padrão, lê apenas esses dois arquivos e não instala, consulta rede, lê chaves, inicia serviço ou altera firewall/TLS.
Saída **ready=false sempre**; lint aprovado atesta somente coerência dos arquivos. Mesmo referências preenchidas continuam sem validação independente.

```text
python -B infra/turn/preflight.py --lint-only
python -B -m unittest discover -s infra/turn -p test_preflight.py
python -B infra/turn/preflight.py --candidate 4.6.1-1build4
```

O último comando retorna 2: gates de host/segurança/aceite ainda não executados; lint inválido retorna 1. A leitura futura de apt deve confirmar candidato/origem atuais, sem instalar.

## Revisão humana e aceite futuro

A [governança de IA](../../docs/AI_GOVERNANCE.md) exige **“aprovação humana para código crítico e para ações irreversíveis”**. Novo relay é expansão de infraestrutura crítica; uma confirmação em JSON não substitui evidência nem autoriza ativação.
Antes de qualquer ação no host, revisar pacote/digest e patches, public IP/DNS/NAT, TLS/renovação, permissões, isolamento de saída, quotas, headroom e custo, logs/alertas, rollback e a configuração final sem expor segredos.
Após autorização separada, testar externamente TLS/cadeia/hostname/validade, rejeição de anônimo/credenciais inválidas/expiradas, bloqueio de peers proibidos (inclusive IPv4 mapeado), quotas e mídia relay entre duas contas exclusivas de teste. Falha reprova o aceite.
Somente depois dos gates, propor `TEAM_CALL_TURN_URLS=turns:<domínio>:5349?transport=tcp`, segredo exclusivo e `TEAM_CALL_TURN_REQUIRED=true`; TTL 600s/margem 120s já existem no backend. Validar readiness, login, dados, WebSocket e chamadas conforme [DEPLOY_SHARDCLOUD.md](../../DEPLOY_SHARDCLOUD.md).
Rollback futuro: retirar TURN do ambiente da API, restaurar REQUIRED=false, parar relay e fechar exclusivamente as novas portas, revalidando aplicação/dados. Nada disso foi executado.
Risco residual: usuários autenticados podem abusar de relay público e esgotar quota/banda; negar privados e exigir credenciais não elimina DoS nem custo. Redes que bloqueiam 5349 continuam sem caminho; usar 443 exigiria outro desenho.
