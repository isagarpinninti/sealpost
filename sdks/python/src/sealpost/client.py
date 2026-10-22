from __future__ import annotations

import json
import re
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from typing import Any, Callable, Dict, Generic, List, Optional, TypeVar

from .webhooks import verify_webhook

T = TypeVar("T")


@dataclass
class SealpostError:
    """``status`` is the HTTP status, or 0 for a network failure or timeout."""

    status: int
    message: str
    code: Optional[str] = None
    preflight: Optional[Dict[str, Any]] = None
    #: Matches the server's ``x-request-id`` header; quote it when reporting a problem.
    request_id: Optional[str] = None

    def __str__(self) -> str:
        return "%s (%s)%s" % (self.message, self.status, " [%s]" % self.code if self.code else "")


class SealpostException(Exception):
    def __init__(self, error: SealpostError) -> None:
        super().__init__(str(error))
        self.error = error


@dataclass
class Result(Generic[T]):
    """Exactly one of ``data`` and ``error`` is set. Nothing raises unless you call ``unwrap()``."""

    data: Optional[T] = None
    error: Optional[SealpostError] = None
    #: Response headers, lower-cased.
    headers: Optional[Dict[str, str]] = None

    @property
    def replayed(self) -> bool:
        """True when the server replayed an earlier response for the same ``idempotency_key``."""
        return (self.headers or {}).get("idempotent-replayed") == "true"

    @property
    def ok(self) -> bool:
        return self.error is None

    def unwrap(self) -> T:
        if self.error is not None:
            raise SealpostException(self.error)
        return self.data  # type: ignore[return-value]


def _to_body(template: str, to: Any, **opts: Any) -> Dict[str, Any]:
    body: Dict[str, Any] = {"templateId": template, "to": to}
    names = {"domain": "domain", "cc": "cc", "bcc": "bcc", "variables": "variables", "auto_fill": "autoFill", "attachments": "attachments", "include_mime": "includeMime", "tags": "tags", "metadata": "metadata", "in_reply_to": "inReplyTo", "scheduled_at": "scheduledAt"}
    for key, wire in names.items():
        if opts.get(key) is not None:
            body[wire] = opts[key]
    return body


class _Resource:
    def __init__(self, client: "Sealpost") -> None:
        self._c = client


class Emails(_Resource):
    def send(self, template: str, to: Any, **opts: Any) -> Result[Dict[str, Any]]:
        """Send one email. ``error.code == "preflight_blocked"`` means nothing was sent; see ``error.preflight``.

        Options: ``scheduled_at`` (ISO 8601, up to 90 days ahead; the gate runs now and again then), ``variables``, ``domain``, ``cc``, ``bcc``, ``auto_fill``, ``attachments``, ``tags`` (list of
        ``{"name", "value"}``), ``metadata`` (str to str) and ``idempotency_key``: retrying with the same key and
        body within 24 h returns the original result (``result.replayed``) instead of sending again.
        """
        key = opts.pop("idempotency_key", None)  # also accepted: in_reply_to=<Message-ID or an in_… id from inbound.list>
        return self._c._call("POST", "/api/send", _to_body(template, to, **opts), None, {"Idempotency-Key": key} if key else None)

    def get(self, email_id: str) -> Result[Dict[str, Any]]:
        """One email with its status timeline (opens, clicks, bounces, ...)."""
        return self._c._call("GET", "/api/emails/%s" % _q(email_id))

    def list(self, status: Optional[str] = None, to: Optional[str] = None, template: Optional[str] = None, domain: Optional[str] = None, tag: Optional[str] = None, since: Optional[str] = None, until: Optional[str] = None, limit: Optional[int] = None, before: Optional[str] = None) -> Result[Dict[str, Any]]:
        """Newest first. Page with ``before=page["nextCursor"]``; the data has ``data``, ``hasMore`` and ``nextCursor``."""
        params = {k: v for k, v in {"status": status, "to": to, "template": template, "domain": domain, "tag": tag, "since": since, "until": until, "limit": limit, "before": before}.items() if v is not None}
        return self._c._call("GET", "/api/emails?" + urllib.parse.urlencode(params))

    def batch(self, items: List[Dict[str, Any]]) -> Result[Dict[str, Any]]:
        """Up to 100 items of ``{"template": ..., "to": ..., ...}``; failures are reported per item."""
        emails = [_to_body(i["template"], i["to"], **{k: v for k, v in i.items() if k not in ("template", "to")}) for i in items]
        return self._c._call("POST", "/api/send/batch", {"emails": emails})

    def preview(self, template: str, to: Any = None, **opts: Any) -> Result[Dict[str, Any]]:
        return self._c._call("POST", "/api/compile", _to_body(template, to or [], **opts))


class Scheduled(_Resource):
    def list(self) -> Result[List[Dict[str, Any]]]:
        return self._c._call("GET", "/api/scheduled", None, lambda j: j.get("scheduled", []))

    def cancel(self, scheduled_id: str) -> Result[Dict[str, Any]]:
        """Cancel a scheduled send that has not run yet."""
        return self._c._call("DELETE", "/api/scheduled/%s" % _q(scheduled_id), None, lambda j: j["scheduled"])


class Inbound(_Resource):
    """Received mail. ``html`` bodies are untrusted: show them only in a sandboxed frame with remote content blocked."""

    def list(self, from_: Optional[str] = None, to: Optional[str] = None, q: Optional[str] = None, kind: Optional[str] = None, since: Optional[str] = None, until: Optional[str] = None, limit: Optional[int] = None, before: Optional[str] = None) -> Result[Dict[str, Any]]:
        """Newest first. ``kind`` is message, bounce or complaint. Page with ``before=page["nextCursor"]``."""
        params = {k: v for k, v in {"from": from_, "to": to, "q": q, "kind": kind, "since": since, "until": until, "limit": limit, "before": before}.items() if v is not None}
        return self._c._call("GET", "/api/inbound?" + urllib.parse.urlencode(params))

    def get(self, inbound_id: str) -> Result[Dict[str, Any]]:
        """One message with decoded ``text``, ``html`` and ``headers``."""
        return self._c._call("GET", "/api/inbound/%s" % _q(inbound_id))

    def raw(self, inbound_id: str) -> Result[Dict[str, Any]]:
        """The original bytes: ``{"bytes": b"...", "content_type": ..., "filename": ...}``."""
        return self._c._call_bytes("/api/inbound/%s/raw" % _q(inbound_id))

    def attachment(self, inbound_id: str, index: int) -> Result[Dict[str, Any]]:
        """One attachment: ``{"bytes": b"...", "content_type": ..., "filename": ...}``."""
        return self._c._call_bytes("/api/inbound/%s/attachments/%d" % (_q(inbound_id), index))

    def delete(self, inbound_id: str) -> Result[Dict[str, Any]]:
        return self._c._call("DELETE", "/api/inbound/%s" % _q(inbound_id))


class Audiences(_Resource):
    def create(self, name: str) -> Result[Dict[str, Any]]:
        return self._c._call("POST", "/api/audiences", {"name": name}, lambda j: j["audience"])

    def list(self) -> Result[List[Dict[str, Any]]]:
        return self._c._call("GET", "/api/audiences", None, lambda j: j.get("audiences", []))

    def get(self, audience_id: str, offset: int = 0, limit: int = 100) -> Result[Dict[str, Any]]:
        return self._c._call("GET", "/api/audiences/%s?offset=%d&limit=%d" % (_q(audience_id), offset, limit))

    def add_contacts(self, audience_id: str, contacts: List[Dict[str, Any]]) -> Result[Dict[str, Any]]:
        """Each contact is ``{"email": ..., "name": ..., "variables": {...}}``; up to 10,000 per call."""
        return self._c._call("POST", "/api/audiences/%s/contacts" % _q(audience_id), {"contacts": contacts})

    def remove_contact(self, audience_id: str, email: str) -> Result[Dict[str, Any]]:
        return self._c._call("DELETE", "/api/audiences/%s/contacts?email=%s" % (_q(audience_id), _q(email)))

    def delete(self, audience_id: str) -> Result[Dict[str, Any]]:
        return self._c._call("DELETE", "/api/audiences/%s" % _q(audience_id))


class Broadcasts(_Resource):
    def create(self, name: str, audience_id: str, template: str, domain: Optional[str] = None, variables: Optional[Dict[str, Any]] = None, scheduled_at: Optional[str] = None, rate_per_minute: Optional[int] = None) -> Result[Dict[str, Any]]:
        """``scheduled_at`` is an ISO 8601 string (``datetime.isoformat()``); omit to start immediately."""
        body: Dict[str, Any] = {"name": name, "audienceId": audience_id, "templateId": template}
        if domain is not None:
            body["domain"] = domain
        if variables is not None:
            body["variables"] = variables
        if scheduled_at is not None:
            body["scheduledAtIso"] = scheduled_at
        if rate_per_minute is not None:
            body["ratePerMinute"] = rate_per_minute
        return self._c._call("POST", "/api/broadcasts", body, lambda j: j["broadcast"])

    def list(self) -> Result[List[Dict[str, Any]]]:
        return self._c._call("GET", "/api/broadcasts", None, lambda j: j.get("broadcasts", []))

    def get(self, broadcast_id: str) -> Result[Dict[str, Any]]:
        return self._c._call("GET", "/api/broadcasts/%s" % _q(broadcast_id))

    def cancel(self, broadcast_id: str) -> Result[Dict[str, Any]]:
        return self._c._call("POST", "/api/broadcasts/%s/cancel" % _q(broadcast_id), {}, lambda j: j["broadcast"])


class Domains(_Resource):
    def list(self) -> Result[List[Dict[str, Any]]]:
        return self._c._call("GET", "/api/domains", None, lambda j: j.get("domains", []))

    def check(self, domain: str) -> Result[Dict[str, Any]]:
        """Live DNS lookup of SPF, DKIM and DMARC."""
        return self._c._call("GET", "/api/domains/%s/check" % _q(domain))


class Suppressions(_Resource):
    def list(self) -> Result[List[Dict[str, Any]]]:
        return self._c._call("GET", "/api/suppressions", None, lambda j: j.get("suppressions", []))

    def add(self, email: str, reason: str = "unsubscribed", detail: Optional[str] = None) -> Result[List[Dict[str, Any]]]:
        return self._c._call("POST", "/api/suppressions", {"email": email, "reason": reason, "detail": detail}, lambda j: j.get("suppressions", []))

    def remove(self, email: str) -> Result[List[Dict[str, Any]]]:
        return self._c._call("DELETE", "/api/suppressions?email=%s" % _q(email), None, lambda j: j.get("suppressions", []))


class Webhooks(_Resource):
    @staticmethod
    def verify(secret: str, raw_body: Any, signature_header: Optional[str], **kwargs: Any):
        """See :func:`sealpost.verify_webhook`."""
        return verify_webhook(secret, raw_body, signature_header, **kwargs)

    def test(self, endpoint_id: str) -> Result[Dict[str, Any]]:
        return self._c._call("POST", "/api/webhooks/%s/test" % _q(endpoint_id), {})

    def deliveries(self) -> Result[List[Dict[str, Any]]]:
        return self._c._call("GET", "/api/webhooks/deliveries", None, lambda j: j.get("deliveries", []))


def _q(value: str) -> str:
    return urllib.parse.quote(value, safe="")


class Sealpost:
    """Client for the Sealpost REST API::

        mail = Sealpost(api_key="evk_...", base_url="https://mail.example.com")
        result = mail.emails.send("magic_link_otp_verification", "user@example.org",
                                  variables={"userName": "Ada", "otpCode": "482913", "signInUrl": "https://app.example.com/in"})
        if result.error and result.error.code == "preflight_blocked":
            print(result.error.preflight["checks"])
    """

    def __init__(self, api_key: str, base_url: str = "http://127.0.0.1:4320", timeout: float = 30.0) -> None:
        if not api_key:
            raise ValueError("Sealpost: api_key is required")
        self._key = api_key
        self._base = base_url.rstrip("/")
        self._timeout = timeout
        self.emails = Emails(self)
        self.inbound = Inbound(self)
        self.scheduled = Scheduled(self)
        self.audiences = Audiences(self)
        self.broadcasts = Broadcasts(self)
        self.domains = Domains(self)
        self.suppressions = Suppressions(self)
        self.webhooks = Webhooks(self)

    def unsubscribe_link(self, email: str, domain: Optional[str] = None) -> Result[str]:
        """A hosted one-click unsubscribe URL (needs ``unsubscribe.hosted`` and a ``trackingBaseUrl`` on the server)."""
        return self._call("POST", "/api/unsubscribe-link", {"email": email, "domain": domain}, lambda j: j["url"])

    def stats(self) -> Result[Dict[str, Any]]:
        return self._call("GET", "/api/stats")

    def events(self) -> Result[List[Dict[str, Any]]]:
        return self._call("GET", "/api/events", None, lambda j: j.get("events", []))

    def verify_receipt(self, token: str, inbox_id: Optional[str] = None) -> Result[Dict[str, Any]]:
        return self._call("POST", "/api/verify", {"token": token, "inboxId": inbox_id})

    def verify_ledger(self) -> Result[Dict[str, Any]]:
        return self._call("GET", "/api/ledger/verify")

    def _call_bytes(self, path: str) -> Result[Any]:
        req = urllib.request.Request(self._base + path, headers={"Authorization": "Bearer " + self._key, "User-Agent": "sealpost-python/0.1.0"})
        try:
            with urllib.request.urlopen(req, timeout=self._timeout) as res:
                return Result(data={"bytes": res.read(), "content_type": res.headers.get("Content-Type", "application/octet-stream"), "filename": _filename(res.headers.get("Content-Disposition", ""))})
        except urllib.error.HTTPError as e:
            payload = _parse(e.read())
            return Result(error=SealpostError(status=e.code, message=str(payload.get("error", "HTTP %d" % e.code)), code=payload.get("code"), request_id=payload.get("requestId") or e.headers.get("x-request-id")))
        except (urllib.error.URLError, OSError, TimeoutError) as e:
            return Result(error=SealpostError(status=0, message=str(getattr(e, "reason", e))))

    def _call(self, method: str, path: str, body: Any = None, pick: Optional[Callable[[Dict[str, Any]], Any]] = None, extra_headers: Optional[Dict[str, str]] = None) -> Result[Any]:
        headers = {"Authorization": "Bearer " + self._key, "Accept": "application/json", "User-Agent": "sealpost-python/0.1.0"}
        headers.update(extra_headers or {})
        data = None
        if body is not None:
            data = json.dumps({k: v for k, v in body.items() if v is not None} if isinstance(body, dict) else body).encode("utf-8")
            headers["Content-Type"] = "application/json"
        req = urllib.request.Request(self._base + path, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=self._timeout) as res:
                payload = _parse(res.read())
                return Result(data=pick(payload) if pick else payload, headers={k.lower(): v for k, v in res.headers.items()})
        except urllib.error.HTTPError as e:
            payload = _parse(e.read())
            return Result(error=SealpostError(status=e.code, message=str(payload.get("error", "HTTP %d" % e.code)), code=payload.get("code"), preflight=payload.get("preflight"), request_id=payload.get("requestId") or e.headers.get("x-request-id")))
        except (urllib.error.URLError, OSError, TimeoutError) as e:
            return Result(error=SealpostError(status=0, message=str(getattr(e, "reason", e))))


def _filename(disposition: str) -> Optional[str]:
    encoded = re.search(r"filename\*=UTF-8''([^;]+)", disposition, re.I)
    return urllib.parse.unquote(encoded.group(1)) if encoded else None


def _parse(raw: bytes) -> Dict[str, Any]:
    try:
        value = json.loads(raw.decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        return {}
    return value if isinstance(value, dict) else {"_": value}
