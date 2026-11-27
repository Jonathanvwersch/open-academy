export interface AuthPayload {
  authenticated: boolean;
  authRequired: boolean;
  demo: { ttlHours: number } | null;
}
