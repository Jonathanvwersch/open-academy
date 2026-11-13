import { apiFetch } from './authenticated-fetch.js';
export async function getJson<T>(url: string, message: string): Promise<T> {
  const response = await apiFetch(url);
  if (!response.ok) throw new Error(message);
  return (await response.json()) as T;
}
