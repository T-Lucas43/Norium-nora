from __future__ import annotations

import os
import base64
import tempfile
import time
import unittest
from contextlib import ExitStack
from pathlib import Path
from unittest.mock import AsyncMock, patch

from fastapi import HTTPException

from app.modules.chat import router as chat_router
from app.services import wapi_binding as wb
from app.services.wapi_binding import InstanceBinding
from app.services.wapi_messaging import wapi_phone, InvalidGroupParticipants
from app.services.conversation_store import load_conversations, new_conversation, save_conversations


def chat_user(user_id: str) -> dict:
    return {
        "id": user_id,
        "role": "owner",
        "plan": "enterprise",
        "status": "ativo",
        "permissions": {"chat": True, "integracao_whatsapp": True},
    }


def bind(user_id: str, instance_id: str, token: str) -> None:
    wb.save_binding(user_id, InstanceBinding(instance_id=instance_id, token=token, state="connected"))


class WapiPhoneNormalizationTests(unittest.TestCase):
    def test_individual_jid_becomes_digits(self) -> None:
        self.assertEqual("5511999998888", wapi_phone("5511999998888@c.us"))
        self.assertEqual("5511999998888", wapi_phone("+55 11 99999-8888"))

    def test_group_id_is_preserved(self) -> None:
        self.assertEqual("120363000000000000@g.us", wapi_phone("120363000000000000@g.us"))


class WapiMessagingRouteTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        self._stack = ExitStack()
        temp_dir = self._stack.enter_context(tempfile.TemporaryDirectory())
        self._stack.enter_context(patch.dict(os.environ, {"NORIUM_DATA_DIR": temp_dir}))
        upload_dir = Path(temp_dir) / "uploads"
        upload_dir.mkdir(parents=True, exist_ok=True)
        self._stack.enter_context(patch.object(chat_router, "UPLOAD_DIR", upload_dir))
        self._send_text = AsyncMock(return_value={"messageId": "MID-1"})
        self._stack.enter_context(patch.object(chat_router.wapi_messaging._client, "send_text", self._send_text))

    def tearDown(self) -> None:
        self._stack.close()

    async def test_send_without_instance_returns_409(self) -> None:
        payload = chat_router.EnviarMensagemPayload(conversa_id="5511999998888", texto="ola")
        with self.assertRaises(HTTPException) as error:
            await chat_router.enviar_mensagem(payload, chat_user("user-a"))
        self.assertEqual(409, error.exception.status_code)
        self._send_text.assert_not_awaited()

    async def test_send_uses_own_instance_and_persists(self) -> None:
        bind("user-a", "INST-A", "tok-a")
        payload = chat_router.EnviarMensagemPayload(conversa_id="5511999998888@c.us", texto="ola mundo")
        result = await chat_router.enviar_mensagem(payload, chat_user("user-a"))
        self.assertEqual("enviado_real", result["status"])
        # chamou o cliente com a instância do próprio usuário e o número normalizado
        self._send_text.assert_awaited_once()
        args = self._send_text.await_args.args
        self.assertEqual("INST-A", args[0])
        self.assertEqual("tok-a", args[1])
        self.assertEqual("5511999998888", args[2])
        # persistiu no store de conversas do usuário
        from app.services.conversation_store import load_conversations
        db = await load_conversations("user-a")
        self.assertIn("5511999998888@c.us", db)
        textos = [m.get("texto") for m in db["5511999998888@c.us"].get("mensagens", [])]
        self.assertIn("ola mundo", textos)

    async def test_one_account_cannot_send_through_another(self) -> None:
        # A vincula INST-A; B não vincula nada. B tenta enviar -> 409, sem usar INST-A.
        bind("user-a", "INST-A", "tok-a")
        payload = chat_router.EnviarMensagemPayload(conversa_id="5511999998888", texto="x")
        with self.assertRaises(HTTPException) as error:
            await chat_router.enviar_mensagem(payload, chat_user("user-b"))
        self.assertEqual(409, error.exception.status_code)
        self._send_text.assert_not_awaited()

    async def test_group_creation_sends_only_numeric_participants(self) -> None:
        bind("user-a", "INST-A", "tok-a")
        create_group = AsyncMock(return_value={"group": {"id": "120363000000000000@g.us"}})
        with patch.object(chat_router.wapi_messaging._client, "create_group", create_group):
            await chat_router.wapi_messaging.create_group(
                "user-a",
                "Equipe",
                ["5511999998888@c.us", "219451387551856@lid", "123@newsletter"],
            )
        self.assertEqual(["5511999998888"], create_group.await_args.args[3])

    async def test_group_creation_rejects_only_lid_participants(self) -> None:
        bind("user-a", "INST-A", "tok-a")
        with self.assertRaises(InvalidGroupParticipants):
            await chat_router.wapi_messaging.create_group(
                "user-a",
                "Equipe",
                ["219451387551856@lid"],
            )

    async def test_group_route_returns_422_for_only_lid_participants(self) -> None:
        bind("user-a", "INST-A", "tok-a")
        payload = chat_router.CriarGrupoPayload(nome="Equipe", participantes=["219451387551856@lid"])
        with self.assertRaises(HTTPException) as error:
            await chat_router.criar_grupo(payload, chat_user("user-a"))
        self.assertEqual(422, error.exception.status_code)

    async def test_edit_route_updates_only_own_stored_outgoing_message(self) -> None:
        bind("user-a", "INST-A", "tok-a")
        conversation_id = "5511999998888@s.whatsapp.net"
        conversation = new_conversation(conversation_id, contato="Maria", channel="whatsapp")
        conversation["mensagens"] = [
            {
                "id": "MSG-EDIT",
                "remetente": "usuario",
                "texto": "antes",
                "tipo": "texto",
                "timestamp": int(time.time()),
                "status": "enviado",
            }
        ]
        conversation["ultimoTexto"] = "antes"
        await save_conversations({conversation_id: conversation}, "user-a")
        edit = AsyncMock(return_value={"error": False})
        with patch.object(chat_router.wapi_messaging._client, "edit_message", edit):
            result = await chat_router.editar_mensagem(
                chat_router.EditarMensagemPayload(
                    conversa_id=conversation_id,
                    mensagem_id="MSG-EDIT",
                    texto="depois",
                ),
                chat_user("user-a"),
            )
        self.assertEqual("editada", result["status"])
        self.assertEqual(("INST-A", "tok-a", "5511999998888", "MSG-EDIT", "depois"), edit.await_args.args)
        stored = (await load_conversations("user-a"))[conversation_id]
        self.assertEqual("depois", stored["mensagens"][0]["texto"])
        self.assertTrue(stored["mensagens"][0]["editada"])
        self.assertTrue(stored["mensagens"][0]["editadoEm"])
        self.assertEqual("depois", stored["ultimoTexto"])

    async def test_edit_route_cannot_target_another_tenant_message(self) -> None:
        bind("user-a", "INST-A", "tok-a")
        conversation_id = "5511999998888@s.whatsapp.net"
        conversation = new_conversation(conversation_id, contato="Maria", channel="whatsapp")
        conversation["mensagens"] = [
            {"id": "PRIVATE", "remetente": "usuario", "texto": "segredo", "timestamp": int(time.time())}
        ]
        await save_conversations({conversation_id: conversation}, "user-a")
        with self.assertRaises(HTTPException) as error:
            await chat_router.editar_mensagem(
                chat_router.EditarMensagemPayload(
                    conversa_id=conversation_id,
                    mensagem_id="PRIVATE",
                    texto="invasao",
                ),
                chat_user("user-b"),
            )
        self.assertEqual(404, error.exception.status_code)

    async def test_forward_resends_text_through_official_send_and_persists_flag(self) -> None:
        bind("user-a", "INST-A", "tok-a")
        source_id = "5511888887777@s.whatsapp.net"
        destination_id = "120363000000000000@g.us"
        conversation = new_conversation(source_id, contato="Ana", channel="whatsapp")
        conversation["mensagens"] = [
            {"id": "SOURCE-1", "remetente": "contato", "texto": "encaminhe isto", "timestamp": int(time.time())}
        ]
        await save_conversations({source_id: conversation}, "user-a")
        result = await chat_router.encaminhar_mensagens(
            chat_router.EncaminharMensagensPayload(
                destino_id=destination_id,
                mensagens_ids=["SOURCE-1"],
            ),
            chat_user("user-a"),
        )
        self.assertEqual("encaminhado", result["status"])
        self.assertEqual(1, result["total"])
        self.assertEqual("120363000000000000@g.us", self._send_text.await_args.args[2])
        self.assertEqual("encaminhe isto", self._send_text.await_args.args[3])
        stored = (await load_conversations("user-a"))[destination_id]["mensagens"][-1]
        self.assertEqual("encaminhe isto", stored["texto"])
        self.assertTrue(stored["encaminhada"])

    async def test_forward_reads_media_from_tenant_local_upload(self) -> None:
        bind("user-a", "INST-A", "tok-a")
        source_id = "5511888887777@s.whatsapp.net"
        destination_id = "120363000000000000@g.us"
        media_bytes = b"\x89PNG\r\n\x1a\nlocal-norium-upload"
        local_name = "source.png"
        (chat_router.user_upload_dir("user-a") / local_name).write_bytes(media_bytes)
        conversation = new_conversation(source_id, contato="Ana", channel="whatsapp")
        conversation["mensagens"] = [
            {
                "id": "SOURCE-MEDIA-1",
                "remetente": "usuario",
                "texto": "legenda local",
                "tipo": "midia",
                "arquivoUrl": f"/api/chat/uploads/{local_name}",
                "arquivoMime": "image/png",
                "nomeArquivo": local_name,
                "timestamp": int(time.time()),
            }
        ]
        await save_conversations({source_id: conversation}, "user-a")
        send_media = AsyncMock(return_value={"messageId": "FORWARDED-MEDIA-1"})
        download_remote = AsyncMock()
        with (
            patch.object(chat_router.wapi_messaging._client, "send_media", send_media),
            patch.object(chat_router, "obter_midia_whatsapp", download_remote),
        ):
            result = await chat_router.encaminhar_mensagens(
                chat_router.EncaminharMensagensPayload(
                    destino_id=destination_id,
                    mensagens_ids=["SOURCE-MEDIA-1"],
                ),
                chat_user("user-a"),
            )

        self.assertEqual("encaminhado", result["status"])
        download_remote.assert_not_awaited()
        sent_data = send_media.await_args.args[4]
        self.assertEqual(media_bytes, base64.b64decode(sent_data.split(",", 1)[1]))
        stored = (await load_conversations("user-a"))[destination_id]["mensagens"][-1]
        self.assertEqual("FORWARDED-MEDIA-1", stored["id"])
        self.assertEqual("image/png", stored["arquivoMime"])
        self.assertTrue(stored["encaminhada"])

    async def test_delete_for_me_is_local_and_works_without_whatsapp_binding(self) -> None:
        conversation_id = "5511777776666@s.whatsapp.net"
        conversation = new_conversation(conversation_id, contato="Offline", channel="whatsapp")
        conversation["mensagens"] = [
            {"id": "LOCAL-ONLY", "remetente": "usuario", "texto": "apagar", "timestamp": int(time.time())}
        ]
        await save_conversations({conversation_id: conversation}, "offline-user")
        remote_delete = AsyncMock()
        with patch.object(chat_router.wapi_messaging._client, "delete_message", remote_delete):
            result = await chat_router.apagar_mensagem(
                chat_router.ApagarMensagemPayload(
                    conversa_id=conversation_id,
                    mensagem_id="LOCAL-ONLY",
                    para_todos=False,
                ),
                chat_user("offline-user"),
            )

        self.assertEqual("sucesso", result["status"])
        remote_delete.assert_not_awaited()
        stored = (await load_conversations("offline-user"))[conversation_id]
        self.assertEqual([], stored["mensagens"])

    async def test_audio_status_reply_passes_quoted_message_id_and_persists_preview(self) -> None:
        bind("user-a", "INST-A", "tok-a")
        status_id = "STATUS-VOICE-1"
        await chat_router.save_whatsapp_status_feed(
            "user-a",
            {
                "items": [
                    {
                        "id": status_id,
                        "contactId": "5511999998888",
                        "contactName": "Maria",
                        "texto": "status da Maria",
                        "timestamp": int(time.time()),
                    }
                ]
            },
        )
        send_media = AsyncMock(return_value={"messageId": "VOICE-1"})
        payload = chat_router.EnviarArquivoPayload(
            conversa_id="5511999998888@s.whatsapp.net",
            nome_arquivo="resposta.ogg",
            mime_type="audio/ogg",
            data_url="data:audio/ogg;base64," + base64.b64encode(b"OggS-audio").decode(),
            responder_a=status_id,
        )
        with (
            patch.object(chat_router.wapi_messaging._client, "send_media", send_media),
            patch.object(chat_router, "transcode_audio_to_ogg", return_value=None),
        ):
            await chat_router.enviar_arquivo(payload, chat_user("user-a"))
        self.assertEqual(status_id, send_media.await_args.kwargs["quoted_message_id"])
        stored = (await load_conversations("user-a"))[payload.conversa_id]["mensagens"][-1]
        self.assertEqual(status_id, stored["citada"]["id"])
        self.assertTrue(stored["citada"]["status"])

    async def test_group_details_resolve_member_name_and_admin(self) -> None:
        bind("user-a", "INST-A", "tok-a")
        group_id = "120363000000000000@g.us"
        await chat_router.save_whatsapp_catalog_cache(
            "user-a",
            {
                "contacts": [
                    {"id": "5511999998888@s.whatsapp.net", "savedName": "Maria da agenda"}
                ],
                "chats": [],
            },
        )
        metadata = AsyncMock(
            return_value={
                "group": {
                    "id": group_id,
                    "subject": "Equipe",
                    "size": 1,
                    "profilePictureUrl": "https://cdn.example/group.jpg",
                    "participants": [
                        {"id": "5511999998888@s.whatsapp.net", "admin": "admin"}
                    ],
                }
            }
        )
        with patch.object(chat_router.wapi_client, "group_metadata", metadata):
            details = await chat_router.obter_detalhes_conversa(group_id, chat_user("user-a"))
        member = details["metadados"]["participantes"][0]
        self.assertEqual("Maria da agenda", member["name"])
        self.assertEqual("admin", member["admin"])
        self.assertTrue(member["isAdmin"])
        self.assertEqual(1, details["metadados"]["participantesCount"])

    async def test_new_group_is_sorted_before_older_conversations(self) -> None:
        bind("user-a", "INST-A", "tok-a")
        old_id = "5511888887777@s.whatsapp.net"
        old = new_conversation(old_id, contato="Ana", channel="whatsapp")
        old["timestampUltimaMsg"] = int(time.time()) - 60
        old["horario"] = "12:00"
        await save_conversations({old_id: old}, "user-a")
        create = AsyncMock(return_value={"group": {"id": "120363999999999999@g.us"}})
        with patch.object(chat_router.wapi_messaging._client, "create_group", create):
            created = await chat_router.criar_grupo(
                chat_router.CriarGrupoPayload(
                    nome="Grupo novo",
                    participantes=["5511999998888"],
                ),
                chat_user("user-a"),
            )
        stored = await load_conversations("user-a")
        self.assertEqual(created["group"]["id"], chat_router.sorted_conversations(stored)[0]["id"])
        self.assertTrue(created["group"]["metadados"]["recentlyCreatedAt"])


if __name__ == "__main__":
    unittest.main()
