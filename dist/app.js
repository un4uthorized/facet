(() => {
  'use strict';

  const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'options', 'head'];
  const state = { spec: null, operations: [], active: null, importMode: 'url', sourceName: 'sample-openapi.json' };
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const escapeHTML = (value = '') => String(value).replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#039;', '"': '&quot;' })[char]);
  const slugify = (value = '') => String(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const methodClass = (method) => `method method--${method.toLowerCase()}`;
  const methodLabel = (method) => method.toUpperCase();

  function toast(message, error = false) {
    const element = $('#toast');
    $('span', element).textContent = message;
    element.classList.toggle('is-error', error);
    element.classList.add('is-visible');
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => element.classList.remove('is-visible'), 2400);
  }

  async function copyText(text, message = 'Copiado') {
    try { await navigator.clipboard.writeText(text); toast(message); }
    catch { toast('Não foi possível copiar', true); }
  }

  function resolveRef(ref) {
    if (!ref || !ref.startsWith('#/')) return null;
    return ref.slice(2).split('/').reduce((value, key) => value?.[key.replace(/~1/g, '/').replace(/~0/g, '~')], state.spec);
  }

  function dereference(value) {
    if (!value || typeof value !== 'object') return value;
    return value.$ref ? (resolveRef(value.$ref) || value) : value;
  }

  function schemaExample(rawSchema, depth = 0) {
    const schema = dereference(rawSchema) || {};
    if (schema.example !== undefined) return schema.example;
    if (schema.default !== undefined) return schema.default;
    if (schema.enum?.length) return schema.enum[0];
    if (depth > 4) return null;
    if (schema.type === 'array' || schema.items) return [schemaExample(schema.items || {}, depth + 1)];
    if (schema.type === 'object' || schema.properties) return Object.fromEntries(Object.entries(schema.properties || {}).map(([key, value]) => [key, schemaExample(value, depth + 1)]));
    if (schema.type === 'integer' || schema.type === 'number') return 1;
    if (schema.type === 'boolean') return false;
    if (schema.format === 'date-time') return new Date().toISOString();
    if (schema.format === 'date') return new Date().toISOString().slice(0, 10);
    return 'string';
  }

  function parseSpec(text) {
    const source = String(text || '').trim();
    if (!source) throw new Error('A especificação está vazia.');
    let parsed;
    try { parsed = JSON.parse(source); }
    catch (jsonError) {
      if (!window.jsyaml) throw jsonError;
      parsed = window.jsyaml.load(source);
    }
    if (!parsed || typeof parsed !== 'object' || !parsed.openapi || !parsed.info || !parsed.paths) {
      throw new Error('O arquivo precisa conter openapi, info e paths.');
    }
    return parsed;
  }

  function collectOperations(spec) {
    const operations = [];
    Object.entries(spec.paths || {}).forEach(([path, rawPathItem]) => {
      const pathItem = dereference(rawPathItem) || {};
      HTTP_METHODS.forEach((method) => {
        if (!pathItem[method]) return;
        const operation = dereference(pathItem[method]);
        const parameters = [...(pathItem.parameters || []), ...(operation.parameters || [])].map(dereference);
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

  function tagMetadata(tagName) {
    return state.spec.tags?.find((tag) => tag.name === tagName) || { name: tagName, description: '' };
  }

  function renderNavigation() {
    const grouped = Object.groupBy ? Object.groupBy(state.operations, (op) => op.tag) : state.operations.reduce((acc, op) => ((acc[op.tag] ||= []).push(op), acc), {});
    $('#navigation').innerHTML = `
      <a class="nav-overview is-active" href="#overview"><svg viewBox="0 0 16 16"><path d="M2.5 3.5h11v9h-11zM5.5 3.5v9"/></svg><span>Visão geral</span></a>
      ${Object.entries(grouped).map(([tag, operations]) => `
        <section class="nav-section">
          <div class="nav-section__label"><strong>${escapeHTML(tag)}</strong><span>${operations.length}</span></div>
          ${operations.map((operation) => `<a class="nav-link" href="#${operation.id}" data-operation-id="${operation.id}"><span class="nav-link__method" data-method="${operation.method}">${methodLabel(operation.method)}</span><span class="nav-link__title">${escapeHTML(operation.summary)}</span></a>`).join('')}
        </section>`).join('')}`;
  }

  function renderParameterDocs(parameters) {
    if (!parameters.length) return '';
    return `<div class="detail-block"><div class="detail-block__header"><span>Parâmetros</span><span>${parameters.length}</span></div>${parameters.map((parameter) => {
      const schema = dereference(parameter.schema) || {};
      return `<div class="param-row"><code>${escapeHTML(parameter.name)}${parameter.required ? ' <span class="required">*</span>' : ''}</code><p>${escapeHTML(parameter.description || 'Sem descrição.')}</p><span class="param-row__meta">${escapeHTML(parameter.in || '')} · ${escapeHTML(schema.type || 'any')}</span></div>`;
    }).join('')}</div>`;
  }

  function renderResponseDocs(responses) {
    const entries = Object.entries(responses || {});
    if (!entries.length) return '';
    return `<div class="detail-block"><div class="detail-block__header"><span>Responses</span><span>${entries.length}</span></div>${entries.map(([code, raw]) => {
      const response = dereference(raw) || {};
      return `<div class="response-row"><code>${escapeHTML(code)}</code><span>${escapeHTML(response.description || 'Sem descrição.')}</span></div>`;
    }).join('')}</div>`;
  }

  function renderReference() {
    const info = state.spec.info;
    const server = state.spec.servers?.[0];
    const tagOrder = [...new Set(state.operations.map((operation) => operation.tag))];
    $('#reference').innerHTML = `<div class="reference__inner">
      <section class="hero" id="overview">
        <p class="hero__kicker"><span>API REFERENCE</span><span>·</span><span class="version">${escapeHTML(info.version || '1.0.0')}</span></p>
        <h1>${escapeHTML(info.title || 'API Reference')}</h1>
        <p class="hero__description">${escapeHTML(info.description || 'Documentação interativa gerada a partir da sua especificação OpenAPI.')}</p>
        <div class="hero__meta">
          <div class="meta-item"><span>Base URL</span><strong>${escapeHTML(server?.url || window.location.origin)}</strong></div>
          <div class="meta-item"><span>Formato</span><strong>OpenAPI ${escapeHTML(state.spec.openapi)}</strong></div>
          <div class="meta-item"><span>Endpoints</span><strong>${state.operations.length}</strong></div>
        </div>
      </section>
      ${tagOrder.map((tag, tagIndex) => {
        const metadata = tagMetadata(tag);
        const operations = state.operations.filter((operation) => operation.tag === tag);
        return `<section class="tag-section" id="tag-${slugify(tag)}">
          <header class="tag-section__header"><div><span class="eyebrow">RECURSO</span><h2>${escapeHTML(tag)}</h2><p>${escapeHTML(metadata.description || '')}</p></div><span class="tag-index">${String(tagIndex + 1).padStart(2, '0')}</span></header>
          ${operations.map((operation) => `<article class="operation" id="${operation.id}" data-operation-id="${operation.id}">
            <div class="operation__title-row"><span class="${methodClass(operation.method)}">${methodLabel(operation.method)}</span><code class="operation__path">${escapeHTML(operation.path)}</code></div>
            <h3>${escapeHTML(operation.summary)}</h3>
            <p class="operation__description">${escapeHTML(operation.description || 'Sem descrição para este endpoint.')}</p>
            <div class="operation__actions"><button class="try-button" type="button" data-try-operation="${operation.id}"><svg viewBox="0 0 16 16"><path d="m5 3 8 5-8 5V3Z"/></svg>Testar request</button><button class="icon-button copy-path" type="button" data-copy-path="${escapeHTML(operation.path)}" aria-label="Copiar path" title="Copiar path"><svg viewBox="0 0 16 16"><rect x="5" y="5" width="8" height="8" rx="1.5"/><path d="M11 5V3.8A1.8 1.8 0 0 0 9.2 2H3.8A1.8 1.8 0 0 0 2 3.8v5.4A1.8 1.8 0 0 0 3.8 11H5"/></svg></button></div>
            <div class="operation-details">${renderParameterDocs(operation.parameters)}${renderResponseDocs(operation.responses)}</div>
          </article>`).join('')}
        </section>`;
      }).join('')}
    </div>`;
  }

  function renderServers() {
    const servers = state.spec.servers?.length ? state.spec.servers : [{ url: window.location.origin, description: 'Current origin' }];
    $('#server-select').innerHTML = servers.map((server) => `<option value="${escapeHTML(server.url)}">${escapeHTML(server.description || server.url)} · ${escapeHTML(server.url)}</option>`).join('');
  }

  function bodySchema(operation) {
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
      if (input.dataset.in === 'query') query.append(input.dataset.name, input.value);
    });
    const base = $('#server-select').value.replace(/\/$/, '');
    $('#request-url').value = `${base}${path}${query.toString() ? `?${query}` : ''}`;
  }

  function renderRequestParams(operation) {
    const panel = $('#params-panel');
    const params = operation.parameters.filter((parameter) => ['path', 'query'].includes(parameter.in));
    $('#param-count').textContent = params.length;
    panel.innerHTML = params.length ? params.map((parameter) => {
      const schema = dereference(parameter.schema) || {};
      const value = schema.example ?? parameter.example ?? schema.default ?? '';
      return `<div class="param-input"><label for="param-${slugify(parameter.in + '-' + parameter.name)}">${escapeHTML(parameter.name)}${parameter.required ? '<span class="required"> *</span>' : ''}</label><input id="param-${slugify(parameter.in + '-' + parameter.name)}" data-name="${escapeHTML(parameter.name)}" data-in="${escapeHTML(parameter.in)}" value="${escapeHTML(value)}" placeholder="${escapeHTML(schema.type || 'string')}" /></div>`;
    }).join('') : '<p class="empty-params">Este endpoint não recebe parâmetros.</p>';
    $$('input', panel).forEach((input) => input.addEventListener('input', updateRequestURL));
  }

  function renderRequestBody(operation) {
    const body = bodySchema(operation);
    const hasBody = Boolean(body.schema);
    $('[data-request-tab="body"]').style.opacity = hasBody ? '1' : '.4';
    $('[data-request-tab="body"]').disabled = !hasBody;
    $('#request-body').value = hasBody ? JSON.stringify(schemaExample(body.schema), null, 2) : '';
    $('#body-panel .editor-header span').textContent = body.type;
  }

  function selectOperation(id, openConsole = false) {
    const operation = state.operations.find((item) => item.id === id);
    if (!operation) return;
    state.active = operation;
    $$('.nav-link').forEach((link) => link.classList.toggle('is-active', link.dataset.operationId === id));
    $('.nav-overview')?.classList.remove('is-active');
    const method = $('#request-method');
    method.className = methodClass(operation.method);
    method.textContent = methodLabel(operation.method);
    renderRequestParams(operation);
    renderRequestBody(operation);
    updateRequestURL();
    if (openConsole && matchMedia('(max-width: 900px)').matches) document.body.classList.add('console-open');
  }

  function loadSpec(spec, sourceName = 'openapi') {
    state.spec = spec;
    state.sourceName = sourceName;
    state.operations = collectOperations(spec);
    $('#api-name').textContent = spec.info.title || 'API Reference';
    $('#api-version').textContent = `v${String(spec.info.version || '1.0.0').replace(/^v/, '')}`;
    $('#openapi-version').textContent = spec.openapi;
    document.title = `${spec.info.title || 'API'} — Facet`;
    renderNavigation();
    renderReference();
    renderServers();
    if (state.operations[0]) selectOperation(state.operations[0].id);
    bindDynamicEvents();
  }

  function bindDynamicEvents() {
    $$('[data-try-operation]').forEach((button) => button.addEventListener('click', () => selectOperation(button.dataset.tryOperation, true)));
    $$('[data-copy-path]').forEach((button) => button.addEventListener('click', () => copyText(button.dataset.copyPath, 'Path copiado')));
    $$('.nav-link').forEach((link) => link.addEventListener('click', () => selectOperation(link.dataset.operationId)));
    $('.nav-overview')?.addEventListener('click', () => {
      $$('.nav-link').forEach((link) => link.classList.remove('is-active'));
      $('.nav-overview').classList.add('is-active');
    });
  }

  function headersFromUI() {
    const headers = {};
    $$('#header-list .header-row').forEach((row) => {
      const [name, value] = $$('input', row).map((input) => input.value.trim());
      if (name && value) headers[name] = value;
    });
    const token = $('#auth-token').value.trim();
    if (token) headers.Authorization = `Bearer ${token}`;
    return headers;
  }

  async function sendRequest() {
    if (!state.active) return;
    const button = $('#send-request');
    button.classList.add('is-loading');
    button.disabled = true;
    const started = performance.now();
    try {
      const headers = headersFromUI();
      const options = { method: methodLabel(state.active.method), headers };
      if (!['get', 'head'].includes(state.active.method) && state.active.requestBody) {
        const body = $('#request-body').value.trim();
        if (body) {
          if (($('#body-panel .editor-header span').textContent || '').includes('json')) JSON.parse(body);
          options.body = body;
          if (!headers['Content-Type']) headers['Content-Type'] = $('#body-panel .editor-header span').textContent || 'application/json';
        }
      }
      const response = await fetch($('#request-url').value, options);
      const elapsed = Math.round(performance.now() - started);
      const text = await response.text();
      let formatted = text;
      try { formatted = JSON.stringify(JSON.parse(text), null, 2); } catch {}
      const size = new Blob([text]).size;
      $('#response-empty').hidden = true;
      $('#response-result').hidden = false;
      $('#response-code').textContent = formatted || '(empty response)';
      $('#response-type').textContent = response.headers.get('content-type')?.split(';')[0] || 'text/plain';
      const status = $('.status-code');
      status.textContent = `${response.status} ${response.statusText || ''}`.trim();
      status.style.color = response.ok ? 'var(--green)' : 'var(--red)';
      $('#response-meta').innerHTML = `<span class="status-code" style="color:${response.ok ? 'var(--green)' : 'var(--red)'}">${response.status} ${escapeHTML(response.statusText || '')}</span><span>${elapsed} ms</span><span>${formatBytes(size)}</span>`;
    } catch (error) {
      const elapsed = Math.round(performance.now() - started);
      $('#response-empty').hidden = true;
      $('#response-result').hidden = false;
      $('#response-type').textContent = 'request/error';
      $('#response-code').textContent = `${error.message}\n\nVerifique a URL, o certificado e a política de CORS da API.`;
      $('#response-meta').innerHTML = `<span class="status-code" style="color:var(--red)">FALHOU</span><span>${elapsed} ms</span>`;
      toast('A request falhou', true);
    } finally {
      button.classList.remove('is-loading');
      button.disabled = false;
    }
  }

  function formatBytes(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    return `${(bytes / 1024).toFixed(1)} KB`;
  }

  function addHeaderRow(name = '', value = '') {
    const row = document.createElement('div');
    row.className = 'header-row';
    row.innerHTML = `<input class="header-input" placeholder="Header" value="${escapeHTML(name)}" aria-label="Nome do header" /><input class="header-input" placeholder="Valor" value="${escapeHTML(value)}" aria-label="Valor do header" /><button type="button" aria-label="Remover header">×</button>`;
    $('button', row).addEventListener('click', () => row.remove());
    $('#header-list').append(row);
  }

  function renderSearch(query = '') {
    const normalized = query.trim().toLowerCase();
    const results = state.operations.filter((operation) => !normalized || `${operation.summary} ${operation.path} ${operation.tag} ${operation.method}`.toLowerCase().includes(normalized));
    $('#search-results').innerHTML = results.length ? results.slice(0, 20).map((operation) => `<button class="search-result" type="button" data-search-id="${operation.id}"><span class="nav-link__method" data-method="${operation.method}">${methodLabel(operation.method)}</span><div><strong>${escapeHTML(operation.summary)}</strong><small>${escapeHTML(operation.path)}</small></div><span>${escapeHTML(operation.tag)}</span></button>`).join('') : '<div class="search-empty">Nenhum endpoint encontrado.</div>';
    $$('[data-search-id]').forEach((button) => button.addEventListener('click', () => {
      $('#search-dialog').close();
      selectOperation(button.dataset.searchId);
      document.getElementById(button.dataset.searchId)?.scrollIntoView({ behavior: 'smooth' });
    }));
  }

  function setImportMode(mode) {
    state.importMode = mode;
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
        const response = await fetch(url);
        if (!response.ok) throw new Error(`Não foi possível carregar a URL (${response.status}).`);
        source = await response.text();
        sourceName = url.split('/').pop() || 'openapi';
      } else if (state.importMode === 'file') {
        const file = $('#spec-file').files[0];
        if (!file) throw new Error('Selecione um arquivo.');
        source = await file.text();
        sourceName = file.name;
      } else {
        source = $('#spec-paste').value;
        sourceName = 'openapi-pasted';
      }
      loadSpec(parseSpec(source), sourceName);
      $('#import-dialog').close();
      toast('Documentação gerada');
    } catch (error) {
      errorNode.textContent = error.message || 'Não foi possível ler a especificação.';
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

  function bindStaticEvents() {
    $('#collapse-sidebar').addEventListener('click', () => document.body.classList.toggle('sidebar-collapsed'));
    $('#open-import').addEventListener('click', () => $('#import-dialog').showModal());
    $('#open-import-secondary').addEventListener('click', () => $('#import-dialog').showModal());
    $('#download-spec').addEventListener('click', downloadSpec);
    $$('[data-request-tab]').forEach((tab) => tab.addEventListener('click', () => {
      $$('[data-request-tab]').forEach((button) => button.classList.toggle('is-active', button === tab));
      ['params', 'body', 'headers'].forEach((name) => $(`#${name}-panel`).hidden = name !== tab.dataset.requestTab);
    }));
    $('#server-select').addEventListener('change', updateRequestURL);
    $('#copy-url').addEventListener('click', () => copyText($('#request-url').value, 'URL copiada'));
    $('#toggle-token').addEventListener('click', () => {
      const input = $('#auth-token');
      input.type = input.type === 'password' ? 'text' : 'password';
    });
    $('#format-json').addEventListener('click', () => {
      try { $('#request-body').value = JSON.stringify(JSON.parse($('#request-body').value), null, 2); }
      catch { toast('JSON inválido', true); }
    });
    $('#add-header').addEventListener('click', () => addHeaderRow());
    $('#send-request').addEventListener('click', sendRequest);
    $('#copy-response').addEventListener('click', () => copyText($('#response-code').textContent, 'Response copiada'));
    $('#mobile-console-toggle').addEventListener('click', () => document.body.classList.toggle('console-open'));
    $('#close-console').addEventListener('click', () => document.body.classList.remove('console-open'));
    $$('[data-import-tab]').forEach((button) => button.addEventListener('click', () => setImportMode(button.dataset.importTab)));
    $('#load-spec').addEventListener('click', importSpec);
    $('#open-search').addEventListener('click', () => { renderSearch(); $('#search-dialog').showModal(); setTimeout(() => $('#search-input').focus(), 20); });
    $('#search-input').addEventListener('input', (event) => renderSearch(event.target.value));
    $('#spec-file').addEventListener('change', () => { const file = $('#spec-file').files[0]; if (file) $('.dropzone strong').textContent = file.name; });
    const dropzone = $('#dropzone');
    ['dragenter', 'dragover'].forEach((event) => dropzone.addEventListener(event, (e) => { e.preventDefault(); dropzone.classList.add('is-dragging'); }));
    ['dragleave', 'drop'].forEach((event) => dropzone.addEventListener(event, (e) => { e.preventDefault(); dropzone.classList.remove('is-dragging'); }));
    dropzone.addEventListener('drop', (event) => { $('#spec-file').files = event.dataTransfer.files; const file = event.dataTransfer.files[0]; if (file) $('.dropzone strong').textContent = file.name; });
    document.addEventListener('keydown', (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); renderSearch(); $('#search-dialog').showModal(); setTimeout(() => $('#search-input').focus(), 20); }
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') { event.preventDefault(); sendRequest(); }
      if (event.key === 'Escape' && document.body.classList.contains('console-open')) document.body.classList.remove('console-open');
    });
  }

  async function init() {
    bindStaticEvents();
    addHeaderRow('Accept', 'application/json');
    try {
      const response = await fetch('./sample-openapi.json');
      loadSpec(await response.json(), 'sample-openapi.json');
    } catch (error) {
      $('#reference').innerHTML = `<div class="reference__inner"><p>Não foi possível carregar o exemplo: ${escapeHTML(error.message)}</p></div>`;
    }
  }

  init();
})();
