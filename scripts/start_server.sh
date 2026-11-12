#!/usr/bin/env bash
set -eo pipefail

HOST="${HOST:-0.0.0.0}"
PORT="${PORT:-8000}"
RESTART_INTERVAL="${RESTART_INTERVAL_SECONDS:-18000}"

echo "===================================================================="
echo " Starting AS Telegram & Messaging Relay Server (5-Hour Cycle)"
echo " Host: $HOST | Port: $PORT"
echo " Restart Interval: ${RESTART_INTERVAL}s"
echo "===================================================================="

cleanup() {
    echo "Caught shutdown signal. Terminating child processes cleanly..."
    if [ -n "$SERVER_PID" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
        kill -TERM "$SERVER_PID" 2>/dev/null || true
    fi
    if [ -n "$TUNNEL_PID" ] && kill -0 "$TUNNEL_PID" 2>/dev/null; then
        kill -TERM "$TUNNEL_PID" 2>/dev/null || true
    fi
    exit 0
}
trap cleanup SIGINT SIGTERM EXIT

# Restore Proton credentials
if [ -d "config/proton-cli" ]; then
    echo "Restoring Proton CLI credentials..."
    mkdir -p "$HOME/.config/proton-cli"
    cp -r config/proton-cli/* "$HOME/.config/proton-cli/" || true
    chmod -R 700 "$HOME/.config/proton-cli" || true
fi

# Start Node.js Relay Server
node src/server.js &
SERVER_PID=$!
echo "Node server PID: $SERVER_PID"

echo "Waiting for local server to become healthy..."
for i in $(seq 1 40); do
    if curl -s "http://127.0.0.1:$PORT/health" | grep -q '"status":\s*"ok"'; then
        echo "Server is HEALTHY and ready!"
        break
    fi
    sleep 1
done

# Start Cloudflare Tunnel
if command -v cloudflared &> /dev/null; then
    echo "Launching Cloudflare Quick Tunnel..."
    cloudflared tunnel --url "http://127.0.0.1:$PORT" --no-autoupdate > tunnel.log 2>&1 &
    TUNNEL_PID=$!

    for i in $(seq 1 45); do
        sleep 1
        if grep -o "https://[-a-zA-Z0-9@:%._\+~#=]\+\.trycloudflare\.com" tunnel.log > /dev/null 2>&1; then
            PUBLIC_URL=$(grep -o "https://[-a-zA-Z0-9@:%._\+~#=]\+\.trycloudflare\.com" tunnel.log | head -n 1)
            echo "Public Edge Relay URL: $PUBLIC_URL"
            echo "$PUBLIC_URL" > endpoint.txt
            
            # Immediately notify Vercel API
            curl -s -X POST -H "Content-Type: application/json" -d "{\"url\":\"$PUBLIC_URL\"}" "https://asllm.vercel.app/api/msg?action=set_relay_url" || true

            git config user.name "github-actions[bot]"
            git config user.email "github-actions[bot]@users.noreply.github.com"
            if [ -n "$GH_PAT" ]; then
                git remote set-url origin "https://x-access-token:${GH_PAT}@github.com/ugv0/as-telegram-relay.git"
            fi
            git add endpoint.txt
            git commit -m "chore: update live endpoint.txt [skip ci]" || true
            git push origin main || true
            break
        fi
    done
fi

echo "Serving real-time requests for $RESTART_INTERVAL seconds (~5 hours)..."
sleep "$RESTART_INTERVAL"

echo "5-hour cycle completed. Graceful restart commencing..."
kill -TERM "$SERVER_PID" 2>/dev/null || true
