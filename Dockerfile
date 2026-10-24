FROM node:22-alpine AS web-builder
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci --registry=https://registry.npmmirror.com --no-audit --no-fund
COPY web/ ./
RUN npm run build

FROM gogost/gost:3.3.1 AS gost-bin

FROM node:22-alpine
RUN apk add --no-cache tzdata
ENV TZ=Asia/Shanghai

WORKDIR /app
COPY --from=gost-bin /bin/gost /usr/local/bin/gost
COPY server/app.js ./
COPY --from=web-builder /web/dist ./public

ENV PANEL_PORT=8080 \
    GOST_MANAGED=1 \
    GOST_CONFIG=/etc/gost/gost.yml \
    GOST_API=http://127.0.0.1:18080 \
    GOST_METRICS=http://127.0.0.1:9000/metrics \
    DATA_DIR=/data \
    PORT_RANGE_START=18100 \
    PORT_RANGE_END=18199

RUN mkdir -p /data /etc/gost

EXPOSE 8080
EXPOSE 18100-18199

CMD ["node", "app.js"]
