FROM ghcr.io/puppeteer/puppeteer:latest

ENV NODE_ENV=production

WORKDIR /usr/src/app

COPY package*.json ./
RUN npm ci

COPY . .

CMD [ "node", "index.js" ]
