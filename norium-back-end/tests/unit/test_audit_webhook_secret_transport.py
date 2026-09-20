import os
import unittest
from unittest.mock import AsyncMock, patch

from app.modules.chat import router as chat_router


class Request:
    def __init__(self, *, query="", header=""):
        self.query_params = {"secret": query} if query else {}
        self.headers = {"x-wapi-webhook-secret": header} if header else {}


class Result:
    def as_dict(self):
        return {"status": "success"}


class WebhookSecretTransportTests(unittest.IsolatedAsyncioTestCase):
    async def test_query_secret_is_rejected_by_default_and_header_is_accepted(self):
        integration = AsyncMock()
        integration.handle_webhook.return_value = Result()
        payload = {"instanceId": "synthetic", "event": "received"}
        with patch.dict(os.environ, {"WAPI_WEBHOOK_QUERY_SECRET_COMPAT": "0"}), patch.object(
            chat_router, "whatsapp_integration", integration
        ):
            await chat_router.webhook_whatsapp(payload, request=Request(query="secret-value"))
            self.assertEqual("", integration.handle_webhook.await_args.args[0]["x-wapi-webhook-secret"])
            await chat_router.webhook_whatsapp(payload, request=Request(header="secret-value"))
            self.assertEqual("secret-value", integration.handle_webhook.await_args.args[0]["x-wapi-webhook-secret"])


if __name__ == "__main__":
    unittest.main()
