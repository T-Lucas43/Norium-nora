"""Ponto de entrada ASGI estável do Norium.

O objeto ``app`` permanece neste módulo para preservar o comando de execução
existente (``uvicorn main:app``). A composição da aplicação vive em
``app.bootstrap`` e os domínios mantêm suas rotas originais.
"""

from app.bootstrap import create_app


app = create_app()
