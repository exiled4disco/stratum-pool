#!/bin/bash

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${YELLOW}Starting GitHub sync...${NC}"

# Navigate to project directory
cd ~/stratum-pool

# Check if there are any changes
if [ -n "$(git status --porcelain)" ]; then
    echo -e "${YELLOW}Changes detected, syncing...${NC}"
    
    # Add all changes
    git add .
    
    # Commit with timestamp
    TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')
    git commit -m "Auto-sync: $TIMESTAMP"
    
    # Push to GitHub
    if git push origin main; then
        echo -e "${GREEN}✅ Successfully synced to GitHub!${NC}"
    else
        echo -e "${RED}❌ Failed to push to GitHub${NC}"
        exit 1
    fi
else
    echo -e "${GREEN}No changes to sync${NC}"
fi

echo -e "${GREEN}Sync complete!${NC}"
