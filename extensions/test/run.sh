#!/bin/sh
# bun test resolves packages from node_modules, while Pi loads extensions
# against its managed release. Re-create that arrangement without changing it.
set -eu
agent=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
IFS= read -r version < "$agent/install/current-version"
sandbox=$(mktemp -d)
trap 'rm -rf "$sandbox"' EXIT
ln -s "$agent/install/releases/$version/node_modules" "$sandbox/node_modules"
cp -R "$agent/extensions" "$sandbox/extensions"
cd "$sandbox"
bun test extensions/test
