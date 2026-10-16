#!/usr/bin/env python3
"""Each app has its own container. With the old names, ("joao", "minha-loja")
and ("joao-minha", "loja") were the same container, so one tenant publishing
removed another tenant's app. Docker is replaced by an in-memory fake."""
import base64
import importlib.util
import io
import json
import os
import pathlib
import sys
import tempfile
import unittest

HERE = pathlib.Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("ctl", HERE / "ctl.py")
ctl = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ctl)


class _R:
    def __init__(self, rc=0, out=""):
        self.returncode, self.stdout, self.stderr = rc, out, ""


class FakeDocker:
    """Only what ctl.py asks of docker here: run, rm, rename and the /app mount."""
    def __init__(self):
        self.containers = {}   # name -> host dir mounted at /app
        self.removed = []

    def __call__(self, *args, **kw):
        a = list(args)
        if a[0] == "run":
            name = a[a.index("--name") + 1]
            if name in self.containers:
                return _R(1)
            self.containers[name] = a[a.index("-v") + 1].rsplit(":/app", 1)[0]
            return _R()
        if a[:2] == ["rm", "-f"]:
            self.removed.append(a[2])
            self.containers.pop(a[2], None)
            return _R()
        if a[0] == "rename":
            if a[1] not in self.containers or a[2] in self.containers:
                return _R(1)
            self.containers[a[2]] = self.containers.pop(a[1])
            return _R()
        if a[0] == "inspect" and "--type" in a and "{{.Source}}" in a[-2]:
            return _R(0, self.containers[a[-1]]) if a[-1] in self.containers else _R(1)
        return _R(1)


class ContainerNameTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        base = pathlib.Path(self.tmp.name)
        ctl.APPS_ROOT = str(base / "apps")
        ctl.GIT_ROOT = str(base / "git")
        ctl.REG_PATH = str(base / "registry.json")
        self.docker = FakeDocker()
        names = ("docker", "_uid_for", "ensure_quota", "_healthcheck", "_smoketest", "_git_commit")
        self._orig = {n: getattr(ctl, n) for n in names}
        ctl.docker = self.docker
        ctl._uid_for = lambda label: os.getuid()
        ctl.ensure_quota = lambda *a, **k: None
        ctl._healthcheck = lambda *a, **k: {"state": "ok", "exit_code": None}
        ctl._smoketest = lambda *a, **k: {}
        ctl._git_commit = lambda *a, **k: {"versioned": False}

    def tearDown(self):
        for n, f in self._orig.items():
            setattr(ctl, n, f)
        self.tmp.cleanup()

    def publish(self, label, system):
        return ctl.v_publish({"label": label, "system": system, "runtime": "node",
                              "files": {"server.js": base64.b64encode(b"x").decode()}})

    def legacy_app(self, label, system):
        """An app published by the old ctl.py: old container name in docker and in the registry."""
        d = ctl.appdir(label, system)
        os.makedirs(d)
        self.docker.containers["brambs-%s-%s" % (label, system)] = d
        reg = ctl.load_json(ctl.REG_PATH)
        reg["%s/%s" % (label, system)] = {"container": "brambs-%s-%s" % (label, system), "port": 8080}
        ctl.save_json(ctl.REG_PATH, reg)

    def registry(self):
        return {k: v["container"] for k, v in ctl.load_json(ctl.REG_PATH).items()}

    def test_publishing_never_removes_another_apps_container(self):
        self.assertTrue(self.publish("joao", "minha-loja")["ok"])
        self.assertTrue(self.publish("joao-minha", "loja")["ok"])
        self.assertEqual(sorted(self.docker.containers.values()),
                         sorted([ctl.appdir("joao", "minha-loja"), ctl.appdir("joao-minha", "loja")]))
        reg = self.registry()
        self.assertNotEqual(reg["joao/minha-loja"], reg["joao-minha/loja"])

    def test_migration_moves_only_the_container_that_mounts_the_app(self):
        # the old name is shared; the container under it is joao-minha/loja's
        self.legacy_app("joao-minha", "loja")
        os.makedirs(ctl.appdir("joao", "minha-loja"))
        reg = ctl.load_json(ctl.REG_PATH)
        reg["joao/minha-loja"] = {"container": "brambs-joao-minha-loja", "port": 8080}
        ctl.save_json(ctl.REG_PATH, reg)

        r = ctl.v_migrate_names({})
        self.assertTrue(r["ok"], r)
        self.assertEqual(self.docker.removed, [])
        self.assertEqual(self.docker.containers,
                         {ctl.cname("joao-minha", "loja"): ctl.appdir("joao-minha", "loja")})
        # joao/minha-loja no longer points at someone else's container
        self.assertEqual(self.registry(), {"joao-minha/loja": ctl.cname("joao-minha", "loja"),
                                           "joao/minha-loja": ctl.cname("joao", "minha-loja")})

    def test_migration_can_be_undone_for_a_ctl_rollback(self):
        self.legacy_app("ana", "loja")
        before = (dict(self.docker.containers), self.registry())
        ctl.v_migrate_names({})
        self.assertNotEqual(self.registry(), before[1])
        ctl.v_migrate_names({"desfazer": True})
        self.assertEqual((self.docker.containers, self.registry()), before)

    def test_app_left_on_the_old_name_moves_on_its_first_call(self):
        self.legacy_app("ana", "loja")
        stdin, stdout = sys.stdin, sys.stdout
        sys.stdin, sys.stdout = io.StringIO(json.dumps({"verb": "stop", "label": "ana", "system": "loja"})), io.StringIO()
        try:
            ctl.main()
        finally:
            sys.stdin, sys.stdout = stdin, stdout
        self.assertEqual(self.docker.containers, {ctl.cname("ana", "loja"): ctl.appdir("ana", "loja")})
        self.assertEqual(self.registry(), {"ana/loja": ctl.cname("ana", "loja")})


if __name__ == "__main__":
    unittest.main()
