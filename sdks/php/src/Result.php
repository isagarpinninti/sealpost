<?php
declare(strict_types=1);

namespace Sealpost;

/** Exactly one of $data and $error is set. Nothing throws unless you call unwrap(). */
final class Result
{
    /** @var mixed */
    public $data;
    public ?Error $error;
    /** @var array<string,string> Response headers, lower-cased. */
    public array $headers;

    /** @param mixed $data */
    public function __construct($data = null, ?Error $error = null, array $headers = [])
    {
        $this->data = $data;
        $this->error = $error;
        $this->headers = $headers;
    }

    public function ok(): bool
    {
        return $this->error === null;
    }

    /** True when the server replayed an earlier response for the same idempotency key. */
    public function replayed(): bool
    {
        return ($this->headers['idempotent-replayed'] ?? '') === 'true';
    }

    /** @return mixed */
    public function unwrap()
    {
        if ($this->error !== null) {
            throw new \RuntimeException((string) $this->error);
        }
        return $this->data;
    }
}
