FROM node:20-alpine

WORKDIR /app

RUN apk add --no-cache \
    git \
    ffmpeg \
    python3 \
    make \
    g++

COPY package*.json ./

RUN npm install

COPY src ./src

RUN mkdir -p /app/sessions /app/media

EXPOSE 3000

CMD ["node", "src/index.js"]
