<?php
declare(strict_types=1);

namespace Sealpost;

final class Error
{
    /** HTTP status, or 0 for a network failure or timeout. */
    public int $status;
    public string $message;
    /** e.g. "preflight_blocked", "smtp_failed", "idempotency_key_reuse". */
    public ?string $code;
    /** The gate result when code is "preflight_blocked": nothing was sent. */
    public ?array $preflight;
    public ?string $requestId;

    public function __construct(int $status, string $message, ?string $code = null, ?array $preflight = null, ?string $requestId = null)
    {
        $this->status = $status;
        $this->message = $message;
        $this->code = $code;
        $this->preflight = $preflight;
        $this->requestId = $requestId;
    }

    public function __toString(): string
    {
        return $this->message . ' (' . $this->status . ')' . ($this->code ? ' [' . $this->code . ']' : '');
    }
}
