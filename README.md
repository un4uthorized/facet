# Facet API Reference

Documentação OpenAPI interativa inspirada no fluxo do Scalar e construída com a linguagem visual do blog: Space Grotesk, superfícies escuras, controles compactos e cores semânticas por método HTTP.

## Recursos

- Importação de OpenAPI 3.x por URL, arquivo ou texto (JSON/YAML)
- Navegação automática por tags e endpoints
- Busca rápida com `⌘/Ctrl + K`
- Playground com path/query params, headers, bearer token e JSON body
- Requests reais via `fetch`, com status, latência, tamanho e body da resposta
- Layout responsivo com console móvel

## Rodar localmente

Sirva a pasta `dist` com qualquer servidor estático:

```sh
python3 -m http.server 4173 --directory dist
```

Depois acesse `http://localhost:4173`.

> Requests feitas pelo playground estão sujeitas à política de CORS da API de destino.
