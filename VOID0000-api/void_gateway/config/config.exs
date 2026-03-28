import Config

# Use Cowboy2 adapter (required for WebSockAdapter)
config :void_gateway, VoidGatewayWeb.Endpoint,
  adapter: Phoenix.Endpoint.Cowboy2Adapter,
  server: true

config :phoenix, :json_library, Jason
