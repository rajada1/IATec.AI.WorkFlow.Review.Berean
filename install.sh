#!/usr/bin/env bash
# Berean installer - install globally from GitHub
set -eo pipefail

REPO="https://github.com/iatecbr/IATec.AI.WorkFlow.Review.Berean.git"
INSTALL_DIR="${BEREAN_INSTALL_DIR:-$HOME/.berean-cli}"

get_version() {
  local dir="$1"
  if [ -f "$dir/package.json" ]; then
    grep '"version"' "$dir/package.json" | head -1 | sed 's/.*"version": *"\([^"]*\)".*/\1/'
  fi
}

# Remove previous installation to ensure fresh install
if [ -d "$INSTALL_DIR" ]; then
  CURRENT_VERSION=$(get_version "$INSTALL_DIR")
  echo "🧹 Cleaning previous installation (current: v$CURRENT_VERSION)..."
  rm -rf "$INSTALL_DIR"
fi

echo "📦 Installing Berean..."
echo "  Cloning from GitHub..."
git clone "$REPO" "$INSTALL_DIR"
cd "$INSTALL_DIR"

NEW_VERSION=$(get_version "$INSTALL_DIR")

# Install dependencies (including devDependencies needed for build)
echo "  Installing dependencies..."
npm install

# Build TypeScript sources
echo "  Building..."
npm run build

# Ensure entry point is executable
chmod +x "$INSTALL_DIR/dist/index.js"

# Link globally (may fail on restricted systems, handled below)
echo "  Linking globally..."
if ! npm link 2>&1; then
  echo "  ⚠️  npm link failed; falling back to manual symlink"
fi

# Determine npm global bin directory
NPM_GLOBAL_BIN="$(npm prefix -g)/bin"

# Ensure the linked binary is executable
chmod +x "$NPM_GLOBAL_BIN/berean" 2>/dev/null || true

# Fallback: create symlink in /usr/local/bin if npm link target is not in PATH
if ! command -v berean &>/dev/null; then
  if [ -d "/usr/local/bin" ] && ln -sf "$INSTALL_DIR/dist/index.js" /usr/local/bin/berean 2>/dev/null; then
    echo "  Linked berean → /usr/local/bin/berean"
  elif mkdir -p "$HOME/.local/bin" && ln -sf "$INSTALL_DIR/dist/index.js" "$HOME/.local/bin/berean" 2>/dev/null; then
    export PATH="$HOME/.local/bin:$PATH"
    echo "  Linked berean → $HOME/.local/bin/berean"
  fi
fi

# Add npm global bin and ~/.local/bin to shell profiles for future sessions
add_to_profile() {
  local profile="$1"
  local dir="$2"
  if [ -f "$profile" ]; then
    if ! grep -q "$dir" "$profile" 2>/dev/null; then
      {
        echo ""
        echo "# Added by Berean installer"
        echo "export PATH=\"$dir:\$PATH\""
      } >> "$profile"
    fi
  fi
}

# Ensure npm global bin is in PATH for current and future sessions
if [[ ":$PATH:" != *":$NPM_GLOBAL_BIN:"* ]]; then
  export PATH="$NPM_GLOBAL_BIN:$PATH"
  add_to_profile "$HOME/.bashrc" "$NPM_GLOBAL_BIN"
  add_to_profile "$HOME/.profile" "$NPM_GLOBAL_BIN"
fi

echo ""
if [ -n "$CURRENT_VERSION" ] && [ "$CURRENT_VERSION" != "$NEW_VERSION" ]; then
  echo "✅ Berean updated: v$CURRENT_VERSION → v$NEW_VERSION"
elif [ -n "$CURRENT_VERSION" ] && [ "$CURRENT_VERSION" = "$NEW_VERSION" ]; then
  echo "✅ Berean updated to v$NEW_VERSION"
else
  echo "✅ Berean v$NEW_VERSION installed!"
fi

# Verify installation
if command -v berean &>/dev/null; then
  echo "   Run: berean --help"
else
  echo "   ⚠️  'berean' is not in your current PATH."
  echo "   Add npm global bin to your PATH and retry:"
  echo "     export PATH=\"$NPM_GLOBAL_BIN:\$PATH\""
  echo "   Or restart your shell: source ~/.bashrc"
fi
echo "   Location: $INSTALL_DIR"
