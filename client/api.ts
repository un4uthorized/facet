import type { MfaEnrollment, AuthUser, AuthLoginResult, ContentPage, CustomizationContent, ImportedOpenApi, Invitation, DocumentationSettings, CreateUserInput, ManagedUser, MfaRecoveryCodes, MfaSetup, MfaStatus, UpdateUserInput } from './types';

export class ApiError extends Error {
  constructor(public readonly status: number, message: string, public readonly code?: string) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...options,
      credentials: 'same-origin',
      headers: { Accept: 'application/json', ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers },
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new ApiError(0, 'Não foi possível conectar ao servidor. Tente novamente.');
  }

  if (!response.ok) {
    const payload: unknown = await response.json().catch(() => null);
    const message = payload && typeof payload === 'object' && 'error' in payload && typeof payload.error === 'string'
      ? payload.error
      : 'Não foi possível concluir a solicitação. Tente novamente.';
    if (response.status === 401 && path !== '/api/auth/login' && path !== '/api/auth/me' && path !== '/api/auth/mfa/verify') {
      window.dispatchEvent(new CustomEvent('facet:unauthorized'));
    }
    throw new ApiError(response.status, message, payload && typeof payload === 'object' && 'code' in payload && typeof payload.code === 'string' ? payload.code : undefined);
  }

  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export const api = {
  customizationContent: (signal?: AbortSignal) => request<CustomizationContent>('/api/admin/documentation/content', { signal }),
  documentationContent: (signal?: AbortSignal) => request<{ pages: ContentPage[]; openapi: ImportedOpenApi | null }>('/api/documentation/content', { signal }),
  importOpenApi: (source: string, sourceName: string) => request<{ openapi: ImportedOpenApi }>('/api/admin/documentation/openapi', { method: 'PUT', body: JSON.stringify({ source, sourceName }) }),
  savePages: (pages: ContentPage[], revision: number) => request<{ pages: ContentPage[]; revision: number }>('/api/admin/documentation/pages', { method: 'PUT', body: JSON.stringify({ pages, revision }) }),
  listInvitations: (signal?: AbortSignal) => request<{ invitations: Invitation[] }>('/api/admin/invitations', { signal }),
  revokeInvitation: (id: string) => request<void>(`/api/admin/invitations/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  inspectInvitation: (token: string, signal?: AbortSignal) => request<{ invitation: { name: string; email: string; expiresAt: string } }>('/api/invitations/inspect', { method: 'POST', body: JSON.stringify({ token }), signal }),
  acceptInvitation: (token: string, password: string) => request<MfaEnrollment & { user: ManagedUser }>('/api/invitations/accept', { method: 'POST', body: JSON.stringify({ token, password }) }),
  documentationSettings: (signal?: AbortSignal) => request<{ settings: DocumentationSettings }>('/api/documentation/settings', { signal }),
  saveDocumentationSettings: (settings: DocumentationSettings) => request<{ settings: DocumentationSettings }>('/api/admin/documentation/settings', { method: 'PUT', body: JSON.stringify(settings) }),
  me: (signal?: AbortSignal) => request<{ user: AuthUser }>('/api/auth/me', { signal }),
  login: (email: string, password: string, newPassword?: string) => request<AuthLoginResult>('/api/auth/login', { method: 'POST', body: JSON.stringify({ email, password, newPassword }) }),
  mfaEnrollmentConfirm: (enrollmentToken: string, code: string) => request<MfaRecoveryCodes>('/api/auth/mfa/enrollment/confirm', { method: 'POST', body: JSON.stringify({ enrollmentToken, code }) }),
  mfaStatus: (signal?: AbortSignal) => request<MfaStatus>('/api/auth/mfa', { signal }),
  mfaSetup: (password: string) => request<MfaSetup>('/api/auth/mfa/setup', { method: 'POST', body: JSON.stringify({ password }) }),
  mfaEnable: (code: string) => request<MfaRecoveryCodes>('/api/auth/mfa/enable', { method: 'POST', body: JSON.stringify({ code }) }),
  mfaDisable: (password: string, code: string) => request<void>('/api/auth/mfa/disable', { method: 'POST', body: JSON.stringify({ password, code }) }),
  mfaRecoveryCodes: (password: string, code: string) => request<MfaRecoveryCodes>('/api/auth/mfa/recovery-codes', { method: 'POST', body: JSON.stringify({ password, code }) }),
  mfaVerify: (challengeToken: string, code: string) => request<{ user: AuthUser }>('/api/auth/mfa/verify', { method: 'POST', body: JSON.stringify({ challengeToken, code }) }),
  logout: () => request<void>('/api/auth/logout', { method: 'POST' }),
  listUsers: (signal?: AbortSignal) => request<{ users: ManagedUser[] }>('/api/admin/users', { signal }),
  createUser: (input: CreateUserInput) => request<{ invitation: Invitation; path: string }>('/api/admin/users', { method: 'POST', body: JSON.stringify(input) }),
  updateUser: (id: string, input: UpdateUserInput) => request<{ user: ManagedUser }>(`/api/admin/users/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(input) }),
  deleteUser: (id: string) => request<void>(`/api/admin/users/${encodeURIComponent(id)}`, { method: 'DELETE' }),
};

export function errorMessage(error: unknown): string {
  return error instanceof ApiError ? error.message : 'Ocorreu um erro inesperado. Tente novamente.';
}
