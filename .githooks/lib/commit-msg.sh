#!/bin/bash
#
# Qoral Project Commit-Msg Hook
# Ensures CLAUDE.md and tests are updated with every commit.
#
# Skip tags (add to commit message to bypass specific checks):
#   [skip-docs]  - Skip CLAUDE.md and CHANGELOG.md check
#   [skip-tests] - Skip test file staging check
#   [skip-infra] - Skip Terraform check when Dockerfiles/cloudbuild change
#   [skip-bump]  - Skip version-bump requirement (only active when git-guard.version-file is set)
#   [major-bump] - Explicit opt-in for a major semver bump (only active when version-bump enforcement is on)
#

# Colors for output
RED='\033[0;31m'
YELLOW='\033[1;33m'
GREEN='\033[0;32m'
BOLD='\033[1m'
NC='\033[0m' # No Color

# Read commit message
COMMIT_MSG=$(cat "$1")

# Check for skip tags in commit message
SKIP_DOCS=false
SKIP_TESTS=false
if echo "$COMMIT_MSG" | grep -q "\[skip-docs\]"; then
    SKIP_DOCS=true
fi
if echo "$COMMIT_MSG" | grep -q "\[skip-tests\]"; then
    SKIP_TESTS=true
fi
SKIP_INFRA=false
if echo "$COMMIT_MSG" | grep -q "\[skip-infra\]"; then
    SKIP_INFRA=true
fi
SKIP_BUMP=false
if echo "$COMMIT_MSG" | grep -q "\[skip-bump\]"; then
    SKIP_BUMP=true
fi
MAJOR_BUMP_ALLOWED=false
if echo "$COMMIT_MSG" | grep -q "\[major-bump\]"; then
    MAJOR_BUMP_ALLOWED=true
fi

# Get list of staged files
STAGED_FILES=$(git diff --cached --name-only)

# Track blocking errors (collect all before exiting)
BLOCK_ERRORS=""

# Check if CLAUDE.md is in the staged files (skipped by [skip-docs])
CLAUDE_MISSING=false
if [ "$SKIP_DOCS" = false ]; then
    if ! echo "$STAGED_FILES" | grep -q "^CLAUDE.md$"; then
        CLAUDE_MISSING=true
        BLOCK_ERRORS="${BLOCK_ERRORS}claude,"
    fi
fi

# Check if CHANGELOG.md is in the staged files (skipped by [skip-docs])
CHANGELOG_MISSING=false
if [ "$SKIP_DOCS" = false ]; then
    if ! echo "$STAGED_FILES" | grep -q "^CHANGELOG.md$"; then
        CHANGELOG_MISSING=true
        BLOCK_ERRORS="${BLOCK_ERRORS}changelog,"
    fi
fi

# Check if SUMMARY.md is updated when docs/published-docs/ changes (skipped by [skip-docs])
PUBLISHED_DOCS_CHANGES=$(echo "$STAGED_FILES" | grep -E "^docs/published-docs/" || true)
SUMMARY_MISSING=false
if [ "$SKIP_DOCS" = false ]; then
    if [ -n "$PUBLISHED_DOCS_CHANGES" ] && ! echo "$STAGED_FILES" | grep -q "^SUMMARY.md$"; then
        SUMMARY_MISSING=true
        BLOCK_ERRORS="${BLOCK_ERRORS}summary,"
    fi
fi

# Check if tests are updated when src files change (skipped by [skip-tests]).
# Source/test patterns are configurable via `git config git-guard.source-pattern`
# and `git-guard.test-pattern`. Defaults match both single-package and monorepo
# layouts and both `test/` and `tests/` conventions.
SOURCE_PATTERN=$(git config --get git-guard.source-pattern 2>/dev/null || echo '^(src|packages/[^/]+/src|lib)/')
TEST_PATTERN=$(git config --get git-guard.test-pattern 2>/dev/null || echo '^(tests?|packages/[^/]+/tests?)/')
SRC_CHANGES=$(echo "$STAGED_FILES" | grep -E "$SOURCE_PATTERN" | head -5)
DATA_CHANGES=$(echo "$STAGED_FILES" | grep "^data/" | head -5)
TEST_CHANGES=$(echo "$STAGED_FILES" | grep -E "$TEST_PATTERN")

TESTS_MISSING=false
if [ "$SKIP_TESTS" = false ]; then
    if [ -n "$SRC_CHANGES" ] && [ -z "$TEST_CHANGES" ]; then
        TESTS_MISSING=true
        BLOCK_ERRORS="${BLOCK_ERRORS}tests,"
    fi
fi

# Migration number collision detection (BLOCKING, no skip tag).
# Two files sharing the same 3-digit prefix is a silent bug:
# run-migrations.js keys schema_migrations by the prefix, so only the
# first applied registers — both SQL files run, and any re-run skips
# them entirely. Caught live on 2026-04-18 after 065_tenant_context
# (Sean, PR #141) and 065_slack_channel_context (Jake, PR #161) landed
# two days apart. This check runs on every commit regardless of what's
# staged — collisions are project-wide and require intervention even
# if the current commit doesn't touch sql/migrations/.
MIGRATION_COLLISION_DETAIL=""
if [ -d "sql/migrations" ]; then
    DUPLICATE_PREFIXES=$(ls sql/migrations/ 2>/dev/null \
        | grep -E '^[0-9]{3}_.*\.sql$' \
        | cut -c1-3 \
        | sort \
        | uniq -d)
    if [ -n "$DUPLICATE_PREFIXES" ]; then
        BLOCK_ERRORS="${BLOCK_ERRORS}migration-collision,"
        MIGRATION_COLLISION_DETAIL="$DUPLICATE_PREFIXES"
    fi
fi

# Check for infrastructure-affecting changes
# Dockerfile/cloudbuild changes = BLOCKING (directly map to Terraform resources)
# Gateway/pubsub changes = WARNING (softer correlation)
INFRA_BLOCK=false
INFRA_WARNING=false
if [ "$SKIP_INFRA" = false ]; then
    NEW_DOCKERFILES=$(echo "$STAGED_FILES" | grep -E "^Dockerfile\." || true)
    NEW_CLOUDBUILDS=$(echo "$STAGED_FILES" | grep -E "^cloudbuild\..*\.yaml$" || true)
    GATEWAY_CHANGES=$(echo "$STAGED_FILES" | grep -E "^src/(orchestration/.*-gateway|api/server).*\.js$" || true)
    PUBSUB_CHANGES=$(echo "$STAGED_FILES" | grep -E "^src/(integrations/gcp/pubsub|worker)\.js$" || true)
    TERRAFORM_STAGED=$(echo "$STAGED_FILES" | grep -E "^infra/.*\.tf$" || true)

    # Dockerfiles + cloudbuilds directly define Cloud Run services, secrets, IAM → block
    HARD_INFRA="$NEW_DOCKERFILES$NEW_CLOUDBUILDS"
    if [ -n "$HARD_INFRA" ] && [ -z "$TERRAFORM_STAGED" ]; then
        INFRA_BLOCK=true
        BLOCK_ERRORS="${BLOCK_ERRORS}infra,"
    fi

    # Gateway/pubsub changes may need infra updates → warn only
    SOFT_INFRA="$GATEWAY_CHANGES$PUBSUB_CHANGES"
    if [ -n "$SOFT_INFRA" ] && [ -z "$TERRAFORM_STAGED" ] && [ "$INFRA_BLOCK" = false ]; then
        INFRA_WARNING=true
    fi
fi

# Version bump enforcement (opt-in via git config git-guard.version-file)
#
# Policy:
#   - If version-file is configured, every commit must bump its .version field.
#   - Patch and minor bumps: allowed.
#   - Major bumps (x.0.0 from (x-1).y.z): blocked unless [major-bump] in message.
#   - Downgrades (any decrease): always blocked.
#   - Irregular bumps (e.g. 1.2.3 → 1.4.0 skipping minor resets): blocked.
#   - Skip with [skip-bump] for commits that genuinely shouldn't cut a new
#     version (e.g. CI-only, hook tweaks, untracked local config).
#
# Old version is read from HEAD's committed version-file. New version is
# read from the staged content (git show :path) to support commits that
# stage the bump alongside other changes. Requires `jq` for JSON parsing;
# if `jq` is missing, the check logs a warning and skips rather than blocks.
VERSION_FILE=$(git config --get git-guard.version-file 2>/dev/null || true)
VERSION_BUMP_DETAIL=""
VERSION_BUMP_ERROR=""
if [ -n "$VERSION_FILE" ]; then
    if ! command -v jq >/dev/null 2>&1; then
        echo -e "${YELLOW}⚠${NC} git-guard.version-file is set but jq is not installed — skipping version-bump check."
    elif ! git rev-parse --verify HEAD >/dev/null 2>&1; then
        : # initial commit, nothing to compare against
    elif ! git show "HEAD:$VERSION_FILE" >/dev/null 2>&1; then
        : # version-file did not exist in HEAD — treat as first introduction, allow
    else
        OLD_RAW=$(git show "HEAD:$VERSION_FILE" | jq -r '.version // empty' 2>/dev/null || echo "")
        # Prefer staged content; fall back to working tree if file exists but isn't staged
        NEW_RAW=$(git show ":$VERSION_FILE" 2>/dev/null | jq -r '.version // empty' 2>/dev/null || echo "")
        if [ -z "$NEW_RAW" ] && [ -f "$VERSION_FILE" ]; then
            NEW_RAW=$(jq -r '.version // empty' "$VERSION_FILE" 2>/dev/null || echo "")
        fi

        semver_norm() {
            echo "$1" | grep -oE '^[0-9]+\.[0-9]+\.[0-9]+' | head -1
        }
        OLD_SEM=$(semver_norm "$OLD_RAW")
        NEW_SEM=$(semver_norm "$NEW_RAW")

        if [ -z "$OLD_SEM" ] || [ -z "$NEW_SEM" ]; then
            VERSION_BUMP_ERROR="unparseable"
            VERSION_BUMP_DETAIL="old=${OLD_RAW:-<empty>} new=${NEW_RAW:-<empty>}"
            BLOCK_ERRORS="${BLOCK_ERRORS}version-bump,"
        else
            OIFS=$IFS; IFS=. read -r OMAJ OMIN OPATCH <<<"$OLD_SEM"; IFS=. read -r NMAJ NMIN NPATCH <<<"$NEW_SEM"; IFS=$OIFS
            BUMP_KIND=""
            if [ "$NEW_SEM" = "$OLD_SEM" ]; then
                BUMP_KIND="none"
            elif [ "$NMAJ" -lt "$OMAJ" ] \
                 || { [ "$NMAJ" -eq "$OMAJ" ] && [ "$NMIN" -lt "$OMIN" ]; } \
                 || { [ "$NMAJ" -eq "$OMAJ" ] && [ "$NMIN" -eq "$OMIN" ] && [ "$NPATCH" -lt "$OPATCH" ]; }; then
                BUMP_KIND="downgrade"
            elif [ "$NMAJ" -eq $((OMAJ + 1)) ] && [ "$NMIN" -eq 0 ] && [ "$NPATCH" -eq 0 ]; then
                BUMP_KIND="major"
            elif [ "$NMAJ" -eq "$OMAJ" ] && [ "$NMIN" -eq $((OMIN + 1)) ] && [ "$NPATCH" -eq 0 ]; then
                BUMP_KIND="minor"
            elif [ "$NMAJ" -eq "$OMAJ" ] && [ "$NMIN" -eq "$OMIN" ] && [ "$NPATCH" -gt "$OPATCH" ]; then
                BUMP_KIND="patch"
            else
                BUMP_KIND="irregular"
            fi

            case "$BUMP_KIND" in
                none)
                    if [ "$SKIP_BUMP" = false ]; then
                        VERSION_BUMP_ERROR="none"
                        VERSION_BUMP_DETAIL="$OLD_SEM (unchanged)"
                        BLOCK_ERRORS="${BLOCK_ERRORS}version-bump,"
                    fi
                    ;;
                downgrade)
                    VERSION_BUMP_ERROR="downgrade"
                    VERSION_BUMP_DETAIL="$OLD_SEM -> $NEW_SEM"
                    BLOCK_ERRORS="${BLOCK_ERRORS}version-bump,"
                    ;;
                major)
                    if [ "$MAJOR_BUMP_ALLOWED" = false ]; then
                        VERSION_BUMP_ERROR="major"
                        VERSION_BUMP_DETAIL="$OLD_SEM -> $NEW_SEM"
                        BLOCK_ERRORS="${BLOCK_ERRORS}version-bump,"
                    fi
                    ;;
                irregular)
                    VERSION_BUMP_ERROR="irregular"
                    VERSION_BUMP_DETAIL="$OLD_SEM -> $NEW_SEM"
                    BLOCK_ERRORS="${BLOCK_ERRORS}version-bump,"
                    ;;
                minor|patch)
                    : # allowed
                    ;;
            esac
        fi
    fi
fi

# If any blocking errors, display all at once
if [ -n "$BLOCK_ERRORS" ]; then
    echo ""
    echo -e "${RED}${BOLD}=============================================${NC}"
    echo -e "${RED}${BOLD}  COMMIT BLOCKED: Missing required updates   ${NC}"
    echo -e "${RED}${BOLD}=============================================${NC}"
    echo ""

    # Show CLAUDE.md error
    if [ "$CLAUDE_MISSING" = true ]; then
        echo -e "${RED}✗${NC} ${BOLD}CLAUDE.md${NC} not staged"
        echo -e "  ${YELLOW}Every commit must include updates to CLAUDE.md${NC}"
        echo -e "  Fix: ${GREEN}git add CLAUDE.md${NC}"
        echo -e "  To skip: add ${YELLOW}[skip-docs]${NC} to your commit message"
        echo ""
    fi

    # Show CHANGELOG.md error
    if [ "$CHANGELOG_MISSING" = true ]; then
        echo -e "${RED}✗${NC} ${BOLD}CHANGELOG.md${NC} not staged"
        echo -e "  ${YELLOW}Every commit must include updates to CHANGELOG.md${NC}"
        echo -e "  Fix: ${GREEN}git add CHANGELOG.md${NC}"
        echo -e "  To skip: add ${YELLOW}[skip-docs]${NC} to your commit message"
        echo ""
    fi

    # Show SUMMARY.md error
    if [ "$SUMMARY_MISSING" = true ]; then
        echo -e "${RED}✗${NC} ${BOLD}SUMMARY.md${NC} not staged (docs/published-docs/ changed)"
        echo -e "  ${YELLOW}GitBook table of contents must reflect docs/published-docs/ structure${NC}"
        echo "  Published-docs files changed:"
        echo "$PUBLISHED_DOCS_CHANGES" | sed 's/^/    - /'
        echo -e "  Fix: ${GREEN}git add SUMMARY.md${NC}"
        echo -e "  To skip: add ${YELLOW}[skip-docs]${NC} to your commit message"
        echo ""
    fi

    # Show tests error
    if [ "$TESTS_MISSING" = true ]; then
        # Hint at the actual on-disk test directory so the fix message is concrete.
        TEST_HINT="test/"
        if [ -d tests ]; then TEST_HINT="tests/"; fi
        echo -e "${RED}✗${NC} ${BOLD}${TEST_HINT}${NC} not staged (source files changed)"
        echo -e "  ${YELLOW}Source files changed but no test files staged${NC}"
        echo "  Source files changed:"
        echo "$SRC_CHANGES" | sed 's/^/    - /'
        SRC_TOTAL=$(echo "$STAGED_FILES" | grep -E "$SOURCE_PATTERN" | wc -l)
        if [ "$SRC_TOTAL" -gt 5 ]; then
            echo "    ... and $(( SRC_TOTAL - 5 )) more"
        fi
        echo -e "  Fix: ${GREEN}git add ${TEST_HINT}${NC} (test pattern: ${TEST_PATTERN})"
        echo -e "  To skip: add ${YELLOW}[skip-tests]${NC} to your commit message"
        echo ""
    fi

    # Show migration-collision error
    if [ -n "$MIGRATION_COLLISION_DETAIL" ]; then
        echo -e "${RED}✗${NC} ${BOLD}sql/migrations/${NC} has duplicate numbering"
        echo -e "  ${YELLOW}Two or more migration files share the same 3-digit prefix.${NC}"
        echo -e "  ${YELLOW}The runner keys schema_migrations by prefix, so only the${NC}"
        echo -e "  ${YELLOW}first applied registers — re-runs silently skip BOTH files.${NC}"
        echo ""
        echo "  Colliding prefix(es):"
        for prefix in $MIGRATION_COLLISION_DETAIL; do
            echo -e "    ${BOLD}${prefix}${NC}:"
            ls sql/migrations/ | grep -E "^${prefix}_" | sed 's/^/      - /'
        done
        echo ""
        echo -e "  Fix: rename the later file to the next unused number and"
        echo -e "  make its DDL idempotent (CREATE ... IF NOT EXISTS, DO blocks"
        echo -e "  with pg_policies existence checks for CREATE POLICY, etc.)"
        echo -e "  so DBs that already ran the old prefix don't fail on re-run."
        echo -e "  ${YELLOW}There is no skip tag for this check.${NC}"
        echo ""
    fi

    # Show version-bump error
    if [ -n "$VERSION_BUMP_ERROR" ]; then
        echo -e "${RED}✗${NC} ${BOLD}$VERSION_FILE${NC} version-bump check failed: $VERSION_BUMP_ERROR ($VERSION_BUMP_DETAIL)"
        case "$VERSION_BUMP_ERROR" in
            none)
                echo -e "  ${YELLOW}Every commit must bump the version in $VERSION_FILE.${NC}"
                echo -e "  Fix: edit the ${GREEN}.version${NC} field (patch or minor bump) and ${GREEN}git add $VERSION_FILE${NC}"
                echo -e "  To skip: add ${YELLOW}[skip-bump]${NC} to your commit message"
                ;;
            downgrade)
                echo -e "  ${YELLOW}Version decreased. Downgrades are never allowed.${NC}"
                echo -e "  Fix: restore or advance the ${GREEN}.version${NC} field in $VERSION_FILE"
                ;;
            major)
                echo -e "  ${YELLOW}Major version bumps require explicit user opt-in.${NC}"
                echo -e "  To confirm: add ${YELLOW}[major-bump]${NC} to your commit message"
                echo -e "  To revert: lower the ${GREEN}.version${NC} field back to a patch/minor bump"
                ;;
            irregular)
                echo -e "  ${YELLOW}Version jump skips semver reset rules (e.g. minor changed without patch reset).${NC}"
                echo -e "  Expected: patch bump keeps MAJOR.MINOR, minor bump resets patch to 0, major bump resets both."
                ;;
            unparseable)
                echo -e "  ${YELLOW}Could not parse MAJOR.MINOR.PATCH from ${VERSION_FILE}'s .version field.${NC}"
                echo -e "  Ensure the file is valid JSON with a semver string at .version"
                ;;
        esac
        echo ""
    fi

    # Show infra error
    if [ "$INFRA_BLOCK" = true ]; then
        echo -e "${RED}✗${NC} ${BOLD}infra/*.tf${NC} not staged (Dockerfiles/cloudbuild changed)"
        echo -e "  ${YELLOW}Dockerfile/cloudbuild changes require Terraform updates${NC}"
        echo "  Infrastructure files changed:"
        [ -n "$NEW_DOCKERFILES" ] && echo "$NEW_DOCKERFILES" | sed 's/^/    - /'
        [ -n "$NEW_CLOUDBUILDS" ] && echo "$NEW_CLOUDBUILDS" | sed 's/^/    - /'
        echo -e "  ${YELLOW}These define Cloud Run services, secrets, and IAM bindings.${NC}"
        echo -e "  ${YELLOW}Terraform must be updated to match or builds/deploys will fail.${NC}"
        echo -e "  Fix: ${GREEN}git add infra/${NC}"
        echo -e "  To skip: add ${YELLOW}[skip-infra]${NC} to your commit message"
        echo ""
    fi

    echo "Staged files:"
    echo "$STAGED_FILES" | sed 's/^/  - /'
    echo ""
    echo -e "To bypass all checks: ${YELLOW}git commit --no-verify${NC}"
    echo ""
    exit 1
fi

# Data file changes are warning only (non-blocking)
if [ -n "$DATA_CHANGES" ] && [ -z "$TEST_CHANGES" ]; then
    echo ""
    echo -e "${YELLOW}${BOLD}===========================================${NC}"
    echo -e "${YELLOW}${BOLD}  REMINDER: Consider updating tests        ${NC}"
    echo -e "${YELLOW}${BOLD}===========================================${NC}"
    echo ""
    echo "  Data files changed:"
    echo "$DATA_CHANGES" | sed 's/^/    - /'
    if [ $(echo "$STAGED_FILES" | grep "^data/" | wc -l) -gt 5 ]; then
        echo "    ... and more"
    fi
    echo ""
    TEST_HINT="test/"
    if [ -d tests ]; then TEST_HINT="tests/"; fi
    echo -e "  Consider adding/updating tests in ${BOLD}${TEST_HINT}**/*${NC}"
    echo ""
fi

# Repository changes without migrations are warning only (non-blocking)
REPO_CHANGES=$(echo "$STAGED_FILES" | grep -E "^src/repositories/.*\.js$" || true)
MIGRATION_STAGED=$(echo "$STAGED_FILES" | grep -E "^sql/migrations/.*\.sql$" || true)
if [ -n "$REPO_CHANGES" ] && [ -z "$MIGRATION_STAGED" ]; then
    echo ""
    echo -e "${YELLOW}${BOLD}===========================================${NC}"
    echo -e "${YELLOW}${BOLD}  REMINDER: Check if migration is needed   ${NC}"
    echo -e "${YELLOW}${BOLD}===========================================${NC}"
    echo ""
    echo -e "  ${YELLOW}⚠${NC} Repository files changed but no sql/migrations/*.sql staged."
    echo "  Changed repositories:"
    echo "$REPO_CHANGES" | head -5 | sed 's/^/    - /'
    if [ $(echo "$REPO_CHANGES" | wc -l) -gt 5 ]; then
        echo "    ... and $(( $(echo "$REPO_CHANGES" | wc -l) - 5 )) more"
    fi
    echo ""
    echo -e "  If queries reference new columns/tables, include the migration."
    echo ""
fi

# Gateway/pubsub changes are warning only (non-blocking, softer correlation)
if [ "$INFRA_WARNING" = true ]; then
    echo ""
    echo -e "${YELLOW}${BOLD}===========================================${NC}"
    echo -e "${YELLOW}${BOLD}  REMINDER: Verify Terraform is updated    ${NC}"
    echo -e "${YELLOW}${BOLD}===========================================${NC}"
    echo ""
    echo -e "  ${YELLOW}⚠${NC} Infrastructure-affecting changes detected but no infra/*.tf files staged."
    echo "  Detected changes:"
    [ -n "$GATEWAY_CHANGES" ] && echo "$GATEWAY_CHANGES" | sed 's/^/    - /'
    [ -n "$PUBSUB_CHANGES" ] && echo "$PUBSUB_CHANGES" | sed 's/^/    - /'
    echo ""
    echo -e "  Gateway/pubsub changes may need networking or topic resources in Terraform."
    echo -e "  To suppress: add ${YELLOW}[skip-infra]${NC} to your commit message"
    echo ""
fi

# Provider integration parity warning (non-blocking)
PROVIDER_CHANGES=$(echo "$STAGED_FILES" | grep -E "^src/integrations/providers/.*\.js$" || true)
if [ -n "$PROVIDER_CHANGES" ] && [ "$SKIP_INFRA" = false ]; then
    echo -e "${YELLOW}${BOLD}Provider integration reminder:${NC}"
    echo "  Provider descriptor(s) changed:"
    echo "$PROVIDER_CHANGES" | sed 's/^/    - /'
    echo ""
    echo -e "  Verify: ${YELLOW}org adapter registered${NC}, ${YELLOW}tool scopes mapped${NC}, ${YELLOW}parity test passes${NC}"
    echo -e "  Run: ${GREEN}node --test test/architecture/provider-integration-parity.test.js${NC}"
    echo ""
fi

# Log skipped checks
SKIPPED=""
if [ "$SKIP_DOCS" = true ]; then
    SKIPPED="${SKIPPED}docs "
fi
if [ "$SKIP_TESTS" = true ]; then
    SKIPPED="${SKIPPED}tests "
fi
if [ "$SKIP_INFRA" = true ]; then
    SKIPPED="${SKIPPED}infra "
fi
if [ "$SKIP_BUMP" = true ] && [ -n "$VERSION_FILE" ]; then
    SKIPPED="${SKIPPED}bump "
fi

if [ -n "$SKIPPED" ]; then
    echo -e "${GREEN}Commit-msg check passed (skipped: ${SKIPPED})${NC}"
else
    echo -e "${GREEN}Commit-msg check passed: CLAUDE.md, CHANGELOG.md, and tests staged${NC}"
fi
exit 0
