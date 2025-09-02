# Use Node.js 20 Alpine for smaller image size
FROM node:20-alpine

# Install build dependencies for native modules
RUN apk add --no-cache python3 make g++

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./
COPY tsconfig.json ./

# Install dependencies
RUN npm ci --only=production && \
    npm install -D typescript tsx @types/node

# Copy source code
COPY src ./src
COPY contracts ./contracts
COPY .env ./

# Create non-root user for security
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001
USER nodejs

# Run the keeper bot
CMD ["npm", "run", "keeper"]