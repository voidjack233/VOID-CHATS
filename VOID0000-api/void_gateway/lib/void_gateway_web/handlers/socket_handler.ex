defmodule VoidGatewayWeb.Handlers.SocketHandler do
  @moduledoc """
  WebSocket handler implementing the void gateway protocol.

  Replaces the wss.on('connection', ...) handler and opcode dispatch
  in gateway/index.js.

  State machine:
    :awaiting_identify  — HELLO sent, waiting for IDENTIFY or RESUME (10s timeout)
    :identified         — registered in ConnectionRegistry, receives pushed events

  Implements:
    - HELLO on connect (op 10)
    - IDENTIFY: session registration, sessmeta persist, event buffer init,
      presence write (op 2)
    - RESUME: sessmeta validation, buffer replay, gap detection, presence write (op 6) → RESUMED (op 7)
    - HEARTBEAT → HEARTBEAT_ACK: sessmeta TTL refresh, presence lastActive refresh (op 1 → op 3)
    - STATUS_UPDATE: presence status change, Valkey write (op 4)
    - Direct event fanout via {:push_event, event, data}
      Each socket assigns its own monotonic sequence number and buffers the event.
    - Token expiry warning (TOKEN_EXPIRING) and expiry close
    - {:update_token_expiry, new_exp} — reschedules token expiry timers
    - {:disconnect, code, reason} — closes socket on Node command
    - Socket teardown: presence offline write when last socket disconnects

  Opcode constants match gateway/index.js OP:
    EVENT = 0, HEARTBEAT = 1, IDENTIFY = 2, HEARTBEAT_ACK = 3,
    STATUS_UPDATE = 4, RESUME = 6, RESUMED = 7, HELLO = 10

  Close codes match gateway/index.js CLOSE:
    AUTH_TIMEOUT = 4000, UNAUTHORIZED = 4001, PROTOCOL_ERROR = 4002,
    INVALID_SESSION = 4007

  Session buffer:
    sess:{session_id}     — outbound events (max 256, TTL 300s)
    sessmeta:{session_id} — {userId, deviceId, clientInstanceId} (TTL 300s)

  Presence:
    presence:{userId}       — JSON {status, lastActive, activeCount}, TTL 30 days
    presence_count:{userId} — string integer, TTL 30 days
    Written on IDENTIFY, RESUME, HEARTBEAT, STATUS_UPDATE, and teardown.
    PRESENCE_UPDATE fanout to friends is NOT implemented (see VoidGateway.Presence docs).
  """

  @behaviour WebSock

  require Logger

  alias VoidGateway.ConnectionRegistry
  alias VoidGateway.Presence
  alias VoidGateway.SessionBuffer

  # Opcodes (mirror gateway/index.js OP constants)
  @op_event 0
  @op_heartbeat 1
  @op_identify 2
  @op_heartbeat_ack 3
  @op_status_update 4
  @op_resume 6
  @op_resumed 7
  @op_hello 10

  # Close codes (mirror gateway/index.js CLOSE constants)
  @close_auth_timeout 4000
  @close_unauthorized 4001
  @close_protocol_error 4002
  @close_invalid_session 4007
  @close_session_replaced 4009

  # Timings (match gateway/index.js)
  @heartbeat_interval_ms 30_000
  @identify_timeout_ms 10_000
  # Seconds before token expiry to send TOKEN_EXPIRING warning (matches Node's notifyBefore = 120)
  @notify_before_secs 120
  @type state :: %{
          status: :awaiting_identify | :identified,
          user_id: String.t(),
          device_id: String.t(),
          token_exp: integer(),
          session_id: String.t() | nil,
          client_instance_id: String.t() | nil,
          # Monotonic per-socket sequence counter.
          # Incremented on every outbound EVENT frame and stored in the Valkey buffer.
          seq: non_neg_integer(),
          identify_timer_ref: reference() | nil,
          token_expiry_warning_ref: reference() | nil,
          token_expiry_close_ref: reference() | nil
        }

  # ---------------------------------------------------------------------------
  # WebSock callbacks
  # ---------------------------------------------------------------------------

  # Called immediately after WebSocket upgrade completes.
  # auth comes from GatewayUpgrade via WebSockAdapter.upgrade/4.
  @impl WebSock
  def init(%{user_id: user_id, device_id: device_id, token_exp: token_exp}) do
    identify_timer = Process.send_after(self(), :identify_timeout, @identify_timeout_ms)

    state = %{
      status: :awaiting_identify,
      user_id: user_id,
      device_id: device_id,
      token_exp: token_exp,
      session_id: nil,
      client_instance_id: nil,
      seq: 0,
      identify_timer_ref: identify_timer,
      token_expiry_warning_ref: nil,
      token_expiry_close_ref: nil
    }

    :telemetry.execute(
      [:void_gateway, :socket, :connect],
      %{},
      %{user_id: user_id, device_id: device_id}
    )

    # Send HELLO immediately. Client must respond with IDENTIFY or RESUME within 10 seconds.
    hello = encode!(%{op: @op_hello, d: %{heartbeat_interval: @heartbeat_interval_ms}})
    {:push, {:text, hello}, state}
  end

  # Incoming WebSocket text frame
  @impl WebSock
  def handle_in({data, [opcode: :text]}, state) do
    case Jason.decode(data) do
      {:ok, msg} -> dispatch_opcode(msg, state)
      {:error, _} -> do_close(state, @close_protocol_error, "Invalid JSON")
    end
  end

  # Binary frames are not used in this protocol
  def handle_in({_data, _opts}, state) do
    do_close(state, @close_protocol_error, "Unsupported frame type")
  end

  # ---------------------------------------------------------------------------
  # handle_info
  # ---------------------------------------------------------------------------

  # Identify timeout — client did not send IDENTIFY or RESUME in time
  @impl WebSock
  def handle_info(:identify_timeout, %{status: :awaiting_identify} = state) do
    do_close(state, @close_auth_timeout, "Identify timeout")
  end

  # Timeout fired after already identified — safe to ignore
  def handle_info(:identify_timeout, state), do: {:ok, state}

  # Direct event from EventDispatcher.
  # Assigns the next sequence number, encodes the frame, buffers it in Valkey,
  # then pushes it to the client.
  def handle_info({:push_event, event, data}, %{status: :identified} = state) do
    {payload, new_state} = push_event(event, data, state)
    {:push, {:text, payload}, new_state}
  end

  # Drop events for sockets that haven't completed IDENTIFY/RESUME yet
  def handle_info({:push_event, _event, _data}, state), do: {:ok, state}

  # TOKEN_EXPIRING warning — notify the client that its token is about to expire.
  # Matches Node's setupTokenExpiryNotification() TOKEN_EXPIRING dispatch.
  # The client should use this to trigger a silent token refresh.
  def handle_info({:token_expiring_warning, expires_in}, %{status: :identified} = state) do
    {payload, new_state} =
      push_event(
        "TOKEN_EXPIRING",
        %{expires_in: expires_in, timestamp: System.system_time(:millisecond)},
        state
      )

    {:push, {:text, payload}, new_state}
  end

  # Token hard expiry — close the socket.
  # Matches Node's tokenExpiryTimer callback: closeSocket(ws, CLOSE.UNAUTHORIZED, 'Token expired').
  def handle_info(:token_expired, state) do
    do_close(state, @close_unauthorized, "Token expired")
  end

  # Node issued a new token (refresh) and is syncing the expiry to live sockets.
  # Matches the updateTokenExpiry command dispatched by gateway/control.js syncLiveTokenExpiry().
  # Cancel old timers, update token_exp, reschedule.
  def handle_info({:update_token_expiry, new_exp}, state) when is_integer(new_exp) do
    new_state = %{state | token_exp: new_exp} |> setup_token_expiry()
    {:ok, new_state}
  end

  # Node commanded this socket to close (logout, session revoke, membership removal, etc.).
  # Matches the disconnectSession command dispatched via gateway/control.js disconnectLiveSession().
  # Graceful drain: push SHUTDOWN event so the client can schedule a clean
  # reconnect, then let the normal OTP shutdown close this socket.
  # The frontend handler (gateway.ts) reads d.in as the reconnect delay,
  # marks the session resumable, and reconnects after the delay.
  def handle_info({:shutdown_event, delay_ms}, %{status: :identified} = state) do
    {payload, new_state} = push_event("SHUTDOWN", %{in: delay_ms}, state)
    {:push, {:text, payload}, new_state}
  end

  def handle_info({:shutdown_event, _delay_ms}, state), do: {:ok, state}

  def handle_info({:disconnect, code, reason}, state) do
    do_close(state, code, reason)
  end

  def handle_info(msg, state) do
    Logger.debug("[SocketHandler] Unhandled info: #{inspect(msg)}")
    {:ok, state}
  end

  # Clean up on socket close for any reason.
  #
  # After unregistering from ConnectionRegistry, checks how many sockets remain
  # for this user. Mirrors handleDisconnect() in gateway/index.js:
  #   - remaining > 0 → update presence_count key (keep status/lastActive)
  #   - remaining == 0 → mark offline (keep lastActive from snapshot)
  #
  # Note: PRESENCE_UPDATE fanout to friends on offline is not implemented.
  # Friend IDs require Postgres; see VoidGateway.Presence for details.
  @impl WebSock
  def terminate(_reason, state) do
    cancel_token_timers(state)

    if state.status == :identified do
      ConnectionRegistry.unregister(state.user_id, state.device_id, self())

      remaining = length(ConnectionRegistry.lookup_all_for_user(state.user_id))

      if remaining == 0 do
        # Last socket for this user — write offline.
        # Recover lastActive from the Valkey snapshot so it persists correctly.
        # Mirrors: syncSharedPresence(userId, {status: 'offline', lastActive: ...})
        last_active =
          case Presence.get(state.user_id) do
            {:ok, %{"lastActive" => la}} when is_integer(la) -> la
            _ -> System.system_time(:millisecond)
          end

        Presence.write(state.user_id, "offline", last_active, 0)
        Presence.publish_change(state.user_id, "offline", last_active)
      else
        # Other sockets remain — always rewrite with the new count and a normalized status.
        # Mirrors syncSharedPresence() in index.js line 1183: always rewrites count;
        # normalizedStatus = activeCount > 0 ? (idle ? 'idle' : 'online') : 'offline'.
        # Since remaining > 0 here, offline is impossible — idle stays idle, everything
        # else (offline, unknown, missing snapshot) defaults to online.
        {status, last_active} =
          case Presence.get(state.user_id) do
            {:ok, %{"status" => "idle", "lastActive" => la}} ->
              {"idle", la || System.system_time(:millisecond)}

            {:ok, %{"lastActive" => la}} ->
              {"online", la || System.system_time(:millisecond)}

            _ ->
              {"online", System.system_time(:millisecond)}
          end

        Presence.write(state.user_id, status, last_active, remaining)
      end
    end

    :ok
  end

  # ---------------------------------------------------------------------------
  # Opcode dispatch
  # ---------------------------------------------------------------------------

  # IDENTIFY — only valid in :awaiting_identify state
  defp dispatch_opcode(
         %{"op" => @op_identify, "d" => d},
         %{status: :awaiting_identify} = state
       ) do
    case validate_identify(d, state) do
      {:ok, client_instance_id} ->
        if state.identify_timer_ref, do: Process.cancel_timer(state.identify_timer_ref)

        session_id = generate_session_id()

        # Register this socket process in the connection registry.
        # EventDispatcher will use this to deliver events to this user/device.
        # Returns pids of stale sockets with the same clientInstanceId (same-tab dedupe).
        displaced =
          ConnectionRegistry.register(state.user_id, state.device_id, client_instance_id, self())

        # Close displaced sockets with 4009 SESSION_REPLACED.
        # This only fires when userId + deviceId + clientInstanceId all match,
        # so parallel sessions from different tabs/devices are unaffected.
        for pid <- displaced do
          send(pid, {:disconnect, @close_session_replaced, "Session replaced"})
        end

        # Persist session metadata and clear any stale event buffer.
        # Matches handleIdentify() in gateway/index.js:
        #   persistSessionIdentity(sessionId, userId, deviceId, clientInstanceId)
        #   valkey.del(sessionKey(sessionId))
        SessionBuffer.persist_meta(session_id, state.user_id, state.device_id, client_instance_id)
        SessionBuffer.delete_buffer(session_id)

        # Write presence: user is now online.
        # Mirrors: syncSharedPresence(userId, { status: 'online', lastActive: Date.now() })
        # Subtract displaced sockets — they're still in ETS but about to terminate.
        now_ms = System.system_time(:millisecond)

        active_count =
          length(ConnectionRegistry.lookup_all_for_user(state.user_id)) - length(displaced)

        Presence.write(state.user_id, "online", now_ms, active_count)
        Presence.publish_change(state.user_id, "online", now_ms)

        # READY is the first event (seq 1). Build it manually because session_id
        # is not in state yet so push_event/3 cannot be used here.
        new_seq = 1

        ready_data = %{
          user_id: state.user_id,
          device_id: state.device_id,
          session_id: session_id,
          timestamp: now_ms,
          # presences is empty — Phase 3 gap. Node's handleIdentify() calls
          # getFriendPresences() which requires Postgres. Phoenix has Valkey access
          # only; clients must handle [] gracefully and rely on PRESENCE_UPDATE events.
          presences: []
        }

        ready_payload = encode!(%{op: @op_event, t: "READY", s: new_seq, d: ready_data})
        SessionBuffer.buffer_event(session_id, ready_payload)

        new_state =
          %{
            state
            | status: :identified,
              session_id: session_id,
              client_instance_id: client_instance_id,
              seq: new_seq,
              identify_timer_ref: nil
          }
          |> setup_token_expiry()

        :telemetry.execute(
          [:void_gateway, :socket, :identify],
          %{},
          %{
            user_id: state.user_id,
            device_id: state.device_id,
            session_id: session_id,
            displaced: length(displaced)
          }
        )

        {:push, {:text, ready_payload}, new_state}

      {:error, reason} ->
        Logger.debug("[SocketHandler] IDENTIFY rejected: #{reason}")
        do_close(state, @close_protocol_error, "Invalid identify")
    end
  end

  # IDENTIFY received after already identified — silently ignore (idempotent)
  defp dispatch_opcode(%{"op" => @op_identify}, state), do: {:ok, state}

  # RESUME — only valid in :awaiting_identify state.
  # Validates session identity from Valkey, replays missed events, and transitions
  # to :identified. Closes with INVALID_SESSION on any failure.
  defp dispatch_opcode(
         %{"op" => @op_resume, "d" => d},
         %{status: :awaiting_identify} = state
       ) do
    case validate_resume(d) do
      {:ok, session_id, last_sequence} ->
        do_resume(session_id, last_sequence, state)

      {:error, _} ->
        do_close(state, @close_protocol_error, "Invalid resume")
    end
  end

  # RESUME after identified — protocol error (matches Node "Unexpected resume")
  defp dispatch_opcode(%{"op" => @op_resume}, state) do
    do_close(state, @close_protocol_error, "Unexpected resume")
  end

  # HEARTBEAT (identified) — refresh sessmeta TTL + update presence lastActive.
  # Always writes 'online': HEARTBEAT acts as an active keep-alive and resets
  # idle status, matching Node's handleHeartbeat() behavior.
  # No fanout (presence fanout gap — friend IDs not available in Phoenix).
  defp dispatch_opcode(%{"op" => @op_heartbeat}, %{status: :identified} = state) do
    # Mirrors: persistSessionIdentity(sessionId, userId, deviceId, clientInstanceId)
    if state.session_id do
      SessionBuffer.persist_meta(
        state.session_id,
        state.user_id,
        state.device_id,
        state.client_instance_id
      )
    end

    # Mirrors idle→online + online lastActive refresh in handleHeartbeat().
    # We always write 'online' since heartbeats imply the client is active.
    now_ms = System.system_time(:millisecond)
    active_count = length(ConnectionRegistry.lookup_all_for_user(state.user_id))
    Presence.write(state.user_id, "online", now_ms, active_count)

    ack = encode!(%{op: @op_heartbeat_ack})
    {:push, {:text, ack}, state}
  end

  # HEARTBEAT before identified — respond with ACK, skip presence/sessmeta
  defp dispatch_opcode(%{"op" => @op_heartbeat}, state) do
    ack = encode!(%{op: @op_heartbeat_ack})
    {:push, {:text, ack}, state}
  end

  # STATUS_UPDATE (identified) — update presence status if it changed.
  # Mirrors handleStatusUpdate() in gateway/index.js.
  # Valid statuses: "online", "idle" (matches Node's VALID_STATUSES).
  # No fanout (presence fanout gap — friend IDs not available in Phoenix).
  defp dispatch_opcode(
         %{"op" => @op_status_update, "d" => d},
         %{status: :identified} = state
       ) do
    case validate_status(d) do
      {:ok, new_status} ->
        now_ms = System.system_time(:millisecond)

        case Presence.get(state.user_id) do
          {:ok, %{"status" => ^new_status}} ->
            # Same status — no-op.
            # Mirrors: if (currentPresence?.status === status) return;
            {:ok, state}

          {:ok, presence} ->
            # Status changed — update lastActive per Node's logic:
            #   lastActive = status === 'online' ? Date.now() : (currentPresence?.lastActive || Date.now())
            last_active =
              if new_status == "online" do
                now_ms
              else
                Map.get(presence, "lastActive") || now_ms
              end

            active_count = length(ConnectionRegistry.lookup_all_for_user(state.user_id))
            Presence.write(state.user_id, new_status, last_active, active_count)
            Presence.publish_change(state.user_id, new_status, last_active)

            {:ok, state}

          {:error, _} ->
            # No prior presence — write as if status changed.
            last_active = now_ms
            active_count = length(ConnectionRegistry.lookup_all_for_user(state.user_id))
            Presence.write(state.user_id, new_status, last_active, active_count)
            Presence.publish_change(state.user_id, new_status, last_active)
            {:ok, state}
        end

      {:error, _} ->
        do_close(state, @close_protocol_error, "Invalid status update")
    end
  end

  # STATUS_UPDATE before identified — protocol error.
  # Mirrors Node: if (info.state !== 'identified') throw PROTOCOL_ERROR
  defp dispatch_opcode(%{"op" => @op_status_update}, state) do
    do_close(state, @close_protocol_error, "Unexpected status update")
  end

  defp dispatch_opcode(%{"op" => _unknown_op}, state) do
    do_close(state, @close_protocol_error, "Unknown opcode")
  end

  defp dispatch_opcode(_, state) do
    do_close(state, @close_protocol_error, "Invalid payload")
  end

  # ---------------------------------------------------------------------------
  # RESUME implementation
  # ---------------------------------------------------------------------------

  defp do_resume(session_id, last_sequence, state) do
    if state.identify_timer_ref, do: Process.cancel_timer(state.identify_timer_ref)

    with {:ok, meta} <- SessionBuffer.get_meta(session_id),
         :ok <- verify_meta_identity(meta, state.user_id, state.device_id),
         {:ok, %{gap_detected: false} = replay} <-
           SessionBuffer.replay(session_id, last_sequence) do
      client_instance_id = Map.get(meta, "clientInstanceId")

      displaced =
        ConnectionRegistry.register(state.user_id, state.device_id, client_instance_id, self())

      for pid <- displaced do
        send(pid, {:disconnect, @close_session_replaced, "Session replaced"})
      end

      # Re-persist to refresh the TTL (matches handleResume() in gateway/index.js).
      SessionBuffer.persist_meta(session_id, state.user_id, state.device_id, client_instance_id)

      # Presence: read current status from Valkey to preserve idle if set.
      # Mirrors: status = currentPresence?.status === 'idle' ? 'idle' : 'online'
      # Subtract displaced sockets — they're still in ETS but about to terminate.
      now_ms = System.system_time(:millisecond)

      active_count =
        length(ConnectionRegistry.lookup_all_for_user(state.user_id)) - length(displaced)

      {resume_status, should_fanout} = resolve_resume_status(state.user_id)
      Presence.write(state.user_id, resume_status, now_ms, active_count)

      if should_fanout do
        Presence.publish_change(state.user_id, resume_status, now_ms)
      end

      # seq must be the maximum of what the client reported and what we buffered,
      # so future events continue from the right point.
      # Mirrors: liveInfo.seq = Math.max(data.last_sequence, replay.latestSequence)
      new_seq = max(last_sequence, replay.latest_seq)

      new_state =
        %{
          state
          | status: :identified,
            session_id: session_id,
            client_instance_id: client_instance_id,
            seq: new_seq,
            identify_timer_ref: nil
        }
        |> setup_token_expiry()

      :telemetry.execute(
        [:void_gateway, :socket, :resume],
        %{},
        %{
          user_id: state.user_id,
          device_id: state.device_id,
          session_id: session_id,
          replayed: length(replay.events)
        }
      )

      # Send buffered events the client missed, then RESUMED.
      # RESUMED has no sequence number (Node uses send(), not dispatch()).
      replay_frames = Enum.map(replay.events, fn raw -> {:text, raw} end)
      resumed = encode!(%{op: @op_resumed, d: %{replayed: length(replay.events)}})

      {:push, replay_frames ++ [{:text, resumed}], new_state}
    else
      {:ok, %{gap_detected: true}} ->
        :telemetry.execute(
          [:void_gateway, :socket, :resume_failed],
          %{},
          %{user_id: state.user_id, device_id: state.device_id, reason: :gap}
        )

        do_close(state, @close_invalid_session, "Resume out of date")

      _ ->
        :telemetry.execute(
          [:void_gateway, :socket, :resume_failed],
          %{},
          %{user_id: state.user_id, device_id: state.device_id, reason: :invalid_session}
        )

        do_close(state, @close_invalid_session, "Invalid session")
    end
  end

  # Meta identity check — userId and deviceId in sessmeta must match the JWT.
  # Mirrors: sessionIdentity.userId !== userId || sessionIdentity.deviceId !== deviceId
  defp verify_meta_identity(%{"userId" => uid, "deviceId" => did}, uid, did), do: :ok
  defp verify_meta_identity(_, _, _), do: {:error, :mismatch}

  # Read current Valkey presence to decide the right status on RESUME.
  # Idle is preserved; anything else (offline, unknown, missing) becomes online.
  # Returns {status, should_fanout} where should_fanout mirrors Node's condition:
  #   !currentPresence || currentPresence.status !== resumedStatus
  defp resolve_resume_status(user_id) do
    case Presence.get(user_id) do
      {:ok, %{"status" => "idle"}} -> {"idle", false}
      {:ok, %{"status" => "online"}} -> {"online", false}
      _ -> {"online", true}
    end
  end

  # ---------------------------------------------------------------------------
  # Token expiry
  # ---------------------------------------------------------------------------

  # Set up (or reschedule) token expiry timers after IDENTIFY/RESUME or updateTokenExpiry.
  # Mirrors setupTokenExpiryNotification() in gateway/index.js.
  #
  # Sends two scheduled messages:
  #   {:token_expiring_warning, expires_in} — @notify_before_secs before expiry
  #   :token_expired                        — at expiry
  defp setup_token_expiry(state) do
    cancel_token_timers(state)

    now = System.system_time(:second)
    time_until_expiry = state.token_exp - now

    cond do
      time_until_expiry <= 0 ->
        # Already expired — force close on next scheduler turn
        send(self(), :token_expired)
        %{state | token_expiry_warning_ref: nil, token_expiry_close_ref: nil}

      time_until_expiry > @notify_before_secs ->
        # Schedule warning, then close
        warn_ms = (time_until_expiry - @notify_before_secs) * 1_000

        warning_ref =
          Process.send_after(self(), {:token_expiring_warning, @notify_before_secs}, warn_ms)

        close_ref = Process.send_after(self(), :token_expired, time_until_expiry * 1_000)
        %{state | token_expiry_warning_ref: warning_ref, token_expiry_close_ref: close_ref}

      true ->
        # Already inside warning window — send warning now, schedule close
        send(self(), {:token_expiring_warning, time_until_expiry})
        close_ref = Process.send_after(self(), :token_expired, time_until_expiry * 1_000)
        %{state | token_expiry_warning_ref: nil, token_expiry_close_ref: close_ref}
    end
  end

  defp cancel_token_timers(state) do
    if state.token_expiry_warning_ref, do: Process.cancel_timer(state.token_expiry_warning_ref)
    if state.token_expiry_close_ref, do: Process.cancel_timer(state.token_expiry_close_ref)
    :ok
  end

  # ---------------------------------------------------------------------------
  # Helpers
  # ---------------------------------------------------------------------------

  # Validates the IDENTIFY payload.
  # Critically: user_id in the payload must match the user_id from the JWT
  # verified at upgrade time. This prevents a client from claiming to be
  # a different user after authentication.
  defp validate_identify(%{"user_id" => user_id} = d, %{user_id: auth_user_id})
       when is_binary(user_id) and byte_size(user_id) > 0 and byte_size(user_id) <= 64 do
    if user_id != auth_user_id do
      {:error, :user_id_mismatch}
    else
      case Map.get(d, "client_instance_id") do
        nil ->
          {:ok, nil}

        cid when is_binary(cid) and byte_size(cid) > 0 and byte_size(cid) <= 128 ->
          {:ok, cid}

        _ ->
          {:error, :invalid_client_instance_id}
      end
    end
  end

  defp validate_identify(_, _), do: {:error, :invalid_payload}

  # Validates the RESUME payload.
  # Mirrors validateResumePayload() in gateway/index.js.
  defp validate_resume(%{"session_id" => sid, "last_sequence" => last_seq})
       when is_binary(sid) and byte_size(sid) > 0 and byte_size(sid) <= 128 and
              is_integer(last_seq) and last_seq >= 0 do
    {:ok, sid, last_seq}
  end

  defp validate_resume(_), do: {:error, :invalid_payload}

  # Validates the STATUS_UPDATE payload.
  # Mirrors validateStatusPayload() in gateway/index.js.
  # Valid statuses match Node's VALID_STATUSES = new Set(['online', 'idle']).
  defp validate_status(%{"status" => status}) when status in ["online", "idle"] do
    {:ok, status}
  end

  defp validate_status(_), do: {:error, :invalid_payload}

  # Increment seq, encode an EVENT frame with the new sequence number,
  # buffer it in Valkey, and return {encoded_payload, updated_state}.
  # Used for all outbound events after IDENTIFY/RESUME.
  defp push_event(event, data, state) do
    new_seq = state.seq + 1
    payload = encode!(%{op: @op_event, t: event, s: new_seq, d: data})

    if state.session_id do
      SessionBuffer.buffer_event(state.session_id, payload)
    end

    {payload, %{state | seq: new_seq}}
  end

  defp encode!(map), do: Jason.encode!(map)

  # Send a WebSocket close frame with a custom close code before stopping.
  defp do_close(state, code, reason_str) do
    :telemetry.execute(
      [:void_gateway, :socket, :close],
      %{},
      %{user_id: state.user_id, device_id: state.device_id, code: code, reason: reason_str}
    )

    {:stop, :normal, {code, reason_str}, state}
  end

  # Session ID: 18 random bytes as base64url (24 chars).
  # Matches Node gateway SESSION_ID_BYTES = 18 and base64url encoding.
  defp generate_session_id do
    :crypto.strong_rand_bytes(18) |> Base.url_encode64(padding: false)
  end
end
