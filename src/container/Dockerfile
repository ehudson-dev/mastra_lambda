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

# Copy package files first for better caching
COPY package*.json ${LAMBDA_TASK_ROOT}/

# Install Node.js dependencies
RUN npm ci --production --no-audit --no-fund

# Copy source code
COPY . ${LAMBDA_TASK_ROOT}/

# Set the CMD to your handler
CMD ["index.handler"]