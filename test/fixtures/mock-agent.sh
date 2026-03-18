#!/bin/bash
# Mock agent that simulates agent TUI behavior.
# Usage: ./mock-agent.sh [agent-type]
# Reads lines from stdin, outputs formatted responses.

AGENT_TYPE="${1:-claude-code}"

case "$AGENT_TYPE" in
  claude-code)
    PROMPT="❯"
    SPINNER=("⠋" "⠙" "⠹" "⠸" "⠼" "⠴" "⠦" "⠧" "⠇" "⠏")
    ;;
  codex)
    PROMPT=">"
    SPINNER=("-" "\\" "|" "/")
    ;;
  opencode)
    PROMPT="λ"
    SPINNER=("." ".." "...")
    ;;
  *)
    PROMPT=">"
    SPINNER=("-" "\\" "|" "/")
    ;;
esac

# Initial idle state
echo ""
echo "  Mock Agent ($AGENT_TYPE)"
echo ""
echo "$PROMPT "

# Read input and respond
while IFS= read -r line; do
  if [[ -z "$line" ]]; then
    continue
  fi

  # Simulate thinking
  for i in 0 1 2; do
    spinner_idx=$((RANDOM % ${#SPINNER[@]}))
    echo -ne "${SPINNER[$spinner_idx]} Thinking...\r"
    sleep 0.3
  done
  echo ""

  # Simulate response
  echo "I received: $line"
  echo ""
  echo "Here is my response to your request. This is a mock response from the $AGENT_TYPE agent."
  echo ""

  # Return to idle
  echo "$PROMPT "
done
