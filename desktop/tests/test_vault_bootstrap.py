"""Desktop encryption setup needs no user shell configuration."""
import importlib.util
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("desktop_host_vault", Path(__file__).resolve().parents[1] / "runtime_host.py")
host = importlib.util.module_from_spec(spec)
spec.loader.exec_module(host)


class VaultBootstrapTests(unittest.TestCase):
    def test_key_persists_and_credentials_are_encrypted(self):
        from nerya.security.secrets import SecretVault
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {}, clear=True):
            data = Path(directory)
            key = host.ensure_vault_passphrase(data)
            self.assertGreaterEqual(len(key), 32)
            self.assertEqual(host.ensure_vault_passphrase(data), key)
            if os.name != "nt":
                self.assertEqual((data / "vault.key").stat().st_mode & 0o777, 0o600)
            vault = data / "secrets.enc"
            SecretVault.open(vault, key).put(name="test", value="not-a-real-api-key", kind="llm", scope=["llm"])
            self.assertNotIn(b"not-a-real-api-key", vault.read_bytes())
            self.assertEqual(SecretVault.open(vault, host.ensure_vault_passphrase(data)).resolve("test"), "not-a-real-api-key")

    def test_native_key_does_not_create_plaintext_key_file(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {"NERYA_VAULT_PASSPHRASE": "x" * 64}, clear=True):
            self.assertEqual(host.ensure_vault_passphrase(Path(directory)), "x" * 64)
            self.assertFalse((Path(directory) / "vault.key").exists())

    def test_missing_key_never_overwrites_existing_vault(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {}, clear=True):
            data = Path(directory)
            vault = data / "workspace/vault/secrets.enc"
            vault.parent.mkdir(parents=True)
            vault.write_bytes(b"existing encrypted content")
            with self.assertRaisesRegex(RuntimeError, "existing_vault_key_required"):
                host.ensure_vault_passphrase(data)
            self.assertEqual(vault.read_bytes(), b"existing encrypted content")
            self.assertFalse((data / "vault.key").exists())

    @unittest.skipIf(os.name == "nt", "POSIX permissions")
    def test_unsafe_key_file_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {}, clear=True):
            data = Path(directory)
            key = data / "vault.key"
            key.write_text("x" * 64)
            key.chmod(0o644)
            with self.assertRaisesRegex(RuntimeError, "unsafe_vault_key_permissions"):
                host.ensure_vault_passphrase(data)


if __name__ == "__main__":
    unittest.main()
