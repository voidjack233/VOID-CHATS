defmodule VoidGateway.SessionBuffer do
  require Logger

  # Define attributes before @moduledoc so interpolation resolves correctly.
  @session_key_prefix "sess:"
  @session_meta_prefix "sessmeta:"
  @session_buffer_max 256
  @session_buffer_ttl 300

  @moduledoc """
  Valkey-backed session event buffer.

  Mirrors the sess:/sessmeta: buffer from gateway/index.js:

    sess:{session_id}
      RPUSH list of JSON-encoded event payloads.
      Capped at #{@session_buffer_max} entries via LTRIM.
      TTL #{@session_buffer_ttl}s, refreshed on every write.

    sessmeta:{session_id}
      JSON object: {userId, deviceId, clientInstanceId}.
      Used by RESUME to validate the claiming socket matches the JWT.
      TTL #{@session_buffer_ttl}s.

  Key-name constants match gateway/index.js exactly:
    SESSION_KEY_PREFIX   = "sess:"
    SESSION_META_PREFIX  = "sessmeta:"
    SESSION_BUFFER_MAX   = 256
    SESSION_BUFFER_TTL   = 300

  Gap detection in replay/2 mirrors replayEvents() in gateway/index.js:
    gap_detected = earliest buffered seq > last_sequence + 1
    i.e. we cannot guarantee continuity from where the client left off.
  """

  # ---------------------------------------------------------------------------
  # Event buffer
  # ---------------------------------------------------------------------------

  @doc """
  Append `payload` (JSON string) to the session buffer. Caps at
  #{@session_buffer_max} entries and refreshes the TTL. Fire-and-forget;
  errors are logged but not propagated to the caller.

  Mirrors bufferEvent() in gateway/index.js.
  """
  @spec buffer_event(String.t(), String.t()) :: :ok
  def buffer_event(session_id, payload) do
    key = @session_key_prefix <> session_id

    # Synchronous — do NOT use Task.start here.
    #
    # Each socket is a single Erlang process; handle_info is processed one
    # at a time, so successive calls from the same socket are already serialized.
    # Task.start would race two Redix pipelines, breaking LRANGE insertion order
    # and making gap detection unreliable. Node avoids the same race because
    # bufferEvent() queues Redis writes on the single JS event loop.
    case Redix.pipeline(:redix, [
           ["RPUSH", key, payload],
           ["LTRIM", key, "-#{@session_buffer_max}", "-1"],
           ["EXPIRE", key, "#{@session_buffer_ttl}"]
         ]) do
      {:ok, _} ->
        :ok

      {:error, err} ->
        # Non-fatal. Replay may be incomplete but RESUME will either replay
        # what's in the buffer or detect a gap and close with INVALID_SESSION.
        Logger.error("[SessionBuffer] buffer_event error: #{inspect(err)}")
        :ok
    end
  end

  @doc """
  Delete the event buffer for a session. Called on fresh IDENTIFY to clear
  any stale buffer that may exist for the newly generated session ID.

  Mirrors `valkey.del(sessionKey(sessionId))` in handleIdentify().
  """
  @spec delete_buffer(String.t()) :: :ok
  def delete_buffer(session_id) do
    key = @session_key_prefix <> session_id

    case Redix.command(:redix, ["DEL", key]) do
      {:ok, _} -> :ok
      {:error, _} -> :ok
    end
  end

  @doc """
  Replay buffered events since `last_sequence`.

  Returns `{:ok, result}` where result is:
    %{
      events:       [String.t()],      # pre-encoded payloads to send, in order
      gap_detected: boolean(),         # true → close with INVALID_SESSION
      latest_seq:   non_neg_integer()  # highest seq seen (or last_sequence if empty)
    }

  Returns `{:error, reason}` on Valkey failure.

  Mirrors replayEvents() in gateway/index.js.
  Gap condition: earliestBufferedSeq > last_sequence + 1.
  """
  @spec replay(String.t(), non_neg_integer()) ::
          {:ok,
           %{
             events: [String.t()],
             gap_detected: boolean(),
             latest_seq: non_neg_integer()
           }}
          | {:error, any()}
  def replay(session_id, last_sequence) do
    key = @session_key_prefix <> session_id

    case Redix.command(:redix, ["LRANGE", key, "0", "-1"]) do
      {:ok, raw_events} ->
        {:ok, process_replay(raw_events, last_sequence)}

      {:error, err} ->
        Logger.error("[SessionBuffer] replay error: #{inspect(err)}")
        {:error, err}
    end
  end

  # ---------------------------------------------------------------------------
  # Session metadata
  # ---------------------------------------------------------------------------

  @doc """
  Persist session metadata and refresh the TTL.

  Mirrors persistSessionIdentity() in gateway/index.js.
  """
  @spec persist_meta(String.t(), String.t(), String.t(), String.t() | nil) :: :ok | :error
  def persist_meta(session_id, user_id, device_id, client_instance_id \\ nil) do
    key = @session_meta_prefix <> session_id

    value =
      Jason.encode!(%{
        userId: user_id,
        deviceId: device_id,
        clientInstanceId: client_instance_id
      })

    case Redix.command(:redix, ["SET", key, value, "EX", "#{@session_buffer_ttl}"]) do
      {:ok, _} ->
        :ok

      {:error, err} ->
        Logger.error("[SessionBuffer] persist_meta error: #{inspect(err)}")
        :error
    end
  end

  @doc """
  Fetch and decode session metadata.

  Returns `{:ok, meta_map}` or `{:error, reason}`.
  Fails closed — :error is treated as invalid session by the caller.

  Mirrors getSessionIdentity() in gateway/index.js.
  """
  @spec get_meta(String.t()) :: {:ok, map()} | {:error, atom() | any()}
  def get_meta(session_id) do
    key = @session_meta_prefix <> session_id

    case Redix.command(:redix, ["GET", key]) do
      {:ok, nil} ->
        {:error, :not_found}

      {:ok, raw} ->
        case Jason.decode(raw) do
          {:ok, meta} -> {:ok, meta}
          {:error, _} -> {:error, :invalid_json}
        end

      {:error, err} ->
        {:error, err}
    end
  end

  # ---------------------------------------------------------------------------
  # Private
  # ---------------------------------------------------------------------------

  defp process_replay(raw_events, last_sequence) do
    # Parse events, keeping only those with an integer "s" field.
    # LRANGE returns entries in insertion order (oldest first = ascending seq).
    parsed =
      Enum.flat_map(raw_events, fn raw ->
        case Jason.decode(raw) do
          {:ok, %{"s" => s}} when is_integer(s) -> [{s, raw}]
          _ -> []
        end
      end)

    # Earliest seq is the first element (smallest due to insertion order).
    earliest_seq =
      case parsed do
        [{s, _} | _] -> s
        [] -> nil
      end

    latest_seq = Enum.reduce(parsed, last_sequence, fn {s, _}, acc -> max(s, acc) end)

    # Events the client hasn't seen yet, in order.
    to_replay = for {s, raw} <- parsed, s > last_sequence, do: raw

    # Gap: the oldest buffered event is past what the client last saw,
    # meaning we dropped events that the client needs for continuity.
    gap_detected = earliest_seq != nil and last_sequence < earliest_seq - 1

    %{events: to_replay, gap_detected: gap_detected, latest_seq: latest_seq}
  end
end
