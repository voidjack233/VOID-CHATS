FROM node:24-bookworm-slim

WORKDIR /app

COPY package*.json ./
RUN npm ci --legacy-peer-deps

COPY . .

EXPOSE 5173

CMD ["npm", "run", "dev", "--", "--host", "0.0.0.0"]
