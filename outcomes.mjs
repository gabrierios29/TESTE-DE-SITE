import { randomUUID } from 'node:crypto'
import { canScope, meetingInstructorIds, visibleClass } from './workflow.mjs'
import { queueCanal, queueEmail, setCanalCertificateProvider } from './integrations.mjs'
import { certificatePdf, reportCsv, reportPdf, reportXlsx } from './outcome-exports.mjs'
import { reportData, reportTitles } from './outcomes-reports.mjs'
import { certificateCriteria, certificateEligibility } from './outcome-eligibility.mjs'

const types = ['reaction', 'learning', 'instructor']
const questionKinds = ['rating', 'choice', 'text']
const defaultTemplate = { id: 'main', institution: 'Escola de Governo • IMPARH', heading: 'Certificado de conclusão', footer: '' }
const zone = 'America/Fortaleza'
const formatDate = value => value ? new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeZone: 'UTC' }).format(new Date(String(value).slice(0, 10))) : ''
const average = values => values.length ? Math.round(values.reduce((sum, n) => sum + n, 0) / values.length * 100) / 100 : null
const owns = (user, row) => row.userId === user.id || Boolean(user.servantId && row.servantId === user.servantId)
const canReadRecord = (ctx, row) => canScope(ctx.user, row) && (ctx.user.role !== 'participant' || owns(ctx.user, row))

function textField(ctx, field, label, max, required = true) {
  if (field === undefined || field === null) field = ''
  if (typeof field !== 'string' || field.trim().length > max || required && !field.trim()) ctx.fail(400, `Informe ${label} com até ${max} caracteres.`)
  return field.trim()
}

function instant(ctx, input, label, fallback) {
  if (!input) return fallback
  const error = () => ctx.fail(400, `Informe uma data e hora válida para ${label}.`)
  if (typeof input !== 'string' || !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})?$/.test(input)) error()
  const calendarDay = new Date(input.slice(0, 10))
  if (!Number.isFinite(calendarDay.getTime()) || calendarDay.toISOString().slice(0, 10) !== input.slice(0, 10)) error()
  const local = /(?:Z|[+-]\d{2}:\d{2})$/.test(input) ? input : `${input}-03:00`
  const timestamp = Date.parse(local)
  if (!Number.isFinite(timestamp)) error()
  return new Date(timestamp).toISOString()
}

function assignedClasses(db, evaluation) {
  return db.list('classes').filter(klass => klass.status !== 'canceled' && (evaluation.classId ? klass.id === evaluation.classId : klass.actionId === evaluation.actionId))
}

function assignments(db, evaluation) {
  const cohortIds = new Set(assignedClasses(db, evaluation).map(klass => klass.id))
  return db.list('registrations').filter(row => row.status === 'confirmed' && cohortIds.has(row.classId))
}

function currentEvaluation(record, now) {
  return record.enabled && record.availableAt <= now && (!record.closesAt || now <= record.closesAt)
}

export function sendDueEvaluations(ctx) {
  const now = ctx.now()
  const evaluations = ctx.db.list('evaluations').filter(item => currentEvaluation(item, now))
  const users = ctx.db.list('users').filter(user => user.active !== false)
  for (const evaluation of evaluations) {
    for (const registration of assignments(ctx.db, evaluation)) {
      const id = `${evaluation.id}:${registration.id}`
      if (ctx.db.get('evaluationDeliveries', id) || ctx.db.get('evaluationResponses', id)) continue
      const user = users.find(item => item.id === registration.userId || Boolean(item.servantId && item.servantId === registration.servantId))
      ctx.db.tx(() => {
        if (ctx.db.get('evaluationDeliveries', id) || ctx.db.get('evaluationResponses', id)) return
        const subject = 'Avaliação disponível'
        const text = `Responda à avaliação “${evaluation.title}”.`
        const link = `/#evaluations/${encodeURIComponent(evaluation.id)}`
        const notice = user ? ctx.notify(user.id, subject, text, link) : ctx.app?.demo === false
          ? queueEmail(ctx.db, { id: `evaluation:${id}`, to: registration.email, subject, text, link, createdAt: now })
          : null
        if (!notice) return
        ctx.db.save('evaluationDeliveries', { id, evaluationId: evaluation.id, registrationId: registration.id, deliveredAt: now })
      })
    }
  }
}

function evaluationTarget(ctx) {
  const { db, body } = ctx
  const klass = body.classId ? db.get('classes', body.classId) : null
  if (body.classId && (!klass || !visibleClass(ctx, klass))) ctx.fail(404, 'Turma não encontrada.')
  const action = db.get('actions', klass?.actionId || body.actionId)
  if (!action || !klass && !canScope(ctx.user, action)) ctx.fail(404, 'Ação não encontrada.')
  if (klass && body.actionId && body.actionId !== action.id) ctx.fail(400, 'A turma precisa pertencer à ação selecionada.')
  if (body.type === 'instructor') {
    const instructor = body.instructorId && db.get('instructors', body.instructorId)
    const cohorts = klass ? [klass] : assignedClasses(db, { actionId: action.id })
    if (!instructor || ![...(action.instructorIds || []), ...cohorts.flatMap(item => item.instructorIds || [])].includes(instructor.id)) ctx.fail(400, 'Selecione um instrutor vinculado à ação ou à turma.')
  }
  return { classId: klass?.id || '', actionId: action.id, instructorId: body.type === 'instructor' ? body.instructorId : '', org: action.org, unit: action.unit }
}

function questions(ctx, entries, type) {
  if (!Array.isArray(entries) || !entries.length || entries.length > 25) ctx.fail(400, 'Cadastre de 1 a 25 perguntas.')
  const records = entries.map((entry, index) => {
    if (!entry || !questionKinds.includes(entry.kind)) ctx.fail(400, 'Selecione o tipo de cada pergunta.')
    const prompt = textField(ctx, entry.prompt, `a pergunta ${index + 1}`, 250)
    const q = { id: String(index + 1), prompt, kind: entry.kind }
    if (entry.kind === 'choice') {
      if (!Array.isArray(entry.choices) || entry.choices.length < 2 || entry.choices.length > 10) ctx.fail(400, 'Informe de 2 a 10 alternativas nas perguntas de múltipla escolha.')
      q.choices = entry.choices.map(choice => textField(ctx, choice, 'a alternativa', 160))
      if (new Set(q.choices).size !== q.choices.length) ctx.fail(400, 'As alternativas da pergunta devem ser distintas.')
      if (type === 'learning') {
        const answer = Number(entry.answer)
        const points = Number(entry.points || 1)
        if (!Number.isInteger(answer) || answer < 1 || answer > q.choices.length) ctx.fail(400, 'Informe o número da alternativa correta em cada pergunta objetiva.')
        if (!Number.isFinite(points) || points <= 0 || points > 100) ctx.fail(400, 'Informe um peso maior que zero e de até 100.')
        Object.assign(q, { answer, points })
      }
    }
    return q
  })
  if (type === 'learning' && !records.some(item => item.points)) ctx.fail(400, 'Inclua ao menos uma pergunta objetiva para calcular a nota.')
  return records
}

function evaluationVisible(ctx, record) {
  const action = ctx.db.get('actions', record.actionId)
  if (!action) return false
  if (record.classId) {
    const klass = ctx.db.get('classes', record.classId)
    return Boolean(klass && visibleClass(ctx, klass))
  }
  if (ctx.user.role === 'instructor') return assignedClasses(ctx.db, record).some(klass => visibleClass(ctx, klass))
  return canScope(ctx.user, action) || assignedClasses(ctx.db, record).some(klass => visibleClass(ctx, klass))
}

function assessmentScope(ctx, evaluation) {
  const cohortIds = new Set(assignedClasses(ctx.db, evaluation).filter(klass => visibleClass(ctx, klass)).map(klass => klass.id))
  return assignments(ctx.db, evaluation).filter(row => cohortIds.has(row.classId) && canReadRecord(ctx, row))
}

function consolidation(ctx, evaluation) {
  const selected = assessmentScope(ctx, evaluation)
  const responses = ctx.db.list('evaluationResponses').filter(response => response.evaluationId === evaluation.id && selected.some(row => row.id === response.registrationId))
  const details = evaluation.questions.map(question => {
    const answers = responses.map(response => response.answers[question.id]).filter(answer => answer !== undefined)
    const summary = { question: question.prompt, kind: question.kind, answered: answers.length }
    if (question.kind === 'rating') {
      summary.average = average(answers)
      summary.counts = [1, 2, 3, 4, 5].map(score => ({ label: String(score), count: answers.filter(answer => answer === score).length }))
    } else if (question.kind === 'choice') {
      summary.counts = question.choices.map((choice, index) => ({ label: choice, count: answers.filter(answer => answer === index + 1).length }))
    } else {
      summary.comments = answers
    }
    return summary
  })
  const pending = selected.filter(row => !responses.some(response => response.registrationId === row.id))
  return { total: selected.length, received: responses.length, pending: pending.length, details, averageGrade: average(responses.map(row => row.grade).filter(grade => typeof grade === 'number')) }
}

function safeEvaluation(item) {
  return { ...item, questions: item.questions.map(({ answer, points, ...question }) => question) }
}

function evaluationList(ctx) {
  const { db, user } = ctx
  const mine = user.role === 'participant'
  const now = ctx.now()
  const actions = new Map(db.list('actions').map(row => [row.id, row]))
  const classes = new Map(db.list('classes').map(row => [row.id, row]))
  const instructorNames = new Map(db.list('instructors').map(row => [row.id, row.name]))
  const items = db.list('evaluations').filter(item => mine || evaluationVisible(ctx, item))
  return items.flatMap(item => {
    const labels = { action: actions.get(item.actionId)?.title, cohort: classes.get(item.classId)?.title, instructor: instructorNames.get(item.instructorId) }
    if (!mine) {
      const totals = consolidation(ctx, item)
      const record = ctx.check('evaluations.write') ? item : safeEvaluation(item)
      return [{ ...record, ...labels, total: totals.total, received: totals.received, pending: totals.pending }]
    }
    return assignments(db, item).filter(row => canReadRecord(ctx, row)).flatMap(row => {
      const response = db.get('evaluationResponses', `${item.id}:${row.id}`)
      if (!response && (!item.enabled || item.closesAt && item.closesAt < now)) return []
      const isOpen = currentEvaluation(item, now)
      return [{ ...safeEvaluation(item), ...labels, questions: isOpen && !response ? safeEvaluation(item).questions : [], cohort: classes.get(row.classId)?.title, registrationId: row.id, answered: Boolean(response), grade: response?.grade ?? null, open: isOpen }]
    })
  }).sort((a, b) => b.availableAt.localeCompare(a.availableAt))
}

function submitEvaluation(ctx) {
  const { db, user, body, params } = ctx
  const evaluation = db.get('evaluations', params.id)
  const row = db.get('registrations', body.registrationId)
  if (!evaluation || !row || !owns(user, row) || !canReadRecord(ctx, row) || !assignments(db, evaluation).some(item => item.id === row.id)) ctx.fail(404, 'Avaliação não encontrada para esta inscrição.')
  if (!currentEvaluation(evaluation, ctx.now())) ctx.fail(409, 'A avaliação está fora do prazo de resposta.')
  const answers = {}
  let score = 0
  let maximum = 0
  for (const question of evaluation.questions) {
    const answer = body.answers?.[question.id]
    if (question.kind === 'text') {
      answers[question.id] = textField(ctx, answer, `a resposta à pergunta ${question.id}`, 2000)
      continue
    }
    if (!Number.isInteger(answer) || answer < 1 || answer > (question.kind === 'rating' ? 5 : question.choices.length)) ctx.fail(400, `Selecione uma resposta válida na pergunta ${question.id}.`)
    answers[question.id] = answer
    if (question.points) {
      maximum += question.points
      if (answer === question.answer) score += question.points
    }
  }
  const grade = maximum ? Math.round(score / maximum * 10000) / 100 : null
  const id = `${evaluation.id}:${row.id}`
  db.tx(() => {
    if (db.get('evaluationResponses', id)) ctx.fail(409, 'A avaliação já foi respondida.')
    db.save('evaluationResponses', { id, evaluationId: evaluation.id, registrationId: row.id, classId: row.classId, userId: user.id, servantId: row.servantId, org: row.org, unit: row.unit, answers, grade, answeredAt: ctx.now() })
    if (grade !== null && (row.gradeSource !== 'manual' || row.grade == null)) {
      const all = db.list('evaluationResponses').filter(item => item.registrationId === row.id && typeof item.grade === 'number')
      db.save('registrations', { ...row, grade: average(all.map(item => item.grade)), gradeSource: 'evaluation' })
    }
    ctx.audit('Responder avaliação', 'evaluations', evaluation.id, { registrationId: row.id })
  })
  return { answered: true, grade }
}

function classAction(ctx, classId) {
  const klass = ctx.db.get('classes', classId)
  if (!klass || !visibleClass(ctx, klass)) ctx.fail(404, 'Turma não encontrada.')
  const action = ctx.db.get('actions', klass.actionId)
  if (!action) ctx.fail(404, 'Ação não encontrada.')
  return { klass, action }
}

function validationUrl(app, code) {
  const url = new URL('/validar', app.baseUrl || 'http://localhost:3000')
  url.searchParams.set('codigo', code)
  return url.href
}

function writeBinary(ctx, name, type, contents) {
  ctx.res.writeHead(200, { 'Content-Type': type, 'Content-Disposition': `attachment; filename="${name}"`, 'Cache-Control': 'private, no-store', 'Content-Length': Buffer.byteLength(contents) })
  ctx.res.end(contents)
}

function certificateContext(ctx, id) {
  const certificate = ctx.db.get('certificates', id)
  if (!certificate || !canReadRecord(ctx, certificate)) ctx.fail(404, 'Certificado não encontrado.')
  const { klass, action } = classAction(ctx, certificate.classId)
  return { certificate, klass, action }
}

function certificateIssue(ctx, row, klass, action) {
  const existing = ctx.db.list('certificates').find(item => item.registrationId === row.id && item.status === 'active')
  if (existing) return existing
  const eligibility = certificateEligibility(ctx, klass, row)
  if (!eligibility.eligible) ctx.fail(409, eligibility.problems.join(' '))
  const template = ctx.db.get('certificateTemplates', 'main') || { ...defaultTemplate, institution: ctx.db.get('settings', 'general')?.institution || defaultTemplate.institution }
  const assigned = klass.instructorIds?.length ? klass.instructorIds : action.instructorIds || []
  const taught = ctx.db.list('meetings').filter(meeting => meeting.classId === klass.id && meeting.status === 'done').flatMap(meeting => meetingInstructorIds(ctx, meeting))
  const names = [...new Set(taught.length && !klass.virtualPlannedHours ? taught : [...taught, ...assigned])].map(id => ctx.db.get('instructors', id)?.name).filter(Boolean)
  const start = klass.startDate || action.startDate
  const end = klass.endDate || action.endDate
  const period = [formatDate(start), formatDate(end)].filter(Boolean).join(' a ')
  const issuedAt = ctx.now()
  const issued = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeZone: zone }).format(new Date(issuedAt))
  const totalHours = eligibility.attendance.denominator || Number(klass.hours || action.hours) || 0
  const certificate = ctx.db.save('certificates', {
    code: randomUUID().replaceAll('-', '').toUpperCase(), status: 'active', classId: klass.id, actionId: action.id, registrationId: row.id,
    userId: row.userId, servantId: row.servantId, org: row.org, unit: row.unit, issuedAt,
    snapshot: { name: row.name, title: action.title, hours: totalHours, period, instructors: names.join(', '), institution: template.institution, heading: template.heading, footer: template.footer, issued },
  })
  const completed = row.completion === 'completed' ? row : ctx.db.save('registrations', {
    ...row, completion: 'completed', updatedAt: issuedAt,
    history: [...(row.history || []), { action: 'Conclusão certificada', at: issuedAt, userId: ctx.user.id, userName: ctx.user.name, details: { certificateId: certificate.id } }],
  })
  queueCanal(ctx.db, { registration: completed, certificate, classRecord: klass, action, operation: 'upsert' })
  ctx.audit('Emitir certificado', 'certificates', certificate.id, { code: certificate.code, registrationId: row.id, criteria: eligibility.criteria })
  if (row.userId) ctx.notify(row.userId, 'Certificado disponível', `O certificado da capacitação “${action.title}” está disponível.`, '/#certificates')
  return certificate
}

function validationRecord(ctx, code) {
  const normalized = typeof code === 'string' ? code.trim().toUpperCase() : ''
  const certificate = /^[A-F0-9]{32}$/.test(normalized) && ctx.db.list('certificates').find(item => item.code === normalized)
  if (!certificate) return { status: 'missing' }
  if (certificate.status !== 'active') return { status: 'revoked', code: certificate.code }
  const { name, title, hours, period, institution, issued } = certificate.snapshot
  return { status: 'active', code: certificate.code, name, title, hours, period, institution, issued }
}

function escapeHtml(value) { return String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;') }

function validationPage(ctx) {
  const result = validationRecord(ctx, ctx.query.codigo)
  const valid = result.status === 'active'
  const pairs = valid ? [['Participante', result.name], ['Ação', result.title], ['Carga horária', `${result.hours} h`], ['Período', result.period], ['Instituição', result.institution], ['Emissão', result.issued], ['Código', result.code]] : []
  const message = valid ? 'Certificado válido' : result.status === 'revoked' ? 'Certificado cancelado' : ctx.query.codigo ? 'Certificado não encontrado' : ''
  const html = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Validação de certificado | Escola de Governo</title><link rel="stylesheet" href="/styles.css"></head><body><main class="validation-page"><section class="panel stack"><p class="muted">Escola de Governo · IMPARH</p><h1>Validação de certificado</h1><form class="filters" action="/validar"><label class="field">Código<input name="codigo" value="${escapeHtml(ctx.query.codigo)}" pattern="[0-9A-Fa-f]{32}" maxlength="32" required></label><button class="btn btn-primary">Consultar</button></form>${message ? `<p class="notice">${escapeHtml(message)}</p>` : ''}${pairs.length ? `<dl>${pairs.map(([label, value]) => `<dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd>`).join('')}</dl>` : ''}<p><a href="/">Ir ao sistema</a></p></section></main></body></html>`
  ctx.res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' })
  ctx.res.end(html)
}

export function registerOutcomes(app) {
  const route = (method, path, permission, handler) => app.route(method, `/api${path}`, permission, handler)
  setCanalCertificateProvider((certificate, { baseUrl } = {}) => certificatePdf(certificate, validationUrl({ baseUrl: baseUrl || app.baseUrl }, certificate.code)))
  route('GET', '/evaluations', 'evaluations.read', evaluationList)
  route('GET', '/evaluations/options', 'evaluations.write', ctx => {
    const classes = ctx.db.list('classes').filter(klass => visibleClass(ctx, klass))
    const actions = ctx.db.list('actions').filter(action => canScope(ctx.user, action) || classes.some(klass => klass.actionId === action.id))
    const instructors = ctx.db.list('instructors').filter(item => canScope(ctx.user, item) || classes.some(klass => (klass.instructorIds || []).includes(item.id)))
    return { actions, classes, instructors: instructors.map(({ id, name }) => ({ id, name })) }
  })
  route('POST', '/evaluations', 'evaluations.write', ctx => {
    const { db, body } = ctx
    if (!types.includes(body.type)) ctx.fail(400, 'Selecione o tipo da avaliação.')
    const target = evaluationTarget(ctx)
    const availableAt = instant(ctx, body.availableAt, 'a abertura', ctx.now())
    const closesAt = instant(ctx, body.closesAt, 'o encerramento', '')
    if (closesAt && closesAt < availableAt) ctx.fail(400, 'O encerramento deve ser posterior à abertura.')
    const data = { ...target, title: textField(ctx, body.title, 'o título', 180), type: body.type, availableAt, closesAt, enabled: body.enabled !== false, questions: questions(ctx, body.questions, body.type), createdAt: ctx.now() }
    const record = db.tx(() => {
      const created = db.save('evaluations', data)
      ctx.audit('Cadastrar avaliação', 'evaluations', created.id, { type: created.type, actionId: created.actionId, classId: created.classId })
      return created
    })
    sendDueEvaluations(ctx)
    return record
  })
  route('PATCH', '/evaluations/:id', 'evaluations.write', ctx => {
    const record = ctx.db.get('evaluations', ctx.params.id)
    if (!record || !evaluationVisible(ctx, record)) ctx.fail(404, 'Avaliação não encontrada.')
    const availableAt = ctx.body.availableAt === undefined ? record.availableAt : instant(ctx, ctx.body.availableAt, 'a abertura', ctx.now())
    const closesAt = ctx.body.closesAt === undefined ? record.closesAt : instant(ctx, ctx.body.closesAt, 'o encerramento', '')
    if (closesAt && closesAt < availableAt) ctx.fail(400, 'O encerramento deve ser posterior à abertura.')
    const enabled = ctx.body.enabled === undefined ? record.enabled : ctx.body.enabled === true
    const updated = ctx.db.tx(() => {
      const saved = ctx.db.save('evaluations', { ...record, enabled, availableAt, closesAt })
      ctx.audit('Alterar aplicação de avaliação', 'evaluations', record.id, { enabled, availableAt, closesAt })
      return saved
    })
    sendDueEvaluations(ctx)
    return updated
  })
  route('POST', '/evaluations/:id/response', 'evaluations.read', submitEvaluation)
  route('GET', '/evaluations/:id/results', 'evaluations.read', ctx => {
    const record = ctx.db.get('evaluations', ctx.params.id)
    if (!record || ctx.user.role === 'participant' || !evaluationVisible(ctx, record)) ctx.fail(404, 'Avaliação não encontrada.')
    return consolidation(ctx, record)
  })

  route('GET', '/certificates', 'certificates.read', ctx => {
    const { db, user } = ctx
    const cohorts = db.list('classes').filter(klass => visibleClass(ctx, klass))
    const actionMap = new Map(db.list('actions').map(item => [item.id, item]))
    const result = db.list('certificates').filter(item => canReadRecord(ctx, item) && cohorts.some(klass => klass.id === item.classId)).map(item => ({ ...item, validationUrl: validationUrl(app, item.code) }))
    const candidates = user.role === 'participant' ? [] : db.list('registrations').filter(row => row.status === 'confirmed' && canReadRecord(ctx, row)).flatMap(row => {
      const klass = cohorts.find(item => item.id === row.classId && item.status === 'completed')
      if (!klass || result.some(item => item.status === 'active' && item.registrationId === row.id)) return []
      return [{ id: row.id, classId: klass.id, cohort: klass.title, action: actionMap.get(klass.actionId)?.title, name: row.name, org: row.org, grade: row.grade, ...certificateEligibility(ctx, klass, row) }]
    })
    return { items: result.sort((a, b) => b.issuedAt.localeCompare(a.issuedAt)), candidates }
  })
  route('GET', '/certificates/template', 'certificates.read', ctx => {
    if (ctx.user.role !== 'admin') ctx.fail(403, 'A configuração do modelo é administrativa.')
    return ctx.db.get('certificateTemplates', 'main') || { ...defaultTemplate, institution: ctx.db.get('settings', 'general')?.institution || defaultTemplate.institution }
  })
  route('PUT', '/certificates/template', 'certificates.write', ctx => {
    if (ctx.user.role !== 'admin') ctx.fail(403, 'A configuração do modelo é administrativa.')
    const data = { id: 'main', institution: textField(ctx, ctx.body.institution, 'a instituição promotora', 100), heading: textField(ctx, ctx.body.heading, 'o título do modelo', 70), footer: textField(ctx, ctx.body.footer, 'o texto complementar', 220, false) }
    return ctx.db.tx(() => {
      const result = ctx.db.save('certificateTemplates', data)
      ctx.audit('Configurar modelo de certificado', 'certificateTemplates', 'main', data)
      return result
    })
  })
  route('GET', '/certificates/criteria', 'certificates.write', ctx => {
    const classes = ctx.db.list('classes').filter(klass => visibleClass(ctx, klass))
    const actions = ctx.db.list('actions').filter(action => canScope(ctx.user, action)).map(({ id, title }) => ({ id, title, criteria: ctx.db.get('certificateRules', `action:${id}`) }))
    return { actions, classes: classes.map(({ id, actionId, title, ...klass }) => ({ id, actionId, title, criteria: certificateCriteria(ctx.db, { ...klass, id, actionId }) })) }
  })
  route('PUT', '/certificates/criteria', 'certificates.write', ctx => {
    const { scope, targetId, minAttendance, minGrade, reset } = ctx.body
    if (!['action', 'class'].includes(scope) || typeof targetId !== 'string') ctx.fail(400, 'Selecione a ação ou a turma.')
    const target = ctx.db.get(scope === 'action' ? 'actions' : 'classes', targetId)
    if (!target || !(scope === 'action' ? canScope(ctx.user, target) : visibleClass(ctx, target))) ctx.fail(404, 'Ação ou turma não encontrada.')
    if (reset !== true && (typeof minAttendance !== 'number' || !Number.isFinite(minAttendance) || minAttendance < 0 || minAttendance > 100 || minGrade !== null && (typeof minGrade !== 'number' || !Number.isFinite(minGrade) || minGrade < 0 || minGrade > 100))) ctx.fail(400, 'Informe a frequência mínima e, se aplicável, a nota mínima, ambas de 0 a 100.')
    const id = `${scope}:${targetId}`
    return ctx.db.tx(() => {
      const record = reset === true ? null : ctx.db.save('certificateRules', { id, scope, targetId, minAttendance, minGrade })
      if (!record) ctx.db.remove('certificateRules', id)
      ctx.audit('Configurar critérios de certificação', scope === 'class' ? 'classes' : 'actions', targetId, { criteria: record })
      return { criteria: record }
    })
  })
  route('POST', '/certificates/issue', 'certificates.write', ctx => {
    const ids = ctx.body.registrationIds
    if (!Array.isArray(ids) || !ids.length || ids.length > 200 || !ids.every(id => typeof id === 'string')) ctx.fail(400, 'Selecione de 1 a 200 inscrições.')
    return ctx.db.tx(() => [...new Set(ids)].map(id => {
      const row = ctx.db.get('registrations', id)
      if (!row || !canReadRecord(ctx, row)) ctx.fail(404, 'Inscrição não encontrada.')
      const { klass, action } = classAction(ctx, row.classId)
      return certificateIssue(ctx, row, klass, action)
    }))
  })
  route('GET', '/certificates/:id/pdf', 'certificates.read', ctx => {
    const { certificate } = certificateContext(ctx, ctx.params.id)
    if (certificate.status !== 'active') ctx.fail(410, 'O certificado foi cancelado.')
    writeBinary(ctx, `certificado-${certificate.code}.pdf`, 'application/pdf', certificatePdf(certificate, validationUrl(app, certificate.code)))
  })
  route('POST', '/certificates/:id/revoke', 'certificates.write', ctx => {
    const { certificate, klass, action } = certificateContext(ctx, ctx.params.id)
    const reason = textField(ctx, ctx.body.reason, 'a justificativa do cancelamento', 500)
    if (certificate.status !== 'active') ctx.fail(409, 'O certificado já está cancelado.')
    return ctx.db.tx(() => {
      const saved = ctx.db.save('certificates', { ...certificate, status: 'revoked', revokedAt: ctx.now(), revokeReason: reason })
      const registration = ctx.db.get('registrations', certificate.registrationId)
      queueCanal(ctx.db, { registration, certificate: saved, classRecord: klass, action, operation: 'cancel' })
      ctx.audit('Cancelar certificado', 'certificates', certificate.id, { code: certificate.code, reason })
      if (certificate.userId) ctx.notify(certificate.userId, 'Certificado cancelado', `O certificado da capacitação “${action.title}” foi cancelado.`, '/#certificates')
      return saved
    })
  })
  app.route('GET', '/validar', '*', validationPage)
  route('GET', '/validation/:code', '*', ctx => validationRecord(ctx, ctx.params.code))

  route('GET', '/reports', 'reports.read', () => reportTitles)
  route('GET', '/reports/:type', 'reports.read', ctx => reportData(ctx, ctx.params.type))
  route('GET', '/reports/:type/export/:format', 'reports.read', ctx => {
    const { title, columns, rows } = reportData(ctx, ctx.params.type)
    const format = ctx.params.format
    const name = `imparh-${ctx.params.type}.${format}`
    if (format === 'csv') writeBinary(ctx, name, 'text/csv; charset=utf-8', reportCsv(columns, rows))
    else if (format === 'xlsx') writeBinary(ctx, name, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', reportXlsx(columns, rows))
    else if (format === 'pdf') writeBinary(ctx, name, 'application/pdf', reportPdf(title, columns, rows))
    else ctx.fail(400, 'Formato de exportação inválido.')
  })
  route('GET', '/bi/:type', 'reports.read', ctx => {
    const { columns, rows } = reportData(ctx, ctx.params.type)
    if (ctx.query.format === 'csv') {
      writeBinary(ctx, `imparh-bi-${ctx.params.type}.csv`, 'text/csv; charset=utf-8', reportCsv(columns, rows, { bi: true }))
      return
    }
    return { columns, rows }
  })
}
