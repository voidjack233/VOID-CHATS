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

  # Health check — matches gateway-server.js /health endpoint shape.
  # Returns 503 during drain so load balancers stop sending traffic.
  get "/health" do
    draining = VoidGateway.Drain.draining?()
    status_code = if draining, do: 503, else: 200

    body =
      Jason.encode!(%{
        status: if(draining, do: "draining", else: "ok"),
        service: "void_gateway",
        sockets: VoidGateway.ConnectionRegistry.count()
      })

    send_resp(conn, status_code, body)
  end

  match _ do
    send_resp(conn, 404, "Not Found")
  end
end
