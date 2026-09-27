#!/bin/sh
# Build the app and publish public/ to the gh-pages branch of this repo's
# origin remote. GitHub Pages must be set to deploy from the gh-pages branch
# (repo Settings > Pages > Source: "Deploy from a branch", gh-pages, / (root)).
set -eu

cd "$(dirname "$0")"
remote=$(git remote get-url origin)
rev=$(git rev-parse --short HEAD)

npm ci
npm run build

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
cp -R public/. "$tmp"
touch "$tmp/.nojekyll" # serve files as-is, no Jekyll processing

cd "$tmp"
git init -q -b gh-pages
git add -A
git commit -q -m "Deploy $rev"
git push -f "$remote" gh-pages

echo "Deployed $rev to gh-pages"
