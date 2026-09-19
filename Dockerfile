FROM node:20-slim

# better-sqlite3 needs build tools to compile its native binding
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY . .

# Persistent volume mount point for the SQLite DB - see docker-compose.yml
VOLUME ["/app/data"]

ENV NODE_ENV=production
EXPOSE 4000

CMD ["sh", "-c", "node src/db/migrate.js && node src/server.js"]
