"""Mantem o catalogo de ajuda da Nora em sincronia com as abas do frontend.

Sem esta verificacao, uma aba nova entra no sistema sem documentacao e a Nora
passa a inventar como aquela tela funciona - foi o que aconteceu com Propostas.
"""

from __future__ import annotations

import re
import unicodedata
import unittest
from pathlib import Path

from app.services.nora_module_help import MODULE_HELP, answer_module_help

TABS_FILE = (
    Path(__file__).resolve().parents[2].parent
    / "norium-front-end"
    / "src"
    / "app"
    / "navigation"
    / "tabs.ts"
)

# Abas que sao apenas outro nome para um modulo ja documentado. O mapa e
# explicito de proposito: um alias novo no frontend quebra o teste e obriga a
# decidir se e sinonimo ou modulo novo, em vez de passar despercebido.
TAB_ALIASES = {
    "resumo": "dashboard",
    "inbox": "central",
    "gastos": "financeiro",
    "e-mail": "emails",
}


def normalize(value: str) -> str:
    """Remove acento, caixa e hifen para comparar 'Automações' com 'automacoes'."""
    decomposed = unicodedata.normalize("NFKD", value.strip().lower())
    without_accents = "".join(char for char in decomposed if not unicodedata.combining(char))
    return without_accents.replace("-", "")


def frontend_tabs() -> set[str]:
    """Le as chaves de TAB_PERMISSIONS direto do tabs.ts."""
    source = TABS_FILE.read_text(encoding="utf-8")
    block = re.search(r"TAB_PERMISSIONS[^=]*=\s*\{(.*?)\n\};", source, re.S)
    if not block:
        raise AssertionError(f"Nao consegui ler TAB_PERMISSIONS em {TABS_FILE}")

    tabs: set[str] = set()
    for line in block.group(1).splitlines():
        key = re.match(r'\s*"?([^":]+?)"?\s*:', line)
        if key:
            tabs.add(normalize(key.group(1)))
    return tabs


def documented_modules() -> set[str]:
    return {normalize(guide.module) for guide in MODULE_HELP}


class NoraModuleHelpSyncTest(unittest.TestCase):
    def setUp(self) -> None:
        if not TABS_FILE.exists():
            self.skipTest(f"Frontend nao encontrado em {TABS_FILE}")
        # As chaves do mapa passam pela mesma normalizacao das abas, senao
        # "E-mail" (que vira "email") nunca casaria com a chave "e-mail".
        aliases = {normalize(key): value for key, value in TAB_ALIASES.items()}
        self.tabs = {aliases.get(tab, tab) for tab in frontend_tabs()}
        self.documented = documented_modules()

    def test_o_arquivo_de_abas_foi_lido(self) -> None:
        """Protege o proprio teste: se o regex parar de casar, ele nao pode passar vazio."""
        self.assertGreater(len(self.tabs), 10, "Poucas abas lidas - o formato do tabs.ts mudou?")

    def test_toda_aba_tem_ajuda_no_catalogo(self) -> None:
        faltando = sorted(self.tabs - self.documented)
        self.assertEqual(
            faltando,
            [],
            "Abas sem documentacao em MODULE_HELP: "
            f"{', '.join(faltando)}. Sem isso a Nora inventa como a tela funciona. "
            "Adicione a entrada em app/services/nora_module_help.py.",
        )

    def test_catalogo_nao_documenta_aba_inexistente(self) -> None:
        orfaos = sorted(self.documented - self.tabs)
        self.assertEqual(
            orfaos,
            [],
            f"MODULE_HELP documenta modulos que nao sao mais abas: {', '.join(orfaos)}. "
            "Remova a entrada ou registre o alias em TAB_ALIASES.",
        )

    def test_toda_entrada_responde_a_pergunta_de_orientacao(self) -> None:
        """Nao basta existir: a entrada precisa ser alcancada pelos proprios aliases."""
        for guide in MODULE_HELP:
            with self.subTest(module=guide.module):
                answer = answer_module_help(f"explique a tela {guide.aliases[0]}")
                self.assertIsNotNone(answer, f"'{guide.aliases[0]}' nao alcanca nenhuma entrada")
                assert answer is not None
                self.assertEqual(answer["module"], guide.module)
                self.assertGreater(
                    len(answer["response"]),
                    80,
                    f"Resposta de '{guide.module}' curta demais para orientar alguem",
                )


if __name__ == "__main__":
    unittest.main()
