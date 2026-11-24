<?php
// POST /api/bolna-session: mints a short-lived Bolna web-call session with YOUR bn- key
// (server-side only) and returns it unchanged to the browser SDK.
// Run:  BOLNA_API_KEY=bn-... BOLNA_AGENT_ID=... php -S localhost:8787 index.php

$apiKey = getenv('BOLNA_API_KEY');
$agentId = getenv('BOLNA_AGENT_ID') ?: '';
$apiBase = getenv('BOLNA_API_BASE') ?: 'https://api.bolna.ai';

header('Content-Type: application/json');

if ($_SERVER['REQUEST_METHOD'] !== 'POST' || parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH) !== '/api/bolna-session') {
    http_response_code(404);
    exit;
}
// Add YOUR user auth here so only signed-in users can start calls.

// decode as objects so {} and {"0": ...} stay JSON objects
$in = json_decode(file_get_contents('php://input') ?: '{}');
$payload = ['agent_id' => $agentId];
if (is_object($in) && isset($in->user_data)) {
    $payload['user_data'] = $in->user_data; // forwarded from the SDK's userData
}

$ch = curl_init("$apiBase/web-call/session");
curl_setopt_array($ch, [
    CURLOPT_POST => true,
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_TIMEOUT => 15,
    CURLOPT_HTTPHEADER => ["Authorization: Bearer $apiKey", 'Content-Type: application/json'],
    CURLOPT_POSTFIELDS => json_encode((object) $payload),
]);
$body = curl_exec($ch);
if ($body === false) {
    http_response_code(502);
    echo json_encode(['message' => 'session mint failed']);
    exit;
}
http_response_code(curl_getinfo($ch, CURLINFO_RESPONSE_CODE));
echo $body;
