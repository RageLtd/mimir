#!/bin/sh
set -e

echo "[ollama-init] Waiting for Ollama to start..."
until ollama list >/dev/null 2>&1; do
  sleep 1
done
echo "[ollama-init] Ollama is ready"

for model in ${OLLAMA_PULL_MODELS}; do
  echo "[ollama-init] Pulling ${model}..."
  ollama pull "${model}"
done

echo "[ollama-init] All models ready"
