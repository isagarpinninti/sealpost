# sealpost/sealpost (PHP)

Zero-dependency PHP client for the self-hosted [Sealpost](https://github.com/isagarpinninti/sealpost) email API. PHP 7.4+, needs only `ext-curl` and `ext-json`.

```bash
composer require sealpost/sealpost
```

```php
$mail = new Sealpost\Client(getenv('SEALPOST_KEY'), 'https://mail.yourdomain.com');

$r = $mail->send('magic_link_otp_verification', 'user@example.org', [
    'variables' => ['userName' => 'Ada', 'otpCode' => '482913', 'signInUrl' => 'https://app.example.com/in'],
    'idempotencyKey' => 'signup-42',
    'tags' => [['name' => 'campaign', 'value' => 'welcome']],
]);
if ($r->error && $r->error->code === 'preflight_blocked') {
    // nothing was sent: $r->error->preflight['checks']
} elseif ($r->ok()) {
    echo $r->data['id'];
}
```

Results are `Sealpost\Result` objects (`data` / `error`); nothing throws unless you call `unwrap()`.

### Verifying webhooks

```php
[$ok, $reason] = Sealpost\Webhooks::verify($secret, file_get_contents('php://input'), $_SERVER['HTTP_SEALPOST_SIGNATURE'] ?? null);
```

Run the tests with `php tests/run.php`. MIT.

> This SDK has not been run against a PHP runtime by its author yet; the CI job runs `tests/run.php`.
