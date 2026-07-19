#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
REPO_ROOT=$(cd -- "$SCRIPT_DIR/.." && pwd -P)
COMPOSE_FILE=${NEBULA_SERVER_COMPOSE_FILE:-"$REPO_ROOT/compose.deploy.yaml"}
ENV_FILE=${NEBULA_SERVER_ENV_FILE:-"$REPO_ROOT/.env"}
BASE_DIR=${NEBULA_SERVER_BASE_DIR:-/srv/nebula}
DOCKER_BIN=${NEBULA_DOCKER_BIN:-docker}
CURL_BIN=${NEBULA_CURL_BIN:-curl}
WAIT_TIMEOUT=${NEBULA_SERVER_WAIT_TIMEOUT:-180}
COMMAND="" FOLLOW=false LOG_TAIL=200 NO_WAIT=false BACKUP_ID=""
TOKEN_FILE=${NEBULA_SERVER_TOKEN_FILE:-}
TEMP_ENV="" CURL_CONFIG="" CURL_PAYLOAD=""
CONFIG_UID=${NEBULA_UID:-${SUDO_UID:-$(id -u)}}
CONFIG_GID=${NEBULA_GID:-${SUDO_GID:-$(id -g)}}
CONFIG_BIND=${NEBULA_BIND_ADDRESS:-127.0.0.1}
CONFIG_PORT=${NEBULA_PORT:-5173}

usage() {
  cat <<'EOF'
Nebula single-host server operator

Usage:
  scripts/nebula-server.sh [options] <command>

Commands:
  install          Initialize safely, build, start, wait, and print setup URL
  init             Create missing directories and .env without overwriting it
  validate         Check prerequisites, configuration, and deployment Compose
  up | start       Validate, build if needed, start, and wait for readiness
  down | stop      Gracefully stop the deployment stack
  status           Show deployment container status
  logs             Show dashboard logs (use --follow to stream)
  update | upgrade Rebuild the checked-out revision with fresh base images
  backup           Create an online backup using a service-admin token file
  help             Show this help

Options:
  --base-dir PATH       Default data/content/backups parent (default: /srv/nebula)
  --env-file PATH       Deployment env file (default: repository .env)
  --compose-file PATH   Deployment Compose file (default: compose.deploy.yaml)
  --uid ID              Numeric owner for newly initialized directories
  --gid ID              Numeric group for newly initialized directories
  --bind ADDRESS        Generated host bind address (default: 127.0.0.1)
  --port PORT           Generated host port (default: 5173)
  --timeout SECONDS     Readiness timeout (default: 180)
  --no-wait             Do not wait for /readyz after start/update
  --follow              Stream logs
  --tail LINES          Number of log lines to show (default: 200)
  --backup-id ID        Backup identifier (default: UTC timestamp)
  --token-file PATH     Mode-0600 file containing NEBULA_API_TOKEN
  -h, --help            Show this help

Environment equivalents:
  NEBULA_SERVER_BASE_DIR, NEBULA_SERVER_ENV_FILE,
  NEBULA_SERVER_COMPOSE_FILE, NEBULA_SERVER_WAIT_TIMEOUT,
  NEBULA_SERVER_TOKEN_FILE, NEBULA_UID, NEBULA_GID,
  NEBULA_BIND_ADDRESS, and NEBULA_PORT.

The CLI never replaces an existing env file, changes Git revisions, removes
volumes, resets accounts, or prints tokens. Run it from a reviewed checkout.
EOF
}

die() { printf 'nebula-server: error: %s\n' "$*" >&2; exit 1; }
note() { printf 'nebula-server: %s\n' "$*"; }
require_value() { [[ $# -ge 2 && -n ${2:-} ]] || die "$1 requires a value"; }
cleanup() { rm -f -- "$TEMP_ENV" "$CURL_CONFIG" "$CURL_PAYLOAD"; }
trap cleanup EXIT INT TERM

while [[ $# -gt 0 ]]; do
  case "$1" in
    install|init|validate|up|start|down|stop|status|logs|update|upgrade|backup|help)
      [[ -z $COMMAND ]] || die "only one command may be supplied"
      COMMAND=$1; shift ;;
    --base-dir|--env-file|--compose-file|--uid|--gid|--bind|--port|--timeout|--tail|--backup-id|--token-file)
      require_value "$1" "${2:-}"; option=$1; value=$2; shift 2
      case "$option" in
        --base-dir) BASE_DIR=$value ;; --env-file) ENV_FILE=$value ;;
        --compose-file) COMPOSE_FILE=$value ;; --uid) CONFIG_UID=$value ;;
        --gid) CONFIG_GID=$value ;; --bind) CONFIG_BIND=$value ;;
        --port) CONFIG_PORT=$value ;; --timeout) WAIT_TIMEOUT=$value ;;
        --tail) LOG_TAIL=$value ;; --backup-id) BACKUP_ID=$value ;;
        --token-file) TOKEN_FILE=$value ;;
      esac ;;
    --no-wait) NO_WAIT=true; shift ;; --follow) FOLLOW=true; shift ;;
    -h|--help) usage; exit 0 ;; --) shift; [[ $# -eq 0 ]] || die "unexpected argument: $1" ;;
    -*) die "unknown option: $1" ;; *) die "unknown command: $1" ;;
  esac
done

[[ -n $COMMAND ]] || { usage >&2; exit 2; }
[[ $COMMAND != help ]] || { usage; exit 0; }
[[ $BASE_DIR = /* ]] || die "--base-dir must be an absolute path"
[[ $ENV_FILE = /* ]] || ENV_FILE="$PWD/$ENV_FILE"
[[ $COMPOSE_FILE = /* ]] || COMPOSE_FILE="$PWD/$COMPOSE_FILE"
[[ $CONFIG_UID =~ ^[0-9]+$ ]] || die "--uid must be numeric"
[[ $CONFIG_GID =~ ^[0-9]+$ ]] || die "--gid must be numeric"
[[ $CONFIG_PORT =~ ^[0-9]+$ && $CONFIG_PORT -ge 1 && $CONFIG_PORT -le 65535 ]] || die "--port must be between 1 and 65535"
[[ $WAIT_TIMEOUT =~ ^[0-9]+$ && $WAIT_TIMEOUT -ge 1 ]] || die "--timeout must be a positive integer"
[[ $LOG_TAIL =~ ^[0-9]+$ ]] || die "--tail must be a non-negative integer"
[[ $CONFIG_BIND =~ ^[0-9A-Fa-f:.]+$ || $CONFIG_BIND == localhost ]] || die "--bind must be an IP address or localhost"
[[ -f $COMPOSE_FILE ]] || die "Compose file not found: $COMPOSE_FILE"

compose() { "$DOCKER_BIN" compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"; }
check_prerequisites() {
  command -v "$DOCKER_BIN" >/dev/null 2>&1 || die "Docker is not installed or '$DOCKER_BIN' is not on PATH"
  "$DOCKER_BIN" info >/dev/null 2>&1 || die "Docker daemon is unavailable or this user cannot access it"
  "$DOCKER_BIN" compose version >/dev/null 2>&1 || die "Docker Compose v2 is unavailable; install the Docker Compose plugin"
}
env_quote() { local value=$1; value=${value//\\/\\\\}; value=${value//\"/\\\"}; printf '"%s"' "$value"; }

create_directory() {
  local path=$1 current_uid current_gid
  current_uid=$(id -u); current_gid=$(id -g)
  if [[ $current_uid -ne 0 && ( $CONFIG_UID -ne $current_uid || $CONFIG_GID -ne $current_gid ) ]]; then
    die "cannot assign $CONFIG_UID:$CONFIG_GID as uid $current_uid; rerun with sudo or choose --uid/--gid for this user"
  fi
  install -d -m 0750 "$path" || die "cannot create $path; rerun with sufficient permission or choose --base-dir"
  [[ $current_uid -ne 0 ]] || chown "$CONFIG_UID:$CONFIG_GID" "$path"
}

initialize() {
  local data_path="$BASE_DIR/data" content_path="$BASE_DIR/content" backup_path="$BASE_DIR/backups"
  local env_parent
  if [[ -e $ENV_FILE ]]; then
    [[ -f $ENV_FILE ]] || die "env path exists but is not a regular file: $ENV_FILE"
    note "keeping existing configuration: $ENV_FILE"; return
  fi
  create_directory "$data_path"; create_directory "$content_path"; create_directory "$backup_path"
  env_parent=$(dirname -- "$ENV_FILE"); [[ -d $env_parent ]] || die "env file parent does not exist: $env_parent"
  umask 077; TEMP_ENV=$(mktemp "$ENV_FILE.tmp.XXXXXX") || die "cannot create temporary env file beside $ENV_FILE"
  {
    printf '%s\n' '# Generated by scripts/nebula-server.sh. Review before exposing the server.'
    printf 'NEBULA_BIND_ADDRESS=%s\n' "$(env_quote "$CONFIG_BIND")"
    printf 'NEBULA_PORT=%s\n' "$(env_quote "$CONFIG_PORT")"
    printf 'NEBULA_UID=%s\n' "$(env_quote "$CONFIG_UID")"
    printf 'NEBULA_GID=%s\n' "$(env_quote "$CONFIG_GID")"
    printf 'NEBULA_DATA_PATH=%s\n' "$(env_quote "$data_path")"
    printf 'NEBULA_CONTENT_PATH=%s\n' "$(env_quote "$content_path")"
    printf 'NEBULA_BACKUP_PATH=%s\n' "$(env_quote "$backup_path")"
    printf '%s\n' 'NEBULA_REQUIRE_AUTH="false"' 'NEBULA_API_TOKEN=""' 'NEBULA_AUTH_ALLOW_LOCALHOST="false"'
    printf '%s\n' 'NEBULA_FIRST_RUN_GUEST_ENABLED="false"' 'NEBULA_GUEST_SESSION_TTL_MS="28800000"'
    printf '%s\n' 'NEBULA_CORS_ALLOWED_ORIGINS=""' 'NEBULA_VITE_ALLOWED_HOSTS=""'
    printf '%s\n' 'TMDB_API_TOKEN=""' 'GOOGLE_VISION_API_KEY=""'
    printf '%s\n' 'NEBULA_AUDIT_RETENTION_DAYS="90"' 'NEBULA_AUDIT_MAX_EVENTS="10000"'
  } >"$TEMP_ENV"
  chmod 0600 "$TEMP_ENV"; mv -- "$TEMP_ENV" "$ENV_FILE"; TEMP_ENV=""
  [[ $(id -u) -ne 0 ]] || chown "$CONFIG_UID:$CONFIG_GID" "$ENV_FILE"
  note "created configuration: $ENV_FILE"
}

require_configuration() { [[ -f $ENV_FILE ]] || die "configuration not found: $ENV_FILE (run 'init' or 'install')"; }
validate_configuration() { require_configuration; compose config --quiet; note "deployment configuration is valid"; }
env_value() {
  local key=$1 line value
  line=$(awk -v key="$key" 'index($0, key "=") == 1 { value=substr($0, length(key)+2) } END { print value }' "$ENV_FILE")
  value=$line
  if [[ $value == \"*\" && $value == *\" ]]; then
    value=${value:1:${#value}-2}; value=${value//\\\"/\"}; value=${value//\\\\/\\}
  elif [[ $value == \'*\' && $value == *\' ]]; then value=${value:1:${#value}-2}; fi
  printf '%s' "$value"
}
setup_url() {
  local bind port; bind=$(env_value NEBULA_BIND_ADDRESS); port=$(env_value NEBULA_PORT)
  bind=${bind:-127.0.0.1}; port=${port:-5173}; [[ $bind != 0.0.0.0 && $bind != :: ]] || bind=127.0.0.1
  [[ $bind != *:* || $bind == \[* ]] || bind="[$bind]"; printf 'http://%s:%s' "$bind" "$port"
}
validate_storage() {
  local key path
  for key in NEBULA_DATA_PATH NEBULA_CONTENT_PATH NEBULA_BACKUP_PATH; do
    path=$(env_value "$key")
    [[ $path = /* ]] || die "$key must be an absolute path in $ENV_FILE"
    [[ -d $path ]] || die "$key directory does not exist: $path (run 'init' for a fresh configuration or create it explicitly)"
  done
}
wait_for_readiness() {
  [[ $NO_WAIT == false ]] || { note "readiness wait skipped"; return; }
  local url deadline; url="$(setup_url)/readyz"; deadline=$((SECONDS + WAIT_TIMEOUT))
  note "waiting up to ${WAIT_TIMEOUT}s for readiness"
  until compose exec -T dashboard wget -q -O /dev/null http://127.0.0.1:5173/readyz >/dev/null 2>&1; do
    if (( SECONDS >= deadline )); then compose ps >&2 || true; die "server did not become ready within ${WAIT_TIMEOUT}s; inspect 'logs' and $url"; fi
    sleep 2
  done
  note "server is ready: $(setup_url)"
}
start_stack() { compose up -d --build; wait_for_readiness; note "owner setup URL: $(setup_url)"; }

create_backup() {
  require_configuration
  [[ -n $TOKEN_FILE ]] || die "backup requires --token-file (never pass the token on the command line)"
  [[ -f $TOKEN_FILE ]] || die "token file not found: $TOKEN_FILE"
  local token token_mode url
  token_mode=$(stat -c '%a' "$TOKEN_FILE" 2>/dev/null || stat -f '%Lp' "$TOKEN_FILE" 2>/dev/null || true)
  [[ $token_mode == 600 ]] || die "token file must have mode 0600"
  command -v "$CURL_BIN" >/dev/null 2>&1 || die "curl is required to create an online backup"
  token=$(<"$TOKEN_FILE"); [[ -n $token && $token != *$'\n'* && $token != *$'\r'* ]] || die "token file must contain exactly one non-empty line"
  BACKUP_ID=${BACKUP_ID:-"nebula-$(date -u +%Y%m%dT%H%M%SZ)"}
  [[ $BACKUP_ID =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ ]] || die "backup id must be 1-64 letters, digits, dot, underscore, or hyphen"
  umask 077; CURL_CONFIG=$(mktemp "${TMPDIR:-/tmp}/nebula-curl.XXXXXX"); CURL_PAYLOAD=$(mktemp "${TMPDIR:-/tmp}/nebula-backup.XXXXXX")
  token=${token//\\/\\\\}; token=${token//\"/\\\"}
  printf 'header = "Authorization: Bearer %s"\nheader = "Content-Type: application/json"\n' "$token" >"$CURL_CONFIG"
  printf '{"backupId":"%s"}\n' "$BACKUP_ID" >"$CURL_PAYLOAD"; url="$(setup_url)/api/admin/backups"
  note "creating backup '$BACKUP_ID' (content media is not included)"
  "$CURL_BIN" --fail --silent --show-error --request POST --config "$CURL_CONFIG" --data-binary "@$CURL_PAYLOAD" "$url"; printf '\n'
  rm -f -- "$CURL_CONFIG" "$CURL_PAYLOAD"; CURL_CONFIG=""; CURL_PAYLOAD=""
  note "backup bundle is under the configured NEBULA_BACKUP_PATH; back up content separately"
}

check_prerequisites
case "$COMMAND" in
  init) initialize; validate_configuration; validate_storage ;;
  install) initialize; validate_configuration; validate_storage; start_stack ;;
  validate) validate_configuration; validate_storage ;;
  up|start) validate_configuration; validate_storage; start_stack ;;
  down|stop) require_configuration; compose down ;;
  status) require_configuration; compose ps ;;
  logs) require_configuration; log_args=(logs --tail "$LOG_TAIL"); [[ $FOLLOW == false ]] || log_args+=(-f); log_args+=(dashboard); compose "${log_args[@]}" ;;
  update|upgrade) validate_configuration; validate_storage; note "updating the checked-out revision only; create and verify a backup before migrations"; compose build --pull; compose up -d; wait_for_readiness; note "updated server URL: $(setup_url)" ;;
  backup) create_backup ;;
esac
