#!/usr/bin/env python3
"""Regression tests for HTTP Basic lifecycle and publish smoke checks."""
import base64
import importlib.util
import pathlib
import unittest

HERE = pathlib.Path(__file__).resolve().parent

def load(name):
    spec = importlib.util.spec_from_file_location(name, HERE / (name + ".py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

ctl = load("ctl")
router = load("router")

class Headers(dict):
    def get(self, key, default=None):
        return super().get(key, default)

def basic(user, password):
    raw = base64.b64encode((user + ":" + password).encode()).decode()
    return Headers(Authorization="Basic " + raw)

class BasicAuthLifecycleTest(unittest.TestCase):
    def test_same_credentials_keep_salt_and_hash(self):
        first = ctl._auth_entry({"user": "ana", "password": "segredo"})
        second = ctl._auth_entry({"user": "ana", "password": "segredo"}, {"auth": first})
        self.assertIs(second, first)
        self.assertEqual(router.auth_realm("agenda", second), router.auth_realm("agenda", first))
        self.assertEqual(router.auth_check({"auth": second}, basic("ana", "segredo")), "ok")

    def test_password_change_rotates_salt_and_invalidates_old_password(self):
        first = ctl._auth_entry({"user": "ana", "password": "antiga"})
        second = ctl._auth_entry({"user": "ana", "password": "nova"}, {"auth": first})
        self.assertNotEqual(second["salt"], first["salt"])
        self.assertNotEqual(router.auth_realm("agenda", second), router.auth_realm("agenda", first))
        self.assertEqual(router.auth_check({"auth": second}, basic("ana", "antiga")), "need")
        self.assertEqual(router.auth_check({"auth": second}, basic("ana", "nova")), "ok")

    def test_username_change_rotates_salt(self):
        first = ctl._auth_entry({"user": "ana", "password": "segredo"})
        second = ctl._auth_entry({"user": "bia", "password": "segredo"}, {"auth": first})
        self.assertNotEqual(second["salt"], first["salt"])

class FunctionalSmokeTest(unittest.TestCase):
    def test_literal_fetch_500_blocks_publish_smoke(self):
        old_html, old_get = ctl._router_html, ctl._router_get
        try:
            ctl._router_html = lambda label, system: '<script>fetch("api/status")</script>'
            ctl._router_get = lambda label, path: 500 if path.endswith('/api/status') else 200
            out = ctl._smoketest('ana', 'agenda')
            self.assertEqual(out['broken_functional'], [{'ref': 'api/status', 'status': 500}])
        finally:
            ctl._router_html, ctl._router_get = old_html, old_get

    def test_expected_auth_response_is_warning_not_publish_block(self):
        old_html, old_get = ctl._router_html, ctl._router_get
        try:
            ctl._router_html = lambda label, system: '<script>fetch("api/health")</script>'
            ctl._router_get = lambda label, path: 401
            out = ctl._smoketest('ana', 'agenda')
            self.assertNotIn('broken_functional', out)
            self.assertEqual(out['functional_warnings'][0]['status'], 401)
        finally:
            ctl._router_html, ctl._router_get = old_html, old_get

if __name__ == "__main__":
    unittest.main()
