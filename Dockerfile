FROM node:22-alpine AS builder
WORKDIR /usr/src/app

# Prisma needs OpenSSL at generate time to pick the right engine binary
RUN apk add --no-cache openssl

# Install deps (including dev for build)
COPY package.json package-lock.json* ./
RUN npm ci

# Copy source
COPY tsconfig.json ./
COPY prisma ./prisma
COPY src ./src

# Generate prisma client and build
RUN npx prisma generate
RUN npm run build

FROM node:22-alpine AS runtime
WORKDIR /usr/src/app

ENV NODE_ENV=production

# Runtime library required by the Prisma query engine
RUN apk add --no-cache openssl

# Production deps only
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

# Copy the client generated in the builder stage (runtime deps alone cannot generate it)
COPY --from=builder /usr/src/app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /usr/src/app/node_modules/@prisma/client ./node_modules/@prisma/client

COPY --from=builder /usr/src/app/dist ./dist
COPY prisma ./prisma

EXPOSE 3000

CMD ["node", "./dist/bootstrap.js"]
