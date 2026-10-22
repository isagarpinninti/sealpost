# sealpost (Python)

[![PyPI](https://img.shields.io/pypi/v/sealpost)](https://pypi.org/project/sealpost/)

Zero-dependency Python client for the self-hosted [Sealpost](https://github.com/isagarpinninti/sealpost) email API. Python 3.8+, standard library only.

```bash
pip install sealpost
```

```python
from sealpost import Sealpost, verify_webhook

mail = Sealpost(api_key="evk_...", base_url="https://mail.yourdomain.com")

result = mail.emails.send(
    "magic_link_otp_verification", "user@example.org",
    variables={"userName": "Ada", "otpCode": "482913", "signInUrl": "https://app.example.com/in"},
)
if result.error and result.error.code == "preflight_blocked":
    print(result.error.preflight["checks"])      # nothing was sent
elif result.ok:
    print(result.data["messageId"])
```

Results are `Result(data, error)` objects; nothing raises unless you call `.unwrap()`.

```python
aud = mail.audiences.create("Customers").unwrap()
mail.audiences.add_contacts(aud["id"], [{"email": "ada@example.org", "name": "Ada", "variables": {"userName": "Ada"}}])
mail.broadcasts.create("Launch", aud["id"], "workspace_team_invitation",
                       scheduled_at="2030-01-01T09:00:00Z", rate_per_minute=300)

mail.domains.check("news.example.org")           # live SPF / DKIM / DMARC lookup
```

### Verifying webhooks

```python
ok, reason = verify_webhook(SECRET, raw_body, request.headers["Sealpost-Signature"])
```

Pass the **raw** request body, before JSON parsing. Run the tests with `PYTHONPATH=src python -m unittest discover tests`. MIT.
