"""The browser fixture exercises real file guards under its temporary root."""

import os
from pathlib import Path
import subprocess
import sys
import unittest


class BrowserFixtureStorageTests(unittest.TestCase):
    def test_fixture_aligns_upload_root_and_keeps_traversal_guard(self):
        # Fixture patches are intentionally process-lifetime. Import it in a
        # separate process so they cannot leak into unrelated unit tests.
        environment = os.environ.copy()
        environment.update({
            "ENVIRONMENT": "test", "APP_ENV": "test",
            "PYTHON_DOTENV_DISABLED": "1", "NORIUM_DATABASE_URL": "",
            "NORA_BRAIN_DATABASE_URL": "", "DATABASE_URL": "",
        })
        source = """
from pathlib import Path
import tempfile
from tests import team_call_browser_app as fixture
from app.core.tenant import get_data_root
from app.infrastructure.persistence.files import read as read_binary_file, write as write_binary_file
from app.infrastructure.persistence.postgres_store import PostgresStoreError

root = fixture._data_root
assert get_data_root().resolve() == root.resolve()
assert fixture.team.UPLOAD_DIR.resolve() == root.resolve()
target = root / 'synthetic.part'
write_binary_file(target, bytes([1, 2, 3]))
assert read_binary_file(target) == bytes([1, 2, 3])
with tempfile.TemporaryDirectory(prefix='norium-outside-fixture-') as outside:
    forbidden = Path(outside) / 'synthetic.part'
    try:
        write_binary_file(forbidden, b'x')
    except PostgresStoreError as error:
        assert str(error) == 'store_path_outside_data_root'
    else:
        raise AssertionError('Outside-root write accepted')
    assert not forbidden.exists()
fixture._clear_fixture_files()
assert not target.exists()
print('browser_fixture_storage_passed')
"""
        result = subprocess.run(
            [sys.executable, "-c", source],
            cwd=Path(__file__).resolve().parents[2],
            env=environment, capture_output=True, text=True, timeout=30,
        )
        self.assertEqual(0, result.returncode, result.stderr)
        self.assertIn("browser_fixture_storage_passed", result.stdout)


if __name__ == "__main__":
    unittest.main()
