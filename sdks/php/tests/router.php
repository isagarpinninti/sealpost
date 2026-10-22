<?php
// A fake Sealpost server for the tests, served by `php -S`. It echoes what it received.
$path = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);
$body = file_get_contents('php://input');
$seen = ['method' => $_SERVER['REQUEST_METHOD'], 'uri' => $_SERVER['REQUEST_URI'], 'auth' => $_SERVER['HTTP_AUTHORIZATION'] ?? '', 'idem' => $_SERVER['HTTP_IDEMPOTENCY_KEY'] ?? '', 'body' => $body];
header('Content-Type: application/json');
if ($path === '/api/blocked') {
    http_response_code(403);
    echo json_encode(['ok' => false, 'error' => 'Blocked', 'code' => 'preflight_blocked', 'requestId' => 'req_1', 'preflight' => ['gate' => 'BLOCKED']]);
    return;
}
if ($path === '/api/send') {
    header('Idempotent-Replayed: true');
    http_response_code(201);
    echo json_encode(['ok' => true, 'id' => 'em_1', 'status' => 'delivered', 'seen' => $seen]);
    return;
}
echo json_encode(['ok' => true, 'seen' => $seen, 'data' => [], 'scheduled' => [['id' => 'sch_1']], 'url' => 'https://m/u/x']);
