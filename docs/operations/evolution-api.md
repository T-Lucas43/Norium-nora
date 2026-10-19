# WhatsApp por Evolution API

O Norium possui um adaptador para a **Evolution API 2.3.7**, projeto da Evolution
Foundation. [Documentação oficial](https://docs.evolutionfoundation.com.br/evolution-api)
e [licença com condições adicionais](https://github.com/evolution-foundation/evolution-api/blob/2.3.7/LICENSE).
A identificação do fornecedor também aparece nas configurações do WhatsApp.

## Estado em 19/10/2026

**Código integrado, ativação bloqueada.** A imagem oficial foi iniciada localmente,
aplicou suas migrações e respondeu HTTP 200 à listagem autenticada, sem instâncias.
Não houve pareamento nem envio real. O build do frontend/API e a inicialização do
Norium foram conferidos separadamente: a revisão `5134978` está em execução local,
página HTTP 200 e readiness pronta com PostgreSQL. Isso não comprova funcionamento
com uma conta WhatsApp conectada. Evidência sanitizada em
`output/docker-local/evolution-runtime-evidence.json`.

A auditoria Trivy 0.75.0 do digest abaixo encontrou **11 ocorrências CRITICAL e
254 HIGH**. São ocorrências em pacotes/arquivos, não 265 vulnerabilidades distintas
nem comprovação de explorabilidade de cada uma. Relatório local:
`output/docker-local/evolution-vulnerabilities.json`.

Um bloqueio confirmado é **CVE-2026-48063 / GHSA-qvv5-jq5g-4cgg** no
`baileys@7.0.0-rc.9`: a faixa afetada e a correção em rc12 constam no
[aviso de segurança revisado](https://github.com/advisories/GHSA-qvv5-jq5g-4cgg).
É possível falsificar eventos de mensagens e corromper sincronização de estado.
Filtrar apenas o webhook não corrige o estado interno da sessão do fornecedor.

Por isso `EVOLUTION_CONNECTIONS_ENABLED=0` bloqueia o provisionamento e o QR
antes de criar claims/instâncias. Nenhuma chave ou conta WhatsApp real foi usada.
**Não promover este digest para o Shard nem liberar pareamento.** Preparar uma
imagem corrigida, conferir compatibilidade e repetir a auditoria antes da revisão
humana. Uma nova versão RC ou somente atualizar Baileys não resolve automaticamente
os demais achados. Não adicionar exceções globais ao scanner.

## Contratos implementados

- Conexão/estado/QR, reconciliação por nome determinístico e ciclo de vida existente.
- Texto, imagem, vídeo, documento, áudio, figurinha e localização, sem retry de escrita.
- Referências/reação/edição/exclusão buscam a chave real da mensagem na instância
  e confirmam conversa/autoria, sem fabricar `fromMe`.
- Contatos, conversas, consulta recente de histórico, grupos e foto do perfil.
- Webhooks minimizados de mensagens, conexão, ACK e presença; mantêm autenticação,
  deduplicação e confirmação de propriedade na fronteira existente.
- Recursos sem correspondência verificada, como envio temporário/view-once e GIF,
  são recusados explicitamente. A publicação de Status permanece indisponível.

Esses itens são implementação de contrato, **não aceite funcional com WhatsApp**.
A consulta de histórico limita-se às 100 mensagens recentes disponíveis no provedor;
não é sincronização retroativa completa. `syncFullHistory` e armazenamento histórico
automático ficam desligados. O recebimento normal mantém histórico no banco do
fornecedor para referências de mensagens. Esses dados/volumes têm ciclo de vida
próprio: exportação, eliminação e retenção do Norium não eliminam automaticamente
o banco externo Evolution. O procedimento operacional do fornecedor ainda precisa
ser integrado/validado antes de disponibilização a contas reais.

## Isolamento e retorno à W-API

`WHATSAPP_PROVIDER` é definido pelo servidor e congelado no processo. O padrão
continua `wapi`. Não aceitar URL, token ou instância enviados pelo frontend.

Evolution usa documentos `evolution_instance`, `evolution_conversas` e caches
próprios; seu registro PostgreSQL usa tabelas `evolution_*`. Credenciais de instância
usam a implementação Fernet existente e chave própria. Consentimento tem versão
específica. W-API LITE/PRO continuam com o comportamento anterior. O perfil `pro`
interno reutilizado pelo catálogo não é um plano comercial Evolution e não aparece
como tal na interface. A restauração de snapshots não reaproveita o vínculo do outro
provedor.

Para voltar à W-API, restaurar a configuração anterior e reiniciar o Norium. Isso
retoma os vínculos e o histórico W-API preservados; não migrar sessões entre APIs.

## Docker local

```powershell
powershell -ExecutionPolicy Bypass -File scripts/start_local_docker.ps1 -WithEvolution
```

URL do Norium: `http://localhost:8765`. Mesma conta de desenvolvimento existente.
Segredos aleatórios são preservados em `output/docker-local/.env`, ignorado pelo
Git. A API Evolution, Redis e PostgreSQL não publicam portas no host. Não há painel
do fornecedor exposto. A API privada está iniciada para preparação da integração;
o pareamento no Norium permanece bloqueado pela auditoria.

`-PrepareOnly` prepara arquivos sem alterar containers. Nunca usar `down -v` para
pausar. Manter os três volumes Evolution e os dois volumes do Norium.

## Instalação no Shard — pendente

Arquivo preparado: `compose.evolution.shard.yaml`, sem portas públicas, volumes
próprios, banco/cache em rede interna, limites e logs rotacionados. O serviço se
liga à rede `norium-edge` existente. Não altera o container Norium nem o proxy.

Imagem original auditada:

`evoapicloud/evolution-api@sha256:1bd8afc4a6cf48822e6cf02469aeae7bd35a12a6b616eacd1291926307f4d339`

Fonte correspondente: tag `2.3.7`, commit
`cd800f2976e1e5b682fbf86a01ee4d85ae61f370`; o rótulo OCI da imagem confirmou a revisão.

A VPS tem 686 MB livres, 99% do disco ocupado e aproximadamente 4,8 GB de RAM
disponível. `docker system df` indicou 8,69 GB recuperáveis de cache de build.
Nenhum cache, container, volume, backup ou imagem de rollback foi removido.

Ordem de promoção após correção do fornecedor:

1. Atualizar o digest, guardar auditoria sem HIGH/CRITICAL e revisar compatibilidade.
2. Revisão humana das alterações de autorização, privacidade e infraestrutura.
3. Resolver espaço com uma ação específica revisada; exigir pelo menos 6 GiB livres.
4. Publicar o código/artefato imutável pelo GitHub antes de instalar no Shard.
5. Em diretório dedicado, `python3 scripts/prepare_evolution_shard.py` cria arquivos
   novos com permissão 0600, sem imprimir nem substituir segredos.
6. Somente então iniciar o Compose revisado. Incorporar `norium-evolution.env` ao
   ambiente do Norium pelo fluxo existente, sem mostrar seu conteúdo no console.
7. Prontidão, aceite do titular, QR e validação de envio/recebimento autorizada.

O gerador deixa `EVOLUTION_CONNECTIONS_ENABLED=0`. Ativação remota ainda não ocorreu.
Pausa sem apagar dados: `docker compose -f compose.evolution.shard.yaml stop`.
