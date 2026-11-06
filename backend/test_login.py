import http.client
import threading
import unittest
from http.server import ThreadingHTTPServer
from unittest.mock import patch
from urllib.parse import urlencode

from test_server import server


class TestPhoneLogin(unittest.TestCase):
    def setUp(self):
        self.settings = patch.multiple(server, USER="test-owner", PASSWORD="test-password")
        self.settings.start()
        server.LOGIN_FAILURES.clear()
        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.httpd.shutdown()
        self.httpd.server_close()
        self.thread.join()
        self.settings.stop()
        server.LOGIN_FAILURES.clear()

    def request(self, method, path, body=None, **headers):
        client = http.client.HTTPConnection("127.0.0.1", self.httpd.server_port)
        client.request(method, path, body=body, headers={"Host": "portfolio.example", "X-Forwarded-Proto": "https", **headers})
        response = client.getresponse()
        result = response.status, dict(response.getheaders()), response.read()
        client.close()
        return result

    def login(self, password="test-password", **headers):
        body = urlencode({"username": "test-owner", "password": password})
        return self.request("POST", "/api/login", body, **{
            "Content-Type": "application/x-www-form-urlencoded", "Origin": "https://portfolio.example", **headers})

    def test_phone_sees_visible_form_and_no_basic_dialog(self):
        status, headers, body = self.request("GET", "/")
        self.assertEqual(status, 200)
        self.assertIn(b'action="/api/login"', body)
        self.assertNotIn("WWW-Authenticate", headers)
        self.assertEqual(headers["Referrer-Policy"], "same-origin")
        self.assertNotIn(b"test-password", body)

    def test_correct_password_cookie_and_private_api(self):
        status, headers, body = self.login()
        self.assertEqual(status, 303)
        cookie = headers["Set-Cookie"]
        for flag in ("HttpOnly", "Secure", "SameSite=Strict", "Path=/"):
            self.assertIn(flag, cookie)
        self.assertNotIn("test-password", cookie)
        with patch.object(server.saved_state, "read_profile", return_value={"private": True}):
            status, headers, body = self.request("GET", "/api/user-data", Cookie=cookie.split(";", 1)[0])
        self.assertEqual(status, 200)
        self.assertIn(b'"private": true', body)

    def test_wrong_password_cannot_read_data(self):
        status, headers, body = self.login("wrong")
        self.assertEqual(status, 401)
        self.assertNotIn("Set-Cookie", headers)
        self.assertIn("Неверный".encode(), body)
        self.assertEqual(self.request("GET", "/api/user-data")[0], 401)

    def test_cross_site_and_insecure_login_rejected(self):
        self.assertEqual(self.login(Origin="https://other.example")[0], 403)
        self.assertEqual(self.login(**{"X-Forwarded-Proto": "http"})[0], 403)

    def test_expired_tampered_and_changed_password_sessions_rejected(self):
        with patch.object(server.time, "time", return_value=1000):
            token = server.session_token()
            self.assertTrue(server.session_valid(token))
            self.assertFalse(server.session_valid(token[:-1] + ("0" if token[-1] != "0" else "1")))
        with patch.object(server.time, "time", return_value=1000 + server.SESSION_LIFETIME):
            self.assertFalse(server.session_valid(token))
        with patch.object(server, "PASSWORD", "changed"), patch.object(server.time, "time", return_value=1001):
            self.assertFalse(server.session_valid(token))

    def test_cookie_survives_process_memory_reset(self):
        token = server.session_token()
        server.LOGIN_FAILURES.clear()
        self.assertTrue(server.session_valid(token))


if __name__ == "__main__":
    unittest.main()
