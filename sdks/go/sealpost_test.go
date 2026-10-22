package sealpost

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestSendMapsBodyAndResult(t *testing.T) {
	var got map[string]any
	var auth string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		auth = r.Header.Get("Authorization")
		b, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(b, &got)
		w.WriteHeader(201)
		_, _ = w.Write([]byte(`{"ok":true,"status":"delivered","messageId":"<m@x>","receipt":{"token":"evw_abc","receiptId":"evw_1"}}`))
	}))
	defer srv.Close()
	c := New("evk_t", WithBaseURL(srv.URL))
	res, err := c.Emails.Send(context.Background(), SendParams{Template: "t", To: []string{"a@b.co"}, Domain: "d.io", AutoFill: true})
	if err != nil {
		t.Fatal(err)
	}
	if res.Status != "delivered" || res.Receipt.Token != "evw_abc" || auth != "Bearer evk_t" {
		t.Fatalf("unexpected result %+v auth=%s", res, auth)
	}
	if got["templateId"] != "t" || got["domain"] != "d.io" || got["autoFill"] != true {
		t.Fatalf("unexpected body %v", got)
	}
}

func TestBlockedSendIsATypedError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(403)
		_, _ = w.Write([]byte(`{"ok":false,"error":"Blocked","code":"preflight_blocked","preflight":{"gate":"BLOCKED","score":40}}`))
	}))
	defer srv.Close()
	_, err := New("k", WithBaseURL(srv.URL)).Emails.Send(context.Background(), SendParams{Template: "t", To: []string{"a@b.co"}})
	var apiErr *Error
	if !errors.As(err, &apiErr) || apiErr.Status != 403 || apiErr.Preflight == nil || apiErr.Preflight.Gate != "BLOCKED" || !IsPreflightBlocked(err) {
		t.Fatalf("expected a preflight_blocked *Error, got %v", err)
	}
}

func TestNetworkFailureHasStatusZero(t *testing.T) {
	_, err := New("k", WithBaseURL("http://127.0.0.1:1")).Stats(context.Background())
	var apiErr *Error
	if !errors.As(err, &apiErr) || apiErr.Status != 0 {
		t.Fatalf("expected status 0, got %v", err)
	}
}

func TestBroadcastsAndAudiences(t *testing.T) {
	var paths []string
	var last map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		paths = append(paths, r.Method+" "+r.URL.RequestURI())
		b, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(b, &last)
		_, _ = w.Write([]byte(`{"ok":true,"broadcast":{"id":"brd_1","status":"scheduled"},"audience":{"id":"aud_1"},"added":1,"total":1}`))
	}))
	defer srv.Close()
	c := New("k", WithBaseURL(srv.URL))
	ctx := context.Background()
	a, err := c.Audiences.Create(ctx, "L")
	if err != nil || a.ID != "aud_1" {
		t.Fatalf("create audience: %v %+v", err, a)
	}
	if _, err := c.Audiences.AddContacts(ctx, "aud_1", []Contact{{Email: "a@b.co", Name: "A"}}); err != nil {
		t.Fatal(err)
	}
	b, err := c.Broadcasts.Create(ctx, BroadcastParams{Name: "n", AudienceID: "aud_1", Template: "t", ScheduledAt: time.Date(2030, 1, 1, 0, 0, 0, 0, time.UTC), RatePerMinute: 120})
	if err != nil || b.ID != "brd_1" {
		t.Fatalf("create broadcast: %v %+v", err, b)
	}
	if last["scheduledAtIso"] != "2030-01-01T00:00:00Z" || last["ratePerMinute"] != float64(120) {
		t.Fatalf("unexpected broadcast body %v", last)
	}
	_ = c.Suppressions.Remove(ctx, "a+b@x.io")
	if paths[len(paths)-1] != "DELETE /api/suppressions?email=a%2Bb%40x.io" {
		t.Fatalf("unexpected path %s", paths[len(paths)-1])
	}
}

func TestWebhookVerification(t *testing.T) {
	body := []byte(`{"id":"evt_1","type":"email.delivered"}`)
	at := time.Unix(1_700_000_000, 0)
	header := SignWebhook("whsec", body, at)
	if err := VerifyWebhook("whsec", body, header, 0, at.Add(5*time.Second)); err != nil {
		t.Fatal(err)
	}
	if err := VerifyWebhook("whsec", append(body, ' '), header, 0, at); !errors.Is(err, ErrSignatureMismatch) {
		t.Fatalf("want mismatch, got %v", err)
	}
	if err := VerifyWebhook("whsec", body, header, 0, at.Add(time.Hour)); !errors.Is(err, ErrSignatureStale) {
		t.Fatalf("want stale, got %v", err)
	}
	if err := VerifyWebhook("whsec", body, "nonsense", 0, at); !errors.Is(err, ErrSignatureMalformed) {
		t.Fatalf("want malformed, got %v", err)
	}
}

func TestIdempotencyHeaderAndReplayFlag(t *testing.T) {
	var key string
	var got map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		key = r.Header.Get("Idempotency-Key")
		b, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(b, &got)
		w.Header().Set("Idempotent-Replayed", "true")
		w.WriteHeader(201)
		_, _ = w.Write([]byte(`{"ok":true,"id":"em_1","status":"delivered"}`))
	}))
	defer srv.Close()
	res, err := New("k", WithBaseURL(srv.URL)).Emails.Send(context.Background(), SendParams{Template: "t", To: []string{"a@b.co"}, IdempotencyKey: "order-1", Tags: []Tag{{Name: "c", Value: "v"}}, Metadata: map[string]string{"u": "1"}})
	if err != nil {
		t.Fatal(err)
	}
	if key != "order-1" || res.ID != "em_1" || !res.Replayed {
		t.Fatalf("key=%q res=%+v", key, res)
	}
	if got["tags"] == nil || got["metadata"] == nil {
		t.Fatalf("tags and metadata missing from body: %v", got)
	}
}

func TestListAndRequestID(t *testing.T) {
	var uri string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		uri = r.URL.RequestURI()
		if r.URL.Path == "/api/emails/em_9" {
			w.Header().Set("X-Request-Id", "req_hdr")
			w.WriteHeader(404)
			_, _ = w.Write([]byte(`{"ok":false,"error":"No such email","code":"not_found"}`))
			return
		}
		_, _ = w.Write([]byte(`{"ok":true,"data":[{"id":"em_1","status":"bounced"}],"hasMore":true,"nextCursor":"em_1"}`))
	}))
	defer srv.Close()
	c := New("k", WithBaseURL(srv.URL))
	page, err := c.Emails.List(context.Background(), ListParams{Status: "bounced", Tag: "campaign:welcome", Limit: 5, Before: "em_9"})
	if err != nil || !page.HasMore || page.NextCursor != "em_1" || page.Data[0].Status != "bounced" {
		t.Fatalf("list: %v %+v", err, page)
	}
	if uri != "/api/emails?before=em_9&limit=5&status=bounced&tag=campaign%3Awelcome" {
		t.Fatalf("unexpected uri %s", uri)
	}
	_, err = c.Emails.Get(context.Background(), "em_9")
	var apiErr *Error
	if !errors.As(err, &apiErr) || apiErr.Code != "not_found" || apiErr.RequestID != "req_hdr" {
		t.Fatalf("expected not_found with request id, got %v", err)
	}
}

func TestInboundListGetAndDownload(t *testing.T) {
	var uris []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		uris = append(uris, r.URL.RequestURI())
		switch {
		case r.URL.Path == "/api/inbound/in_1/attachments/0":
			w.Header().Set("Content-Type", "image/png")
			w.Header().Set("Content-Disposition", "attachment; filename=\"plan.png\"; filename*=UTF-8''%E2%82%AC%20plan.png")
			_, _ = w.Write([]byte{0x89, 'P', 'N', 'G', 0x00, 0xff})
		case r.URL.Path == "/api/inbound/in_1":
			_, _ = w.Write([]byte(`{"ok":true,"id":"in_1","subject":"hi","text":"body","kind":"message","dkim":{"result":"pass"}}`))
		case r.URL.Path == "/api/inbound/in_x":
			w.WriteHeader(404)
			_, _ = w.Write([]byte(`{"ok":false,"error":"No such received message","code":"not_found","requestId":"req_z"}`))
		default:
			_, _ = w.Write([]byte(`{"ok":true,"data":[{"id":"in_1","kind":"bounce"}],"hasMore":true,"nextCursor":"in_1"}`))
		}
	}))
	defer srv.Close()
	c := New("k", WithBaseURL(srv.URL))
	ctx := context.Background()
	page, err := c.Inbound.List(ctx, ListInboundParams{Kind: "bounce", Q: "refund", Limit: 3})
	if err != nil || !page.HasMore || page.Data[0].Kind != "bounce" || uris[0] != "/api/inbound?kind=bounce&limit=3&q=refund" {
		t.Fatalf("list: %v %+v %v", err, page, uris)
	}
	msg, err := c.Inbound.Get(ctx, "in_1")
	if err != nil || msg.Text != "body" || msg.DKIM.Result != "pass" {
		t.Fatalf("get: %v %+v", err, msg)
	}
	att, err := c.Inbound.Attachment(ctx, "in_1", 0)
	if err != nil || len(att.Bytes) != 6 || att.ContentType != "image/png" || att.Filename != "\u20ac plan.png" {
		t.Fatalf("attachment: %v %+v", err, att)
	}
	_, err = c.Inbound.Get(ctx, "in_x")
	var apiErr *Error
	if !errors.As(err, &apiErr) || apiErr.Code != "not_found" || apiErr.RequestID != "req_z" {
		t.Fatalf("expected not_found, got %v", err)
	}
}

func TestScheduleAndUnsubscribeLink(t *testing.T) {
	var got map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(b, &got)
		switch r.URL.Path {
		case "/api/unsubscribe-link":
			_, _ = w.Write([]byte(`{"ok":true,"url":"https://m.example.com/u/abc"}`))
		case "/api/scheduled":
			_, _ = w.Write([]byte(`{"ok":true,"scheduled":[{"id":"sch_1","status":"scheduled"}]}`))
		case "/api/scheduled/sch_1":
			_, _ = w.Write([]byte(`{"ok":true,"scheduled":{"id":"sch_1","status":"cancelled"}}`))
		default:
			w.WriteHeader(202)
			_, _ = w.Write([]byte(`{"ok":true,"status":"scheduled","id":"sch_1"}`))
		}
	}))
	defer srv.Close()
	c := New("k", WithBaseURL(srv.URL))
	ctx := context.Background()
	res, err := c.Emails.Send(ctx, SendParams{Template: "t", To: []string{"a@b.co"}, ScheduledAt: time.Date(2030, 1, 1, 0, 0, 0, 0, time.UTC)})
	if err != nil || res.Status != "scheduled" || res.ID != "sch_1" || got["scheduledAt"] != "2030-01-01T00:00:00Z" {
		t.Fatalf("send: %v %+v %v", err, res, got)
	}
	list, err := c.Scheduled.List(ctx)
	if err != nil || len(list) != 1 {
		t.Fatalf("list: %v %v", err, list)
	}
	cancelled, err := c.Scheduled.Cancel(ctx, "sch_1")
	if err != nil || cancelled.Status != "cancelled" {
		t.Fatalf("cancel: %v %+v", err, cancelled)
	}
	url, err := c.UnsubscribeLink(ctx, "a@b.co")
	if err != nil || url != "https://m.example.com/u/abc" {
		t.Fatalf("unsubscribe link: %v %s", err, url)
	}
}
