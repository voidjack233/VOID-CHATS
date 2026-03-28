import Config

# HTTP port for the WebSocket gateway.
# Must not conflict with Node's ports (default 3000/3002).
gateway_port = System.get_env("GATEWAY_PORT", "4001") |> String.to_integer()

valkey_host = System.get_env("VALKEY_HOST", "127.0.0.1")
valkey_port = System.get_env("VALKEY_PORT", "6379") |> String.to_integer()

config :void_gateway, VoidGatewayWeb.Endpoint,
  http: [ip: {0, 0, 0, 0}, port: gateway_port],
  # Required by Phoenix. Unrelated to Node's JWT secret.
  # Generate with: mix phx.gen.secret
  # PHX_SECRET_KEY_BASE is preferred so the Phoenix gateway can keep its own
  # secret separate from any other app-level secrets. SECRET_KEY_BASE remains
  # as a compatibility fallback.
  secret_key_base: System.get_env("PHX_SECRET_KEY_BASE") || System.fetch_env!("SECRET_KEY_BASE")

config :void_gateway,
  # Shared HMAC secret with Node. Phoenix only reads tokens — never issues them.
  access_secret: System.fetch_env!("ACCESS_SECRET"),
  valkey_host: valkey_host,
  valkey_port: valkey_port,
  # Origins are checked on WebSocket upgrade.
  # FRONT_URL is optional (adds dev/staging URLs dynamically).
  allowed_origins:
    [
      System.get_env("FRONT_URL"),
      "https://void0000.online",
      "http://localhost:5173",
      "http://localhost"
    ]
    |> Enum.reject(&is_nil/1)
    |> Enum.uniq()
