import { api } from '../api';
import type { ContentPage } from '../types';
import { renderMarkdown } from '../content/markdown';
import { load as loadYAML } from 'js-yaml';
import {
  createIcons, ArrowUpRight, BookOpen, Braces, ChevronDown, ChevronRight,
  CircleHelp, Code2, Copy, Eye, Folder, KeyRound, ListOrdered, ListTree,
  LockKeyhole, Play, Plus, RotateCcw, Search, SquareTerminal, X,
} from 'lucide';
import { languages as snippetLanguages, generate as generateSnippet } from './request-snippets';
import type { SnippetLanguage } from './request-snippets';
import type { DynamicSchema, APIParameter, OpenAPISpec, Operation, DocumentationState, MediaType } from './types';

/**
 * The documentation template declares these controls by stable IDs. Keeping the
 * adapter here lets the existing editor and renderer share typed DOM access
 * while the React shell owns routing, authentication and lifecycle.
 */
interface UIElement extends HTMLElement {
  value: string;
  disabled: boolean;
  open: boolean;
  type: string;
  options: HTMLOptionsCollection;
  files: FileList | null;
  selectionStart: number;
  selectionEnd: number;
  setSelectionRange(start: number, end: number): void;
  setRangeText(text: string, start: number, end: number, mode?: SelectionMode): void;
  showModal(): void;
  close(): void;
}

const icons = {
  ArrowUpRight, BookOpen, Braces, ChevronDown, ChevronRight, CircleHelp, Code2,
  Copy, Eye, Folder, KeyRound, ListOrdered, ListTree, LockKeyhole,
  Play, Plus, RotateCcw, Search, SquareTerminal, X,
};

const emptySpec: OpenAPISpec = { openapi: '', info: { title: '', version: '' }, paths: {} };

export async function mountDocumentation(signal?: AbortSignal): Promise<() => void> {
  if (signal?.aborted) return () => {};
  const lifecycle = new AbortController();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let toastTimer: ReturnType<typeof setTimeout> | undefined;
  function schedule(callback: () => void, delay: number) {
    const timer = setTimeout(() => { timers.delete(timer); if (!lifecycle.signal.aborted) callback(); }, delay);
    timers.add(timer);
    return timer;
  }
  function listen<K extends keyof GlobalEventHandlersEventMap>(target: EventTarget | null, event: K, callback: (event: GlobalEventHandlersEventMap[K]) => unknown): void;
  function listen(target: EventTarget | null, event: string, callback: (event: Event) => unknown): void;
  function listen(target: EventTarget | null, event: string, callback: (event: never) => unknown) {
    target?.addEventListener(event, callback as EventListener, { signal: lifecycle.signal });
  }

  const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'options', 'head'];
  const state: DocumentationState = { spec: emptySpec, operations: [], active: null, importMode: 'url', sourceName: 'sample-openapi.json' };
  let requestSettingsInitialized = false;
  let requestExampleLanguage = 'curl';
  let credentialOrigin: string | null = null;
  const $ = (selector: string, root: ParentNode = document): UIElement => root.querySelector(selector) as UIElement;
  const $$ = (selector: string, root: ParentNode = document): UIElement[] => [...root.querySelectorAll(selector)] as UIElement[];
  const escapeHTML = (value: unknown = '') => String(value).replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#039;', '"': '&quot;' } as Record<string, string>)[char]);
  const slugify = (value = '') => String(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const methodClass = (method: string) => `method method--${method.toLowerCase()}`;
  const methodLabel = (method: string) => method.toUpperCase();

  function toast(message: string, error = false) {
    if (lifecycle.signal.aborted) return;
    const element = $('#toast');
    $('span', element).textContent = message;
    element.classList.toggle('is-error', error);
    element.classList.add('is-visible');
    clearTimeout(toastTimer);
    toastTimer = schedule(() => element.classList.remove('is-visible'), 2400);
  }

  async function copyText(text: string | null, message = 'Copiado') {
    try { await navigator.clipboard.writeText(text || ''); toast(message); }
    catch { toast('Não foi possível copiar', true); }
  }

  function resolveRef(ref?: string) {
    if (!ref || !ref.startsWith('#/')) return null;
    return ref.slice(2).split('/').reduce((value, key) => value?.[key.replace(/~1/g, '/').replace(/~0/g, '~')], state.spec);
  }

  function dereference(value: unknown): NonNullable<DynamicSchema> | undefined {
    if (!value || typeof value !== 'object') return undefined;
    let node = value as NonNullable<DynamicSchema>;
    const references = new Set<string>();
    while (typeof node.$ref === 'string' && !references.has(node.$ref)) {
      references.add(node.$ref);
      const resolved = resolveRef(node.$ref);
      if (!resolved || typeof resolved !== 'object') break;
      node = resolved;
    }
    return node;
  }

  function schemaExample(rawSchema: unknown, depth = 0, ancestors = new Set<DynamicSchema>()): unknown {
    const schema = dereference(rawSchema) || {};
    if (schema.example !== undefined) return schema.example;
    if (schema.default !== undefined) return schema.default;
    if (schema.enum?.length) return schema.enum[0];
    if (depth > 4 || ancestors.has(schema)) return null;
    const next = new Set([...ancestors, schema]);
    if (schema.type === 'array' || schema.items) return [schemaExample(schema.items || {}, depth + 1, next)];
    if (schema.type === 'object' || schema.properties) return Object.fromEntries(Object.entries(schema.properties || {}).map(([key, value]) => [key, schemaExample(value, depth + 1, next)]));
    if (schema.type === 'integer' || schema.type === 'number') return 1;
    if (schema.type === 'boolean') return false;
    if (schema.format === 'date-time') return new Date().toISOString();
    if (schema.format === 'date') return new Date().toISOString().slice(0, 10);
    return 'string';
  }

  function parseSpec(text: string) {
    const source = String(text || '').trim();
    if (!source) throw new Error('A especificação está vazia.');
    let parsed;
    try { parsed = JSON.parse(source); }
    catch (jsonError) {
      parsed = loadYAML(source);
    }
    if (!parsed || typeof parsed !== 'object' || !parsed.openapi || !parsed.info || !parsed.paths) {
      throw new Error('O arquivo precisa conter openapi, info e paths.');
    }
    return parsed;
  }

  function collectOperations(spec: OpenAPISpec) {
    const operations: Operation[] = [];
    Object.entries(spec.paths || {}).forEach(([path, rawPathItem]) => {
      const pathItem = dereference(rawPathItem) || {};
      HTTP_METHODS.forEach((method) => {
        if (!pathItem[method]) return;
        const operation = dereference(pathItem[method]) || {};
        const parameters = [...(pathItem.parameters || []), ...(operation.parameters || [])].map((parameter) => dereference(parameter)).filter((parameter): parameter is APIParameter => Boolean(parameter));
        operations.push({
          id: `op-${slugify(operation.operationId || `${method}-${path}`)}`,
          method,
          path,
          tag: operation.tags?.[0] || 'General',
          summary: operation.summary || operation.operationId || `${methodLabel(method)} ${path}`,
          description: operation.description || '',
          parameters,
          requestBody: dereference(operation.requestBody),
          responses: operation.responses || {},
          security: operation.security ?? spec.security,
          raw: operation
        });
      });
    });
    return operations;
  }

  function tagMetadata(tagName: string) {
    return state.spec.tags?.find((tag) => tag.name === tagName) || { name: tagName, description: '' };
  }

  let GUIDES: (ContentPage & { icon: string })[] = [];
  function guideContent(id: string) {
    const page = GUIDES.find(item => item.slug === id);
    return page ? renderMarkdown(page.markdown) : '';
  }

  function selectGuide(id?: string) {
    const guide = GUIDES.find((item) => item.slug === id);
    if (!guide) return;
    document.body.classList.add('docs-content-page');
    document.body.classList.remove('console-open');
    $$('.nav-schema-link').forEach(link => { link.classList.remove('is-active'); link.removeAttribute('aria-current'); });
    $('#reference-content').innerHTML = `<div class="reference__inner reference__inner--single"><article class="text-guide"><div class="text-guide__eyebrow">${escapeHTML(guide.group)}</div><h1>${escapeHTML(guide.title)}</h1><div class="cms-markdown">${guideContent(guide.slug)}</div></article></div>`;
    history.replaceState(null, '', `#guide-${guide.slug}`);
    $('#reference').scrollTop = 0;
    $$('.nav-link').forEach((link) => link.classList.remove('is-active'));
    $$('[data-guide]').forEach((link) => link.classList.toggle('is-active', link.dataset.guide === id));
  }

  function schemaHash(name: string) { return `#schema-${encodeURIComponent(name)}`; }
  function schemaNameFromHash(hash: string) {
    try { return decodeURIComponent(hash.slice(7)); } catch { return ''; }
  }
  function schemaReferenceName(ref: unknown): string | null {
    if (typeof ref !== 'string' || !ref.startsWith('#/components/schemas/')) return null;
    return ref.slice('#/components/schemas/'.length).replace(/~1/g, '/').replace(/~0/g, '~');
  }
  function schemaReferenceLink(raw: unknown) {
    const name = schemaReferenceName((raw as DynamicSchema)?.$ref);
    return name && Object.hasOwn(state.spec.components?.schemas || {}, name)
      ? `<a class="schema-model-link" href="${escapeHTML(schemaHash(name))}" data-schema-target="${escapeHTML(name)}"><i data-lucide="braces" aria-hidden="true"></i>${escapeHTML(name)}</a>` : '';
  }
  function referencedSchemas(raw: unknown): string[] {
    const names = new Set<string>();
    const visited = new Set<object>();
    function walk(value: unknown) {
      if (!value || typeof value !== 'object' || visited.has(value)) return;
      visited.add(value);
      const name = schemaReferenceName((value as NonNullable<DynamicSchema>).$ref);
      if (name && Object.hasOwn(state.spec.components?.schemas || {}, name)) names.add(name);
      Object.values(value).forEach(walk);
    }
    walk(raw);
    return [...names];
  }
  function selectSchema(name?: string) {
    const schemas = state.spec.components?.schemas || {};
    resetRequestResponse();
    state.active = null;
    document.body.classList.add('docs-content-page');
    document.body.classList.remove('console-open');
    $$('.nav-link, [data-guide], .nav-schema-link').forEach(link => { link.classList.remove('is-active'); link.removeAttribute('aria-current'); });
    if (!name || !Object.hasOwn(schemas, name)) {
      $('#reference-content').innerHTML = '<div class="schema-page"><p class="schema-page-eyebrow">API Reference / Schemas</p><h1>Schema não encontrado</h1><p>Selecione um schema disponível no menu lateral.</p></div>';
      return;
    }
    const raw: unknown = schemas[name];
    const schema = dereference(raw) || {};
    const references = referencedSchemas(raw);
    const explicitExample = schema.example !== undefined ? schema.example : Array.isArray(schema.examples) ? schema.examples[0] : undefined;
    const example = explicitExample !== undefined ? explicitExample : raw === false ? undefined : schemaExample(raw);
    const propertyCount = Object.keys(schema.properties || {}).length;
    const description = (raw as DynamicSchema)?.description || schema.description;
    history.replaceState(null, '', schemaHash(name));
    $('#reference-content').innerHTML = `<article class="schema-page">
      <div class="schema-page-eyebrow"><i data-lucide="braces" aria-hidden="true"></i><span>API Reference <b>/</b> Schemas</span></div>
      <header class="schema-page-header"><div><h1>${escapeHTML(name)}</h1><div class="schema-page-meta"><code>${escapeHTML(schemaType(raw))}</code>${schema.format ? `<span>${escapeHTML(schema.format)}</span>` : ''}${propertyCount ? `<span>${propertyCount} ${propertyCount === 1 ? 'propriedade' : 'propriedades'}</span>` : ''}${schema.deprecated ? '<span>Obsoleto</span>' : ''}</div></div><button type="button" class="schema-copy" data-copy-schema><i data-lucide="copy" aria-hidden="true"></i>Copiar JSON</button></header>
      ${description ? `<div class="schema-page-description cms-markdown">${renderMarkdown(String(description))}</div>` : ''}
      <div class="schema-view-tabs" role="tablist" aria-label="Visualização do schema"><button type="button" role="tab" id="schema-tab-properties" aria-controls="schema-properties" aria-selected="true">Propriedades</button><button type="button" role="tab" id="schema-tab-json" aria-controls="schema-json" aria-selected="false" tabindex="-1">JSON</button></div>
      <div id="schema-properties" role="tabpanel" aria-labelledby="schema-tab-properties" class="schema-view-grid">
        <section class="endpoint-content schema-page-properties" aria-label="Propriedades do schema">${raw === false ? '<p class="schema-view-note">Este schema não aceita nenhum valor.</p>' : raw === true ? '<p class="schema-view-note">Este schema aceita qualquer valor.</p>' : renderSchemaFields(raw)}
          ${references.length ? `<section class="schema-references"><h2>Schemas relacionados</h2><div>${references.map(target => `<a class="schema-model-link" href="${escapeHTML(schemaHash(target))}" data-schema-target="${escapeHTML(target)}"><i data-lucide="braces" aria-hidden="true"></i>${escapeHTML(target)}</a>`).join('')}</div></section>` : ''}
        </section>
        <aside class="schema-page-example" aria-label="Exemplo do schema">${example !== undefined ? renderDocCode(example, explicitExample !== undefined ? 'Exemplo' : 'Exemplo gerado') : '<p class="schema-view-note">Não há exemplo válido para este schema.</p>'}${explicitExample === undefined && example !== undefined ? '<p class="schema-example-hint">Gerado a partir dos tipos e valores definidos no schema.</p>' : ''}</aside>
      </div>
      <div id="schema-json" role="tabpanel" aria-labelledby="schema-tab-json" hidden><div class="schema-source"><div>Schema OpenAPI <span>JSON</span></div><pre tabindex="0" aria-label="JSON do schema"><code>${highlightJSON(JSON.stringify(raw, null, 2))}</code></pre></div></div>
    </article>`;
    $('#reference').scrollTop = 0;
    $$('.nav-schema-link').forEach(link => {
      const active = link.dataset.schemaName === name;
      link.classList.toggle('is-active', active);
      if (active) { link.setAttribute('aria-current', 'page'); link.closest<HTMLDetailsElement>('.nav-schemas')!.open = true; }
      else link.removeAttribute('aria-current');
    });
    const tabs = $$('.schema-view-tabs [role="tab"]');
    function changeTab(index: number) {
      tabs.forEach((tab, position) => { tab.setAttribute('aria-selected', String(position === index)); tab.tabIndex = position === index ? 0 : -1; });
      $('#schema-properties').hidden = index !== 0;
      $('#schema-json').hidden = index !== 1;
    }
    tabs.forEach((tab, index) => {
      listen(tab, 'click', () => changeTab(index));
      listen(tab, 'keydown', event => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? 1 : 1 - index;
        changeTab(next); tabs[next].focus();
      });
    });
    listen($('[data-copy-schema]'), 'click', () => copyText(JSON.stringify(raw, null, 2), 'Schema copiado'));
    createIcons({ icons, attrs: { 'aria-hidden': 'true' } });
  }

  function renderNavigation() {
    const grouped = new Map<string, Operation[]>();
    state.operations.forEach(operation => {
      if (!grouped.has(operation.tag)) grouped.set(operation.tag, []);
      grouped.get(operation.tag)!.push(operation);
    });
    const schemas = Object.keys(state.spec.components?.schemas || {});
    $('#navigation').innerHTML = `
      <button class="sidebar-search" id="sidebar-search" type="button"><i data-lucide="search" aria-hidden="true"></i><span>Search…</span><kbd>⌘K</kbd></button>
      ${[...new Set(GUIDES.map(page => page.group))].map(group => `<div class="nav-guides"><h2>${escapeHTML(group)}</h2>${GUIDES.filter(page => page.group === group).map(guide => `<a class="nav-guide" href="#guide-${guide.slug}" data-guide="${guide.slug}"><i data-lucide="book-open" aria-hidden="true"></i><span>${escapeHTML(guide.title)}</span></a>`).join('')}</div>`).join('')}
      <h2 class="nav-reference-label">API Reference</h2>
      <div class="nav-tree">
        <div class="nav-tree__children">
          ${[...grouped].map(([tag, operations], index) => `
            <details class="nav-group" data-nav-tag="${escapeHTML(tag)}" ${index === 0 ? 'open' : ''}>
              <summary><span class="nav-node__chevron"><i data-lucide="chevron-right" aria-hidden="true"></i></span><span class="nav-resource-icon" aria-hidden="true"><i data-lucide="folder"></i></span><span class="nav-node__label">${escapeHTML(tag)}</span><span class="nav-node__count">${operations.length}</span></summary>
              <div class="nav-group__items">
                ${operations.map((operation) => `<a class="nav-link" href="#${operation.id}" data-operation-id="${operation.id}" data-operation-tag="${escapeHTML(tag)}"><span class="nav-link__method" data-method="${operation.method}">${methodLabel(operation.method)}</span><span class="nav-link__title">${escapeHTML(operation.summary)}</span></a>`).join('')}
              </div>
            </details>`).join('')}
          <details class="nav-schemas">
            <summary><span class="nav-node__chevron"><i data-lucide="chevron-right" aria-hidden="true"></i></span><span class="nav-schema-icon" aria-hidden="true"><i data-lucide="braces"></i></span><span class="nav-node__label">Schemas</span><span class="nav-node__count">${schemas.length}</span></summary>
            <div class="nav-schema-items">${schemas.length ? schemas.map((schema) => `<a class="nav-schema-link" href="${escapeHTML(schemaHash(schema))}" data-schema-name="${escapeHTML(schema)}">${escapeHTML(schema)}</a>`).join('') : '<span class="nav-schema-empty">No schemas</span>'}</div>
          </details>
        </div>
      </div>`;
    createIcons({ icons, attrs: { 'aria-hidden': 'true' } });
  }

  function renderParameterDocs(parameters: APIParameter[]) {
    if (!parameters.length) return '';
    return `<div class="detail-block"><div class="detail-block__header"><span>Parâmetros</span><span>${parameters.length}</span></div>${parameters.map((parameter) => {
      const schema = dereference(parameter.schema) || {};
      return `<div class="param-row"><code>${escapeHTML(parameter.name)}${parameter.required ? ' <span class="required">*</span>' : ''}</code><p>${escapeHTML(parameter.description || 'Sem descrição.')}</p><span class="param-row__meta">${escapeHTML(parameter.in || '')} · ${escapeHTML(schema.type || 'any')}</span></div>`;
    }).join('')}</div>`;
  }

  function renderResponseDocs(responses: Record<string, DynamicSchema>) {
    const entries = Object.entries(responses || {});
    if (!entries.length) return '';
    return `<div class="detail-block"><div class="detail-block__header"><span>Responses</span><span>${entries.length}</span></div>${entries.map(([code, raw]) => {
      const response = dereference(raw) || {};
      return `<div class="response-row"><code>${escapeHTML(code)}</code><span>${escapeHTML(response.description || 'Sem descrição.')}</span></div>`;
    }).join('')}</div>`;
  }

  function renderBodyDocs(operation: Operation) {
    const body = bodySchema(operation);
    const schema = dereference(body.schema) || {};
    const properties = Object.entries(schema.properties || {});
    if (!properties.length) return '';
    return `<div class="detail-block body-docs"><div class="detail-block__header"><span>Body <code>${escapeHTML(body.type)}</code></span><span>${properties.length} fields</span></div>${properties.map(([name, raw]) => {
      const property = dereference(raw) || {};
      const required = schema.required?.includes(name);
      return `<div class="param-row"><code>${escapeHTML(name)}${required ? ' <span class="required">required</span>' : ''}</code><p>${escapeHTML(property.description || `Valor enviado em ${name}.`)}</p><span class="param-row__meta">${escapeHTML(property.type || 'any')}${property.format ? ` · ${escapeHTML(property.format)}` : ''}</span></div>`;
    }).join('')}</div>`;
  }

  function schemaType(raw: unknown, seen = new Set<DynamicSchema>()): string {
    if (raw === false) return 'never';
    const schema = dereference(raw) || {};
    if (seen.has(schema)) return 'object';
    if (schema.type === 'array') return `${schemaType(schema.items, new Set([...seen, schema]))}[]`;
    return Array.isArray(schema.type) ? schema.type.join(' | ') : schema.type || (schema.properties || schema.additionalProperties ? 'object' : schema.oneOf || schema.anyOf ? 'union' : schema.allOf ? 'object' : 'any');
  }

  function highlightJSON(json: string) {
    const tokens = /"(?:\\.|[^"\\])*"\s*:|"(?:\\.|[^"\\])*"|\b(?:true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g;
    let html = '';
    let cursor = 0;
    for (const match of json.matchAll(tokens)) {
      const token = match[0];
      const kind = token.startsWith('"') ? (/:$/.test(token) ? 'key' : 'string') : /^(true|false|null)$/.test(token) ? 'literal' : 'number';
      html += escapeHTML(json.slice(cursor, match.index)) + `<span class="json-${kind}">${escapeHTML(token)}</span>`;
      cursor = match.index + token.length;
    }
    return html + escapeHTML(json.slice(cursor));
  }

  function renderDocCode(value: unknown, label = 'Example') {
    const json = JSON.stringify(value, null, 2);
    if (json === undefined) return '';
    const highlighted = highlightJSON(json);
    const scalar = value === null || typeof value !== 'object';
    return `<figure class="doc-example${scalar ? ' doc-example--scalar' : ''}"><figcaption>${escapeHTML(label)}</figcaption><pre tabindex="0" aria-label="${escapeHTML(label)}"><code>${highlighted}</code></pre></figure>`;
  }

  function renderDocExamples(source: unknown, named = false, inline = false) {
    const sourceNode = dereference(source);
    if (!sourceNode) return '';
    const render = inline ? (value: unknown, label = 'Example') => `<p class="field-example"><code>${escapeHTML(label)}: ${escapeHTML(JSON.stringify(value, null, typeof value === 'object' && value !== null ? 2 : undefined))}</code></p>` : renderDocCode;
    if (sourceNode.example !== undefined) return render(sourceNode.example);
    if (Array.isArray(sourceNode.examples)) return sourceNode.examples.map((value: unknown, index: number) => render(value, sourceNode.examples.length > 1 ? `Example ${index + 1}` : 'Example')).join('');
    if (named && sourceNode.examples) return Object.entries(sourceNode.examples).map(([name, raw]) => {
      const example = dereference(raw) || {};
      return `${example.description ? `<p class="example-description">${escapeHTML(example.description)}</p>` : ''}${example.value !== undefined ? render(example.value, example.summary || name) : example.externalValue ? `<p class="example-description">${escapeHTML(example.summary || name)}: <code>${escapeHTML(example.externalValue)}</code></p>` : ''}`;
    }).join('');
    return '';
  }

  function schemaConstraints(schema: NonNullable<DynamicSchema>, includeExamples = true, inlineExamples = false) {
    const values: string[] = [];
    if (schema.enum) values.push(`Allowed: ${schema.enum.map((value: unknown) => JSON.stringify(value)).join(', ')}`);
    if (schema.default !== undefined) values.push(`Default: ${JSON.stringify(schema.default)}`);
    if (schema.minimum !== undefined) values.push(`Min: ${schema.minimum}`);
    if (schema.maximum !== undefined) values.push(`Max: ${schema.maximum}`);
    if (schema.minLength !== undefined) values.push(`Min length: ${schema.minLength}`);
    if (schema.maxLength !== undefined) values.push(`Max length: ${schema.maxLength}`);
    if (schema.pattern) values.push(`Pattern: ${schema.pattern}`);
    return (values.length ? `<div class="field-constraints">${values.map((value) => `<code>${escapeHTML(value)}</code>`).join('')}</div>` : '') + (includeExamples ? renderDocExamples(schema, false, inlineExamples) : '');
  }

  function renderSchemaFields(rawSchema: unknown, ancestors = new Set<DynamicSchema>(), layout = 'list'): string {
    const schema = dereference(rawSchema) || {};
    if (ancestors.has(schema)) return `<p class="schema-reference">Referência recursiva ${schemaReferenceLink(rawSchema) || `<code>${escapeHTML((rawSchema as DynamicSchema)?.$ref || '')}</code>`}</p>`;
    const next = new Set([...ancestors, schema]);
    const fields = Object.entries(schema.properties || {}).map(([name, rawProperty]) => {
      const property = dereference(rawProperty) || {};
      const complex = property.properties || property.items || property.allOf || property.oneOf || property.anyOf || typeof property.additionalProperties === 'object';
      const nested = complex ? `<details class="schema-nested"><summary>${property.type === 'array' ? 'Propriedades do item' : 'Propriedades do objeto'}</summary>${renderSchemaFields(property.type === 'array' ? property.items : rawProperty, next, layout)}</details>` : '';
      return `<div class="schema-field"><div class="schema-field__meta"><strong>${escapeHTML(name)}</strong><code>${escapeHTML(schemaType(property))}${property.format ? ` · ${escapeHTML(property.format)}` : ''}</code>${property.readOnly ? '<span class="field-access">read-only</span>' : ''}${property.writeOnly ? '<span class="field-access">write-only</span>' : ''}${schema.required?.includes(name) ? '<span class="field-required">required</span>' : '<span class="field-optional">optional</span>'}</div>${property.description ? `<p>${escapeHTML(property.description)}</p>` : ''}${schemaConstraints(property, true, layout === 'body')}${schemaReferenceLink(rawProperty)}${nested}</div>`;
    }).join('');
    const variants = ['allOf', 'oneOf', 'anyOf'].map((kind) => (schema[kind] || []).map((variant: unknown, index: number) => `<details class="schema-nested"><summary>${kind} · ${escapeHTML(dereference(variant)?.title || `Schema ${index + 1}`)}</summary>${renderSchemaFields(variant, next, layout)}</details>`).join('')).join('');
    const items = schema.items ? `<div class="schema-array"><code>${escapeHTML(schemaType(schema))}</code>${renderSchemaFields(schema.items, next, layout)}</div>` : '';
    const additional = typeof schema.additionalProperties === 'object' ? `<details class="schema-nested"><summary>Additional properties</summary>${renderSchemaFields(schema.additionalProperties, next, layout)}</details>` : '';
    const root = fields || items || variants || additional ? '' : `<div class="schema-root-type"><code>${escapeHTML(schemaType(schema))}</code>${schema.description ? `<p>${escapeHTML(schema.description)}</p>` : ''}</div>`;
    return `${fields ? `<div class="schema-fields">${fields}</div>` : ''}${items}${variants}${additional}${root}${schemaConstraints(schema, true, layout === 'body')}`;
  }

  function renderEndpointAuth(operation: Operation) {
    const requirements = operation.security || [];
    if (!requirements.length) return '';
    const optional = requirements.some((requirement) => !Object.keys(requirement).length);
    const schemes = state.spec.components?.securitySchemes || {};
    const alternatives = requirements.filter((requirement) => Object.keys(requirement).length).map((requirement) => Object.entries(requirement).map(([name, scopes]) => {
      const scheme = dereference(schemes[name]) || {};
      const label = scheme.type === 'http' ? (scheme.scheme?.toLowerCase() === 'bearer' ? 'Bearer token' : `${scheme.scheme || 'HTTP'} authentication`) : scheme.type === 'apiKey' ? `${scheme.name || name} (${scheme.in || 'header'})` : name;
      return { label, scheme, scopes };
    }));
    const methods = alternatives.map((items) => items.map((item) => item.label).join(' + ')).join(' or ');
    return `<details class="endpoint-auth"><summary><i data-lucide="lock-keyhole" aria-hidden="true"></i><span class="auth-heading"><strong>Authentication</strong><span class="auth-status">${optional ? 'Optional' : 'Required'}</span></span><span class="auth-method">${escapeHTML(methods)}</span><i data-lucide="chevron-down" aria-hidden="true"></i></summary><div class="endpoint-auth__details">${alternatives.map((items, index) => `${index ? '<p class="auth-alternative">or</p>' : ''}${items.map(({ label, scheme, scopes }) => `<div class="auth-scheme"><strong>${escapeHTML(label)}</strong>${scheme.description ? `<p>${escapeHTML(scheme.description)}</p>` : ''}<dl>${scheme.type === 'http' ? '<div><dt>Header</dt><dd><code>Authorization</code></dd></div>' : ''}${scheme.type === 'apiKey' ? `<div><dt>${escapeHTML(scheme.in || 'Location')}</dt><dd><code>${escapeHTML(scheme.name || '')}</code></dd></div>` : ''}${scheme.bearerFormat ? `<div><dt>Format</dt><dd><code>${escapeHTML(scheme.bearerFormat)}</code></dd></div>` : ''}${scopes.length ? `<div><dt>Scopes</dt><dd><code>${escapeHTML(scopes.join(', '))}</code></dd></div>` : ''}</dl></div>`).join('')}`).join('')}<button class="auth-guide-link" type="button" data-auth-guide>Authentication guide<i data-lucide="arrow-up-right" aria-hidden="true"></i></button></div></details>`;
  }

  function renderResponseDocsContent(responses: [string, DynamicSchema][]) {
    const expanded = responses.find(([code, raw]) => /^2/.test(code) && Object.values((dereference(raw)?.content || {}) as Record<string, MediaType>).some((media) => media.schema || media.example !== undefined || media.examples))?.[0];
    return responses.map(([code, raw]) => {
      const response = dereference(raw) || {};
      const media = Object.entries((response.content || {}) as Record<string, MediaType>);
      const kind = /^2/.test(code) ? 'success' : /^[45]/.test(code) ? 'error' : 'neutral';
      return `<details class="endpoint-response"${code === expanded ? ' open' : ''}><summary><span class="response-status response-status--${kind}">${escapeHTML(code)}</span><span>${escapeHTML(response.description || 'Response')}</span><i data-lucide="chevron-down" aria-hidden="true"></i></summary><div class="endpoint-response__body">${media.length ? media.map(([type, value]) => `<div class="response-media"><code>${escapeHTML(type)}</code>${value.schema ? renderSchemaFields(value.schema) : ''}${renderDocExamples(value, true)}${!value.schema && value.example === undefined && !value.examples ? '<p>No response schema or example provided.</p>' : ''}</div>`).join('') : `<p>${code === '204' ? 'This response has no body.' : 'No response body is documented for this status.'}</p>`}</div></details>`;
    }).join('') || '<p>No responses documented.</p>';
  }

  function renderReference(operation = state.active || state.operations[0]) {
    if (!operation) return;
    const body = bodySchema(operation);
    const parameters = operation.parameters || [];
    const responses = Object.entries(operation.responses || {});
    const locations = [...new Set(parameters.map((parameter) => parameter.in))];
    const baseURL = ($('#server-select').value || state.spec.servers?.[0]?.url || window.location.origin).replace(/\/$/, '');
    $('#reference-content').innerHTML = `<div class="reference__inner reference__inner--single endpoint-content">
      <div class="endpoint-breadcrumb" id="overview"><span>API Reference</span><span>/</span><span>${escapeHTML(operation.tag)}</span></div>
      <article class="endpoint-page" id="${operation.id}" data-operation-id="${operation.id}">
        <header class="endpoint-page__header"><div><h1>${escapeHTML(operation.summary)}</h1>${operation.raw.deprecated ? '<span class="endpoint-deprecated">Deprecated</span>' : ''}</div></header>
        ${operation.description ? `<p class="endpoint-page__description">${escapeHTML(operation.description)}</p>` : ''}
        <div class="endpoint-address"><span class="${methodClass(operation.method)}">${methodLabel(operation.method)}</span><code id="endpoint-full-url"><span class="endpoint-url__prefix">${escapeHTML(baseURL)}</span>${escapeHTML(operation.path)}</code><button class="icon-button" type="button" id="copy-endpoint-path" aria-label="Copiar URL completa" title="Copiar URL completa"><i data-lucide="copy" aria-hidden="true"></i></button><button class="endpoint-run" type="button" data-try-operation="${operation.id}" aria-controls="console" title="Abrir no API Explorer"><i data-lucide="play" aria-hidden="true"></i><span>Test request</span></button></div>
        ${renderEndpointAuth(operation)}
        ${locations.map((location) => `<section class="doc-section"><header><h2>${escapeHTML(({ path: 'Path parameters', query: 'Query parameters', header: 'Headers', cookie: 'Cookies' })[location] || 'Parameters')}</h2><span class="section-count">${parameters.filter((parameter) => parameter.in === location).length}</span></header><div class="schema-fields">${parameters.filter((parameter) => parameter.in === location).map((parameter) => { const schema = dereference(parameter.schema) || {}; return `<div class="schema-field"><div class="schema-field__meta"><strong>${escapeHTML(parameter.name)}</strong><code>${escapeHTML(schemaType(schema))}${schema.format ? ` · ${escapeHTML(schema.format)}` : ''}</code>${parameter.required || location === 'path' ? '<span class="field-required">required</span>' : '<span class="field-optional">optional</span>'}</div>${parameter.description ? `<p>${escapeHTML(parameter.description)}</p>` : ''}${schemaConstraints(schema, true, true)}${renderDocExamples(parameter, true, true)}</div>`; }).join('')}</div></section>`).join('')}
        ${operation.requestBody ? `<section class="doc-section request-body-section"><header><h2>Body</h2>${operation.requestBody.required ? '<span class="body-required">Required</span>' : ''}<code>${escapeHTML(body.type)}</code></header>${operation.requestBody.description || dereference(body.schema)?.description ? `<p>${escapeHTML(operation.requestBody.description || dereference(body.schema)?.description)}</p>` : ''}${body.schema ? renderSchemaFields(body.schema, new Set(), 'body') : '<p>No request schema provided.</p>'}${renderDocExamples(operation.requestBody.content?.[body.type], true)}</section>` : ''}
        <section class="doc-section responses-section"><header><h2>Responses</h2><span class="section-count">${responses.length}</span></header><div class="endpoint-responses">${renderResponseDocsContent(responses)}</div></section>
      </article>
    </div>`;
    bindReferenceEvents();
    createIcons({ icons, attrs: { 'aria-hidden': 'true' } });
  }

  function bindReferenceEvents() {
    $$('[data-try-operation]', $('#reference')).forEach((button) => listen(button, 'click', () => selectOperation(button.dataset.tryOperation, true)));
    listen($('[data-auth-guide]'), 'click', () => selectGuide('authentication'));
    listen($('#copy-endpoint-path'), 'click', () => copyText($('#endpoint-full-url').textContent, 'URL copiada'));
  }

  function renderServers() {
    const servers = state.spec.servers?.length ? state.spec.servers : [{ url: window.location.origin, description: 'Current origin' }];
    $('#server-select').innerHTML = servers.map((server) => `<option value="${escapeHTML(server.url)}">${escapeHTML(server.description || server.url)} · ${escapeHTML(server.url)}</option>`).join('');
  }

  function bodySchema(operation: Operation) {
    const content = operation.requestBody?.content || {};
    const type = Object.keys(content).find((key) => key.includes('json')) || Object.keys(content)[0];
    return { type: type || 'application/json', schema: content[type]?.schema };
  }

  function updateRequestURL() {
    if (!state.active) return;
    let path = state.active.path;
    const query = new URLSearchParams();
    $$('#params-panel input').forEach((input) => {
      if (!input.value) return;
      if (input.dataset.in === 'path') path = path.replace(`{${input.dataset.name}}`, encodeURIComponent(input.value));
      if (input.dataset.in === 'query') query.append(input.dataset.name || '', input.value);
    });
    const base = $('#server-select').value.replace(/\/$/, '');
    $('#request-url').value = `${base}${path}${query.toString() ? `?${query}` : ''}`;
    const address = $('#endpoint-full-url');
    if (address) address.innerHTML = `<span class="endpoint-url__prefix">${escapeHTML(base)}</span>${escapeHTML($('#request-url').value.slice(base.length))}`;
  }

  function renderRequestParams(operation: Operation) {
    const panel = $('#params-panel');
    const params = operation.parameters.filter((parameter) => ['path', 'query'].includes(parameter.in));
    $('#param-count').textContent = String(params.length);
    $('#param-count').hidden = params.length === 0;
    panel.innerHTML = ['path', 'query'].map((location) => {
      const fields = params.filter((parameter) => parameter.in === location);
      if (!fields.length) return '';
      const title = location === 'path' ? 'Path parameters' : 'Query parameters';
      return `<div class="request-params-table"><table aria-label="${title}"><colgroup><col class="request-params-name"><col></colgroup><thead><tr><th scope="col">${title}</th><th scope="col">Valor</th></tr></thead><tbody>${fields.map((parameter) => {
        const schema = dereference(parameter.schema) || {};
        const value = schema.example ?? parameter.example ?? schema.default ?? '';
        const id = `param-${slugify(parameter.in + '-' + parameter.name)}`;
        const required = parameter.required || location === 'path';
        return `<tr><th scope="row"><label for="${id}">${escapeHTML(parameter.name)}${required ? '<span class="required" aria-label="obrigatório"> *</span>' : ''}</label><span class="request-param-type">${escapeHTML(schemaType(schema))}</span>${parameter.description ? `<p id="${id}-description">${escapeHTML(parameter.description)}</p>` : ''}</th><td><input id="${id}" data-name="${escapeHTML(parameter.name)}" data-in="${location}" value="${escapeHTML(value)}" placeholder="${escapeHTML(schemaType(schema))}"${required ? ' aria-required="true"' : ''}${parameter.description ? ` aria-describedby="${id}-description"` : ''} /></td></tr>`;
      }).join('')}</tbody></table></div>`;
    }).join('');
    $$('input', panel).forEach((input) => listen(input, 'input', updateRequestURL));
  }

  function setRequestTab(name?: string | null) {
    const target = name ? $(`[data-request-tab="${name}"]`) : null;
    if (name && (!target || target.disabled || target.hidden)) return;
    $$('[data-request-tab]').forEach((button) => {
      const selected = button === target;
      button.classList.toggle('is-active', selected);
      button.setAttribute('aria-selected', String(selected));
      button.tabIndex = selected ? 0 : -1;
    });
    ['params', 'body', 'headers'].forEach((panel) => { $(`#${panel}-panel`).hidden = panel !== name; });
  }

  function validateRequestBody() {
    const input = $('#request-body');
    const body = input.value.trim();
    let message = '';
    if (state.active?.requestBody?.required && !body) message = 'Preencha o body obrigatório antes de enviar.';
    else if (body && ($('#body-panel .editor-header span').textContent || '').includes('json')) {
      try { JSON.parse(body); } catch { message = 'JSON inválido. Confira as aspas, vírgulas e chaves.'; }
    }
    $('#request-body-error').textContent = message;
    input.setAttribute('aria-invalid', String(Boolean(message)));
    return !message;
  }

  function syncBodyEditorScroll() {
    const input = $('#request-body');
    $('#body-editor-highlight').scrollTop = input.scrollTop;
    $('#body-editor-highlight').scrollLeft = input.scrollLeft;
    $('#body-editor-lines').scrollTop = input.scrollTop;
  }

  function updateBodyEditorPosition() {
    const input = $('#request-body');
    const before = input.value.slice(0, input.selectionStart || 0).split('\n');
    $('#body-editor-position').textContent = `Ln ${before.length}, Col ${before[before.length - 1].length + 1}`;
  }

  function updateBodyEditor() {
    const input = $('#request-body');
    const json = ($('#body-panel .editor-header span').textContent || '').includes('json');
    $('#body-editor-code').innerHTML = (json ? highlightJSON(input.value) : escapeHTML(input.value)) + '\n';
    $('#body-editor-lines').innerHTML = input.value.split('\n').map((_, index) => `<span>${index + 1}</span>`).join('');
    const invalid = input.getAttribute('aria-invalid') === 'true';
    $('#body-editor-status').textContent = invalid ? 'Body inválido' : json ? 'JSON' : 'Texto';
    $('#body-editor-status').classList.toggle('is-invalid', invalid);
    updateBodyEditorPosition();
    syncBodyEditorScroll();
  }

  let bodyEditorEscapeTab = false;

  function onBodyEditorInput() {
    $('#request-body-error').textContent = '';
    $('#request-body').setAttribute('aria-invalid', 'false');
    updateBodyEditor();
  }

  function replaceBodySelection(start: number, end: number, text: string, selectionStart = start + text.length, selectionEnd = selectionStart) {
    const input = $('#request-body');
    input.setSelectionRange(start, end);
    // Use the native editing transaction when available so Undo keeps working.
    let inserted = false;
    try { inserted = document.execCommand?.('insertText', false, text) || false; } catch {}
    if (!inserted) input.setRangeText(text, start, end, 'end');
    input.setSelectionRange(selectionStart, selectionEnd);
    onBodyEditorInput();
  }

  function bodyStringContext(value: string, end: number) {
    let inside = false;
    let escaped = false;
    for (let index = 0; index < end; index++) {
      const char = value[index];
      if (escaped) escaped = false;
      else if (inside && char === '\\') escaped = true;
      else if (char === '"') inside = !inside;
    }
    return { inside, escaped };
  }

  function indentBodySelection(outdent: boolean) {
    const input = $('#request-body');
    const { value, selectionStart: start, selectionEnd: end } = input;
    const first = start === 0 ? 0 : value.lastIndexOf('\n', start - 1) + 1;
    const lastPosition = end > start && value[end - 1] === '\n' ? end - 1 : end;
    let last = value.indexOf('\n', lastPosition);
    if (last === -1) last = value.length;
    const edits: { offset: number; removed: number; added: number }[] = [];
    let offset = first;
    const text = value.slice(first, last).split('\n').map((line) => {
      const removed = outdent ? (line.match(/^(?: {1,2}|\t)/)?.[0].length || 0) : 0;
      const added = outdent ? 0 : 2;
      edits.push({ offset, removed, added });
      offset += line.length + 1;
      return ' '.repeat(added) + line.slice(removed);
    }).join('\n');
    const shifted = (position: number) => position + edits.filter((edit) => edit.offset <= position).reduce((delta, edit) => delta + edit.added - Math.min(edit.removed, position - edit.offset), 0);
    replaceBodySelection(first, last, text, shifted(start), shifted(end));
  }

  function handleBodyEditorKeydown(event: KeyboardEvent) {
    if (event.isComposing) return;
    const input = $('#request-body');
    if (event.key === 'Escape') {
      event.preventDefault(); event.stopPropagation(); bodyEditorEscapeTab = true;
      $('#body-editor-help').textContent = 'Pressione Tab para sair do editor';
      return;
    }
    const leaveWithTab = bodyEditorEscapeTab && event.key === 'Tab';
    bodyEditorEscapeTab = false;
    $('#body-editor-help').textContent = 'Tab: recuo · Esc, Tab: sair';
    if (leaveWithTab || event.ctrlKey || event.metaKey) return;
    if (event.altKey && event.shiftKey && (event.code === 'KeyF' || event.key.toLowerCase() === 'f') && !$('#format-json').disabled) {
      event.preventDefault(); formatRequestBody(); return;
    }
    if (event.altKey) return;
    const { value, selectionStart: start, selectionEnd: end } = input;
    const lineStart = start === 0 ? 0 : value.lastIndexOf('\n', start - 1) + 1;
    const prefix = value.slice(lineStart, start);
    if (event.key === 'Tab') {
      event.preventDefault();
      if (event.shiftKey || start !== end) indentBodySelection(event.shiftKey);
      else {
        const column = [...prefix].reduce((count, char) => count + (char === '\t' ? 2 - count % 2 : 1), 0);
        replaceBodySelection(start, end, ' '.repeat(2 - column % 2));
      }
      return;
    }
    const json = ($('#body-panel .editor-header span').textContent || '').includes('json');
    const context = bodyStringContext(value, start);
    const opening: Record<string, string> = { '{': '}', '[': ']', '"': '"' };
    if (event.key === 'Enter') {
      event.preventDefault();
      const indent = (prefix.match(/^[ \t]*/)?.[0] || '');
      const before = prefix.trimEnd().slice(-1);
      const after = value.slice(end).match(/^[ \t]*([}\]])/);
      const extra = json && !context.inside && ['{', '['].includes(before) ? '  ' : '';
      if (extra && after && opening[before] === after[1]) {
        replaceBodySelection(start, end + after[0].length - 1, '\n' + indent + extra + '\n' + indent, start + 1 + indent.length + extra.length);
      } else replaceBodySelection(start, end, '\n' + indent + extra);
      return;
    }
    if (!json) return;
    if (event.key === 'Backspace' && start === end && start > 0) {
      const previous = value[start - 1];
      if (opening[previous] && opening[previous] === value[start] && (previous === '"' || !context.inside) && !context.escaped) {
        event.preventDefault(); replaceBodySelection(start - 1, start + 1, ''); return;
      }
      if (/^ +$/.test(prefix)) {
        event.preventDefault(); replaceBodySelection(start - ((prefix.length - 1) % 2 + 1), start, ''); return;
      }
    }
    if (start === end && ['}', ']', '"'].includes(event.key) && value[start] === event.key && (event.key === '"' ? context.inside && !context.escaped : !context.inside)) {
      event.preventDefault(); input.setSelectionRange(start + 1, start + 1); updateBodyEditorPosition(); return;
    }
    if (opening[event.key] && !context.inside && (start !== end || !value[end] || /[\s}\],:]/.test(value[end]))) {
      event.preventDefault();
      replaceBodySelection(start, end, event.key + value.slice(start, end) + opening[event.key], start + 1, end + 1);
      return;
    }
    if (['}', ']'].includes(event.key) && !context.inside && start === end && /^ {2,}$/.test(prefix)) {
      event.preventDefault(); replaceBodySelection(lineStart, end, prefix.slice(2) + event.key);
    }
  }

  function formatRequestBody() {
    const input = $('#request-body');
    if (validateRequestBody() && input.value.trim()) {
      const caret = input.selectionStart;
      input.value = JSON.stringify(JSON.parse(input.value), null, 2);
      input.setSelectionRange(Math.min(caret, input.value.length), Math.min(caret, input.value.length));
    }
    updateBodyEditor();
    input.focus();
  }

  function renderRequestBody(operation: Operation) {
    const body = bodySchema(operation);
    const hasBody = Boolean(operation.requestBody);
    const hasURLParameters = (operation.parameters || []).some((parameter) => ['path', 'query'].includes(parameter.in));
    $('[data-request-tab="params"]').hidden = !hasURLParameters;
    $('[data-request-tab="params"]').disabled = !hasURLParameters;
    $('[data-request-tab="body"]').hidden = !hasBody;
    $('[data-request-tab="body"]').disabled = !hasBody;
    $('#request-tabs').hidden = !hasBody && !hasURLParameters;
    $('#request-body').value = body.schema ? JSON.stringify(schemaExample(body.schema), null, 2) : '';
    $('#body-panel .editor-header span').textContent = body.type;
    $('#format-json').disabled = !body.type.includes('json');
    $('#request-body-error').textContent = '';
    $('#request-body').setAttribute('aria-invalid', 'false');
    setRequestTab(hasURLParameters ? 'params' : hasBody ? 'body' : null);
    $('#request-body').setSelectionRange(0, 0);
    $('#request-body').scrollTop = 0;
    $('#request-body').scrollLeft = 0;
    updateBodyEditor();
  }

  function exampleResponse(operation: Operation) {
    const success = Object.entries(operation.responses || {}).find(([code]) => /^2/.test(code));
    const response = dereference(success?.[1]);
    const content = response?.content || {};
    const media = content['application/json'] || Object.values(content)[0] as NonNullable<DynamicSchema> | undefined;
    if (media?.example !== undefined) return media.example;
    const example = Object.values(media?.examples || {}).map(item => dereference(item)).find(item => item?.value !== undefined);
    if (example) return example.value;
    return media?.schema ? schemaExample(media.schema) : null;
  }

  function highlightRequestCode(text: string) {
    const tokens = /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\/\/[^\n]*|#[^\n]*|\b(?:async|await|const|let|function|return|import|from|package|func|defer|if|throw|new|true|false|null|nil|curl|http|wget)\b|--[\w-]+|\b\d+(?:\.\d+)?\b/g;
    let html = '';
    let cursor = 0;
    for (const match of text.matchAll(tokens)) {
      const token = match[0];
      const kind = /^["']/.test(token) ? 'json-string' : /^(\/\/|#)/.test(token) ? 'snippet-comment' : 'json-number';
      html += escapeHTML(text.slice(cursor, match.index)) + '<span class="' + kind + '">' + escapeHTML(token) + '</span>';
      cursor = match.index + token.length;
    }
    return html + escapeHTML(text.slice(cursor));
  }

  function requestExampleData(operation: Operation) {
    const { type, schema } = bodySchema(operation);
    const active = state.active?.id === operation.id;
    const base = ($('#server-select').value || state.spec.servers?.[0]?.url || window.location.origin).replace(/\/+$/, '');
    const exampleValue = (parameter: Partial<APIParameter>) => dereference(parameter.schema)?.example ?? parameter.example ?? dereference(parameter.schema)?.default;
    const path = operation.path.replace(/\{([^}]+)\}/g, (_, name) => encodeURIComponent(exampleValue(operation.parameters.find((parameter) => parameter.in === 'path' && parameter.name === name) || {}) ?? '1'));
    const query = new URLSearchParams();
    operation.parameters.filter((parameter) => parameter.in === 'query').forEach((parameter) => {
      const value = exampleValue(parameter);
      if (value !== undefined && value !== '') query.append(parameter.name, String(value));
    });
    const url = active && $('#request-url').value ? $('#request-url').value : base + path + (query.size ? '?' + query.toString() : '');
    let body: string | null = null;
    if (!['get', 'head'].includes(operation.method) && operation.requestBody) {
      if (active) body = $('#request-body').value || null;
      else if (schema) body = JSON.stringify(schemaExample(schema), null, 2) ?? null;
    }
    const headers = headersFromUI();
    if (!Object.keys(headers).some((name) => name.toLowerCase() === 'accept')) headers.Accept = 'application/json';
    if (body !== null && !Object.keys(headers).some((name) => name.toLowerCase() === 'content-type')) headers['Content-Type'] = type;
    return { method: methodLabel(operation.method), url, headers, body };
  }

  function renderRequestSnippet(operation: Operation) {
    const language = snippetLanguages.find((item) => item.id === requestExampleLanguage) || snippetLanguages[0];
    const code = generateSnippet(language.id, requestExampleData(operation));
    $('#curl-example').innerHTML = highlightRequestCode(code);
    $('#curl-example').parentElement!.setAttribute('aria-label', 'Exemplo em ' + language.label);
    const label = 'Copiar ' + language.label;
    $('[data-copy-example="curl"]').setAttribute('aria-label', label);
    $('#tooltip-example-curl').textContent = label;
  }

  function initRequestLanguageSelector() {
    const groups = new Map<string, SnippetLanguage[]>();
    snippetLanguages.forEach((language) => {
      if (!groups.has(language.group)) groups.set(language.group, []);
      groups.get(language.group)!.push(language);
    });
    $('#example-language').innerHTML = [...groups].map(([group, languages]) => '<optgroup label="' + escapeHTML(group) + '">' + languages.map((language) => '<option value="' + language.id + '">' + escapeHTML(language.label) + '</option>').join('') + '</optgroup>').join('');
    try {
      const saved = localStorage.getItem('facet-example-language');
      if (snippetLanguages.some((language) => language.id === saved)) requestExampleLanguage = saved!;
    } catch {}
    $('#example-language').value = requestExampleLanguage;
  }

  function renderExamples(operation: Operation) {
    const body = bodySchema(operation);
    const payload = body.schema ? schemaExample(body.schema) : null;
    $('#example-method').className = methodClass(operation.method);
    $('#example-method').textContent = methodLabel(operation.method);
    $('#example-path').textContent = operation.path;
    renderRequestSnippet(operation);
    $('#request-example').innerHTML = highlightJSON(payload ? JSON.stringify(payload, null, 2) : JSON.stringify({ parameters: Object.fromEntries(operation.parameters.map((item) => [item.name, item.schema?.example ?? item.schema?.default ?? 'string'])) }, null, 2));
    const responseExample = exampleResponse(operation);
    $('#response-example').innerHTML = responseExample === null ? 'Nenhum exemplo de resposta definido na especificação.' : highlightJSON(JSON.stringify(responseExample, null, 2));
    const success = Object.keys(operation.responses || {}).find((code) => /^2/.test(code));
    $('#response-example-status').textContent = success || '';
    $('#response-example-status').hidden = !success;
    $('#request-example-card').hidden = !payload && !operation.parameters.length;
  }

  function setConsoleMode(mode?: string) {
    const enteringExplorer = mode === 'explorer' && !requestSettingsInitialized;
    $('#examples-panel').hidden = mode !== 'examples';
    $('#explorer-panel').hidden = mode !== 'explorer';
    $$('[data-console-mode]').forEach((button) => {
      const selected = button.dataset.consoleMode === mode;
      button.classList.toggle('is-active', selected);
      button.setAttribute('aria-selected', String(selected));
      button.tabIndex = selected ? 0 : -1;
    });
    if (enteringExplorer) populateRequestSettings();
    if (mode === 'examples' && state.active) renderExamples(state.active);
  }

  function selectOperation(id?: string, openConsole = false, updateURL = true) {
    const operation = state.operations.find((item) => item.id === id);
    if (!operation) return;
    document.body.classList.remove('docs-content-page');
    $$('.nav-schema-link').forEach(link => { link.classList.remove('is-active'); link.removeAttribute('aria-current'); });
    resetRequestResponse();
    state.active = operation;
    if (updateURL) history.replaceState(null, '', `#${operation.id}`);
    $$('[data-guide]').forEach((link) => link.classList.remove('is-active'));
    renderReference(operation);
    $$('.nav-link').forEach((link) => link.classList.toggle('is-active', link.dataset.operationId === id));
    const activeLink = $(`.nav-link[data-operation-id="${id}"]`);
    if (activeLink) {
      activeLink.closest<HTMLDetailsElement>('.nav-group')!.open = true;
    }
    $('.nav-overview')?.classList.remove('is-active');
    const method = $('#request-method');
    method.className = methodClass(operation.method);
    method.textContent = methodLabel(operation.method);
    renderRequestParams(operation);
    renderRequestBody(operation);
    updateRequestURL();
    renderExamples(operation);
    if (openConsole) {
      setConsoleMode('explorer');
      if (matchMedia('(max-width: 980px)').matches) document.body.classList.add('console-open');
    }
  }

  function loadSpec(spec: OpenAPISpec, sourceName = 'openapi') {
    if (lifecycle.signal.aborted) return;
    clearRequestCredentials();
    credentialOrigin = null;
    state.spec = spec;
    requestSettingsInitialized = false;
    state.sourceName = sourceName;
    state.operations = collectOperations(spec);
    $('#openapi-version').textContent = spec.openapi;
    renderNavigation();
    renderServers();
    updateCredentialOrigin(new URL($('#server-select').value, window.location.origin).origin);
    bindDynamicEvents();
    const initialHash = window.location.hash.slice(1);
    const guideSlug = initialHash.startsWith('guide-') ? initialHash.slice(6) : '';
    const initialOperation = state.operations.find(operation => operation.id === initialHash) || state.operations.find((operation) => operation.requestBody) || state.operations[0];
    if (initialOperation) selectOperation(initialOperation.id, false, false);
    if (initialHash.startsWith('schema-')) selectSchema(schemaNameFromHash(initialHash));
    else if (GUIDES.some(page => page.slug === guideSlug)) selectGuide(guideSlug);
    else if (!initialOperation && GUIDES.length) selectGuide(GUIDES[0].slug);
    else if (!initialOperation && Object.keys(spec.components?.schemas || {}).length) selectSchema(Object.keys(spec.components!.schemas!)[0]);
    if (!$('#explorer-panel').hidden) populateRequestSettings();
  }

  function bindDynamicEvents() {
    $$('[data-schema-name]').forEach(link => listen(link, 'click', event => { event.preventDefault(); selectSchema(link.dataset.schemaName); }));
    $$('[data-guide]').forEach((link) => listen(link, 'click', (event) => { event.preventDefault(); selectGuide(link.dataset.guide); }));
    $$('.nav-link').forEach((link) => listen(link, 'click', (event) => { event.preventDefault(); selectOperation(link.dataset.operationId); }));
    listen($('.nav-overview'), 'click', () => {
      $$('.nav-link').forEach((link) => link.classList.remove('is-active'));
      $('.nav-overview').classList.add('is-active');
    });
    listen($('#sidebar-search'), 'click', openSearch);
  }

  function openSearch() {
    $('#search-input').value = '';
    renderSearch();
    $('#search-dialog').showModal();
    schedule(() => $('#search-input').focus(), 20);
  }

  function headersFromUI() {
    const headers: Record<string, string> = {};
    $$('#header-list .header-row').forEach((row) => {
      const [name, value] = $$('input', row).map((input) => input.value.trim());
      if (name && value) headers[name] = value;
    });
    const token = $('#auth-token').value.trim();
    if (token) {
      Object.keys(headers).filter((name) => name.toLowerCase() === 'authorization').forEach((name) => delete headers[name]);
      headers.Authorization = `Bearer ${token}`;
    }
    return headers;
  }

  function clearRequestCredentials() {
    $('#auth-token').value = '';
    $('#connection-token').value = '';
    $('#connection-auth-mode').value = 'bearer';
    for (const container of [$('#header-list'), $('#connection-headers')]) {
      container.replaceChildren();
      addHeaderRow('Accept', 'application/json', container);
    }
    updateConnectionAuthMode();
  }

  function updateCredentialOrigin(origin: string) {
    if (credentialOrigin !== null && credentialOrigin !== origin) clearRequestCredentials();
    credentialOrigin = origin;
  }

  function explorerURL(value: string) {
    const url = new URL(value, window.location.origin);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
      throw new Error('Use uma URL HTTP ou HTTPS sem credenciais na URL.');
    }
    if (url.origin === window.location.origin) {
      let path = url.pathname;
      // Decode before normalizing so encoded slashes, backslashes and dot segments
      // cannot disguise a portal route as an API endpoint.
      for (let count = 0; count < 10; count++) {
        const decoded = decodeURIComponent(path);
        if (decoded === path) break;
        path = decoded;
        if (count === 9) throw new Error('A URL possui codificação inválida.');
      }
      path = new URL('/' + path.replace(/\\/g, '/').replace(/^\/+/, ''), window.location.origin).pathname.replace(/\/{2,}/g, '/');
      if (/^\/(?:api|admin|login|invite|docs|docs-assets)(?:\/|$)/i.test(path) || path === '/') {
        throw new Error('O API Explorer não pode acessar as rotas internas deste portal. Use o servidor da sua API.');
      }
    }
    return url;
  }

  let activeRequestController: AbortController | null = null;

  function resetRequestResponse() {
    activeRequestController?.abort();
    activeRequestController = null;
    $('#response-panel').hidden = true;
    $('#response-result').hidden = true;
    $('#response-network-error').hidden = true;
    $('#response-network-detail').textContent = '';
    $('#response-code').textContent = '';
    $('#response-meta').textContent = '';
    $('#response-type').textContent = '';
    $('#response-panel').setAttribute('aria-busy', 'false');
    const button = $('#send-request');
    button.classList.remove('is-loading');
    button.setAttribute('aria-busy', 'false');
    $('span', button).textContent = 'Enviar request';
    button.disabled = false;
  }

  async function sendRequest() {
    if (!state.active) return;
    if ($('#connection-error').textContent) {
      setConsoleMode('explorer');
      if (matchMedia('(max-width: 980px)').matches) document.body.classList.add('console-open');
      $('#connection-error').focus();
      return;
    }
    if (state.active.requestBody && !validateRequestBody()) {
      updateBodyEditor();
      setConsoleMode('explorer');
      setRequestTab('body');
      if (matchMedia('(max-width: 980px)').matches) document.body.classList.add('console-open');
      $('#request-body').focus();
      return;
    }
    const button = $('#send-request');
    if (button.disabled) return;
    const controller = new AbortController();
    activeRequestController = controller;
    button.classList.add('is-loading');
    button.setAttribute('aria-busy', 'true');
    $('span', button).textContent = 'Enviando…';
    $('#response-panel').setAttribute('aria-busy', 'true');
    $('#response-panel').hidden = false;
    $('#response-result').hidden = true;
    $('#response-network-error').hidden = true;
    $('#response-network-error details').removeAttribute('open');
    $('#response-meta').textContent = 'Enviando…';
    button.disabled = true;
    const started = performance.now();
    try {
      const url = explorerURL($('#request-url').value);
      updateCredentialOrigin(url.origin);
      const headers = headersFromUI();
      const options: RequestInit = { method: methodLabel(state.active.method), headers, signal: controller.signal, credentials: 'omit', redirect: 'error' };
      if (!['get', 'head'].includes(state.active.method) && state.active.requestBody) {
        const body = $('#request-body').value.trim();
        if (body) {
          if (($('#body-panel .editor-header span').textContent || '').includes('json')) JSON.parse(body);
          options.body = body;
          if (!headers['Content-Type']) headers['Content-Type'] = $('#body-panel .editor-header span').textContent || 'application/json';
        }
      }
      const response = await fetch(url.href, options);
      const elapsed = Math.round(performance.now() - started);
      const text = await response.text();
      if (activeRequestController !== controller) return;
      let formatted = text;
      let isJSON = false;
      try { formatted = JSON.stringify(JSON.parse(text), null, 2); isJSON = true; } catch {}
      const size = new Blob([text]).size;
      $('#response-result').hidden = false;
      $('#response-panel').hidden = false;
      if (isJSON) $('#response-code').innerHTML = highlightJSON(formatted);
      else $('#response-code').textContent = formatted || '(sem conteúdo)';
      $('#response-type').textContent = response.headers.get('content-type')?.split(';')[0] || 'text/plain';
      $('#response-meta').innerHTML = `<span class="status-code" style="color:${response.ok ? 'var(--green)' : 'var(--red)'}">${response.status} ${escapeHTML(response.statusText || '')}</span><span>${elapsed} ms</span><span>${formatBytes(size)}</span>`;
    } catch (error) {
      if (activeRequestController !== controller) return;
      const elapsed = Math.round(performance.now() - started);
      $('#response-panel').hidden = false;
      $('#response-result').hidden = true;
      $('#response-network-error').hidden = false;
      $('#response-type').textContent = '';
      $('#response-code').textContent = '';
      $('#response-network-detail').textContent = error instanceof Error ? error.message : 'Erro inesperado';
      $('#response-meta').innerHTML = `<span class="status-code status-code--unavailable">Sem resposta</span><span>${elapsed} ms</span>`;
    } finally {
      if (activeRequestController === controller) {
        activeRequestController = null;
        button.classList.remove('is-loading');
        button.setAttribute('aria-busy', 'false');
        $('span', button).textContent = 'Enviar request';
        $('#response-panel').setAttribute('aria-busy', 'false');
        button.disabled = false;
      }
    }
  }

  function formatBytes(bytes: number) {
    if (bytes < 1024) return `${bytes} B`;
    return `${(bytes / 1024).toFixed(1)} KB`;
  }

  function addHeaderRow(name = '', value = '', container = $('#header-list')) {
    const row = document.createElement('div');
    row.className = 'header-row';
    row.innerHTML = `<input class="header-input" placeholder="Nome" value="${escapeHTML(name)}" aria-label="Nome do header" /><input class="header-input" placeholder="Valor" value="${escapeHTML(value)}" aria-label="Valor do header" /><button type="button" aria-label="Remover header">×</button>`;
    listen($('button', row), 'click', () => {
      row.remove();
      if (container.id === 'connection-headers') syncRequestSettings();
    });
    container.append(row);
  }

  function renderSearch(query = '') {
    const normalized = query.trim().toLowerCase();
    const results = state.operations.filter((operation) => !normalized || `${operation.summary} ${operation.path} ${operation.tag} ${operation.method}`.toLowerCase().includes(normalized));
    const groups = new Map<string, Operation[]>();
    results.forEach((operation) => {
      if (!groups.has(operation.tag)) groups.set(operation.tag, []);
      groups.get(operation.tag)!.push(operation);
    });
    const guides = GUIDES.filter((guide) => {
      const text = document.createElement('div');
      text.innerHTML = guideContent(guide.slug);
      return !normalized || `Guides ${guide.title} ${text.textContent}`.toLowerCase().includes(normalized);
    });
    const guideResults = guides.length ? `<section class="search-group" aria-labelledby="search-guides-title"><h3 id="search-guides-title"><i data-lucide="folder" aria-hidden="true"></i>Guides<span>${guides.length}</span></h3>${guides.map((guide) => `<button class="search-result search-result--guide" type="button" data-search-guide="${guide.slug}"><div class="search-result-copy"><strong>${escapeHTML(guide.title)}</strong><small>Guide</small></div></button>`).join('')}</section>` : '';
    const operationResults = results.length ? [...groups].map(([tag, operations], index) => `
      <section class="search-group" aria-labelledby="search-group-${index}">
        <h3 id="search-group-${index}"><i data-lucide="folder" aria-hidden="true"></i>${escapeHTML(tag)}<span>${operations.length}</span></h3>
        ${operations.map((operation) => `<button class="search-result" type="button" data-search-id="${operation.id}"><span class="nav-link__method" data-method="${operation.method}">${methodLabel(operation.method)}</span><div class="search-result-copy"><strong>${escapeHTML(operation.summary)}</strong><small class="search-result-path">${escapeHTML(operation.path)}</small></div></button>`).join('')}
      </section>`).join('') : '';
    const schemaNames = Object.keys(state.spec.components?.schemas || {}).filter(name => !normalized || `Schemas ${name}`.toLowerCase().includes(normalized));
    const schemaResults = schemaNames.length ? `<section class="search-group"><h3><i data-lucide="braces" aria-hidden="true"></i>Schemas<span>${schemaNames.length}</span></h3>${schemaNames.map(name => `<button class="search-result" type="button" data-search-schema="${escapeHTML(name)}"><div class="search-result-copy"><strong>${escapeHTML(name)}</strong><small>Schema</small></div></button>`).join('')}</section>` : '';
    $('#search-results').innerHTML = guideResults + schemaResults + operationResults || '<div class="search-empty"><strong>Nenhum resultado encontrado</strong><p>Tente outro guia, grupo, nome, caminho ou método HTTP.</p></div>';
    $$('[data-search-schema]').forEach(button => listen(button, 'click', () => { $('#search-dialog').close(); selectSchema(button.dataset.searchSchema); }));
    $$('[data-search-guide]').forEach((button) => listen(button, 'click', () => {
      $('#search-dialog').close();
      selectGuide(button.dataset.searchGuide);
    }));
    createIcons({ icons, attrs: { 'aria-hidden': 'true' } });
    $$('[data-search-id]').forEach((button) => listen(button, 'click', () => {
      $('#search-dialog').close();
      selectOperation(button.dataset.searchId);
      document.getElementById(button.dataset.searchId || '')?.scrollIntoView({ behavior: 'smooth' });
    }));
  }

  function setImportMode(mode?: string) {
    state.importMode = mode || 'url';
    $$('[data-import-tab]').forEach((button) => button.classList.toggle('is-active', button.dataset.importTab === mode));
    $$('[data-import-panel]').forEach((panel) => panel.hidden = panel.dataset.importPanel !== mode);
    $('#import-error').textContent = '';
  }

  async function importSpec() {
    const errorNode = $('#import-error');
    const button = $('#load-spec');
    errorNode.textContent = '';
    button.disabled = true;
    button.textContent = 'Carregando…';
    try {
      let source = '';
      let sourceName = 'openapi';
      if (state.importMode === 'url') {
        const url = $('#spec-url').value.trim();
        if (!url) throw new Error('Informe uma URL.');
        const response = await fetch(url, { signal: lifecycle.signal });
        if (!response.ok) throw new Error(`Não foi possível carregar a URL (${response.status}).`);
        source = await response.text();
        sourceName = url.split('/').pop() || 'openapi';
      } else if (state.importMode === 'file') {
        const file = $('#spec-file').files?.[0];
        if (!file) throw new Error('Selecione um arquivo.');
        source = await file.text();
        sourceName = file.name;
      } else {
        source = $('#spec-paste').value;
        sourceName = 'openapi-pasted';
      }
      loadSpec(parseSpec(source), sourceName);
      if (lifecycle.signal.aborted) return;
      $('#import-dialog').close();
      toast('Documentação gerada');
    } catch (error) {
      if (lifecycle.signal.aborted) return;
      errorNode.textContent = (error instanceof Error ? error.message : 'Erro inesperado') || 'Não foi possível ler a especificação.';
    } finally {
      button.disabled = false;
      button.textContent = 'Carregar documentação';
    }
  }

  function downloadSpec() {
    const blob = new Blob([JSON.stringify(state.spec, null, 2)], { type: 'application/json' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = state.sourceName.endsWith('.json') ? state.sourceName : 'openapi.json';
    link.click();
    URL.revokeObjectURL(link.href);
  }

  function updateConnectionAuthMode() {
    const bearer = $('#connection-auth-mode').value === 'bearer';
    $('#connection-bearer-row').hidden = !bearer;
    $('#connection-token').disabled = !bearer;
    $('#connection-auth-note').hidden = bearer;
  }

  function renderServerOptions() {
    const selected = $('#server-select').value;
    $('#connection-servers').innerHTML = [...$('#server-select').options].map((option) => {
      const server = state.spec.servers?.find((item) => item.url === option.value);
      return `<button type="button" role="menuitemradio" aria-checked="${option.value === selected}" tabindex="-1" data-server-url="${escapeHTML(option.value)}"><span>${escapeHTML(server?.description || (server ? 'Servidor' : 'Personalizado'))}</span><code>${escapeHTML(option.value)}</code></button>`;
    }).join('');
  }

  function toggleServerMenu(open: boolean) {
    $('#connection-servers').hidden = !open;
    $('#server-picker-toggle').setAttribute('aria-expanded', String(open));
    if (open) {
      renderServerOptions();
      const selected = $('[aria-checked="true"]', $('#connection-servers')) || $('button', $('#connection-servers'));
      selected?.focus();
    }
  }

  function populateRequestSettings() {
    $('#connection-base-url').value = $('#server-select').value;
    $('#connection-token').value = $('#auth-token').value;
    $('#connection-auth-mode').value = $('#auth-token').value || !Object.keys(headersFromUI()).some((name) => name.toLowerCase() === 'authorization') ? 'bearer' : 'headers';
    const requirements = state.active?.security ?? state.spec.security ?? [];
    $('#connection-auth-status').textContent = requirements.length && !requirements.some((item) => !Object.keys(item).length) ? 'Obrigatória' : 'Opcional';
    updateConnectionAuthMode();
    $('#connection-token').type = 'password';
    $('#connection-toggle-token').setAttribute('aria-pressed', 'false');
    $('#connection-toggle-token').setAttribute('aria-label', 'Mostrar token');
    $('#connection-error').textContent = '';
    $('#connection-headers').replaceChildren();
    $$('#header-list .header-row').forEach((row) => {
      const [name, value] = $$('input', row).map((input) => input.value);
      addHeaderRow(name, value, $('#connection-headers'));
    });
    toggleServerMenu(false);
    renderServerOptions();
    requestSettingsInitialized = true;
  }

  function syncRequestSettings(event?: Event) {
    event?.preventDefault();
    const error = $('#connection-error');
    error.textContent = '';
    try {
      const baseURL = new URL($('#connection-base-url').value.trim());
      if (!['http:', 'https:'].includes(baseURL.protocol) || baseURL.username || baseURL.password || baseURL.search || baseURL.hash) throw new Error('Use uma base URL HTTP ou HTTPS, sem credenciais, query parameters ou fragmentos.');
      const base = baseURL.href.replace(/\/+$/, '');
      const select = $('#server-select');
      const baseChanged = base !== select.value.replace(/\/+$/, '');
      updateCredentialOrigin(baseChanged ? baseURL.origin : new URL($('#request-url').value, window.location.origin).origin);
      const headers = $$('#connection-headers .header-row').map((row) => $$('input', row).map((input) => input.value.trim())).filter(([name, value]) => name || value);
      for (const [name, value] of headers) {
        if (!name) throw new Error('Informe o nome de cada header.');
        try { new Headers([[name, value]]); } catch { throw new Error(`Header inválido: ${name}`); }
      }
      let option = [...select.options].find((item) => item.value === base || item.value.replace(/\/+$/, '') === base);
      if (!option) {
        option = [...select.options].find((item) => item.dataset.customServer === 'true');
        if (!option) {
          option = document.createElement('option');
          option.dataset.customServer = 'true';
          select.append(option);
        }
        option.value = base;
        option.textContent = `Custom server · ${base}`;
      }
      select.value = option.value;
      $('#auth-token').value = $('#connection-auth-mode').value === 'bearer' ? $('#connection-token').value.trim().replace(/^Bearer\s+/i, '') : '';
      $('#header-list').replaceChildren();
      headers.forEach(([name, value]) => addHeaderRow(name, value));
      if (baseChanged) updateRequestURL();
      if (state.active) renderExamples(state.active);
      return true;
    } catch (failure) {
      error.textContent = failure instanceof TypeError ? 'Informe uma base URL válida, como https://api.exemplo.com/v1.' : (failure instanceof Error ? failure.message : 'Configuração inválida.');
      return false;
    }
  }

  function bindStaticEvents() {
    listen($('#example-language'), 'change', (event) => {
      requestExampleLanguage = (event.target as HTMLInputElement).value;
      try { localStorage.setItem('facet-example-language', requestExampleLanguage); } catch {}
      if (state.active) renderRequestSnippet(state.active);
    });
    listen($('#server-picker-toggle'), 'click', () => toggleServerMenu(Boolean($('#connection-servers').hidden)));
    listen($('#connection-servers'), 'click', (event) => {
      const option = (event.target as Element).closest<HTMLElement>('[data-server-url]');
      if (!option) return;
      $('#connection-base-url').value = option.dataset.serverUrl || '';
      syncRequestSettings();
      toggleServerMenu(false);
      $('#connection-base-url').focus();
    });
    listen($('#server-picker'), 'keydown', (event) => {
      const menu = $('#connection-servers');
      if (event.key === 'Escape' && !menu.hidden) {
        event.preventDefault(); event.stopPropagation(); toggleServerMenu(false); $('#server-picker-toggle').focus(); return;
      }
      if (event.key === 'ArrowDown' && menu.hidden) { event.preventDefault(); toggleServerMenu(true); return; }
      if (menu.hidden || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const choices = $$('[data-server-url]', menu);
      if (!choices.length) return;
      const index = choices.indexOf(document.activeElement as UIElement);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? choices.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + choices.length) % choices.length;
      choices[next].focus();
    });
    listen($('#server-picker'), 'focusout', (event) => { if (!(event.currentTarget as Element).contains((event as FocusEvent).relatedTarget as Node | null)) toggleServerMenu(false); });
    listen(document, 'pointerdown', (event) => { if (!(event.target as Element).closest('#server-picker')) toggleServerMenu(false); });
    listen($('#connection-form'), 'submit', syncRequestSettings);
    listen($('#connection-form'), 'input', () => syncRequestSettings());
    listen($('#connection-auth-mode'), 'change', () => { updateConnectionAuthMode(); syncRequestSettings(); });
    listen($('#connection-clear-token'), 'click', () => { $('#connection-token').value = ''; syncRequestSettings(); $('#connection-token').focus(); });
    listen($('#connection-add-header'), 'click', () => addHeaderRow('', '', $('#connection-headers')));
    listen($('#connection-toggle-token'), 'click', () => {
      const input = $('#connection-token');
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      $('#connection-toggle-token').setAttribute('aria-pressed', String(show));
      $('#connection-toggle-token').setAttribute('aria-label', show ? 'Ocultar token' : 'Mostrar token');
    });
    listen($('#open-import-secondary'), 'click', () => $('#import-dialog').showModal());
    listen($('#download-spec'), 'click', downloadSpec);
    const requestTabs = $$('[data-request-tab]');
    requestTabs.forEach((tab) => {
      listen(tab, 'click', () => setRequestTab(tab.dataset.requestTab));
      listen(tab, 'keydown', (event) => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const available = requestTabs.filter((button) => !button.disabled && !button.hidden);
        if (!available.length) return;
        const index = available.indexOf(tab);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? available.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + available.length) % available.length;
        setRequestTab(available[next].dataset.requestTab);
        available[next].focus();
      });
    });
    listen($('#request-body'), 'input', onBodyEditorInput);
    listen($('#request-body'), 'keydown', handleBodyEditorKeydown);
    listen($('#request-body'), 'blur', () => {
      bodyEditorEscapeTab = false;
      $('#body-editor-help').textContent = 'Tab: recuo · Esc, Tab: sair';
    });
    listen($('#request-body'), 'scroll', syncBodyEditorScroll);
    ['click', 'keyup', 'select', 'focus'].forEach((name) => listen($('#request-body'), name, updateBodyEditorPosition));
    listen($('#copy-request-body'), 'click', () => copyText($('#request-body').value, 'Body copiado'));
    listen($('#server-select'), 'change', () => {
      updateCredentialOrigin(new URL($('#server-select').value, window.location.origin).origin);
      updateRequestURL();
      if (state.active) renderExamples(state.active);
    });
    listen($('#copy-url'), 'click', () => copyText($('#request-url').value, 'URL copiada'));
    listen($('#request-url'), 'input', () => {
      try {
        const url = new URL($('#request-url').value, window.location.origin);
        updateCredentialOrigin(url.origin);
        const select = $('#server-select');
        if (url.origin !== new URL(select.value, window.location.origin).origin) {
          let option = [...select.options].find(item => item.value === url.origin);
          if (!option) {
            option = document.createElement('option');
            option.value = url.origin;
            option.textContent = `Custom server · ${url.origin}`;
            select.append(option);
          }
          select.value = option.value;
          $('#connection-base-url').value = option.value;
        }
      } catch {}
      if (state.active) renderRequestSnippet(state.active);
    });
    listen($('#toggle-token'), 'click', () => {
      const input = $('#auth-token');
      input.type = input.type === 'password' ? 'text' : 'password';
    });
    listen($('#format-json'), 'click', formatRequestBody);
    listen($('#add-header'), 'click', () => addHeaderRow());
    listen($('#send-request'), 'click', sendRequest);
    listen($('#copy-response'), 'click', () => copyText($('#response-code').textContent, 'Response copiada'));
    listen($('#mobile-console-toggle'), 'click', () => document.body.classList.toggle('console-open'));
    listen($('#close-console'), 'click', () => document.body.classList.remove('console-open'));
    $$('[data-import-tab]').forEach((button) => listen(button, 'click', () => setImportMode(button.dataset.importTab)));
    listen($('#load-spec'), 'click', importSpec);
    const consoleTabs = $$('[data-console-mode]');
    consoleTabs.forEach((button, index) => {
      listen(button, 'click', () => setConsoleMode(button.dataset.consoleMode));
      listen(button, 'keydown', (event) => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? consoleTabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + consoleTabs.length) % consoleTabs.length;
        setConsoleMode(consoleTabs[next].dataset.consoleMode);
        consoleTabs[next].focus();
      });
    });
    $$('[data-copy-example]').forEach((button) => listen(button, 'click', () => {
      const target = button.dataset.copyExample === 'curl' ? '#curl-example' : button.dataset.copyExample === 'request' ? '#request-example' : '#response-example';
      copyText($(target).textContent, 'Example copied');
    }));
    listen($('#theme-toggle'), 'click', () => {
      const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
      document.documentElement.dataset.theme = next;
      localStorage.setItem('facet-theme', next);
      $('#theme-toggle').setAttribute('aria-label', next === 'dark' ? 'Ativar light mode' : 'Ativar dark mode');
    });
    listen($('#search-input'), 'input', (event) => renderSearch((event.target as HTMLInputElement).value));
    listen($('#search-close'), 'click', () => $('#search-dialog').close());
    $$('.modal').forEach((dialog) => {
      let startedOutside = false;
      listen(dialog, 'pointerdown', (event) => {
        startedOutside = !(event.target as Element).closest('.modal__card');
      });
      listen(dialog, 'click', (event) => {
        if (startedOutside && !(event.target as Element).closest('.modal__card')) dialog.close();
        startedOutside = false;
      });
      listen(dialog, 'pointercancel', () => { startedOutside = false; });
    });
    listen($('#search-dialog'), 'keydown', (event) => {
      const buttons = $$('.search-result', $('#search-results'));
      const index = buttons.indexOf(document.activeElement as UIElement);
      if (['ArrowDown', 'ArrowUp'].includes(event.key) && buttons.length) {
        event.preventDefault();
        const next = index < 0 ? (event.key === 'ArrowDown' ? 0 : buttons.length - 1) : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
        buttons[next].focus();
      }
      if (event.key === 'Enter' && event.target === $('#search-input') && buttons.length) { event.preventDefault(); buttons[0].click(); }
    });
    listen($('#spec-file'), 'change', () => { const file = $('#spec-file').files?.[0]; if (file) $('.dropzone strong').textContent = file.name; });
    const dropzone = $('#dropzone');
    ['dragenter', 'dragover'].forEach((event) => listen(dropzone, event, (e) => { e.preventDefault(); dropzone.classList.add('is-dragging'); }));
    ['dragleave', 'drop'].forEach((event) => listen(dropzone, event, (e) => { e.preventDefault(); dropzone.classList.remove('is-dragging'); }));
    listen(dropzone, 'drop', (event) => { $('#spec-file').files = event.dataTransfer!.files; const file = event.dataTransfer!.files?.[0]; if (file) $('.dropzone strong').textContent = file.name; });
    listen(document, 'keydown', (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); if (!$('#search-dialog').open) openSearch(); }
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') { event.preventDefault(); sendRequest(); }
      if (event.key === 'Escape' && document.body.classList.contains('console-open')) document.body.classList.remove('console-open');
    });
  }

  function initConsoleResize() {
    const handle = $('#console-resizer');
    const root = document.documentElement;
    const desktop = matchMedia('(min-width: 981px)');
    let preferredWidth = Number(localStorage.getItem('facet-console-width')) || 384;
    let dragging = false;
    const update = (width: number) => {
      const sidebarWidth = $('.sidebar').getBoundingClientRect().width;
      const max = Math.max(300, Math.min(800, innerWidth - sidebarWidth - 360));
      const next = Math.round(Math.max(300, Math.min(max, width)));
      root.style.setProperty('--console-width', `${next}px`);
      handle.setAttribute('aria-valuemin', '300');
      handle.setAttribute('aria-valuemax', String(max));
      handle.setAttribute('aria-valuenow', String(next));
      return next;
    };
    const save = (width: number) => {
      preferredWidth = update(width);
      localStorage.setItem('facet-console-width', String(preferredWidth));
    };
    listen(handle, 'pointerdown', (event) => {
      if (!desktop.matches || event.button !== 0) return;
      event.preventDefault();
      dragging = true;
      handle.setPointerCapture(event.pointerId);
      document.body.classList.add('console-resizing');
    });
    listen(handle, 'pointermove', (event) => {
      if (dragging) update(innerWidth - event.clientX);
    });
    const finish = () => {
      if (!dragging) return;
      dragging = false;
      document.body.classList.remove('console-resizing');
      save($('#console').getBoundingClientRect().width);
    };
    listen(handle, 'pointerup', finish);
    listen(handle, 'pointercancel', finish);
    listen(handle, 'lostpointercapture', finish);
    listen(handle, 'keydown', (event) => {
      if (!desktop.matches || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const current = $('#console').getBoundingClientRect().width;
      save(event.key === 'Home' ? 300 : event.key === 'End' ? 800 : current + (event.key === 'ArrowLeft' ? 20 : -20));
    });
    listen(handle, 'dblclick', () => save(384));
    listen(window, 'resize', () => { if (desktop.matches) update(preferredWidth); });
    update(preferredWidth);
  }

  async function init() {
    const savedTheme = localStorage.getItem('facet-theme');
    document.documentElement.dataset.theme = savedTheme || 'light';
    $('#theme-toggle').setAttribute('aria-label', document.documentElement.dataset.theme === 'dark' ? 'Ativar light mode' : 'Ativar dark mode');
    initRequestLanguageSelector();
    bindStaticEvents();
    listen(window, 'hashchange', () => {
      const hash = window.location.hash.slice(1);
      if (hash.startsWith('schema-')) selectSchema(schemaNameFromHash(hash));
      else if (hash.startsWith('guide-')) selectGuide(hash.slice(6));
      else selectOperation(hash);
    });
    listen($('#reference-content'), 'click', event => {
      const link = (event.target as Element).closest<HTMLElement>('[data-schema-target]');
      if (link) { event.preventDefault(); selectSchema(link.dataset.schemaTarget); }
    });
    initConsoleResize();
    addHeaderRow('Accept', 'application/json');
    try {
      const content = await api.documentationContent(lifecycle.signal);
      GUIDES = content.pages.map(page => ({ ...page, icon: 'book-open' }));
      if (content.openapi) {
        if (!lifecycle.signal.aborted) loadSpec(content.openapi.spec, content.openapi.sourceName);
      } else {
        const response = await fetch('/docs-assets/sample-openapi.json', { signal: lifecycle.signal });
        if (response.status === 401) { window.location.assign('/login'); return; }
        if (!response.ok) throw new Error('Não foi possível carregar a documentação.');
        const spec = parseSpec(await response.text());
        if (!lifecycle.signal.aborted) loadSpec(spec, 'sample-openapi.json');
      }
    } catch (error) {
      if (lifecycle.signal.aborted) return;
      $('#reference-content').innerHTML = '<div class="reference__inner"><p role="alert">' + escapeHTML(error instanceof Error ? error.message : 'Não foi possível carregar a documentação.') + '</p></div>';
    }
  }

  let cleanedUp = false;
  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    signal?.removeEventListener('abort', cleanup);
    lifecycle.abort();
    activeRequestController?.abort();
    activeRequestController = null;
    clearTimeout(toastTimer);
    timers.forEach(clearTimeout);
    document.body.classList.remove('console-open', 'console-resizing', 'docs-content-page');
    document.documentElement.style.removeProperty('--console-width');
  };
  signal?.addEventListener('abort', cleanup, { once: true });
  await init();
  return cleanup;
}
