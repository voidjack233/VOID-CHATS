FROM node:24-bookworm-slim

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    g++ \
    libcairo2-dev \
    libgif-dev \
    libjpeg62-turbo-dev \
    libpango1.0-dev \
    librsvg2-dev \
    make \
    pkg-config \
    python3 \
  && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci --legacy-peer-deps

COPY . .

EXPOSE 3001

CMD ["npm", "run", "dev"]
