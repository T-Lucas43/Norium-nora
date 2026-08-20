from googleapiclient.discovery import build
from google.oauth2.credentials import Credentials
import datetime
import logging

logger = logging.getLogger(__name__)

class GoogleCalendarService:
    def __init__(self, tokens: dict):
        """
        Inicializa o serviço do Google Calendar usando os tokens do utilizador.
        """
        self.creds = Credentials(
            token=tokens.get("access_token"),
            refresh_token=tokens.get("refresh_token"),
            client_id=tokens.get("client_id"),
            client_secret=tokens.get("client_secret"),
            token_uri="https://oauth2.googleapis.com/token"
        )
        self.service = build("calendar", "v3", credentials=self.creds)

    def listar_compromissos(self, max_resultados: int = 5):
        """
        Procura os próximos compromissos da agenda principal (primary).
        """
        agora = datetime.datetime.utcnow().isoformat() + 'Z' # 'Z' indica UTC
        
        try:
            logger.debug("Consultando eventos no Google Calendar.")
            eventos_result = self.service.events().list(
                calendarId='primary',
                timeMin=agora,
                maxResults=max_resultados,
                singleEvents=True,
                orderBy='startTime'
            ).execute()
            
            eventos = eventos_result.get('items', [])
            
            lista_formatada = []
            for ev in eventos:
                inicio = ev['start'].get('dateTime', ev['start'].get('date'))
                fim = ev['end'].get('dateTime', ev['end'].get('date'))
                
                lista_formatada.append({
                    "id": ev.get("id"),
                    "titulo": ev.get("summary", "Compromisso sem título"),
                    "inicio": inicio,
                    "fim": fim,
                    "descricao": ev.get("description", "")
                })
                
            return lista_formatada
        except Exception as exc:
            logger.warning("Falha ao listar eventos no Google Calendar (%s).", type(exc).__name__)
            return []

    def criar_compromisso(self, titulo: str, inicio_iso: str, fim_iso: str, descricao: str = ""):
        """
        Insere um novo evento na agenda do utilizador.
        """
        evento_body = {
            'summary': titulo,
            'description': descricao,
            'start': {'dateTime': inicio_iso, 'timeZone': 'America/Sao_Paulo'},
            'end': {'dateTime': fim_iso, 'timeZone': 'America/Sao_Paulo'},
        }
        try:
            evento_criado = self.service.events().insert(
                calendarId='primary', 
                body=evento_body
            ).execute()
            return evento_criado
        except Exception as exc:
            logger.warning("Falha ao criar evento no Google Calendar (%s).", type(exc).__name__)
            return None
