FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
COPY server.js ./
COPY scripts ./scripts
RUN npm ci --omit=dev
COPY . .
USER node
EXPOSE 4000
CMD ["npm", "start"]
