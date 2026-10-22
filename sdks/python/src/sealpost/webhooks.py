"""Verification of Sealpost outbound webhooks.

The ``Sealpost-Signature`` header is ``t=<unix seconds>,v1=<hex>`` where
``v1 = HMAC-SHA256(secret, "<t>.<raw body>")``. Always verify against the raw bytes.
"""
from __future__ import annotations

import hashlib
import hmac
import re
import time
from typing import Optional, Tuple, Union

SIGNATURE_HEADER = "Sealpost-Signature"
DEFAULT_TOLERANCE_SECONDS = 300

_HEX64 = re.compile(r"^[0-9a-f]{64}$")


def verify_webhook(
    secret: str,
    raw_body: Union[str, bytes],
    signature_header: Optional[str],
    tolerance_seconds: int = DEFAULT_TOLERANCE_SECONDS,
    now: Optional[float] = None,
) -> Tuple[bool, Optional[str]]:
    """Returns ``(ok, reason)``; ``reason`` is ``malformed``, ``stale`` or ``mismatch`` when not ok."""
    parts = {}
    for piece in (signature_header or "").split(","):
        key, sep, value = piece.partition("=")
        if sep:
            parts[key.strip()] = value.strip()
    try:
        t = int(parts.get("t", ""))
    except ValueError:
        return False, "malformed"
    v1 = parts.get("v1", "")
    if not _HEX64.match(v1):
        return False, "malformed"
    if abs((time.time() if now is None else now) - t) > tolerance_seconds:
        return False, "stale"
    body = raw_body.encode("utf-8") if isinstance(raw_body, str) else raw_body
    expected = hmac.new(secret.encode("utf-8"), str(t).encode("ascii") + b"." + body, hashlib.sha256).hexdigest()
    return (True, None) if hmac.compare_digest(expected, v1) else (False, "mismatch")


def sign_webhook(secret: str, raw_body: Union[str, bytes], timestamp: Optional[int] = None) -> str:
    """Builds a signature header. Useful in tests for your own handler."""
    t = int(time.time()) if timestamp is None else timestamp
    body = raw_body.encode("utf-8") if isinstance(raw_body, str) else raw_body
    mac = hmac.new(secret.encode("utf-8"), str(t).encode("ascii") + b"." + body, hashlib.sha256).hexdigest()
    return "t=%d,v1=%s" % (t, mac)
