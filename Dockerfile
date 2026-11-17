FROM node:26-alpine
LABEL org.opencontainers.image.source="https://github.com/OneByJorah/opentalk" \
      org.opencontainers.image.description="Free, open, no-login chat with private rooms by code" \
      org.opencontainers.image.licenses="MIT"
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server.js blocked-words.txt ./
COPY public ./public
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
CMD ["node", "server.js"]
