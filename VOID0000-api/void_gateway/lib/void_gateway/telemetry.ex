defmodule VoidGateway.Telemetry do
  @moduledoc """
  Attaches :telemetry handlers that produce structured log lines for
  gateway lifecycle events. Started early in the supervision tree so
  handlers are in place before the first socket connects.

  All events use the [:void_gateway, ...] prefix. Measurements are
  always %{} (counters only — no latency tracking needed here).

  Events:
    [:void_gateway, :socket, :connect]        — WebSocket upgrade completed
    [:void_gateway, :socket, :identify]       — IDENTIFY succeeded
    [:void_gateway, :socket, :resume]         — RESUME succeeded
    [:void_gateway, :socket, :resume_failed]  — RESUME rejected (gap/invalid)
    [:void_gateway, :socket, :close]          — socket closing with a close code
    [:void_gateway, :command, :disconnect_session]  — Node disconnect command
    [:void_gateway, :command, :update_token_expiry] — Node token expiry sync
    [:void_gateway, :event, :fanout]          — event dispatched to sockets
  """

  require Logger

  @events [
    [:void_gateway, :socket, :connect],
    [:void_gateway, :socket, :identify],
    [:void_gateway, :socket, :resume],
    [:void_gateway, :socket, :resume_failed],
    [:void_gateway, :socket, :close],
    [:void_gateway, :command, :disconnect_session],
    [:void_gateway, :command, :update_token_expiry],
    [:void_gateway, :event, :fanout]
  ]

  def start_link(_opts) do
    :telemetry.attach_many(
      "void-gateway-logger",
      @events,
      &__MODULE__.handle_event/4,
      nil
    )

    # No process needed — :telemetry handlers run in the caller's process.
    # Return :ignore so the supervisor treats this as a transient child.
    :ignore
  end

  def child_spec(opts) do
    %{
      id: __MODULE__,
      start: {__MODULE__, :start_link, [opts]},
      type: :worker,
      restart: :temporary
    }
  end

  # ---------------------------------------------------------------------------
  # Handlers
  # ---------------------------------------------------------------------------

  def handle_event([:void_gateway, :socket, :connect], _measurements, meta, _config) do
    Logger.info("[gateway] connect user=#{meta.user_id} device=#{meta.device_id}")
  end

  def handle_event([:void_gateway, :socket, :identify], _measurements, meta, _config) do
    displaced_str = if meta.displaced > 0, do: " displaced=#{meta.displaced}", else: ""

    Logger.info(
      "[gateway] identify user=#{meta.user_id} device=#{meta.device_id}" <>
        " session=#{meta.session_id}#{displaced_str}"
    )
  end

  def handle_event([:void_gateway, :socket, :resume], _measurements, meta, _config) do
    Logger.info(
      "[gateway] resume user=#{meta.user_id} device=#{meta.device_id}" <>
        " session=#{meta.session_id} replayed=#{meta.replayed}"
    )
  end

  def handle_event([:void_gateway, :socket, :resume_failed], _measurements, meta, _config) do
    Logger.warning(
      "[gateway] resume_failed user=#{meta.user_id} device=#{meta.device_id}" <>
        " reason=#{meta.reason}"
    )
  end

  def handle_event([:void_gateway, :socket, :close], _measurements, meta, _config) do
    Logger.info(
      "[gateway] close user=#{meta.user_id} device=#{meta.device_id}" <>
        " code=#{meta.code} reason=#{meta.reason}"
    )
  end

  def handle_event([:void_gateway, :command, :disconnect_session], _measurements, meta, _config) do
    Logger.info("[gateway] cmd=disconnect_session user=#{meta.user_id} targets=#{meta.targets}")
  end

  def handle_event([:void_gateway, :command, :update_token_expiry], _measurements, meta, _config) do
    Logger.info("[gateway] cmd=update_token_expiry user=#{meta.user_id} targets=#{meta.targets}")
  end

  def handle_event([:void_gateway, :event, :fanout], _measurements, meta, _config) do
    Logger.debug(
      "[gateway] fanout event=#{meta.event} user=#{meta.user_id} sockets=#{meta.sockets}"
    )
  end
end
