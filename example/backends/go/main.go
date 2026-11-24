// POST /api/bolna-session: mints a short-lived Bolna web-call session with YOUR bn- key
// (server-side only) and returns it unchanged to the browser SDK.
// Run:  BOLNA_API_KEY=bn-... BOLNA_AGENT_ID=... go run .
package main

import (
	"bytes"
	"encoding/json"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"time"
)

var (
	apiKey  = os.Getenv("BOLNA_API_KEY")
	agentID = os.Getenv("BOLNA_AGENT_ID")
	apiBase = getenv("BOLNA_API_BASE", "https://api.bolna.ai")
	client  = &http.Client{Timeout: 15 * time.Second}
)

func getenv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func bolnaSession(w http.ResponseWriter, r *http.Request) {
	// Add YOUR user auth here so only signed-in users can start calls.
	var in struct {
		UserData json.RawMessage `json:"user_data,omitempty"`
	}
	_ = json.NewDecoder(r.Body).Decode(&in)

	payload := map[string]any{"agent_id": agentID}
	if len(in.UserData) > 0 && string(in.UserData) != "null" {
		payload["user_data"] = in.UserData // forwarded from the SDK's userData
	}
	body, _ := json.Marshal(payload)

	req, _ := http.NewRequestWithContext(r.Context(), http.MethodPost, apiBase+"/web-call/session", bytes.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+apiKey)
	req.Header.Set("Content-Type", "application/json")
	resp, err := client.Do(req)
	if err != nil {
		http.Error(w, `{"message":"session mint failed"}`, http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(resp.StatusCode)
	io.Copy(w, resp.Body)
}

func main() {
	if apiKey == "" {
		log.Fatal("Set BOLNA_API_KEY (your bn- key) in the environment.")
	}
	http.HandleFunc("POST /api/bolna-session", bolnaSession)
	addr := net.JoinHostPort(getenv("HOST", "127.0.0.1"), getenv("PORT", "8787"))
	log.Printf("session proxy on http://%s/api/bolna-session", addr)
	log.Fatal(http.ListenAndServe(addr, nil))
}
