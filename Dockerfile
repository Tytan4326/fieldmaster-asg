FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY public ./public
COPY server ./server
ENV NODE_ENV=production
EXPOSE 8080
CMD ["node", "server/index.js"]

