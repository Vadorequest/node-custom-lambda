#!/bin/sh

export NODE_VERSION=4.3.2

docker build --build-arg NODE_VERSION -t node-provided-lambda-v4.3 .
docker run --rm node-provided-lambda-v4.3 cat /tmp/node-v${NODE_VERSION}.zip > ./layer.zip
