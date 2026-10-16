#!/usr/bin/env python3
"""ctl.py runs as root over a directory the app can write to (/app). A symlink or
FIFO left there by the app must never make ctl.py write or read outside
the app dir. Runs as a normal user: the outside file stands in for a host file."""
import base64
import importlib.util
import json
import os
import pathlib
import sqlite3
import subprocess
import tempfile
import unittest

HERE = pathlib.Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("ctl", HERE / "ctl.py")
ctl = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ctl)

class _Falhou:
    returncode = 1; stdout = ""; stderr = "docker indisponivel no teste"

class AppDirSymlinkTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        base = pathlib.Path(self.tmp.name)
        self.host = base / "host"; self.host.mkdir()
        self.segredo = self.host / "internal.key"
        self.segredo.write_text("SEGREDO-DO-HOST")
        ctl.APPS_ROOT = str(base / "apps")
        ctl.GIT_ROOT = str(base / "git")
        ctl.REG_PATH = str(base / "registry.json")
        self.app = pathlib.Path(ctl.appdir("ana", "loja"))
        self.app.mkdir(parents=True)
        self._orig = (ctl.docker, ctl._uid_for, ctl.ensure_quota)
        ctl.docker = lambda *a, **k: _Falhou()
        ctl._uid_for = lambda label: os.getuid()
        ctl.ensure_quota = lambda *a, **k: None

    def tearDown(self):
        ctl.docker, ctl._uid_for, ctl.ensure_quota = self._orig
        self.tmp.cleanup()

    def publish(self, files):
        return ctl.v_publish({"label": "ana", "system": "loja", "runtime": "node",
                              "files": {k: base64.b64encode(v).decode() for k, v in files.items()}})

    def test_publish_replaces_symlinked_file_instead_of_writing_through_it(self):
        (self.app / "server.js").symlink_to(self.segredo)
        self.publish({"server.js": b"novo"})
        self.assertEqual(self.segredo.read_text(), "SEGREDO-DO-HOST")
        self.assertFalse((self.app / "server.js").is_symlink())
        self.assertEqual((self.app / "server.js").read_bytes(), b"novo")

    def test_publish_refuses_symlinked_directory(self):
        (self.app / "lib").symlink_to(self.host, target_is_directory=True)
        r = self.publish({"lib/cron.js": b"x"})
        self.assertFalse(r["ok"])
        self.assertFalse((self.host / "cron.js").exists())

    def test_publish_does_not_hang_on_fifo(self):
        os.mkfifo(self.app / "server.js")
        self.publish({"server.js": b"novo"})
        self.assertEqual((self.app / "server.js").read_bytes(), b"novo")

    def test_publish_still_rejects_escaping_paths(self):
        r = self.publish({"../fora.js": b"x"})
        self.assertFalse(r["ok"])
        self.assertIn("caminho suspeito", r["error"])

    def test_inventory_does_not_walk_a_symlinked_data_dir(self):
        (self.host / "pedidos.json").write_text(json.dumps([1, 2, 3]))
        (self.app / "data").symlink_to(self.host, target_is_directory=True)
        r = ctl.v_inventory({"label": "ana", "system": "loja"})
        self.assertFalse(r["dados"]["existe"])
        self.assertEqual(r["dados"]["colecoes"], {})

    def test_inventory_counts_sqlite_rows_still_in_the_wal_without_touching_the_db(self):
        (self.app / "data").mkdir()
        db = self.app / "data" / "app.db"
        con = sqlite3.connect(db)
        con.execute("PRAGMA journal_mode=WAL")
        con.execute("PRAGMA wal_autocheckpoint=0")
        con.execute("CREATE TABLE pedidos(x)")
        con.executemany("INSERT INTO pedidos VALUES (?)", [(i,) for i in range(5)])
        con.commit()
        antes = {p.name: p.read_bytes() for p in (self.app / "data").iterdir()}
        r = ctl.v_inventory({"label": "ana", "system": "loja"})
        depois = {p.name: p.read_bytes() for p in (self.app / "data").iterdir()}
        con.close()
        self.assertEqual(r["dados"]["tabelas"], {"app.db": {"pedidos": 5}})
        self.assertEqual(depois, antes)

    # ---- versioning: git runs as root, so it must never work on the app dir ----

    def commit(self, files, msg):
        for rel, data in files.items():
            p = self.app / rel
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_bytes(data)
        return ctl._git_commit("ana", "loja", "ana", msg, set(files))

    def git(self, *args):
        return subprocess.run(["git", "--git-dir", ctl._gitdir("ana", "loja")] + list(args),
                              capture_output=True, text=True).stdout

    def rollback(self, ref):
        return ctl.v_git_rollback({"label": "ana", "system": "loja", "ref": ref})

    def test_git_never_gets_the_app_dir_as_work_tree(self):
        vistos = []
        orig = subprocess.run
        def espia(cmd, *a, **k):
            if cmd and cmd[0] == "git":
                vistos.append(cmd[cmd.index("--work-tree") + 1] if "--work-tree" in cmd
                              else k.get("cwd") or os.getcwd())
            return orig(cmd, *a, **k)
        ctl.subprocess.run = espia
        try:
            self.commit({"a.js": b"v1"}, "v1")
            v1 = self.git("rev-parse", "HEAD").strip()
            self.commit({"a.js": b"v2"}, "v2")
            self.rollback(v1)
            ctl.v_git_log({"label": "ana", "system": "loja"})
            ctl.v_git_diff({"label": "ana", "system": "loja", "ref": "HEAD"})
            ctl.v_inventory({"label": "ana", "system": "loja"})
        finally:
            ctl.subprocess.run = orig
        self.assertTrue(vistos)
        for wt in vistos:
            self.assertNotEqual(os.path.realpath(wt), os.path.realpath(self.app))

    def test_rollback_restores_tracked_files_and_keeps_runtime_files(self):
        self.commit({"a.js": b"v1", "lib/b.js": b"b1"}, "v1")
        v1 = self.git("rev-parse", "HEAD").strip()
        self.commit({"a.js": b"v2", "lib/b.js": b"b2", "c.js": b"novo"}, "v2")
        (self.app / "data").mkdir()
        (self.app / "data" / "db.json").write_text("[1]")
        r = self.rollback(v1)
        self.assertTrue(r["ok"], r)
        self.assertEqual({k: base64.b64decode(v) for k, v in r["files"].items()},
                         {"a.js": b"v1", "lib/b.js": b"b1"})
        self.assertEqual((self.app / "a.js").read_bytes(), b"v1")
        self.assertEqual((self.app / "lib" / "b.js").read_bytes(), b"b1")
        self.assertFalse((self.app / "c.js").exists())
        self.assertEqual((self.app / "data" / "db.json").read_text(), "[1]")
        self.assertEqual(self.git("rev-parse", "HEAD^{tree}"), self.git("rev-parse", v1 + "^{tree}"))
        self.assertEqual(self.git("log", "--format=%s").split("\n")[1], "v2")

    def test_rollback_does_not_write_through_a_symlinked_directory(self):
        self.commit({"a.js": b"v1", "lib/cron.js": b"x"}, "v1")
        v1 = self.git("rev-parse", "HEAD").strip()
        self.commit({"a.js": b"v2"}, "v2")
        (self.app / "lib" / "cron.js").unlink()
        (self.app / "lib").rmdir()
        (self.app / "lib").symlink_to(self.host, target_is_directory=True)
        self.rollback(v1)
        self.assertFalse((self.host / "cron.js").exists())

    def test_commit_does_not_version_a_file_behind_a_symlink(self):
        self.commit({"a.js": b"v1"}, "v1")
        (self.app / "pasta").symlink_to(self.host, target_is_directory=True)
        (self.app / "leak.txt").symlink_to(self.segredo)
        self.commit({"a.js": b"v2"}, "v2")
        tudo = "".join(self.git("show", "HEAD:" + p) for p in self.git("ls-tree", "-r", "--name-only", "HEAD").split())
        self.assertNotIn("SEGREDO-DO-HOST", tudo)

    def test_sparse_file_is_never_read_or_copied(self):
        # 1 GiB on paper, ~0 of quota: reading it would put the whole size on the host
        with open(self.app / "grande.bin", "wb") as f:
            f.truncate(1 << 30)
        dest = os.path.join(self.tmp.name, "copia.bin")
        self.assertFalse(ctl._copy_app_file(str(self.app), "grande.bin", dest))
        self.assertFalse(os.path.exists(dest))
        self.assertIsNone(ctl._read_app_file(str(self.app), "grande.bin"))

    def test_commit_gives_up_instead_of_filling_the_host_disk(self):
        self.addCleanup(setattr, ctl, "KEEP_FREE", ctl.KEEP_FREE)
        ctl.KEEP_FREE = 1 << 62
        r = self.commit({"a.js": b"v1"}, "v1")
        self.assertFalse(r["versioned"])
        self.assertEqual(os.listdir(os.path.join(ctl.GIT_ROOT, ".tmp")), [])

if __name__ == "__main__":
    unittest.main()
