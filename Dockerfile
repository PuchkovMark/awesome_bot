FROM node:22-alpine AS builder
WORKDIR /usr/src/app

# Install deps (including dev for build)
COPY package.json package-lock.json* ./
RUN npm ci

# Copy source
COPY . .

# Generate prisma client and build
RUN npx prisma generate
RUN npm run build

FROM node:22-alpine AS runtime
WORKDIR /usr/src/app

# Copy production deps and built files from builder
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

COPY --from=builder /usr/src/app/dist ./dist
COPY prisma ./prisma
COPY .env ./.env

ENV NODE_ENV=production

EXPOSE 3000
CMD ["node", "./dist/bootstrap.js"]
