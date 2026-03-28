defmodule VoidGateway.Drain do
  @moduledoc """
  Manages graceful drain state for the gateway.

  Uses :persistent_term for the drain flag so hot-path reads in
  GatewayUpgrade are lock-free and zero-cost (no GenServer call,
  no ETS lookup, no message passing).

  Flow:
    1. Application.prep_stop/1 calls start_drain/1
    2. Drain flag is set — new upgrades get 503
    3. SHUTDOWN event pushed to every connected socket
    4. prep_stop sleeps the drain delay, then returns
    5. Normal OTP shutdown proceeds
  """

  alias VoidGateway.ConnectionRegistry

  @drain_key :void_gateway_draining
  @default_drain_delay_ms 5_000

  @doc "Returns true if the gateway is draining."
  @spec draining?() :: boolean()
  def draining? do
    :persistent_term.get(@drain_key, false)
  end

  @doc """
  Initiate drain: set the flag and notify all connected sockets.

  Each socket receives {:shutdown_event, delay_ms} and pushes a
  SHUTDOWN event to the client with `d.in` set to the delay.

  Returns after notifications are sent (does NOT sleep the delay —
  the caller in prep_stop handles that).
  """
  @spec start_drain(pos_integer()) :: :ok
  def start_drain(delay_ms \\ @default_drain_delay_ms) do
    :persistent_term.put(@drain_key, true)

    # Gather all connected pids and notify them
    all_pids =
      ConnectionRegistry.all_pids()

    Enum.each(all_pids, fn pid ->
      send(pid, {:shutdown_event, delay_ms})
    end)

    :ok
  end

  @doc "Reset drain flag (for testing or if drain is aborted)."
  @spec reset() :: :ok
  def reset do
    :persistent_term.put(@drain_key, false)
    :ok
  end
end
