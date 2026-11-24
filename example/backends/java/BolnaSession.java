// POST /api/bolna-session: mints a short-lived Bolna web-call session with YOUR bn- key
// (server-side only) and returns it unchanged to the browser SDK. JDK 17+, no dependencies.
// Run:  BOLNA_API_KEY=bn-... BOLNA_AGENT_ID=... java BolnaSession.java
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;

import java.io.IOException;
import java.net.InetSocketAddress;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.Optional;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

public class BolnaSession {
    static final String API_KEY = System.getenv("BOLNA_API_KEY");
    static final String AGENT_ID = Optional.ofNullable(System.getenv("BOLNA_AGENT_ID")).orElse("");
    static final String API_BASE = Optional.ofNullable(System.getenv("BOLNA_API_BASE")).orElse("https://api.bolna.ai");
    static final HttpClient CLIENT = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(10)).build();
    // the SDK posts {"user_data": {...}} or {}; a JSON library (Jackson/Gson) is the
    // production choice — this keeps the example dependency-free
    static final Pattern USER_DATA = Pattern.compile("^\\s*\\{\\s*\"user_data\"\\s*:\\s*(\\{.*\\})\\s*\\}\\s*$", Pattern.DOTALL);

    public static void main(String[] args) throws IOException {
        if (API_KEY == null || API_KEY.isEmpty()) {
            System.err.println("Set BOLNA_API_KEY (your bn- key) in the environment.");
            System.exit(1);
        }
        int port = Integer.parseInt(Optional.ofNullable(System.getenv("PORT")).orElse("8787"));
        HttpServer server = HttpServer.create(new InetSocketAddress(Optional.ofNullable(System.getenv("HOST")).orElse("127.0.0.1"), port), 0);
        server.createContext("/api/bolna-session", BolnaSession::handle);
        server.start();
        System.out.println("session proxy on http://localhost:" + port + "/api/bolna-session");
    }

    // True when s is exactly one balanced JSON object, so a body like
    // {"user_data":{},"agent_id":"other"} cannot smuggle extra top-level fields.
    static boolean isOneObject(String s) {
        int depth = 0;
        boolean inString = false;
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (inString) {
                if (c == '\\') i++;
                else if (c == '"') inString = false;
            } else if (c == '"') {
                inString = true;
            } else if (c == '{' || c == '[') {
                depth++;
            } else if (c == '}' || c == ']') {
                if (--depth == 0 && i != s.length() - 1) return false;
            }
        }
        return depth == 0 && !inString;
    }

    static void handle(HttpExchange ex) throws IOException {
        if (!"POST".equals(ex.getRequestMethod())) {
            ex.sendResponseHeaders(405, -1);
            return;
        }
        // Add YOUR user auth here so only signed-in users can start calls.
        String in = new String(ex.getRequestBody().readAllBytes(), StandardCharsets.UTF_8);
        Matcher m = USER_DATA.matcher(in);
        String agent = "\"agent_id\":\"" + AGENT_ID.replace("\\", "\\\\").replace("\"", "\\\"") + "\"";
        String payload = m.matches() && isOneObject(m.group(1))
                ? "{" + agent + ",\"user_data\":" + m.group(1) + "}"
                : "{" + agent + "}";

        HttpRequest req = HttpRequest.newBuilder(URI.create(API_BASE + "/web-call/session"))
                .timeout(Duration.ofSeconds(15))
                .header("Authorization", "Bearer " + API_KEY)
                .header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(payload))
                .build();
        int status;
        byte[] body;
        try {
            HttpResponse<byte[]> resp = CLIENT.send(req, HttpResponse.BodyHandlers.ofByteArray());
            status = resp.statusCode();
            body = resp.body();
        } catch (IOException | InterruptedException e) {
            status = 502;
            body = "{\"message\":\"session mint failed\"}".getBytes(StandardCharsets.UTF_8);
        }
        ex.getResponseHeaders().set("Content-Type", "application/json");
        ex.sendResponseHeaders(status, body.length);
        ex.getResponseBody().write(body);
        ex.close();
    }
}
