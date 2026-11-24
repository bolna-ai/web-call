# POST /api/bolna-session: mints a short-lived Bolna web-call session with YOUR bn- key
# (server-side only) and returns it unchanged to the browser SDK.
# Run:  bundle install && BOLNA_API_KEY=bn-... BOLNA_AGENT_ID=... bundle exec ruby app.rb
require "json"
require "net/http"
require "sinatra"

API_KEY = ENV.fetch("BOLNA_API_KEY")
AGENT_ID = ENV.fetch("BOLNA_AGENT_ID", "")
API_BASE = ENV.fetch("BOLNA_API_BASE", "https://api.bolna.ai")

set :port, ENV.fetch("PORT", 8787).to_i

post "/api/bolna-session" do
  # Add YOUR user auth here so only signed-in users can start calls.
  input = JSON.parse(request.body.read) rescue {}
  payload = { agent_id: AGENT_ID }
  payload[:user_data] = input["user_data"] if input.is_a?(Hash) && input["user_data"]

  uri = URI("#{API_BASE}/web-call/session")
  begin
    res = Net::HTTP.start(uri.host, uri.port, use_ssl: uri.scheme == "https", read_timeout: 15) do |http|
      http.post(uri.path, payload.to_json,
                "Authorization" => "Bearer #{API_KEY}", "Content-Type" => "application/json")
    end
  rescue StandardError
    halt 502, { "Content-Type" => "application/json" }, { message: "session mint failed" }.to_json
  end

  content_type :json
  status res.code.to_i
  res.body
end
