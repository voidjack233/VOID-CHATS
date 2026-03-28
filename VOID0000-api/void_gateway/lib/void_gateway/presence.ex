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

  ## Presence fanout gap

  PRESENCE_UPDATE events to friends are NOT published from this module.
  Friend resolution requires a Postgres query (friendships table). Phoenix has
  no Postgres access — keeping DB logic in Node is an explicit boundary.

  The result: connected friends will not receive real-time PRESENCE_UPDATE pushes
  for presence changes that originate from Phoenix sockets. The Valkey keys ARE
  correct, so any REST call (e.g. getLiveUserPresence) returns accurate state,
  and friends who reconnect will see the right presence.

  To close this gap properly, one of the following is needed (future work):
    a. A dedicated Node API worker subscriber on a separate Pub/Sub channel that
       handles a \"broadcastPresenceUpdate\" command, resolving friends via Postgres
       and calling publishToGateway() per friend.
    b. A Node internal REST endpoint that Phoenix calls after writing presence,
       which performs the fan-out.
    c. Storing the friend list in Valkey (e.g. friends:{userId} Set) so Phoenix
       can resolve it directly without Postgres.
  """

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
