#!/bin/bash
set -euo pipefail

# Deploy a FEATURE BRANCH of the siwx-oidc-matrix-server stack to
# agentic.inblock.io for testing, then verify, then roll back if needed.
#
# Why a separate script from deploy.sh:
#   - deploy.sh sets only IMAGE_TAG (synapse + element-web) and leaves siwx-oidc
#     pinned to `main`, so a feature branch's siwx-oidc code would never ship.
#   - Branch names contain `/`, which is invalid in a Docker tag and must be
#     sanitized to `-` (matching docker/metadata-action `type=ref,event=branch`).
#
# What actually changes per feature:
#   - siwx-oidc  : Rust code -> needs a branch image (built by CI on the branch).
#   - element-web: config-only (volume-mounted element-config.json) -> NO image
#                  rebuild; the server repo checkout at the branch ref supplies it.
#   - synapse    : unchanged -> stays on the `main` image.
# So this script pulls the branch siwx-oidc image and keeps synapse/element-web
# on IMAGE_TAG (default `main`), while checking out the matrix-server repo at the
# branch ref so the new element-config.json is volume-mounted in.
#
# Usage:
#   ./deploy-feature.sh <branch> [--build-image] [--deploy] [--verify] [--rollback]
#
#   <branch>        Feature branch present in BOTH repos (this repo + siwx-oidc).
#   --build-image   Trigger the siwx-oidc Docker workflow on <branch> and wait.
#   --deploy        Checkout <branch> on the server, pull the branch siwx-oidc
#                   image, and restart the stack.
#   --verify        Run verify-deployment.sh against the live endpoints.
#   --rollback      Redeploy `main` (siwx-oidc + repo checkout) and restart.
#
# Typical flow:
#   ./deploy-feature.sh fix/cross-signing-identity-stability --build-image --deploy --verify
#   # ...manual validation (see docs/feature-branch-validation.md)...
#   # success -> merge to main; failure -> ./deploy-feature.sh main --rollback
#
# Prerequisites:
#   - SSH access to deploy@agentic.inblock.io via ~/.ssh/id_ed25519
#   - gh CLI authenticated (for --build-image)
#   - Both branches pushed to origin

SERVER="deploy@agentic.inblock.io"
SSH_KEY="$HOME/.ssh/id_ed25519"
REMOTE_DIR="/home/deploy/matrix"
MATRIX_REPO="https://github.com/inblockio/siwx-oidc-matrix-server.git"
SIWX_OIDC_WORKFLOW="docker.yml"
SIWX_OIDC_REPO="inblockio/siwx-oidc"
# synapse + element-web image tag (these are unchanged by feature work).
IMAGE_TAG="${IMAGE_TAG:-main}"

BRANCH="${1:-}"
DO_BUILD_IMAGE=false
DO_DEPLOY=false
DO_VERIFY=false
DO_ROLLBACK=false

if [ -z "$BRANCH" ]; then
  echo "Usage: ./deploy-feature.sh <branch> [--build-image] [--deploy] [--verify] [--rollback]"
  exit 1
fi
shift

while [ "$#" -gt 0 ]; do
  case "$1" in
    --build-image) DO_BUILD_IMAGE=true; shift ;;
    --deploy)      DO_DEPLOY=true;      shift ;;
    --verify)      DO_VERIFY=true;      shift ;;
    --rollback)    DO_ROLLBACK=true;    shift ;;
    *) echo "Unknown flag: $1"; exit 1 ;;
  esac
done

# Docker tag = branch with '/' -> '-' (docker/metadata-action sanitization).
SIWX_OIDC_TAG="${BRANCH//\//-}"
SSH_CMD="ssh -i $SSH_KEY $SERVER"

echo "=== Feature deploy: branch '$BRANCH' (siwx-oidc tag '$SIWX_OIDC_TAG', stack IMAGE_TAG '$IMAGE_TAG') ==="

# -- Rollback to main ---------------------------------------------------------
if [ "$DO_ROLLBACK" = true ]; then
  echo ""
  echo "[rollback] Restoring main on the server..."
  $SSH_CMD bash -s <<REMOTE_ROLLBACK
set -euo pipefail
cd ${REMOTE_DIR}/stack
git fetch origin --prune
git checkout origin/main --detach
echo "Repo at \$(git rev-parse --short HEAD) (main)"
SIWX_OIDC_TAG=main IMAGE_TAG=main docker compose pull matrix_synapse siwx-oidc element-web
SIWX_OIDC_TAG=main IMAGE_TAG=main docker compose down
SIWX_OIDC_TAG=main IMAGE_TAG=main docker compose up -d
sleep 5
docker compose ps --format 'table {{.Name}}\t{{.Status}}'
REMOTE_ROLLBACK
  echo "=== Rollback to main complete ==="
  exit 0
fi

# -- Build the siwx-oidc branch image via CI ----------------------------------
if [ "$DO_BUILD_IMAGE" = true ]; then
  echo ""
  echo "[build] Triggering siwx-oidc Docker build on '$BRANCH'..."
  command -v gh >/dev/null 2>&1 || { echo "ERROR: gh CLI not found"; exit 1; }
  gh workflow run "$SIWX_OIDC_WORKFLOW" --repo "$SIWX_OIDC_REPO" --ref "$BRANCH"
  echo "[build] Waiting for the run to register..."
  sleep 6
  RUN_ID=$(gh run list --repo "$SIWX_OIDC_REPO" --workflow "$SIWX_OIDC_WORKFLOW" \
    --branch "$BRANCH" --limit 1 --json databaseId --jq '.[0].databaseId')
  if [ -z "$RUN_ID" ]; then
    echo "ERROR: could not find a workflow run for '$BRANCH'. Is the branch pushed?"
    exit 1
  fi
  echo "[build] Watching run $RUN_ID (ghcr.io/$SIWX_OIDC_REPO:$SIWX_OIDC_TAG)..."
  gh run watch "$RUN_ID" --repo "$SIWX_OIDC_REPO" --exit-status
  echo "[build] siwx-oidc image built: ghcr.io/$SIWX_OIDC_REPO:$SIWX_OIDC_TAG"
fi

# -- Deploy the branch to the server ------------------------------------------
if [ "$DO_DEPLOY" = true ]; then
  echo ""
  echo "[deploy] Checking out '$BRANCH' on the server and restarting..."
  $SSH_CMD bash -s <<REMOTE_DEPLOY
set -euo pipefail
if [ -d ${REMOTE_DIR}/stack/.git ]; then
  cd ${REMOTE_DIR}/stack
  git fetch origin --prune
else
  git clone ${MATRIX_REPO} ${REMOTE_DIR}/stack
  cd ${REMOTE_DIR}/stack
fi
git checkout "origin/${BRANCH}" --detach
chmod +x entrypoints/*.sh start-matrix.sh deploy*.sh verify-deployment.sh 2>/dev/null || true
echo "Repo at \$(git rev-parse --short HEAD) (${BRANCH})"

# Pull the branch siwx-oidc image; keep synapse + element-web on IMAGE_TAG.
SIWX_OIDC_TAG=${SIWX_OIDC_TAG} IMAGE_TAG=${IMAGE_TAG} docker compose pull matrix_synapse siwx-oidc element-web
SIWX_OIDC_TAG=${SIWX_OIDC_TAG} IMAGE_TAG=${IMAGE_TAG} docker compose down
SIWX_OIDC_TAG=${SIWX_OIDC_TAG} IMAGE_TAG=${IMAGE_TAG} docker compose up -d
echo "Waiting for health checks..."
sleep 6
docker compose ps --format 'table {{.Name}}\t{{.Status}}'
echo "siwx-oidc image in use:"
docker compose images siwx-oidc 2>/dev/null || true
REMOTE_DEPLOY
  echo "[deploy] Done."
fi

# -- Verify -------------------------------------------------------------------
if [ "$DO_VERIFY" = true ]; then
  echo ""
  echo "[verify] Running verify-deployment.sh..."
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  if [ -x "$SCRIPT_DIR/verify-deployment.sh" ]; then
    "$SCRIPT_DIR/verify-deployment.sh"
  else
    bash "$SCRIPT_DIR/verify-deployment.sh"
  fi
fi

echo ""
echo "=== Feature deploy actions complete (branch: $BRANCH) ==="
echo "Manual validation steps: docs/feature-branch-validation.md"
echo "Roll back with: ./deploy-feature.sh main --rollback"
