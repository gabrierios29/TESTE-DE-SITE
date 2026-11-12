import { passwordHash } from './security.mjs';

const base = new Date(new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Fortaleza' }) + 'T12:00:00Z');
const day = (offset) => new Date(base.getTime() + offset * 86_400_000).toISOString().slice(0, 10);
const at = (offset) => day(offset) + 'T14:00:00.000Z';
const year = Number(day(0).slice(0, 4));
const orgs = { school: 'IMPARH', people: 'SEPOG', health: 'SMS', education: 'SME', social: 'SDHDS' };

export function seedDemo(db) {
  db.tx(() => {
    if (db.get('settings', 'demo-seeded')) return;
    if (db.list('users').length) throw new Error('Use um banco exclusivo para a demonstração.');
    const password = passwordHash('CapacitacaoDemo2026!');
    const accounts = [
      ['admin', 'Administração Escola de Governo', 'admin', orgs.school, 'Escola de Governo'],
      ['gestor', 'Gestão Escola de Governo', 'manager', orgs.school, 'Escola de Governo'],
      ['tecnico', 'Equipe Técnica', 'tech', orgs.school, 'Escola de Governo'],
      ['focal', 'Renata Alves', 'focal', orgs.people, 'Gestão de Pessoas'],
      ['instrutor', 'Paulo Ribeiro', 'instructor', orgs.school, 'Escola de Governo'],
      ['servidor', 'Mariana Nascimento', 'participant', orgs.people, 'Gestão de Pessoas'],
      ['auditoria', 'Consulta Institucional', 'auditor', orgs.school, 'Escola de Governo']
    ];
    for (const [id, name, role, org, unit] of accounts) db.save('users', {
      id, name, role, org, unit, email: id + '@demo.example', passwordHash: password, active: true,
      ...(role === 'participant' ? { servantId: 'serv-01' } : {}), ...(role === 'instructor' ? { instructorId: 'inst-01' } : {})
    });
    const people = [
      ['serv-01', 'Mariana Nascimento', '00000000001', 'DEMO001', orgs.people, 'Gestão de Pessoas', 'servidor@demo.example', 'servidor'],
      ['serv-02', 'João Andrade', '00000000002', 'DEMO002', orgs.health, 'Atenção Primária', 'joao@demo.example', ''],
      ['serv-03', 'Camila Duarte', '00000000003', 'DEMO003', orgs.education, 'Gestão Escolar', 'camila@demo.example', ''],
      ['serv-04', 'Lívia Monteiro', '00000000004', 'DEMO004', orgs.people, 'Gestão de Pessoas', 'livia@demo.example', '']
    ];
    for (const [id, name, cpf, matricula, org, unit, email, userId] of people) db.save('servants', {
      id, name, cpf, matricula, org, unit, email, userId, active: true, functionalId: 'FICTICIO-' + id, validatedAt: at(-30)
    });
    db.save('instructors', { id: 'inst-01', name: 'Paulo Ribeiro', org: orgs.school, unit: 'Escola de Governo', userId: 'instrutor',
      email: 'instrutor@demo.example', education: 'Administração Pública', degree: 'Mestrado', roleName: 'Instrutor',
      experience: 'Formação de equipes da administração municipal.', credentialStatus: 'active', expiresOn: day(150),
      areas: ['Gestão pública'], topics: ['Processos', 'Planejamento'], annualLimit: 120, hourlyRate: 85, rateRule: 'Valor fictício de demonstração', attachments: [], history: [] });
    db.save('instructors', { id: 'inst-02', name: 'Helena Martins', org: orgs.school, unit: 'Escola de Governo', userId: '',
      email: 'helena@demo.example', education: 'Ciência de Dados', degree: 'Especialização', credentialStatus: 'active', expiresOn: day(200),
      areas: ['Tecnologia'], topics: ['Dados', 'Planilhas'], annualLimit: 80, attachments: [], history: [] });
    const requests = [
      ['req-01', 'Gestão e fiscalização de contratos', orgs.people, 'Gestão de Pessoas', 'review', 'presential', 24, 30, -1, 26],
      ['req-02', 'Atendimento humanizado ao cidadão', orgs.health, 'Atenção Primária', 'received', 'hybrid', 20, 40, -2, 21],
      ['req-03', 'Excel aplicado à gestão pública', orgs.education, 'Gestão Escolar', 'approved', 'presential', 16, 25, -4, 4],
      ['req-04', 'Proteção de dados no serviço público', orgs.social, 'Gestão de Pessoas', 'complement', 'online', 12, 30, -6, 15],
      ['req-05', 'Gestão de processos de trabalho', orgs.people, 'Gestão de Pessoas', 'approved', 'hybrid', 20, 24, -12, -4],
      ['req-06', 'Comunicação institucional', orgs.people, 'Gestão de Pessoas', 'rejected', 'presential', 8, 18, -18, 3],
      ['req-07', 'Planejamento e indicadores de resultados', orgs.school, 'Escola de Governo', 'received', 'online', 10, 45, -21, 19],
      ['req-08', 'Mediação e gestão de conflitos', orgs.health, 'Atenção Primária', 'approved', 'hybrid', 16, 20, -24, -2]
    ];
    for (const [id, title, org, unit, status, modality, hours, participants, sent, start] of requests) {
      const focal = org === orgs.people;
      db.save('requests', { id, title, org, unit, status, modality, hours, participants, startDate: day(start), endDate: day(start + 9),
        userId: focal ? 'focal' : 'tecnico', requester: focal ? 'Renata Alves' : 'Equipe Técnica', email: (focal ? 'focal' : 'tecnico') + '@demo.example',
        protocol: 'EG-' + year + '-' + id.slice(-2).padStart(12, '0'), submittedAt: at(sent), createdAt: at(sent), updatedAt: at(sent),
        audience: 'Servidores municipais da unidade solicitante', place: 'Escola de Governo', needsInstructor: true, attachments: [],
        responsibleId: ['review', 'complement', 'approved'].includes(status) ? 'tecnico' : '', opinion: status === 'approved' ? 'Demanda incluída no planejamento da Escola de Governo.' : '',
        history: [{ action: 'Envio de solicitação', at: at(sent), userId: focal ? 'focal' : 'tecnico', userName: focal ? 'Renata Alves' : 'Equipe Técnica', details: { status: 'received' } }] });
    }
    const actions = [
      ['ac-01', 'Excel aplicado à gestão pública', 'req-03', orgs.education, 'Gestão Escolar', 'presential', 16, 25, 'open', 4, 9, 'inst-02', 'Laboratório de informática'],
      ['ac-02', 'Gestão de processos de trabalho', 'req-05', orgs.people, 'Gestão de Pessoas', 'hybrid', 20, 24, 'ongoing', -4, 7, 'inst-01', 'Sala 2 · Escola de Governo'],
      ['ac-03', 'Mediação e gestão de conflitos', 'req-08', orgs.health, 'Atenção Primária', 'hybrid', 16, 20, 'ongoing', -2, 9, 'inst-01', 'Sala 1 · Escola de Governo'],
      ['ac-04', 'Fundamentos de gestão pública', '', orgs.people, 'Gestão de Pessoas', 'presential', 12, 18, 'completed', -15, -8, 'inst-01', 'Sala 1 · Escola de Governo'],
      ['ac-05', 'Indicadores para políticas públicas', '', orgs.school, 'Escola de Governo', 'online', 10, 35, 'planned', 15, 29, 'inst-02', 'Ambiente virtual de aprendizagem']
    ];
    for (const [id, title, requestId, org, unit, modality, hours, capacity, status, start, end, instructorId, place] of actions) {
      const classId = 'tr-' + id.slice(-2);
      db.save('actions', { id, title, requestId, requestIds: requestId ? [requestId] : [], org, unit, modality, hours, capacity, place,
        startDate: day(start), endDate: day(end), schedule: 'Consulte o cronograma da turma', instructorIds: [instructorId],
        description: 'Ação formativa voltada ao desenvolvimento de competências no serviço público municipal.',
        program: 'Conceitos introdutórios, aplicação no serviço público e atividade prática.', audience: 'Servidores municipais',
        coordinatorId: 'gestor', responsibleId: 'tecnico', plannedYear: year, planRef: 'PDC-' + year, cost: hours * 85,
        resources: 'Sala, materiais didáticos e registro de frequência', history: [], createdAt: at(-30) });
      db.save('classes', { id: classId, actionId: id, title: 'Turma ' + id.slice(-2), status, capacity, startDate: day(start), endDate: day(end), place,
        instructorIds: [instructorId], minAttendance: 75, minGrade: null, eligibleOrgs: [], eligibleUnits: [],
        virtualPlannedHours: modality === 'hybrid' ? 4 : modality === 'online' ? hours : 0,
        ...(status === 'open' ? { enrollStart: day(-7), enrollEnd: day(3) } : {}), history: [] });
    }
    const schedule = [
      ['mt-01', 'tr-02', 'Mapeamento de processos', 1, '08:30', '12:30', 4, 'planned'],
      ['mt-02', 'tr-03', 'Práticas de mediação', 3, '14:00', '18:00', 4, 'planned'],
      ['mt-03', 'tr-01', 'Introdução e planilhas', 4, '08:00', '12:00', 4, 'planned'],
      ['mt-04', 'tr-02', 'Introdução à gestão por processos', -4, '08:30', '12:30', 4, 'done'],
      ['mt-05', 'tr-04', 'Fundamentos da administração pública', -15, '08:00', '12:00', 4, 'done'],
      ['mt-06', 'tr-04', 'Instrumentos de gestão', -12, '08:00', '12:00', 4, 'done'],
      ['mt-07', 'tr-04', 'Aplicação prática', -8, '08:00', '12:00', 4, 'done']
    ];
    for (const [id, classId, title, offset, startTime, endTime, plannedHours, status] of schedule) db.save('meetings', {
      id, classId, title, date: day(offset), startTime, endTime, plannedHours, status, actualHours: status === 'done' ? plannedHours : null,
      content: status === 'done' ? 'Conteúdo do encontro e exercício aplicado.' : '', attachments: [], history: []
    });
    for (const [id, classId, servantId, status, completion] of [
      ['reg-01', 'tr-04', 'serv-01', 'confirmed', 'completed'], ['reg-02', 'tr-04', 'serv-02', 'confirmed', 'pending'],
      ['reg-03', 'tr-02', 'serv-01', 'confirmed', 'pending'], ['reg-04', 'tr-03', 'serv-02', 'confirmed', 'pending'],
      ['reg-05', 'tr-01', 'serv-03', 'confirmed', 'pending'], ['reg-06', 'tr-02', 'serv-04', 'withdrawn', 'pending']
    ]) {
      const { name, cpf, matricula, org, unit, email, userId } = db.get('servants', servantId);
      db.save('registrations', { id, classId, servantId, name, cpf, matricula, org, unit, email, userId, status, completion,
        grade: null, virtualHours: 0, enrolledAt: at(-18), confirmedAt: at(-17), history: [] });
    }
    for (const registrationId of ['reg-01', 'reg-02']) for (const meetingId of ['mt-05', 'mt-06', 'mt-07']) db.save('attendance', {
      id: meetingId + ':' + registrationId, meetingId, registrationId, classId: 'tr-04', status: 'present', justification: ''
    });
    db.save('attendance', { id: 'mt-04:reg-03', meetingId: 'mt-04', registrationId: 'reg-03', classId: 'tr-02', status: 'present', justification: '' });
    db.save('evaluations', { id: 'eval-demo', title: 'Avaliação de reação · Fundamentos de gestão pública', type: 'reaction',
      actionId: 'ac-04', classId: 'tr-04', instructorId: '', enabled: true, availableAt: at(-3), closesAt: '',
      questions: [{ id: '1', prompt: 'Como você avalia a capacitação?', kind: 'rating' }, { id: '2', prompt: 'O que podemos melhorar?', kind: 'text' }] });
    db.save('certificates', { id: 'cert-demo', code: 'ED532C05470E4ACD80BEA212B7BA0DF1', status: 'active', classId: 'tr-04', actionId: 'ac-04',
      registrationId: 'reg-01', userId: 'servidor', servantId: 'serv-01', org: orgs.people, unit: 'Gestão de Pessoas', issuedAt: at(-7),
      snapshot: { name: 'Mariana Nascimento', title: 'Fundamentos de gestão pública', hours: 12,
        period: day(-15).split('-').reverse().join('/') + ' a ' + day(-8).split('-').reverse().join('/'),
        instructors: 'Paulo Ribeiro', institution: 'IMPARH · Escola de Governo', heading: 'Certificado de conclusão',
        footer: 'Documento fictício para demonstração do sistema.', issued: day(-7).split('-').reverse().join('/') } });
    db.save('notifications', { userId: 'admin', subject: 'Solicitação recebida', text: 'Atendimento humanizado ao cidadão aguarda análise.', link: '#requests', createdAt: at(-2), readAt: null });
    db.save('notifications', { userId: 'focal', subject: 'Solicitação em análise', text: 'A Escola de Governo iniciou a análise da capacitação sobre gestão e fiscalização de contratos.', link: '#requests', createdAt: at(-1), readAt: null });
    db.save('notifications', { userId: 'servidor', subject: 'Certificado disponível', text: 'Seu certificado de Fundamentos de gestão pública está disponível.', link: '#certificates', createdAt: at(-7), readAt: null });
    db.save('settings', { id: 'general', institution: 'IMPARH · Escola de Governo', planYear: year, annualTarget: 8, support: '' });
    db.save('settings', { id: 'demo-seeded', at: at(0) });
  });
}
