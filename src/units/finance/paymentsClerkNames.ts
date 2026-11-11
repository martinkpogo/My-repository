/**
 * The Payments Clerk's names, kept import-free so financeManifest.ts can use
 * them while the module graph is still loading (paymentsClerk.ts reaches the
 * Unit Registry through access.ts, which loads this manifest).
 */
export const PAYMENTS_CLERK_HAT_NAME = "Payments Clerk";
export const PAYMENT_CALLBACK_PREFIX = "paymentrecord" as const;
