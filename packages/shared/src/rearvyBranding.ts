/**
 * Product identity shared by the Rearvy coding-agent surfaces.
 *
 * The package remains named @t3tools/shared because that is part of the
 * embedded T3 runtime's module contract. User-facing identity belongs here so
 * the web app, desktop shell, and server do not drift apart.
 */
export const REARVY_CODING_AGENT_BASE_NAME = "Rearvy Coding Agent" as const;
export const REARVY_CODING_AGENT_SHORT_NAME = "Rearvy Code" as const;
export const REARVY_CODING_AGENT_DESCRIPTION = "Agent-powered coding workspace for Rearvy" as const;
