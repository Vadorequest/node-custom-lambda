#!/bin/bash

LAYER_NAME=nodejs610

NODE_VERSION=6.10.3

REGIONS='
eu-west-1
'

for region in $REGIONS; do
  aws lambda add-layer-version-permission --region $region --layer-name $LAYER_NAME \
    --statement-id sid1 --action lambda:GetLayerVersion --principal '*' \
    --version-number $(aws lambda publish-layer-version --region $region --layer-name $LAYER_NAME \
      --zip-file fileb://layer.zip --cli-read-timeout 0 --cli-connect-timeout 0 \
      --description "Node.js v${NODE_VERSION} custom runtime" --query Version --output text) &
done

for job in $(jobs -p); do
  wait $job
done
