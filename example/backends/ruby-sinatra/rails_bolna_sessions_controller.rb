# Rails version of the same route. Save as app/controllers/bolna_sessions_controller.rb.
# In config/routes.rb:
#   post "/api/bolna-session", to: "bolna_sessions#create"
require "net/http"

class BolnaSessionsController < ApplicationController
  before_action :authenticate_user! # YOUR auth
  # The SDK POSTs application/json without a CSRF token. Cross-site pages can't send that content type
  # without a CORS preflight, so only JSON requests skip the token check.
  skip_forgery_protection only: :create, if: -> { request.media_type == "application/json" }

  def create
    payload = { agent_id: ENV.fetch("BOLNA_AGENT_ID") }
    payload[:user_data] = params[:user_data].to_unsafe_h if params[:user_data].present?

    uri = URI("https://api.bolna.ai/web-call/session")
    res = Net::HTTP.post(uri, payload.to_json,
                         "Authorization" => "Bearer #{ENV.fetch('BOLNA_API_KEY')}",
                         "Content-Type" => "application/json")
    # pass Bolna's status through: the SDK maps 429 to at_capacity
    render json: res.body, status: res.code.to_i
  end
end
