import hashlib
import hmac
import json
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer

from sealpost import Sealpost, sign_webhook, verify_webhook


def serve(handler):
    seen = []

    class H(BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def _do(self):
            length = int(self.headers.get("Content-Length") or 0)
            body = self.rfile.read(length).decode() if length else ""
            seen.append({"method": self.command, "path": self.path, "auth": self.headers.get("Authorization"), "idem": self.headers.get("Idempotency-Key"), "body": body})
            status, payload = handler(self.path, body)
            raw = json.dumps(payload).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)

        do_GET = do_POST = do_DELETE = _do

    server = HTTPServer(("127.0.0.1", 0), H)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, "http://127.0.0.1:%d" % server.server_address[1], seen


class SealpostTests(unittest.TestCase):
    def test_send_maps_body_and_returns_data(self):
        server, url, seen = serve(lambda p, b: (201, {"ok": True, "status": "delivered", "messageId": "<m@x>"}))
        self.addCleanup(server.shutdown)
        r = Sealpost("evk_t", url).emails.send("t", "a@b.co", variables={"x": 1}, auto_fill=True, domain="d.io")
        self.assertTrue(r.ok)
        self.assertEqual(r.data["status"], "delivered")
        self.assertEqual(seen[0]["auth"], "Bearer evk_t")
        self.assertEqual(json.loads(seen[0]["body"]), {"templateId": "t", "to": "a@b.co", "variables": {"x": 1}, "autoFill": True, "domain": "d.io"})

    def test_blocked_send_is_an_error_not_an_exception(self):
        pre = {"gate": "BLOCKED", "checks": []}
        server, url, _ = serve(lambda p, b: (403, {"ok": False, "error": "Blocked", "code": "preflight_blocked", "preflight": pre}))
        self.addCleanup(server.shutdown)
        r = Sealpost("k", url).emails.send("t", "a@b.co")
        self.assertIsNone(r.data)
        self.assertEqual((r.error.status, r.error.code, r.error.preflight["gate"]), (403, "preflight_blocked", "BLOCKED"))
        with self.assertRaises(Exception):
            r.unwrap()

    def test_network_failure_is_status_zero(self):
        r = Sealpost("k", "http://127.0.0.1:1", timeout=1).stats()
        self.assertEqual(r.error.status, 0)

    def test_audiences_broadcasts_and_encoding(self):
        server, url, seen = serve(lambda p, b: (200, {"ok": True, "broadcast": {"id": "brd_1"}, "audience": {"id": "aud_1"}, "added": 1, "total": 1}))
        self.addCleanup(server.shutdown)
        m = Sealpost("k", url)
        self.assertEqual(m.audiences.create("L").data["id"], "aud_1")
        m.audiences.add_contacts("aud_1", [{"email": "a@b.co", "name": "A"}])
        self.assertEqual(m.broadcasts.create("n", "aud_1", "t", scheduled_at="2030-01-01T00:00:00Z", rate_per_minute=120).data["id"], "brd_1")
        self.assertEqual(json.loads(seen[2]["body"]), {"name": "n", "audienceId": "aud_1", "templateId": "t", "scheduledAtIso": "2030-01-01T00:00:00Z", "ratePerMinute": 120})
        m.suppressions.remove("a+b@x.io")
        self.assertEqual(seen[3]["path"], "/api/suppressions?email=a%2Bb%40x.io")

    def test_batch_wraps_items(self):
        server, url, seen = serve(lambda p, b: (200, {"accepted": 2, "rejected": 0, "results": []}))
        self.addCleanup(server.shutdown)
        Sealpost("k", url).emails.batch([{"template": "t", "to": "a@b.co", "auto_fill": True}, {"template": "t", "to": "c@d.co"}])
        self.assertEqual(json.loads(seen[0]["body"])["emails"][0], {"templateId": "t", "to": "a@b.co", "autoFill": True})

    def test_webhook_verification(self):
        body = json.dumps({"id": "evt_1", "type": "email.delivered"})
        t = 1_700_000_000
        header = "t=%d,v1=%s" % (t, hmac.new(b"whsec", ("%d.%s" % (t, body)).encode(), hashlib.sha256).hexdigest())
        self.assertEqual(verify_webhook("whsec", body, header, now=t + 5), (True, None))
        self.assertEqual(verify_webhook("whsec", body + " ", header, now=t + 5), (False, "mismatch"))
        self.assertEqual(verify_webhook("whsec", body, header, now=t + 9999), (False, "stale"))
        self.assertEqual(verify_webhook("whsec", body, "nope"), (False, "malformed"))
        self.assertEqual(verify_webhook("whsec", body.encode(), sign_webhook("whsec", body)), (True, None))

    def test_idempotency_key_header_tags_and_replay_flag(self):
        seen_headers = []

        def handler(path, body):
            return 201, {"ok": True, "id": "em_1", "status": "delivered"}

        server, url, seen = serve(handler)
        self.addCleanup(server.shutdown)
        r = Sealpost("k", url).emails.send("t", "a@b.co", tags=[{"name": "c", "value": "v"}], metadata={"u": "1"}, idempotency_key="order-1")
        self.assertEqual(r.data["id"], "em_1")
        self.assertFalse(r.replayed)
        self.assertEqual(json.loads(seen[0]["body"]), {"templateId": "t", "to": "a@b.co", "tags": [{"name": "c", "value": "v"}], "metadata": {"u": "1"}})
        self.assertEqual(seen[0]["idem"], "order-1")

    def test_list_and_get_and_request_id(self):
        server, url, seen = serve(lambda p, b: (404, {"ok": False, "error": "No such email", "code": "not_found", "requestId": "req_x"}) if "em_" in p and "?" not in p else (200, {"data": [], "hasMore": False, "nextCursor": None}))
        self.addCleanup(server.shutdown)
        m = Sealpost("k", url)
        m.emails.list(status="bounced", tag="campaign:welcome", limit=5, before="em_9")
        self.assertEqual(seen[0]["path"], "/api/emails?status=bounced&tag=campaign%3Awelcome&limit=5&before=em_9")
        e = m.emails.get("em_9").error
        self.assertEqual((e.status, e.code, e.request_id), (404, "not_found", "req_x"))

    def test_inbound_list_get_and_bytes(self):
        def handler(path, body):
            if "/attachments/" in path:
                return 200, {"unused": True}
            if path.startswith("/api/inbound?"):
                return 200, {"data": [{"id": "in_1"}], "hasMore": False, "nextCursor": None}
            return 404, {"ok": False, "error": "No such received message", "code": "not_found", "requestId": "req_z"}

        server, url, seen = serve(handler)
        self.addCleanup(server.shutdown)
        m = Sealpost("k", url)
        page = m.inbound.list(from_="ada@", kind="bounce", limit=3)
        self.assertEqual(page.data["data"][0]["id"], "in_1")
        self.assertEqual(seen[0]["path"], "/api/inbound?from=ada%40&kind=bounce&limit=3")
        att = m.inbound.attachment("in_1", 0)
        self.assertTrue(att.ok)
        self.assertIsInstance(att.data["bytes"], bytes)
        self.assertEqual(att.data["content_type"], "application/json")
        e = m.inbound.get("in_x").error
        self.assertEqual((e.status, e.code, e.request_id), (404, "not_found", "req_z"))
        m.emails.send("t", "a@b.co", in_reply_to="in_1")
        self.assertEqual(json.loads(seen[-1]["body"]), {"templateId": "t", "to": "a@b.co", "inReplyTo": "in_1"})

    def test_schedule_and_unsubscribe_link(self):
        def handler(path, body):
            if path == "/api/unsubscribe-link":
                return 200, {"ok": True, "url": "https://m.example.com/u/abc"}
            if path == "/api/scheduled":
                return 200, {"scheduled": [{"id": "sch_1"}]}
            if path.startswith("/api/scheduled/"):
                return 200, {"scheduled": {"id": "sch_1", "status": "cancelled"}}
            return 202, {"ok": True, "status": "scheduled", "id": "sch_1"}

        server, url, seen = serve(handler)
        self.addCleanup(server.shutdown)
        m = Sealpost("k", url)
        r = m.emails.send("t", "a@b.co", scheduled_at="2030-01-01T00:00:00Z")
        self.assertEqual(r.data["status"], "scheduled")
        self.assertEqual(json.loads(seen[0]["body"])["scheduledAt"], "2030-01-01T00:00:00Z")
        self.assertEqual(m.scheduled.list().data, [{"id": "sch_1"}])
        self.assertEqual(m.scheduled.cancel("sch_1").data["status"], "cancelled")
        self.assertEqual(seen[-1]["method"], "DELETE")
        self.assertEqual(m.unsubscribe_link("a@b.co").data, "https://m.example.com/u/abc")

    def test_requires_key(self):
        with self.assertRaises(ValueError):
            Sealpost("")


if __name__ == "__main__":
    unittest.main()
