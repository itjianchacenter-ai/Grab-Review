#!/bin/bash
# Cloudflare Tunnel deployment for JIANCHA Dashboard
# Run AFTER `cloudflared tunnel login` completes
set -e

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TUNNEL_NAME="jiancha-dashboard"
HOSTNAME="dashboard.jc-group-global.com"
LOCAL_URL="http://localhost:8765"

echo "═══ Cloudflare Tunnel Deployment ═══"
echo ""

# 1. Check auth
if [ ! -f "$HOME/.cloudflared/cert.pem" ]; then
  echo "✗ Not logged in — run: cloudflared tunnel login"
  exit 1
fi
echo "✓ cloudflared authorized"

# 2. Create tunnel (skip if exists)
if cloudflared tunnel list 2>/dev/null | grep -q "$TUNNEL_NAME"; then
  echo "✓ Tunnel '$TUNNEL_NAME' already exists"
  TUNNEL_ID=$(cloudflared tunnel list 2>/dev/null | grep "$TUNNEL_NAME" | awk '{print $1}')
else
  echo "→ Creating tunnel '$TUNNEL_NAME'..."
  cloudflared tunnel create "$TUNNEL_NAME"
  TUNNEL_ID=$(cloudflared tunnel list 2>/dev/null | grep "$TUNNEL_NAME" | awk '{print $1}')
  echo "✓ Tunnel created (id: $TUNNEL_ID)"
fi

# 3. Write config
CONFIG="$HOME/.cloudflared/config.yml"
cat > "$CONFIG" <<EOF
tunnel: $TUNNEL_ID
credentials-file: $HOME/.cloudflared/$TUNNEL_ID.json

ingress:
  - hostname: $HOSTNAME
    service: $LOCAL_URL
    originRequest:
      noTLSVerify: true
      connectTimeout: 30s
  - service: http_status:404
EOF
echo "✓ Config written: $CONFIG"

# 4. DNS route
echo "→ Routing DNS $HOSTNAME → $TUNNEL_NAME..."
cloudflared tunnel route dns "$TUNNEL_NAME" "$HOSTNAME" 2>&1 | tail -3 || true
echo "✓ DNS route configured"

# 5. Install service (auto-start on boot)
echo "→ Installing tunnel as service..."
sudo cloudflared service uninstall 2>/dev/null || true
sudo cloudflared service install
echo "✓ Service installed (will need: sudo password)"

# 6. Update server env for production
ENV_FILE="$ROOT/.env.production"
cat > "$ENV_FILE" <<EOF
HOST=127.0.0.1
PORT=8765
SECURE_COOKIE=true
CORS_ORIGINS=https://$HOSTNAME
EOF
echo "✓ Production env: $ENV_FILE"

# 7. Update dashboard launchd plist with new env
DASH_PLIST="$HOME/Library/LaunchAgents/com.jiancha.dashboard.plist"
if [ -f "$DASH_PLIST" ]; then
  /usr/libexec/PlistBuddy -c "Delete :EnvironmentVariables:CORS_ORIGINS" "$DASH_PLIST" 2>/dev/null || true
  /usr/libexec/PlistBuddy -c "Add :EnvironmentVariables:CORS_ORIGINS string https://$HOSTNAME" "$DASH_PLIST"
  /usr/libexec/PlistBuddy -c "Delete :EnvironmentVariables:SECURE_COOKIE" "$DASH_PLIST" 2>/dev/null || true
  /usr/libexec/PlistBuddy -c "Add :EnvironmentVariables:SECURE_COOKIE string true" "$DASH_PLIST"
  launchctl unload "$DASH_PLIST"
  launchctl load "$DASH_PLIST"
  echo "✓ Dashboard restarted with HTTPS-aware config"
fi

echo ""
echo "═══ ✓ Deployment complete ═══"
echo ""
echo "Live at: https://$HOSTNAME"
echo "Tunnel:  $TUNNEL_NAME ($TUNNEL_ID)"
echo ""
echo "Verify (~30s after DNS propagation):"
echo "  curl -fsS https://$HOSTNAME/api/health"
echo ""
echo "Manage:"
echo "  cloudflared tunnel list"
echo "  cloudflared tunnel info $TUNNEL_NAME"
echo "  sudo launchctl unload /Library/LaunchDaemons/com.cloudflare.cloudflared.plist  # stop"
