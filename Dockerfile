FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
COPY . .
RUN npm ci --omit=dev
USER node
EXPOSE 4000
CMD ["npm", "start"]
