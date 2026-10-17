#!/usr/bin/env bash
set -euo pipefail
# Explicitly operates on YOUR project. Never embeds credentials or uses the active default project.
: "${PROJECT_ID:?Set PROJECT_ID to your Google Cloud project}"
REGION="${REGION:-europe-west1}"
SERVICE="${SERVICE:-classic-mail-mcp}"
DATABASE="${DATABASE:-classic-mail-mcp}"
SA="${SERVICE}@${PROJECT_ID}.iam.gserviceaccount.com"
SECRET="${SERVICE}-config"
MODE="${1:-}"
if [[ "$MODE" != bootstrap && "$MODE" != configure ]]; then
  echo "Usage: PROJECT_ID=your-project $0 bootstrap | configure path/to/private-config.json" >&2
  exit 2
fi
if [[ "$MODE" == bootstrap ]]; then
  if gcloud run services describe "$SERVICE" --project="$PROJECT_ID" --region="$REGION" >/dev/null 2>&1; then
    echo "Service already exists; bootstrap refuses to replace it. Use configure." >&2
    exit 1
  fi
  gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com secretmanager.googleapis.com firestore.googleapis.com --project="$PROJECT_ID"
  if ! gcloud iam service-accounts describe "$SA" --project="$PROJECT_ID" >/dev/null 2>&1; then
    gcloud iam service-accounts create "$SERVICE" --project="$PROJECT_ID" --display-name="Classic Mail MCP runtime"
  fi
  if ! gcloud firestore databases describe --database="$DATABASE" --project="$PROJECT_ID" >/dev/null 2>&1; then
    gcloud firestore databases create --database="$DATABASE" --location="$REGION" --type=firestore-native --project="$PROJECT_ID"
  fi
  gcloud projects add-iam-policy-binding "$PROJECT_ID" --member="serviceAccount:$SA" --role=roles/datastore.user \
    --condition="expression=resource.name == 'projects/$PROJECT_ID/databases/$DATABASE',title=classic-mail-database" --quiet >/dev/null
  for collection in oauth limits; do
    gcloud firestore fields ttls update expiresAt --collection-group="$collection" --database="$DATABASE" --project="$PROJECT_ID" --enable-ttl --quiet
  done
  gcloud run deploy "$SERVICE" --source=. --project="$PROJECT_ID" --region="$REGION" --service-account="$SA" \
    --allow-unauthenticated --ingress=all --memory=512Mi --cpu=1 --max-instances=3 --concurrency=20 --timeout=180 \
    --set-env-vars="HOST=0.0.0.0,AUTH_MODE=oauth,STORAGE=firestore,GOOGLE_CLOUD_PROJECT=$PROJECT_ID,FIRESTORE_DATABASE=$DATABASE,BASE_URL=https://setup.invalid,ACCESS_MODE=read-only" --quiet
  echo "Bootstrap complete. Mail access remains locked. Use the service URL below for the Google OAuth callback, then run configure:"
  gcloud run services describe "$SERVICE" --project="$PROJECT_ID" --region="$REGION" --format='value(status.url)'
else
  CONFIG_FILE="${2:?Pass the private OAuth JSON configuration path}"
  [[ -f "$CONFIG_FILE" ]] || { echo "Configuration file not found" >&2; exit 1; }
  # Validation prints no inputs and checks exactly the public OAuth schema.
  node --input-type=module -e "import {readFileSync} from 'node:fs'; import {secretSchema} from './dist/config.js'; try {secretSchema.parse(JSON.parse(readFileSync(process.argv[1],'utf8')))} catch {console.error('Invalid OAuth configuration');process.exit(1)}" "$CONFIG_FILE"
  BASE_URL="$(gcloud run services describe "$SERVICE" --project="$PROJECT_ID" --region="$REGION" --format='value(status.url)')"
  if ! gcloud secrets describe "$SECRET" --project="$PROJECT_ID" >/dev/null 2>&1; then
    gcloud secrets create "$SECRET" --replication-policy=user-managed --locations="$REGION" --project="$PROJECT_ID"
  fi
  VERSION="$(gcloud secrets versions add "$SECRET" --data-file="$CONFIG_FILE" --project="$PROJECT_ID" --format='value(name)' | awk -F/ '{print $NF}')"
  gcloud secrets add-iam-policy-binding "$SECRET" --member="serviceAccount:$SA" --role=roles/secretmanager.secretAccessor --project="$PROJECT_ID" --quiet >/dev/null
  gcloud run deploy "$SERVICE" --source=. --project="$PROJECT_ID" --region="$REGION" --service-account="$SA" \
    --allow-unauthenticated --ingress=all --memory=512Mi --cpu=1 --max-instances=3 --concurrency=20 --timeout=180 \
    --set-env-vars="HOST=0.0.0.0,AUTH_MODE=oauth,STORAGE=firestore,GOOGLE_CLOUD_PROJECT=$PROJECT_ID,FIRESTORE_DATABASE=$DATABASE,BASE_URL=$BASE_URL,ACCESS_MODE=${ACCESS_MODE:-read-only}" \
    --set-secrets="APP_CONFIG_JSON=$SECRET:$VERSION" --quiet
  echo "Deployed. Verify OAuth, tools/list and check_connection before enabling writes."
fi
