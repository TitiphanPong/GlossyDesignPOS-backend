FROM node:22-alpine

WORKDIR /usr/src/app

COPY package*.json ./

# Use the committed lockfile so production installs are reproducible.
RUN npm ci

COPY . .

RUN npm run build

ENV NODE_ENV=production
ENV PORT=8080

CMD ["node", "dist/main.js"]
