# sealpost (Ruby)

Zero-dependency Ruby client for the self-hosted [Sealpost](https://github.com/isagarpinninti/sealpost) email API. Ruby 2.6+, standard library only.

```bash
gem install sealpost
```

```ruby
require "sealpost"

mail = Sealpost::Client.new(api_key: ENV["SEALPOST_KEY"], base_url: "https://mail.yourdomain.com")

result = mail.emails.deliver(
  template: "magic_link_otp_verification", to: "user@example.org",
  variables: { userName: "Ada", otpCode: "482913", signInUrl: "https://app.example.com/in" },
  idempotency_key: "signup-42", tags: [{ name: "campaign", value: "welcome" }],
)
if result.error&.code == "preflight_blocked"
  puts result.error.preflight["checks"]   # nothing was sent
elsif result.ok?
  puts result.data["id"]
end
```

Results are `Sealpost::Result` objects (`data` / `error`); nothing raises unless you call `.unwrap`. The method is `deliver` (alias `send_email`) because `send` is taken by Ruby's `Object`.

Also: `emails.batch/get/list/preview`, `inbound.list/get/raw/attachment/delete`, `audiences.*`, `broadcasts.*`, `scheduled.*`, `suppressions.*`, `domains.list/check`, `stats`, `unsubscribe_link`, and `Sealpost::Webhooks.verify(secret, raw_body, header)`.

Run the tests with `ruby test/sealpost_test.rb`. MIT.
