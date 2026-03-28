defmodule VoidGateway.EventDispatcher do
  @moduledoc """
  Routes decoded void:gateway pub/sub messages to the correct socket processes.

  Replaces the message handler body inside gateway-server.js initSubscriber().

  Handles:
    - Direct user events  { event, targetUserId, data }
        → sends {:push_event, event, data} to all socket pids for that user;
          each socket assigns its own sequence number and buffers the encoded frame
    - disconnectSession command
        → sends {:disconnect, code, reason} to targeted socket pids;
          deviceId nil = all sockets for that user
    - updateTokenExpiry command
        → sends {:update_token_expiry, new_exp} to targeted socket pids;
          deviceId nil = all sockets for that user
    - invalidateFriendCachePair command
        → silently dropped; Phoenix has no friend cache
    - broadcastToFriends message shape
        → removed from the protocol in Phase 2 Node flattening;
          this clause is a safety net that logs and drops any stale messages
          from a Node process that hasn't restarted yet

  Op 0 is OP.EVENT in the Node gateway protocol (gateway/index.js OP constants).
  The payload sent to socket pids is pre-encoded JSON so socket processes
  can forward it directly without re-encoding.
  """

  require Logger
  alias VoidGateway.ConnectionRegistry

  @spec dispatch(map()) :: :ok

  # ---------------------------------------------------------------------------
  # Direct user event — fan out to all sockets for that user
  # ---------------------------------------------------------------------------

  def dispatch(%{"targetUserId" => user_id, "event" => event, "data" => data})
      when is_binary(user_id) and is_binary(event) do
    sockets = ConnectionRegistry.lookup_all_for_user(user_id)

    if sockets == [] do
      Logger.debug("[EventDispatcher] No live connections for #{user_id}, dropping #{event}")
    else
      Enum.each(sockets, fn {_device_id, pid} ->
        send(pid, {:push_event, event, data})
      end)

      :telemetry.execute(
        [:void_gateway, :event, :fanout],
        %{},
        %{event: event, user_id: user_id, sockets: length(sockets)}
      )
    end

    :ok
  end

  # ---------------------------------------------------------------------------
  # Commands
  # ---------------------------------------------------------------------------

  # disconnectSession — close one device or all devices for a user.
  # Mirrors disconnectUserSession() in gateway/index.js:
  #   deviceId nil → disconnect all sockets for userId
  #   deviceId string → disconnect only that device's sockets
  def dispatch(%{
        "type" => "command",
        "command" => "disconnectSession",
        "data" => %{"userId" => user_id} = data
      })
      when is_binary(user_id) do
    device_id = data["deviceId"]
    code = data["code"] || 4001
    reason = data["reason"] || "Session revoked"

    pids = resolve_pids(user_id, device_id)

    Enum.each(pids, fn pid -> send(pid, {:disconnect, code, reason}) end)

    :telemetry.execute(
      [:void_gateway, :command, :disconnect_session],
      %{},
      %{user_id: user_id, targets: length(pids)}
    )

    :ok
  end

  # updateTokenExpiry — update token expiry on one device or all devices.
  # Mirrors updateTokenExpiry() in gateway/index.js.
  def dispatch(%{
        "type" => "command",
        "command" => "updateTokenExpiry",
        "data" => %{"userId" => user_id, "newExp" => new_exp} = data
      })
      when is_binary(user_id) and is_integer(new_exp) do
    device_id = data["deviceId"]
    pids = resolve_pids(user_id, device_id)

    Enum.each(pids, fn pid -> send(pid, {:update_token_expiry, new_exp}) end)

    :telemetry.execute(
      [:void_gateway, :command, :update_token_expiry],
      %{},
      %{user_id: user_id, targets: length(pids)}
    )

    :ok
  end

  # invalidateFriendCachePair — Phoenix has no friend cache; safely ignored.
  def dispatch(%{"type" => "command", "command" => "invalidateFriendCachePair"}) do
    :ok
  end

  # Unknown command — log and drop
  def dispatch(%{"type" => "command", "command" => cmd}) do
    Logger.debug("[EventDispatcher] Unknown command #{cmd}, dropping")
    :ok
  end

  # broadcastToFriends — removed from the void:gateway protocol in Phase 2.
  # Node now resolves friend IDs before publishing (client.js). This clause
  # catches any stale messages from a Node process that hasn't restarted yet.
  def dispatch(%{"type" => "broadcastToFriends", "userId" => user_id, "event" => event}) do
    Logger.warning(
      "[EventDispatcher] Stale broadcastToFriends from #{user_id} for #{event} " <>
        "— Node client.js should have flattened this. Is Node restarted?"
    )

    :ok
  end

  def dispatch(message) do
    Logger.warning("[EventDispatcher] Unknown message shape: #{inspect(message)}")
    :ok
  end

  # ---------------------------------------------------------------------------
  # Private
  # ---------------------------------------------------------------------------

  # Returns pids for a specific device, or all pids for the user if device_id is nil.
  defp resolve_pids(user_id, nil) do
    ConnectionRegistry.lookup_all_for_user(user_id)
    |> Enum.map(fn {_device_id, pid} -> pid end)
  end

  defp resolve_pids(user_id, device_id) when is_binary(device_id) do
    ConnectionRegistry.lookup(user_id, device_id)
  end
end
