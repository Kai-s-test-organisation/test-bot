# ==== BUILD STAGE ====
# This creates a temporary container just for building your app
FROM node:18-slim AS builder
# FROM = what base image to start with (Node.js 18 on a lightweight Linux)
# AS builder = give this stage a name so we can reference it later

# Install build dependencies for native modules like better-sqlite3
RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*
# These tools are needed to compile native Node.js modules

WORKDIR /app
# WORKDIR = set the working directory inside the container
# Like doing "cd /app" - all future commands run from here

COPY package*.json ./
# COPY = copy files from your computer INTO the container
# package*.json = copies package.json and package-lock.json (if it exists)
# ./ = copy them to current directory (/app)

# Install ALL dependencies (including dev dependencies for building)
RUN npm ci
# npm ci = clean install (faster than npm install, used in production)
# We need devDependencies like TypeScript to build the app

# Copy source code
COPY . .
# Copy your source code from your computer to the container

# Build your TypeScript code
RUN npm run build
# This compiles your TypeScript to JavaScript

# Now install only production dependencies with native modules
RUN npm ci --only=production
# This rebuilds better-sqlite3 for the container's architecture

# ==== RUNTIME STAGE ====
# This creates the final container that will actually run your app
FROM node:18-slim
# Start fresh with a new clean image (throws away build tools we don't need)

WORKDIR /app
# Set working directory again in this new container

# Create a non-root user for security
RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 --gid 1001 botuser
# addgroup/adduser = create a user that's not root (safer)
# --system = system user (no login shell, no home directory)
# --gid/--uid = specific ID numbers for the user/group

# Create directory for SQLite database and set permissions
RUN mkdir -p /app/data && chown -R botuser:nodejs /app/data
# mkdir -p = create directory (and parent directories if needed)
# chown = change ownership to our botuser

# Copy package.json for the start script
COPY --from=builder /app/package.json ./package.json
# We need package.json for npm start to work

COPY --from=builder /app/node_modules ./node_modules
# COPY --from=builder = copy from the BUILD stage we named earlier
# Gets the dependencies with native modules compiled for Linux

COPY --from=builder /app/dist ./dist
# Copy the compiled JavaScript from the build stage
# No need to rebuild since we already compiled it

# Switch to non-root user
USER botuser
# USER = switch to this user for running the app (security best practice)

EXPOSE 3131
# EXPOSE = document what port your app uses (doesn't actually open it)
# This is for documentation - Kubernetes will still need to configure ports

CMD ["node", "dist/index.js"]
# CMD = the command to run when the container starts
# node dist/index.js = run your compiled JavaScript file