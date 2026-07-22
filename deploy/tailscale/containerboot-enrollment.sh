#!/bin/sh
set -eu

control_dir=${NEBULA_TAILSCALE_CONTROL_DIR:-/var/run/nebula-tailscale}
enabled_file="$control_dir/enabled"
login_file="$control_dir/login-url"
connected_file="$control_dir/connected"
fqdn_file="$control_dir/server-fqdn"
serve_ready_file="$control_dir/serve-ready"
serve_error_file="$control_dir/serve-error"
network_status_file="$control_dir/network-status.json"
status_group=${NEBULA_DASHBOARD_GID:-1000}
child_pid=""
reader_pid=""
daemon_pid=""
login_pid=""
stopping=false

mkdir -p "$control_dir"
chown "0:$status_group" "$control_dir"
chmod 0770 "$control_dir"
rm -f "$login_file" "$connected_file" "$fqdn_file" "$serve_ready_file" "$serve_error_file" "$network_status_file"

publish_file() {
  destination=$1
  value=$2
  temporary="$destination.tmp.$$"
  printf '%s\n' "$value" > "$temporary"
  chown "0:$status_group" "$temporary"
  chmod 0640 "$temporary"
  mv -f "$temporary" "$destination"
}

publish_output() {
  fifo=$1
  while IFS= read -r line; do
    printf '%s\n' "$line"
    login_url=$(printf '%s\n' "$line" | grep -Eo 'https://login\.tailscale\.com/a/[A-Za-z0-9]+' | head -n 1 || true)
    [ -z "$login_url" ] || publish_file "$login_file" "$login_url"
  done < "$fifo"
}

publish_login() {
  login_url=$(/usr/local/bin/tailscale --socket=/tmp/tailscaled.sock status --json 2>/dev/null \
    | sed -n 's/^[[:space:]]*"AuthURL":[[:space:]]*"\(https:\/\/login\.tailscale\.com\/a\/[A-Za-z0-9]*\)".*/\1/p' \
    | head -n 1 || true)
  if printf '%s\n' "$login_url" | grep -Eq '^https://login\.tailscale\.com/a/[A-Za-z0-9]+$'; then
    publish_file "$login_file" "$login_url"
  fi
}

publish_connection() {
  publish_file "$connected_file" connected
  rm -f "$login_file"
  dns_name=$(/usr/local/bin/tailscale --socket=/tmp/tailscaled.sock status --json 2>/dev/null \
    | sed -n 's/^[[:space:]]*"DNSName":[[:space:]]*"\([^"]*\)".*/\1/p' \
    | head -n 1 \
    | sed 's/\.$//' || true)
  if printf '%s\n' "$dns_name" | grep -Eq '^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?\.ts\.net$'; then
    publish_file "$fqdn_file" "$(printf '%s' "$dns_name" | tr 'A-Z' 'a-z')"
  fi
}

publish_serve_status() {
  serve_status=$(/usr/local/bin/tailscale --socket=/tmp/tailscaled.sock serve status --json 2>/dev/null || true)
  if printf '%s\n' "$serve_status" | grep -Fq 'http://127.0.0.1:5173'; then
    publish_file "$serve_ready_file" ready
    rm -f "$serve_error_file"
  else
    rm -f "$serve_ready_file"
    publish_file "$serve_error_file" https-required
  fi
}

publish_network_status() {
  temporary="$network_status_file.tmp.$$"
  if /usr/local/bin/tailscale --socket=/tmp/tailscaled.sock status --json > "$temporary" 2>/dev/null; then
    size=$(wc -c < "$temporary" | tr -d ' ')
    if [ "$size" -gt 1 ] && [ "$size" -le 262144 ]; then
      chown "0:$status_group" "$temporary"
      chmod 0640 "$temporary"
      mv -f "$temporary" "$network_status_file"
      return
    fi
  fi
  rm -f "$temporary"
}

stop_child() {
  [ -z "$child_pid" ] || kill -TERM "$child_pid" 2>/dev/null || true
  [ -z "$reader_pid" ] || kill -TERM "$reader_pid" 2>/dev/null || true
  [ -z "$login_pid" ] || kill -TERM "$login_pid" 2>/dev/null || true
  [ -z "$daemon_pid" ] || kill -TERM "$daemon_pid" 2>/dev/null || true
}

shutdown() {
  stopping=true
  stop_child
  rm -f "$login_file" "$connected_file" "$fqdn_file" "$serve_ready_file" "$serve_error_file" "$network_status_file"
}

trap shutdown INT TERM

prepare_interactive_enrollment() {
  case ${TS_AUTHKEY:-} in
    file:*) auth_file=${TS_AUTHKEY#file:} ;;
    *) return 0 ;;
  esac
  [ ! -s "$auth_file" ] || return 0

  socket=/tmp/tailscaled.sock
  rm -f "$socket" /var/run/tailscale/tailscaled.sock
  /usr/local/bin/tailscaled \
    --socket="$socket" \
    --statedir="${TS_STATE_DIR:-/var/lib/tailscale}" \
    --tun=userspace-networking \
    --outbound-http-proxy-listen="${TS_OUTBOUND_HTTP_PROXY_LISTEN:-127.0.0.1:1055}" &
  daemon_pid=$!

  attempts=0
  until /usr/local/bin/tailscale --socket="$socket" status --json >/dev/null 2>&1; do
    kill -0 "$daemon_pid" 2>/dev/null || return 1
    attempts=$((attempts + 1))
    [ "$attempts" -lt 100 ] || return 1
    sleep 0.1
  done

  /usr/local/bin/tailscale --socket="$socket" login \
    --timeout=0s \
    --hostname="${TS_HOSTNAME:-nebula}" \
    --accept-dns=false > /proc/1/fd/1 2>&1 &
  login_pid=$!

  while kill -0 "$daemon_pid" 2>/dev/null; do
    if [ ! -f "$enabled_file" ]; then
      stop_child
      break
    fi
    publish_login
    backend_state=$(/usr/local/bin/tailscale --socket="$socket" status --json 2>/dev/null \
      | sed -n 's/^[[:space:]]*"BackendState":[[:space:]]*"\([A-Za-z]*\)".*/\1/p' \
      | head -n 1 || true)
    [ "$backend_state" != Running ] || break
    if ! kill -0 "$login_pid" 2>/dev/null; then
      set +e
      wait "$login_pid"
      login_result=$?
      set -e
      login_pid=""
      [ "$login_result" -eq 0 ] || return "$login_result"
    fi
    sleep 1
  done

  [ -z "$login_pid" ] || wait "$login_pid" 2>/dev/null || true
  login_pid=""
  [ -z "$daemon_pid" ] || kill -TERM "$daemon_pid" 2>/dev/null || true
  [ -z "$daemon_pid" ] || wait "$daemon_pid" 2>/dev/null || true
  daemon_pid=""
  rm -f "$socket" /var/run/tailscale/tailscaled.sock
}

run_tailscale() {
  fifo="$control_dir/containerboot-output.$$"
  rm -f "$fifo" "$login_file" "$connected_file" "$fqdn_file" "$serve_ready_file" "$serve_error_file" "$network_status_file"
  mkfifo "$fifo"
  publish_output "$fifo" &
  reader_pid=$!
  prepare_interactive_enrollment
  if [ ! -f "$enabled_file" ]; then
    kill -TERM "$reader_pid" 2>/dev/null || true
    wait "$reader_pid" 2>/dev/null || true
    reader_pid=""
    rm -f "$fifo"
    return 0
  fi
  /usr/local/bin/containerboot > "$fifo" 2>&1 &
  child_pid=$!
  published=false
  serve_check=0

  while kill -0 "$child_pid" 2>/dev/null; do
    if [ ! -f "$enabled_file" ]; then
      kill -TERM "$child_pid" 2>/dev/null || true
      break
    fi
    if [ "$published" = false ]; then
      # Newer containerboot releases redact the URL in their output. The local
      # daemon status remains the authoritative source while login is pending.
      publish_login
    fi
    if [ "$published" = false ] && wget -q -O /dev/null http://127.0.0.1:9002/healthz 2>/dev/null; then
      publish_connection
      publish_serve_status
      publish_network_status
      published=true
    fi
    if [ "$published" = true ]; then
      serve_check=$((serve_check + 1))
      if [ "$serve_check" -ge 5 ]; then
        publish_serve_status
        publish_network_status
        serve_check=0
      fi
    fi
    sleep 1
  done

  set +e
  wait "$child_pid"
  result=$?
  wait "$reader_pid" 2>/dev/null
  set -e
  child_pid=""
  reader_pid=""
  rm -f "$fifo" "$login_file" "$connected_file" "$fqdn_file" "$serve_ready_file" "$serve_error_file" "$network_status_file"
  return "$result"
}

while [ "$stopping" = false ]; do
  if [ -f "$enabled_file" ]; then
    run_tailscale || result=$?
    # An enabled daemon should be long-lived. Exit so Docker's restart policy
    # can reattach this container if the shared dashboard namespace changed.
    [ ! -f "$enabled_file" ] || exit "${result:-1}"
  else
    sleep 1
  fi
done
