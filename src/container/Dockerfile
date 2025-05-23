FROM mcr.microsoft.com/playwright:v1.44.1-jammy

RUN apt-get update && apt-get install -y \
    g++ \
    make \
    unzip \
    libcurl4-openssl-dev \
    cmake \
    build-essential \
    autoconf \
    automake \
    libtool \
    && rm -rf /var/lib/apt/lists/*

# Set Chromium path for Playwright
ENV PLAYWRIGHT_BROWSERS_PATH=/usr/bin
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium-browser

# Copy package files first for better caching
COPY . .

RUN npm install aws-lambda-ric
RUN npm install

# Compile TypeScript to JavaScript
RUN npm run build

ENTRYPOINT ["npx", "aws-lambda-ric"]
# Set the CMD to your handler
CMD ["index.handler"]