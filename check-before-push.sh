#!/bin/bash

# Git Push Safety Checker
# Run this BEFORE pushing to GitHub

echo "🔍 Git Push Safety Checker"
echo "=========================="
echo ""

# Check if git is initialized
if [ ! -d .git ]; then
    echo "⚠️  Git not initialized yet. Run: git init"
    echo ""
fi

echo "✅ Checking what will be pushed..."
echo ""

# Simulate what would be added
git add -n . 2>/dev/null > /tmp/git_add_preview.txt || echo "Git not initialized - showing file preview instead"

# Count source files
SOURCE_COUNT=$(find apps/backend/src apps/web/src packages/shared/src -type f 2>/dev/null | wc -l | tr -d ' ')
echo "📝 Source files to push: $SOURCE_COUNT"

# Check for node_modules
NODE_MODULES_COUNT=$(find . -name "node_modules" -type d 2>/dev/null | wc -l | tr -d ' ')
echo "📦 node_modules found: $NODE_MODULES_COUNT (should be IGNORED)"

# Check for .env files
ENV_FILES=$(find apps -name ".env" -not -name "*.example" 2>/dev/null | wc -l | tr -d ' ')
echo "🔒 .env files found: $ENV_FILES (should be IGNORED)"

# Check for .env.example files  
ENV_EXAMPLE=$(find apps -name ".env.example" 2>/dev/null | wc -l | tr -d ' ')
echo "📄 .env.example files: $ENV_EXAMPLE (should be INCLUDED)"

echo ""
echo "==================================="
echo ""

# Verify packages/shared exists
if [ -d "packages/shared/src" ]; then
    SHARED_FILES=$(find packages/shared/src -type f 2>/dev/null | wc -l | tr -d ' ')
    echo "✅ packages/shared/src found ($SHARED_FILES files) - GOOD!"
else
    echo "❌ packages/shared/src NOT FOUND - BUILD WILL FAIL!"
fi

echo ""

# Check if .gitignore exists
if [ -f ".gitignore" ]; then
    echo "✅ Root .gitignore exists"
    
    # Verify node_modules is in gitignore
    if grep -q "node_modules" .gitignore; then
        echo "✅ node_modules is gitignored"
    else
        echo "❌ WARNING: node_modules not in .gitignore!"
    fi
    
    # Verify .env is in gitignore
    if grep -q "\.env" .gitignore; then
        echo "✅ .env files are gitignored"
    else
        echo "❌ WARNING: .env not in .gitignore!"
    fi
else
    echo "❌ .gitignore not found!"
fi

echo ""
echo "==================================="
echo ""

# Final safety check
if [ -d .git ]; then
    echo "🔍 Checking staged files for secrets..."
    
    # Check if .env would be committed
    if git ls-files -c | grep -q "apps/.*\.env$" 2>/dev/null; then
        echo "❌ DANGER: .env file is staged! Remove it before pushing!"
        echo "   Run: git reset apps/backend/.env apps/web/.env"
    else
        echo "✅ No .env files staged"
    fi
    
    # Check if node_modules would be committed
    if git ls-files -c | grep -q "node_modules" 2>/dev/null; then
        echo "❌ DANGER: node_modules is staged! This will add 10,000+ files!"
        echo "   Run: git reset"
    else
        echo "✅ node_modules not staged"
    fi
    
    echo ""
    echo "📊 Git Status:"
    git status --short | head -20
    
    TOTAL_STAGED=$(git status --short | wc -l | tr -d ' ')
    echo ""
    echo "Total files staged: $TOTAL_STAGED"
    
    if [ $TOTAL_STAGED -gt 1000 ]; then
        echo "⚠️  WARNING: More than 1000 files! You might be including node_modules."
    elif [ $TOTAL_STAGED -lt 50 ]; then
        echo "⚠️  WARNING: Less than 50 files. Did you forget to add something?"
    else
        echo "✅ File count looks reasonable"
    fi
fi

echo ""
echo "==================================="
echo ""
echo "🎯 Next Steps:"
echo ""
if [ ! -d .git ]; then
    echo "1. git init"
    echo "2. git add ."
    echo "3. Run this script again to verify"
else
    if [ $TOTAL_STAGED -eq 0 ]; then
        echo "1. git add ."
        echo "2. Run this script again"
    else
        echo "1. Review the files above"
        echo "2. git commit -m 'Initial commit'"
        echo "3. git remote add origin YOUR_GITHUB_URL"
        echo "4. git push -u origin main"
    fi
fi
echo ""
