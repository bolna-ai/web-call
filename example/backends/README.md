# Session endpoint examples

The Web Call SDK runs in the browser, so it works with any backend. The one thing your backend
must do is expose a route that mints a short-lived call session with your `bn-` API key and
returns Bolna's JSON unchanged:

```
POST /api/bolna-session   body: {} or {"user_data": {...}}   (sent by the SDK's sessionUrl mode)
  └─▶ POST https://api.bolna.ai/web-call/session
        Authorization: Bearer <BOLNA_API_KEY>
        {"agent_id": "<BOLNA_AGENT_ID>", "user_data": {...}}
```

Pass Bolna's status code through as-is: the SDK turns a `429` into the `at_capacity` error.
Put your own user auth in front of the route so only signed-in users can start calls.

| Language | File | Run |
|---|---|---|
| Node.js | [`../server-example.js`](../server-example.js) | `node server-example.js` |
| Python (FastAPI) | [`python-fastapi/main.py`](python-fastapi/main.py) | `pip install -r requirements.txt && uvicorn main:app --port 8787` |
| Go | [`go/main.go`](go/main.go) | `go run .` (Go 1.22+) |
| Java (JDK only) | [`java/BolnaSession.java`](java/BolnaSession.java) | `java BolnaSession.java` (JDK 17+) |
| Java (Spring Boot) | [`java/SpringBolnaSessionController.java`](java/SpringBolnaSessionController.java) | drop into your app; set `bolna.api-key` / `bolna.agent-id` |
| PHP | [`php/index.php`](php/index.php) | `php -S localhost:8787 index.php` |
| PHP (Laravel) | [`php/LaravelBolnaSessionController.php`](php/LaravelBolnaSessionController.php) | drop into `app/Http/Controllers` |
| Ruby (Sinatra) | [`ruby-sinatra/app.rb`](ruby-sinatra/app.rb) | `bundle install && bundle exec ruby app.rb` |
| Ruby (Rails) | [`ruby-sinatra/rails_bolna_sessions_controller.rb`](ruby-sinatra/rails_bolna_sessions_controller.rb) | drop into `app/controllers` |
| C# (ASP.NET Core) | [`csharp-aspnet/Program.cs`](csharp-aspnet/Program.cs) | `dotnet run` (.NET 8+) |

Every runnable example reads `BOLNA_API_KEY`, `BOLNA_AGENT_ID`, `PORT` (default `8787`) and
`BOLNA_API_BASE` (default `https://api.bolna.ai`) from the environment.

To start a multilingual agent in a chosen language, add `"agent_data": {"language": "hi"}` to the
mint body (see the [docs](https://www.bolna.ai/docs/developer-resources/sdks/web-call#start-in-a-chosen-language)).

Framework wrappers for the browser side are in [`../frameworks`](../frameworks): a React hook and
a Vue 3 composable.
