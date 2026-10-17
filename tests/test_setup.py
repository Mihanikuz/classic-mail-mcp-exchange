import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("setup", Path(__file__).parents[1] / "scripts/setup.py")
setup = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(setup)

class SetupTests(unittest.TestCase):
    def test_wizard_hides_secrets_uses_private_permissions_and_refuses_overwrite(self):
        previous = Path.cwd()
        with tempfile.TemporaryDirectory() as tmp:
            try:
                os.chdir(tmp)
                answers = ["1", "personal", "owner@example.com", "", "imap.example.com", "993", "smtp.example.com", "587", "no", "no"]
                output = io.StringIO()
                with patch("sys.argv", ["setup.py"]), patch("builtins.input", side_effect=answers), patch("getpass.getpass", return_value="hidden-test-value"), contextlib.redirect_stdout(output):
                    setup.main()
                path = Path(".secrets/config.json")
                config = json.loads(path.read_text())
                self.assertEqual(config["accounts"][0]["password"], "hidden-test-value")
                self.assertNotIn("hidden-test-value", output.getvalue())
                self.assertNotIn(config["bearerToken"], output.getvalue())
                self.assertNotEqual(config["bearerToken"], config["encryptionKey"])
                self.assertGreaterEqual(len(config["bearerToken"]), 43)
                self.assertEqual(path.stat().st_mode & 0o777, 0o600)
                self.assertFalse(config["accounts"][0]["appendSent"])
                with patch("sys.argv", ["setup.py"]), self.assertRaises(ValueError):
                    setup.main()
                self.assertEqual(json.loads(path.read_text()), config)
            finally:
                os.chdir(previous)

if __name__ == "__main__":
    unittest.main()
