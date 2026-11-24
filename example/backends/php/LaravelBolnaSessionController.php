<?php
// Laravel version of the same route. Save as app/Http/Controllers/BolnaSessionController.php.
// In routes/api.php (Laravel adds the /api prefix and no CSRF check there):
//   Route::post('/bolna-session', BolnaSessionController::class)->middleware('auth:sanctum');
// with BOLNA_API_KEY / BOLNA_AGENT_ID in .env, exposed via config/services.php ('bolna' => [...]).

namespace App\Http\Controllers;

use Illuminate\Http\Request;
use Illuminate\Support\Facades\Http;

class BolnaSessionController extends Controller
{
    public function __invoke(Request $request)
    {
        $payload = ['agent_id' => config('services.bolna.agent_id')];
        // decode as objects so {} and {"0": ...} stay JSON objects
        $in = json_decode($request->getContent() ?: '{}');
        if (is_object($in) && isset($in->user_data)) {
            $payload['user_data'] = $in->user_data;
        }

        $r = Http::withToken(config('services.bolna.api_key'))
            ->timeout(15)
            ->withBody(json_encode($payload), 'application/json')
            ->post('https://api.bolna.ai/web-call/session');

        // pass Bolna's status through: the SDK maps 429 to at_capacity
        return response($r->body(), $r->status())->header('Content-Type', 'application/json');
    }
}
