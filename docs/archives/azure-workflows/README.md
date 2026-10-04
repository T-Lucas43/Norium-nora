# Workflows Azure históricos

Arquivados em 04/10/2026 por instrução explícita do responsável: usar somente Shard Cloud por enquanto. Esses YAML estão fora de `.github/workflows` e não são acionáveis pelo GitHub Actions.

O workflow ativo é `.github/workflows/shard-homologacao.yml`. Ele valida o SHA concreto, PostgreSQL descartável, chamadas e sandbox; produz um pacote de fontes após os gates. O teste PostgreSQL local mantém seu caminho histórico em `infra/azure/test_postgres_persistence.py`; não acessa nem publica no Azure.

Arquivar o YAML não altera, encerra ou exclui aplicações, infraestrutura, dados, credenciais ou configurações remotas. Não despachar versões históricas da branch main. Retomar Azure exige instrução nova e revisão específica.
