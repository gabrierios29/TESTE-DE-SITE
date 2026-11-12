# Gestão de Capacitações da Escola de Governo

Sistema web do IMPARH para registrar demandas de formação, planejar e executar turmas, acompanhar servidores e emitir certificados. A aplicação mantém os registros em um banco SQLite central para os usuários de cada ambiente.

## Abrir a demonstração

1. Extraia todos os arquivos de `Gestao_Capacitacoes_IMPARH.zip` para uma pasta.
2. Em um computador Windows de 64 bits, abra **INICIAR.cmd**. O pacote inclui o Node.js necessário para a execução.
3. Abra [http://127.0.0.1:4173](http://127.0.0.1:4173) no navegador se ele não abrir automaticamente.
4. Escolha um dos sete perfis de demonstração na tela de acesso. Clique no seu nome no rodapé do menu lateral e selecione **Sair da sessão** para trocar de perfil.

A demonstração escuta apenas no computador local. Os cadastros e certificados são fictícios. As alterações ficam em `%LOCALAPPDATA%\IMPARH\GestaoCapacitacoes\demo`. Fechar a janela do iniciador encerra o servidor. Os conectores externos ficam desabilitados na demonstração.

Pela linha de comando, com Node.js 24 ou superior, execute `node demo.mjs` ou `npm run demo`. Use `node --test` para executar os testes incluídos.

## Manual rápido

### Ponto focal

1. Abra **Solicitações** e selecione **Nova solicitação**. Preencha a demanda e anexe os arquivos necessários.
2. Escolha **Salvar como rascunho** para continuar depois ou **Enviar para análise** para gerar o protocolo.
3. Abra a solicitação para baixar o comprovante e consultar a tramitação. Se a Escola pedir complementação, edite o registro e selecione **Reenviar para análise**.

### Escola de Governo

1. Filtre **Solicitações** e abra o protocolo. Use **Registrar tramitação** para atribuir responsável, agrupar demandas, registrar parecer e alterar a situação.
2. Em **Ações e turmas**, crie a ação interna ou vincule solicitações aprovadas. Cadastre a turma, as vagas, as condições de inscrição e os encontros. A agenda fica disponível em **Calendário**.
3. Em **Instrutores**, mantenha formação, atuação, documentos, credenciamento, valores e limites de horas. Vincule os instrutores à ação, à turma ou ao encontro. A tela sinaliza quando as horas previstas ou realizadas alcançam o limite anual.
4. Em **Inscrições**, consulte o servidor por CPF e matrícula e gerencie aprovações, lista de espera, cancelamentos, desistências e substituições.
5. Em **Frequência**, selecione a turma e o encontro. Use o modelo CSV UTF-8 para importar a frequência ou lance as presenças individualmente. Anexe a lista assinada e registre a execução e as reposições. A ausência justificada fica registrada e não soma horas de presença. Encerre a turma após validar os registros.
6. Em **Avaliações**, configure perguntas e data de abertura. Acompanhe respostas e resultados. Em **Certificados**, revise a elegibilidade, emita os PDFs e use a opção de cancelamento quando houver justificativa.
7. Em **Relatórios**, selecione a visão e os filtros e baixe os dados em Excel, CSV ou PDF.

### Servidor e instrutor

O servidor pode consultar as turmas elegíveis, inscrever-se, acompanhar a situação, responder a avaliações e acessar o histórico e as segundas vias. O instrutor consulta a programação das turmas vinculadas e a frequência disponível ao seu perfil. A tela pública **Validar um certificado** consulta a autenticidade pelo código do documento.

### Administração e auditoria

A administração vincula contas às identidades institucionais, configura os perfis e restringe o acesso por órgão e unidade. Em **Configurações**, define instituição, suporte e meta anual, consulta os backups e exporta os dados. O perfil de auditoria pode consultar as informações autorizadas sem alteração. Em **Integrações**, a administração vincula ou sincroniza salas do AVEA e acompanha, processa ou reenvia as transmissões autorizadas.

## Onde cada requisito aparece

| Seção do anexo | Funcionalidade ou componente |
| --- | --- |
| 1. Solicitação dos órgãos | Solicitações, rascunho, anexos, protocolo, comprovante e histórico do próprio órgão |
| 2. Análise e tramitação | Filtros, responsável, parecer, devolução, agrupamento, notificações e histórico |
| 3. Planejamento | Ações internas ou vinculadas, turmas, encontros, cronograma, recursos, custos e calendário |
| 4. Instrutores | Banco de instrutores, documentos, credenciamento, histórico, horas, valores e relatórios |
| 5. Participantes | Consulta funcional, elegibilidade, confirmação, espera, substituição, histórico e avisos |
| 6. Execução e frequência | Listas por turma e encontro, lançamento e importação, anexos, reposição, carga e percentual |
| 7. AVEA/Moodle | Criação ou vínculo de sala, matrículas, atividades, resultados, progresso e divergências |
| 8. Avaliações | Instrumentos de reação, aprendizagem e instrutor, agenda, avisos, respostas e consolidação |
| 9. Certificados | Critérios por ação e turma, modelo, PDF, segunda via, código e URL de validação, cancelamento auditado |
| 10. Canal do Servidor | Fila de histórico formativo, PDF digital, identificador validado, correção, cancelamento, reenvio e transmissão |
| 11. Painéis e relatórios | Indicadores, execução do PDC, relatórios operacionais, Excel, CSV, PDF e fonte para BI |
| 12. Usuários e permissões | Sete perfis, funções configuráveis, escopos e controle de sessão no servidor |
| 13. Requisitos técnicos | Interface responsiva, HTTPS em produção, SQLite, auditoria, portabilidade, backup, restauração, monitoramento e documentação |
| 14. Integrações | OIDC, base funcional, AVEA/Moodle, Canal do Servidor, e-mail e exportação para BI |

As integrações institucionais exigem os endereços, contratos, credenciais e autorizações dos sistemas responsáveis. Consulte [INTEGRAÇÕES](INTEGRACOES.md) e [IMPLANTAÇÃO E SUPORTE](OPERACAO.md). A entrega é executável localmente. A implantação institucional e o aceite das integrações ocorrem na homologação.
