#!/bin/bash
# Oracle-v2 Installer
# Inspired by claude-mem's installation pattern
#
# Usage: curl -fsSL https://raw.githubusercontent.com/Soul-Brews-Studio/oracle-v2/main/scripts/install.sh | bash

set -e

INSTALL_DIR="${ORACLE_INSTALL_DIR:-$HOME/.local/share/oracle-v2}"
REPO_URL="https://github.com/Soul-Brews-Studio/oracle-v2.git"

echo "🔮 Oracle-v2 Installer"
echo "======================"
echo ""

# Check for bun
if ! command -v bun &> /dev/null; then
    echo "❌ Bun not found. Install it first:"
    echo "   curl -fsSL https://bun.sh/install | bash"
    exit 1
fi

# Check if already installed
if [ -d "$INSTALL_DIR" ]; then
    echo "📁 Found existing installation at $INSTALL_DIR"
    echo "   Updating..."
    cd "$INSTALL_DIR"
    git pull origin main
    bun install
else
    echo "📥 Cloning to $INSTALL_DIR..."
    git clone "$REPO_URL" "$INSTALL_DIR"
    cd "$INSTALL_DIR"
    bun install
fi

echo ""
echo "✅ Installation complete!"
echo ""
echo "📝 Add to Claude Code (~/.claude.json):"
echo ""
cat << EOF
{
  "mcpServers": {
    "oracle-v2": {
      "type": "stdio",
      "command": "bun",
      "args": ["run", "$INSTALL_DIR/src/index.ts"],
      "env": {}
    }
  }
}
EOF
echo ""
echo "Or run: claude mcp add oracle-v2 -- bun run $INSTALL_DIR/src/index.ts"
echo ""
echo "🎉 Restart Claude Code to activate Oracle-v2"
