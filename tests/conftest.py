"""Shared pytest configuration.

Use a deterministic Vault passphrase for the general test suite so tests do
not leave per-workspace keyring files unless they explicitly exercise local
Vault bootstrapping. Bootstrap tests delete this variable with monkeypatch.
"""

import os

os.environ.setdefault("NERYA_VAULT_PASSPHRASE", "test-vault-passphrase")
