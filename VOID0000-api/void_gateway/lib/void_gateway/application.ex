defmodule VoidGateway.Application do
  use Application

  @impl true
  def start(_type, _args) do
    valkey_host = Application.get_env(:void_gateway, :valkey_host, "127.0.0.1")
    valkey_port = Application.get_env(:void_gateway, :valkey_port, 6379)

    children = [
      # Named Redix connection used for synchronous Valkey commands (EXISTS, etc.)
      # Separate from the pub/sub connection — a subscribed Redix connection cannot
      # issue regular commands.
      {Redix, host: valkey_host, port: valkey_port, name: :redix},

      # ETS-backed registry: {userId, deviceId} -> socket pid.
      # GenServer owns the table; socket processes write directly via public ETS API.
      VoidGateway.ConnectionRegistry,

      # Subscribes to void:gateway Valkey pub/sub channel.
      # Receives events published by Node API workers and forwards them to EventDispatcher.
      # Replaces gateway-server.js initSubscriber().
      VoidGateway.GatewaySubscriber,

      # Phoenix endpoint — Cowboy2 HTTP server that handles WebSocket upgrades.
      # Replaces gateway-server.js setupGateway().
      VoidGatewayWeb.Endpoint
    ]

    opts = [strategy: :one_for_one, name: VoidGateway.Supervisor]
    Supervisor.start_link(children, opts)
  end
end
