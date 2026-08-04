// Implements session/request_permission (ACP).
//
// Grok uses this for tool approval AND for plan-mode exit approval
// (pending_interaction kind: "plan_approval"). The agent sends a concrete
// `options` list; the client MUST reply with one of those optionIds.
// Always returning the literal "allow_always" fails when plan approval
// (or a given tool) only offers other ids — the agent then reports
// "client disconnected mid-approval" and leaves plan mode stuck.

export interface PermissionOutcome {
  outcome: {
    outcome: 'selected' | 'cancelled' | string;
    optionId?: string;
  };
}

export interface PermissionOption {
  optionId?: string;
  name?: string;
  kind?: string;
}

export interface PermissionHost {
  requestPermission(params?: unknown): Promise<PermissionOutcome>;
}

/** Prefer allow_always → allow_once → first option; fall back to allow_always. */
export function pickPermissionOptionId(params?: unknown): string {
  const options = extractOptions(params);
  if (!options.length) return 'allow_always';

  const byKind = (kind: string) =>
    options.find((o) => o.kind === kind && typeof o.optionId === 'string' && o.optionId);

  const always = byKind('allow_always');
  if (always?.optionId) return always.optionId;

  const once = byKind('allow_once');
  if (once?.optionId) return once.optionId;

  // Some agents use kind names as optionIds, or only set optionId.
  const byId = (id: string) =>
    options.find((o) => o.optionId === id);
  if (byId('allow_always')?.optionId) return 'allow_always';
  if (byId('allow_once')?.optionId) return 'allow_once';

  // Prefer any non-reject option by name/kind heuristics.
  const allowish = options.find((o) => {
    const id = (o.optionId || '').toLowerCase();
    const kind = (o.kind || '').toLowerCase();
    const name = (o.name || '').toLowerCase();
    if (kind.startsWith('reject') || id.startsWith('reject')) return false;
    if (name.includes('reject') || name.includes('deny') || name.includes('cancel')) return false;
    return typeof o.optionId === 'string' && o.optionId.length > 0;
  });
  if (allowish?.optionId) return allowish.optionId;

  const first = options.find((o) => typeof o.optionId === 'string' && o.optionId);
  return first?.optionId || 'allow_always';
}

function extractOptions(params: unknown): PermissionOption[] {
  if (!params || typeof params !== 'object') return [];
  const p = params as { options?: unknown };
  if (!Array.isArray(p.options)) return [];
  return p.options.filter(
    (o): o is PermissionOption => !!o && typeof o === 'object',
  ) as PermissionOption[];
}

export function createPermissionHost(): PermissionHost {
  return {
    async requestPermission(params?: unknown): Promise<PermissionOutcome> {
      const optionId = pickPermissionOptionId(params);
      return { outcome: { outcome: 'selected', optionId } };
    },
  };
}
