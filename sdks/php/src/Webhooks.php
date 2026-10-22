<?php
declare(strict_types=1);

namespace Sealpost;

/**
 * Verification of Sealpost outbound webhooks. The Sealpost-Signature header is "t=<unix seconds>,v1=<hex>" where
 * v1 = HMAC-SHA256(secret, "<t>.<raw body>"). Always verify against the raw body (file_get_contents('php://input')).
 */
final class Webhooks
{
    public const SIGNATURE_HEADER = 'Sealpost-Signature';

    /** @return array{0:bool,1:?string} [ok, reason] where reason is malformed, stale or mismatch */
    public static function verify(string $secret, string $rawBody, ?string $header, int $toleranceSeconds = 300, ?int $now = null): array
    {
        $parts = [];
        foreach (explode(',', (string) $header) as $piece) {
            $pos = strpos($piece, '=');
            if ($pos !== false) {
                $parts[trim(substr($piece, 0, $pos))] = trim(substr($piece, $pos + 1));
            }
        }
        $t = $parts['t'] ?? '';
        $v1 = $parts['v1'] ?? '';
        if (!ctype_digit($t) || !preg_match('/^[0-9a-f]{64}$/', $v1)) {
            return [false, 'malformed'];
        }
        if (abs(($now ?? time()) - (int) $t) > $toleranceSeconds) {
            return [false, 'stale'];
        }
        $expected = hash_hmac('sha256', $t . '.' . $rawBody, $secret);
        return hash_equals($expected, $v1) ? [true, null] : [false, 'mismatch'];
    }

    public static function sign(string $secret, string $rawBody, ?int $timestamp = null): string
    {
        $t = $timestamp ?? time();
        return 't=' . $t . ',v1=' . hash_hmac('sha256', $t . '.' . $rawBody, $secret);
    }
}
