#!/bin/bash
# Setup oracle-v2 with frontend build
set -e

echo "🔧 Installing root dependencies..."
bun install

echo "🔧 Installing frontend dependencies..."
cd frontend && bun install

echo "🔨 Building frontend..."
bun run build

echo "✅ Setup complete! Run: bun run server"
