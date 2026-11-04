FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production PORT=3060 DATA_DIR=/data
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY public ./public
COPY scripts ./scripts
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 3060
HEALTHCHECK CMD node -e "fetch('http://127.0.0.1:3060/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "src/server.js"]
