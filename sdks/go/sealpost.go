// Package sealpost is a zero-dependency Go client for the self-hosted Sealpost email API.
//
//	client := sealpost.New("evk_...", sealpost.WithBaseURL("https://mail.example.com"))
//	res, err := client.Emails.Send(ctx, sealpost.SendParams{
//		Template:  "magic_link_otp_verification",
//		To:        []string{"user@example.org"},
//		Variables: map[string]any{"userName": "Ada", "otpCode": "482913", "signInUrl": "https://app.example.com/in"},
//	})
//	var apiErr *sealpost.Error
//	if errors.As(err, &apiErr) && apiErr.Code == "preflight_blocked" {
//		// nothing was sent; apiErr.Preflight has the gate result
//	}
package sealpost

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// Version is the SDK version.
const Version = "0.1.0"

// Error is returned for any non-2xx response and for network failures (Status == 0).
type Error struct {
	Status    int
	Code      string
	Message   string
	Preflight *Preflight
	// RequestID matches the server's x-request-id header; quote it when reporting a problem.
	RequestID string
}

func (e *Error) Error() string {
	if e.Code != "" {
		return fmt.Sprintf("sealpost: %s (%d, %s)", e.Message, e.Status, e.Code)
	}
	return fmt.Sprintf("sealpost: %s (%d)", e.Message, e.Status)
}

// PreflightCheck is one of EW-101 … EW-108.
type PreflightCheck struct {
	Code     string `json:"code"`
	Severity string `json:"severity"`
	Message  string `json:"message"`
}

// Preflight is the deliverability gate result.
type Preflight struct {
	Gate           string           `json:"gate"`
	Score          int              `json:"score"`
	Checks         []PreflightCheck `json:"checks"`
	IdempotencyKey string           `json:"idempotencyKey"`
}

// Attachment is a base64-encoded file.
type Attachment struct {
	Filename      string `json:"filename"`
	ContentType   string `json:"contentType"`
	ContentBase64 string `json:"contentBase64"`
}

// Tag is a label you can filter logs by.
type Tag struct {
	Name  string `json:"name"`
	Value string `json:"value"`
}

// SendParams describes one email.
type SendParams struct {
	Template    string
	Domain      string
	// ScheduledAt sends later (up to 90 days ahead). The gate runs now, so a bad request is refused immediately, and
	// again at that time. The result's Status is "scheduled" and ID is an sch_… id.
	ScheduledAt time.Time
	// InReplyTo sends this as a reply: a Message-ID, or the in_… id of a received message. Adds In-Reply-To and
	// References (signed by DKIM) so mail clients thread it.
	InReplyTo string
	// Tags are labels to filter logs by (up to 10).
	Tags []Tag
	// Metadata is your own key/value data, stored with the email record (up to 20 keys).
	Metadata map[string]string
	// IdempotencyKey is sent as the Idempotency-Key header. Retrying with the same key and body within 24 hours
	// returns the original result (SendResult.Replayed) instead of sending again.
	IdempotencyKey string
	To          []string
	Cc          []string
	Bcc         []string
	Variables   map[string]any
	AutoFill    bool
	Attachments []Attachment
}

func (p SendParams) body() map[string]any {
	b := map[string]any{"templateId": p.Template, "to": p.To}
	if p.Domain != "" {
		b["domain"] = p.Domain
	}
	if len(p.Cc) > 0 {
		b["cc"] = p.Cc
	}
	if len(p.Bcc) > 0 {
		b["bcc"] = p.Bcc
	}
	if p.Variables != nil {
		b["variables"] = p.Variables
	}
	if p.InReplyTo != "" {
		b["inReplyTo"] = p.InReplyTo
	}
	if !p.ScheduledAt.IsZero() {
		b["scheduledAt"] = p.ScheduledAt.UTC().Format(time.RFC3339)
	}
	if len(p.Tags) > 0 {
		b["tags"] = p.Tags
	}
	if len(p.Metadata) > 0 {
		b["metadata"] = p.Metadata
	}
	if p.AutoFill {
		b["autoFill"] = true
	}
	if len(p.Attachments) > 0 {
		b["attachments"] = p.Attachments
	}
	return b
}

// Receipt is the signed evw_ delivery receipt.
type Receipt struct {
	Token     string `json:"token"`
	ReceiptID string `json:"receiptId"`
}

// SendResult is the outcome of a send that was accepted (delivered or queued for retry).
type SendResult struct {
	// ID is the em_… id for Emails.Get.
	ID string `json:"id"`
	// Replayed is true when the response was replayed for an earlier request with the same idempotency key.
	Replayed  bool       `json:"-"`
	OK        bool       `json:"ok"`
	Status    string     `json:"status"`
	MessageID string     `json:"messageId"`
	QueueID   string     `json:"queueId"`
	Receipt   *Receipt   `json:"receipt"`
	Preflight *Preflight `json:"preflight"`
}

// BatchItem is the per-email result of a batch send.
type BatchItem struct {
	OK        bool       `json:"ok"`
	Status    string     `json:"status"`
	MessageID string     `json:"messageId"`
	ReceiptID string     `json:"receiptId"`
	QueueID   string     `json:"queueId"`
	Error     string     `json:"error"`
	Preflight *Preflight `json:"preflight"`
}

// BatchResult summarises a batch send.
type BatchResult struct {
	Accepted int         `json:"accepted"`
	Rejected int         `json:"rejected"`
	Results  []BatchItem `json:"results"`
}

// Contact is an audience member.
type Contact struct {
	Email     string         `json:"email"`
	Name      string         `json:"name,omitempty"`
	Variables map[string]any `json:"variables,omitempty"`
}

// Audience is a contact list summary.
type Audience struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	CreatedAt string `json:"createdAtIso"`
	Contacts  int    `json:"contacts"`
}

// AddContactsResult reports an import.
type AddContactsResult struct {
	Added    int `json:"added"`
	Updated  int `json:"updated"`
	Total    int `json:"total"`
	Rejected []struct {
		Email  string `json:"email"`
		Reason string `json:"reason"`
	} `json:"rejected"`
}

// BroadcastCounts are the live counters of a broadcast.
type BroadcastCounts struct {
	Total      int `json:"total"`
	Delivered  int `json:"delivered"`
	Queued     int `json:"queued"`
	Suppressed int `json:"suppressed"`
	Duplicate  int `json:"duplicate"`
	Blocked    int `json:"blocked"`
	Failed     int `json:"failed"`
}

// Broadcast is a scheduled or running send to an audience.
type Broadcast struct {
	ID            string          `json:"id"`
	Name          string          `json:"name"`
	AudienceID    string          `json:"audienceId"`
	TemplateID    string          `json:"templateId"`
	Domain        string          `json:"domain"`
	ScheduledAt   string          `json:"scheduledAtIso"`
	RatePerMinute int             `json:"ratePerMinute"`
	Status        string          `json:"status"`
	Cursor        int             `json:"cursor"`
	Counts        BroadcastCounts `json:"counts"`
}

// BroadcastParams creates a broadcast.
type BroadcastParams struct {
	Name          string
	AudienceID    string
	Template      string
	Domain        string
	Variables     map[string]any
	ScheduledAt   time.Time // zero = start immediately
	RatePerMinute int       // zero = server default (600)
}

// DNSRecord is a record to publish for a sending domain.
type DNSRecord struct {
	Purpose   string `json:"purpose"`
	Type      string `json:"type"`
	Name      string `json:"name"`
	FQDN      string `json:"fqdn"`
	Value     string `json:"value"`
	ZoneValue string `json:"zoneValue"`
	Note      string `json:"note"`
}

// Domain is a configured sending domain.
type Domain struct {
	Domain       string      `json:"domain"`
	FromEmail    string      `json:"fromEmail"`
	DKIMSelector string      `json:"dkimSelector"`
	Primary      bool        `json:"primary"`
	Records      []DNSRecord `json:"records"`
}

// DNSCheck is one live DNS verification result.
type DNSCheck struct {
	Purpose string   `json:"purpose"`
	FQDN    string   `json:"fqdn"`
	Status  string   `json:"status"`
	Detail  string   `json:"detail"`
	Found   []string `json:"found"`
}

// DomainCheck is the result of a live DNS check.
type DomainCheck struct {
	Domain  string     `json:"domain"`
	OK      bool       `json:"ok"`
	Results []DNSCheck `json:"results"`
}

// Stats are aggregate sending metrics.
type Stats struct {
	Sent        int     `json:"sent"`
	Queued      int     `json:"queued"`
	Suppressed  int     `json:"suppressed"`
	Opens       int     `json:"opens"`
	UniqueOpens int     `json:"uniqueOpens"`
	Clicks      int     `json:"clicks"`
	Bounces     int     `json:"bounces"`
	Complaints  int     `json:"complaints"`
	Delivered   int     `json:"delivered"`
	OpenRate    float64 `json:"openRate"`
	ClickRate   float64 `json:"clickRate"`
	BounceRate  float64 `json:"bounceRate"`
}

// Suppression is a blocked recipient.
type Suppression struct {
	Email  string `json:"email"`
	Reason string `json:"reason"`
	Detail string `json:"detail"`
	AtIso  string `json:"atIso"`
}

// Client talks to a Sealpost server.
type Client struct {
	apiKey  string
	baseURL string
	http    *http.Client

	Emails       *EmailsService
	Inbound      *InboundService
	Scheduled    *ScheduledService
	Audiences    *AudiencesService
	Broadcasts   *BroadcastsService
	Domains      *DomainsService
	Suppressions *SuppressionsService
}

// Option configures a Client.
type Option func(*Client)

// WithBaseURL sets the server URL (default http://127.0.0.1:4320).
func WithBaseURL(u string) Option { return func(c *Client) { c.baseURL = strings.TrimRight(u, "/") } }

// WithHTTPClient replaces the HTTP client (timeouts, proxies, tests).
func WithHTTPClient(h *http.Client) Option { return func(c *Client) { c.http = h } }

// New creates a client. It panics if apiKey is empty, like a programmer error.
func New(apiKey string, opts ...Option) *Client {
	if apiKey == "" {
		panic("sealpost: apiKey is required")
	}
	c := &Client{apiKey: apiKey, baseURL: "http://127.0.0.1:4320", http: &http.Client{Timeout: 30 * time.Second}}
	for _, o := range opts {
		o(c)
	}
	c.Emails = &EmailsService{c}
	c.Inbound = &InboundService{c}
	c.Scheduled = &ScheduledService{c}
	c.Audiences = &AudiencesService{c}
	c.Broadcasts = &BroadcastsService{c}
	c.Domains = &DomainsService{c}
	c.Suppressions = &SuppressionsService{c}
	return c
}

func (c *Client) do(ctx context.Context, method, path string, body any, out any) error {
	_, err := c.doH(ctx, method, path, body, out, nil)
	return err
}

func (c *Client) doH(ctx context.Context, method, path string, body any, out any, extra map[string]string) (http.Header, error) {
	var rd io.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			return nil, &Error{Message: err.Error()}
		}
		rd = bytes.NewReader(raw)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.baseURL+path, rd)
	if err != nil {
		return nil, &Error{Message: err.Error()}
	}
	req.Header.Set("Authorization", "Bearer "+c.apiKey)
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "sealpost-go/"+Version)
	for k, v := range extra {
		req.Header.Set(k, v)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	res, err := c.http.Do(req)
	if err != nil {
		return nil, &Error{Status: 0, Message: err.Error()}
	}
	defer res.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(res.Body, 32<<20))
	if err != nil {
		return res.Header, &Error{Status: res.StatusCode, Message: err.Error()}
	}
	if res.StatusCode < 200 || res.StatusCode > 299 {
		var e struct {
			Error     string     `json:"error"`
			Code      string     `json:"code"`
			RequestID string     `json:"requestId"`
			Preflight *Preflight `json:"preflight"`
		}
		_ = json.Unmarshal(raw, &e)
		msg := e.Error
		if msg == "" {
			msg = fmt.Sprintf("HTTP %d", res.StatusCode)
		}
		rid := e.RequestID
		if rid == "" {
			rid = res.Header.Get("X-Request-Id")
		}
		return res.Header, &Error{Status: res.StatusCode, Code: e.Code, Message: msg, Preflight: e.Preflight, RequestID: rid}
	}
	if out != nil && len(raw) > 0 {
		if err := json.Unmarshal(raw, out); err != nil {
			return res.Header, &Error{Status: res.StatusCode, Message: "invalid JSON in response: " + err.Error()}
		}
	}
	return res.Header, nil
}

func esc(s string) string { return url.PathEscape(s) }

// IsPreflightBlocked reports whether err is a send rejected by the deliverability gate (nothing was sent).
func IsPreflightBlocked(err error) bool {
	var e *Error
	return errors.As(err, &e) && e.Code == "preflight_blocked"
}

// Stats returns aggregate metrics.
func (c *Client) Stats(ctx context.Context) (*Stats, error) {
	var out Stats
	if err := c.do(ctx, http.MethodGet, "/api/stats", nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// EmailsService sends mail.
type EmailsService struct{ c *Client }

// Send sends one email. A gate rejection returns an *Error with Code "preflight_blocked".
func (s *EmailsService) Send(ctx context.Context, p SendParams) (*SendResult, error) {
	var out SendResult
	var extra map[string]string
	if p.IdempotencyKey != "" {
		extra = map[string]string{"Idempotency-Key": p.IdempotencyKey}
	}
	h, err := s.c.doH(ctx, http.MethodPost, "/api/send", p.body(), &out, extra)
	if err != nil {
		return nil, err
	}
	out.Replayed = h.Get("Idempotent-Replayed") == "true"
	return &out, nil
}

// EmailEvent is one entry of an email's timeline.
type EmailEvent struct {
	Type   string `json:"type"`
	AtIso  string `json:"atIso"`
	Detail string `json:"detail"`
	URL    string `json:"url"`
}

// EmailRecord is one email with its status timeline.
type EmailRecord struct {
	ID        string            `json:"id"`
	MessageID string            `json:"messageId"`
	CreatedAt string            `json:"createdAtIso"`
	From      string            `json:"from"`
	To        []string          `json:"to"`
	Subject   string            `json:"subject"`
	Template  string            `json:"templateId"`
	Domain    string            `json:"domain"`
	Tags      []Tag             `json:"tags"`
	Metadata  map[string]string `json:"metadata"`
	// Status is the latest of queued, delivered, failed, bounced, complained, deferred.
	Status    string       `json:"status"`
	Opens     int          `json:"opens"`
	Clicks    int          `json:"clicks"`
	// Replies counts received messages that answered this email.
	Replies   int          `json:"replies"`
	ReceiptID string       `json:"receiptId"`
	Events    []EmailEvent `json:"events"`
}

// ListParams filters Emails.List. Zero values are ignored.
type ListParams struct {
	Status   string
	To       string
	Template string
	Domain   string
	// Tag is "name" or "name:value".
	Tag    string
	Since  time.Time
	Until  time.Time
	Limit  int
	Before string
}

// EmailPage is one page of emails, newest first.
type EmailPage struct {
	Data       []EmailRecord `json:"data"`
	HasMore    bool          `json:"hasMore"`
	NextCursor string        `json:"nextCursor"`
}

// Get returns one email with its timeline.
func (s *EmailsService) Get(ctx context.Context, id string) (*EmailRecord, error) {
	var out EmailRecord
	if err := s.c.do(ctx, http.MethodGet, "/api/emails/"+esc(id), nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// List returns a page of emails. Page with ListParams.Before = page.NextCursor.
func (s *EmailsService) List(ctx context.Context, p ListParams) (*EmailPage, error) {
	q := url.Values{}
	set := func(k, v string) {
		if v != "" {
			q.Set(k, v)
		}
	}
	set("status", p.Status)
	set("to", p.To)
	set("template", p.Template)
	set("domain", p.Domain)
	set("tag", p.Tag)
	set("before", p.Before)
	if !p.Since.IsZero() {
		set("since", p.Since.UTC().Format(time.RFC3339))
	}
	if !p.Until.IsZero() {
		set("until", p.Until.UTC().Format(time.RFC3339))
	}
	if p.Limit > 0 {
		q.Set("limit", strconv.Itoa(p.Limit))
	}
	var out EmailPage
	if err := s.c.do(ctx, http.MethodGet, "/api/emails?"+q.Encode(), nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// Batch sends up to 100 emails; failures are reported per item.
func (s *EmailsService) Batch(ctx context.Context, items []SendParams) (*BatchResult, error) {
	emails := make([]map[string]any, 0, len(items))
	for _, it := range items {
		emails = append(emails, it.body())
	}
	var out BatchResult
	if err := s.c.do(ctx, http.MethodPost, "/api/send/batch", map[string]any{"emails": emails}, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// AudiencesService manages contact lists.
type AudiencesService struct{ c *Client }

// Create makes an empty audience.
func (s *AudiencesService) Create(ctx context.Context, name string) (*Audience, error) {
	var out struct {
		Audience Audience `json:"audience"`
	}
	if err := s.c.do(ctx, http.MethodPost, "/api/audiences", map[string]any{"name": name}, &out); err != nil {
		return nil, err
	}
	return &out.Audience, nil
}

// List returns every audience.
func (s *AudiencesService) List(ctx context.Context) ([]Audience, error) {
	var out struct {
		Audiences []Audience `json:"audiences"`
	}
	if err := s.c.do(ctx, http.MethodGet, "/api/audiences", nil, &out); err != nil {
		return nil, err
	}
	return out.Audiences, nil
}

// AddContacts adds or updates up to 10,000 contacts.
func (s *AudiencesService) AddContacts(ctx context.Context, audienceID string, contacts []Contact) (*AddContactsResult, error) {
	var out AddContactsResult
	if err := s.c.do(ctx, http.MethodPost, "/api/audiences/"+esc(audienceID)+"/contacts", map[string]any{"contacts": contacts}, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// RemoveContact removes one contact.
func (s *AudiencesService) RemoveContact(ctx context.Context, audienceID, email string) error {
	return s.c.do(ctx, http.MethodDelete, "/api/audiences/"+esc(audienceID)+"/contacts?email="+url.QueryEscape(email), nil, nil)
}

// Delete removes an audience.
func (s *AudiencesService) Delete(ctx context.Context, audienceID string) error {
	return s.c.do(ctx, http.MethodDelete, "/api/audiences/"+esc(audienceID), nil, nil)
}

// BroadcastsService schedules sends to audiences.
type BroadcastsService struct{ c *Client }

// Create schedules a broadcast.
func (s *BroadcastsService) Create(ctx context.Context, p BroadcastParams) (*Broadcast, error) {
	body := map[string]any{"name": p.Name, "audienceId": p.AudienceID, "templateId": p.Template}
	if p.Domain != "" {
		body["domain"] = p.Domain
	}
	if p.Variables != nil {
		body["variables"] = p.Variables
	}
	if !p.ScheduledAt.IsZero() {
		body["scheduledAtIso"] = p.ScheduledAt.UTC().Format(time.RFC3339)
	}
	if p.RatePerMinute > 0 {
		body["ratePerMinute"] = p.RatePerMinute
	}
	var out struct {
		Broadcast Broadcast `json:"broadcast"`
	}
	if err := s.c.do(ctx, http.MethodPost, "/api/broadcasts", body, &out); err != nil {
		return nil, err
	}
	return &out.Broadcast, nil
}

// Get returns a broadcast with live counters.
func (s *BroadcastsService) Get(ctx context.Context, id string) (*Broadcast, error) {
	var out Broadcast
	if err := s.c.do(ctx, http.MethodGet, "/api/broadcasts/"+esc(id), nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// List returns every broadcast, newest first.
func (s *BroadcastsService) List(ctx context.Context) ([]Broadcast, error) {
	var out struct {
		Broadcasts []Broadcast `json:"broadcasts"`
	}
	if err := s.c.do(ctx, http.MethodGet, "/api/broadcasts", nil, &out); err != nil {
		return nil, err
	}
	return out.Broadcasts, nil
}

// Cancel stops a scheduled or running broadcast.
func (s *BroadcastsService) Cancel(ctx context.Context, id string) (*Broadcast, error) {
	var out struct {
		Broadcast Broadcast `json:"broadcast"`
	}
	if err := s.c.do(ctx, http.MethodPost, "/api/broadcasts/"+esc(id)+"/cancel", map[string]any{}, &out); err != nil {
		return nil, err
	}
	return &out.Broadcast, nil
}

// DomainsService manages sending domains.
type DomainsService struct{ c *Client }

// List returns the configured sending domains with their DNS records.
func (s *DomainsService) List(ctx context.Context) ([]Domain, error) {
	var out struct {
		Domains []Domain `json:"domains"`
	}
	if err := s.c.do(ctx, http.MethodGet, "/api/domains", nil, &out); err != nil {
		return nil, err
	}
	return out.Domains, nil
}

// Check performs a live DNS lookup of SPF, DKIM and DMARC.
func (s *DomainsService) Check(ctx context.Context, domain string) (*DomainCheck, error) {
	var out DomainCheck
	if err := s.c.do(ctx, http.MethodGet, "/api/domains/"+esc(domain)+"/check", nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// SuppressionsService manages blocked recipients.
type SuppressionsService struct{ c *Client }

// List returns the suppression list.
func (s *SuppressionsService) List(ctx context.Context) ([]Suppression, error) {
	var out struct {
		Suppressions []Suppression `json:"suppressions"`
	}
	if err := s.c.do(ctx, http.MethodGet, "/api/suppressions", nil, &out); err != nil {
		return nil, err
	}
	return out.Suppressions, nil
}

// Add suppresses an address. reason is hard_bounce, unsubscribed or complaint.
func (s *SuppressionsService) Add(ctx context.Context, email, reason string) error {
	return s.c.do(ctx, http.MethodPost, "/api/suppressions", map[string]any{"email": email, "reason": reason}, nil)
}

// Remove un-suppresses an address.
func (s *SuppressionsService) Remove(ctx context.Context, email string) error {
	return s.c.do(ctx, http.MethodDelete, "/api/suppressions?email="+url.QueryEscape(email), nil, nil)
}

// InboundAddress is a parsed address.
type InboundAddress struct {
	Name    string `json:"name"`
	Address string `json:"address"`
}

// InboundAttachment describes one attachment of a received message.
type InboundAttachment struct {
	Index       int    `json:"index"`
	Filename    string `json:"filename"`
	ContentType string `json:"contentType"`
	Disposition string `json:"disposition"`
	ContentID   string `json:"contentId"`
	Size        int    `json:"size"`
}

// InboundRecord is a received message. Bounce and complaint reports are only acted on when they match mail this
// server sent (ReportVerified).
type InboundRecord struct {
	ID         string              `json:"id"`
	ReceivedAt string              `json:"receivedAtIso"`
	Source     string              `json:"source"`
	From       *InboundAddress     `json:"from"`
	To         []InboundAddress    `json:"to"`
	Cc         []InboundAddress    `json:"cc"`
	Subject    string              `json:"subject"`
	MessageID  string              `json:"messageId"`
	InReplyTo  string              `json:"inReplyTo"`
	References []string            `json:"references"`
	Snippet    string              `json:"snippet"`
	HasText    bool                `json:"hasText"`
	HasHTML    bool                `json:"hasHtml"`
	Attachments []InboundAttachment `json:"attachments"`
	Size       int                 `json:"size"`
	// Kind is message, bounce or complaint.
	Kind string `json:"kind"`
	// AutoReply marks an out-of-office or other automatic reply: do not answer it.
	AutoReply bool `json:"autoReply"`
	// ThreadEmailID is the em_… email this answers or reports on.
	ThreadEmailID  string `json:"threadEmailId"`
	ReportVerified bool   `json:"reportVerified"`
	DKIM           struct {
		Result string `json:"result"`
		Domain string `json:"domain"`
		Detail string `json:"detail"`
	} `json:"dkim"`
}

// InboundMessage adds the decoded bodies. HTML is untrusted: show it only in a sandboxed frame with remote
// content blocked.
type InboundMessage struct {
	InboundRecord
	Text    string `json:"text"`
	HTML    string `json:"html"`
	Headers []struct {
		Name  string `json:"name"`
		Value string `json:"value"`
	} `json:"headers"`
}

// InboundPage is one page of received mail, newest first.
type InboundPage struct {
	Data       []InboundRecord `json:"data"`
	HasMore    bool            `json:"hasMore"`
	NextCursor string          `json:"nextCursor"`
}

// ListInboundParams filters Inbound.List. Zero values are ignored.
type ListInboundParams struct {
	From   string
	To     string
	Q      string
	Kind   string
	Since  time.Time
	Until  time.Time
	Limit  int
	Before string
}

// InboundService reads received mail.
type InboundService struct{ c *Client }

// List returns a page of received mail. Page with ListInboundParams.Before = page.NextCursor.
func (s *InboundService) List(ctx context.Context, p ListInboundParams) (*InboundPage, error) {
	q := url.Values{}
	set := func(k, v string) {
		if v != "" {
			q.Set(k, v)
		}
	}
	set("from", p.From)
	set("to", p.To)
	set("q", p.Q)
	set("kind", p.Kind)
	set("before", p.Before)
	if !p.Since.IsZero() {
		set("since", p.Since.UTC().Format(time.RFC3339))
	}
	if !p.Until.IsZero() {
		set("until", p.Until.UTC().Format(time.RFC3339))
	}
	if p.Limit > 0 {
		q.Set("limit", strconv.Itoa(p.Limit))
	}
	var out InboundPage
	if err := s.c.do(ctx, http.MethodGet, "/api/inbound?"+q.Encode(), nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// Get returns one message with its decoded text, html and headers.
func (s *InboundService) Get(ctx context.Context, id string) (*InboundMessage, error) {
	var out InboundMessage
	if err := s.c.do(ctx, http.MethodGet, "/api/inbound/"+esc(id), nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// Delete removes a received message.
func (s *InboundService) Delete(ctx context.Context, id string) error {
	return s.c.do(ctx, http.MethodDelete, "/api/inbound/"+esc(id), nil, nil)
}

// Download is a file fetched from the server.
type Download struct {
	Bytes       []byte
	ContentType string
	Filename    string
}

func (s *InboundService) download(ctx context.Context, path string) (*Download, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, s.c.baseURL+path, nil)
	if err != nil {
		return nil, &Error{Message: err.Error()}
	}
	req.Header.Set("Authorization", "Bearer "+s.c.apiKey)
	req.Header.Set("User-Agent", "sealpost-go/"+Version)
	res, err := s.c.http.Do(req)
	if err != nil {
		return nil, &Error{Status: 0, Message: err.Error()}
	}
	defer res.Body.Close()
	data, err := io.ReadAll(io.LimitReader(res.Body, 128<<20))
	if err != nil {
		return nil, &Error{Status: res.StatusCode, Message: err.Error()}
	}
	if res.StatusCode < 200 || res.StatusCode > 299 {
		var e struct {
			Error     string `json:"error"`
			Code      string `json:"code"`
			RequestID string `json:"requestId"`
		}
		_ = json.Unmarshal(data, &e)
		msg := e.Error
		if msg == "" {
			msg = fmt.Sprintf("HTTP %d", res.StatusCode)
		}
		rid := e.RequestID
		if rid == "" {
			rid = res.Header.Get("X-Request-Id")
		}
		return nil, &Error{Status: res.StatusCode, Code: e.Code, Message: msg, RequestID: rid}
	}
	name := ""
	if _, after, ok := strings.Cut(res.Header.Get("Content-Disposition"), "filename*=UTF-8''"); ok {
		enc, _, _ := strings.Cut(after, ";")
		if dec, err := url.PathUnescape(enc); err == nil {
			name = dec
		}
	}
	return &Download{Bytes: data, ContentType: res.Header.Get("Content-Type"), Filename: name}, nil
}

// Raw returns the original message bytes as received.
func (s *InboundService) Raw(ctx context.Context, id string) (*Download, error) {
	return s.download(ctx, "/api/inbound/"+esc(id)+"/raw")
}

// Attachment returns one attachment (InboundAttachment.Index).
func (s *InboundService) Attachment(ctx context.Context, id string, index int) (*Download, error) {
	return s.download(ctx, "/api/inbound/"+esc(id)+"/attachments/"+strconv.Itoa(index))
}

// ScheduledSend is a send waiting for its time.
type ScheduledSend struct {
	ID          string `json:"id"`
	ScheduledAt string `json:"scheduledAtIso"`
	CreatedAt   string `json:"createdAtIso"`
	// Status is scheduled, sending, sent, cancelled or failed.
	Status string `json:"status"`
}

// ScheduledService manages sends scheduled for later.
type ScheduledService struct{ c *Client }

// List returns scheduled sends, newest first.
func (s *ScheduledService) List(ctx context.Context) ([]ScheduledSend, error) {
	var out struct {
		Scheduled []ScheduledSend `json:"scheduled"`
	}
	if err := s.c.do(ctx, http.MethodGet, "/api/scheduled", nil, &out); err != nil {
		return nil, err
	}
	return out.Scheduled, nil
}

// Cancel stops a scheduled send that has not run yet.
func (s *ScheduledService) Cancel(ctx context.Context, id string) (*ScheduledSend, error) {
	var out struct {
		Scheduled ScheduledSend `json:"scheduled"`
	}
	if err := s.c.do(ctx, http.MethodDelete, "/api/scheduled/"+esc(id), nil, &out); err != nil {
		return nil, err
	}
	return &out.Scheduled, nil
}

// UnsubscribeLink returns a hosted one-click unsubscribe URL for an address (the server needs unsubscribe.hosted
// and a trackingBaseUrl).
func (c *Client) UnsubscribeLink(ctx context.Context, email string) (string, error) {
	var out struct {
		URL string `json:"url"`
	}
	if err := c.do(ctx, http.MethodPost, "/api/unsubscribe-link", map[string]any{"email": email}, &out); err != nil {
		return "", err
	}
	return out.URL, nil
}
