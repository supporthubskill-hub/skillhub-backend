FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
COPY . .
RUN npm install --omit=dev
USER node
EXPOSE 4000
CMD ["npm", "start"]
