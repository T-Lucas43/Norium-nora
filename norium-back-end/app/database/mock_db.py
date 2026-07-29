import json
import os

DB_FILE = "mock_database.json"

def obter_tokens_usuario(user_id: str):
    """Busca os tokens OAuth do usuário no arquivo JSON."""
    if not os.path.exists(DB_FILE):
        return None
    with open(DB_FILE, "r") as f:
        data = json.load(f)
        return data.get(user_id)

def salvar_tokens_usuario(user_id: str, tokens: dict):
    """Salva ou atualiza os tokens OAuth de um usuário."""
    data = {}
    if os.path.exists(DB_FILE):
        with open(DB_FILE, "r") as f:
            try:
                data = json.load(f)
            except:
                data = {}
                
    data[user_id] = tokens
    with open(DB_FILE, "w") as f:
        json.dump(data, f, indent=4)