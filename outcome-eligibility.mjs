import { frequency } from './workflow.mjs'

export function certificateEligibility(ctx, klass, registration, attendance = frequency(ctx, registration)) {
  const criteria = certificateCriteria(ctx.db, klass)
  const problems = []
  if (klass.status !== 'completed') problems.push('A turma precisa estar concluída.')
  if (registration.status !== 'confirmed') problems.push('A inscrição precisa estar confirmada.')
  if (registration.completion === 'not_completed') problems.push('A conclusão da atividade formativa está pendente.')
  if (Number(attendance.percent) < Number(criteria.minAttendance)) problems.push(`Frequência inferior ao mínimo de ${criteria.minAttendance}%.`)
  if (criteria.minGrade !== null && criteria.minGrade !== '' && (registration.grade === null || registration.grade === '' || registration.grade === undefined || Number(registration.grade) < Number(criteria.minGrade))) {
    problems.push(`Nota inferior ao mínimo de ${criteria.minGrade} ou ainda não registrada.`)
  }
  return { eligible: !problems.length, problems, attendance, criteria }
}

export function certificateCriteria(db, klass) {
  const custom = db.get('certificateRules', `class:${klass.id}`) || db.get('certificateRules', `action:${klass.actionId}`)
  return custom
    ? { minAttendance: custom.minAttendance, minGrade: custom.minGrade, source: custom.scope }
    : { minAttendance: klass.minAttendance ?? 75, minGrade: klass.minGrade ?? null, source: 'class_default' }
}
