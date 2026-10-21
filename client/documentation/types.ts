/** OpenAPI schemas permit vendor fields and arbitrary examples. This renderer
 * dereferences these dynamic nodes at runtime, while operations keep explicit
 * types for the fields used by navigation, request building and responses. */
export type DynamicSchema = Record<string, any> | undefined | null;

export interface APIParameter {
  name: string;
  in: string;
  required?: boolean;
  description?: string;
  example?: any;
  schema?: DynamicSchema;
  $ref?: string;
}

export interface RequestBody {
  required?: boolean;
  description?: string;
  content?: Record<string, MediaType>;
}

export interface MediaType {
  schema?: DynamicSchema;
  example?: any;
  examples?: Record<string, any>;
}

export type SecurityRequirement = Record<string, string[]>;

export interface OpenAPISpec {
  openapi: string;
  info: { title?: string; version?: string; description?: string };
  paths: Record<string, Record<string, any>>;
  servers?: { url: string; description?: string }[];
  tags?: { name: string; description?: string }[];
  security?: SecurityRequirement[];
  components?: {
    schemas?: Record<string, DynamicSchema>;
    securitySchemes?: Record<string, DynamicSchema>;
  };
  [key: string]: any;
}

export interface Operation {
  id: string;
  method: string;
  path: string;
  tag: string;
  summary: string;
  description: string;
  parameters: APIParameter[];
  requestBody?: RequestBody;
  responses: Record<string, DynamicSchema>;
  security?: SecurityRequirement[];
  raw: Record<string, any>;
}

export interface DocumentationState {
  spec: OpenAPISpec;
  operations: Operation[];
  active: Operation | null;
  importMode: string;
  sourceName: string;
}
