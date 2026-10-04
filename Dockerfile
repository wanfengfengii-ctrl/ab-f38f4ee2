FROM node:22-alpine

WORKDIR /app

# Zero runtime dependencies, so there is no install step; copying the lock-free
# package manifest still documents the contract.
COPY package.json ./
COPY src ./src
COPY scripts ./scripts
COPY test ./test

ENV NODE_ENV=production
EXPOSE 3000

CMD ["node", "src/server.js"]
