# ใช้ Node.js LTS
FROM node:18-alpine

# สร้าง working directory
WORKDIR /usr/src/app

# copy package.json + lockfile
COPY package*.json ./

# install dependencies
RUN npm install --omit=dev

# copy source code
COPY . .

# build NestJS
RUN npm run build

# set env PORT (Cloud Run จะกำหนดให้)
ENV PORT=8080

# run app
CMD ["node", "dist/main.js"]
