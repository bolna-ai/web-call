// POST /api/bolna-session: mints a short-lived Bolna web-call session with YOUR bn- key
// (server-side only) and returns it unchanged to the browser SDK.
// Run:  BOLNA_API_KEY=bn-... BOLNA_AGENT_ID=... dotnet run
using System.Net.Http.Headers;
using System.Text.Json.Nodes;

var builder = WebApplication.CreateBuilder(args);
var apiKey = builder.Configuration["BOLNA_API_KEY"] ?? throw new InvalidOperationException("Set BOLNA_API_KEY (your bn- key).");
var agentId = builder.Configuration["BOLNA_AGENT_ID"] ?? "";
var apiBase = builder.Configuration["BOLNA_API_BASE"] ?? "https://api.bolna.ai";

builder.Services.AddHttpClient("bolna", c =>
{
    c.BaseAddress = new Uri(apiBase);
    c.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", apiKey);
    c.Timeout = TimeSpan.FromSeconds(15);
});
var app = builder.Build();

// Add YOUR user auth here (.RequireAuthorization()) so only signed-in users can start calls.
app.MapPost("/api/bolna-session", async (HttpRequest request, IHttpClientFactory factory) =>
{
    JsonNode? input = null;
    try { input = await JsonNode.ParseAsync(request.Body); } catch (System.Text.Json.JsonException) { }

    var payload = new JsonObject { ["agent_id"] = agentId };
    if (input?["user_data"] is JsonNode userData)
        payload["user_data"] = userData.DeepClone(); // forwarded from the SDK's userData

    try
    {
        var r = await factory.CreateClient("bolna").PostAsync("/web-call/session",
            new StringContent(payload.ToJsonString(), System.Text.Encoding.UTF8, "application/json"));
        return Results.Content(await r.Content.ReadAsStringAsync(), "application/json", statusCode: (int)r.StatusCode);
    }
    catch (HttpRequestException)
    {
        return Results.Json(new { message = "session mint failed" }, statusCode: 502);
    }
});

app.Run($"http://localhost:{Environment.GetEnvironmentVariable("PORT") ?? "8787"}");
