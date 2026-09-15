#!/usr/bin/env bash
# Build the sadbox supervisor image and push it to Amazon ECR.
#
# Usage:
#   AWS_REGION=ap-southeast-1 AWS_ACCOUNT_ID=123456789012 ./scripts/push-ecr.sh [tag]
#
# Requires: docker (buildx) or Apple `container`, and awscli v2 authenticated.
# Defaults to a linux/arm64 image (Apple-silicon Mac mini / Graviton). Override
# with PLATFORM=linux/amd64 for an Intel host.
set -euo pipefail

REGION="${AWS_REGION:?set AWS_REGION}"
ACCOUNT="${AWS_ACCOUNT_ID:?set AWS_ACCOUNT_ID}"
REPO="${ECR_REPO:-sadbox}"
TAG="${1:-latest}"
PLATFORM="${PLATFORM:-linux/arm64}"
REGISTRY="${ACCOUNT}.dkr.ecr.${REGION}.amazonaws.com"
IMAGE="${REGISTRY}/${REPO}:${TAG}"

cd "$(dirname "$0")/.."

echo "→ ensuring ECR repo '${REPO}' exists"
aws ecr describe-repositories --region "$REGION" --repository-names "$REPO" >/dev/null 2>&1 \
  || aws ecr create-repository --region "$REGION" --repository-name "$REPO" >/dev/null

echo "→ logging in to ${REGISTRY}"
aws ecr get-login-password --region "$REGION" \
  | docker login --username AWS --password-stdin "$REGISTRY"

echo "→ building & pushing ${IMAGE} (${PLATFORM})"
# buildx pushes straight to the registry for the target platform in one step
docker buildx build --platform "$PLATFORM" -t "$IMAGE" --push .

echo "✓ pushed ${IMAGE}"
echo
echo "On the server:"
echo "  aws ecr get-login-password --region ${REGION} | docker login --username AWS --password-stdin ${REGISTRY}"
echo "  docker pull ${IMAGE}"
echo "  docker run -d --name sadbox -p 7070:7070 -v sadbox-data:/data ${IMAGE}"
