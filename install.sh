#!/usr/bin/env bash
# Install ai-coder on a fresh Linux VPS.
#
# Idempotent: safe to re-run. Clones (or pulls) the repo into ~/ai-coder,
# installs deps, builds the frontend, and installs the Claude Code CLI into
# a user-owned npm prefix so no sudo is needed.
#
# Usage (run as the target user, NOT root):
#   curl -fsSL https://raw.githubusercontent.com/aisendhub/ai-coder/main/install.sh | bash
# or:
#   ssh user@host 'bash -s' < install.sh

set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/aisendhub/ai-coder.git}"
INSTALL_DIR="${INSTALL_DIR:-$HOME/ai-coder}"
NPM_PREFIX="${NPM_PREFIX:-$HOME/.npm-global}"

log() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!!\033[0m %s\n' "$*" >&2; }
die() { printf '\033[1;31mxx\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] && die "Run as a regular user, not root."

log "Checking prerequisites"
command -v git >/dev/null || die "git is required"
command -v node >/dev/null || die "node >=22 is required"
command -v npm >/dev/null || die "npm is required"

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 22 ] || die "node >=22 required (have $(node -v))"

log "Configuring user-level npm prefix at $NPM_PREFIX"
mkdir -p "$NPM_PREFIX"
npm config set prefix "$NPM_PREFIX"

SHELL_RC=""
case "${SHELL:-}" in
  */zsh) SHELL_RC="$HOME/.zshrc" ;;
  *)    SHELL_RC="$HOME/.bashrc" ;;
esac
if [ -n "$SHELL_RC" ] && ! grep -qs "npm-global/bin" "$SHELL_RC"; then
  echo "export PATH=\"$NPM_PREFIX/bin:\$PATH\"" >> "$SHELL_RC"
  log "Added $NPM_PREFIX/bin to PATH in $SHELL_RC"
fi
export PATH="$NPM_PREFIX/bin:$PATH"

log "Installing Claude Code CLI"
npm install -g @anthropic-ai/claude-code >/dev/null
claude --version

if [ -d "$INSTALL_DIR/.git" ]; then
  log "Updating existing checkout in $INSTALL_DIR"
  git -C "$INSTALL_DIR" pull --ff-only
else
  log "Cloning $REPO_URL into $INSTALL_DIR"
  git clone "$REPO_URL" "$INSTALL_DIR"
fi

cd "$INSTALL_DIR"

log "Installing npm dependencies"
npm install

log "Building frontend"
npm run build

if [ ! -f "$INSTALL_DIR/.env" ]; then
  cat > "$INSTALL_DIR/.env" <<'EOF'
# ai-coder environment
# Fill these in, then restart the server.

# Auth: either set ANTHROPIC_API_KEY, or leave it unset and run `claude /login`.
# ANTHROPIC_API_KEY=sk-ant-...

# Supabase
VITE_SUPABASE_URL=
VITE_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=

# Optional: directory the UI browser can traverse (defaults to parent of install dir)
# PROJECTS_ROOT=/home/admin

# Optional: port (default 3001)
# PORT=3001
EOF
  warn "Created template .env — fill in Supabase keys before starting."
else
  log ".env already present, leaving untouched"
fi

cat <<EOF

$(printf '\033[1;32m✓ ai-coder installed at %s\033[0m\n' "$INSTALL_DIR")

Next steps:
  1. Edit $INSTALL_DIR/.env (Supabase keys + optional ANTHROPIC_API_KEY)
  2. If using subscription auth: run \`claude /login\` once
  3. Start the server:
       cd $INSTALL_DIR && NODE_ENV=production npm start
  4. (Optional) wire up systemd or pm2 for supervision.
EOF
