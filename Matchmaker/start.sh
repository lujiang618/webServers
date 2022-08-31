#!/bin/sh

SCRIPT_NAME=$(echo \"$0\" | xargs readlink -f)
PROJECT_ROOT=$(dirname $(dirname "$SCRIPT_NAME"))

cd "$PROJECT_ROOT/SignallingWebServer/platform_scripts/bash/"

./Start_SignallingServer.sh "$@"