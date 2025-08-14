# Optional Dockerfile (Render can build without Docker too)
FROM node:20-slim

WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY config ./config

RUN npm run build
EXPOSE 3000
CMD ["npm","start"]
