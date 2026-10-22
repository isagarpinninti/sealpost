package sealpost

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"strconv"
	"strings"
	"time"
)

// SignatureHeader is the HTTP header carrying the webhook signature.
const SignatureHeader = "Sealpost-Signature"

// DefaultTolerance is how far a signature timestamp may differ from now.
const DefaultTolerance = 5 * time.Minute

// Webhook verification failures.
var (
	ErrSignatureMalformed = errors.New("sealpost: malformed signature header")
	ErrSignatureStale     = errors.New("sealpost: signature timestamp outside tolerance")
	ErrSignatureMismatch  = errors.New("sealpost: signature mismatch")
)

func mac(secret string, t int64, body []byte) string {
	h := hmac.New(sha256.New, []byte(secret))
	h.Write([]byte(strconv.FormatInt(t, 10)))
	h.Write([]byte("."))
	h.Write(body)
	return hex.EncodeToString(h.Sum(nil))
}

// VerifyWebhook checks a Sealpost-Signature header against the RAW request body (read it with io.ReadAll
// before decoding any JSON). tolerance of 0 means DefaultTolerance; now of the zero time means time.Now().
func VerifyWebhook(secret string, body []byte, header string, tolerance time.Duration, now time.Time) error {
	var t int64
	var v1 string
	haveT := false
	for _, part := range strings.Split(header, ",") {
		k, v, ok := strings.Cut(strings.TrimSpace(part), "=")
		if !ok {
			continue
		}
		switch k {
		case "t":
			n, err := strconv.ParseInt(v, 10, 64)
			if err != nil {
				return ErrSignatureMalformed
			}
			t, haveT = n, true
		case "v1":
			v1 = v
		}
	}
	if !haveT || len(v1) != 64 {
		return ErrSignatureMalformed
	}
	if tolerance == 0 {
		tolerance = DefaultTolerance
	}
	if now.IsZero() {
		now = time.Now()
	}
	if d := now.Sub(time.Unix(t, 0)); d > tolerance || -d > tolerance {
		return ErrSignatureStale
	}
	if !hmac.Equal([]byte(mac(secret, t, body)), []byte(v1)) {
		return ErrSignatureMismatch
	}
	return nil
}

// SignWebhook builds a signature header; useful for testing your own handler.
func SignWebhook(secret string, body []byte, at time.Time) string {
	t := at.Unix()
	return "t=" + strconv.FormatInt(t, 10) + ",v1=" + mac(secret, t, body)
}
