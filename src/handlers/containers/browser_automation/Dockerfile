FROM mcr.microsoft.com/playwright:v1.52.0-jammy

WORKDIR /var/task

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

# Copy package files first for better caching
COPY . .

RUN npm install aws-lambda-ric
RUN npm install

# Compile TypeScript to JavaScript
RUN npm run build

ENTRYPOINT ["npx", "aws-lambda-ric"]
# Set the CMD to your handler
CMD ["index.handler"]