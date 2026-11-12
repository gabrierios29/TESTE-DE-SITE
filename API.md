# API de integração

A API usa a mesma origem HTTPS da aplicação em homologação institucional ou produção. As consultas autenticadas usam a sessão emitida no login. A especificação `GET /api/openapi.json` lista os métodos, parâmetros de rota e permissões da conta autenticada.

| Método e recurso | Acesso | Resultado |
| --- | --- | --- |
| `GET /health` | Público | Sonda com `{"status":"ok"}` em funcionamento |
| `GET /api/validation/:code` | Público com limitação de requisições | Autenticidade de certificado por código de 32 caracteres hexadecimais. O campo `status` é `active`, `revoked` ou `missing` |
| `GET /api/reports` | Sessão com `reports.read` | Objeto que associa códigos de relatórios aos títulos |
| `GET /api/reports/:type` | Sessão com `reports.read` | Objeto com `title`, `columns`, `rows` e `metrics` |
| `GET /api/reports/:type/export/:format` | Sessão com `reports.read` | Download em `xlsx`, `csv` ou `pdf` |
| `GET /api/bi/:type` | Sessão com `reports.read` | Objeto com `columns` e `rows`. Use `format=csv` para baixar o CSV com cabeçalhos técnicos |

Os relatórios e conjuntos para BI aplicam as permissões, o órgão e a unidade da sessão. Os filtros opcionais são `start` e `end` no formato `AAAA-MM-DD`, `org`, `modality`, `theme`, `instructor` e `status`. Use `presential`, `online` ou `hybrid` para modalidade. Codifique acentos e espaços nos valores da URL. Cada linha JSON usa as chaves listadas no campo `key` de cada coluna. Em CSV para BI, importe o arquivo UTF-8 exportado pelo perfil autorizado para o Looker Studio ou Power BI.

Exemplos de recursos

```http
GET /api/bi/indicadores?start=2026-01-01&end=2026-12-31&format=csv
GET /api/reports/frequencia-turmas/export/xlsx?org=IMPARH
GET /api/validation/ED532C05470E4ACD80BEA212B7BA0DF1
```

O código acima é de um certificado fictício na demonstração. A página `/validar` aceita um código digitado pelo usuário ou o parâmetro `codigo`.

Erros da API retornam `error` e `requestId`. Trate HTTP 401 como sessão ausente ou expirada, 403 como acesso ou origem recusada, 404 como recurso não encontrado e 409 como conflito de estado. O cabeçalho `X-Request-Id` permite correlacionar a resposta com o log de suporte.

Os contratos de autenticação, consulta cadastral, AVEA, Canal do Servidor e e-mail estão em [INTEGRAÇÕES](INTEGRACOES.md).
