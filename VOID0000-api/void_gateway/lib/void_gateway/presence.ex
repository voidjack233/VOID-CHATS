defmodule VoidGateway.Presence do
  require Logger

  # Define attributes before @moduledoc so interpolation resolves at compile time.
  @presence_key_prefix "presence:"
  @presence_count_key_prefix "presence_count:"
  # 30 days — mirrors PRESENCE_SNAPSHOT_TTL = 60 * 60 * 24 * 30 in gateway/index.js
  @presence_snapshot_ttl 2_592_000

  @moduledoc """
  Valkey presence state for the Phoenix gateway.

  Mirrors persistPresenceSnapshot() / syncSharedPresence() from gateway/index.js.

  Key shapes (match gateway/index.js and gateway/client.js exactly):
    presence:{userId}       — JSON {status, lastActive, activeCount}, TTL #{@presence_snapshot_ttl}s
    presence_count:{userId} — string integer, same TTL

  Both keys are read by getLiveUserPresence() in gateway/client.js (REST path), so
  correct presence state here means REST callers also see live presence correctly.

  ## Presence fanout

  Phoenix cannot resolve friend IDs (Postgres boundary). Instead, `publish_change/3`
  publishes a signal to the `void:presence_change` Valkey channel. A Node subscriber
  (`server/gateway/presence-fanout.js`) picks it up, resolves friends from Postgres,
  and republishes individual PRESENCE_UPDATE events to `void:gateway`, which Phoenix
  fans out via the existing EventDispatcher path.
  """

  @presence_change_channel "void:presence_change"

  # ---------------------------------------------------------------------------
  # Public API
  # ---------------------------------------------------------------------------

  @doc """
  Write both presence keys to Valkey.

  Mirrors persistPresenceSnapshot(userId, presence, activeCount) in gateway/index.js.
  Uses pipeline to write both keys in one round-trip.
  """
  @spec write(String.t(), String.t(), integer() | nil, non_neg_integer()) :: :ok
  def write(user_id, status, last_active_ms, active_count) do
    presence_key = @presence_key_prefix <> user_id
    count_key = @presence_count_key_prefix <> user_id
    ttl = "#{@presence_snapshot_ttl}"

    value =
      Jason.encode!(%{
        status: status,
        lastActive: last_active_ms,
        activeCount: active_count
      })

    case Redix.pipeline(:redix, [
           ["SET", presence_key, value, "EX", ttl],
           ["SET", count_key, "#{active_count}", "EX", ttl]
         ]) do
      {:ok, _} ->
        :ok

      {:error, err} ->
        Logger.error("[Presence] write error user=#{user_id}: #{inspect(err)}")
        # Non-fatal — REST reads may be stale but the socket continues.
        :ok
    end
  end

  @doc """
  Publish a presence-change signal to `void:presence_change`.

  Node subscribes to this channel, resolves friend IDs from Postgres, and
  republishes individual PRESENCE_UPDATE events to `void:gateway`.

  Fire-and-forget — if Node is down or Valkey errors, the signal is lost.
  REST presence reads are still accurate (Valkey keys are already written).
  """
  @spec publish_change(String.t(), String.t(), integer()) :: :ok
  def publish_change(user_id, status, last_active_ms) do
    payload =
      Jason.encode!(%{
        userId: user_id,
        status: status,
        lastActive: last_active_ms
      })

    case Redix.command(:redix, ["PUBLISH", @presence_change_channel, payload]) do
      {:ok, _receivers} -> :ok
      {:error, err} ->
        Logger.error("[Presence] publish_change error user=#{user_id}: #{inspect(err)}")
        :ok
    end
  end

  @doc """
  Read the current presence snapshot for a user.

  Returns {:ok, map} with keys "status", "lastActive", "activeCount",
  or {:error, :not_found | reason}.

  Used on RESUME (to decide idle/online) and on socket teardown (to recover
  lastActive before writing offline state).
  """
  @spec get(String.t()) :: {:ok, map()} | {:error, atom() | any()}
  def get(user_id) do
    key = @presence_key_prefix <> user_id

    case Redix.command(:redix, ["GET", key]) do
      {:ok, nil} ->
        {:error, :not_found}

      {:ok, raw} ->
        case Jason.decode(raw) do
          {:ok, map} -> {:ok, map}
          {:error, _} -> {:error, :invalid_json}
        end

      {:error, err} ->
        {:error, err}
    end
  end
end
