import { canScope, frequency, meetingInstructorIds, visibleClass } from './workflow.mjs'
import { certificateCriteria, certificateEligibility } from './outcome-eligibility.mjs'

const labels = {
  received: 'Recebida', review: 'Em análise', complement: 'Aguardando complementação',
  approved: 'Aprovada', rejected: 'Não aprovada', draft: 'Rascunho', planned: 'Planejada', open: 'Inscrições abertas', ongoing: 'Em andamento',
  completed: 'Concluída', canceled: 'Cancelada', pending: 'Pendente', confirmed: 'Confirmada', waitlisted: 'Lista de espera',
  withdrawn: 'Desistência', active: 'Emitido', revoked: 'Cancelado',
  scheduled: 'Programada', application: 'Em aplicação', closed: 'Encerrada', paused: 'Pausada',
  reaction: 'Reação', learning: 'Aprendizagem', instructor: 'Instrutor',
  presential: 'Presencial', hybrid: 'Híbrida', online: 'A distância', not_completed: 'Não concluída',
}

export const statusLabel = value => labels[value] || value || ''
const value = input => Number(input) || 0
const round = number => Math.round(number * 100) / 100
const rate = (count, total) => total ? round(100 * count / total) : 0
const mean = list => list.length ? round(list.reduce((sum, item) => sum + item, 0) / list.length) : 0
const key = text => String(text ?? '').normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().trim()
const column = (key, label, width) => ({ key, label, width })
const credentialLabel = status => ({ active: 'Ativo', pending: 'Pendente', expired: 'Vencido', suspended: 'Suspenso' })[status] || ''

export const reportTitles = {
  indicadores: 'Indicadores gerenciais', solicitacoes: 'Solicitações por órgão e situação', acoes: 'Ações de capacitação', turmas: 'Turmas, vagas e inscrições',
  participantes: 'Participantes e conclusões', frequencia: 'Frequência individual', 'frequencia-turmas': 'Frequência consolidada por turma',
  certificados: 'Certificados emitidos, cancelados e pendentes', instrutores: 'Instrutores e horas ministradas', horas: 'Carga horária planejada e executada',
  avaliacoes: 'Resultados das avaliações', custos: 'Custos registrados por ação', planejamento: 'Execução do Plano de Desenvolvimento de Capacitação',
  distribuicao: 'Participantes por órgão e unidade', 'acoes-realizadas': 'Ações realizadas por período, órgão e modalidade',
}

function matches(query, record) {
  const start = String(record.start || '').slice(0, 10)
  const end = String(record.end || start).slice(0, 10)
  return (!query.start || end && end >= query.start)
    && (!query.end || start && start <= query.end)
    && (!query.org || record.orgs?.some(org => key(org) === key(query.org)))
    && (!query.modality || key(record.modality) === key(query.modality) || key(statusLabel(record.modality)) === key(query.modality))
    && (!query.theme || key(record.theme).includes(key(query.theme)))
    && (!query.instructor || record.instructors?.some(instructor => key(instructor).includes(key(query.instructor))))
    && (!query.status || record.statuses?.some(status => key(status) === key(query.status) || key(statusLabel(status)) === key(query.status)))
}

function unique(values) { return [...new Set(values.filter(Boolean))] }

function actionState(action, classes) {
  if (!classes.length) return action.status || 'planned'
  if (classes.some(item => item.status === 'ongoing')) return 'ongoing'
  if (classes.every(item => item.status === 'canceled')) return 'canceled'
  if (classes.every(item => ['completed', 'canceled'].includes(item.status))) return 'completed'
  return 'planned'
}

export function reportData(ctx, name) {
  if (!Object.hasOwn(reportTitles, name)) ctx.fail(404, 'Relatório não encontrado.')
  const q = ctx.query
  const { user } = ctx
  const records = new Map()
  const store = ctx.db
  const db = { ...store, list(entity) {
    if (!records.has(entity)) records.set(entity, store.list(entity))
    return records.get(entity)
  } }
  ctx = { ...ctx, db }
  const today = ctx.now()
  if (q.start && q.end && q.start > q.end) ctx.fail(400, 'O fim do período deve ser igual ou posterior ao início.')
  const self = user.role === 'participant'
  const privateScope = record => canScope(user, record) && (!self || record.userId === user.id || Boolean(user.servantId && record.servantId === user.servantId))
  const allActions = new Map(db.list('actions').map(record => [record.id, record]))
  const instructors = db.list('instructors').filter(record => canScope(user, record))
  const annualPlan = db.get('settings', 'general') || {}
  const instructorMap = new Map(db.list('instructors').map(item => [item.id, item.name]))
  const roster = db.list('registrations').filter(privateScope)
  const visible = db.list('classes').filter(klass => visibleClass(ctx, klass) && (!self || roster.some(item => item.classId === klass.id)))
  const meetings = db.list('meetings')
  const certificates = db.list('certificates').filter(privateScope)
  const responses = db.list('evaluationResponses').filter(privateScope)
  const instruments = db.list('evaluations')
  const classes = visible.map(klass => {
    const action = allActions.get(klass.actionId) || {}
    const registrations = roster.filter(item => item.classId === klass.id)
    const sessions = meetings.filter(item => item.classId === klass.id)
    const instructorIds = klass.instructorIds?.length ? klass.instructorIds : action.instructorIds || []
    const associated = unique([...instructorIds, ...sessions.flatMap(session => meetingInstructorIds(ctx, session))])
    const facts = {
      start: klass.startDate || action.startDate, end: klass.endDate || action.endDate,
      orgs: unique([klass.org, action.org, ...registrations.map(item => item.org)]),
      modality: klass.modality || action.modality, theme: `${action.title || ''} ${klass.title || ''}`,
      instructors: associated.map(id => instructorMap.get(id)).filter(Boolean), statuses: [klass.status],
    }
    const records = registrations.map(registration => ({
      ...registration, attendance: frequency(ctx, registration),
    })).map(registration => ({
      ...registration, complete: certificateEligibility(ctx, klass, registration, registration.attendance).eligible,
      facts: { ...facts, orgs: unique([registration.org]), statuses: [registration.status, klass.status, registration.completion] },
    }))
    const planned = sessions.filter(item => item.status !== 'canceled').reduce((sum, item) => sum + value(item.plannedHours), value(klass.virtualPlannedHours))
    const virtualActual = klass.status === 'completed' ? Math.max(0, ...records.filter(item => item.status === 'confirmed').map(item => value(item.virtualHours))) : 0
    const taught = new Map(instructorIds.map(id => [id, virtualActual]))
    let actual = virtualActual
    for (const session of sessions.filter(item => item.status === 'done')) {
      const hours = value(session.actualHours ?? session.plannedHours)
      actual += hours
      for (const id of meetingInstructorIds(ctx, session)) taught.set(id, (taught.get(id) || 0) + hours)
    }
    return { klass, action, facts, records, instructorIds, taught, planned: planned || value(action.hours), actual }
  })
  const classMatches = item => matches(q, item.facts)
  const matchingClasses = classes.filter(classMatches)
  const classMap = new Map(classes.map(item => [item.klass.id, item]))
  const actionRows = [...allActions.values()].filter(action => {
    const associated = classes.filter(item => item.action.id === action.id)
    return (!self && user.role !== 'instructor' && canScope(user, action)) || associated.length
  }).map(action => {
    const cohorts = classes.filter(item => item.action.id === action.id)
    const status = actionState(action, cohorts.map(item => item.klass))
    const facts = {
      start: action.startDate, end: action.endDate, theme: action.title, modality: action.modality,
      orgs: unique([action.org, ...cohorts.flatMap(item => item.facts.orgs)]),
      instructors: unique([...(action.instructorIds || []).map(id => instructorMap.get(id)), ...cohorts.flatMap(item => item.facts.instructors)]), statuses: [status],
    }
    return { action, cohorts, status, facts }
  }).filter(item => matches(q, item.facts))
  const enrollments = classes.flatMap(item => item.records.filter(record => matches(q, record.facts)).map(record => ({ ...item, record })))
  const certificateRows = certificates.map(cert => ({ cert, item: classMap.get(cert.classId) })).filter(({ cert, item }) => item && matches(q, {
    ...item.facts, start: cert.issuedAt, end: cert.issuedAt, orgs: unique([cert.org]), statuses: [cert.status],
  }))
  const evaluationRows = instruments.flatMap(instrument => {
    const cohorts = instrument.classId ? classes.filter(item => item.klass.id === instrument.classId) : classes.filter(item => item.action.id === instrument.actionId)
    return cohorts.map(item => {
      const records = item.records.filter(record => record.status === 'confirmed' && (!q.org || key(record.org) === key(q.org)))
      const received = responses.filter(response => response.evaluationId === instrument.id && records.some(record => record.id === response.registrationId))
      const ratings = received.flatMap(response => instrument.questions.filter(question => question.kind === 'rating').map(question => Number(response.answers[question.id])).filter(score => score >= 1 && score <= 5))
      const grades = received.map(response => response.grade).filter(score => typeof score === 'number')
      return { item, instrument, records, received, ratings, grades }
    }).filter(row => matches(q, {
      ...row.item.facts, start: instrument.availableAt, end: instrument.closesAt || (instrument.availableAt > today ? instrument.availableAt : today),
      instructors: instrument.instructorId ? [instructorMap.get(instrument.instructorId)] : row.item.facts.instructors,
      statuses: [!instrument.enabled ? 'paused' : instrument.availableAt > today ? 'scheduled' : instrument.closesAt && instrument.closesAt < today ? 'closed' : 'application'],
    }))
  })
  const plannedActions = actionRows.filter(({ action }) => action.plannedYear || action.planRef)
  const annualPlanned = plannedActions.filter(({ action }) => !annualPlan.planYear || Number(action.plannedYear || String(action.startDate || '').slice(0, 4)) === Number(annualPlan.planYear))
  const annualDone = annualPlanned.filter(item => item.status === 'completed').length
  const showGlobalTarget = !user.scopeOrg && !user.scopeUnit && ['admin', 'manager', 'tech', 'auditor'].includes(user.role) && !Object.keys(q).some(field => ['org', 'modality', 'theme', 'instructor', 'status', 'start', 'end'].includes(field) && q[field])

  let columns, rows, metrics
  switch (name) {
    case 'solicitacoes':
      columns = [column('protocol', 'Protocolo', 1.5), column('title', 'Solicitação', 2), column('org', 'Órgão'), column('unit', 'Unidade'), column('date', 'Data de envio'), column('modality', 'Modalidade'), column('status', 'Situação', 1.2)]
      rows = db.list('requests').filter(record => !self && user.role !== 'instructor' && canScope(user, record) && record.status !== 'draft').filter(record => matches(q, {
        start: record.submittedAt || record.createdAt, orgs: unique([record.org]), modality: record.modality, theme: record.title, statuses: [record.status],
      })).map(record => ({ protocol: record.protocol, title: record.title, org: record.org, unit: record.unit, date: (record.submittedAt || record.createdAt || '').slice(0, 10), modality: statusLabel(record.modality), status: statusLabel(record.status) }))
      metrics = ['Aprovada', 'Não aprovada', 'Aguardando complementação', 'Recebida', 'Em análise'].map(label => ({ label, value: rows.filter(row => row.status === label).length }))
      break
    case 'acoes':
      columns = [column('title', 'Ação', 2.2), column('org', 'Órgão'), column('modality', 'Modalidade'), column('start', 'Início'), column('end', 'Término'), column('cohorts', 'Turmas'), column('status', 'Situação')]
      rows = actionRows.map(({ action, cohorts, status }) => ({ title: action.title, org: action.org, modality: statusLabel(action.modality), start: action.startDate, end: action.endDate, cohorts: cohorts.length, status: statusLabel(status) }))
      break
    case 'turmas':
      columns = [column('title', 'Turma', 2), column('action', 'Ação', 1.8), column('status', 'Situação', 1.2), column('capacity', 'Vagas'), column('registrations', 'Inscrições'), column('confirmed', 'Confirmadas'), column('waitlisted', 'Lista de espera'), column('occupancy', 'Ocupação %')]
      rows = matchingClasses.map(({ klass, action, records }) => {
        const relevant = records.filter(record => !q.org || key(record.org) === key(q.org))
        const confirmed = relevant.filter(record => record.status === 'confirmed').length
        return { title: klass.title, action: action.title, status: statusLabel(klass.status), capacity: value(klass.capacity), registrations: relevant.length, confirmed, waitlisted: relevant.filter(record => record.status === 'waitlisted').length, occupancy: rate(confirmed, value(klass.capacity)) }
      })
      break
    case 'participantes':
    case 'frequencia':
      columns = [column('name', 'Participante', 1.7), column('org', 'Órgão'), column('unit', 'Unidade'), column('title', 'Turma', 1.7), column('status', 'Inscrição'), column('percent', 'Frequência %'), column('hours', 'Horas cumpridas'), column('outcome', 'Situação formativa')]
      rows = enrollments.map(({ klass, record }) => ({ name: record.name, org: record.org, unit: record.unit, title: klass.title, status: statusLabel(record.status), percent: record.attendance.percent, hours: record.attendance.hours, outcome: record.complete ? 'Concluinte' : record.status === 'withdrawn' ? 'Desistente' : record.status === 'confirmed' && record.attendance.denominator > 0 && record.attendance.percent >= certificateCriteria(db, klass).minAttendance ? 'Frequente' : '' }))
      break
    case 'frequencia-turmas':
      columns = [column('title', 'Turma', 2), column('action', 'Ação', 2), column('confirmed', 'Confirmadas'), column('frequent', 'Frequentes'), column('average', 'Frequência média %'), column('hours', 'Horas cumpridas'), column('complete', 'Concluintes')]
      rows = matchingClasses.map(({ klass, action, records }) => {
        const selected = records.filter(record => record.status === 'confirmed' && (!q.org || key(record.org) === key(q.org)))
        const minimum = certificateCriteria(db, klass).minAttendance
        return { title: klass.title, action: action.title, confirmed: selected.length, frequent: selected.filter(record => record.attendance.denominator > 0 && record.attendance.percent >= minimum).length, average: mean(selected.map(record => record.attendance.percent)), hours: round(selected.reduce((sum, record) => sum + record.attendance.hours, 0)), complete: selected.filter(record => record.complete).length }
      })
      break
    case 'certificados':
      columns = [column('name', 'Participante', 1.4), column('title', 'Turma', 1.5), column('org', 'Órgão'), column('code', 'Código', 2), column('issued', 'Emissão'), column('status', 'Situação')]
      rows = certificateRows.map(({ cert, item }) => ({ name: cert.snapshot.name, title: item.klass.title, org: cert.org, code: cert.code, issued: cert.issuedAt.slice(0, 10), status: statusLabel(cert.status) }))
      rows.push(...classes.flatMap(item => item.records.filter(record => item.klass.status === 'completed' && record.status === 'confirmed' && !certificates.some(cert => cert.registrationId === record.id && cert.status === 'active') && matches(q, { ...record.facts, statuses: ['pending'] })).map(record => ({ name: record.name, title: item.klass.title, org: record.org, code: '', issued: '', status: 'Pendente' }))))
      break
    case 'instrutores':
      columns = [column('name', 'Instrutor', 1.7), column('title', 'Turma', 1.5), column('action', 'Ação', 1.5), column('hours', 'Horas ministradas'), column('annualLimit', 'Limite anual'), column('hourlyRate', 'Valor hora-aula'), column('credential', 'Credenciamento')]
      rows = instructors.filter(record => (!q.instructor || key(record.name).includes(key(q.instructor))) && (user.role !== 'instructor' || record.id === user.instructorId || record.userId === user.id)).flatMap(instructor => {
        const assignments = matchingClasses.filter(item => item.taught.has(instructor.id))
        if (assignments.length) return assignments.map(({ klass, action, taught }) => ({ name: instructor.name, title: klass.title, action: action.title, hours: round(taught.get(instructor.id)), annualLimit: instructor.annualLimit ?? '', hourlyRate: instructor.hourlyRate ?? '', credential: credentialLabel(instructor.credentialStatus) }))
        if (!matches(q, { orgs: unique([instructor.org]), instructors: [instructor.name], theme: (instructor.topics || []).toString(), statuses: [instructor.credentialStatus || instructor.status] })) return []
        return [{ name: instructor.name, title: '', action: '', hours: 0, annualLimit: instructor.annualLimit ?? '', hourlyRate: instructor.hourlyRate ?? '', credential: credentialLabel(instructor.credentialStatus) }]
      })
      break
    case 'horas':
      columns = [column('title', 'Turma', 2), column('action', 'Ação', 2), column('modality', 'Modalidade'), column('planned', 'Horas planejadas'), column('actual', 'Horas executadas'), column('virtual', 'Horas virtuais cumpridas')]
      rows = matchingClasses.map(({ klass, action, facts, planned, actual, records }) => ({ title: klass.title, action: action.title, modality: statusLabel(facts.modality), planned: round(planned), actual: round(actual), virtual: round(records.filter(record => !q.org || key(record.org) === key(q.org)).reduce((sum, record) => sum + value(record.virtualHours), 0)) }))
      break
    case 'avaliacoes':
      columns = [column('title', 'Instrumento', 1.5), column('type', 'Tipo'), column('action', 'Ação', 1.3), column('cohort', 'Turma', 1.3), column('instructor', 'Instrutor', 1.2), column('received', 'Respostas'), column('pending', 'Pendências'), column('satisfaction', 'Média 1–5'), column('grade', 'Nota média')]
      rows = evaluationRows.map(({ item, instrument, records, received, ratings, grades }) => ({ title: instrument.title, type: statusLabel(instrument.type), action: item.action.title, cohort: item.klass.title, instructor: instructorMap.get(instrument.instructorId) || item.facts.instructors.join(', '), received: received.length, pending: Math.max(0, records.length - received.length), satisfaction: ratings.length ? mean(ratings) : '', grade: grades.length ? mean(grades) : '' }))
      break
    case 'custos':
      columns = [column('title', 'Ação', 2), column('org', 'Órgão'), column('start', 'Início'), column('cost', 'Custo em R$'), column('status', 'Situação')]
      rows = actionRows.filter(({ action }) => action.cost !== null && action.cost !== undefined && action.cost !== '').map(({ action, status }) => ({ title: action.title, org: action.org, start: action.startDate, cost: value(action.cost), status: statusLabel(status) }))
      metrics = [{ label: 'Custo registrado (R$)', value: round(rows.reduce((sum, row) => sum + row.cost, 0)) }]
      break
    case 'planejamento':
      columns = [column('year', 'Ano'), column('plan', 'Referência do plano', 1.4), column('title', 'Ação', 2), column('status', 'Situação'), column('planned', 'Horas planejadas'), column('actual', 'Horas executadas'), column('cohorts', 'Turmas')]
      rows = plannedActions.map(({ action, cohorts, status }) => ({ year: action.plannedYear || String(action.startDate || '').slice(0, 4), plan: action.planRef || '', title: action.title, status: statusLabel(status), planned: round(cohorts.reduce((sum, row) => sum + row.planned, 0) || value(action.hours)), actual: round(cohorts.reduce((sum, row) => sum + row.actual, 0)), cohorts: cohorts.length }))
      metrics = [{ label: 'Ações no plano', value: rows.length }, { label: 'Ações realizadas', value: rows.filter(row => row.status === 'Concluída').length }, { label: 'Execução (%)', value: rate(rows.filter(row => row.status === 'Concluída').length, rows.length) }]
      if (showGlobalTarget && annualPlan.annualTarget) metrics.push({ label: `Meta de ações em ${annualPlan.planYear}`, value: annualPlan.annualTarget }, { label: 'Meta anual realizada (%)', value: rate(annualDone, annualPlan.annualTarget) })
      break
    case 'distribuicao': {
      columns = [column('org', 'Órgão', 1.5), column('unit', 'Unidade', 1.5), column('registered', 'Inscrições'), column('confirmed', 'Confirmadas'), column('complete', 'Concluintes'), column('unique', 'Servidores únicos capacitados')]
      const groups = new Map()
      for (const { record } of enrollments) {
        const groupKey = JSON.stringify([record.org, record.unit])
        if (!groups.has(groupKey)) groups.set(groupKey, [])
        groups.get(groupKey).push(record)
      }
      rows = [...groups.values()].map(records => ({ org: records[0].org, unit: records[0].unit, registered: records.length, confirmed: records.filter(record => record.status === 'confirmed').length, complete: records.filter(record => record.complete).length, unique: unique(records.filter(record => record.complete).map(personKey)).length }))
      break
    }
    case 'acoes-realizadas': {
      columns = [column('period', 'Ano e mês'), column('org', 'Órgão', 1.5), column('modality', 'Modalidade'), column('actions', 'Ações realizadas'), column('hours', 'Horas executadas')]
      const groups = new Map()
      for (const item of actionRows.filter(row => row.status === 'completed')) {
        const period = (item.action.endDate || item.action.startDate || '').slice(0, 7)
        const org = item.action.org || 'Sem órgão de origem'
        const modality = statusLabel(item.action.modality)
        const groupKey = JSON.stringify([period, org, modality])
        const group = groups.get(groupKey) || { period, org, modality, actions: 0, hours: 0 }
        group.actions++
        group.hours = round(group.hours + item.cohorts.reduce((sum, cohort) => sum + cohort.actual, 0))
        groups.set(groupKey, group)
      }
      rows = [...groups.values()]
      break
    }
    default: {
      const people = enrollments.map(item => item.record)
      const complete = people.filter(item => item.complete)
      const confirmed = people.filter(item => item.status === 'confirmed')
      const withdrawn = people.filter(item => item.status === 'withdrawn')
      const completedCohorts = new Set(matchingClasses.filter(item => item.klass.status === 'completed').map(item => item.klass.id))
      const active = enrollments.filter(item => completedCohorts.has(item.klass.id) && ['confirmed', 'withdrawn'].includes(item.record.status))
      const seats = matchingClasses.filter(item => item.klass.status !== 'canceled').reduce((sum, item) => sum + value(item.klass.capacity), 0)
      const occupied = enrollments.filter(item => item.klass.status !== 'canceled' && item.record.status === 'confirmed').length
      const satisfaction = evaluationRows.filter(row => row.instrument.type === 'reaction').flatMap(row => row.ratings)
      const definitions = [
        ['completed_actions', 'Ações realizadas', actionRows.filter(item => item.status === 'completed').length],
        ['unique_participants', 'Servidores únicos capacitados', unique(complete.map(personKey)).length],
        ['offered_hours', 'Horas de capacitação ofertadas', round(matchingClasses.filter(item => item.klass.status !== 'canceled').reduce((sum, item) => sum + item.planned, 0))],
        ['executed_hours', 'Horas de capacitação executadas', round(matchingClasses.reduce((sum, item) => sum + item.actual, 0))],
        ['completed_person_hours', 'Horas concluídas pelos servidores', round(complete.reduce((sum, item) => sum + item.attendance.hours, 0))],
        ['occupation_pct', 'Taxa de ocupação (%)', rate(occupied, seats)],
        ['completion_pct', 'Taxa de conclusão em turmas encerradas (%)', rate(complete.length, active.length)],
        ['dropout_pct', 'Taxa de evasão (%)', rate(withdrawn.length, confirmed.length + withdrawn.length)],
        ['average_satisfaction', 'Satisfação média (1–5)', satisfaction.length ? mean(satisfaction) : null],
        ['issued_certificates', 'Certificados emitidos', certificateRows.filter(({ cert }) => cert.status === 'active').length],
        ['annual_plan_pct', `Execução do planejamento ${annualPlan.planYear || 'anual'} (%)`, rate(annualDone, annualPlanned.length)],
      ]
      if (showGlobalTarget && annualPlan.annualTarget) definitions.push(['annual_target_pct', `Meta de ações em ${annualPlan.planYear} realizada (%)`, rate(annualDone, annualPlan.annualTarget)])
      columns = [column('indicator', 'Código', 1.2), column('label', 'Indicador', 2.5), column('value', 'Valor')]
      rows = definitions.map(([indicator, label, value]) => ({ indicator, label, value }))
      metrics = [rows[0], rows[1], rows[2], rows[5], rows[8], rows[9]]
    }
  }
  return { title: reportTitles[name], columns, rows, metrics: metrics || [] }
}

function personKey(record) {
  return record.servantId || record.userId || record.matricula || record.cpf || record.id
}
