FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production DATA_DIR=/data
COPY package.json ./
COPY server.js ./
COPY public ./public
EXPOSE 3000
CMD ["node", "--disable-warning=ExperimentalWarning", "server.js"]
