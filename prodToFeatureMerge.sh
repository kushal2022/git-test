#!/bin/bash
# This script merges source branches into target branches based on config

if [ $# -ne 3 ]
then
	echo "Please provide Sprint number, BITBUCKET_USER and BITBUCKET_API_KEY as input"
	echo "usage: $0 <SPRINT_NUM> <BITBUCKET_USER> <BITBUCKET_API_KEY> "
	echo "Example: $0 50 xyz@deloitte.com NTg0NDcabcdODEwOsh7H4aI55o9xMSnFfhEeqC"
	exit 1
fi

SPRINT_NUM=$1
BITBUCKET_USER=$2
BITBUCKET_API_KEY=$3

DATE=$(date +%Y%m%d)
CONFIG_FILE="feature_branches.conf"
REPOS=("aspen" "database")
LOG_FILE="merge_crossmerge_$(date '+%d-%m-%Y-%H-%M-%S').log"
PROJECT_KEY='ASPEN'

BB_BASE_URL='https://hhsbb.hsd.state.nm.us'

# Skip Git LFS smudge
export GIT_LFS_SKIP_SMUDGE=1
git lfs install --local 2>/dev/null || true

# ============================================================
# Parse config: source_branch:target_branch:reviewers_list
# Stores entries as "source>target" in MERGE_ENTRIES
# Stores reviewers keyed by target branch in REVIEWERS
# ============================================================
declare -A MERGE_ENTRIES
declare -A REVIEWERS
current_repo=""

while IFS= read -r line; do
    echo "Processing Line: $line"

    # Trim whitespace
    line=$(echo "$line" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')

    # Skip comments and empty lines
    [[ "$line" =~ ^#.*$ || -z "$line" ]] && continue

    # Match repo header [reponame]
    if [[ "$line" =~ ^\[(.*)\]$ ]]; then
        echo "Config for new repo found: $line"
        current_repo="${BASH_REMATCH[1]}"
        echo "Current repo set to: $current_repo"
        MERGE_ENTRIES[$current_repo]=""
        REVIEWERS[$current_repo]=""
    else
        # Match source:target:reviewers (three colon-separated fields)
        if [[ "$line" =~ ^([^:]+)[[:space:]]*:[[:space:]]*([^:]+)[[:space:]]*:[[:space:]]*(.+)$ ]]; then
            source_branch="${BASH_REMATCH[1]}"
            source_branch=$(echo "$source_branch" | xargs)
            target_branch="${BASH_REMATCH[2]}"
            target_branch=$(echo "$target_branch" | xargs)
            reviewer_list="${BASH_REMATCH[3]}"
            reviewer_list=$(echo "$reviewer_list" | xargs)

            echo "  Source: '$source_branch'"
            echo "  Target: '$target_branch'"
            echo "  Reviewers: '$reviewer_list'"

            MERGE_ENTRIES[$current_repo]+="$source_branch>$target_branch "
            REVIEWERS[$current_repo]+="$target_branch:$reviewer_list|"
        fi
    fi

done < "$CONFIG_FILE"

# ============================================================
# Function: get_reviewers <repo> <target_branch>
# Returns comma-separated reviewer emails for a target branch
# ============================================================
get_reviewers() {
    local repo=$1
    local target=$2
    local reviewer_data="${REVIEWERS[$repo]}"

    while IFS='|' read -ra ENTRIES; do
        for entry in "${ENTRIES[@]}"; do
            if [[ "$entry" =~ ^([^:]+):(.+)$ ]]; then
                entry_target="${BASH_REMATCH[1]}"
                entry_target=$(echo "$entry_target" | xargs)
                entry_reviewers="${BASH_REMATCH[2]}"

                if [[ "$entry_target" == "$target" ]]; then
                    echo "$entry_reviewers"
                    return
                fi
            fi
        done
    done <<< "$reviewer_data"
}

# ============================================================
# Function: build_reviewers_json <comma_separated_emails>
# Returns JSON array for Bitbucket PR API
# ============================================================
build_reviewers_json() {
    local reviewers=$1
    local json_array="["
    local first=true

    IFS=',' read -ra EMAILS <<< "$reviewers"
    for email in "${EMAILS[@]}"; do
        email=$(echo "$email" | xargs)
        if [[ "$first" == true ]]; then
            first=false
        else
            json_array+=","
        fi
        json_array+="{\"user\":{\"name\":\"$email\"}}"
    done
    json_array+="]"
    echo "$json_array"
}

# ============================================================
# Main merge loop
# ============================================================
echo "=== Merge Script Started at $(date) ===" >> "$LOG_FILE"

for repo in "${REPOS[@]}"; do
    echo "Processing repo: $repo" | tee -a "$LOG_FILE"
    cd "$repo" || { echo "Repo $repo not found!" | tee -a "../$LOG_FILE"; exit 1; }
    git fetch

    for entry in ${MERGE_ENTRIES[$repo]}; do
        # Unpack source and target from "source>target"
        src="${entry%%>*}"
        target="${entry##*>}"

        echo "" | tee -a "../$LOG_FILE"
        echo " Processing: merge '$src' -> '$target'" | tee -a "../$LOG_FILE"

        # Checkout and pull target branch
        echo " Checking out: $target" | tee -a "../$LOG_FILE"
        git checkout "$target" 2>&1 | tee -a "../$LOG_FILE"
        echo " Checking out: $target completed" | tee -a "../$LOG_FILE"
        git pull
        echo " Pulling branch: $target completed" | tee -a "../$LOG_FILE"

        # Create merge branch
        MERGE_BRANCH="Sprint${SPRINT_NUM}-${src}-Crossmerge-to-${target}-${DATE}"
        echo " Creating merge branch: $MERGE_BRANCH" | tee -a "../$LOG_FILE"
        git branch -D "$MERGE_BRANCH" 2>/dev/null
        git checkout -b "$MERGE_BRANCH" 2>&1 | tee -a "../$LOG_FILE"

        # Attempt merge
        echo " Attempting to merge $src into $MERGE_BRANCH" | tee -a "../$LOG_FILE"
        git merge --no-ff "origin/$src" 2>&1 | tee -a "../$LOG_FILE"
        merge_rc=${PIPESTATUS[0]}

        if [[ $merge_rc == 0 ]]; then
            git commit -m "Merged $src into $target" 2>&1 | tee -a "../$LOG_FILE"
            echo " Merge from $src into $MERGE_BRANCH successful, merging back into $target" | tee -a "../$LOG_FILE"
            echo " Checking out $target" | tee -a "../$LOG_FILE"
            git checkout "$target" 2>&1 | tee -a "../$LOG_FILE"
            git merge --no-ff "$MERGE_BRANCH" 2>&1 | tee -a "../$LOG_FILE"
            git push origin "$target" 2>&1 | tee -a "../$LOG_FILE"
            echo " $target updated and pushed with $src changes." | tee -a "../$LOG_FILE"
            git branch -D "$MERGE_BRANCH" 2>&1 | tee -a "../$LOG_FILE"
        else
            echo " Merge conflict detected in $MERGE_BRANCH." | tee -a "../$LOG_FILE"
            echo " Reverting previous merge" | tee -a "../$LOG_FILE"
            git merge --abort 2>&1 | tee -a "../$LOG_FILE"
            echo " Pushing branch to remote for PR" | tee -a "../$LOG_FILE"
            git push -u origin "$MERGE_BRANCH" 2>&1 | tee -a "../$LOG_FILE"

            # Get reviewers and create PR
            reviewer_emails=$(get_reviewers "$repo" "$target")
            reviewers_json=$(build_reviewers_json "$reviewer_emails")

            echo " Adding reviewers: $reviewer_emails" | tee -a "../$LOG_FILE"

            curl -sS --fail-with-body \
                -H "Authorization: Bearer $BITBUCKET_API_KEY" \
                -H "Content-Type: application/json" \
                -X POST \
                --data-binary @- \
                "$BB_BASE_URL/rest/api/latest/projects/ASPEN/repos/${repo}/pull-requests" <<EOF
                {
                "title": "Merge $src into $MERGE_BRANCH (conflict resolution needed)",
                "description": "Please resolve conflicts between $src and $MERGE_BRANCH for $target in ${repo}.",
                "state": "OPEN",
                "open": true,
                "closed": false,
                "fromRef": {
                    "id": "refs/heads/$src",
                    "repository": {
                    "slug": "${repo}",
                    "project": { "key": "$PROJECT_KEY" }
                    }
                },
                "toRef": {
                    "id": "refs/heads/$MERGE_BRANCH",
                    "repository": {
                    "slug": "${repo}",
                    "project": { "key": "$PROJECT_KEY" }
                    }
                }
                ,"reviewers": $reviewers_json
            }
EOF
                if [[ $? == 0 ]]; then
                    echo " PR created from $src to $MERGE_BRANCH for manual conflict resolution." | tee -a "../$LOG_FILE"
                else
                    echo " PR Creation Failed" | tee -a "../$LOG_FILE"
                fi
        fi
    done

    cd ..
done

echo "=== Merge Script Finished at $(date) ===" >> "$LOG_FILE"