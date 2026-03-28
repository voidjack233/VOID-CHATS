defmodule VoidGatewayWeb.Router do
  use Plug.Router

  plug Plug.Logger, log: :debug
  plug :match
  plug :dispatch

  # WebSocket upgrade endpoint. Matches Node's gateway-server.js on port 3002.
  # GatewayUpgrade handles origin check, JWT auth, Valkey session check, then upgrades.
  get "/gateway" do
    VoidGatewayWeb.Plugs.GatewayUpgrade.call(conn, [])
  end

  # Health check — matches gateway-server.js /health endpoint shape
  get "/health" do
    body = Jason.encode!(%{status: "ok", service: "void_gateway"})
    send_resp(conn, 200, body)
  end

  match _ do
    send_resp(conn, 404, "Not Found")
  end
end
