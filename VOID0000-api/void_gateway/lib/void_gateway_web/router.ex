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

  get "/ready" do
    draining = VoidGateway.Drain.draining?()
    valkey = valkey_ready()
    ready = !draining and valkey.ok
    status_code = if ready, do: 200, else: 503

    body =
      Jason.encode!(%{
        success: ready,
        status: if(ready, do: "ready", else: "degraded"),
        service: "void_gateway",
        sockets: VoidGateway.ConnectionRegistry.count(),
        dependencies: %{
          valkey: valkey
        }
      })

    conn
    |> put_resp_header("cache-control", "no-store")
    |> send_resp(status_code, body)
  end

  match _ do
    send_resp(conn, 404, "Not Found")
  end

  defp valkey_ready do
    case Redix.command(:redix, ["PING"], timeout: 1_000) do
      {:ok, "PONG"} ->
        %{ok: true}

      {:ok, response} ->
        %{ok: false, error: "Unexpected PING response: #{inspect(response)}"}

      {:error, reason} ->
        %{ok: false, error: inspect(reason)}
    end
  catch
    :exit, reason ->
      %{ok: false, error: inspect(reason)}
  end
end
