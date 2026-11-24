// Spring Boot version of the same route (spring-boot-starter-web). Drop into your app.
package com.example.bolna;

import java.util.HashMap;
import java.util.Map;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.client.HttpStatusCodeException;
import org.springframework.web.client.RestClient;

@RestController
public class SpringBolnaSessionController {
    private final RestClient bolna;
    private final String agentId;

    public SpringBolnaSessionController(
            @Value("${bolna.api-key}") String apiKey,
            @Value("${bolna.agent-id}") String agentId,
            @Value("${bolna.api-base:https://api.bolna.ai}") String apiBase) {
        this.bolna = RestClient.builder()
                .baseUrl(apiBase)
                .defaultHeader("Authorization", "Bearer " + apiKey)
                .build();
        this.agentId = agentId;
    }

    // Protect this route with YOUR user auth (e.g. Spring Security).
    @PostMapping(value = "/api/bolna-session", produces = MediaType.APPLICATION_JSON_VALUE)
    public ResponseEntity<String> session(@RequestBody(required = false) Map<String, Object> in) {
        Map<String, Object> payload = new HashMap<>();
        payload.put("agent_id", agentId);
        if (in != null && in.get("user_data") != null) payload.put("user_data", in.get("user_data"));
        try {
            return bolna.post().uri("/web-call/session")
                    .contentType(MediaType.APPLICATION_JSON)
                    .body(payload)
                    .retrieve()
                    .toEntity(String.class);
        } catch (HttpStatusCodeException e) {
            // pass Bolna's status through: the SDK maps 429 to at_capacity
            return ResponseEntity.status(e.getStatusCode()).body(e.getResponseBodyAsString());
        }
    }
}
