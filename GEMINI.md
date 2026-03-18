# GEMINI.md

This file provides foundational mandates for Gemini CLI when working in this repository.

## Precedence
The instructions in this file take absolute precedence over general workflows and tool defaults.

## Project Standards
- **Reference Document**: Always refer to `CLAUDE.md` for the latest build commands, architecture overview, and development conventions.
- **i18n Standard**: Follow the i18n development guidelines defined in `CLAUDE.md`.
- **Agent Roles**: Refer to `AGENTS.md` for specific guidance on how AI agents (including Gemini) should operate within the IM.codes ecosystem.

## Core Rules
- **Environment**: Be aware that this project involves multiple sub-projects: `server`, `web`, `worker`, and the root `daemon` (in `src/`).
- **Testing**: Follow the specific test commands in `CLAUDE.md` (e.g., `npm run test:web` for frontend changes).
- **Security**: Never commit secrets. Note the redaction logic in `worker/src/util/logger.ts`.
