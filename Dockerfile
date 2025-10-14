# Use a slim Node LTS with good CA certs
FROM node:20-alpine

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --only=production

COPY index.mjs ./

ENV NODE_ENV=production
EXPOSE 3000

CMD ["node", "index.mjs"]
