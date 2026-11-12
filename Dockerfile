FROM node:22-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
ENV PORT=8080
CMD ["npx", "tsx", "src/server.ts"]
