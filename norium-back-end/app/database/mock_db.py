from app.core.tenant import get_system_db_path
from app.infrastructure.persistence.json_repository import read_json, write_json

DB_FILE = get_system_db_path("mock_database")

def obter_tokens_usuario(user_id: str):
    """Busca os tokens OAuth do usuário no arquivo JSON."""
    data = read_json(DB_FILE, {})
    return data.get(user_id) if isinstance(data, dict) else None

def salvar_tokens_usuario(user_id: str, tokens: dict):
    """Salva ou atualiza os tokens OAuth de um usuário."""
    data = read_json(DB_FILE, {})
    if not isinstance(data, dict):
        data = {}
    data[user_id] = tokens
    write_json(DB_FILE, data)
