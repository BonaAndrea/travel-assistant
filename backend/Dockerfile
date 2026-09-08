FROM node:20-slim

# Prisma richiede OpenSSL per generare/eseguire correttamente gli engine binari
RUN apt-get update -y && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
RUN npm install

COPY . .

RUN npx prisma generate

EXPOSE 4000

CMD ["sh", "-c", "npx prisma db push --accept-data-loss && npm start"]
