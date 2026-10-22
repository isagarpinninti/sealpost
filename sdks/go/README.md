# Sealpost for Go

Zero-dependency Go client for the self-hosted [Sealpost](https://github.com/isagarpinninti/sealpost) email API. Standard library only, Go 1.20+.

```bash
go get github.com/isagarpinninti/sealpost/sdks/go
```

```go
client := sealpost.New(os.Getenv("SEALPOST_KEY"), sealpost.WithBaseURL("https://mail.yourdomain.com"))

res, err := client.Emails.Send(ctx, sealpost.SendParams{
	Template:  "magic_link_otp_verification",
	To:        []string{"user@example.org"},
	Variables: map[string]any{"userName": "Ada", "otpCode": "482913", "signInUrl": "https://app.example.com/in"},
})
if sealpost.IsPreflightBlocked(err) {
	var apiErr *sealpost.Error
	errors.As(err, &apiErr) // apiErr.Preflight.Checks: nothing was sent
} else if err == nil {
	fmt.Println(res.MessageID, res.Receipt.Token)
}
```

Also `Emails.Batch`, `Audiences.*`, `Broadcasts.*`, `Domains.List/Check`, `Suppressions.*`, `Stats`.

### Verifying webhooks

```go
body, _ := io.ReadAll(r.Body) // the raw body, before decoding JSON
if err := sealpost.VerifyWebhook(secret, body, r.Header.Get(sealpost.SignatureHeader), 0, time.Time{}); err != nil {
	http.Error(w, "bad signature", http.StatusUnauthorized)
	return
}
```

Run the tests with `go test ./...`. MIT.
