import { JSON_SCHEMA, load } from 'js-yaml';

export interface ContentPage {
  id: string;
  title: string;
  slug: string;
  group: string;
  markdown: string;
  published: boolean;
}
export const defaultPages: ContentPage[] = [
  { id: 'introduction', slug: 'introduction', title: 'Introdução', group: 'Comece aqui', published: true, markdown: 'Bem-vindo à documentação da API. Encontre os endpoints e experimente as requisições no API Explorer.\n\n## Sua primeira requisição\n\n1. Escolha um endpoint no menu.\n2. Confira os parâmetros e o formato da resposta.\n3. Abra o API Explorer, configure o servidor e envie a requisição.' },
  { id: 'authentication', slug: 'authentication', title: 'Autenticação', group: 'Comece aqui', published: true, markdown: 'Os requisitos de autenticação são definidos pela especificação OpenAPI e podem variar entre endpoints.\n\n## Bearer token\n\nInforme seu token no API Explorer. Ele será enviado no header `Authorization`.\n\n## API keys\n\nAdicione o header exigido pela sua API na seção Headers. Mantenha suas credenciais privadas.' },
  { id: 'pagination', slug: 'pagination', title: 'Paginação', group: 'Guias', published: true, markdown: 'A paginação depende de cada endpoint. Consulte os parâmetros documentados antes de enviar a requisição.\n\n## Próxima página\n\nUse o cursor ou a página retornada pela API. Verifique os limites e o tamanho de página aceitos pelo endpoint.' },
  { id: 'errors', slug: 'errors', title: 'Erros e respostas', group: 'Guias', published: true, markdown: 'Consulte os códigos e schemas na seção Responses de cada endpoint.\n\n| Código | Significado |\n| --- | --- |\n| 2xx | Requisição concluída |\n| 4xx | Verifique credenciais, parâmetros e permissões |\n| 5xx | Falha no servidor |\n\nO API Explorer mostra o status, os headers e o corpo da resposta.' },
];
const object = (value: unknown): value is Record<string, any> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
export function parseOpenApi(source: unknown): Record<string, any> {
  if (typeof source !== 'string' || !source.trim() || Buffer.byteLength(source) > 2 * 1024 * 1024) throw new Error('Importe um arquivo JSON ou YAML de até 2 MB.');
  let parsed: unknown;
  try { parsed = load(source, { schema: JSON_SCHEMA }); }
  catch { throw new Error('Não foi possível ler o JSON ou YAML. Confira a sintaxe do arquivo.'); }
  // Bound aliases/depth and reject circular YAML before persisting or rendering.
  let nodes = 0;
  const ancestors = new Set<object>();
  function inspect(value: unknown, depth = 0) {
    if (++nodes > 150000 || depth > 60) throw new Error('A especificação excede os limites de complexidade.');
    if (value && typeof value === 'object') {
      if (ancestors.has(value)) throw new Error('Referências circulares em YAML não são aceitas. Use $ref do OpenAPI.');
      ancestors.add(value);
      Object.values(value).forEach(item => inspect(item, depth + 1));
      ancestors.delete(value);
    }
  }
  inspect(parsed);
  if (!object(parsed) || typeof parsed.openapi !== 'string' || !/^3\.(0|1)\.\d+$/.test(parsed.openapi)
    || !object(parsed.info) || typeof parsed.info.title !== 'string' || !parsed.info.title.trim()
    || typeof parsed.info.version !== 'string' || !object(parsed.paths)) {
    throw new Error('Use OpenAPI 3.0 ou 3.1 com info.title, info.version e paths válidos.');
  }
  function checkSecurity(value: unknown) {
    if (value === undefined) return;
    if (!Array.isArray(value) || value.some(item => !object(item) || Object.values(item).some(scopes => !Array.isArray(scopes) || scopes.some(scope => typeof scope !== 'string')))) throw new Error('Confira os requisitos de segurança da API.');
  }
  function checkSchema(value: unknown) {
    if (value === undefined || typeof value === 'boolean') return;
    if (!object(value)) throw new Error('Os schemas precisam ser objetos válidos.');
    if (value.required !== undefined && (!Array.isArray(value.required) || value.required.some((name: unknown) => typeof name !== 'string'))) throw new Error('A lista required de um schema precisa conter nomes de campos.');
    if (value.properties !== undefined) {
      if (!object(value.properties)) throw new Error('Confira properties nos schemas.');
      Object.values(value.properties).forEach(checkSchema);
    }
    for (const key of ['allOf', 'oneOf', 'anyOf', 'prefixItems']) if (value[key] !== undefined) {
      if (!Array.isArray(value[key])) throw new Error(`O campo ${key} precisa ser uma lista de schemas.`);
      value[key].forEach(checkSchema);
    }
    if (value.items !== undefined) checkSchema(value.items);
    if (value.additionalProperties !== undefined) checkSchema(value.additionalProperties);
  }
  function checkContent(value: unknown) {
    if (value === undefined) return;
    if (!object(value)) throw new Error('Confira os tipos de mídia em content.');
    for (const media of Object.values(value)) {
      if (!object(media)) throw new Error('Cada tipo de mídia precisa ser um objeto.');
      checkSchema(media.schema);
      if (media.examples !== undefined && !object(media.examples)) throw new Error('Confira os exemplos da API.');
    }
  }
  function checkParameters(value: unknown) {
    if (value === undefined) return;
    if (!Array.isArray(value)) throw new Error('parameters precisa ser uma lista.');
    for (const parameter of value) {
      if (!object(parameter) || (!parameter.$ref && (typeof parameter.name !== 'string' || !['path', 'query', 'header', 'cookie'].includes(parameter.in)))) throw new Error('Confira nome e localização dos parâmetros.');
      checkSchema(parameter.schema);
      checkContent(parameter.content);
    }
  }
  checkSecurity(parsed.security);
  if (parsed.components !== undefined) {
    if (!object(parsed.components)) throw new Error('components precisa ser um objeto.');
    if (parsed.components.schemas !== undefined) {
      if (!object(parsed.components.schemas)) throw new Error('Confira os schemas de components.');
      Object.values(parsed.components.schemas).forEach(checkSchema);
    }
  }
  const methods = ['get', 'post', 'put', 'patch', 'delete', 'options', 'head', 'trace'];
  for (const [path, item] of Object.entries(parsed.paths)) {
    if (path.startsWith('x-')) continue;
    if (!path.startsWith('/') || !object(item)) throw new Error('Cada item de paths deve começar com / e conter um objeto.');
    checkParameters(item.parameters);
    for (const method of methods) if (method in item) {
      const operation = item[method];
      if (!object(operation) || !object(operation.responses)) throw new Error(`Confira responses em ${method.toUpperCase()} ${path}.`);
      checkParameters(operation.parameters); checkSecurity(operation.security);
      if (operation.tags !== undefined && (!Array.isArray(operation.tags) || operation.tags.some((tag: unknown) => typeof tag !== 'string'))) throw new Error('As tags de um endpoint precisam ser uma lista.');
      if (operation.requestBody !== undefined) {
        if (!object(operation.requestBody)) throw new Error('requestBody precisa ser um objeto.');
        checkContent(operation.requestBody.content);
      }
      for (const response of Object.values(operation.responses)) {
        if (!object(response)) throw new Error('Cada resposta precisa ser um objeto.');
        checkContent(response.content);
      }
    }
  }
  if (parsed.servers !== undefined && (!Array.isArray(parsed.servers) || parsed.servers.some((item: unknown) => !object(item) || typeof item.url !== 'string'))) throw new Error('Confira a lista de servidores da API.');
  if (parsed.tags !== undefined && (!Array.isArray(parsed.tags) || parsed.tags.some((item: unknown) => !object(item) || typeof item.name !== 'string'))) throw new Error('Confira as tags da API.');
  return parsed;
}
export function validatePages(value: unknown): ContentPage[] {
  if (!Array.isArray(value) || value.length > 100) throw new Error('A documentação aceita até 100 páginas.');
  const ids = new Set<string>();
  const slugs = new Set<string>();
  return value.map(page => {
    if (!object(page) || typeof page.id !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(page.id)
      || typeof page.title !== 'string' || !page.title.trim() || page.title.trim().length > 100
      || typeof page.slug !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(page.slug) || page.slug.length > 100
      || typeof page.group !== 'string' || !page.group.trim() || page.group.trim().length > 60
      || typeof page.markdown !== 'string' || page.markdown.length > 100000 || typeof page.published !== 'boolean') throw new Error('Confira título, endereço, grupo e conteúdo das páginas.');
    if (ids.has(page.id) || slugs.has(page.slug)) throw new Error('Cada página precisa ter um endereço único.');
    ids.add(page.id); slugs.add(page.slug);
    return { id: page.id, title: page.title.trim(), slug: page.slug, group: page.group.trim(), markdown: page.markdown, published: page.published };
  });
}
