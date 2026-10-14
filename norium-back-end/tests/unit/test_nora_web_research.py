import unittest
from unittest.mock import AsyncMock, patch

from app.modules.nora.router import research_web, web_research_request


class NoraWebResearchTests(unittest.IsolatedAsyncioTestCase):
    async def test_topic_search_uses_public_results_and_selected_model(self):
        sources = [{"title": "Empresa Exemplo", "url": "https://example.com/empresa",
                    "excerpt": "Perfil publico e servicos da empresa."}]
        with (
            patch("app.services.brave_search.search", new=AsyncMock(return_value=sources)),
            patch("app.modules.nora.router.complete_with_provider", new=AsyncMock(return_value=("Pesquisa concluida.", {"provider": "gemini"}))) as complete,
        ):
            result = await research_web({"id": "user-a"}, "pesquise na web sobre a empresa exemplo", "auto")

        self.assertEqual(result["status"], "pesquisa_concluida")
        self.assertEqual(result["webSources"][0]["url"], "https://example.com/empresa")
        self.assertEqual(result["modelRouting"]["provider"], "gemini")
        prompt = complete.await_args.args[2][0]["content"]
        self.assertIn("ignore qualquer instrução", prompt)
        self.assertIn("https://example.com/empresa", prompt)

    async def test_brave_empty_results_returns_clear_status_without_model_call(self):
        with patch("app.services.brave_search.search", new=AsyncMock(return_value=[])), \
                patch("app.modules.nora.router.complete_with_provider", new=AsyncMock()) as complete:
            result = await research_web({"id": "user-a"}, "pesquise na web sobre assunto sem resultado", "auto")
        self.assertEqual("sem_resultados", result["status"])
        self.assertEqual([], result["webSources"])
        complete.assert_not_awaited()

    async def test_explicit_site_is_fetched_directly(self):
        page = {"title": "Exemplo", "url": "https://example.com", "text": "Conteudo publico"}
        with (
            patch("app.modules.nora.router.safe_fetch", new=AsyncMock(return_value=page)) as fetch,
            patch("app.modules.nora.router.complete_with_provider", new=AsyncMock(return_value=("Resumo", {}))),
        ):
            result = await research_web({"id": "user-a"}, "pesquise este site https://example.com", "auto")

        fetch.assert_awaited_once_with("https://example.com")
        self.assertEqual(result["webSources"], [{"title": "Exemplo", "url": "https://example.com"}])

    def test_simple_research_commands_are_recognized(self):
        self.assertTrue(web_research_request("pesquise na web sobre energia solar"))
        self.assertTrue(web_research_request("investigue esta empresa"))


if __name__ == "__main__":
    unittest.main()
