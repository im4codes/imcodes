#!/bin/bash
# Mock brain agent that reads input and outputs @commands for the brain-dispatcher.
# Usage: ./mock-brain.sh
# Reads lines from stdin, outputs @commands.

echo ""
echo "  Mock Brain Agent"
echo ""
echo "  Workers: w1 (claude-code), w2 (codex)"
echo ""
echo "❯ "

# Read input and dispatch @commands
while IFS= read -r line; do
  if [[ -z "$line" ]]; then
    continue
  fi

  sleep 0.5

  # Route to a worker
  if [[ "$line" == *"audit"* ]]; then
    echo "@w2 Please review the code changes in src/ for correctness and security issues."
    sleep 1
    echo "@status"
  elif [[ "$line" == *"implement"* || "$line" == *"fix"* || "$line" == *"add"* ]]; then
    echo "@w1 $line"
    sleep 1
    echo "@status"
  elif [[ "$line" == *"screen"* ]]; then
    echo "@screen w1"
  elif [[ "$line" == *"approve"* ]]; then
    echo "@approve w2"
  elif [[ "$line" == *"reject"* ]]; then
    echo "@reject w2 The implementation needs improvement: add error handling."
  elif [[ "$line" == *"merge"* ]]; then
    echo "@merge w1"
  else
    echo "@w1 $line"
  fi

  echo ""
  echo "❯ "
done
