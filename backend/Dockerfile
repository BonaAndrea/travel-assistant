FROM node:20-slim

# Prisma richiede OpenSSL per generare/eseguire correttamente gli engine binari
RUN apt-get update -y && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

RUN npx prisma generate

RUN mkdir -p /app/uploads && chown -R node:node /app
USER node

EXPOSE 4000

CMD ["npm", "start"]
