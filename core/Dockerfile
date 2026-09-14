FROM node:20-alpine AS builder

WORKDIR /app

RUN corepack enable

# 构建阶段限制 Node 堆, 避免小内存机器在 tsc/vite 阶段被拖到假死(超出会明确报错而不是整机卡住)
ENV NODE_OPTIONS=--max-old-space-size=1536

COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY core/package.json ./core/
COPY web/package.json ./web/

RUN pnpm config set registry https://registry.npmmirror.com/
RUN pnpm install --frozen-lockfile

COPY core ./core
COPY web ./web

# 快速构建: 跳过 vue-tsc 类型检查(省约 500MB 内存), 构建产物随镜像固化
RUN pnpm build:web:fast

# ==========================================
FROM node:20-alpine AS prod-deps

WORKDIR /app

RUN corepack enable

COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY core/package.json ./core/
COPY web/package.json ./web/

RUN pnpm -C core install --prod --frozen-lockfile

# ==========================================

FROM node:20-alpine AS runner

WORKDIR /app/core

ENV NODE_ENV=production
ENV TZ=Asia/Shanghai

RUN apk add --no-cache tzdata && \
    cp /usr/share/zoneinfo/Asia/Shanghai /etc/localtime && \
    echo "Asia/Shanghai" > /etc/timezone && \
    apk del tzdata

COPY --from=prod-deps /app/node_modules ../node_modules/
COPY --from=prod-deps /app/core/node_modules ./node_modules/
COPY --from=prod-deps /app/package.json ../package.json

COPY --from=builder /app/core ./
COPY --from=builder /app/web/dist ../web/dist

RUN mkdir -p data/logs && chmod -R 755 data

VOLUME ["/app/core/data"]

EXPOSE 3007

HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
    CMD wget -q --spider http://localhost:3007/api/status || exit 1

CMD ["node", "client.js"]
