# Dockerfile
FROM node:20-alpine

WORKDIR /app

# Copy only manifest(s) first for better caching
COPY package.json ./

# Create a lockfile, then install prod deps only
RUN npm i --package-lock-only \
 && npm ci --omit=dev

# Now copy the app code
COPY index.mjs ./

ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "index.mjs"]