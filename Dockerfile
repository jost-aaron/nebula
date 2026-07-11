FROM node:25-alpine

WORKDIR /app

RUN apk add --no-cache ffmpeg

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

EXPOSE 5173

CMD ["npm", "run", "dev", "--", "--host", "0.0.0.0"]
