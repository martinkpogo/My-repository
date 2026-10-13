import { SALES_OPERATION } from "../units/sales/salesOperationNames";

/**
 * Test double for the part of a WorkSession stub that Sales callers use: the
 * ONE generic `runUnitOperation(unit, name, input)`. Takes handlers keyed by the
 * SALES_OPERATION key (`handleProposalDocComment`, ...), so a test reads the
 * same as before the operations moved off WorkSession. A call for any other
 * Unit or an undeclared operation throws, like the real entry.
 */
type Handler = (input: any) => Promise<unknown>;

export function salesOperationStub(handlers: Partial<Record<keyof typeof SALES_OPERATION, Handler>>) {
  const byName = new Map<string, Handler>();
  for (const [key, handler] of Object.entries(handlers) as [keyof typeof SALES_OPERATION, Handler][]) {
    byName.set(SALES_OPERATION[key], handler);
  }
  return {
    runUnitOperation: async (unit: string, name: string, input: unknown) => {
      if (unit !== "Sales") throw new Error(`unexpected Unit ${unit}`);
      const handler = byName.get(name);
      if (!handler) throw new Error(`no test handler for Sales operation ${name}`);
      return handler(input);
    },
  };
}
