"""Untrusted DOCX XML must not expand entities while extracting text."""

import hashlib
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch

from defusedxml.common import EntitiesForbidden

from app.modules.nora.brain import documents


class NoraDocumentXmlSecurityTests(unittest.IsolatedAsyncioTestCase):
    async def test_docx_entity_is_rejected(self) -> None:
        malicious_xml = (
            b'<!DOCTYPE document [<!ENTITY hidden "expanded text">]>'
            b'<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
            b'<w:p>&hidden;</w:p></w:document>'
        )
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "untrusted.docx"
            with zipfile.ZipFile(path, "w") as archive:
                archive.writestr("word/document.xml", malicious_xml)
            prepared = {
                "id": "synthetic-document",
                "start": 0,
                "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
            }
            with patch.object(documents, "checked_file", return_value=({}, path)):
                with self.assertRaises(EntitiesForbidden):
                    await documents.read_file({"id": "synthetic-user"}, prepared, None)


if __name__ == "__main__":
    unittest.main()
