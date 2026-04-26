#!/bin/bash
#
# Qoral Project Pre-Commit Hook (WARNING ONLY)
#
# Non-blocking reminders about documentation and test updates.
# The commit-msg hook handles actual enforcement with [skip-docs]/[skip-tests] bypass.
#

# Colors for output
YELLOW='\033[1;33m'
BOLD='\033[1m'
NC='\033[0m' # No Color

# Get list of staged files
STAGED_FILES=$(git diff --cached --name-only)

WARNINGS=""

# Check if CLAUDE.md is staged
if ! echo "$STAGED_FILES" | grep -q "^CLAUDE.md$"; then
    WARNINGS="${WARNINGS}claude,"
fi

# Check if CHANGELOG.md is staged
if ! echo "$STAGED_FILES" | grep -q "^CHANGELOG.md$"; then
    WARNINGS="${WARNINGS}changelog,"
fi

# Check if tests are staged when source changes.
# Source/test patterns are configurable via `git config git-guard.source-pattern`
# and `git-guard.test-pattern`. Defaults match both single-package and monorepo
# layouts and both `test/` and `tests/` conventions.
SOURCE_PATTERN=$(git config --get git-guard.source-pattern 2>/dev/null || echo '^(src|packages/[^/]+/src|lib)/')
TEST_PATTERN=$(git config --get git-guard.test-pattern 2>/dev/null || echo '^(tests?|packages/[^/]+/tests?)/')
SRC_CHANGES=$(echo "$STAGED_FILES" | grep -E "$SOURCE_PATTERN")
TEST_CHANGES=$(echo "$STAGED_FILES" | grep -E "$TEST_PATTERN")
if [ -n "$SRC_CHANGES" ] && [ -z "$TEST_CHANGES" ]; then
    WARNINGS="${WARNINGS}tests,"
fi

# Check for repository changes without migrations
REPO_CHANGES=$(echo "$STAGED_FILES" | grep -E "^src/repositories/.*\.js$" || true)
MIGRATION_STAGED=$(echo "$STAGED_FILES" | grep -E "^sql/migrations/.*\.sql$" || true)
if [ -n "$REPO_CHANGES" ] && [ -z "$MIGRATION_STAGED" ]; then
    WARNINGS="${WARNINGS}migrations,"
fi

# Check for published-docs changes without SUMMARY.md update
PUBLISHED_DOCS_CHANGES=$(echo "$STAGED_FILES" | grep -E "^docs/published-docs/" || true)
SUMMARY_STAGED=$(echo "$STAGED_FILES" | grep "^SUMMARY.md$" || true)
if [ -n "$PUBLISHED_DOCS_CHANGES" ] && [ -z "$SUMMARY_STAGED" ]; then
    WARNINGS="${WARNINGS}summary,"
fi

# Check for infrastructure-affecting changes without Terraform updates
NEW_DOCKERFILES=$(echo "$STAGED_FILES" | grep -E "^Dockerfile\." || true)
NEW_CLOUDBUILDS=$(echo "$STAGED_FILES" | grep -E "^cloudbuild\..*\.yaml$" || true)
GATEWAY_CHANGES=$(echo "$STAGED_FILES" | grep -E "^src/(orchestration/.*-gateway|api/server).*\.js$" || true)
PUBSUB_CHANGES=$(echo "$STAGED_FILES" | grep -E "^src/(integrations/gcp/pubsub|worker)\.js$" || true)
INFRA_AFFECTING="$NEW_DOCKERFILES$NEW_CLOUDBUILDS$GATEWAY_CHANGES$PUBSUB_CHANGES"
TERRAFORM_STAGED=$(echo "$STAGED_FILES" | grep -E "^infra/.*\.tf$" || true)

if [ -n "$INFRA_AFFECTING" ] && [ -z "$TERRAFORM_STAGED" ]; then
    WARNINGS="${WARNINGS}infra,"
fi

# Detect migration-number collisions across the whole sql/migrations/ tree.
# See commit-msg.sh for the rationale (prefix-keyed schema_migrations means
# silent double-application + later silent skip). Advisory here; the
# commit-msg hook will block if the collision survives.
MIGRATION_COLLISION_DETAIL=""
if [ -d "sql/migrations" ]; then
    DUPLICATE_PREFIXES=$(ls sql/migrations/ 2>/dev/null \
        | grep -E '^[0-9]{3}_.*\.sql$' \
        | cut -c1-3 \
        | sort \
        | uniq -d)
    if [ -n "$DUPLICATE_PREFIXES" ]; then
        MIGRATION_COLLISION_DETAIL="$DUPLICATE_PREFIXES"
        WARNINGS="${WARNINGS}migration-collision,"
    fi
fi

# Show warnings (non-blocking)
if [ -n "$WARNINGS" ]; then
    echo ""
    echo -e "${YELLOW}${BOLD}Pre-commit reminders:${NC}"

    if echo "$WARNINGS" | grep -q "claude"; then
        echo -e "  ${YELLOW}⚠${NC} CLAUDE.md not staged — update if architecture, dependencies, or components changed"
    fi

    if echo "$WARNINGS" | grep -q "changelog"; then
        echo -e "  ${YELLOW}⚠${NC} CHANGELOG.md not staged — update if adding features, fixes, or version changes"
    fi

    if echo "$WARNINGS" | grep -q "tests"; then
        TEST_HINT="test/"
        if [ -d tests ]; then TEST_HINT="tests/"; fi
        echo -e "  ${YELLOW}⚠${NC} ${TEST_HINT} not staged — update if source changes introduce new exports, APIs, or behaviors"
    fi

    if echo "$WARNINGS" | grep -q "migrations"; then
        echo -e "  ${YELLOW}⚠${NC} sql/migrations/ not staged — repository changes may need a migration"
    fi

    if echo "$WARNINGS" | grep -q "summary"; then
        echo -e "  ${YELLOW}⚠${NC} SUMMARY.md not staged — docs/published-docs/ changed; update the GitBook table of contents if files were added/removed/renamed"
        echo "$PUBLISHED_DOCS_CHANGES" | sed 's/^/      - /'
    fi

    if echo "$WARNINGS" | grep -q "infra"; then
        echo -e "  ${YELLOW}⚠${NC} Infrastructure-affecting changes detected — verify Terraform is updated"
        echo -e "    Detected:"
        [ -n "$NEW_DOCKERFILES" ] && echo "$NEW_DOCKERFILES" | sed 's/^/      - /'
        [ -n "$NEW_CLOUDBUILDS" ] && echo "$NEW_CLOUDBUILDS" | sed 's/^/      - /'
        [ -n "$GATEWAY_CHANGES" ] && echo "$GATEWAY_CHANGES" | sed 's/^/      - /'
        [ -n "$PUBSUB_CHANGES" ] && echo "$PUBSUB_CHANGES" | sed 's/^/      - /'
    fi

    if echo "$WARNINGS" | grep -q "migration-collision"; then
        echo -e "  ${YELLOW}⚠${NC} Migration-number collision in sql/migrations/ — two files share a 3-digit prefix"
        for prefix in $MIGRATION_COLLISION_DETAIL; do
            echo -e "      Prefix ${BOLD}${prefix}${NC}:"
            ls sql/migrations/ | grep -E "^${prefix}_" | sed 's/^/        - /'
        done
        echo -e "    ${YELLOW}Rename the later file to the next unused number and make its DDL idempotent.${NC}"
    fi

    echo -e "  ${YELLOW}The commit-msg hook will block unless these are staged or [skip-docs]/[skip-tests] is in the message.${NC}"
    echo ""
fi

# Always pass (non-blocking)
exit 0
