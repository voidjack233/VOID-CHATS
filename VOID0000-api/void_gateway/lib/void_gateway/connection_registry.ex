defmodule VoidGateway.ConnectionRegistry do
  @moduledoc """
  ETS-backed registry mapping {userId, deviceId, pid} -> :registered.

  Key design decisions vs the first version ({userId, deviceId} -> pid):

    - The ETS key is a 3-tuple {userId, deviceId, pid} instead of a 2-tuple.
      This allows multiple live sockets per {userId, deviceId}, matching the
      Node gateway which uses userId -> Set<WebSocket> and supports up to 5
      concurrent connections per user across any device combination.

    - unregister/3 takes an explicit pid and only removes that one row.
      A second socket for the same {userId, deviceId} no longer overwrites the
      first entry on register, and the first socket terminating no longer
      deletes the second socket's entry.

    - The GenServer monitors every registered pid. If a socket process crashes
      before its terminate/2 callback fires (abnormal exit, VM fault), the
      {:DOWN} message cleans up the stale ETS entry. WebSock's terminate/2
      should always run, but the monitor closes the gap for free.
  """

  use GenServer

  @table :gateway_connections

  # ---------------------------------------------------------------------------
  # Client API
  # ETS reads/writes happen in the calling process — no GenServer round-trip
  # on the hot path. Only monitor bookkeeping goes through the GenServer.
  # ---------------------------------------------------------------------------

  def start_link(_opts), do: GenServer.start_link(__MODULE__, [], name: __MODULE__)

  @spec register(String.t(), String.t(), pid()) :: :ok
  def register(user_id, device_id, pid)
      when is_binary(user_id) and is_binary(device_id) and is_pid(pid) do
    :ets.insert(@table, {{user_id, device_id, pid}, :registered})
    # Fire-and-forget cast — the ETS insert already happened.
    # GenServer will monitor the pid and clean up the row if it crashes.
    GenServer.cast(__MODULE__, {:monitor, user_id, device_id, pid})
    :ok
  end

  # Removes exactly the row for this {userId, deviceId, pid}.
  # All other pids for the same {userId, deviceId} are unaffected.
  @spec unregister(String.t(), String.t(), pid()) :: :ok
  def unregister(user_id, device_id, pid)
      when is_binary(user_id) and is_binary(device_id) and is_pid(pid) do
    :ets.delete(@table, {user_id, device_id, pid})
    :ok
  end

  # All pids currently registered for a specific {userId, deviceId} pair.
  # Normally 0 or 1 entries; may be >1 transiently during reconnect overlap.
  @spec lookup(String.t(), String.t()) :: [pid()]
  def lookup(user_id, device_id) do
    :ets.match_object(@table, {{user_id, device_id, :_}, :_})
    |> Enum.map(fn {{_uid, _did, pid}, _} -> pid end)
  end

  # All {deviceId, pid} pairs for every socket belonging to a user.
  # Used by EventDispatcher to fan out a pub/sub event to all of a user's
  # connected sockets regardless of device.
  @spec lookup_all_for_user(String.t()) :: [{String.t(), pid()}]
  def lookup_all_for_user(user_id) do
    :ets.match_object(@table, {{user_id, :_, :_}, :_})
    |> Enum.map(fn {{_uid, device_id, pid}, _} -> {device_id, pid} end)
  end

  # ---------------------------------------------------------------------------
  # GenServer callbacks — monitor lifecycle only
  # ---------------------------------------------------------------------------

  @impl true
  def init(_) do
    :ets.new(@table, [
      :named_table,
      :public,
      :set,
      read_concurrency: true,
      write_concurrency: true
    ])

    {:ok, %{monitors: %{}}}
  end

  @impl true
  def handle_cast({:monitor, user_id, device_id, pid}, %{monitors: monitors} = state) do
    ref = Process.monitor(pid)
    {:noreply, %{state | monitors: Map.put(monitors, ref, {user_id, device_id, pid})}}
  end

  # Socket process exited — remove its ETS row.
  # This fires even for normal exits, so it duplicates the unregister/3 call
  # from terminate/2. :ets.delete on a missing key is a safe no-op.
  @impl true
  def handle_info({:DOWN, ref, :process, _pid, _reason}, %{monitors: monitors} = state) do
    case Map.pop(monitors, ref) do
      {{user_id, device_id, pid}, new_monitors} ->
        :ets.delete(@table, {user_id, device_id, pid})
        {:noreply, %{state | monitors: new_monitors}}

      {nil, _} ->
        {:noreply, state}
    end
  end

  def handle_info(_msg, state), do: {:noreply, state}
end
