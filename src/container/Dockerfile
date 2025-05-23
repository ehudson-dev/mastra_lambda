FROM public.ecr.aws/lambda/nodejs:20

# Install system dependencies for Chromium
RUN dnf update -y && \
    dnf install -y \
    chromium \
    nss \
    freetype \
    freetype-devel \
    harfbuzz \
    ca-certificates \
    fontconfig \
    wqy-zenhei-fonts \
    && dnf clean all

# Set Chromium path for Playwright
ENV PLAYWRIGHT_BROWSERS_PATH=/usr/bin
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium-browser

# Copy package files first for better Docker layer caching
COPY package*.json tsconfig.json ${LAMBDA_TASK_ROOT}/

# Install ALL dependencies (including devDependencies for TypeScript compilation)
RUN npm ci --no-audit --no-fund

# Copy TypeScript source files
COPY *.ts ${LAMBDA_TASK_ROOT}/

# Compile TypeScript to JavaScript
RUN npm run build

# Remove devDependencies to reduce final image size (optional)
RUN npm prune --production

# Set the CMD to your compiled handler
CMD ["index.handler"]