defmodule VoidGatewayWeb.Endpoint do
  use Phoenix.Endpoint, otp_app: :void_gateway

  # No session, cookie, or LiveView plugs — this endpoint is WebSocket-only.
  # Auth is handled per-upgrade in GatewayUpgrade plug via JWT + Valkey check.
  plug VoidGatewayWeb.Router
end
