# Use Node
FROM node:18-alpine

WORKDIR /usr/src/app

COPY package*.json ./

# ✅ Install all deps (not omit dev)
RUN npm install

COPY . .

RUN npm run build

ENV PORT=8080

CMD ["node", "dist/main.js"]
