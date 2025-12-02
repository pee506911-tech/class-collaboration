#!/bin/bash

# SQLx Migration Script
# Migrations run automatically on server startup, but you can also run them manually

echo "=== SQLx Database Migration ==="
echo ""

# Check if sqlx-cli is installed
if ! command -v sqlx &> /dev/null; then
    echo "SQLx CLI not found. Installing..."
    cargo install sqlx-cli --no-default-features --features mysql
fi

# Load environment
source .env 2>/dev/null || true

if [ -z "$DATABASE_URL" ]; then
    echo "ERROR: DATABASE_URL not set in .env"
    exit 1
fi

echo "Database: $DATABASE_URL"
echo ""

# Run migrations
echo "Running migrations..."
sqlx migrate run

if [ $? -eq 0 ]; then
    echo ""
    echo "✅ Migrations completed successfully!"
else
    echo ""
    echo "❌ Migration failed"
    exit 1
fi
