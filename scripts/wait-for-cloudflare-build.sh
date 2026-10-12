#!/usr/bin/env bash
# Waits until Cloudflare Workers Builds has finished building AND deploying
# the exact commit given, so the post-deployment health check that follows
# runs against that commit's Worker version rather than the previous one.
#
# Why this exists: Workers Builds deploys asynchronously on its own push
# trigger. A fixed sleep cannot know when that lands -- observed builds take
# 51-104s, so the old 45s sleep made every health check hit the PREVIOUS
# version. This polls Cloudflare for the build of COMMIT_SHA instead.
#
# Usage: wait-for-cloudflare-build.sh <commit-sha>
# Env:   CLOUDFLARE_API_TOKEN  (required; needs read access to Workers
#                               Scripts and Workers Builds on the account)
#        WORKER_NAME           (default: enig-agent)
#        TIMEOUT_SECONDS       (default: 600)
#        POLL_SECONDS          (default: 15)
#        CF_API                (default: https://api.cloudflare.com/client/v4)
#
# Exit 0 only when the build for COMMIT_SHA finished with outcome "success".
# Any failed/cancelled build, API error, or timeout exits non-zero -- this
# never reports a deployment it could not see.
set -euo pipefail

COMMIT_SHA="${1:?usage: $0 <commit-sha>}"
WORKER_NAME="${WORKER_NAME:-enig-agent}"
TIMEOUT_SECONDS="${TIMEOUT_SECONDS:-600}"
POLL_SECONDS="${POLL_SECONDS:-15}"
CF_API="${CF_API:-https://api.cloudflare.com/client/v4}"
: "${CLOUDFLARE_API_TOKEN:?CLOUDFLARE_API_TOKEN is required}"

cf_get() {
  curl -sS --fail-with-body -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" "${CF_API}$1"
}

ACCOUNT_ID=$(cf_get "/accounts" | jq -r '.result[0].id // empty')
[ -n "$ACCOUNT_ID" ] || { echo "Could not resolve the Cloudflare account from the token." >&2; exit 1; }

SCRIPT_TAG=$(cf_get "/accounts/${ACCOUNT_ID}/workers/scripts" | jq -r --arg n "$WORKER_NAME" '.result[] | select(.id == $n) | .tag' | head -n1)
[ -n "$SCRIPT_TAG" ] || { echo "Worker '${WORKER_NAME}' not found on the account." >&2; exit 1; }

echo "Waiting for the Workers Builds build of ${COMMIT_SHA} (worker ${WORKER_NAME}, timeout ${TIMEOUT_SECONDS}s)"
deadline=$(( $(date +%s) + TIMEOUT_SECONDS ))
while :; do
  build=$(cf_get "/accounts/${ACCOUNT_ID}/builds/workers/${SCRIPT_TAG}/builds?per_page=20" \
    | jq -c --arg sha "$COMMIT_SHA" '[.result[] | select(.build_trigger_metadata.commit_hash == $sha)] | first // empty')

  if [ -n "$build" ]; then
    status=$(jq -r '.status' <<<"$build")
    outcome=$(jq -r '.build_outcome // ""' <<<"$build")
    uuid=$(jq -r '.build_uuid' <<<"$build")
    if [ "$status" = "stopped" ]; then
      if [ "$outcome" = "success" ]; then
        version=$(cf_get "/accounts/${ACCOUNT_ID}/workers/scripts/${WORKER_NAME}/deployments" \
          | jq -r '.result.deployments[0].versions | map("\(.version_id) (\(.percentage)%)") | join(", ")')
        echo "Build ${uuid} for ${COMMIT_SHA} succeeded. Active deployment: ${version}"
        exit 0
      fi
      echo "Build ${uuid} for ${COMMIT_SHA} finished with outcome '${outcome}' -- deployment did not land." >&2
      exit 1
    fi
    echo "Build ${uuid} is '${status}'..."
  else
    echo "No build for ${COMMIT_SHA} yet..."
  fi

  if [ "$(date +%s)" -ge "$deadline" ]; then
    echo "Timed out after ${TIMEOUT_SECONDS}s waiting for the build of ${COMMIT_SHA}." >&2
    exit 1
  fi
  sleep "$POLL_SECONDS"
done
