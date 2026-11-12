import { randomUUID } from 'node:crypto';
import { lookupServant, queueCanalRegistration, queueEmail } from './integrations.mjs';

const staffRoles = new Set(['admin', 'manager', 'tech', 'auditor']);
const requestStatuses = {
  draft: ['received'], received: ['review', 'complement', 'approved', 'rejected', 'canceled'],
  review: ['complement', 'approved', 'rejected', 'canceled'],
  complement: ['received', 'review', 'approved', 'rejected', 'canceled'],
  approved: ['canceled'], rejected: ['review', 'canceled'], canceled: []
};
const classStatuses = ['planned', 'open', 'ongoing', 'completed', 'canceled'];
const meetingStatuses = ['planned', 'done', 'canceled'];
const attendanceStatuses = ['present', 'absent', 'excused'];
const registrationStatuses = {
  pending: ['confirmed', 'waitlisted', 'rejected', 'canceled', 'withdrawn'],
  confirmed: ['canceled', 'withdrawn'], waitlisted: ['confirmed', 'rejected', 'canceled', 'withdrawn'],
  rejected: ['pending'], canceled: [], withdrawn: []
};
const duplicateStatuses = new Set(['pending', 'confirmed', 'waitlisted']);
const modalities = ['presential', 'online', 'hybrid'];
const localDate = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Fortaleza' });
const clean = (value) => String(value ?? '').trim();
const identity = (value) => clean(value).replace(/\D/g, '');
const match = (first, second) => clean(first).localeCompare(clean(second), 'pt-BR', { sensitivity: 'accent' }) === 0;

export const staff = (ctx) => staffRoles.has(ctx.user?.role);

export function canScope(user, record) {
  if (!user || !record) return false;
  const org = user.role === 'focal' ? user.org : user.scopeOrg;
  const unit = user.scopeUnit ?? '';
  if (user.role === 'focal' && !org) return false;
  return (!org || match(org, record.org)) && (!unit || match(unit, record.unit));
}

function ownEnrollment(user, registration) {
  return registration.userId === user.id || Boolean(user.servantId && user.servantId === registration.servantId);
}

function linkedInstructor(ctx, klass) {
  const instructorIds = [...classInstructorIds(ctx, klass), ...ctx.db.list('meetings').filter(item => item.classId === klass.id).flatMap(item => item.instructorIds ?? [])];
  return instructorIds.some(id => isInstructor(ctx, id));
}

const isInstructor = (ctx, id) => ctx.user.instructorId === id || ctx.db.get('instructors', id)?.userId === ctx.user.id;

function classInstructorIds(ctx, klass) {
  if (klass?.instructorIds?.length) return klass.instructorIds;
  return ctx.db.get('actions', klass?.actionId)?.instructorIds ?? [];
}

export function meetingInstructorIds(ctx, meeting) {
  return meeting.instructorIds?.length ? meeting.instructorIds : classInstructorIds(ctx, ctx.db.get('classes', meeting.classId));
}

function eligible(klass, servant) {
  return (!(klass.eligibleOrgs?.length) || klass.eligibleOrgs.some(org => match(org, servant.org))) &&
    (!(klass.eligibleUnits?.length) || klass.eligibleUnits.some(unit => match(unit, servant.unit)));
}

function openForRegistration(klass) {
  const today = localDate();
  return klass.status === 'open' && (!klass.enrollStart || today >= klass.enrollStart) && (!klass.enrollEnd || today <= klass.enrollEnd);
}

export function visibleClass(ctx, klass) {
  const action = ctx.db.get('actions', klass.actionId);
  if (!action || !canScope(ctx.user, action)) return false;
  if (staff(ctx)) return true;
  if (ctx.user.role === 'instructor') return linkedInstructor(ctx, klass);
  if (ctx.user.role === 'participant') {
    const servant = ctx.db.get('servants', ctx.user.servantId) ?? ctx.user;
    return (openForRegistration(klass) && eligible(klass, servant)) || ctx.db.list('registrations').some(item => item.classId === klass.id && ownEnrollment(ctx.user, item));
  }
  return false;
}

export function getEnrollmentClass(ctx, registration) {
  return registration && ctx.db.get('classes', registration.classId);
}

export function frequency(ctx, registration) {
  const klass = getEnrollmentClass(ctx, registration);
  if (!klass) return { percent: 0, hours: 0, denominator: 0 };
  const meetings = ctx.db.list('meetings').filter(item => item.classId === klass.id && item.status === 'done');
  const attendance = new Map(ctx.db.list('attendance').filter(item => item.registrationId === registration.id).map(item => [item.meetingId, item.status]));
  let denominator = 0;
  let hours = 0;
  for (const meeting of meetings) {
    const duration = Number(meeting.actualHours ?? meeting.plannedHours) || 0;
    denominator += duration;
    if (attendance.get(meeting.id) === 'present') hours += duration;
  }
  const action = ctx.db.get('actions', klass.actionId);
  const virtualPlanned = Math.max(0, Number(klass.virtualPlannedHours ?? (action?.modality === 'online' && !denominator ? action.hours : 0)) || 0);
  const virtualHours = Number(registration.virtualHours) || 0;
  if (virtualPlanned > 0) {
    denominator += virtualPlanned;
    const percent = registration.virtualAttendance;
    hours += percent == null ? Math.min(virtualHours, virtualPlanned) : Math.min(100, Math.max(0, Number(percent))) * virtualPlanned / 100;
  } else if (!denominator && registration.virtualAttendance != null) {
    return { percent: Math.min(100, Math.max(0, Number(registration.virtualAttendance) || 0)), hours: virtualHours, denominator: 0 };
  }
  return { percent: denominator ? Math.round(10000 * hours / denominator) / 100 : 0, hours: Math.round((virtualPlanned ? hours : hours + virtualHours) * 100) / 100, denominator };
}

function required(ctx, value, label, max = 300) {
  const str = clean(value);
  if (!str || str.length > max) ctx.fail(400, `Preencha ${label} com até ${max} caracteres.`);
  return str;
}

function optional(ctx, value, label, max = 300) {
  return value == null || clean(value) === '' ? '' : required(ctx, value, label, max);
}

function number(ctx, value, label, min = 0, max = 1000000, integer = false) {
  const result = Number(value);
  if (value == null || clean(value) === '' || !Number.isFinite(result) || result < min || result > max || (integer && !Number.isInteger(result))) ctx.fail(400, `Informe ${label} entre ${min} e ${max}.`);
  return result;
}

function maybeNumber(ctx, value, label, min, max, integer = false) {
  return value == null || clean(value) === '' ? null : number(ctx, value, label, min, max, integer);
}

function option(ctx, value, options, label) {
  if (!options.includes(value)) ctx.fail(400, `Selecione ${label}.`);
  return value;
}

function date(ctx, value, label, mandatory = false) {
  if (!value && !mandatory) return '';
  if (!/^\d{4}-\d\d-\d\d$/.test(value ?? '') || Number.isNaN(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) ctx.fail(400, `Informe uma data válida para ${label}.`);
  return value;
}

function dateRange(ctx, start, end, mandatory = false) {
  const startDate = date(ctx, start, 'início', mandatory);
  const endDate = date(ctx, end, 'término', mandatory);
  if (startDate && endDate && endDate < startDate) ctx.fail(400, 'A data de término deve ser posterior ou igual à data de início.');
  return { startDate, endDate };
}

function time(ctx, value, label) {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(value ?? '')) ctx.fail(400, `Informe um horário válido para ${label}.`);
  return value;
}

function safeUrl(ctx, value) {
  if (!value) return '';
  try {
    const parsed = new URL(value);
    if (['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password) return parsed.href;
  } catch { /* mensagem de validação abaixo */ }
  ctx.fail(400, 'Informe um endereço virtual HTTP ou HTTPS válido.');
}

function stringList(ctx, value, label, max = 50) {
  const arr = Array.isArray(value) ? value : clean(value).split(/[,;\n]+/);
  if (arr.length > max) ctx.fail(400, `Use até ${max} itens em ${label}.`);
  return [...new Set(arr.map(item => optional(ctx, item, label, 180)).filter(Boolean))];
}

function attachments(ctx, value, original = []) {
  if (value === undefined) return original;
  if (!Array.isArray(value) || value.length > 8) ctx.fail(400, 'Anexe até oito arquivos.');
  let total = 0;
  return value.map(file => {
    const data = file?.data;
    if (typeof data !== 'string' || data.length > 2800000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) ctx.fail(400, 'Cada anexo deve conter um arquivo de até 2 MB.');
    total += data.length;
    if (total > 8000000) ctx.fail(400, 'O total de anexos ultrapassa 6 MB.');
    return { name: required(ctx, file.name, 'nome do arquivo', 180).replace(/[\\/\p{Cc}]/gu, '_'), data };
  });
}

function get(ctx, type, id) {
  const item = id && ctx.db.get(type, id);
  if (!item) ctx.fail(404, 'Registro não encontrado.');
  return item;
}

function inScope(ctx, item) {
  if (!canScope(ctx.user, item)) ctx.fail(403, 'Seu perfil não possui acesso a este órgão ou unidade.');
  return item;
}

function writableClass(ctx, id) {
  const klass = get(ctx, 'classes', id);
  if (!staff(ctx) || !visibleClass(ctx, klass)) ctx.fail(403, 'A turma está fora do seu escopo.');
  return klass;
}

function modelHistory(ctx, old, action, details) {
  return [...(old?.history ?? []), { action, details, userId: ctx.user.id, userName: ctx.user.name, at: ctx.now() }];
}

function saveRecord(ctx, type, previous, next, event, details = {}) {
  const stored = ctx.db.save(type, {
    ...next, id: previous?.id ?? next.id ?? randomUUID(), updatedAt: ctx.now(), createdAt: previous?.createdAt ?? next.createdAt ?? ctx.now(),
    history: modelHistory(ctx, previous, event, details)
  });
  ctx.audit(event, type, stored.id, details);
  return stored;
}

function notifyRegistration(ctx, registration, title, message) {
  if (registration.userId) ctx.notify(registration.userId, title, message, '#history');
  else if (!ctx.app?.demo && registration.email) queueEmail(ctx.db, { id: randomUUID(), to: registration.email, subject: title, text: message, link: '#history', createdAt: ctx.now() });
}

function notifyClass(ctx, klass, subject, text) {
  for (const registration of ctx.db.list('registrations').filter(item => item.classId === klass.id && item.status === 'confirmed')) {
    notifyRegistration(ctx, registration, subject, text);
  }
  for (const id of classInstructorIds(ctx, klass)) {
    const userId = ctx.db.get('instructors', id)?.userId;
    if (userId) ctx.notify(userId, subject, text, '#calendar');
  }
}

function synchronizeClass(ctx, klass, action) {
  if (ctx.app?.demo) return;
  for (const enrollment of ctx.db.list('registrations').filter(item => item.classId === klass.id)) queueCanalRegistration(ctx.db, enrollment, klass, action);
}

function requestNotice(ctx, request, subject, message) {
  if (request.userId) ctx.notify(request.userId, subject, message, '#requests');
}

function classForMeeting(ctx, meeting) {
  return get(ctx, 'classes', meeting.classId);
}

function classCapacity(ctx, klass) {
  return ctx.db.list('registrations').filter(item => item.classId === klass.id && item.status === 'confirmed').length;
}

function readRequests(ctx) {
  if (!staff(ctx) && ctx.user.role !== 'focal') return [];
  return ctx.db.list('requests').filter(record => canScope(ctx.user, record) && (record.status !== 'draft' || record.userId === ctx.user.id))
    .map(record => ({ ...record, responsibleName: record.responsibleName || ctx.db.get('users', record.responsibleId)?.name || '' }));
}

function readActions(ctx) {
  const classes = ctx.db.list('classes').filter(klass => visibleClass(ctx, klass));
  const actionIds = new Set(classes.map(item => item.actionId));
  const actions = ctx.db.list('actions').filter(item => canScope(ctx.user, item) && (staff(ctx) || actionIds.has(item.id)));
  return { actions, classes };
}

function scopedInstructors(ctx) {
  const { actions, classes } = readActions(ctx);
  const classIds = new Set(classes.map(item => item.id));
  const meetings = ctx.db.list('meetings').filter(item => classIds.has(item.classId));
  const visibleIds = new Set([...actions, ...classes, ...meetings].flatMap(item => item.instructorIds ?? []));
  return ctx.db.list('instructors').filter(item => (staff(ctx) && canScope(ctx.user, item)) || visibleIds.has(item.id) || item.userId === ctx.user.id);
}

function summarizeInstructor(instructor) {
  return { id: instructor.id, name: instructor.name, topics: instructor.topics };
}

function readRegistrations(ctx) {
  return ctx.db.list('registrations').filter(record => {
    const klass = getEnrollmentClass(ctx, record);
    if (!klass || !visibleClass(ctx, klass)) return false;
    return (staff(ctx) && canScope(ctx.user, record)) || ctx.user.role === 'instructor' || ownEnrollment(ctx.user, record);
  }).map(record => {
    if (ctx.user.role !== 'instructor') return { ...record, frequency: frequency(ctx, record) };
    return { id: record.id, classId: record.classId, name: record.name, status: record.status, confirmedAt: record.confirmedAt, frequency: frequency(ctx, record) };
  });
}

function availableStaff(ctx) {
  return ctx.db.list('users').filter(user => ['admin', 'manager', 'tech'].includes(user.role) && user.active !== false).map(({ id, name, org, unit }) => ({ id, name, org, unit }));
}

function saveRequest(ctx, previous, send) {
  const actor = ctx.user;
  if (actor.role !== 'focal' && !staff(ctx)) ctx.fail(403, 'Seu perfil não pode registrar solicitações.');
  if (previous && (!['draft', 'complement'].includes(previous.status) || previous.userId !== actor.id)) ctx.fail(409, 'Esta solicitação não está aberta para edição pelo solicitante.');
  const input = ctx.body;
  const field = send ? required : optional;
  const org = required(ctx, actor.role === 'focal' ? actor.org : (input.org || actor.org), 'órgão');
  const unit = required(ctx, input.unit || actor.unit, 'unidade administrativa');
  inScope(ctx, { org, unit });
  const request = {
    ...previous, org, unit, userId: actor.id, requester: actor.name, email: actor.email,
    title: field(ctx, input.title, 'tema da capacitação'), audience: field(ctx, input.audience, 'público-alvo', 1500),
    participants: send ? number(ctx, input.participants, 'quantidade estimada', 1, 10000, true) : maybeNumber(ctx, input.participants, 'quantidade estimada', 1, 10000, true),
    modality: input.modality || send ? option(ctx, input.modality, modalities, 'modalidade') : '',
    hours: send ? number(ctx, input.hours, 'carga horária', 0.25, 10000) : maybeNumber(ctx, input.hours, 'carga horária', 0.25, 10000),
    ...dateRange(ctx, input.startDate, input.endDate, send), place: optional(ctx, input.place, 'local'),
    needsInstructor: input.needsInstructor === true, attachments: attachments(ctx, input.attachments, previous?.attachments),
    status: send ? 'received' : previous?.status ?? 'draft'
  };
  if (send) {
    request.protocol = previous?.protocol || `EG-${localDate().slice(0, 4)}-${randomUUID().replaceAll('-', '').slice(0, 12).toUpperCase()}`;
    request.submittedAt = previous?.submittedAt || ctx.now();
    request.lastSubmissionAt = ctx.now();
  }
  return ctx.db.tx(() => {
    const stored = saveRecord(ctx, 'requests', previous, request, send ? 'Envio de solicitação' : 'Edição de solicitação', { status: request.status, protocol: request.protocol });
    if (send) requestNotice(ctx, stored, `Solicitação ${stored.protocol} recebida`, `A Escola de Governo recebeu a solicitação ${stored.title}.`);
    return stored;
  });
}

function reviewRequest(ctx) {
  const previous = inScope(ctx, get(ctx, 'requests', ctx.params.id));
  if (!staff(ctx) || previous.status === 'draft') ctx.fail(403, 'Esta solicitação ainda não foi enviada à Escola de Governo.');
  const input = ctx.body;
  const status = input.status ?? previous.status;
  if (status !== previous.status && !requestStatuses[previous.status]?.includes(status)) ctx.fail(409, 'A alteração de situação não é permitida nesta etapa.');
  const observation = optional(ctx, input.observation, 'observação', 6000);
  const opinion = optional(ctx, input.opinion, 'parecer', 10000);
  if (status === 'complement' && previous.status !== status && !observation && !opinion) ctx.fail(400, 'Informe a complementação solicitada.');
  const responsibleId = input.responsibleId === undefined ? previous.responsibleId : clean(input.responsibleId);
  const assigned = responsibleId && ctx.db.get('users', responsibleId);
  if (responsibleId && (!assigned || !availableStaff(ctx).some(item => item.id === responsibleId) || !canScope(assigned, previous))) ctx.fail(400, 'Selecione um responsável técnico ativo com acesso ao órgão.');
  const responsibleName = assigned?.name ?? '';
  const groupId = input.groupId === undefined ? previous.groupId : optional(ctx, input.groupId, 'agrupamento', 120);
  return ctx.db.tx(() => {
    const updated = saveRecord(ctx, 'requests', previous, { ...previous, status, responsibleId, responsibleName, groupId, opinion: opinion || previous.opinion }, 'Tramitação de solicitação', { from: previous.status, status, responsibleId, responsibleName, groupId, observation, opinion });
    if (status !== previous.status) requestNotice(ctx, updated, `Atualização da solicitação ${updated.protocol}`, `A solicitação ${updated.title} está ${requestStatusLabel[status]}. ${observation || opinion}`);
    return updated;
  });
}

const requestStatusLabel = { draft: 'em rascunho', received: 'recebida', review: 'em análise', complement: 'aguardando complementação', approved: 'aprovada', rejected: 'não aprovada', canceled: 'cancelada' };

function requestedInstructors(ctx, values) {
  const ids = stringList(ctx, values, 'instrutores');
  const allowed = new Set(scopedInstructors(ctx).map(item => item.id));
  if (ids.some(id => !allowed.has(id))) ctx.fail(400, 'Selecione instrutores cadastrados no seu escopo.');
  return ids;
}

function responsible(ctx, value) {
  const id = clean(value);
  if (id && !availableStaff(ctx).some(item => item.id === id)) ctx.fail(400, 'Selecione um integrante ativo da Escola de Governo.');
  return id;
}

function saveAction(ctx, previous) {
  if (!staff(ctx)) ctx.fail(403, 'Seu perfil não pode planejar ações.');
  const input = ctx.body;
  const requestIds = stringList(ctx, input.requestIds ?? input.requestId, 'solicitações');
  const sources = requestIds.map(id => inScope(ctx, get(ctx, 'requests', id)));
  if (sources.some(item => item.status !== 'approved' && !(previous?.requestIds ?? [previous?.requestId]).includes(item.id))) ctx.fail(409, 'Vincule apenas solicitações aprovadas.');
  const source = sources[0];
  const org = required(ctx, input.org || source?.org || ctx.user.org, 'órgão de referência');
  const unit = optional(ctx, input.unit || source?.unit || ctx.user.unit, 'unidade de referência');
  inScope(ctx, { org, unit });
  const record = {
    ...previous, org, unit, requestId: source?.id ?? '', requestIds,
    title: required(ctx, input.title, 'título'), description: required(ctx, input.description, 'descrição', 10000), program: required(ctx, input.program, 'conteúdo programático', 16000),
    modality: option(ctx, input.modality, modalities, 'modalidade'), hours: number(ctx, input.hours, 'carga horária', 0.25, 10000),
    ...dateRange(ctx, input.startDate, input.endDate, true), schedule: optional(ctx, input.schedule, 'dias e horários', 500), place: optional(ctx, input.place, 'local'), virtualUrl: safeUrl(ctx, input.virtualUrl),
    capacity: number(ctx, input.capacity, 'vagas', 1, 10000, true), audience: required(ctx, input.audience, 'público autorizado', 1500),
    instructorIds: requestedInstructors(ctx, input.instructorIds), coordinatorId: responsible(ctx, input.coordinatorId), responsibleId: responsible(ctx, input.responsibleId),
    cost: maybeNumber(ctx, input.cost, 'custo', 0, 1000000000), resources: optional(ctx, input.resources, 'recursos necessários', 6000),
    plannedYear: maybeNumber(ctx, input.plannedYear, 'ano do plano', 2000, 2200, true), planRef: optional(ctx, input.planRef, 'referência do plano anual')
  };
  const oldClasses = previous ? ctx.db.list('classes').filter(item => item.actionId === previous.id) : [];
  if (oldClasses.some(klass => klass.status !== 'canceled' && (klass.startDate < record.startDate || klass.endDate > record.endDate))) ctx.fail(409, 'As datas da ação devem abranger suas turmas ativas.');
  const changes = changesIn(previous, record, ['startDate', 'endDate', 'schedule', 'place', 'virtualUrl', 'capacity', 'instructorIds']);
  return ctx.db.tx(() => {
    const stored = saveRecord(ctx, 'actions', previous, record, previous ? 'Alteração de ação' : 'Cadastro de ação', changes);
    if (Object.keys(changes).length) for (const klass of oldClasses.filter(item => !['completed', 'canceled'].includes(item.status))) notifyClass(ctx, klass, 'Planejamento da ação atualizado', `${stored.title}. Consulte os dados da turma e o calendário.`);
    if (Object.keys(changesIn(previous, record, ['title', 'modality', 'hours', 'startDate', 'endDate'])).length) for (const klass of oldClasses) synchronizeClass(ctx, klass, stored);
    return stored;
  });
}

function changesIn(previous, next, fields) {
  if (!previous) return {};
  return Object.fromEntries(fields.filter(key => JSON.stringify(previous[key]) !== JSON.stringify(next[key])).map(key => [key, { from: previous[key], to: next[key] }]));
}

function saveClass(ctx, previous) {
  if (!staff(ctx)) ctx.fail(403, 'Seu perfil não pode planejar turmas.');
  const input = ctx.body;
  const action = inScope(ctx, get(ctx, 'actions', previous?.actionId ?? input.actionId));
  const dates = dateRange(ctx, input.startDate, input.endDate, true);
  if (dates.startDate < action.startDate || dates.endDate > action.endDate) ctx.fail(400, 'O período da turma deve estar dentro do período da ação.');
  const enrollmentDates = dateRange(ctx, input.enrollStart, input.enrollEnd);
  const capacity = number(ctx, input.capacity, 'vagas', 1, 10000, true);
  const status = option(ctx, input.status ?? 'planned', classStatuses, 'situação da turma');
  if (previous && classCapacity(ctx, previous) > capacity) ctx.fail(409, 'O novo total de vagas é inferior ao total de inscrições confirmadas.');
  if (previous && ctx.db.list('meetings').some(item => item.classId === previous.id && item.status !== 'canceled' && (item.date < dates.startDate || item.date > dates.endDate))) ctx.fail(409, 'O período da turma deve abranger seus encontros ativos.');
  const record = {
    ...previous, actionId: action.id, title: required(ctx, input.title, 'nome da turma'), ...dates, capacity, status,
    schedule: optional(ctx, input.schedule, 'dias e horários', 500), place: optional(ctx, input.place, 'local'), virtualUrl: safeUrl(ctx, input.virtualUrl),
    instructorIds: requestedInstructors(ctx, input.instructorIds),
    audience: optional(ctx, input.audience, 'público-alvo', 1500), eligibleOrgs: stringList(ctx, input.eligibleOrgs, 'órgãos elegíveis'), eligibleUnits: stringList(ctx, input.eligibleUnits, 'unidades elegíveis'),
    enrollStart: enrollmentDates.startDate, enrollEnd: enrollmentDates.endDate, requiresApproval: input.requiresApproval === true,
    minAttendance: number(ctx, input.minAttendance ?? 75, 'frequência mínima', 0, 100), minGrade: maybeNumber(ctx, input.minGrade, 'nota mínima', 0, 100),
    virtualPlannedHours: maybeNumber(ctx, input.virtualPlannedHours, 'carga horária virtual prevista', 0, action.hours)
  };
  const changes = changesIn(previous, record, ['title', 'startDate', 'endDate', 'schedule', 'place', 'virtualUrl', 'instructorIds', 'capacity', 'status']);
  return ctx.db.tx(() => {
    const updated = saveRecord(ctx, 'classes', previous, record, previous ? 'Alteração de turma' : 'Cadastro de turma', changes);
    if (Object.keys(changes).length) notifyClass(ctx, updated, 'Turma atualizada', `${updated.title}. Consulte os dados atualizados e o calendário.`);
    if (previous && updated.status === 'open' && (updated.capacity > previous.capacity || updated.status !== previous.status)) promoteWaiting(ctx, updated);
    if (Object.keys(changesIn(previous, record, ['startDate', 'endDate', 'status'])).length) synchronizeClass(ctx, updated, action);
    return updated;
  });
}

function saveMeeting(ctx, previous) {
  const input = ctx.body;
  const klass = writableClass(ctx, previous?.classId ?? input.classId);
  const meetingDate = date(ctx, input.date, 'encontro', true);
  if (meetingDate < klass.startDate || meetingDate > klass.endDate) ctx.fail(400, 'A data do encontro deve estar dentro do período da turma.');
  const startTime = time(ctx, input.startTime, 'início');
  const endTime = time(ctx, input.endTime, 'término');
  if (endTime <= startTime) ctx.fail(400, 'O horário de término deve ser posterior ao de início.');
  const status = option(ctx, input.status ?? 'planned', meetingStatuses, 'situação do encontro');
  const instructorIds = stringList(ctx, input.instructorIds ?? previous?.instructorIds, 'instrutores do encontro');
  const available = classInstructorIds(ctx, klass);
  if (instructorIds.some(id => !available.includes(id) && !previous?.instructorIds?.includes(id))) ctx.fail(400, 'Selecione instrutores vinculados à turma.');
  const replacementId = clean(input.replacementOfId ?? previous?.replacementOfId);
  if (replacementId) {
    const origin = get(ctx, 'meetings', replacementId);
    if (origin.id === previous?.id || origin.classId !== klass.id || origin.status !== 'canceled') ctx.fail(400, 'Escolha um encontro cancelado desta turma para a reposição.');
    if (ctx.db.list('meetings').some(item => item.replacementOfId === replacementId && item.id !== previous?.id && item.status !== 'canceled')) ctx.fail(409, 'Já existe uma reposição ativa para este encontro.');
  }
  const record = {
    ...previous, classId: klass.id, title: required(ctx, input.title, 'título do encontro'), date: meetingDate, startTime, endTime, status, replacementOfId: replacementId,
    instructorIds: instructorIds.length ? instructorIds : available,
    plannedHours: number(ctx, input.plannedHours, 'carga horária planejada', 0.25, 24),
    actualHours: status === 'done' ? number(ctx, input.actualHours, 'carga horária realizada', 0.25, 24) : null,
    place: optional(ctx, input.place, 'local'), content: optional(ctx, input.content, 'conteúdo', 12000), occurrences: optional(ctx, input.occurrences, 'ocorrências', 12000),
    attachments: attachments(ctx, input.attachments, previous?.attachments)
  };
  const changes = changesIn(previous, record, ['title', 'date', 'startTime', 'endTime', 'status', 'place', 'plannedHours', 'actualHours', 'instructorIds', 'replacementOfId']);
  return ctx.db.tx(() => {
    const stored = saveRecord(ctx, 'meetings', previous, record, previous ? 'Alteração de encontro' : 'Cadastro de encontro', changes);
    if (replacementId || ['date', 'startTime', 'endTime', 'place', 'status'].some(field => Object.hasOwn(changes, field))) notifyClass(ctx, klass, 'Cronograma atualizado', `${klass.title}. Consulte a programação do encontro ${stored.title}.`);
    return stored;
  });
}

function saveInstructor(ctx, previous) {
  if (!staff(ctx)) ctx.fail(403, 'Seu perfil não pode cadastrar instrutores.');
  const input = ctx.body;
  const name = required(ctx, input.name, 'nome');
  const org = optional(ctx, input.org || ctx.user.org, 'órgão');
  const unit = optional(ctx, input.unit || ctx.user.unit, 'unidade');
  inScope(ctx, { org, unit });
  const userId = clean(input.userId);
  if (userId && get(ctx, 'users', userId).role !== 'instructor') ctx.fail(400, 'Vincule uma conta com perfil de instrutor.');
  if (userId && ctx.db.list('instructors').some(item => item.userId === userId && item.id !== previous?.id)) ctx.fail(409, 'A conta selecionada já está vinculada a outro cadastro de instrutor.');
  const cpf = identity(input.cpf);
  if (cpf && cpf.length !== 11) ctx.fail(400, 'Informe os 11 dígitos do CPF.');
  if (cpf && ctx.db.list('instructors').some(item => item.cpf === cpf && item.id !== previous?.id)) ctx.fail(409, 'Já existe um instrutor com este CPF.');
  const email = optional(ctx, input.email, 'e-mail');
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) ctx.fail(400, 'Informe um e-mail válido.');
  const record = {
    ...previous, name, cpf, email, userId, org, unit,
    matricula: optional(ctx, input.matricula, 'matrícula', 60), phone: optional(ctx, input.phone, 'telefone', 60), roleName: optional(ctx, input.roleName, 'cargo ou função'),
    education: optional(ctx, input.education, 'formação acadêmica', 2000), degree: optional(ctx, input.degree, 'titulação'), resume: optional(ctx, input.resume, 'currículo', 12000), experience: optional(ctx, input.experience, 'experiência', 6000),
    areas: stringList(ctx, input.areas, 'áreas de conhecimento'), topics: stringList(ctx, input.topics, 'temas de atuação'),
    credentialStatus: option(ctx, input.credentialStatus ?? 'pending', ['pending', 'active', 'expired', 'suspended'], 'situação do credenciamento'),
    expiresOn: date(ctx, input.expiresOn, 'validade documental'), annualLimit: maybeNumber(ctx, input.annualLimit, 'limite anual de horas', 0, 10000),
    hourlyRate: maybeNumber(ctx, input.hourlyRate, 'valor da hora-aula', 0, 100000), rateRule: optional(ctx, input.rateRule, 'regra de referência'),
    attachments: attachments(ctx, input.attachments, previous?.attachments)
  };
  return ctx.db.tx(() => saveRecord(ctx, 'instructors', previous, record, previous ? 'Alteração de instrutor' : 'Cadastro de instrutor', changesIn(previous, record, ['credentialStatus', 'expiresOn', 'annualLimit', 'hourlyRate', 'rateRule'])));
}

function resolveServant(ctx, input) {
  if (ctx.user.role === 'participant') {
    if (!ctx.user.servantId) ctx.fail(422, 'Seu acesso ainda precisa ser vinculado à base de servidores.');
    const person = get(ctx, 'servants', ctx.user.servantId);
    if (input.cpf && identity(input.cpf) !== identity(person.cpf)) ctx.fail(403, 'O CPF não corresponde ao seu cadastro.');
    if (input.matricula && !match(input.matricula, person.matricula)) ctx.fail(403, 'A matrícula não corresponde ao seu cadastro.');
    return Promise.resolve(person);
  }
  if (!staff(ctx)) ctx.fail(403, 'Seu perfil não pode consultar a base de servidores.');
  const cpf = identity(input.cpf);
  const matricula = required(ctx, input.matricula, 'matrícula', 80);
  if (cpf.length !== 11) ctx.fail(400, 'Informe os 11 dígitos do CPF.');
  return lookupServant(ctx, { cpf, matricula });
}

async function findActiveServant(ctx, input) {
  const person = await resolveServant(ctx, input);
  if (!person || person.active === false) ctx.fail(404, 'Servidor ativo não localizado com o CPF e a matrícula informados.');
  if (identity(person.cpf).length !== 11 || !clean(person.matricula)) ctx.fail(422, 'O cadastro funcional precisa conter a matrícula e os 11 dígitos do CPF.');
  if (staff(ctx)) inScope(ctx, person);
  return person;
}

function enrollmentRecord(ctx, klass, person, status, replacedId = '') {
  return {
    classId: klass.id, servantId: person.id, userId: (ctx.user.role === 'participant' ? ctx.user.id : person.userId) || ctx.db.list('users').find(user => user.servantId === person.id)?.id || '',
    name: person.name, cpf: person.cpf, matricula: person.matricula, org: person.org, unit: person.unit, email: person.email,
    status, completion: 'pending', grade: null, virtualHours: 0, replacedId,
    enrolledAt: ctx.now(), confirmedAt: status === 'confirmed' ? ctx.now() : null
  };
}

function checkEnrollment(ctx, klass, person) {
  if (!eligible(klass, person)) ctx.fail(422, 'O órgão ou a unidade do servidor está fora dos critérios desta turma.');
  if (ctx.db.list('registrations').some(item => item.classId === klass.id && item.servantId === person.id && duplicateStatuses.has(item.status))) ctx.fail(409, 'Já existe uma inscrição ativa do servidor nesta turma.');
}

const registrationStatusLabel = { pending: 'pendente de análise', confirmed: 'confirmada', waitlisted: 'na lista de espera', rejected: 'indeferida', canceled: 'cancelada', withdrawn: 'com desistência registrada' };

function notifyEnrollment(ctx, record, klass) {
  notifyRegistration(ctx, record, `Inscrição em ${klass.title}`, `Sua inscrição está ${registrationStatusLabel[record.status]}.`);
}

async function saveEnrollment(ctx) {
  const input = ctx.body;
  const person = await findActiveServant(ctx, input);
  return ctx.db.tx(() => {
    const klass = get(ctx, 'classes', input.classId);
    if (!visibleClass(ctx, klass)) ctx.fail(403, 'Seu perfil não pode acessar esta turma.');
    if (staff(ctx) ? !['planned', 'open', 'ongoing'].includes(klass.status) : !openForRegistration(klass)) ctx.fail(409, 'A turma não está aceitando inscrições.');
    checkEnrollment(ctx, klass, person);
    const status = klass.requiresApproval ? 'pending' : classCapacity(ctx, klass) >= klass.capacity ? 'waitlisted' : 'confirmed';
    const record = saveRecord(ctx, 'registrations', null, enrollmentRecord(ctx, klass, person, status), 'Cadastro de inscrição', { status });
    notifyEnrollment(ctx, record, klass);
    return record;
  });
}

function promoteWaiting(ctx, klass) {
  if (!['planned', 'open', 'ongoing'].includes(klass.status)) return;
  const available = klass.capacity - classCapacity(ctx, klass);
  if (available < 1) return;
  const waiting = ctx.db.list('registrations').filter(item => item.classId === klass.id && item.status === 'waitlisted' && eligible(klass, item)).sort((a, b) => (a.waitlistedAt ?? a.enrolledAt ?? '').localeCompare(b.waitlistedAt ?? b.enrolledAt ?? ''));
  for (const next of waiting.slice(0, available)) {
    const record = saveRecord(ctx, 'registrations', next, { ...next, status: 'confirmed', confirmedAt: ctx.now() }, 'Convocação da lista de espera', { from: next.status, status: 'confirmed' });
    notifyEnrollment(ctx, record, klass);
  }
}

async function reviewEnrollment(ctx) {
  const input = ctx.body;
  const isStaff = staff(ctx);
  if (isStaff && !ctx.check('registrations.review')) ctx.fail(403, 'Seu perfil não pode analisar inscrições.');
  const substitution = input.replace === true;
  if (substitution && !isStaff) ctx.fail(403, 'Substituição disponível para a equipe da Escola de Governo.');
  const reason = optional(ctx, input.reason, 'motivo', 3000);
  const replacement = substitution ? await findActiveServant(ctx, input) : null;
  return ctx.db.tx(() => {
    const previous = get(ctx, 'registrations', ctx.params.id);
    const klass = getEnrollmentClass(ctx, previous);
    if (!klass || !visibleClass(ctx, klass) || (isStaff ? !canScope(ctx.user, previous) : !ownEnrollment(ctx.user, previous))) ctx.fail(403, 'Esta inscrição está fora do seu escopo.');
    const status = substitution ? 'withdrawn' : input.status ?? previous.status;
    if (!isStaff && (status !== 'withdrawn' || status === previous.status)) ctx.fail(403, 'Seu perfil pode registrar desistência da própria inscrição.');
    if (status !== previous.status && !registrationStatuses[previous.status]?.includes(status)) ctx.fail(409, 'A alteração de inscrição não é permitida nesta etapa.');
    if (status !== previous.status && ['confirmed', 'waitlisted', 'pending'].includes(status) && !['planned', 'open', 'ongoing'].includes(klass.status)) ctx.fail(409, 'A situação da turma impede novas confirmações.');
    if (status !== previous.status && duplicateStatuses.has(status)) {
      if (!eligible(klass, previous)) ctx.fail(422, 'O órgão ou a unidade do servidor está fora dos critérios desta turma.');
      if (!duplicateStatuses.has(previous.status) && ctx.db.list('registrations').some(item => item.classId === klass.id && item.servantId === previous.servantId && item.id !== previous.id && duplicateStatuses.has(item.status))) ctx.fail(409, 'Já existe outra inscrição ativa deste servidor na turma.');
    }
    if (status === 'confirmed' && previous.status !== 'confirmed' && classCapacity(ctx, klass) >= klass.capacity) ctx.fail(409, 'A turma está lotada. Registre a inscrição na lista de espera.');
    if (substitution) {
      if (previous.status !== 'confirmed' || !['planned', 'open', 'ongoing'].includes(klass.status)) ctx.fail(409, 'Substituição disponível para uma inscrição confirmada em turma ativa.');
      checkEnrollment(ctx, klass, replacement);
    }
    const grade = input.grade === undefined ? previous.grade : maybeNumber(ctx, input.grade, 'nota', 0, 100);
    const completion = input.completion === undefined ? previous.completion : option(ctx, input.completion, ['pending', 'completed', 'not_completed'], 'conclusão');
    if (!isStaff && (input.grade !== undefined || input.completion !== undefined)) ctx.fail(403, 'A nota e a conclusão são editadas pela Escola de Governo.');
    if (completion === 'completed' && status !== 'confirmed' && previous.completion !== 'completed') ctx.fail(409, 'Registre a conclusão em uma inscrição confirmada.');
    const updated = saveRecord(ctx, 'registrations', previous, {
      ...previous, status, grade, completion, gradeSource: input.grade === undefined || grade === previous.grade ? previous.gradeSource : 'manual',
      confirmedAt: status === 'confirmed' ? previous.confirmedAt ?? ctx.now() : previous.confirmedAt,
      waitlistedAt: status === 'waitlisted' ? previous.waitlistedAt ?? ctx.now() : previous.waitlistedAt
    }, substitution ? 'Substituição de participante' : 'Alteração de inscrição', { from: previous.status, status, reason, grade, completion });
    if (status !== previous.status) notifyEnrollment(ctx, updated, klass);
    if (!ctx.app?.demo && (status !== previous.status || completion !== previous.completion)) queueCanalRegistration(ctx.db, updated, klass);
    if (substitution) {
      const record = saveRecord(ctx, 'registrations', null, enrollmentRecord(ctx, klass, replacement, 'confirmed', previous.id), 'Confirmação por substituição', { replacedId: previous.id });
      notifyEnrollment(ctx, record, klass);
      return { registration: updated, replacement: record };
    }
    if (previous.status === 'confirmed' && ['withdrawn', 'canceled'].includes(status)) promoteWaiting(ctx, klass);
    return { registration: updated };
  });
}

function recordAttendance(ctx) {
  const previous = get(ctx, 'meetings', ctx.params.id);
  const klass = classForMeeting(ctx, previous);
  if (!visibleClass(ctx, klass) || (!staff(ctx) && (ctx.user.role !== 'instructor' || !meetingInstructorIds(ctx, previous).some(id => isInstructor(ctx, id))))) ctx.fail(403, 'O encontro está fora do seu escopo.');
  if (previous.status === 'canceled' || klass.status === 'canceled') ctx.fail(409, 'O encontro ou a turma está cancelado.');
  const input = ctx.body;
  const rows = input.rows ?? [];
  if (!Array.isArray(rows) || rows.length > 10000) ctx.fail(400, 'Envie até 10.000 registros por encontro.');
  const list = ctx.db.list('registrations').filter(item => item.classId === klass.id && (item.status === 'confirmed' || (item.confirmedAt && ['withdrawn', 'canceled'].includes(item.status))) && (!staff(ctx) || canScope(ctx.user, item)));
  const byId = new Map(list.map(item => [item.id, item]));
  const byNumber = new Map(list.map(item => [clean(item.matricula), item]));
  const processed = new Set();
  const entries = rows.map((row, index) => {
    const enrollment = row.registrationId ? byId.get(row.registrationId) : byNumber.get(clean(row.matricula));
    if (!enrollment) ctx.fail(400, `Linha ${index + 1}: inscrição elegível não encontrada nesta turma.`);
    if (processed.has(enrollment.id)) ctx.fail(400, `Linha ${index + 1}: inscrição repetida no mesmo lançamento.`);
    processed.add(enrollment.id);
    const status = option(ctx, row.status, attendanceStatuses, `a frequência da linha ${index + 1}`);
    const justification = optional(ctx, row.justification, 'justificativa', 3000);
    if (status === 'excused' && !justification) ctx.fail(400, `Linha ${index + 1}: informe a justificativa da ausência.`);
    return { id: `${previous.id}:${enrollment.id}`, meetingId: previous.id, registrationId: enrollment.id, classId: klass.id, status, justification };
  });
  const updatedMeeting = { ...previous, attachments: attachments(ctx, input.attachments, previous.attachments) };
  return ctx.db.tx(() => {
    for (const row of entries) {
      const old = ctx.db.get('attendance', row.id);
      if (old?.status === row.status && old.justification === row.justification) continue;
      saveRecord(ctx, 'attendance', old, row, 'Lançamento de frequência', { meetingId: previous.id, from: old?.status, status: row.status });
    }
    if (input.attachments !== undefined) saveRecord(ctx, 'meetings', previous, updatedMeeting, 'Anexação de lista de frequência', { files: updatedMeeting.attachments.map(item => item.name) });
    return { count: entries.length };
  });
}

export function registerWorkflow(app) {
  app.route('GET', '/api/workflow/requests', 'requests.read', ctx => ({ requests: readRequests(ctx), staff: staff(ctx) ? availableStaff(ctx) : [] }));
  app.route('POST', '/api/requests', 'requests.write', ctx => saveRequest(ctx, null, ctx.body.send === true));
  app.route('PUT', '/api/requests/:id', 'requests.write', ctx => saveRequest(ctx, inScope(ctx, get(ctx, 'requests', ctx.params.id)), ctx.body.send === true));
  app.route('POST', '/api/requests/:id/review', 'requests.review', reviewRequest);

  app.route('GET', '/api/workflow/actions', 'actions.read', ctx => {
    const { actions, classes } = readActions(ctx);
    const ids = new Set(classes.map(item => item.id));
    const meetings = ctx.db.list('meetings').filter(item => ids.has(item.classId));
    const counts = Object.fromEntries(classes.map(item => [item.id, { confirmed: classCapacity(ctx, item) }]));
    return {
      actions: actions.map(item => staff(ctx) ? item : publicAction(item, classes.some(klass => klass.actionId === item.id && canViewVirtual(ctx, klass)))),
      classes: classes.map(item => staff(ctx) ? item : publicClass(item, canViewVirtual(ctx, item))), counts,
      meetings: meetings.map(item => staff(ctx) ? item : publicMeeting(item)), instructors: scopedInstructors(ctx).map(summarizeInstructor),
      requests: staff(ctx) ? readRequests(ctx).filter(item => item.status === 'approved').map(({ id, protocol, title, audience, modality, hours, participants, startDate, endDate, place, org, unit, groupId }) => ({ id, protocol, title, audience, modality, hours, participants, startDate, endDate, place, org, unit, groupId })) : [],
      staff: staff(ctx) ? availableStaff(ctx) : []
    };
  });
  app.route('POST', '/api/actions', 'actions.write', ctx => saveAction(ctx, null));
  app.route('PUT', '/api/actions/:id', 'actions.write', ctx => saveAction(ctx, inScope(ctx, get(ctx, 'actions', ctx.params.id))));
  app.route('POST', '/api/classes', 'actions.write', ctx => saveClass(ctx, null));
  app.route('PUT', '/api/classes/:id', 'actions.write', ctx => saveClass(ctx, writableClass(ctx, ctx.params.id)));
  app.route('POST', '/api/meetings', 'actions.write', ctx => saveMeeting(ctx, null));
  app.route('PUT', '/api/meetings/:id', 'actions.write', ctx => saveMeeting(ctx, get(ctx, 'meetings', ctx.params.id)));

  app.route('GET', '/api/workflow/instructors', 'instructors.read', ctx => {
    const { actions, classes } = readActions(ctx);
    const ids = new Set(classes.map(item => item.id));
    return {
      instructors: scopedInstructors(ctx).filter(item => staff(ctx) || item.userId === ctx.user.id || ctx.user.instructorId === item.id),
      actions: staff(ctx) ? actions : actions.map(item => publicAction(item, true)), classes: staff(ctx) ? classes : classes.map(item => publicClass(item, true)),
      virtualHours: Object.fromEntries(classes.filter(klass => klass.status === 'completed').map(klass => [klass.id, Math.max(0, ...ctx.db.list('registrations').filter(item => item.classId === klass.id && item.status === 'confirmed').map(item => Number(item.virtualHours) || 0))])),
      meetings: ctx.db.list('meetings').filter(item => ids.has(item.classId)).map(publicMeeting),
      users: staff(ctx) ? ctx.db.list('users').filter(user => user.role === 'instructor' && user.active !== false).map(({ id, name }) => ({ id, name })) : []
    };
  });
  app.route('POST', '/api/instructors', 'instructors.write', ctx => saveInstructor(ctx, null));
  app.route('PUT', '/api/instructors/:id', 'instructors.write', ctx => saveInstructor(ctx, inScope(ctx, get(ctx, 'instructors', ctx.params.id))));

  app.route('GET', '/api/workflow/registrations', 'registrations.read', ctx => {
    const { actions, classes } = readActions(ctx);
    return { registrations: readRegistrations(ctx), actions: actions.map(item => publicAction(item)), classes: classes.map(item => publicClass(item)), counts: Object.fromEntries(classes.map(item => [item.id, classCapacity(ctx, item)])) };
  });
  app.route('POST', '/api/registrations/lookup', 'registrations.write', async ctx => {
    const { id, name, cpf, matricula, org, unit, email } = await findActiveServant(ctx, ctx.body);
    return { id, name, cpf, matricula, org, unit, email };
  });
  app.route('POST', '/api/registrations', 'registrations.write', saveEnrollment);
  app.route('PUT', '/api/registrations/:id', null, ctx => {
    if (!staff(ctx) && !ctx.check('registrations.write')) ctx.fail(403, 'Seu perfil não pode alterar inscrições.');
    return reviewEnrollment(ctx);
  });

  app.route('GET', '/api/workflow/attendance', 'attendance.read', ctx => {
    const { actions, classes } = readActions(ctx);
    const ids = new Set(classes.map(item => item.id));
    const registrations = readRegistrations(ctx);
    const registrationIds = new Set(registrations.map(item => item.id));
    const fullDetails = staff(ctx) || ctx.user.role === 'instructor';
    return { actions: actions.map(item => publicAction(item)), classes: classes.map(item => publicClass(item)), instructors: scopedInstructors(ctx).map(summarizeInstructor), meetings: ctx.db.list('meetings').filter(item => ids.has(item.classId)).map(item => fullDetails ? item : publicMeeting(item)), registrations, attendance: ctx.db.list('attendance').filter(item => ids.has(item.classId) && registrationIds.has(item.registrationId)) };
  });
  app.route('PUT', '/api/meetings/:id/attendance', 'attendance.write', recordAttendance);

  app.route('GET', '/api/workflow/history', 'history.read', ctx => {
    const { actions, classes } = readActions(ctx);
    return { registrations: readRegistrations(ctx), actions: actions.map(item => publicAction(item)), classes: classes.map(item => publicClass(item)) };
  });
}

function canViewVirtual(ctx, klass) {
  return staff(ctx) || ctx.user.role === 'instructor' || ctx.db.list('registrations').some(item => item.classId === klass.id && item.status === 'confirmed' && ownEnrollment(ctx.user, item));
}

function publicAction(action, includeVirtual = false) {
  const { id, title, description, program, modality, hours, org, unit, audience, place, virtualUrl, startDate, endDate, schedule, instructorIds } = action;
  return { id, title, description, program, modality, hours, org, unit, audience, place, virtualUrl: includeVirtual ? virtualUrl : '', startDate, endDate, schedule, instructorIds };
}

function publicClass(klass, includeVirtual = false) {
  const { id, actionId, title, startDate, endDate, schedule, capacity, status, place, virtualUrl, instructorIds, audience, eligibleOrgs, eligibleUnits, minAttendance, minGrade, virtualPlannedHours, requiresApproval, enrollStart, enrollEnd } = klass;
  return { id, actionId, title, startDate, endDate, schedule, capacity, status, place, virtualUrl: includeVirtual ? virtualUrl : '', instructorIds, audience, eligibleOrgs, eligibleUnits, minAttendance, minGrade, virtualPlannedHours, requiresApproval, enrollStart, enrollEnd };
}

function publicMeeting(meeting) {
  const { id, classId, title, date, startTime, endTime, status, content, place, plannedHours, actualHours, replacementOfId, instructorIds } = meeting;
  return { id, classId, title, date, startTime, endTime, status, content, place, plannedHours, actualHours, replacementOfId, instructorIds };
}
