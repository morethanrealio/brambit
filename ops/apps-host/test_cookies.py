#!/usr/bin/env python3
"""An app's cookies only reach that app. A page on another tenant's subdomain
can write a cookie for the parent domain, and the browser would hand it to
this app. Runs the router against a local stand-in for the app's container."""
import http.client
import importlib.util
import json
import os
import pathlib
import tempfile
import threading
import unittest
from unittest import mock
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = pathlib.Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("router", HERE / "router.py")
router = importlib.util.module_from_spec(spec)
spec.loader.exec_module(router)


class App(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_GET(self):
        seen = self.headers.get_all("Cookie") or []
        body = ("<html><head><title>loja</title></head><body>%s</body></html>" % "|".join(seen)).encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Set-Cookie", "session=abc; Domain=.apps.test; Path=/loja/; HttpOnly")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def serve(handler):
    srv = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


class HostOnlyCookieTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        # the router reaches the app straight, never through a proxy in the environment
        env = mock.patch.dict(os.environ, {"no_proxy": "127.0.0.1", "NO_PROXY": "127.0.0.1"})
        env.start(); self.addCleanup(env.stop)
        self.app = serve(App)
        reg = os.path.join(self.tmp.name, "apps.json")
        with open(reg, "w") as f:
            json.dump({"ana/loja": {"container": "brambs-ana.loja", "port": self.app.server_port}}, f)
        self._orig = (router.REG_PATH, router.ensure_up)
        router.REG_PATH = reg
        router.ensure_up = lambda name, port: "127.0.0.1"
        self.router = serve(router.Handler)

    def tearDown(self):
        for s in (self.router, self.app):
            s.shutdown(); s.server_close()
        router.REG_PATH, router.ensure_up = self._orig
        self.tmp.cleanup()

    def get(self, headers):
        c = http.client.HTTPConnection("127.0.0.1", self.router.server_port, timeout=10)
        c.request("GET", "/loja/", headers=dict(headers, Host="ana.apps.test"))
        r = c.getresponse(); body = r.read().decode(); c.close()
        self.assertEqual(r.status, 200)
        return r.getheader("Set-Cookie"), body

    def test_the_app_cookie_goes_out_under_a_name_no_other_host_can_write(self):
        # opened directly (wrapped in the shell page) and loaded inside the shell
        for headers in ({"Sec-Fetch-Dest": "document"}, {"Sec-Fetch-Dest": "iframe"}):
            set_cookie, _ = self.get(headers)
            self.assertEqual(set_cookie, "__Host-loja.session=abc; HttpOnly; Path=/; Secure")

    def test_the_app_only_gets_its_own_cookies_back_under_its_name(self):
        planted = "session=attacker; __Host-loja.session=abc; __Host-blog.session=other; __host-loja.x=1"
        _, body = self.get({"Sec-Fetch-Dest": "iframe", "Cookie": planted})
        self.assertIn("<body>session=abc</body>", body)

    def test_without_its_own_cookie_the_app_gets_no_cookie_header(self):
        _, body = self.get({"Sec-Fetch-Dest": "iframe", "Cookie": "session=attacker"})
        self.assertIn("<body></body>", body)

    def test_deleting_a_cookie_hits_the_renamed_one(self):
        self.assertEqual(router.app_cookie_out("session=; Max-Age=0; Path=/x/; Domain=a.test", "loja"),
                         "__Host-loja.session=; Max-Age=0; Path=/; Secure")
        self.assertIsNone(router.app_cookie_out("garbage; HttpOnly", "loja"))


if __name__ == "__main__":
    unittest.main()
