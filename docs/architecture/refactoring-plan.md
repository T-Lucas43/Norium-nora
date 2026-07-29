# Refatoração incremental do Norium

## Invariantes públicos

- O entrypoint do backend permanece `main:app`.
- Rotas, métodos HTTP, parâmetros e estruturas JSON são congelados pelo
  snapshot `tests/contracts/openapi-baseline.json`.
- Os envelopes WebSocket, IDs de armazenamento e eventos do navegador não
  mudam durante a extração.
- Bancos JSON legados continuam sendo lidos enquanto a persistência modular é
  introduzida.

## Regra de extração

Cada mudança segue o padrão *expand and contract*:

1. criar o módulo novo sem conectá-lo ao runtime;
2. cobrir o comportamento atual com teste;
3. ligar o módulo por uma fachada compatível;
4. validar contrato, build e fluxo real;
5. remover a implementação duplicada somente após a validação.

## Fronteiras do backend

Cada domínio contém `router`, `schemas`, `service` e `repository`. Gateways
externos ficam dentro do domínio que os utiliza. Código compartilhado fica em
`core`, `shared` ou `infrastructure`, nunca em routers.

## Fronteiras do frontend

Cada feature contém `api`, `components`, `hooks`, `model` e `types`. Componentes
visuais não fazem chamadas HTTP. Estado assíncrono e cancelamento pertencem aos
hooks; parsing e transporte pertencem ao cliente HTTP.

## Comentários de migração

Arquivos extraídos recebem docstring ou comentário de módulo informando a
origem e a responsabilidade assumida. Comentários linha a linha são evitados
quando nomes e tipos já explicam o comportamento.
