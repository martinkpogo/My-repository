import type { Env } from "../types";

export interface ActionCapability {
  id: string;
  name: string;
  description: string;
  handleIntake(env: Env, chatId: number, text: string, threadId?: number): Promise<boolean>;
}

const REGISTERED_CAPABILITIES: ActionCapability[] = [];

export function registerActionCapability(capability: ActionCapability): void {
  if (!REGISTERED_CAPABILITIES.some((c) => c.id === capability.id)) {
    REGISTERED_CAPABILITIES.push(capability);
  }
}

export function getRegisteredCapabilities(): ActionCapability[] {
  return [...REGISTERED_CAPABILITIES];
}

export function clearRegisteredCapabilities(): void {
  REGISTERED_CAPABILITIES.length = 0;
}

/**
 * Generic Workspace Capability router seam — provider-agnostic.
 * Iterates through registered ActionCapabilities and delegates natural-language intake.
 * Returns true if an ActionCapability recognized and handled the request.
 */
export async function routeWorkspaceCapabilityAction(
  env: Env,
  chatId: number,
  text: string,
  threadId?: number,
): Promise<boolean> {
  for (const capability of REGISTERED_CAPABILITIES) {
    try {
      const handled = await capability.handleIntake(env, chatId, text, threadId);
      if (handled) return true;
    } catch (err) {
      console.error(`ActionCapability ${capability.id} handleIntake failed`, err);
    }
  }
  return false;
}
