# Integrações institucionais

Configure as variáveis de ambiente no processo que executa o sistema. Guarde segredos no serviço de implantação ou no gerenciador institucional de segredos. A tela **Integrações** indica a presença de configuração, mostra vínculos, divergências e o histórico da fila. Confirme os endereços, escopos, responsáveis e regras de sincronização com as equipes titulares antes de habilitar o tráfego.

## Login institucional

Cadastre um cliente confidencial OpenID Connect com Authorization Code e PKCE S256. Registre como retorno a origem de `CAP_BASE_URL` seguida de `/api/auth/institutional/callback`. Defina as seguintes variáveis.

| Variável | Finalidade |
| --- | --- |
| `OIDC_ISSUER` | Emissor HTTPS exatamente como consta no campo `issuer` da descoberta |
| `OIDC_CLIENT_ID` e `OIDC_CLIENT_SECRET` | Identificador e segredo do cliente |
| `OIDC_REDIRECT_URI` | Endereço HTTPS completo de retorno |
| `OIDC_TOKEN_AUTH_METHOD` | `client_secret_basic` por padrão ou `client_secret_post` |
| `OIDC_SIGNING_ALGORITHMS` | Algoritmos permitidos. Padrão `RS256`. Também há suporte a `PS256` e `ES256` quando habilitados |

No cadastro do usuário, informe o identificador `sub` que o emissor fornece ao cliente do sistema. A autorização vem do perfil e do escopo locais. Mudança de emissor exige revisar os vínculos de identidade antes de reiniciar o serviço. [OpenID Connect Core](https://openid.net/specs/openid-connect-core-1_0.html)

## Base cadastral de servidores

Configure `SERVERS_API_URL` com um serviço oficial ou com um adaptador homologado que aceite HTTPS e o contrato abaixo. A consulta transmite CPF e matrícula e valida o pareamento retornado antes de gravar nome, órgão, unidade e identificador funcional. O sistema aceita HTTP 404 para cadastro ausente e o campo `ativo: false` para cadastro inativo.

```http
POST <SERVERS_API_URL>
Content-Type: application/json

{"cpf":"00000000000","matricula":"EXEMPLO-001"}
```

```json
{
  "servidor": {
    "cpf": "00000000000",
    "matricula": "EXEMPLO-001",
    "nome": "Pessoa de Exemplo",
    "orgao": "Órgão de Exemplo",
    "unidade": "Unidade de Exemplo",
    "email": "exemplo@example.invalid",
    "identificadorFuncional": "ID-EXEMPLO-001",
    "moodleUserId": "123",
    "ativo": true
  }
}
```

Os campos `email` e `moodleUserId` são opcionais. Para o Canal do Servidor, o identificador funcional precisa estar validado pela base ou pelo procedimento institucional de cadastro. Mantenha os valores de órgão e unidade coerentes com os filtros de acesso.

## AVEA / Moodle

Defina `MOODLE_URL` com a URL-base HTTPS da instância, incluindo o subdiretório quando existir. Defina `MOODLE_TOKEN` com um token de serviço REST que tenha acesso aos cursos, usuários e funções necessárias. Configure `MOODLE_CATEGORY_ID` para criar salas e `MOODLE_STUDENT_ROLE_ID` para matricular participantes. A relação operacional é de um curso Moodle por turma. Uma sala criada pelo sistema começa oculta.

| Operação | Funções REST |
| --- | --- |
| Localizar e vincular cursos | `core_course_get_courses_by_field` |
| Criar e atualizar salas | `core_course_create_courses`, `core_course_update_courses` |
| Conciliar participantes | `core_enrol_get_enrolled_users` |
| Matricular participantes confirmados | `core_user_get_users_by_field`, `enrol_manual_enrol_users` |
| Consultar conclusão e atividades | `core_completion_get_course_completion_status`, `core_completion_get_activities_completion_status` |
| Consultar nota final | `gradereport_user_get_grade_items` |

A correspondência de usuários usa o ID Moodle validado na base ou o `idnumber` com a matrícula. Configure o acompanhamento de conclusão no Moodle. O sistema registra divergências de matrícula, datas, conclusão, notas e funções indisponíveis. Abra **Progresso** na turma para consultar os dados importados. Notas registradas pela equipe ou pela avaliação interna continuam válidas. Quando a nota vem do Moodle, uma nova importação pode atualizá-la. [Referência de conclusão](https://phpdoc.moodledev.io/4.1/db/d12/classcore__completion__external.html) · [Referência de matrículas](https://moodledev.io/docs/4.5/apis/subsystems/enrol) · [Referência de notas](https://phpdoc.moodledev.io/4.5/d7/da7/classgradereport__user_1_1external_1_1user.html)

Quando a instância oferecer frequência e carga horária, configure `MOODLE_PROGRESS_FUNCTION` com a função institucional. Ela recebe `courseid` e `userid` e devolve `attendancePercent` de 0 a 100, `completedHours` e, opcionalmente, `completed` booleano. Quando há conclusão confirmada e a função deixa de fornecer horas, o sistema usa a carga virtual planejada da turma, se definida. Para turma totalmente EaD sem carga virtual explícita, usa a carga da ação. Percentual de atividades e frequência são dados distintos.

## Canal do Servidor

Defina `CANAL_API_URL` com o endereço HTTPS oficial ou de um adaptador homologado. O serviço recebe POST JSON com `Idempotency-Key`. O destino deve usar esse cabeçalho para tolerar novas tentativas da mesma transmissão e `idRegistro` para aplicar atualizações no mesmo histórico formativo.

```json
{
  "operacao": "upsert",
  "idRegistro": "canal:inscricao-exemplo",
  "identificadorFuncional": "ID-EXEMPLO-001",
  "idCapacitacao": "acao-exemplo",
  "idTurma": "turma-exemplo",
  "titulo": "Capacitação de Exemplo",
  "modalidade": "online",
  "inicio": "2026-11-01",
  "termino": "2026-11-02",
  "cargaHoraria": 8,
  "codigoCertificado": "CODIGO-EXEMPLO",
  "certificadoPdfBase64": "<conteúdo PDF codificado em base64>"
}
```

Use `upsert` para publicação e correção, e `cancel` para invalidação. Os campos de certificado são fornecidos quando há certificado pertinente. O CPF e a matrícula ficam na base funcional. O destino recebe o identificador validado para associar o registro à área individual, na qual a equipe do Canal disponibiliza a consulta e o download.

Aceitação pode ser informada por HTTP 204, HTTP 202, ou JSON com `accepted: true` e `id` ou `protocolo`. Rejeição é registrada em caso de resposta sem sucesso ou de JSON com `accepted: false`, `aceito: false`, `success: false` ou `error`. O administrador global pode preparar o histórico atualizado, processar a fila, corrigir pendências e reenviar registros.

## E-mail institucional

Defina `EMAIL_API_URL` com um gateway institucional HTTPS que aceite POST JSON. `EMAIL_FROM` é o remetente quando o gateway exige esse campo. O contrato usa `Idempotency-Key` no cabeçalho e os campos `to`, `from`, `subject`, `text` e `link` no corpo. O gateway deve aceitar ou rejeitar a solicitação conforme as convenções do Canal e pode devolver `messageId`. O status Enviado indica que o gateway aceitou a transmissão. A entrega na caixa postal depende do gateway.

## Credenciais e processamento

Para a base, o Canal e o e-mail, o prefixo das credenciais é respectivamente `SERVERS`, `CANAL` e `EMAIL`. Use `<PREFIXO>_TOKEN` para um token Bearer, ou `<PREFIXO>_TOKEN_URL`, `<PREFIXO>_CLIENT_ID`, `<PREFIXO>_CLIENT_SECRET` e opcionalmente `<PREFIXO>_SCOPE` para OAuth 2.0 Client Credentials. A troca usa POST com dados de formulário e credenciais no corpo. Se o serviço requer outro mecanismo, use o adaptador autorizado para a interface institucional.

Em homologação, inicie com fila manual e serviços de teste. `INTEGRATION_AUTO_DISPATCH=true` habilita processamento da fila a cada 30 segundos. Falhas temporárias de rede, limite de chamadas ou indisponibilidade entram em nova tentativa com intervalo crescente, até cinco tentativas automáticas. Falhas de dados ou de autorização ficam disponíveis para correção e reenvio. Um processo do sistema deve operar cada base de dados e sua fila. Na demonstração, o sistema mantém os conectores externos desabilitados.

Os conectores usam HTTPS, recusam redirecionamentos do serviço remoto e não devolvem tokens, corpo de erro remoto, CPF ou e-mail nas consultas do painel de integração. As operações de sincronização, preparação de fila e reenvio geram trilha local. Restrinja o acesso aos backups e aplique os prazos institucionais de retenção aos registros e anexos.
