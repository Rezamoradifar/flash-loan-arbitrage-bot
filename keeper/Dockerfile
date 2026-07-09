FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev
COPY . .
# DRY_RUN defaults true - override with --env-file or -e DRY_RUN=false to go live.
ENV DRY_RUN=true
CMD ["npx", "tsx", "src/index.ts"]
