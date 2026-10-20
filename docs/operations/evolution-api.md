# WhatsApp por Evolution API

O adaptador usa Evolution API 2.3.7, da Evolution Foundation.
[Documentação](https://docs.evolutionfoundation.com.br/evolution-api) e
[licença com condições adicionais](https://github.com/evolution-foundation/evolution-api/blob/2.3.7/LICENSE).
A atribuição aparece nas configurações. Não foi copiado o painel do fornecedor.

## Estado em 19/10/2026

A imagem original foi reprovada: 11 ocorrências CRITICAL e 254 HIGH. São
ocorrências em pacotes/arquivos, não vulnerabilidades únicas nem prova de exploração.
Ela não pode ser promovida. Relatório: `output/docker-local/evolution-vulnerabilities.json`.

O runtime foi reconstruído em `Dockerfile.evolution`, usando somente dist,
esquema/migrações e recursos públicos do fornecedor. Não copia seu `.env`, npm
global ou dependências antigas. A fonte continua na revisão
`cd800f2976e1e5b682fbf86a01ee4d85ae61f370`, tag `2.3.7`.

- Node 24 e Alpine mantidos, bases fixadas por digest.
- Baileys `7.0.0-rc14`, corrigindo a faixa afetada por
  [GHSA-qvv5-jq5g-4cgg](https://github.com/WhiskeySockets/Baileys/security/advisories/GHSA-qvv5-jq5g-4cgg).
- Lock Linux próprio, sem dependências de desenvolvimento nem `--force`.
- Overrides específicos: link-preview-js 4, sharp 0.35, Axios legado 0.34 e deepmerge-ts 8.
  São alterações intencionais de compatibilidade; inicialização não comprova todas as funções.
- O caminho FFmpeg do instalador aponta para o binário mantido pelo Alpine.
- API como UID/GID 1000. PostgreSQL auxiliar como 70, sem helper root gosu;
  Redis recebe correções do repositório Alpine. Dados existentes permanecem nos volumes.

Trivy 0.75.0 encontrou **zero HIGH/CRITICAL nas três imagens corrigidas**, sem
exceções: `output/evolution-audit/vulnerabilities-v3.json`, `postgres-fixed.json`
e `redis-fixed.json`. O CI repete a auditoria, gera SBOM/recibo e exporta as três
imagens exatas. Uma auditoria limpa não garante ausência de vulnerabilidades futuras.

A API corrigida iniciou localmente, aplicou/verificou 57 migrações e respondeu HTTP
200 à listagem autenticada, com zero instâncias. PostgreSQL e API ficaram healthy.
Não houve QR, pareamento, leitura de chats reais nem envio. Suítes de testes não
foram executadas manualmente nesta correção; o CI obrigatório continua habilitado.
Publicação e ativação remota dependem do CI e da revisão técnica humana do diff.

## Contratos e limites

- Conexão/estado/QR e reconciliação por nome determinístico, com consentimento do titular.
- Texto, imagem, vídeo, documento, áudio, figurinha e localização, sem retry de escrita.
- Referências/reação/edição/exclusão consultam a chave real e confirmam conversa/autoria.
- Contatos, conversas, grupos, foto do perfil e até 100 mensagens recentes disponíveis.
- Webhooks minimizados com autenticação, deduplicação e prova local de propriedade.
- View-once, GIF e publicação de Status sem contrato verificado são recusados.

Estes itens são implementação de contrato, não aceite funcional com conta pareada.
A sincronização retroativa completa fica desligada (`syncFullHistory=false`). O lote inicial recente disponibilizado pelo WhatsApp passa a ser persistido, sujeito à retenção de 30 dias. Isso não garante todo o histórico do telefone.
Nenhuma autorização desta implantação permite enviar mensagens em nome do usuário.

## Dados pessoais

`evolution_data.py` integra o gateway ao ciclo de privacidade. A associação da
instância é comprovada pelo registro local e hash determinístico da conta;
identificadores enviados pelo provedor não definem acesso entre contas.

- Exportação pessoal inclui mensagens/contatos/chats do próprio vínculo, sem tokens,
  sessão, webhook, proxy ou chaves. Consulta com snapshot read-only e limites explícitos;
  se ultrapassados, falha inteira, sem ZIP parcial silencioso.
- Desconectar a Evolution encerra e elimina a instância remota, além dos históricos
  locais já eliminados pelo fluxo anterior. A interface informa essa consequência.
- Exclusão de conta só elimina o registro local após confirmação da remoção remota;
  uma falha mantém o vínculo privado para retomada pelo worker.
- Mensagens do gateway expiram em 30 dias por padrão (configurável 1–180), em lotes
  de 1.000; relacionamentos MessageUpdate/Media são eliminados por cascata.
- Contatos/chats permanecem enquanto vinculados e são removidos com a instância.
- Backups do operador seguem sua retenção separada; não são prometidos apagamentos
  retroativos de backups. Sem acesso ao banco privado, exportação/purga falham fechadas.

`EVOLUTION_DATABASE_URL` é somente do operador, aceita apenas o serviço interno
`evolution-database:5432/evolution`, com usuário evolution e rede privada explícita.
A API não publica portas; PostgreSQL/Redis usam rede Docker interna separada.

## Isolamento e rollback

`WHATSAPP_PROVIDER` é selecionado pelo servidor e congelado no processo; padrão wapi.
Frontend não define URL, segredo ou instância. Evolution tem documentos/caches e
registros PostgreSQL próprios (`evolution_*`), chave Fernet e versão de consentimento
próprias. O perfil interno pro não é plano comercial Evolution.

Restaurar configuração/imagem anterior retoma vínculos W-API preservados. Não migrar
sessões entre provedores. Para pausa sem remoção: `docker compose stop`; nunca `down -v`.

## Docker local

```powershell
powershell -ExecutionPolicy Bypass -File scripts/start_local_docker.ps1 -WithEvolution -EnableEvolution
```

Somente executar a ativação com as imagens corrigidas auditadas. URL:
`http://localhost:8765/`. Conta e segredos existentes ficam preservados nos arquivos
ignorados `output/docker-local`. O titular aceita os termos no Norium e escaneia o QR.

## ShardCloud e GitHub

1. Publicar/revisar o diff e aguardar todos os gates do CI do SHA exato.
2. Liberar espaço com ação específica aprovada: somente cache Docker de build sem uso.
   Limpeza aprovada e executada em 19/10/2026; última conferência mostrou 17 GB livres.
   Imagens, containers, volumes e backups foram preservados. Conferir espaço novamente antes da promoção.
3. Importar os artefatos imutáveis Norium e `evolution-deploy-image-SHA` do GitHub,
   conferir checksums e recibos. Não reconstruir a aplicação na VPS.
4. Em diretório dedicado, copiar o Compose e executar
   `python3 scripts/prepare_evolution_shard.py --audit-receipt CAMINHO_DO_RECIBO`.
   Exige pelo menos 6 GiB livres, recibo completo e IDs das três imagens; cria
   arquivos 0600 novos, sem sobrescrever nem imprimir segredos.
5. Iniciar os três serviços privados. Incorporar o arquivo privado
   `norium-evolution.env` ao candidato Norium e ligá-lo à rede interna
   `norium-evolution-data`; não expor PostgreSQL/Redis à rede de borda.
6. Após auditoria/revisão, habilitar `EVOLUTION_CONNECTIONS_ENABLED=1`. O gerador
   deixa 0 por segurança. Preservar todas as outras configurações de segurança,
   volumes e dados do Norium. Backup e rollback antes da promoção.
7. Conferir release/readiness; titular aceita termos e escaneia QR. Somente depois
   um teste autorizado de envio/recebimento pode comprovar o fluxo WhatsApp completo.


## Carga inicial e sessões já pareadas

O socket pode conectar antes de o catálogo chegar. Nos primeiros três minutos o
Norium atualiza o catálogo em intervalos limitados de 15 segundos, quando a tela
solicita dados. Um resultado inicial vazio não recebe o TTL longo de um catálogo
completo. Conversas confirmadas pelo catálogo aparecem mesmo sem mensagem/data
recente, sem inventar conteúdo nem horário. A política W-API anterior é preservada.

Em uma sessão pareada quando `DATABASE_SAVE_DATA_HISTORIC` estava desativado, o
lote histórico já descartado pelo gateway não pode ser fabricado ou recuperado do
banco vazio. A atualização preserva a sessão e todos os dados atuais; não força
logout nem apaga vínculos. Se o WhatsApp não reenviar o lote ao reconectar, somente
um novo pareamento feito pelo titular poderá solicitar outra carga inicial.

## Mídias e reações

O download autenticado resolve a mensagem na instância e conversa do titular e
encaminha a chave e o conteúdo completos ao endpoint oficial. Essa referência
permite ao gateway renovar mídia expirada; a chave vazia anterior não permitia
essa renovação. Não há redirecionamento de credenciais nem envio de anexos à IA.
O histórico preserva duração de áudio/vídeo e nome de documento. Envelopes
`deviceSentMessage` e `documentWithCaptionMessage` são normalizados; mensagens de
visualização única e temporárias não são expandidas por essa compatibilidade.

Reações do histórico atualizam a mensagem alvo, sem criar bolha separada. Reações
do próprio celular e de participantes são preservadas por autor; remover uma não
remove as dos outros. O lookup aceita o alias de privacidade somente após provar
que pertence à conversa solicitada, na instância autenticada. Uma escrita sem
confirmação não aparece como sucesso e não é repetida automaticamente.

O ambiente local usa `restart: unless-stopped` nos serviços e continua disponível
em `http://localhost:8765/` com Docker ativo. Rebuild preserva volumes e pareamento.
