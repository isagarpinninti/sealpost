<?php
declare(strict_types=1);

// Dependency-free tests: php tests/run.php
require __DIR__ . '/../src/Result.php';
require __DIR__ . '/../src/Error.php';
require __DIR__ . '/../src/Webhooks.php';
require __DIR__ . '/../src/Client.php';

use Sealpost\Client;
use Sealpost\Webhooks;

$failures = 0;
function check(string $name, bool $ok, string $detail = ''): void
{
    global $failures;
    echo ($ok ? 'ok   ' : 'FAIL ') . $name . ($ok ? '' : ' ' . $detail) . "\n";
    if (!$ok) {
        $failures++;
    }
}

$port = random_int(20000, 40000);
$proc = proc_open([PHP_BINARY, '-S', "127.0.0.1:$port", __DIR__ . '/router.php'], [1 => ['file', '/dev/null', 'w'], 2 => ['file', '/dev/null', 'w']], $pipes);
for ($i = 0; $i < 50; $i++) {
    $s = @fsockopen('127.0.0.1', $port, $errno, $errstr, 0.1);
    if ($s) {
        fclose($s);
        break;
    }
    usleep(100000);
}

try {
    $mail = new Client('evk_t', "http://127.0.0.1:$port");

    $r = $mail->send('t', 'a@b.co', ['variables' => ['x' => 1], 'idempotencyKey' => 'order-1', 'scheduledAt' => new DateTimeImmutable('2030-01-01T00:00:00Z'), 'tags' => [['name' => 'c', 'value' => 'v']]]);
    $seen = $r->data['seen'] ?? [];
    $sent = json_decode($seen['body'] ?? '{}', true);
    check('send returns data', $r->ok() && ($r->data['id'] ?? '') === 'em_1');
    check('idempotent replay is flagged', $r->replayed());
    check('bearer key sent', ($seen['auth'] ?? '') === 'Bearer evk_t');
    check('idempotency key sent as a header', ($seen['idem'] ?? '') === 'order-1' && !isset($sent['idempotencyKey']));
    check('scheduledAt is ISO 8601 UTC', ($sent['scheduledAt'] ?? '') === '2030-01-01T00:00:00Z', json_encode($sent));
    check('body maps template and tags', ($sent['templateId'] ?? '') === 't' && ($sent['tags'][0]['name'] ?? '') === 'c');

    $ref = new ReflectionMethod(Client::class, 'request');
    $ref->setAccessible(true);
    $b = $ref->invoke($mail, 'POST', '/api/blocked', []);
    check('blocked send is an error, not an exception', !$b->ok() && $b->error->status === 403 && $b->error->code === 'preflight_blocked' && $b->error->requestId === 'req_1' && ($b->error->preflight['gate'] ?? '') === 'BLOCKED');
    try {
        $b->unwrap();
        check('unwrap throws', false);
    } catch (RuntimeException $e) {
        check('unwrap throws', true);
    }

    $list = $mail->listEmails(['status' => 'bounced', 'tag' => 'campaign:welcome', 'limit' => 5, 'before' => 'em_9', 'to' => null]);
    check('list encodes the query', ($list->data['seen']['uri'] ?? '') === '/api/emails?status=bounced&tag=campaign%3Awelcome&limit=5&before=em_9', $list->data['seen']['uri'] ?? '');
    $rm = $mail->removeSuppression('a+b@x.io');
    check('suppression email is encoded', ($rm->data['seen']['uri'] ?? '') === '/api/suppressions?email=a%2Bb%40x.io');
    check('scheduled list maps', ($mail->listScheduled()->data[0]['id'] ?? '') === 'sch_1');
    check('unsubscribe link maps', $mail->unsubscribeLink('a@b.co')->data === 'https://m/u/x');

    $down = (new Client('k', 'http://127.0.0.1:1', 1))->stats();
    check('network failure is status 0', !$down->ok() && $down->error->status === 0);

    $body = '{"id":"evt_1"}';
    $t = 1700000000;
    $header = 't=' . $t . ',v1=' . hash_hmac('sha256', $t . '.' . $body, 'whsec');
    check('webhook verifies', Webhooks::verify('whsec', $body, $header, 300, $t + 5) === [true, null]);
    check('webhook mismatch', Webhooks::verify('whsec', $body . ' ', $header, 300, $t + 5) === [false, 'mismatch']);
    check('webhook stale', Webhooks::verify('whsec', $body, $header, 300, $t + 9999) === [false, 'stale']);
    check('webhook malformed', Webhooks::verify('whsec', $body, 'nope') === [false, 'malformed']);
    check('sign round-trips', Webhooks::verify('whsec', $body, Webhooks::sign('whsec', $body)) === [true, null]);

    try {
        new Client('');
        check('requires a key', false);
    } catch (InvalidArgumentException $e) {
        check('requires a key', true);
    }
} finally {
    proc_terminate($proc);
}
exit($failures === 0 ? 0 : 1);
