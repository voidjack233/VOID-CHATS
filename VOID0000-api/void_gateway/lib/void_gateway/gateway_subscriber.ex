defmodule VoidGateway.GatewaySubscriber do
  @moduledoc """
  Subscribes to the void:gateway Valkey pub/sub channel and forwards
  received messages to EventDispatcher.

  Replaces the initSubscriber() call and message handler in gateway-server.js.

  Uses a dedicated Redix.PubSub connection — a subscribed Redis connection
  cannot issue regular commands, so this is separate from the :redix command pool.

  Redix automatically reconnects on Valkey disconnects; no reconnect logic needed here.
  """

  use GenServer
  require Logger

  @channel "void:gateway"

  def start_link(_opts), do: GenServer.start_link(__MODULE__, [], name: __MODULE__)

  @impl true
  def init(_) do
    host = Application.get_env(:void_gateway, :valkey_host, "127.0.0.1")
    port = Application.get_env(:void_gateway, :valkey_port, 6379)

    {:ok, pubsub} = Redix.PubSub.start_link(host: host, port: port)
    {:ok, _ref} = Redix.PubSub.subscribe(pubsub, @channel, self())

    Logger.info("[GatewaySubscriber] Connecting to #{host}:#{port}, subscribing to #{@channel}")
    {:ok, %{pubsub: pubsub}}
  end

  # Subscription confirmed
  @impl true
  def handle_info({:redix_pubsub, _pubsub, _ref, :subscribed, %{channel: ch}}, state) do
    Logger.info("[GatewaySubscriber] Subscribed to #{ch}")
    {:noreply, state}
  end

  # Incoming pub/sub message from a Node API worker
  @impl true
  def handle_info(
        {:redix_pubsub, _pubsub, _ref, :message, %{channel: @channel, payload: payload}},
        state
      ) do
    case Jason.decode(payload) do
      {:ok, message} ->
        VoidGateway.EventDispatcher.dispatch(message)

      {:error, reason} ->
        Logger.error("[GatewaySubscriber] Failed to decode message: #{inspect(reason)}")
    end

    {:noreply, state}
  end

  # Valkey dropped the connection — Redix will reconnect automatically
  @impl true
  def handle_info({:redix_pubsub, _pubsub, _ref, :disconnected, _info}, state) do
    Logger.warning("[GatewaySubscriber] Pub/sub disconnected — Redix will reconnect")
    {:noreply, state}
  end

  @impl true
  def handle_info(msg, state) do
    Logger.debug("[GatewaySubscriber] Unhandled message: #{inspect(msg)}")
    {:noreply, state}
  end
end
