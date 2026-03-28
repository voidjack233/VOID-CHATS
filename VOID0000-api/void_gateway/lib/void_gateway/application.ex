defmodule VoidGateway.Application do
  use Application

  require Logger

  @impl true
  def start(_type, _args) do
    valkey_host = Application.get_env(:void_gateway, :valkey_host, "127.0.0.1")
    valkey_port = Application.get_env(:void_gateway, :valkey_port, 6379)

    # Reset drain flag in case of in-VM restart (e.g. Application.stop + start
    # in the same BEAM). persistent_term survives process restarts.
    VoidGateway.Drain.reset()

    children = [
      # Telemetry handlers — attach before anything that emits events.
      VoidGateway.Telemetry,

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

  # Called by OTP before supervision tree shutdown (SIGTERM, Application.stop, etc.).
  # Sets drain flag, pushes SHUTDOWN to all sockets, waits for clients to disconnect.
  @impl true
  def prep_stop(state) do
    delay = Application.get_env(:void_gateway, :drain_delay_ms, 5_000)
    count = VoidGateway.ConnectionRegistry.count()

    Logger.info("[Application] Draining #{count} sockets, delay=#{delay}ms")
    VoidGateway.Drain.start_drain(delay)

    # Give clients time to receive SHUTDOWN and close cleanly.
    # After this, normal supervision shutdown closes any remaining connections.
    Process.sleep(delay)

    Logger.info("[Application] Drain complete, proceeding with shutdown")
    state
  end
end
