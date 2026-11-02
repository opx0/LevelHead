#!/usr/bin/env bash
# Stand the showcase up, show it, and take it down again. Not a deploy pipeline: Levelhead is not an
# always-on public service (ADR-025), and the teardown step is the point rather than an afterthought.
set -euo pipefail

PROJECT="${LEVELHEAD_GCP_PROJECT:-}"
REGION="${LEVELHEAD_GCP_REGION:-asia-south1}"
REPO="${LEVELHEAD_ARTIFACT_REPO:-levelhead}"
TAG="${LEVELHEAD_IMAGE_TAG:-$(git rev-parse --short HEAD)}"
SERVICE="levelhead-showcase"

usage() {
  cat <<'USAGE'
usage: scripts/showcase.sh <up|down|status|url|logs>

  up      build both images, push, run migrations, deploy the showcase, print its URL
  down    delete the service, so nothing is left running or reachable
  status  what exists right now
  url     the showcase URL, if it is up
  logs    tail the showcase logs

environment:
  LEVELHEAD_GCP_PROJECT   required
  LEVELHEAD_GCP_REGION    default asia-south1
  LEVELHEAD_ARTIFACT_REPO default levelhead
  LEVELHEAD_IMAGE_TAG     default the current commit
USAGE
}

require_project() {
  if [ -z "$PROJECT" ]; then
    echo "LEVELHEAD_GCP_PROJECT is not set; refusing to guess which project to deploy into." >&2
    exit 1
  fi
}

image() { echo "${REGION}-docker.pkg.dev/${PROJECT}/${REPO}/$1:${TAG}"; }

case "${1:-}" in
  up)
    require_project
    gcloud artifacts repositories describe "$REPO" --location "$REGION" --project "$PROJECT" \
      >/dev/null 2>&1 || gcloud artifacts repositories create "$REPO" \
        --repository-format=docker --location "$REGION" --project "$PROJECT"

    docker build -f infra/Dockerfile --target runtime -t "$(image server)" .
    docker build -f infra/Dockerfile --target worker -t "$(image worker)" .
    gcloud auth configure-docker "${REGION}-docker.pkg.dev" --quiet
    docker push "$(image server)"
    docker push "$(image worker)"

    # Forward-only migrations, as their own step, before anything serves traffic.
    gcloud run jobs deploy levelhead-migrate \
      --image "$(image worker)" --region "$REGION" --project "$PROJECT" \
      --command node --args packages/db/src/migrate-cli.ts \
      --set-secrets DATABASE_URL=levelhead-database-url:latest --quiet
    gcloud run jobs execute levelhead-migrate --region "$REGION" --project "$PROJECT" --wait

    gcloud run deploy "$SERVICE" \
      --image "$(image server)" --region "$REGION" --project "$PROJECT" \
      --allow-unauthenticated \
      --min-instances 0 --max-instances 2 --concurrency 20 --timeout 120 \
      --set-env-vars NODE_ENV=production,LEVELHEAD_STORE=postgres,LEVELHEAD_DEMO_MODE=true,LEVELHEAD_PREVIEW_MODE=true,LEVELHEAD_RATE_LIMIT_PER_MINUTE=60 \
      --set-secrets DATABASE_URL=levelhead-database-url:latest,MODEL_PROVIDER_API_KEY=levelhead-model-key:latest \
      --quiet

    echo
    echo "showcase up: $(gcloud run services describe "$SERVICE" --region "$REGION" --project "$PROJECT" --format 'value(status.url)')"
    echo "it runs on the synthetic résumé and keeps nothing. take it down with: scripts/showcase.sh down"
    ;;

  down)
    require_project
    gcloud run services delete "$SERVICE" --region "$REGION" --project "$PROJECT" --quiet
    echo "showcase down. nothing is running and nothing is reachable."
    ;;

  status)
    require_project
    gcloud run services list --region "$REGION" --project "$PROJECT" --filter "metadata.name=$SERVICE"
    ;;

  url)
    require_project
    gcloud run services describe "$SERVICE" --region "$REGION" --project "$PROJECT" --format 'value(status.url)'
    ;;

  logs)
    require_project
    gcloud beta run services logs tail "$SERVICE" --region "$REGION" --project "$PROJECT"
    ;;

  *)
    usage
    exit 1
    ;;
esac
