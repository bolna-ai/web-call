# Rails version of the same route. In config/routes.rb:
#   post "/api/bolna-session", to: "bolna_sessions#create"
require "net/http"

class BolnaSessionsController < ApplicationController
  before_action :authenticate_user! # YOUR auth
  skip_forgery_protection only: :create # the SDK POSTs JSON without a CSRF token; use getSession to send one instead

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
