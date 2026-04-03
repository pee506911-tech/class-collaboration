# Specify platform for consistent behavior across architectures
FROM --platform=linux/amd64 node:20-alpine

WORKDIR /app

# Copy package files and install dependencies
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy source code
COPY src/ ./src/

# Create capture directory
RUN mkdir -p /tmp/ably-captures

# Expose port
EXPOSE 8081

# Start the stub
CMD ["npm", "start"]
