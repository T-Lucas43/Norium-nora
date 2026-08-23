"""Dominio de brainstorm extraido para concentrar sessoes e tempo real."""

from __future__ import annotations

import json
from collections import defaultdict
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Query, WebSocket, WebSocketDisconnect
from pydantic import Field

from app.shared.schemas import StrictModel

from app.routers.auth_router import current_user, user_from_websocket_ticket
from app.routers.inbox_router import record_event
from app.services.brainstorm_store import (
    BrainstormLockedError,
    create_brainstorm_session,
    delete_brainstorm_session,
    get_brainstorm_session,
    list_brainstorm_sessions,
    now_iso,
    save_brainstorm_board,
    session_is_locked,
    update_brainstorm_session,
)
from app.services.nora import NoraIAService
from app.services.task_store import create_task


router = APIRouter(prefix="/api/brainstorm", tags=["Brainstorm colaborativo"])
nora_service = NoraIAService()


class BrainstormCreatePayload(StrictModel):
    title: str = Field(min_length=2, max_length=160)
    objective: str = Field(default="", max_length=1200)
    responsibleId: str | None = Field(default=None, max_length=160)
    responsibleName: str | None = Field(default=None, max_length=160)
    template: Literal["livre", "swot", "mapa-mental", "jornada", "retrospectiva"] = "livre"
    durationMinutes: int = Field(default=15, ge=1, le=240)


class BrainstormUpdatePayload(StrictModel):
    title: str | None = Field(default=None, min_length=2, max_length=160)
    objective: str | None = Field(default=None, max_length=1200)
    responsibleId: str | None = Field(default=None, max_length=160)
    responsibleName: str | None = Field(default=None, max_length=160)
    status: Literal["ativo", "encerrado", "arquivado"] | None = None
    template: str | None = Field(default=None, max_length=60)
    timer: dict[str, Any] | None = None


class BoardPayload(StrictModel):
    nodes: list[dict[str, Any]] = Field(default_factory=list, max_length=600)
    edges: list[dict[str, Any]] = Field(default_factory=list, max_length=1000)
    viewport: dict[str, Any] = Field(default_factory=dict)
    clientId: str | None = Field(default=None, max_length=160)


class ConvertTaskPayload(StrictModel):
    nodeId: str = Field(min_length=1, max_length=180)
    projectId: str = "default"
    projectName: str | None = Field(default=None, max_length=160)
    priority: Literal["baixa", "media", "alta", "urgente"] = "media"
    dueDate: str | None = None


class NoraBoardPayload(StrictModel):
    action: Literal["resumir", "gerar_ideias", "proximos_passos", "analisar_impacto"] = "resumir"
    instruction: str = Field(default="", max_length=1000)


def collaboration_tenant_id(user: dict[str, Any]) -> str:
    return str(user.get("teamOwnerId") or user.get("id") or "lucas123")


def require_brainstorm_access(user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    permissions = user.get("permissions") if isinstance(user.get("permissions"), dict) else {}
    if user.get("systemAdmin") or permissions.get("equipe"):
        return user
    raise HTTPException(status_code=403, detail="Brainstorm colaborativo exige acesso ao modo Equipe.")


def can_manage_session(user: dict[str, Any], session: dict[str, Any]) -> bool:
    return bool(
        user.get("systemAdmin")
        or str(session.get("responsibleId") or "") == str(user.get("id") or "")
        or str(session.get("createdBy") or "") == str(user.get("id") or "")
        or user.get("role") == "owner"
    )


class BrainstormConnectionManager:
    def __init__(self) -> None:
        self.connections: dict[str, dict[str, list[WebSocket]]] = defaultdict(lambda: defaultdict(list))

    async def connect(self, tenant_id: str, session_id: str, websocket: WebSocket) -> None:
        await websocket.accept()
        self.connections[tenant_id][session_id].append(websocket)

    def disconnect(self, tenant_id: str, session_id: str, websocket: WebSocket) -> None:
        sockets = self.connections.get(tenant_id, {}).get(session_id, [])
        if websocket in sockets:
            sockets.remove(websocket)
        if not sockets:
            self.connections.get(tenant_id, {}).pop(session_id, None)
        if not self.connections.get(tenant_id):
            self.connections.pop(tenant_id, None)

    async def broadcast(self, tenant_id: str, session_id: str, payload: dict[str, Any]) -> None:
        stale: list[WebSocket] = []
        for socket in list(self.connections.get(tenant_id, {}).get(session_id, [])):
            try:
                await socket.send_json(payload)
            except Exception:
                stale.append(socket)
        for socket in stale:
            self.disconnect(tenant_id, session_id, socket)


manager = BrainstormConnectionManager()


@router.get("/sessions")
async def list_sessions(user: dict[str, Any] = Depends(require_brainstorm_access)) -> list[dict[str, Any]]:
    return await list_brainstorm_sessions(collaboration_tenant_id(user))


@router.post("/sessions")
async def create_session(payload: BrainstormCreatePayload, user: dict[str, Any] = Depends(require_brainstorm_access)) -> dict[str, Any]:
    tenant_id = collaboration_tenant_id(user)
    session = await create_brainstorm_session(tenant_id, payload.model_dump(), user)
    await record_event(
        source="brainstorm",
        title=f"Brainstorm criado: {session['title']}",
        description=f"Responsavel: {session['responsibleName']}. {session.get('objective') or 'Sessao pronta para receber ideias.'}",
        metadata={"userId": tenant_id, "action": "brainstorm_created", "sessionId": session["id"]},
    )
    return session


@router.get("/sessions/{session_id}")
async def get_session(session_id: str, user: dict[str, Any] = Depends(require_brainstorm_access)) -> dict[str, Any]:
    session = await get_brainstorm_session(collaboration_tenant_id(user), session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Sessao de brainstorm nao encontrada.")
    return session


@router.patch("/sessions/{session_id}")
async def patch_session(session_id: str, payload: BrainstormUpdatePayload, user: dict[str, Any] = Depends(require_brainstorm_access)) -> dict[str, Any]:
    tenant_id = collaboration_tenant_id(user)
    current = await get_brainstorm_session(tenant_id, session_id)
    if not current:
        raise HTTPException(status_code=404, detail="Sessao de brainstorm nao encontrada.")
    updates = payload.model_dump(exclude_unset=True)
    current_timer = current.get("timer") if isinstance(current.get("timer"), dict) else {}
    requested_timer = updates.get("timer") if isinstance(updates.get("timer"), dict) else {}
    if current_timer.get("finishedAt") and (updates.get("status") == "ativo" or requested_timer.get("running")):
        raise HTTPException(status_code=409, detail="Uma sessao encerrada pelo timer nao pode ser reaberta.")
    automatic_finish = (
        str(current.get("status") or "") == "encerrado"
        and updates.get("status") == "encerrado"
        and set(updates).issubset({"status", "timer"})
    )
    if not can_manage_session(user, current) and not automatic_finish:
        raise HTTPException(status_code=403, detail="Somente o responsavel ou lider pode alterar esta sessao.")
    updated = await update_brainstorm_session(tenant_id, session_id, updates, user)
    await manager.broadcast(tenant_id, session_id, {"type": "SESSION_UPDATED", "session": updated})
    return updated or current


@router.put("/sessions/{session_id}/board")
async def put_board(session_id: str, payload: BoardPayload, user: dict[str, Any] = Depends(require_brainstorm_access)) -> dict[str, Any]:
    tenant_id = collaboration_tenant_id(user)
    try:
        updated = await save_brainstorm_board(tenant_id, session_id, payload.model_dump(exclude={"clientId"}), user)
    except BrainstormLockedError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    if not updated:
        raise HTTPException(status_code=404, detail="Sessao de brainstorm nao encontrada.")
    await manager.broadcast(
        tenant_id,
        session_id,
        {"type": "BOARD_UPDATED", "session": updated, "clientId": payload.clientId, "timestamp": now_iso()},
    )
    return updated


@router.post("/sessions/{session_id}/convert-task")
async def convert_idea_to_task(session_id: str, payload: ConvertTaskPayload, user: dict[str, Any] = Depends(require_brainstorm_access)) -> dict[str, Any]:
    tenant_id = collaboration_tenant_id(user)
    session = await get_brainstorm_session(tenant_id, session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Sessao de brainstorm nao encontrada.")
    if session_is_locked(session):
        raise HTTPException(status_code=409, detail="A sessao foi encerrada e nao aceita novas tarefas ou alteracoes.")
    nodes = session.get("board", {}).get("nodes", [])
    node = next((item for item in nodes if str(item.get("id")) == payload.nodeId), None)
    if not isinstance(node, dict):
        raise HTTPException(status_code=404, detail="Ideia nao encontrada no quadro.")
    data = node.get("data") if isinstance(node.get("data"), dict) else {}
    title = str(data.get("label") or data.get("text") or "Ideia do brainstorm").strip()[:160]
    task = create_task(
        tenant_id,
        {
            "projectId": payload.projectId,
            "title": title,
            "description": f"Convertida do brainstorm '{session.get('title')}'.\n\n{str(data.get('description') or '')}".strip(),
            "category": "planejamento",
            "status": "pendente",
            "priority": payload.priority,
            "labels": ["brainstorm"],
            "dueDate": payload.dueDate,
            "assigneeId": str(data.get("responsibleId") or user.get("id") or ""),
            "assigneeName": str(data.get("responsibleName") or user.get("nome") or ""),
        },
    )
    await record_event(
        source="brainstorm",
        title=f"Ideia convertida em tarefa: {title}",
        description=f"Brainstorm: {session.get('title')}. Projeto: {payload.projectName or payload.projectId}.",
        metadata={"userId": tenant_id, "action": "brainstorm_task_created", "sessionId": session_id, "taskId": task.get("id")},
    )
    return {"status": "criada", "task": task}


@router.post("/sessions/{session_id}/nora")
async def brainstorm_with_nora(session_id: str, payload: NoraBoardPayload, user: dict[str, Any] = Depends(require_brainstorm_access)) -> dict[str, Any]:
    session = await get_brainstorm_session(collaboration_tenant_id(user), session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Sessao de brainstorm nao encontrada.")
    nodes = session.get("board", {}).get("nodes", [])
    ideas = [str((item.get("data") or {}).get("label") or "").strip() for item in nodes if isinstance(item, dict)]
    real_ideas = [idea for idea in ideas if idea]
    if not real_ideas and payload.action != "gerar_ideias":
        return {"status": "precisa_dados", "response": "O quadro ainda esta vazio. Adicione ideias ou peça para eu gerar os primeiros pontos."}
    action_instruction = {
        "resumir": "Resuma os temas centrais, divergencias e consensos. Termine com tres proximos passos objetivos.",
        "gerar_ideias": "Gere seis ideias curtas, variadas e acionaveis para iniciar a sessao.",
        "proximos_passos": "Transforme as ideias em um plano de acao priorizado com responsaveis a definir.",
        "analisar_impacto": "Analise o impacto potencial de cada ideia, destacando beneficio, esforco, risco e dependencia. Termine com uma ordem de prioridade justificada.",
    }[payload.action]
    prompt = (
        "Voce esta apoiando uma sessao de brainstorm do Norium. Use somente os dados reais informados; nao diga que salvou ou executou nada. "
        f"Sessao: {session.get('title')}. Objetivo: {session.get('objective') or 'nao informado'}. "
        f"Ideias atuais: {json.dumps(real_ideas, ensure_ascii=False)}. "
        f"Pedido adicional: {payload.instruction or 'nenhum'}. {action_instruction}"
    )
    response = await nora_service.perguntar_nora([{"role": "user", "content": prompt}])
    return {"status": "analisado", "response": response, "action": payload.action}


@router.delete("/sessions/{session_id}")
async def delete_session(session_id: str, user: dict[str, Any] = Depends(require_brainstorm_access)) -> dict[str, str]:
    tenant_id = collaboration_tenant_id(user)
    session = await get_brainstorm_session(tenant_id, session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Sessao de brainstorm nao encontrada.")
    if not can_manage_session(user, session):
        raise HTTPException(status_code=403, detail="Somente o responsavel ou lider pode excluir esta sessao.")
    await delete_brainstorm_session(tenant_id, session_id)
    return {"status": "excluida"}


@router.websocket("/ws/{session_id}")
async def brainstorm_socket(session_id: str, websocket: WebSocket, ticket: str | None = Query(default=None)) -> None:
    try:
        user = await user_from_websocket_ticket(ticket or "")
        require_brainstorm_access(user)
    except Exception:
        await websocket.close(code=4401)
        return
    tenant_id = collaboration_tenant_id(user)
    session = await get_brainstorm_session(tenant_id, session_id)
    if not session:
        await websocket.close(code=4404)
        return
    await manager.connect(tenant_id, session_id, websocket)
    presence = {"id": str(user.get("id") or ""), "name": str(user.get("nome") or user.get("email") or "Membro"), "photoUrl": str(user.get("fotoUrl") or "")}
    await websocket.send_json({"type": "CONNECTED", "session": session, "timestamp": now_iso()})
    await manager.broadcast(tenant_id, session_id, {"type": "PRESENCE_JOIN", "participant": presence})
    try:
        while True:
            raw = await websocket.receive_text()
            try:
                message = json.loads(raw)
            except json.JSONDecodeError:
                await websocket.send_json({"type": "ERROR", "detail": "JSON invalido."})
                continue
            message_type = str(message.get("type") or "")
            if message_type == "PING":
                await websocket.send_json({"type": "PONG", "timestamp": now_iso()})
            elif message_type == "CURSOR":
                await manager.broadcast(tenant_id, session_id, {**message, "participant": presence})
            elif message_type == "BOARD_UPDATE" and isinstance(message.get("board"), dict):
                board = BoardPayload.model_validate({**message["board"], "clientId": message.get("clientId")})
                try:
                    updated = await save_brainstorm_board(tenant_id, session_id, board.model_dump(exclude={"clientId"}), user)
                    await manager.broadcast(tenant_id, session_id, {"type": "BOARD_UPDATED", "session": updated, "clientId": board.clientId, "timestamp": now_iso()})
                except BrainstormLockedError as exc:
                    locked_session = await get_brainstorm_session(tenant_id, session_id)
                    await manager.broadcast(
                        tenant_id,
                        session_id,
                        {"type": "SESSION_LOCKED", "session": locked_session, "detail": str(exc), "timestamp": now_iso()},
                    )
            else:
                await websocket.send_json({"type": "ACK", "timestamp": now_iso()})
    except WebSocketDisconnect:
        manager.disconnect(tenant_id, session_id, websocket)
        await manager.broadcast(tenant_id, session_id, {"type": "PRESENCE_LEAVE", "participant": presence})
    except Exception:
        manager.disconnect(tenant_id, session_id, websocket)
