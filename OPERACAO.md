# Implantação e suporte

## Ambientes e primeiro acesso

O servidor usa Node.js 24 ou superior e SQLite embutido no Node. O processo é único por banco e atende vários usuários pela web. A aplicação grava dados de negócio, anexos, sessões, trilhas e filas no banco SQLite. Use um volume local persistente com acesso restrito ao processo. Use diretórios, chaves, provedores, bancos e credenciais separados para desenvolvimento, homologação e produção.

| Parâmetro | Uso |
| --- | --- |
| `CAP_ENV` | `development`, `test` ou `production` |
| `CAP_HOST` e `CAP_PORT` | Endereço de escuta e porta. Padrão `127.0.0.1` e `4173` |
| `CAP_BASE_URL` | Origem que o navegador e os serviços acessam. Obrigatoriamente HTTPS em produção |
| `CAP_DATA_DIR` | Diretório persistente. Obrigatório em produção |
| `CAP_BACKUP_DIR` | Diretório de cópias. Use volume protegido. Padrão `backups` dentro da pasta de dados |
| `CAP_BACKUP_HOURS`, `CAP_BACKUP_COPIES` | Intervalo de cópias automáticas e quantidade retida. Padrões 24 horas e 14 cópias |
| `CAP_TLS_KEY` e `CAP_TLS_CERT` | Arquivos PEM para o servidor terminar TLS diretamente |
| `CAP_TLS_PROXY=1` | Use quando um proxy local termina TLS. Mantenha a aplicação no loopback e encaminhe o cabeçalho Host |
| `CAP_ADMIN_EMAIL` e `CAP_ADMIN_OIDC_SUBJECT` | Criação do primeiro administrador em banco vazio. O identificador deve vir do provedor institucional |
| `CAP_ADMIN_PASSWORD` | Senha local inicial de 12 a 256 caracteres em banco vazio. Armazene e injete pelo gerenciador de segredos |
| `CAP_LOCAL_LOGIN=1` | Habilita deliberadamente login local em produção. O padrão exige OIDC |
| `CAP_SESSION_MINUTES` e `CAP_SESSION_IDLE_MINUTES` | Tempo máximo e de inatividade. Padrões 480 e 60 minutos |

Inicie com `node server.mjs` ou `node --env-file=CAMINHO_DO_ARQUIVO server.mjs`. Para a execução contínua, use o gerenciador de serviços do ambiente com reinício automático e captura de stdout e stderr. No Windows, os comandos aceitam `runtime\node.exe` no lugar de `node`.

O arquivo de configuração da homologação deve usar `CAP_ENV=test`, o diretório próprio da homologação e endpoints oficiais de teste. Em produção, configure o TLS, o retorno OIDC, a origem pública e o primeiro administrador. Cadastre contas no painel de usuários com o identificador `sub` retornado pelo emissor institucional e os escopos autorizados. Associe servidores ao registro funcional retornado na consulta institucional. Mantenha o identificador da conta e o identificador funcional de acordo com a política do provedor.

Para implantação atrás de proxy, termine o HTTPS no proxy, preserve o `Host` da origem pública e encaminhe para `http://127.0.0.1:4173`. Proteja o acesso ao proxy e à máquina conforme a política institucional. A aplicação valida a origem de mutações e usa cookies HttpOnly, SameSite e Secure em HTTPS.

## Backup, restauração e portabilidade

Gere uma cópia no painel de Configurações ou pelo comando `node maintenance.mjs backup`, usando o mesmo ambiente da instância. O servidor usa o backup online do SQLite e verifica a integridade antes de manter a cópia. A rotina automática começa na primeira execução do agendador após a inicialização e observa o intervalo configurado. Monitore a idade da última cópia e replique os arquivos em armazenamento protegido de recuperação.

1. Verifique uma cópia com `node maintenance.mjs verify "ARQUIVO.sqlite"`.
2. Selecione um `CAP_DATA_DIR` vazio e distinto.
3. Execute `node maintenance.mjs restore "ARQUIVO.sqlite"`. A restauração verifica o banco e revoga as sessões copiadas.
4. Inicie a instância restaurada com configurações de homologação. Confira autenticação, histórico, anexos e certificados antes de mudar o ambiente atendido.

A exportação JSON administrativa serve à portabilidade dos dados. A recuperação integral usa o backup SQLite. Proteja a exportação e os backups, pois podem conter dados pessoais e anexos. Para BI, disponibilize exportações de relatórios ou os conjuntos CSV autorizados de `/api/bi/:type`. Veja os formatos e filtros na [documentação da API](API.md).

## API e integrações

A instância disponibiliza o inventário OpenAPI em `/api/openapi.json` após autenticação. O inventário é filtrado pelas permissões do usuário. Mutações usam JSON e as consultas usam os escopos da conta. As respostas de erro incluem `requestId`. O código de validação é consultável em `GET /api/validation/:code` e em `/validar?codigo=...`.

Os contratos de OIDC, base funcional, AVEA/Moodle, Canal do Servidor e gateway de e-mail estão em [INTEGRAÇÕES](INTEGRACOES.md). Use contas de serviço com as permissões mínimas do contrato homologado. Teste a associação por identificador funcional, o processamento idempotente e a aceitação de atualizações pelo destino antes de habilitar o envio automático.

## Monitoramento e procedimento de suporte

- Configure uma sonda para `GET /health`. A resposta esperada é HTTP 200 com `{"status":"ok"}`.
- Monitore disponibilidade do serviço, erros no log, idade da última cópia e transmissões pendentes ou rejeitadas.
- No chamado, informe ambiente, horário, tela ou operação e identificador do erro. Use o canal de suporte da instituição configurado no sistema.
- A equipe de suporte consulta a trilha de auditoria e correlaciona `X-Request-Id` com os logs do servidor. Para falha de transmissão, consulta o estado e a tentativa correspondente no painel de Integrações. Após a correção, o administrador pode reenviar o item.
- Em falha de armazenamento, preserve o banco e os logs e verifique a cópia disponível antes de executar o procedimento de restauração.

## Proteção de dados na homologação

Confirme com a instituição a base legal, a finalidade, os campos necessários, os prazos de retenção, o processo de atendimento ao titular, a visibilidade da validação pública, os perfis, o armazenamento e a resposta a incidentes. A aplicação oferece autorização no servidor, segregação de acessos, minimização dos dados exibidos conforme perfil, auditoria, revogação de sessão, TLS e portabilidade. O aceite das rotinas institucionais integra a entrada em produção. [Lei Geral de Proteção de Dados](https://www.planalto.gov.br/ccivil_03/_ato2015-2018/2018/lei/l13709.htm)
