defmodule VoidGatewayWeb.Plugs.GatewayUpgrade do
  @moduledoc """
  Handles WebSocket upgrade requests for /gateway.

  Mirrors the upgrade guard in gateway/index.js setupGateway():
    1. Origin check (same allowed-origins list)
    2. JWT verification + Valkey session liveness (via SocketAuth)
    3. WebSocket upgrade via WebSockAdapter — hands off to SocketHandler

  If any check fails, returns HTTP 401/403 and halts. The WebSocket
  is never opened for rejected requests.

  max_frame_size matches Node gateway WS_LIMITS.maxPayload (64 KB).
  """

  @behaviour Plug

  require Logger

  @impl Plug
  def init(opts), do: opts

  @impl Plug
  def call(conn, _opts) do
    with :ok <- check_draining(),
         :ok <- check_origin(conn),
         {:ok, auth} <- VoidGateway.SocketAuth.verify_upgrade(conn) do
      conn
      |> WebSockAdapter.upgrade(
        VoidGatewayWeb.Handlers.SocketHandler,
        auth,
        max_frame_size: 65_536,
        compress: false
      )
      |> Plug.Conn.halt()
    else
      {:error, :draining} ->
        retry_secs =
          Application.get_env(:void_gateway, :drain_delay_ms, 5_000)
          |> div(1_000)
          |> max(1)
          |> Integer.to_string()

        conn
        |> Plug.Conn.put_resp_header("content-type", "text/plain")
        |> Plug.Conn.put_resp_header("retry-after", retry_secs)
        |> Plug.Conn.send_resp(503, "Service draining")
        |> Plug.Conn.halt()

      {:error, :bad_origin} ->
        Logger.warning("[GatewayUpgrade] Rejected: bad origin #{origin_header(conn)}")

        conn
        |> Plug.Conn.put_resp_header("content-type", "text/plain")
        |> Plug.Conn.send_resp(403, "Forbidden")
        |> Plug.Conn.halt()

      {:error, reason} ->
        Logger.debug("[GatewayUpgrade] Rejected: #{reason}")

        conn
        |> Plug.Conn.put_resp_header("content-type", "text/plain")
        |> Plug.Conn.send_resp(401, "Unauthorized")
        |> Plug.Conn.halt()
    end
  end

  # ---------------------------------------------------------------------------
  # Private
  # ---------------------------------------------------------------------------

  defp check_draining do
    if VoidGateway.Drain.draining?(), do: {:error, :draining}, else: :ok
  end

  defp check_origin(conn) do
    origin = origin_header(conn)

    if is_nil(origin) do
      # No Origin header — same-origin or non-browser client. Allow.
      :ok
    else
      allowed = Application.get_env(:void_gateway, :allowed_origins, [])

      if origin in allowed do
        :ok
      else
        {:error, :bad_origin}
      end
    end
  end

  defp origin_header(conn) do
    Plug.Conn.get_req_header(conn, "origin") |> List.first()
  end
end
