FROM node:20-alpine AS build

WORKDIR /app

COPY package.json package-lock.json ./
COPY vendor ./vendor
RUN npm ci

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build


FROM node:20-alpine AS runtime

LABEL org.opencontainers.image.title="Tyr Admission Controller" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.source="https://github.com/mofluxhq/tyr-admission-controller"

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
COPY vendor ./vendor
RUN npm ci --omit=dev && npm cache clean --force

COPY LICENSE.txt NOTICE.txt THIRD_PARTY_NOTICES.txt ./
COPY --from=build /app/dist ./dist

USER node
EXPOSE 8787

CMD ["node", "dist/index.js"]
