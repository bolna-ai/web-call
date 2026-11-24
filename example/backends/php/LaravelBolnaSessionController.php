<?php
// Laravel version of the same route. In routes/web.php or routes/api.php:
//   Route::post('/api/bolna-session', BolnaSessionController::class)->middleware('auth');
// with BOLNA_API_KEY / BOLNA_AGENT_ID in .env, exposed via config/services.php ('bolna' => [...]).

namespace App\Http\Controllers;

use Illuminate\Http\Request;
use Illuminate\Support\Facades\Http;

class BolnaSessionController extends Controller
{
    public function __invoke(Request $request)
    {
        $payload = ['agent_id' => config('services.bolna.agent_id')];
        if ($request->has('user_data')) {
            $payload['user_data'] = $request->input('user_data');
        }

        $r = Http::withToken(config('services.bolna.api_key'))
            ->timeout(15)
            ->post('https://api.bolna.ai/web-call/session', $payload);

        // pass Bolna's status through: the SDK maps 429 to at_capacity
        return response($r->body(), $r->status())->header('Content-Type', 'application/json');
    }
}
