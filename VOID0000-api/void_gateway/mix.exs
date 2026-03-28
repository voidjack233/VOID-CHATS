defmodule VoidGateway.MixProject do
  use Mix.Project

  def project do
    [
      app: :void_gateway,
      version: "0.1.0",
      elixir: "~> 1.16",
      elixirc_paths: elixirc_paths(Mix.env()),
      start_permanent: Mix.env() == :prod,
      deps: deps()
    ]
  end

  def application do
    [
      mod: {VoidGateway.Application, []},
      extra_applications: [:logger, :runtime_tools, :crypto]
    ]
  end

  defp elixirc_paths(:test), do: ["lib", "test/support"]
  defp elixirc_paths(_), do: ["lib"]

  defp deps do
    [
      # HTTP server + WebSocket upgrade
      {:phoenix, "~> 1.7"},
      {:plug_cowboy, "~> 2.7"},
      # WebSock behaviour adapter for Cowboy — handles raw WS frames
      {:websock_adapter, "~> 0.5"},
      # Valkey/Redis client — command pool + pub/sub
      {:redix, "~> 1.5"},
      # JSON
      {:jason, "~> 1.4"},
      # JWT verification (HS256). Node uses the same ACCESS_SECRET.
      # Phoenix never issues tokens — only reads them.
      {:jose, "~> 1.11"}
    ]
  end
end
