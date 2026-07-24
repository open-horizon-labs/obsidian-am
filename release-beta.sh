#!/bin/bash

set -euo pipefail

if [ "$#" -ne 2 ]; then
    echo "Must provide exactly two arguments."
    echo "First one must be the new version number."
    echo "Second one must be the minimum obsidian version for this release."
    echo ""
    echo "Example usage:"
    echo "./release-beta.sh 0.11.0-beta1 1.12.7"
    echo "Exiting."

    exit 1
fi

if [[ $(git status --porcelain) ]]; then
  echo "Changes in the git repo."
  echo "Exiting."

  exit 1
fi

NEW_VERSION=$1
MINIMUM_OBSIDIAN_VERSION=$2
BRANCH_NAME="beta/${NEW_VERSION}"

echo "Updating to version ${NEW_VERSION} with minimum obsidian version ${MINIMUM_OBSIDIAN_VERSION}"

read -p "Continue? [y/N] " -n 1 -r
echo
if [[ $REPLY =~ ^[Yy]$ ]]
then
  echo "Creating branch ${BRANCH_NAME}"
  git checkout -b "${BRANCH_NAME}"

  echo "Updating package.json"
  TEMP_FILE=$(mktemp)
  jq ".version |= \"${NEW_VERSION}\"" package.json > "$TEMP_FILE" || exit 1
  mv "$TEMP_FILE" package.json

  echo "Updating manifest-beta.json"
  TEMP_FILE=$(mktemp)
  jq ".version |= \"${NEW_VERSION}\" | .minAppVersion |= \"${MINIMUM_OBSIDIAN_VERSION}\"" manifest-beta.json > "$TEMP_FILE" || exit 1
  mv "$TEMP_FILE" manifest-beta.json

  echo "Updating versions.json"
  TEMP_FILE=$(mktemp)
  jq ". += {\"${NEW_VERSION}\": \"${MINIMUM_OBSIDIAN_VERSION}\"}" versions.json > "$TEMP_FILE" || exit 1
  mv "$TEMP_FILE" versions.json

  echo "Updating package-lock.json"
  npm install

  read -p "Create git commit, push, and open a pull request? [y/N] " -n 1 -r
  echo
  if [[ $REPLY =~ ^[Yy]$ ]]
  then
    git add package.json package-lock.json manifest-beta.json versions.json
    git commit -m "Update to version ${NEW_VERSION}"
    git push --set-upstream origin "${BRANCH_NAME}"

    echo "Creating a pull request..."
    gh pr create \
      --title "Update to version ${NEW_VERSION}" \
      --body "Beta version bump to ${NEW_VERSION} (minimum Obsidian version ${MINIMUM_OBSIDIAN_VERSION})." \
      --base master \
      --head "${BRANCH_NAME}"

    echo ""
    echo "Pull request created. Merging it into master will automatically tag,"
    echo "build, and publish the ${NEW_VERSION} beta release (via .github/workflows/release.yml)."
  fi
else
  echo "Exiting."
  exit 1
fi
