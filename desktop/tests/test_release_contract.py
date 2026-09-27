"""Read-only release checks; no model/network credentials are needed."""
import importlib.util
from pathlib import Path
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


version = load("release_version", ROOT / "scripts/release_version.py")
runtime = load("verify_runtime", ROOT / "desktop/scripts/verify_runtime.py")


class ReleaseContractTests(unittest.TestCase):
    def test_release_manifests_and_locks_agree(self):
        for path, expected in version.expected_files().items():
            with self.subTest(path=path.name):
                self.assertEqual(path.read_text(encoding="utf-8"), expected)

    def test_packaged_paths_cannot_escape_installation(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "present").write_text("test", encoding="utf-8")
            self.assertEqual(runtime.resource_path(root, "present"), root / "present")
            for invalid in ("../present", "missing", str(root / "present"), "", None):
                with self.subTest(path=invalid), self.assertRaises(ValueError):
                    runtime.resource_path(root, invalid)

    def test_desktop_target_is_native_and_supported(self):
        system, arch = runtime.native_target()
        self.assertIn(system, {"darwin", "win32", "linux"})
        self.assertIn(arch, {"arm64", "x64"})


if __name__ == "__main__":
    unittest.main()
