<?php
declare(strict_types=1);

namespace Sealpost;

/**
 * Client for the Sealpost REST API (PHP 7.4+, ext-curl, no other dependencies).
 *
 *   $mail = new \Sealpost\Client(getenv('SEALPOST_KEY'), 'https://mail.example.com');
 *   $r = $mail->send('magic_link_otp_verification', 'user@example.org', ['variables' => ['userName' => 'Ada', 'otpCode' => '482913', 'signInUrl' => 'https://app.example.com/in']]);
 *   if ($r->error && $r->error->code === 'preflight_blocked') { /* nothing was sent: $r->error->preflight *\/ }
 */
final class Client
{
    private string $key;
    private string $base;
    private int $timeout;

    public function __construct(string $apiKey, string $baseUrl = 'http://127.0.0.1:4320', int $timeoutSeconds = 30)
    {
        if ($apiKey === '') {
            throw new \InvalidArgumentException('Sealpost: apiKey is required');
        }
        $this->key = $apiKey;
        $this->base = rtrim($baseUrl, '/');
        $this->timeout = $timeoutSeconds;
    }

    /**
     * Send one email. Options: variables, domain, cc, bcc, autoFill, attachments, tags, metadata, inReplyTo,
     * scheduledAt (ISO 8601 string or DateTimeInterface; up to 90 days ahead), idempotencyKey.
     */
    public function send(string $template, $to, array $options = []): Result
    {
        $headers = [];
        if (isset($options['idempotencyKey'])) {
            $headers[] = 'Idempotency-Key: ' . $options['idempotencyKey'];
            unset($options['idempotencyKey']);
        }
        return $this->request('POST', '/api/send', $this->body($template, $to, $options), null, $headers);
    }

    /** Up to 100 items, each ['template' => ..., 'to' => ..., ...options]. Failures are reported per item. */
    public function batch(array $items): Result
    {
        $emails = [];
        foreach ($items as $item) {
            $template = (string) ($item['template'] ?? '');
            $to = $item['to'] ?? [];
            unset($item['template'], $item['to']);
            $emails[] = $this->body($template, $to, $item);
        }
        return $this->request('POST', '/api/send/batch', ['emails' => $emails]);
    }

    public function preview(string $template, $to = [], array $options = []): Result
    {
        return $this->request('POST', '/api/compile', $this->body($template, $to, $options));
    }

    public function getEmail(string $id): Result
    {
        return $this->request('GET', '/api/emails/' . rawurlencode($id));
    }

    /** Filters: status, to, template, domain, tag, since, until, limit, before. Newest first. */
    public function listEmails(array $filters = []): Result
    {
        return $this->request('GET', '/api/emails' . $this->query($filters));
    }

    /** Received mail. Filters: from, to, q, kind, since, until, limit, before. */
    public function listInbound(array $filters = []): Result
    {
        return $this->request('GET', '/api/inbound' . $this->query($filters));
    }

    public function getInbound(string $id): Result
    {
        return $this->request('GET', '/api/inbound/' . rawurlencode($id));
    }

    public function createAudience(string $name): Result
    {
        return $this->request('POST', '/api/audiences', ['name' => $name], fn ($j) => $j['audience'] ?? null);
    }

    /** contacts: [['email' => ..., 'name' => ..., 'variables' => [...]]], up to 10,000 per call. */
    public function addContacts(string $audienceId, array $contacts): Result
    {
        return $this->request('POST', '/api/audiences/' . rawurlencode($audienceId) . '/contacts', ['contacts' => $contacts]);
    }

    /** Options: domain, variables, scheduledAtIso, ratePerMinute. */
    public function createBroadcast(string $name, string $audienceId, string $template, array $options = []): Result
    {
        $body = array_merge(['name' => $name, 'audienceId' => $audienceId, 'templateId' => $template], $options);
        return $this->request('POST', '/api/broadcasts', $body, fn ($j) => $j['broadcast'] ?? null);
    }

    public function listScheduled(): Result
    {
        return $this->request('GET', '/api/scheduled', null, fn ($j) => $j['scheduled'] ?? []);
    }

    public function cancelScheduled(string $id): Result
    {
        return $this->request('DELETE', '/api/scheduled/' . rawurlencode($id), null, fn ($j) => $j['scheduled'] ?? null);
    }

    public function addSuppression(string $email, string $reason = 'unsubscribed'): Result
    {
        return $this->request('POST', '/api/suppressions', ['email' => $email, 'reason' => $reason]);
    }

    public function removeSuppression(string $email): Result
    {
        return $this->request('DELETE', '/api/suppressions?email=' . rawurlencode($email));
    }

    public function stats(): Result
    {
        return $this->request('GET', '/api/stats');
    }

    /** A hosted one-click unsubscribe URL (needs unsubscribe.hosted and a trackingBaseUrl on the server). */
    public function unsubscribeLink(string $email): Result
    {
        return $this->request('POST', '/api/unsubscribe-link', ['email' => $email], fn ($j) => $j['url'] ?? null);
    }

    private function body(string $template, $to, array $options): array
    {
        $body = ['templateId' => $template, 'to' => $to];
        foreach ($options as $k => $v) {
            if ($v === null) {
                continue;
            }
            if ($k === 'scheduledAt' && $v instanceof \DateTimeInterface) {
                $v = (new \DateTimeImmutable('@' . $v->getTimestamp()))->format('Y-m-d\TH:i:s\Z');
            }
            $body[$k] = $v;
        }
        return $body;
    }

    private function query(array $filters): string
    {
        $pairs = array_filter($filters, fn ($v) => $v !== null);
        return $pairs ? '?' . http_build_query($pairs, '', '&', PHP_QUERY_RFC3986) : '';
    }

    /**
     * @param ?callable $pick extracts the data from the decoded body
     * @param string[] $extraHeaders
     */
    private function request(string $method, string $path, ?array $body = null, ?callable $pick = null, array $extraHeaders = []): Result
    {
        $ch = curl_init($this->base . $path);
        $headers = array_merge(['Authorization: Bearer ' . $this->key, 'Accept: application/json', 'User-Agent: sealpost-php/0.1.0'], $extraHeaders);
        $responseHeaders = [];
        curl_setopt_array($ch, [
            CURLOPT_CUSTOMREQUEST => $method,
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT => $this->timeout,
            CURLOPT_FOLLOWLOCATION => false,
            CURLOPT_HEADERFUNCTION => static function ($c, string $line) use (&$responseHeaders): int {
                $pos = strpos($line, ':');
                if ($pos !== false) {
                    $responseHeaders[strtolower(trim(substr($line, 0, $pos)))] = trim(substr($line, $pos + 1));
                }
                return strlen($line);
            },
        ]);
        if ($body !== null) {
            $headers[] = 'Content-Type: application/json';
            curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode($body, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE));
        }
        curl_setopt($ch, CURLOPT_HTTPHEADER, $headers);
        $raw = curl_exec($ch);
        if ($raw === false) {
            $message = curl_error($ch) ?: 'Network error';
            curl_close($ch);
            return new Result(null, new Error(0, $message));
        }
        $status = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
        curl_close($ch);
        $decoded = json_decode((string) $raw, true);
        $parsed = is_array($decoded) ? $decoded : [];
        if ($status < 200 || $status > 299) {
            return new Result(null, new Error($status, (string) ($parsed['error'] ?? 'HTTP ' . $status), $parsed['code'] ?? null, $parsed['preflight'] ?? null, $parsed['requestId'] ?? ($responseHeaders['x-request-id'] ?? null)), $responseHeaders);
        }
        return new Result($pick ? $pick($parsed) : $parsed, null, $responseHeaders);
    }
}
