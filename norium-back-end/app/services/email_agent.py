from __future__ import annotations

import asyncio
import re
import hashlib
import json
import unicodedata
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any

from fastapi import HTTPException
from app.core.request_context import current_workspace_id
from app.core.identity import require_user_id

from app.services.gmail_service import GmailService
from app.services.nora import NoraIAService
from app.services.nora_action_prefill import EmailActionPrefill, extract_action_parameters


@dataclass
class EmailSession:
    id: str
    user_id: str
    workspace_id: str = field(default_factory=current_workspace_id)
    fields: dict[str, Any] = field(default_factory=dict)
    awaiting: str = "to"
    updated_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    lock: asyncio.Lock = field(default_factory=asyncio.Lock, repr=False)
    cancelled: bool = False


class EmailAgent:
    SESSION_TTL = timedelta(minutes=20)
    MAX_EMAIL_ATTACHMENTS = 8
    MAX_EMAIL_ATTACHMENT_BYTES = 24 * 1024 * 1024

    def __init__(self) -> None:
        self.sessions: dict[str, EmailSession] = {}
        self.nora = NoraIAService()

    def cancel_session(self, session_id: str | None, *, user_id: str) -> str | None:
        session = self.sessions.get(session_id or "")
        if session and session.user_id == user_id and session.workspace_id == current_workspace_id():
            session.cancelled = True
            self.sessions.pop(session.id, None)
            return session.fields.get("_approval_id")
        return None

    async def handle(self, *, message: str, session_id: str | None, user_id: str, attachment_ids: list[str] | None = None, prefill: EmailActionPrefill | None = None) -> dict[str, Any]:
        user_id = require_user_id({"id": user_id})
        session = self.sessions.get(session_id or "")
        if session and (session.user_id != user_id or session.workspace_id != current_workspace_id()):
            raise HTTPException(404, "Rascunho não encontrado neste ambiente.")
        if session:
            async with session.lock:
                if session.cancelled:
                    raise HTTPException(409, "Este rascunho foi cancelado. Inicie um novo pedido.")
                return await self._handle_unlocked(message=message, session_id=session_id, user_id=user_id, attachment_ids=attachment_ids, prefill=prefill)
        return await self._handle_unlocked(message=message, session_id=session_id, user_id=user_id, attachment_ids=attachment_ids, prefill=prefill)

    async def _handle_unlocked(self, *, message: str, session_id: str | None, user_id: str, attachment_ids: list[str] | None = None, prefill: EmailActionPrefill | None = None) -> dict[str, Any]:
        user_id = require_user_id({"id": user_id})
        text = message.strip()
        normalized = self._normalize(text)
        service = GmailService(user_id)
        status = service.status()
        if not status.get("connected"):
            return {
                "session_id": session_id,
                "status": "desconectado",
                "response": "O Gmail ainda nao esta conectado. Abre E-mails > Conectar Gmail e eu ja consigo ler, resumir e enviar.",
            }

        session = self.sessions.get(session_id or "") if session_id else None
        if session and (session.user_id != user_id or session.workspace_id != current_workspace_id()):
            raise HTTPException(404, "Rascunho não encontrado neste ambiente.")
        if session and datetime.now(timezone.utc) - session.updated_at > self.SESSION_TTL:
            self.sessions.pop(session.id, None)
            session = None
        if self._is_cancel(normalized):
            if session:
                session.cancelled = True
                self.sessions.pop(session.id, None)
            return {"session_id": None, "status": "cancelado", "response": "Rascunho cancelado. Nada foi enviado.", "cancelApprovalId": session.fields.get("_approval_id") if session else None}

        if session:
            session.updated_at = datetime.now(timezone.utc)
            interpreted = prefill or extract_action_parameters("email", text, bare_recipient_kind=session.awaiting)
            if session.awaiting != "confirmacao" and interpreted.explicit and (interpreted.provided or interpreted.unresolved):
                if attachment_ids:
                    session.fields.setdefault("_pending_attachment_ids", []).extend(attachment_ids)
                self._apply_prefill(session, interpreted)
                return await self._next_question(session)
            pending = session.fields.pop("_pending_attachment_ids", [])
            merged = [*(pending if isinstance(pending, list) else []), *(attachment_ids or [])]
            if session.awaiting != "attachments":
                if merged:
                    session.fields["_pending_attachment_ids"] = merged
                merged = []
            return await self._continue_compose(session, text, normalized, merged or None)

        if self._is_compose_intent(normalized):
            session = EmailSession(id=session_id or uuid.uuid4().hex, user_id=user_id)
            self.sessions[session.id] = session
            attached, skipped = self._resolve_attachments(user_id, attachment_ids or [])
            if attached:
                session.fields["attachments"] = attached
            if skipped:
                session.fields["_attachment_errors"] = skipped
            self._extract_initial_fields(session, text, prefill=prefill)
            async with session.lock:
                return await self._next_question(session)

        if self._is_category_intent(normalized):
            return self._group_messages_by_category(service, normalized)

        if self._is_summary_intent(normalized):
            return await self._summarize_inbox(service, normalized)

        if self._is_list_intent(normalized):
            return self._list_messages(service, normalized)

        return {
            "session_id": None,
            "status": "ajuda",
            "response": (
                "Posso listar enviados, nao lidos, com anexo, resumir sua caixa ou enviar e-mails em linguagem natural. "
                "Exemplo: 'mande um e-mail para cliente@email.com sobre proposta, dizendo que retorno hoje'."
            ),
        }

    async def _continue_compose(self, session: EmailSession, text: str, normalized: str, attachment_ids: list[str] | None = None) -> dict[str, Any]:
        fields = session.fields
        if session.awaiting == "confirmacao":
            edit_target = self._edit_command(normalized)
            if edit_target is not None:
                if edit_target == "attachments":
                    session.fields["attachments"] = []
                    session.fields.pop("_attachments_done", None)
                session.awaiting = edit_target
                return {
                    "session_id": session.id,
                    "status": "coletando",
                    "response": self._edit_prompt(edit_target),
                    "fields": fields,
                    "invalidateApprovalId": fields.get("_approval_id"),
                }
            if self._is_yes(normalized):
                return {
                    "session_id": session.id,
                    "status": "pronto_para_aprovacao",
                    "response": "Prévia pronta. Confira o cartão de aprovação e use Permitir para enviar, ou peça um ajuste.",
                    "fields": fields,
                    "preview": self._preview_payload(session),
                    "emailExact": self._exact_payload(session),
                    "supersedes": fields.get("_approval_id"),
                }
            if self._is_no(normalized):
                session.awaiting = "body"
                return {
                    "session_id": session.id,
                    "status": "coletando",
                    "response": "Beleza. Me manda o corpo do e-mail revisado.",
                    "fields": fields,
                    "invalidateApprovalId": fields.get("_approval_id"),
                }

        if session.awaiting == "to":
            recipients = self._extract_emails(text)
            if recipients:
                fields["to"] = recipients
        elif session.awaiting == "cc":
            if self._is_skip(normalized):
                fields["cc"] = []
            else:
                copied = self._extract_emails(text)
                if copied:
                    fields["cc"] = copied
        elif session.awaiting == "bcc":
            if self._is_skip(normalized):
                fields["bcc"] = []
            else:
                blind = self._extract_emails(text)
                if blind:
                    fields["bcc"] = blind
        elif session.awaiting == "subject":
            fields["subject"] = text[:180]
            fields.pop("_subject_inferred", None)
        elif session.awaiting == "body":
            fields["body"] = self._clean_body_for_send(text[:12000])
            fields["_body_literal"] = True
        elif session.awaiting == "attachments":
            if self._is_skip(normalized):
                fields.setdefault("attachments", [])
                fields["_attachments_done"] = True
                fields.pop("_attachment_errors", None)
            elif attachment_ids:
                attached, skipped = self._resolve_attachments(session.user_id, attachment_ids)
                if attached:
                    combined, limit_error = self._merge_attachment_records(fields.get("attachments") or [], attached)
                    if limit_error:
                        skipped.append(limit_error)
                    else:
                        fields["attachments"] = combined
                        fields["_attachments_done"] = True
                else:
                    fields["_attachment_errors"] = skipped or ["não reconheci nenhum arquivo válido."]

        return await self._next_question(session)

    async def _next_question(self, session: EmailSession) -> dict[str, Any]:
        fields = session.fields
        pending = fields.pop("_pending_attachment_ids", [])
        if pending:
            attached, skipped = self._resolve_attachments(session.user_id, pending)
            if skipped:
                return {
                    "session_id": session.id,
                    "status": "falha_validacao",
                    "response": "Não consegui validar um ou mais arquivos. A prévia e a aprovação existentes continuam inalteradas.",
                    "fields": fields,
                }
            combined, limit_error = self._merge_attachment_records(fields.get("attachments") or [], attached)
            if limit_error:
                return {
                    "session_id": session.id,
                    "status": "falha_validacao",
                    "response": f"{limit_error} Os anexos atuais e a aprovação existente continuam inalterados.",
                    "fields": fields,
                }
            fields["attachments"] = combined
            if skipped:
                fields["_attachment_errors"] = skipped
                fields["_attachments_done"] = False
        if not fields.get("to"):
            session.awaiting = "to"
            response = "Para qual e-mail eu envio? Pode mandar um ou vários endereços."
        elif "cc" not in fields:
            session.awaiting = "cc"
            response = "Algum e-mail em cópia (Cc)? Mande os endereços ou diga 'pular'."
        elif "bcc" not in fields:
            session.awaiting = "bcc"
            response = "Algum e-mail em cópia oculta (Cco)? Mande os endereços ou diga 'pular'."
        elif not fields.get("body"):
            session.awaiting = "body"
            response = "Qual mensagem voce quer enviar? Pode mandar em texto livre."
        elif not fields.get("_attachments_done"):
            session.awaiting = "attachments"
            errors = fields.pop("_attachment_errors", [])
            note = f" Não consegui usar: {', '.join(errors[:3])}." if errors else ""
            response = f"Quer anexar arquivos? Envie pelo clipe do chat ou diga 'pular'.{note}"
        else:
            if not fields.get("subject"):
                fields["subject"] = self._infer_subject_from_body(str(fields["body"]))
                fields["_subject_inferred"] = True
            def digest():
                return hashlib.sha256(json.dumps({key: fields.get(key) for key in ("subject", "body")}, sort_keys=True).encode()).hexdigest()
            if fields.get("_draft_digest") != digest() and not fields.get("_body_literal"):
                draft = await self._polish_body(fields, user_id=session.user_id)
                if session.cancelled:
                    raise HTTPException(409, "Este rascunho foi cancelado. Inicie um novo pedido.")
                fields["body"] = draft
            fields["_draft_digest"] = digest()
            session.awaiting = "confirmacao"
            response = f"Prévia pronta. Confira o cartão de aprovação e use Permitir para enviar, ou diga 'editar assunto' para ajustar.\n\n{self._summary(fields)}"

        return {
            "session_id": session.id,
            "status": "pronto_para_aprovacao" if session.awaiting == "confirmacao" else "coletando",
            "response": response,
            "fields": fields,
            "preview": self._preview_payload(session) if session.awaiting == "confirmacao" else None,
            "emailExact": self._exact_payload(session) if session.awaiting == "confirmacao" else None,
            "supersedes": fields.get("_approval_id") if session.awaiting == "confirmacao" else None,
        }

    def _is_skip(self, value: str) -> bool:
        return value in {"pular", "pule", "sem cc", "sem cco", "sem copia", "sem anexo", "sem anexos", "nenhum", "nenhuma", "nao", "n"}

    def _edit_command(self, value: str) -> str | None:
        if not re.search(r"\b(editar|edit|corrigir|corrija|alterar|altere|mudar|mude|trocar|troque)\b", value):
            return None
        if re.search(r"\bcco\b|oculta|bcc", value):
            return "bcc"
        if re.search(r"\bcc\b|copia", value):
            return "cc"
        if re.search(r"\banexo", value):
            return "attachments"
        if "assunto" in value:
            return "subject"
        if re.search(r"\bcorpo\b|mensagem|texto", value):
            return "body"
        if re.search(r"\bpara\b|destinatario", value):
            return "to"
        return "body"

    def _edit_prompt(self, target: str) -> str:
        return {
            "to": "Para qual e-mail eu envio agora? Pode mandar um ou vários endereços.",
            "cc": "Quais e-mails em cópia (Cc)? Ou diga 'pular'.",
            "bcc": "Quais e-mails em cópia oculta (Cco)? Ou diga 'pular'.",
            "subject": "Qual vai ser o assunto agora?",
            "body": "Me manda o corpo do e-mail revisado.",
            "attachments": "Envie os novos anexos pelo clipe do chat, ou diga 'pular' para seguir sem anexos.",
        }.get(target, "O que voce quer ajustar?")

    def _preview_payload(self, session: EmailSession) -> dict[str, Any]:
        fields = session.fields
        return {
            "to": list(fields.get("to") or []),
            "cc": list(fields.get("cc") or []),
            "bcc": list(fields.get("bcc") or []),
            "subject": str(fields.get("subject") or ""),
            "body": str(fields.get("body") or ""),
            "attachments": [
                {"fileName": str(item.get("fileName") or "anexo"), "mimeType": str(item.get("mimeType") or ""), "size": int(item.get("size") or 0)}
                for item in (fields.get("attachments") or [])
                if isinstance(item, dict)
            ],
        }

    def _exact_payload(self, session: EmailSession) -> dict[str, Any]:
        preview = self._preview_payload(session)
        preview["attachments"] = [
            {
                "fileId": str(item.get("fileId") or ""),
                "fileName": str(item.get("fileName") or "anexo"),
                "mimeType": str(item.get("mimeType") or "application/octet-stream"),
                "size": int(item.get("size") or 0),
                "sha256": str(item.get("sha256") or ""),
            }
            for item in (session.fields.get("attachments") or [])
            if isinstance(item, dict)
        ]
        return preview

    def _resolve_attachments(self, user_id: str, attachment_ids: list[str] | None) -> tuple[list[dict[str, Any]], list[str]]:
        import hashlib
        from app.services.nora_files import owned_bytes

        attached: list[dict[str, Any]] = []
        skipped: list[str] = []
        seen: set[str] = set()
        for raw_id in (attachment_ids or [])[:self.MAX_EMAIL_ATTACHMENTS]:
            file_id = str(raw_id or "").strip()
            if not file_id or file_id in seen:
                continue
            seen.add(file_id)
            try:
                record, file_bytes = owned_bytes(user_id, file_id)
            except Exception:
                skipped.append(file_id[:24])
                continue
            attached.append({
                "fileId": file_id,
                "fileName": str(record.get("name") or "anexo"),
                "mimeType": str(record.get("mimeType") or "application/octet-stream"),
                "size": len(file_bytes),
                "sha256": hashlib.sha256(file_bytes).hexdigest(),
            })
        if sum(int(item.get("size") or 0) for item in attached) > self.MAX_EMAIL_ATTACHMENT_BYTES:
            return [], ["O total dos anexos excede o limite de 24 MB."]
        return attached, skipped

    def _merge_attachment_records(
        self, existing: list[dict[str, Any]], added: list[dict[str, Any]],
    ) -> tuple[list[dict[str, Any]], str | None]:
        by_id = {str(item.get("fileId") or ""): item for item in existing if item.get("fileId")}
        by_id.update({str(item.get("fileId") or ""): item for item in added if item.get("fileId")})
        combined = list(by_id.values())
        if len(combined) > self.MAX_EMAIL_ATTACHMENTS:
            return existing, "O e-mail aceita até 8 arquivos no total."
        if sum(int(item.get("size") or 0) for item in combined) > self.MAX_EMAIL_ATTACHMENT_BYTES:
            return existing, "O tamanho total dos anexos não pode passar de 24 MB."
        return combined, None

    async def _polish_body(self, fields: dict[str, Any], *, user_id: str | None = None) -> str:
        body = str(fields.get("body") or "").strip()
        if not body:
            return body
        prompt = (
            "Transforme o texto abaixo em um e-mail claro, humano e pronto para envio. "
            "Nao invente fatos, valores, datas ou promessas. Responda apenas com o corpo do e-mail.\n\n"
            f"Assunto: {fields.get('subject')}\n"
            f"Texto base:\n{body}"
        )
        response = await self.nora.perguntar_nora(
            [{"role": "user", "content": prompt}], purpose="email-draft",
            max_tokens=1000, require_complete=True, user_id=user_id,
        )
        if "provedor de IA" in response or "servidor de IA" in response or response.lower().startswith("ih, deu ruim"):
            return body
        cleaned = self._clean_body_for_send(response)
        return cleaned or body

    async def _summarize_inbox(self, service: GmailService, normalized: str) -> dict[str, Any]:
        folder = self._folder_from_text(normalized)
        query = self._query_from_text(normalized)
        data = service.list_messages(folder=folder, query=query, max_results=10)
        messages = data.get("messages", [])
        if not messages:
            return {"session_id": None, "status": "resumo", "response": "Nao encontrei e-mails para resumir nesse filtro."}

        facts = "\n".join(
            (
                f"- De: {msg.get('fromName')} <{msg.get('fromEmail')}>; "
                f"assunto: {msg.get('subject') or '(sem assunto)'}; data: {msg.get('dateLabel') or 'nao informada'}; "
                f"marcadores: {', '.join(str(label) for label in msg.get('labels', [])) or 'nenhum'}; "
                f"trecho: {str(msg.get('snippet') or '')[:360]}"
            )
            for msg in messages[:10]
        )
        prompt = (
            "Produza um resumo executivo REAL da caixa de e-mails em português do Brasil. "
            "Não replique a caixa de entrada, não crie tabela e não enumere todos os e-mails. "
            "Sintetize padrões, urgências e decisões. Use no máximo 180 palavras e esta estrutura: "
            "'## Visão geral' com 2 ou 3 frases; '## O que merece atenção' com até 4 tópicos; "
            "'## Próximo passo' com uma recomendação curta. Cite remetente ou assunto somente quando isso ajudar uma ação. "
            "Use exclusivamente os fatos abaixo; se prazo, valor ou pedido não estiver explícito, não invente.\n\n"
            f"E-MAILS ANALISADOS ({len(messages)}):\n{facts}"
        )
        summary = await self.nora.perguntar_nora([{"role": "user", "content": prompt}])
        if self._invalid_inbox_summary(summary):
            summary = self._deterministic_inbox_summary(messages, folder)
        return {
            "session_id": None,
            "status": "resumo",
            "response": summary,
            "summaryCount": len(messages),
            "folder": folder,
            "query": query,
        }

    def _invalid_inbox_summary(self, value: str) -> bool:
        cleaned = str(value or "").strip()
        normalized = self._normalize(cleaned)
        return (
            not cleaned
            or len(cleaned) > 2400
            or len(cleaned.splitlines()) > 28
            or "|---" in cleaned
            or "| ---" in cleaned
            or "groq_api_key" in normalized
            or normalized.startswith("ih, deu ruim")
        )

    def _deterministic_inbox_summary(self, messages: list[dict[str, Any]], folder: str) -> str:
        unread = sum("UNREAD" in {str(label).upper() for label in item.get("labels", [])} for item in messages)
        important = sum("IMPORTANT" in {str(label).upper() for label in item.get("labels", [])} for item in messages)
        priority_terms = (
            "urgente", "prazo", "vence", "vencimento", "pagamento", "boleto", "cliente",
            "proposta", "contrato", "reuniao", "reunião", "entrevista", "confirmar", "aprovar",
        )
        low_priority_terms = ("newsletter", "promocao", "promoção", "oferta", "linkedin", "alerta de vaga")

        def priority(item: dict[str, Any]) -> tuple[int, int]:
            labels = {str(label).upper() for label in item.get("labels", [])}
            text = self._normalize(f"{item.get('subject', '')} {item.get('snippet', '')}")
            score = (3 if "IMPORTANT" in labels else 0) + (2 if "UNREAD" in labels else 0)
            score += sum(2 for term in priority_terms if self._normalize(term) in text)
            score -= sum(2 for term in low_priority_terms if self._normalize(term) in text)
            return score, 1 if "UNREAD" in labels else 0

        ranked = sorted(messages, key=priority, reverse=True)
        attention = [item for item in ranked if priority(item)[0] > 0][:4] or ranked[:3]
        overview = f"Analisei {len(messages)} e-mails recentes da {self._folder_label(folder)}."
        signals = []
        if unread:
            signals.append(f"{unread} não lido{'s' if unread != 1 else ''}")
        if important:
            signals.append(f"{important} marcado{'s' if important != 1 else ''} como importante")
        if signals:
            overview += f" Há {', '.join(signals)} entre eles."
        lines = ["## Visão geral", overview, "", "## O que merece atenção"]
        for item in attention:
            sender = str(item.get("fromName") or item.get("fromEmail") or "Remetente")
            subject = str(item.get("subject") or "Sem assunto")
            lines.append(f"- **{subject[:100]}** — {sender[:70]}. Revise o pedido e defina a resposta.")
        lines.extend(["", "## Próximo passo", "Comece pelos itens não lidos ou marcados como importantes e arquive notificações sem ação."])
        return "\n".join(lines)

    def _list_messages(self, service: GmailService, normalized: str) -> dict[str, Any]:
        folder = self._folder_from_text(normalized)
        query = self._query_from_text(normalized)
        data = service.list_messages(folder=folder, query=query, max_results=8)
        messages = data.get("messages", [])
        if not messages:
            return {"session_id": None, "status": "consulta", "response": "Nao encontrei e-mails nesse filtro."}
        if re.search(r"\b(?:primeiro|primeira|1o|1º)\b", normalized):
            messages = messages[:1]
        elif re.search(r"\b(?:segundo|segunda|2o|2º)\b", normalized):
            messages = messages[1:2]
        elif re.search(r"\b(?:terceiro|terceira|3o|3º)\b", normalized):
            messages = messages[2:3]
        if not messages:
            return {"session_id": None, "status": "consulta", "response": "Não há um e-mail nessa posição no filtro atual."}
        lines = [
            f"- {msg.get('fromName')}: {msg.get('subject')} ({msg.get('dateLabel')})"
            for msg in messages
        ]
        return {
            "session_id": None,
            "status": "consulta",
            "response": f"Aqui estao os e-mails em {self._folder_label(folder)}:\n" + "\n".join(lines),
            "messages": messages,
            "folder": folder,
            "query": query,
        }

    def _group_messages_by_category(self, service: GmailService, normalized: str) -> dict[str, Any]:
        folder = self._folder_from_text(normalized)
        data = service.list_messages(folder=folder, query=self._query_from_text(normalized), max_results=20)
        messages = data.get("messages", [])
        if not messages:
            return {"session_id": None, "status": "categorias", "response": "Nao encontrei e-mails para agrupar nesse filtro."}
        groups: dict[str, list[dict[str, Any]]] = {}
        for message in messages:
            category = self._classify_category(message)
            groups.setdefault(category, []).append(message)
        labels = {
            "principal": "Principal",
            "financeiro": "Financeiro",
            "trabalho": "Trabalho",
            "promocoes": "Promocoes",
            "social": "Social",
            "atualizacoes": "Atualizacoes",
            "suporte": "Suporte",
        }
        lines = []
        for category, items in sorted(groups.items(), key=lambda item: (-len(item[1]), item[0])):
            preview = "; ".join(str(msg.get("subject") or "(sem assunto)")[:70] for msg in items[:3])
            lines.append(f"- {labels.get(category, category.title())}: {len(items)} e-mail(s). {preview}")
        return {
            "session_id": None,
            "status": "categorias",
            "response": "Agrupei os e-mails recentes por categoria:\n" + "\n".join(lines),
            "groups": {category: [msg.get("id") for msg in items] for category, items in groups.items()},
            "messages": messages,
            "folder": folder,
        }

    def _extract_initial_fields(self, session: EmailSession, text: str, *, prefill: EmailActionPrefill | None = None) -> None:
        session.fields.setdefault("cc", [])
        session.fields.setdefault("bcc", [])
        session.fields.setdefault("attachments", [])
        self._apply_prefill(session, prefill or extract_action_parameters("email", text))

    def _apply_prefill(self, session: EmailSession, prefill: EmailActionPrefill) -> None:
        for key, value in prefill.fields.items():
            if key not in {"to", "cc", "bcc", "subject", "body"}:
                raise HTTPException(400, "Campo inválido para o rascunho.")
            session.fields[key] = self._clean_body_for_send(value) if key == "body" else value
            if key == "body":
                session.fields["_body_literal"] = prefill.literal_body
            if key == "subject":
                session.fields.pop("_subject_inferred", None)
        for key in prefill.unresolved:
            if key in {"to", "cc", "bcc"}:
                session.fields.pop(key, None)
        if prefill.attachments_requested or session.fields.get("_attachment_errors"):
            session.fields["_attachments_done"] = bool(session.fields.get("attachments")) and not session.fields.get("_attachment_errors")
        else:
            session.fields.setdefault("_attachments_done", True)
        if session.fields.get("body") and not session.fields.get("subject"):
            session.fields["subject"] = self._infer_subject_from_body(str(session.fields["body"]))
            session.fields["_subject_inferred"] = True

    def _summary(self, fields: dict[str, Any]) -> str:
        lines = [
            f"- Para: {', '.join(fields.get('to', []))}",
        ]
        if fields.get("cc"):
            lines.append(f"- Cc: {', '.join(fields['cc'])}")
        if fields.get("bcc"):
            lines.append(f"- Cco: {', '.join(fields['bcc'])}")
        lines.append(f"- Assunto: {fields.get('subject')}{' (sugerido)' if fields.get('_subject_inferred') else ''}")
        attachments = fields.get("attachments") or []
        if attachments:
            names = ", ".join(str(item.get("fileName") or "anexo") for item in attachments)
            lines.append(f"- Anexos: {names}")
        lines.extend(["", str(fields.get("body") or "").strip()])
        return "\n".join(lines)

    def _extract_emails(self, text: str) -> list[str]:
        return sorted(set(re.findall(r"[\w.+-]+@[\w-]+\.[\w.-]+", text)))

    def _extract_subject(self, text: str) -> str:
        match = re.search(r"\b(?:assunto|sobre)\s*[:\-]?\s*(.+?)(?:\s+(?:mensagem|corpo|dizendo|texto)\b|$)", text, re.I)
        return match.group(1).strip(" .,:;-")[:180] if match else ""

    def _extract_body(self, text: str) -> str:
        match = re.search(
            r"\b(?:mensagem|corpo|dizendo|texto|perguntando|pergunte|diga|avisando|avise|falando|fale|com o texto|com a mensagem)\s*[:\-]?\s*(.+)$",
            text,
            re.I | re.S,
        )
        if match:
            return match.group(1).strip()[:12000]
        marker = re.search(
            r"\b(?:para|pra)\s+[\w.+-]+@[\w-]+\.[\w.-]+(?:\s*[,;:-]\s*|\s+)(.+)$",
            text,
            re.I | re.S,
        )
        return marker.group(1).strip(" ,.:;-")[:12000] if marker else ""

    def _infer_subject_from_body(self, body: str) -> str:
        clean = re.sub(r"\s+", " ", body).strip(" .,:;-")
        if not clean:
            return "Mensagem do Norium"
        if "como foi seu dia" in self._normalize(clean):
            return "Como foi seu dia?"
        return clean[:72].rstrip(" .,:;-") or "Mensagem do Norium"

    def _is_compose_intent(self, value: str) -> bool:
        if re.search(r"\b(enviar|envie|mande|mandar|redigir|escrever)\s+(?:um|uma|o|a)?\s*e-?mail\b", value):
            return True
        if re.search(r"[\w.+-]+@[\w-]+\.[\w.-]+", value) and any(word in value for word in ["envie", "enviar", "mande", "mandar", "redigir", "escrever"]):
            return True
        return any(word in value for word in [
            "enviar email", "enviar e-mail", "mandar email", "mandar e-mail", "mande email", "mande e-mail",
            "envie email", "envie e-mail", "novo email", "novo e-mail", "redigir email", "redigir e-mail",
            "escrever email", "escrever e-mail",
        ])

    def _is_summary_intent(self, value: str) -> bool:
        return any(word in value for word in ["resumir", "resumo", "prioridades", "importante"])

    def _is_category_intent(self, value: str) -> bool:
        return any(word in value for word in ["agrupar", "categorizar", "categoria", "categorias", "classificar emails", "classificar e-mails"])

    def _is_list_intent(self, value: str) -> bool:
        return any(word in value for word in [
            "listar", "mostrar", "mostre", "meus emails", "meus e-mails", "ver emails", "ver e-mails", "caixa de entrada", "nao lidos", "nao lido",
            "enviados", "enviado", "rascunhos", "spam", "lixeira", "com anexo", "anexos", "pesquisar email",
        ])

    def _folder_from_text(self, value: str) -> str:
        if "enviados" in value or "enviado" in value or "sent" in value:
            return "sent"
        if "rascunho" in value:
            return "drafts"
        if "spam" in value:
            return "spam"
        if "lixeira" in value or "lixo" in value:
            return "trash"
        if "estrela" in value or "favorito" in value:
            return "starred"
        if "importante" in value or "prioridade" in value:
            return "important"
        if "nao lido" in value or "nao lidos" in value:
            return "unread"
        if "todos os emails" in value or "todos os e-mails" in value:
            return "all"
        return "inbox"

    def _query_from_text(self, value: str) -> str:
        query: list[str] = []
        if "com anexo" in value or "anexos" in value:
            query.append("has:attachment")
        if "hoje" in value:
            today = datetime.now(timezone(timedelta(hours=-3))).strftime("%Y/%m/%d")
            query.append(f"after:{today}")
        if "ontem" in value:
            today = datetime.now(timezone(timedelta(hours=-3))).date()
            yesterday = today - timedelta(days=1)
            query.append(f"after:{yesterday.strftime('%Y/%m/%d')} before:{today.strftime('%Y/%m/%d')}")
        sender = re.search(r"\b(?:de|remetente)\s+([\w.+-]+@[\w-]+\.[\w.-]+)", value)
        if sender:
            query.append(f"from:{sender.group(1)}")
        to_match = re.search(r"\b(?:para|destinatario)\s+([\w.+-]+@[\w-]+\.[\w.-]+)", value)
        if to_match:
            query.append(f"to:{to_match.group(1)}")
        subject = re.search(r"\b(?:assunto|titulo)\s+(.+)$", value)
        if subject:
            cleaned = subject.group(1).strip(" :.-")
            if cleaned:
                query.append(f"subject:({cleaned[:80]})")
        return " ".join(query).strip()

    def _classify_category(self, message: dict[str, Any]) -> str:
        labels = {str(label).upper() for label in message.get("labels", [])}
        text = self._normalize(
            f"{message.get('fromName', '')} {message.get('fromEmail', '')} {message.get('subject', '')} {message.get('snippet', '')}"
        )
        if "CATEGORY_PROMOTIONS" in labels or any(term in text for term in ("promocao", "promocoes", "oferta", "desconto", "cupom")):
            return "promocoes"
        if "CATEGORY_SOCIAL" in labels or any(term in text for term in ("linkedin", "facebook", "instagram", "rede social")):
            return "social"
        if any(term in text for term in ("boleto", "fatura", "recibo", "pagamento", "pix", "nubank", "banco")):
            return "financeiro"
        if "CATEGORY_UPDATES" in labels or any(term in text for term in ("atualizacao", "notificacao", "confirmacao", "alerta")):
            return "atualizacoes"
        if any(term in text for term in ("cliente", "proposta", "contrato", "reuniao", "orcamento", "trabalho", "comercial")):
            return "trabalho"
        if any(term in text for term in ("suporte", "ticket", "erro", "chamado", "atendimento")):
            return "suporte"
        return "principal"

    def _folder_label(self, folder: str) -> str:
        return {
            "inbox": "caixa de entrada",
            "sent": "enviados",
            "drafts": "rascunhos",
            "spam": "spam",
            "trash": "lixeira",
            "starred": "com estrela",
            "important": "importantes",
            "unread": "nao lidos",
            "all": "todos os e-mails",
        }.get(folder, folder)

    def _clean_body_for_send(self, value: str) -> str:
        body = value.strip()
        forbidden = [
            "nao tenho contexto", "não tenho contexto", "nao consigo", "não consigo",
            "desculpa", "desculpe", "olhei para o historico", "histórico vazio",
            "preciso de mais contexto", "se voce precisar", "se você precisar",
        ]
        lowered = self._normalize(body)
        if any(self._normalize(item) in lowered for item in forbidden):
            lines = [
                line for line in body.splitlines()
                if not any(self._normalize(item) in self._normalize(line) for item in forbidden)
            ]
            body = "\n".join(lines).strip()
        return body[:12000]

    def _is_cancel(self, value: str) -> bool:
        return value in {"cancelar", "cancela", "desistir", "parar"}

    def _is_yes(self, value: str) -> bool:
        return value in {"sim", "s", "confirmo", "confirmar", "pode enviar", "envia", "enviar", "ok"}

    def _is_no(self, value: str) -> bool:
        return value in {"nao", "n", "negativo", "corrigir", "editar"}

    def _normalize(self, value: str) -> str:
        lowered = value.lower().strip()
        return "".join(char for char in unicodedata.normalize("NFKD", lowered) if not unicodedata.combining(char))

shared_email_agent = EmailAgent()
