FROM elixir:1.16-otp-26

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates build-essential git \
  && rm -rf /var/lib/apt/lists/*

RUN mix local.hex --force && mix local.rebar --force

COPY mix.exs mix.lock ./
RUN mix deps.get

COPY . .

EXPOSE 4001

CMD ["mix", "phx.server"]
