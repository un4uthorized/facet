export interface AuthUser {
  name: string;
  id: string;
  email: string;
  role: 'admin' | 'user';
}

export interface MfaChallenge { mfaRequired: true; challengeToken: string; expiresAt: string }
export interface MfaEnrollment extends MfaSetup { mfaEnrollmentRequired: true; enrollmentToken: string }
export type AuthLoginResult = { user: AuthUser } | MfaChallenge | MfaEnrollment;
export interface MfaStatus { enabled: boolean; configured: boolean }
export interface MfaSetup { secret: string; uri: string; qrCode: string; expiresAt: string }
export interface MfaRecoveryCodes { recoveryCodes: string[] }

export interface ManagedUser {
  status: 'active' | 'inactive' | 'pending' | 'expired' | 'mfa_pending';
  invitationExpiresAt?: string;
  name: string;
  role: 'admin' | 'user';
  id: string;
  email: string;
  active: boolean;
  createdAt: string | null;
  updatedAt: string | null;
  lastLoginAt: string | null;
}

export interface CreateUserInput {
  name: string;
  email: string;
}

export interface UpdateUserInput {
  name?: string;
  email?: string;
  active?: boolean;
}

export interface DocumentationSettings {
  title: string;
  logoUrl: string;
}

export interface Invitation {
  name: string;
  id: string;
  email: string;
  createdAt: string;
  expiresAt: string;
}

export interface ContentPage {
  id: string;
  title: string;
  slug: string;
  group: string;
  markdown: string;
  published: boolean;
}
export interface ImportedOpenApi {
  spec: import('./documentation/types').OpenAPISpec;
  sourceName: string;
  updatedAt: string;
}
export interface CustomizationContent { pages: ContentPage[]; revision: number; openapi: ImportedOpenApi | null }
