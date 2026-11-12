"""Verify source archive stays exact when public DEV config lives outside a worktree."""
import os
from pathlib import Path
import runpy
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
CONFIG = "/home/codex/projects/masterweld.ru/ops/.secrets/dev/build-public.env"
PUBLIC = "\n".join(("VITE_APP_ENV=dev", "VITE_SUPABASE_PROJECT_ID=mw-dev",
                     "VITE_SUPABASE_URL=https://dev.example.test",
                     "VITE_SUPABASE_PUBLISHABLE_KEY=public-test-key"))
SHA = "a" * 40


class BuildConfigTests(unittest.TestCase):
    def test_canonical_config_never_changes_worktree_archive(self):
        with patch.dict(os.environ, {"MW_DEV_PUBLIC_CONFIG": CONFIG}), \
                patch.object(Path, "read_text", autospec=True, return_value=PUBLIC) as read, \
                patch("subprocess.check_output", side_effect=[SHA + "\n", ""]) as git, \
                patch("subprocess.run") as run, patch("builtins.print"):
            runpy.run_path(str(ROOT / "ops/dev/build.py"), run_name="__main__")
        read.assert_called_once_with(Path(CONFIG))
        self.assertTrue(all(call.kwargs["cwd"] == ROOT for call in git.call_args_list))
        self.assertEqual(run.call_args_list[0].args[0], ["git", "archive", "--format=tar", SHA])
        self.assertEqual(run.call_args_list[0].kwargs["cwd"], ROOT)
        self.assertEqual(run.call_args_list[1].kwargs["cwd"], ROOT)
        self.assertIn("masterweld-dev:" + SHA, run.call_args_list[1].args[0])

    def test_external_config_does_not_permit_dirty_source_or_production_values(self):
        for status, config in ((" M source.py", PUBLIC),
                               ("", PUBLIC.replace("VITE_APP_ENV=dev", "VITE_APP_ENV=production"))):
            with patch.dict(os.environ, {"MW_DEV_PUBLIC_CONFIG": CONFIG}), \
                    patch.object(Path, "read_text", return_value=config), \
                    patch("subprocess.check_output", side_effect=[SHA, status]), \
                    patch("subprocess.run") as run, patch("builtins.print"):
                with self.assertRaises(SystemExit):
                    runpy.run_path(str(ROOT / "ops/dev/build.py"), run_name="__main__")
                run.assert_not_called()


if __name__ == "__main__":
    unittest.main()
