# Facet

Documentação OpenAPI privada com API Explorer e administração de acesso.

- **Frontend:** React, TypeScript e Vite.
- **Backend:** Express e TypeScript.
- **Persistência:** PostgreSQL, com usuários, convites, sessões, configurações e limites de autenticação persistentes.
- **Autenticação:** e-mail e senha, com MFA obrigatório por aplicativo autenticador e sem cadastro público. O administrador é definido pelo ambiente.

## Desenvolvimento

Requer **Node.js 24 ou superior**.

```sh
npm install
cp .env.example .env
```

Edite `.env` e preencha `ADMIN_EMAIL`, `ADMIN_PASSWORD` e `DATABASE_URL`, apontando para um PostgreSQL disponível. Para executar tudo em containers, siga a seção Podman abaixo. A senha deve ter entre 15 e 128 caracteres. Não há credenciais padrão, e o servidor recusa iniciar sem uma configuração válida. Novas senhas de usuários seguem o mesmo limite. Contas antigas com senha curta precisam confirmar a senha atual e definir uma nova senha no próximo login; nenhuma sessão nova é emitida antes da atualização, e sessões anteriores são revogadas ao concluir a troca. A senha do administrador é validada na inicialização: ajuste `ADMIN_PASSWORD` no ambiente antes de reiniciar se ainda tiver menos de 15 caracteres.

```sh
npm run dev
```

Abra <http://127.0.0.1:4173>. Express serve a API e integra o Vite na mesma origem durante o desenvolvimento.

## Podman

Requer Podman e `podman-compose`. No macOS, inicie a máquina com `podman machine start` caso esteja parada. O arquivo `compose.yaml` e o `Dockerfile` são compatíveis com Podman. Copie `.env.example` para `.env` apenas na configuração inicial e defina:

- `ADMIN_EMAIL` e `ADMIN_PASSWORD` (15–128 caracteres).
- `POSTGRES_DB`, `POSTGRES_USER` e uma senha privada em `POSTGRES_PASSWORD`.
- `DATABASE_URL`, usando os mesmos dados e o host **`postgres`**, porta `5432`: `postgresql://<usuario>:<senha-codificada>@postgres:5432/<banco>`.

Codifique os caracteres especiais da senha na URI, por exemplo `@` como `%40`; em `POSTGRES_PASSWORD`, mantenha a senha original. Não há senha padrão. O Compose recusa iniciar com variáveis obrigatórias vazias.

```sh
podman-compose up --build -d
podman-compose ps
podman-compose logs --tail=100 app
```

Abra <http://127.0.0.1:4173>. O Compose local executa o aplicativo **compilado**, com `NODE_ENV=development` para permitir HTTP apenas na porta publicada em loopback; ele não inicia o Vite. O banco fica na rede interna, sem porta publicada no host, e a aplicação aguarda seu healthcheck. O volume usa `/var/lib/postgresql`, conforme a [imagem oficial PostgreSQL 18](https://hub.docker.com/_/postgres).

A imagem usa Node.js 24, build em estágio separado, dependências de produção e usuário `node`. Seu padrão fora do Compose é `NODE_ENV=production`, que mantém a exigência de HTTPS. O Compose não repassa `COOKIE_SECURE`: a seleção automática segue `NODE_ENV`.

Para produção, configure um proxy HTTPS confiável na mesma máquina, encaminhando para `127.0.0.1:4173` e substituindo `X-Forwarded-For` e `X-Forwarded-Proto`. Defina `NODE_ENV=production` e `TRUST_PROXY=true` no ambiente usado pelo Compose e recrie a aplicação. Não publique o serviço local de desenvolvimento na internet. Para PostgreSQL externo, use uma conta de aplicação sem privilégios de superusuário, com acesso apenas ao banco/schema do portal, e conexão TLS validada conforme o provedor. As variáveis `POSTGRES_*` inicializam o serviço local; o runtime da aplicação utiliza apenas `DATABASE_URL`.

Para desenvolvimento com `npm run dev` no host, configure um PostgreSQL local/externo acessível e use esse endereço em `DATABASE_URL`; o nome `postgres` só resolve dentro da rede do Compose. O Compose não publica PostgreSQL por padrão.

O novo runtime não lê arquivos SQLite nem migra dados automaticamente. Para trazer um banco anterior, use o utilitário opcional abaixo antes de iniciar a aplicação no novo destino.

## Migrar dados de SQLite para PostgreSQL

Pare a aplicação anterior para impedir novas gravações durante a transferência. Faça um backup consistente do SQLite, preservando os arquivos de WAL quando aplicável. Configure `DATABASE_URL` para um PostgreSQL acessível pelo processo que executará a migração, com as tabelas do portal vazias, e rode:

```sh
npm run build
npm run migrate:sqlite -- /caminho/para/facet.sqlite
```

Para migrar dentro do Compose, antes de subir a aplicação, disponibilize um backup consistente em um diretório e monte-o somente para leitura:

```sh
podman-compose up -d postgres
podman-compose build app
podman-compose run --rm --no-deps \
  --volume /caminho/absoluto/do/backup:/migration:ro \
  app npm run migrate:sqlite -- /migration/facet.sqlite
podman-compose up -d app
```

O utilitário abre a origem somente para leitura, usa uma visão consistente do SQLite e transfere usuários, convites, configurações, sessões e contadores de tentativas em uma única transação de dados no PostgreSQL. Os hashes das senhas e dos tokens são preservados. Nomes ausentes em bancos antigos são preenchidos com a parte do e-mail anterior a `@`. Se qualquer tabela do destino já tiver registros ou algum dado falhar, a importação é cancelada sem sobrescrever registros; a estrutura das tabelas pode já ter sido criada. Tabelas opcionais ausentes em versões antigas são ignoradas.

O arquivo SQLite permanece preservado. Confira os totais exibidos, o login e as páginas antes de mudar o acesso para a nova aplicação. Mantenha as credenciais anteriores de administrador para preservar suas sessões; sessões e convites expirados continuam expirados após a transferência. Não execute a migração enquanto a aplicação estiver gravando no destino. O host `postgres` de `DATABASE_URL` é interno ao Compose; ao executar o utilitário no host, use um endpoint PostgreSQL acessível por ele.

## Acesso e administração

- `/login`: entrada de usuários e administrador.
- `/docs`: documentação protegida, com os recursos do MVP preservados.
- `/admin`: painel exclusivo do administrador.

Após entrar como administrador, clique em **Novo usuário** e informe nome e e-mail. A criação gera um link de convite: compartilhe-o para que o usuário defina sua própria senha, cadastre o autenticador e confirme o TOTP para ativar a conta. O painel permite buscar contas, editar nome e e-mail, desativar/reativar o acesso e excluir usuários. Não há envio automático de e-mail nem recuperação automática de senha nesta versão.

Alterar o e-mail ou o status de uma conta revoga suas sessões. Excluir uma conta também encerra seu acesso. Alterar `ADMIN_EMAIL` ou `ADMIN_PASSWORD` e reiniciar o servidor invalida as sessões anteriores do administrador. A conta do administrador aparece na lista identificada como Administrador; suas credenciais continuam sendo gerenciadas pelo ambiente, sem ações de edição, desativação ou exclusão no painel.

A documentação e sua especificação em `/docs-assets` exigem uma sessão válida no servidor. Senhas são armazenadas como hashes scrypt com salt; o banco guarda apenas o hash dos tokens de sessão. As sessões expiram após 12 horas e usam cookies HttpOnly e SameSite=Lax, com Secure obrigatório em produção. Login e aceite de convites têm limitação persistente de tentativas no PostgreSQL, que não é zerada ao reiniciar o processo. O login limita falhas por conta (independentemente do IP) e por IP; logins válidos não esgotam esse orçamento. O aceite limita o IP e o token, não calcula senhas em paralelo para o mesmo convite e compartilha com o login um teto de quatro cálculos de senha em execução por processo, sem fila ilimitada. As mutações da API verificam a origem da requisição.

## MFA por aplicativo autenticador

Para cadastrar o MFA obrigatório, gere uma chave de criptografia uma única vez:

```sh
openssl rand -base64 32
```

Guarde o resultado em `MFA_ENCRYPTION_KEY`, no ambiente do servidor ou no `.env` utilizado pelo Compose, e reinicie a aplicação. A chave precisa ter exatamente 32 bytes codificados em Base64. Sem essa configuração, novos cadastros de MFA ficam indisponíveis e contas sem MFA não recebem sessão. O Compose exige essa variável preenchida.

Todo cadastro segue a sequência senha → aplicativo autenticador → confirmação de um código de seis dígitos. Até essa confirmação, a conta permanece inativa com status “MFA pendente”, sem sessão de acesso. A confirmação libera a conta e exibe os códigos de recuperação; depois, a pessoa entra com senha e um código do aplicativo ou de recuperação ainda não utilizado. Contas existentes sem MFA e o administrador também precisam concluir o cadastro do autenticador antes de acessar a aplicação. Informar a senha nessas contas permite apenas iniciar esse cadastro. O MFA não pode ser desativado, nem o administrador pode ativar uma conta pendente sem a confirmação. A área de segurança permite renovar os códigos de recuperação. Esse fluxo usa TOTP padrão, sem serviço pago, SMS ou envio de e-mail; mantenha o relógio do servidor sincronizado.

Os segredos TOTP são criptografados com AES-256-GCM e vinculados à conta. A aplicação aceita uma janela de um intervalo de 30 segundos para diferença de relógio e registra o contador aceito para impedir sua reutilização. Códigos de recuperação são aleatórios e somente seus hashes são persistidos; guarde os códigos exibidos em um local seguro.

Mantenha uma cópia segura de `MFA_ENCRYPTION_KEY` junto ao plano de backup do PostgreSQL, com acesso restrito e separado do banco. Não substitua a chave a cada deploy e não a rotacione sem um procedimento que recriptografe os segredos existentes. Perder ou trocar a chave impede a leitura das configurações TOTP já cadastradas. O banco sozinho não permite recuperar essa chave.

## Configuração

| Variável | Uso | Padrão |
| --- | --- | --- |
| `ADMIN_EMAIL` | E-mail do administrador | Obrigatória |
| `ADMIN_PASSWORD` | Senha do administrador, 15–128 caracteres | Obrigatória |
| `HOST` | Interface em que o servidor escuta | `127.0.0.1` |
| `PORT` | Porta HTTP | `4173` |
| `DATABASE_URL` | URI de conexão PostgreSQL; senha deve estar codificada para URL | Obrigatória |
| `MFA_ENCRYPTION_KEY` | Chave Base64 de 32 bytes para criptografar segredos TOTP | Obrigatória para cadastrar MFA; exigida pelo Compose |
| `POSTGRES_DB` | Banco criado pelo Compose na primeira inicialização | `facet` no exemplo |
| `POSTGRES_USER` | Usuário de inicialização do PostgreSQL no Compose | `facet` no exemplo |
| `POSTGRES_PASSWORD` | Senha desse usuário no Compose | Obrigatória |
| `NODE_ENV` | `production` exige HTTPS; Compose local usa `development` | Imagem Docker: `production` |
| `COOKIE_SECURE` | Cookie restrito a HTTPS (`true`/`false`); produção recusa `false` | `true` com `NODE_ENV=production`; `false` nos demais modos |
| `TRUST_PROXY` | Confiar em um proxy reverso à frente do Express (`true`/`false`) | `false` |

O `.env.example` deixa `COOKIE_SECURE` sem definição para selecionar o padrão conforme `NODE_ENV`. Em produção, cookies seguros são obrigatórios: uma configuração explícita `COOKIE_SECURE=false` interrompe a inicialização. A aplicação também rejeita conexões HTTP com status 426 e envia HSTS nas conexões HTTPS. Configure HTTPS no proxy, habilite `TRUST_PROXY=true` somente para esse proxy confiável e redirecione HTTP para HTTPS antes de servir a aplicação. O Vite de desenvolvimento não é iniciado com `NODE_ENV=production`.

Ative `TRUST_PROXY` apenas se o Express estiver atrás de um único proxy confiável que substitua os headers `X-Forwarded-For` e `X-Forwarded-Proto`. Restrinja o acesso direto à porta do backend por rede privada ou firewall; headers de encaminhamento enviados diretamente por um cliente não devem ser confiáveis. O tráfego HTTP entre proxy e aplicação deve ficar em uma rede privada confiável.

O `.env` fica fora do Git e do contexto de build Docker. O PostgreSQL mantém o estado no volume `postgres_data`; parar ou recriar os containers preserva esse volume. `podman-compose down -v` exclui o banco. Para backup, utilize `pg_dump` e valide a restauração com `pg_restore`. Alterar `POSTGRES_PASSWORD` no `.env` não altera a senha de um banco já inicializado; faça a alteração no PostgreSQL e atualize `DATABASE_URL`. Para múltiplas instâncias, revise também os limites de concorrência de autenticação por processo.

## Build e produção

```sh
npm run build
NODE_ENV=production npm start
```

O build gera `build/client` e `build/server`. O servidor também precisa do diretório `documentation/` com a especificação e os assets. A aplicação requer um serviço Node.js e um PostgreSQL acessível; hospedagem exclusivamente estática não atende à autenticação.

Para expor atrás de um proxy, use `NODE_ENV=production`, HTTPS e `TRUST_PROXY=true`. Se o proxy estiver na mesma máquina, mantenha `HOST=127.0.0.1`; em containers, use `HOST=0.0.0.0` somente com a porta restrita ao proxy. `COOKIE_SECURE=true` pode ser definido explicitamente; sem definição, o modo de produção já exige cookies seguros.

## Documentação da API

A especificação padrão continua em `documentation/sample-openapi.json`. A interface preserva a importação de OpenAPI por URL, arquivo e texto (JSON/YAML), navegação por tags, busca, temas, exemplos em nove linguagens/ferramentas e Explorer com parâmetros, headers, bearer token e editor de Body.

A autenticação da plataforma controla quem pode consultar a documentação. As credenciais configuradas no Explorer são separadas e usadas nas requisições à API documentada. O Explorer envia requisições diretamente pelo navegador, sujeito ao CORS da API de destino. Ele não envia cookies do navegador nem segue redirecionamentos; informe a URL final da API. Rotas internas do portal são bloqueadas. Trocar a origem do servidor ou substituir a especificação limpa os tokens e headers; configure as credenciais do novo destino novamente.

## Estrutura

```text
client/
  pages/                  Login e administração em React
  components/             Componentes de formulário, tema e diálogos
  documentation/          Shell React e motor da documentação em TypeScript
  api.ts                  Cliente tipado da API administrativa
server/
  app.ts                  Autenticação, usuários, sessões e arquivos protegidos
  index.ts                Inicialização do servidor e integração com Vite
documentation/
  sample-openapi.json     Especificação protegida
  styles.css, fonts/      Identidade visual existente
tests/
  server.test.ts          Integração HTTP e persistência
  documentation.test.ts   Geração dos exemplos de request
  e2e/                    Fluxos reais no navegador
```

A migração da documentação é incremental: React cuida do ciclo de vida e da conta, enquanto o renderizador e o editor existentes foram convertidos para módulos TypeScript. Isso preserva a interface e os comportamentos ajustados no MVP sem uma reescrita completa do Explorer.

## Validação

```sh
npm run check
TEST_DATABASE_URL='postgresql://<usuario>:<senha-codificada>@127.0.0.1:5432/<banco-de-testes>' npm test
TEST_DATABASE_URL='postgresql://<usuario>:<senha-codificada>@127.0.0.1:5432/<banco-de-testes>' npm run test:e2e
```

Os testes precisam de `TEST_DATABASE_URL` explícita, uma instância PostgreSQL e um banco separado dos dados da aplicação; não usam `DATABASE_URL` como alternativa. Cada fixture cria um schema temporário isolado com prefixo `facet_test_` e o remove ao terminar. O usuário de testes precisa poder criar e remover esses schemas. Use exclusivamente credenciais e banco de teste; nunca aponte essa configuração para produção. Os testes de navegador usam Chrome instalado. Para usar o Chromium do Playwright, instale-o com `npx playwright install chromium` e acrescente `PLAYWRIGHT_CHANNEL=chromium` ao comando de E2E.

Todos os usuários possuem `name` (obrigatório, de 1 a 128 caracteres). O administrador usa o nome fixo `adminstrador`. Usuários de bancos anteriores recebem inicialmente a parte do e-mail antes de `@` como nome, que pode ser editado no painel.

No painel, a sidebar separa **Usuários** e **Customização**. A área de customização funciona como um CMS da documentação, com três abas:

- **Aparência:** nome obrigatório, usado no título da aba, e logo opcional por URL HTTPS. O menu lateral mostra apenas o logo; sem logo, a marca fica oculta. As cores seguem o tema padrão da documentação.
- **OpenAPI:** importe arquivo JSON/YAML ou cole a especificação OpenAPI 3.0/3.1 (até 2 MB). **Publicar OpenAPI** substitui a referência e o API Explorer para todos os usuários, preservando as páginas. Até a primeira importação, a documentação mantém o exemplo do Facet.
- **Páginas e menu:** crie, edite e exclua páginas em Markdown; defina título, endereço e grupo; ordene com as setas; use a prévia e escolha **Exibir na documentação**. Clique em **Salvar páginas** para persistir as alterações. Rascunhos ficam disponíveis apenas ao administrador.

O CMS persiste no PostgreSQL. Os leitores recebem o OpenAPI importado e as páginas publicadas ao abrir/recarregar a documentação. O Markdown aceita títulos, links, listas, tabelas, imagens e blocos de código; HTML é exibido como texto. As páginas possuem links diretos em `/docs#guide-endereco`. O editor preserva as alterações ao alternar abas e impede sobrescrever silenciosamente uma versão salva em outra aba.

### Convites por link

Em **Usuários → Novo usuário**, informe nome e e-mail e clique em **Criar usuário**. Copie e compartilhe o link exibido; não há envio automático de e-mail. Ele vale por 7 dias e só permite criar uma conta para o e-mail definido. O nome e o e-mail são definidos pelo administrador e exibidos sem edição. A pessoa define a senha, cadastra o autenticador e confirma o TOTP. Só então a conta é ativada; o acesso exige senha e segundo fator.

A mesma tabela de usuários mostra os status **Ativo**, **Inativo**, **Aguardando ativação** e **Convite expirado**. Nas linhas que aguardam ativação, é possível gerar um novo link ou revogar o convite. Gerar outro convite para o mesmo e-mail invalida o anterior. O token usa 32 bytes aleatórios, fica no fragmento do link e o banco armazena apenas seu hash SHA-256. O link completo é mostrado somente ao gerar. Convites expirados, revogados ou utilizados não podem criar contas; contas existentes não podem ser sobrescritas por convite.

Os itens de **Schemas** abrem uma view própria com propriedades, tipos, campos obrigatórios, exemplos e JSON original. Referências locais entre schemas são navegáveis e estruturas recursivas não expandem indefinidamente. Cada schema possui um link direto em `/docs#schema-Nome` e também aparece na busca.
